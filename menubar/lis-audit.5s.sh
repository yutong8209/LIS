#!/bin/bash
# <bitbar.title>LIS 待审</bitbar.title>
# <bitbar.version>4.0</bitbar.version>
# <bitbar.author>LIS-Enhancer</bitbar.author>
# <bitbar.desc>当前筛选范围待审标本（Apple 风格 SF Symbols，下拉分类对齐）</bitbar.desc>
# <bitbar.dependencies>curl,jq</bitbar.dependencies>
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

C_GREEN="#34C759,#30D158"
C_ORANGE="#FF7A00,#FF9F0A"
C_GRAY="#636366,#8E8E93"
C_INDIGO="#5E5CE6,#5E5CE6"
C_BLUE="#007AFF,#0A84FF"
# 深色菜单栏：弹窗背景在浅灰/蓝玻璃间波动，用更深饱和色（绝不用纯灰）
L_GREEN="#15602B"
L_ORANGE="#9B1C1C"
L_INDIGO="#2E2E9E"
L_TEAL="#075E78"
L_BLUE="#0A3D91"
H_FONT="size=15 font=.AppleSystemUIFont semibold=true color=#000000"
SUB_FONT="size=13 font=.AppleSystemUIFont color=#3A3A3C"

J=$(curl -s --max-time 2 http://localhost:8765/stats)
if [ -z "$J" ] || [ "$(echo "$J" | jq -r '.ok // false')" != "true" ]; then
  echo ":antenna.radiowaves.left.and.right.slash: | sfcolor=$C_GRAY"
  echo "---"
  echo "本地桥未连接 | $H_FONT sfimage=bolt.horizontal.circle sfcolor=$C_ORANGE"
  echo "serve.py 未运行？ | $SUB_FONT"
  echo "刷新 | refresh=true $SUB_FONT sfimage=arrow.clockwise"
  exit 0
fi

M=$(echo "$J" | jq -r '.scope // "全部仪器"')
NR=$(echo "$J" | jq -r '.normalReady // 0')
AR=$(echo "$J" | jq -r '.abnormalReady // 0')
PD=$(echo "$J" | jq -r '.pending // 0')
IC=$(echo "$J" | jq -r '.incomplete // 0')
TO=$(echo "$J" | jq -r '.total // 0')
TS=$(echo "$J" | jq -r '.ts // 0')

NOW=$(date +%s)
AGE=$(( NOW - TS ))
if [ "$AGE" -lt 0 ]; then AGE=0; fi
if [ "$AGE" -lt 60 ]; then TIME_TXT="${AGE}秒前"; else TIME_TXT="$(( AGE / 60 ))分钟前"; fi

# ── 菜单栏标题：单色 SF Symbols + 数字（异常>0 才显示告警圆点） ──
if [ "$AR" -gt 0 ] 2>/dev/null; then
  echo ":checkmark.seal: $NR  :exclamationmark.circle.fill: $AR | size=14"
else
  echo ":checkmark.seal: $NR | size=14"
fi

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
      '{ printf "%s | %s bash=%s param1=%s\n", $0, f, j, cat }'
}

row ":checkmark.circle.fill:" "可批审" "$NR" "$L_GREEN" "normal"
row ":exclamationmark.triangle.fill:" "异常待审" "$AR" "$L_ORANGE" "abnormal"
row ":tray.fill:" "待排样" "$PD" "$L_INDIGO" "pending"
row ":doc.fill:" "不完整" "$IC" "$L_TEAL" "incomplete"
row ":number.circle.fill:" "标本总数" "$TO" "$L_BLUE" "all"

echo "---"
echo "更新于 $TIME_TXT | $SUB_FONT sfimage=clock"
echo "立即刷新 | refresh=true $SUB_FONT sfimage=arrow.clockwise"
