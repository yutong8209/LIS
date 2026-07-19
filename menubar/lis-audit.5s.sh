#!/bin/bash
# <bitbar.title>LIS 待审</bitbar.title>
# <bitbar.version>1.0</bitbar.version>
# <bitbar.author>LIS-Enhancer</bitbar.author>
# <bitbar.desc>当前筛选范围的可一键批审/异常待审标本数，下拉含待排样/不完整/总数</bitbar.desc>
# <bitbar.dependencies>curl,jq</bitbar.dependencies>
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

J=$(curl -s --max-time 2 http://localhost:8765/stats)
if [ -z "$J" ] || [ "$(echo "$J" | jq -r '.ok // false')" != "true" ]; then
  echo "🔬 --"
  echo "---"
  echo "本地桥未连接 (serve.py 未运行?)"
  echo "刷新 | refresh=true"
  exit 0
fi

M=$(echo "$J" | jq -r '.scope // "全部仪器"')
NR=$(echo "$J" | jq -r '.normalReady // 0')
AR=$(echo "$J" | jq -r '.abnormalReady // 0')
PD=$(echo "$J" | jq -r '.pending // 0')
IC=$(echo "$J" | jq -r '.incomplete // 0')
TO=$(echo "$J" | jq -r '.total // 0')
TS=$(echo "$J" | jq -r '.ts // 0')

# 菜单栏标题：可批审 / 异常待审（异常>0 时标红提醒）
if [ "$AR" -gt 0 ] 2>/dev/null; then
  echo "✅${NR} ⚠️${AR} | color=#c0392b"
else
  echo "✅${NR} ⚠️${AR}"
fi
echo "---"
echo "范围：${M}"
echo "---"
echo "✅ 可一键批审：${NR}"
echo "⚠️ 异常待审：${AR}"
echo "📝 待排样：${PD}"
echo "📋 结果不完整：${IC}"
echo "📃 标本总数：${TO}"
echo "---"
NOW=$(date +%s)
AGE=$(( NOW - TS ))
if [ "$AGE" -lt 0 ]; then AGE=0; fi
echo "更新于 ${AGE}s 前 | color=gray"
echo "刷新 | refresh=true"
