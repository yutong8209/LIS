#!/bin/bash
# <bitbar.title>LIS 待审</bitbar.title>
# <bitbar.version>4.2</bitbar.version>
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

M=$(echo "$J" | jq -r '.scope // "全部仪器"')
# 待审总数（正常+异常已合并）；兼容旧 serve 无 auditReady 字段时回退为两者之和
AR=$(echo "$J" | jq -r '.auditReady // ((.normalReady // 0) + (.abnormalReady // 0))')
NR=$(echo "$J" | jq -r '.normalReady // 0')
PD=$(echo "$J" | jq -r '.pending // 0')
CL=$(echo "$J" | jq -r '.collected // 0') # 8.5.31: 病房采集中、未送到科室
IC=$(echo "$J" | jq -r '.incomplete // 0')
TO=$(echo "$J" | jq -r '.total // 0')
TS=$(echo "$J" | jq -r '.ts // 0')

NOW=$(date +%s)
AGE=$(( NOW - TS ))
if [ "$AGE" -lt 0 ]; then AGE=0; fi
if [ "$AGE" -lt 60 ]; then TIME_TXT="${AGE}秒前"; else TIME_TXT="$(( AGE / 60 ))分钟前"; fi

# 工作台打开时每 30 秒会推送一次。超时说明浏览器/工作台已关闭，不能继续把旧计数当作实时数据。
if [ "$AGE" -gt 90 ]; then
  echo ":clock.badge.exclamationmark: | sfcolor=$C_GRAY"
  echo "---"
  echo "工作台数据已过期 | $H_FONT sfimage=exclamationmark.triangle sfcolor=$C_ORANGE"
  echo "最后更新：$TIME_TXT；请打开审核工作台刷新数据 | $SUB_FONT"
  echo "刷新 | refresh=true $SUB_FONT sfimage=arrow.clockwise"
  exit 0
fi

# ── 菜单栏标题：两排显示四个状态数字（每排两个），随时盯数无需点开 ──
# SwiftBar 会把每个非分隔行都渲染到状态栏 → 正好两排，每排两个状态。
# emoji 彩色图标区分四类（菜单栏文本颜色跟随系统深浅外观，无需手动指定）。
# 有异常待审时给第一行加红点强调；无异常保持常显 0。
if [ "$AR" -gt 0 ] 2>/dev/null; then
  echo "🔴 ✅$AR 📋$IC | size=13"
else
  echo "✅$AR 📋$IC | size=13"
fi
echo "📝$PD 🩸$CL | size=13"

# ── 下拉：分类行（图标 + 标签 + 大号彩色数字，数字右对齐成列） ──
echo "---"
echo "$M | $H_FONT sfimage=slider.horizontal.3 sfcolor=$C_BLUE"
echo "---"

# 用 printf 把数字右对齐到固定宽度，形成整齐右列；点击跳转对应分类
JUMP="$HOME/lis-menubar/lis_jump.sh"
row() {
  local icon="$1" label="$2" val="$3" color="$4" cat="$5"
  printf "%s %-7s%4s\n" "$icon" "$label" "$val" \
    | awk -v c="$color" -v f="size=16 font=.AppleSystemUIFont semibold=true color=$color" -v j="$JUMP" -v cat="$cat" \
      '{ printf "%s | %s bash=%s param1=%s terminal=false\n", $0, f, j, cat }'
}

row ":checkmark.seal.fill:" "待审" "$AR" "$L_GREEN" "audit"
row ":doc.fill:" "不完整" "$IC" "$L_TEAL" "incomplete"
row ":tray.fill:" "待排样" "$PD" "$L_INDIGO" "pending"
row ":drop.fill:" "采集" "$CL" "$L_PINK" "collected" # 8.5.33: 病房采集（已采未送达）
row ":number.circle.fill:" "标本总数" "$TO" "$L_BLUE" "all"

echo "---"
echo "更新于 $TIME_TXT | $SUB_FONT sfimage=clock"
echo "立即刷新 | refresh=true $SUB_FONT sfimage=arrow.clockwise"
