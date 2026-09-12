#!/bin/bash
# <bitbar.title>LIS 待审</bitbar.title>
# <bitbar.version>5.0</bitbar.version>
# <bitbar.author>LIS-Enhancer</bitbar.author>
# <bitbar.desc>菜单栏两排显示 待审/不完整/待排/采集 四个状态数字（每排两个），下拉分类对齐可点击跳转</bitbar.desc>
# <bitbar.dependencies>curl,jq</bitbar.dependencies>
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

C_GREEN="#34C759,#30D158"
C_ORANGE="#FF7A00,#FF9F0A"
C_GRAY="#636366,#8E8E93"
C_INDIGO="#5E5CE6,#5E5CE6"
C_BLUE="#007AFF,#0A84FF"
C_PINK="#FF3B82,#FF2D55" # 8.5.31: 病房采集（红/粉色，对应 workbench 的 🩸采集）
# 深色菜单栏：弹窗背景在浅灰/蓝玻璃间波动，用更深饱和色（绝不用纯灰）
L_GREEN="#15602B"
L_ORANGE="#9B1C1C"
L_INDIGO="#2E2E9E"
L_TEAL="#075E78"
L_BLUE="#0A3D91"
L_PINK="#9B1C46" # 8.5.31: 采集中
H_FONT="size=15 font=.AppleSystemUIFont semibold=true color=#000000"
SUB_FONT="size=13 font=.AppleSystemUIFont color=#3A3A3C"

