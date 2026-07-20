#!/bin/bash
# LIS 菜单栏服务 一键启动：serve.py（本地桥）+ SwiftBar
# 用途：想用菜单栏时双击/运行本脚本

# 1) 启动 serve.py（若未运行）
if pgrep -f "脚本/serve.py" >/dev/null 2>&1; then
  echo "✅ serve.py 已在运行"
else
  nohup /usr/bin/python3 "/Users/yutong/脚本/serve.py" >/tmp/lis-serve.log 2>&1 &
  sleep 1
  if pgrep -f "脚本/serve.py" >/dev/null 2>&1; then
    echo "✅ serve.py 已启动 (http://localhost:8765)"
  else
    echo "❌ serve.py 启动失败，看 /tmp/lis-serve.log"
    exit 1
  fi
fi

# 2) 启动 SwiftBar（若未运行）
if pgrep -x "SwiftBar" >/dev/null 2>&1; then
  echo "✅ SwiftBar 已在运行"
else
  open -a "SwiftBar"
  sleep 2
  pgrep -x "SwiftBar" >/dev/null 2>&1 && echo "✅ SwiftBar 已启动" || echo "⚠️ SwiftBar 未自动打开，请手动从启动台打开"
fi

echo ""
echo "菜单栏已就绪：点开顶部 ✓/◉ 图标即可看待审统计，点击行可跳转工作台。"

# 自动关闭运行本脚本的终端窗口（serve.py 已 nohup 脱离，关窗不影响）
osascript -e 'tell application "Terminal" to close (every window whose frontmost is true)' 2>/dev/null &
