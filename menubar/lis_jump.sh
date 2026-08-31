#!/bin/bash
# 菜单栏下拉点击 → 聚焦 Chrome 的 LIS 工作台标签 + 发 /cmd 指令切分类
# 用法: lis_jump.sh <cat>
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
CAT="$1"
# 8.10.0: cat 白名单校验（值会拼进 /cmd 的 JSON 与 SwiftBar param1）
case "$CAT" in
  audit|incomplete|pending|collected|all) ;;
  *) exit 0 ;;
esac

# 1) 用 jq 从 /stats 正确提取 url
STATS=$(curl -s --max-time 2 http://127.0.0.1:8765/stats)
URL=$(echo "$STATS" | jq -r '.url // empty' 2>/dev/null)
# 8.10.0 安全加固：url 会被内插进 AppleScript——/stats 可被本机任意进程写入，
# 必须校验为 LIS 白名单来源、且不含引号/管道/换行等可逃逸字符，否则置空不用
case "$URL" in
  http://10.0.29.100/*|http://192.168.31.111:9111/*) ;;
  *) URL="" ;;
esac
if [ -n "$URL" ]; then
  case "$URL" in
    *'"'*|*'|'*|*'\'*|*$'\n'*|*$'\r'*) URL="" ;;
  esac
fi

# 2) 用 AppleScript 精确聚焦到 LIS 标签
osascript <<EOF 2>/dev/null
tell application "Google Chrome"
  activate
  set found to false
  repeat with w in windows
    set ti to 1
    repeat with t in tabs of w
      set u to (URL of t as text)
      if u contains "10.0.29.100" or u contains "192.168.31.111" or u contains "iMedicalLIS" then
        set active tab index of w to ti
        set index of w to 1
        set found to true
        exit repeat
      end if
      set ti to ti + 1
    end repeat
    if found then exit repeat
  end repeat
  if not found then
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
