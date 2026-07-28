#!/bin/bash
# 菜单栏下拉点击 → 聚焦 Chrome 的 LIS 工作台标签 + 发 /cmd 指令切分类
# 用法: lis_jump.sh <cat>
CAT="$1"
[ -z "$CAT" ] && exit 0

# 1) 从本地桥读当前 LIS 工作台 URL（含 host，用于匹配标签）
URL=$(curl -s --max-time 2 http://127.0.0.1:8765/stats | grep -o '"url"[[:space:]]*:[[:space:]]*"[^"]*"' | head -1 | sed 's/.*:[[:space:]]*//; s/"//g')

# 提取 host（用于 AppleScript 匹配 LIS 标签，兼容 10.0.29.100 / 192.168.31.111）
HOST=""
if [ -n "$URL" ]; then
  HOST=$(echo "$URL" | sed -E 's#^[a-zA-Z]+://([^/]+).*#\1#')
fi
# 兜底 host 列表（即使 /stats 无 url 也能匹配）
HOSTS="$HOST 10.0.29.100 192.168.31.111"

# 2) 用 AppleScript 精确聚焦到 LIS 标签（优于纯 open：可指定窗口+tab）
osascript <<EOF 2>/dev/null
tell application "Google Chrome"
  activate
  set found to false
  repeat with w in windows
    set ti to 1
    repeat with t in tabs of w
      set u to (URL of t as text)
      repeat with h in words of "$HOSTS"
        if u contains h and h is not "" then
          set active tab index of w to ti
          set index of w to 1
          set found to true
          exit repeat
        end if
      end repeat
      if found then exit repeat
      set ti to ti + 1
    end repeat
    if found then exit repeat
  end repeat
  if not found then
    -- 没找到 LIS 标签：尝试用已知 URL 新开（若读到了 url）
    if "$URL" is not "" then
      open location "$URL"
    end if
  end if
end tell
EOF

# 3) 发指令给本地桥（userscript 轮询消费后切分类）
curl -s -X POST http://127.0.0.1:8765/cmd -H 'Content-Type: text/plain' \
  -d "{\"action\":\"goto\",\"cat\":\"$CAT\"}" -o /dev/null 2>/dev/null

exit 0
