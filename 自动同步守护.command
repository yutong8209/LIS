#!/bin/bash
# 自动同步守护 —— 常驻窗口，发现「本地版本 ≠ 网关版本」就自动推送。
#
# 为什么需要它：Agent（WorkBuddy AI）没有「本地网络」权限（App 未声明
# NSLocalNetworkUsageDescription，系统静默拒绝且不出现在隐私设置里），
# 所以 Agent 自己 scp 不到网关机；而 Terminal 有权限。
# 于是让这个脚本在 Terminal 里常驻，替 Agent 完成推送。
#
# 用法：双击本文件一次，保持窗口开着即可；按 Ctrl+C 或关窗口退出。
#      可选参数：检查间隔秒数（默认 20），例如  bash 自动同步守护.command 60
#
# 判定逻辑：只比对 userscript 的 @version，不一致才调用 hooks/sync-to-nginx.sh
#          （该脚本自带锁、回验与日志；网关不可达时它自己会跳过）。
set -u
cd "$(dirname "$0")" || exit 1

# 清代理变量，强制局域网直连（与 同步脚本到nginx.command / hooks 保持一致）
unset http_proxy https_proxy all_proxy ALL_PROXY HTTP_PROXY HTTPS_PROXY
export NO_PROXY="localhost,127.0.0.1,192.168.*,10.*"
export no_proxy="localhost,127.0.0.1,192.168.*,10.*"

HOST="192.168.31.111"
URL="http://${HOST}:9111/lis-tools/iMedicalLIS-enhancer.user.js"
INTERVAL="${1:-20}"
LOCAL_FILE="iMedicalLIS-enhancer.user.js"

ver_of() { sed -n 's|^// @version[[:space:]]*||p' "$1" 2>/dev/null | head -1; }

echo "=========================================================="
echo " 自动同步守护已启动"
echo "   本地脚本：$(pwd)/${LOCAL_FILE}"
echo "   目标网关：${HOST}:9111"
echo "   检查间隔：${INTERVAL}s（Ctrl+C 退出）"
echo "=========================================================="
echo

last_state=""
while true; do
  local_ver="$(ver_of "$LOCAL_FILE")"
  if [ -z "$local_ver" ]; then
    echo "[$(date '+%T')] ⚠️ 读不到本地版本号，等下一轮"
    sleep "$INTERVAL"
    continue
  fi

  # 先用 HTTP 探活：网关不在线时静默等待，不刷屏、也不写失败日志
  if ! curl --noproxy '*' -s -m 4 -o /dev/null "$URL"; then
    if [ "$last_state" != "offline" ]; then
      echo "[$(date '+%T')] 网关不可达（不在科室网段 / 网关机未开机）→ 等待中"
      last_state="offline"
    fi
    sleep "$INTERVAL"
    continue
  fi

  remote_ver="$(curl --noproxy '*' -s -m 8 "$URL" | sed -n 's|^// @version[[:space:]]*||p' | head -1)"
  if [ "$remote_ver" != "$local_ver" ]; then
    echo "[$(date '+%T')] 检测到版本差异：网关 ${remote_ver:-无响应} → 本地 ${local_ver}，开始推送…"
    bash hooks/sync-to-nginx.sh
    new_ver="$(curl --noproxy '*' -s -m 8 "$URL" | sed -n 's|^// @version[[:space:]]*||p' | head -1)"
    if [ "$new_ver" = "$local_ver" ]; then
      echo "[$(date '+%T')] ✅ 推送成功，网关现在提供 ${new_ver}"
    else
      echo "[$(date '+%T')] ⚠️ 推送后网关仍返回「${new_ver:-无响应}」，请查看 .cache/nginx_sync.log"
    fi
    last_state="synced"
  else
    if [ "$last_state" != "same" ]; then
      echo "[$(date '+%T')] 已是最新（${local_ver}），持续监控中…"
      last_state="same"
    fi
  fi
  sleep "$INTERVAL"
done
