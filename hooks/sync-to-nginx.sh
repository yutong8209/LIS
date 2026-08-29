#!/bin/bash
# 自动同步 userscript + vendor 到科室 nginx 网关机
# 由 hooks/post-commit 钩子在 commit 涉及脚本文件时后台触发，也可手动运行：
#   bash hooks/sync-to-nginx.sh
# 成功后用 curl 回验 nginx 实际返回的 @version，并把已同步 commit 写入 .cache/nginx_sync_state。
# 依赖：网关机 SSH 免密（id_ed25519 已授权）；失败时下次提交自动重试。
set -u
DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$DIR"

WIN_USER="1"
WIN_HOST="192.168.31.111"
WIN_DIR="D:/nginx-1.31.2/lis-tools"
NGINX_URL="http://${WIN_HOST}:9111/lis-tools/iMedicalLIS-enhancer.user.js"
CACHE="$DIR/.cache"
LOG="$CACHE/nginx_sync.log"
STATE="$CACHE/nginx_sync_state"
LOCK="$CACHE/nginx_sync.lock"
PENDING="$CACHE/nginx_sync_pending"
mkdir -p "$CACHE"

log() { echo "[$(date '+%F %T')] $*" >>"$LOG"; }

# 并发保护：多个 commit 连发时只跑一份，后来者留 pending 标记，收尾时补跑一次
if ! mkdir "$LOCK" 2>/dev/null; then
  touch "$PENDING"
  log "已有同步在跑，本次标记为待补跑"
  exit 0
fi
trap 'rmdir "$LOCK" 2>/dev/null' EXIT

local_ver="$(grep -m1 '^// @version' "$DIR/iMedicalLIS-enhancer.user.js" | sed 's/.*@version[[:space:]]*//')"
commit="$(git -C "$DIR" rev-parse --short HEAD 2>/dev/null || echo '?')"
log "==> 开始同步（commit ${commit}，版本 ${local_ver}）"

scp_err=""
# BatchMode：免密失败时快速报错而不是挂在密码输入上
scp -o BatchMode=yes -o ConnectTimeout=8 \
  "$DIR/iMedicalLIS-enhancer.user.js" "$WIN_USER@$WIN_HOST:$WIN_DIR/" 2>>"$LOG" || scp_err="userscript"
if [ -z "$scp_err" ]; then
  scp -o BatchMode=yes -o ConnectTimeout=8 \
    "$DIR/vendor/xlsx.full.min.js" "$DIR/vendor/jszip.min.js" \
    "$WIN_USER@$WIN_HOST:$WIN_DIR/vendor/" 2>>"$LOG" || scp_err="vendor"
fi

if [ -n "$scp_err" ]; then
  log "❌ 同步失败（$scp_err）。下次提交会自动重试；也可手动跑 bash hooks/sync-to-nginx.sh"
  exit 1
fi

# 用 HTTP 实测 nginx 返回的版本，确认部署真实生效（scp 成功 ≠ nginx 立即可用）
remote_ver="$(curl -s -m 6 "$NGINX_URL" | grep -m1 '^// @version' | sed 's/.*@version[[:space:]]*//')"
if [ "$remote_ver" = "$local_ver" ]; then
  echo "$commit|$local_ver|$(date '+%F %T')" >"$STATE"
  log "✅ 同步成功并验证：nginx 已提供 ${local_ver}（commit ${commit}）"
else
  log "⚠️ scp 完成，但 nginx 实际返回「${remote_ver:-无响应}」与本地 ${local_ver} 不一致，请检查网关机 nginx"
  exit 1
fi

# 补跑：同步期间又有新提交（先释放锁再重入）
if [ -f "$PENDING" ]; then
  rm -f "$PENDING"
  rmdir "$LOCK" 2>/dev/null
  log "检测到待补跑标记，立即再同步一次"
  "$0"
  exit $?
fi