J=$(curl -s --max-time 2 http://127.0.0.1:8765/stats)
if [ -z "$J" ] || [ "$(echo "$J" | jq -r '.ok // false')" != "true" ]; then
  echo ":antenna.radiowaves.left.and.right.slash: | sfcolor=$C_GRAY"
  echo "---"
  echo "本地桥未连接 | $H_FONT sfimage=bolt.horizontal.circle sfcolor=$C_ORANGE"
  echo "serve.py 未运行？ | $SUB_FONT"
  echo "刷新 | refresh=true $SUB_FONT sfimage=arrow.clockwise"
  exit 0
fi

M=$(echo "$J" | jq -r '(.scope // "全部仪器") | tostring | gsub("[|]";"") | gsub("\n";"") | gsub("\r";"") | .[0:40]')
VD=$(echo "$J" | jq -r '(.viewDate // "") | tostring | gsub("[^0-9-]";"") | .[0:10]')
TD=$(date +%Y-%m-%d)
if [ -n "$VD" ] && [ "$VD" != "$TD" ]; then
  VD_LABEL=$(echo "$VD" | sed -E 's/^[0-9]{4}-//')
  M="$M [$VD_LABEL]"
fi
# 待审总数（正常+异常已合并）；兼容旧 serve 无 auditReady 字段时回退为两者之和
# 8.10.0 安全加固：/stats 可被本机任意进程写入，数字字段一律强制 tonumber（非法回退 0），
# 防止恶意值混入 SwiftBar 行协议（行内第一个 | 之后是参数区，注入 bash= 点击即执行）
AR=$(echo "$J" | jq -r '(.auditReady // ((.normalReady // 0) + (.abnormalReady // 0))) | tonumber? // 0')
NR=$(echo "$J" | jq -r '(.normalReady // 0) | tonumber? // 0')
MR=$(echo "$J" | jq -r '(.mildReady // 0) | tonumber? // 0') # 8.12.0: 轻微异常可批审数（F4 队列扩容部分）
PD=$(echo "$J" | jq -r '(.pending // 0) | tonumber? // 0')
CL=$(echo "$J" | jq -r '(.collected // 0) | tonumber? // 0') # 8.5.31: 病房采集中、未送到科室
IC=$(echo "$J" | jq -r '(.incomplete // 0) | tonumber? // 0')
TO=$(echo "$J" | jq -r '(.total // 0) | tonumber? // 0')
TS=$(echo "$J" | jq -r '(.ts // 0) | tonumber? // 0')

NOW=$(date +%s)
AGE=$(( NOW - TS ))
if [ "$AGE" -lt 0 ]; then AGE=0; fi
if [ "$AGE" -lt 60 ]; then TIME_TXT="${AGE}秒前"; else TIME_TXT="$(( AGE / 60 ))分钟前"; fi

# 工作台打开时每 30 秒会推送一次。超时说明浏览器/工作台已关闭，不能继续把旧计数当作实时数据。
if [ "$AGE" -gt 90 ]; then
  echo ":clock.badge.exclamationmark: | sfcolor=$C_GRAY"
  echo "---"
  echo "工作台数据已过期 | $H_FONT sfimage=exclamationmark.triangle sfcolor=$C_ORANGE"
  echo "最后更新：${TIME_TXT}；请打开审核工作台刷新数据 | $SUB_FONT"
  echo "刷新 | refresh=true $SUB_FONT sfimage=arrow.clockwise"
  exit 0
fi

# ── 菜单栏标题：单行四个状态数字（待审 · 不完整 · 待排 · 采集）──
# 8.5.34: tooltip 值含空格需加引号，否则 SwiftBar 只解析出第一个词「待审」
echo "$AR · $IC · $PD · $CL | size=14 tooltip=\"待审 不完整 待排 采集\""

# ── 下拉：分类行（等宽字体 + tab 对齐，数字右对齐成列） ──
# 8.5.37: 二次对齐修复 — 8.5.36 用空格填充网格，但 CJK 在 Menlo 下的 fallback 字形宽度
# 并非严格的整数 2 倍半角空格，空格填充在混合中日文时仍会错位。
# 改用 SwiftBar 原生 tab 对齐：SwiftBar 会把 \t 渲染到等宽 tab stop，数字列天然右对齐，
# 跨 CJK/ASCII 宽度差异稳定对齐。文字左对齐、数字右对齐。
echo "---"
echo "$M | $H_FONT sfimage=slider.horizontal.3 sfcolor=$C_BLUE"
echo "---"
# 优先用插件自身所在目录的 lis_jump.sh（无论 PluginDirectory 是软链还是实体目录），
# 再回退纯 ASCII 软链路径——避免软链缺失时下拉点击静默失效
# 8.10.0: 删掉 $HOME/脚本/… 兜底：把中文路径塞回 SwiftBar bash= 参数与已知的
# SwiftBar 中文路径坑相悖（见 AGENTS.md），软链是唯一受支持的方案
JUMP="$(cd "$(dirname "$0")" 2>/dev/null && pwd)/lis_jump.sh"
[ -f "$JUMP" ] || JUMP="$HOME/lis-menubar/lis_jump.sh"

row() {
  local icon="$1" label="$2" val="$3" color="$4" cat="$5"
  # 文字（左对齐）\t 数字（右对齐到等宽 tab stop）
  echo "$label	$val | size=15 font=Menlo color=$color sfimage=$icon sfcolor=$color bash=$JUMP param1=$cat terminal=false"
}

row "checkmark.seal.fill" "待审" "$AR" "$L_GREEN" "audit"
# 8.12.0: 轻微异常可批审数——有才显示（整管异常都在轻微放行带内，F4 可一并批审）
if [ "$MR" -gt 0 ]; then
  row "bolt.horizontal.circle.fill" "└ 轻微可批" "$MR" "$L_ORANGE" "audit"
fi
row "doc.fill" "不完整" "$IC" "$L_TEAL" "incomplete"
row "tray.fill" "待排样" "$PD" "$L_INDIGO" "pending"
row "drop.fill" "采集" "$CL" "$L_PINK" "collected" # 8.5.33: 病房采集（已采未送达）
row "number.circle.fill" "标本总数" "$TO" "$L_BLUE" "all"

echo "---"
echo "更新于 $TIME_TXT | $SUB_FONT sfimage=clock"
echo "立即刷新 | refresh=true $SUB_FONT sfimage=arrow.clockwise"
