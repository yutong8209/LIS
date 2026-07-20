#!/bin/bash
# LIS 菜单栏服务 一键关闭：退出 SwiftBar + 停止 serve.py
# 用途：不用菜单栏时运行本脚本，彻底关闭，不留后台进程

# 1) 退出 SwiftBar
if pgrep -x "SwiftBar" >/dev/null 2>&1; then
  osascript -e 'quit app "SwiftBar"' 2>/dev/null
  sleep 1
  pgrep -x "SwiftBar" >/dev/null 2>&1 && echo "⚠️ SwiftBar 仍在运行，强制退出" && pkill -x "SwiftBar"
  echo "✅ SwiftBar 已退出"
else
  echo "ℹ️ SwiftBar 本来就未运行"
fi

# 2) 停止 serve.py
if pgrep -f "脚本/serve.py" >/dev/null 2>&1; then
  pkill -f "脚本/serve.py"
  sleep 1
  pgrep -f "脚本/serve.py" >/dev/null 2>&1 && echo "⚠️ serve.py 仍在，强制 kill" && pkill -9 -f "脚本/serve.py"
  echo "✅ serve.py 已停止"
else
  echo "ℹ️ serve.py 本来就未运行"
fi

echo ""
echo "已全部关闭，无后台进程。下次用运行 start_lis_menubar.command 即可。"

# 自动关闭运行本脚本的终端窗口（避免留一个终端窗口）
osascript -e 'tell application "Terminal" to close (every window whose frontmost is true)' 2>/dev/null &
