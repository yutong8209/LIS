#!/bin/bash
# 自动同步守护 —— 常驻窗口，发现「本地版本 ≠ 网关版本」就自动推送。
#
# 为什么需要它：Agent（WorkBuddy AI）没有「本地网络」权限（App 未声明
# NSLocalNetworkUsageDescription，系统静默拒绝且不出现在隐私设置里，用户无从授权），
# 所以 Agent 自己 scp 不到网关机；而 Terminal 有权限。
# 于是让这个脚本在 Terminal 里常驻，替 Agent 完成推送。
#
# 用法：双击本文件一次，保持窗口开着即可；按 Ctrl+C 或关窗口退出。
#      可选参数：检查间隔秒数（默认 20），例如  bash 自动同步守护.command 60
#
# 行为：
#   · 网关不可达 → 每 60s 发一次 Wake-on-LAN 魔术包（网关机睡眠时可自动唤醒），
#     状态变化写日志；不刷屏。
#   · 可达但版本不一致 → 调 hooks/sync-to-nginx.sh（自带锁/回验/日志），
#     并把本次结果追加到 .cache/auto_sync.log。
#   · 全程只比对 userscript 的 @version，不做其它判断。
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
# 网关机网卡 MAC（用于 Wake-on-LAN；取自本机 ARP 表，换机请改这里）
GW_MAC="60:ee:5c:f2:34:1d"
WOL_EVERY=60
STATUS_LOG=".cache/auto_sync.log"

mkdir -p .cache
slog() { echo "[$(date '+%F %T')] $*" >>"$STATUS_LOG"; }
ver_of() { sed -n 's|^// @version[[:space:]]*||p' "$1" 2>/dev/null | head -1; }
remote_ver() { curl --noproxy '*' -s -m 8 "$URL" | sed -n 's|^// @version[[:space:]]*||p' | head -1; }

# Wake-on-LAN：6×0xFF + 16×MAC，UDP 广播到 9 与 7 端口
send_wol() {
  command -v python3 >/dev/null 2>&1 || return 0
  python3 - "$GW_MAC" <<'PY' >/dev/null 2>&1
import socket, sys
mac = bytes.fromhex(sys.argv[1].replace(':', '').replace('-', ''))
pkt = b'\xff' * 6 + mac * 16
s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
s.setsockopt(socket.SOL_SOCKET, socket.SO_BROADCAST, 1)
for addr in ('192.168.31.255', '255.255.255.255'):
    for port in (9, 7):
        try:
            s.sendto(pkt, (addr, port))
        except OSError:
            pass
s.close()
PY
}

echo "=========================================================="
echo " 自动同步守护已启动"
echo "   本地脚本：$(pwd)/${LOCAL_FILE}"
echo "   目标网关：${HOST}:9111（不可达时自动发 Wake-on-LAN）"
echo "   检查间隔：${INTERVAL}s（Ctrl+C 退出）"
echo "   状态日志：${STATUS_LOG}"
echo "=========================================================="
echo

slog "守护启动（间隔 ${INTERVAL}s，本地 $(ver_of "$LOCAL_FILE")）"

last_state=""
last_wol=0
while true; do
  local_ver="$(ver_of "$LOCAL_FILE")"
  if [ -z "$local_ver" ]; then
    echo "[$(date '+%T')] ⚠️ 读不到本地版本号，等下一轮"
    sleep "$INTERVAL"
    continue
  fi

  # ---- 网关不可达：安静等待 + 定期唤醒 ----
  if ! curl --noproxy '*' -s -m 4 -o /dev/null "$URL"; then
    now="$(date +%s)"
    if [ "$last_state" != "offline" ]; then
      echo "[$(date '+%T')] 网关不可达 → 进入等待（每 ${WOL_EVERY}s 发一次 Wake-on-LAN）"
      slog "网关不可达，进入等待（本地 ${local_ver}）"
      last_state="offline"
      last_wol=0
    fi
    if [ $(( now - last_wol )) -ge "$WOL_EVERY" ]; then
      send_wol
      echo "[$(date '+%T')] 已发送 Wake-on-LAN（目标 MAC ${GW_MAC}）"
      slog "已发送 Wake-on-LAN 尝试唤醒网关机"
      last_wol="$now"
    fi
    sleep "$INTERVAL"
    continue
  fi

  # ---- 网关可达：比对版本 ----
  rver="$(remote_ver)"
  if [ "$rver" != "$local_ver" ]; then
    echo "[$(date '+%T')] 版本不一致：网关 ${rver:-无响应} → 本地 ${local_ver}，开始推送…"
    slog "检测到版本差异（网关 ${rver:-无响应} → 本地 ${local_ver}），开始推送"
    bash hooks/sync-to-nginx.sh
    new_ver="$(remote_ver)"
    if [ "$new_ver" = "$local_ver" ]; then
      echo "[$(date '+%T')] ✅ 推送成功，网关现在提供 ${new_ver}"
      slog "✅ 推送成功：网关已提供 ${new_ver}"
      last_state="synced"
    else
      echo "[$(date '+%T')] ⚠️ 推送后网关仍返回「${new_ver:-无响应}」，详见 .cache/nginx_sync.log"
      slog "⚠️ 推送后回验不一致：网关返回「${new_ver:-无响应}」，本地 ${local_ver}"
      last_state="failed"
    fi
  else
    if [ "$last_state" != "same" ]; then
      echo "[$(date '+%T')] 已是最新（${local_ver}），持续监控中…"
      slog "已是最新（${local_ver}）"
      last_state="same"
    fi
  fi
  sleep "$INTERVAL"
done
