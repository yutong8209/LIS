#!/bin/bash
# 菜单栏下拉点击 → 聚焦 Chrome 的 LIS 标签 + 发 /cmd 指令切分类
# 用法: lis_jump.sh <cat>
CAT="$1"
[ -z "$CAT" ] && exit 0

# 1) 从本地桥读当前 LIS 工作台 URL，聚焦 Chrome 到该标签
URL=$(curl -s --max-time 2 http://localhost:8765/stats | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*//; s/"//g')
if [ -n "$URL" ]; then
  open -a "Google Chrome" "$URL" 2>/dev/null || open "$URL" 2>/dev/null
fi

# 2) 发指令给本地桥（userscript 轮询消费后切分类）
curl -s -X POST http://localhost:8765/cmd -H 'Content-Type: text/plain' \
  -d "{\"action\":\"goto\",\"cat\":\"$CAT\"}" -o /dev/null 2>/dev/null

exit 0
