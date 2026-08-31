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

# 2) 停止 serve.py（8.9.0: 按端口找进程，不依赖启动方式——pgrep 匹配不到
# start_serve_mac.command 启动的实例，会出现「说没运行实际还在」）
# 8.10.0: 杀前校验进程命令行含 serve.py——避免误杀恰好监听 8765 的其它程序
if lsof -tiTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
  PIDS="$(lsof -tiTCP:8765 -sTCP:LISTEN 2>/dev/null | sort -u)"
  SERVE_PIDS=""
  for _p in $PIDS; do
    if ps -p "$_p" -o command= 2>/dev/null | grep -q "serve.py"; then
      SERVE_PIDS="$SERVE_PIDS $_p"
    else
      echo "⚠️ PID $_p 占用 8765 但不是 serve.py，跳过（lsof -iTCP:8765 可自行确认）"
    fi
  done
  if [ -n "$SERVE_PIDS" ]; then
    for _p in $SERVE_PIDS; do
      kill "$_p" 2>/dev/null
    done
    sleep 1
    if lsof -tiTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
      for _p in $SERVE_PIDS; do
        kill -9 "$_p" 2>/dev/null
      done
    fi
  fi
  if lsof -tiTCP:8765 -sTCP:LISTEN >/dev/null 2>&1; then
    echo "⚠️ 8765 端口仍被占用，请手动检查：lsof -iTCP:8765"
  else
    echo "✅ serve.py 已停止"
  fi
else
  echo "ℹ️ serve.py 本来就未运行"
fi

echo ""
echo "已全部关闭，无后台进程。下次用运行 start_lis_menubar.command 即可。"

# 自动关闭运行本脚本的终端窗口（避免留一个终端窗口）
osascript -e 'tell application "Terminal" to close (every window whose frontmost is true)' 2>/dev/null &
