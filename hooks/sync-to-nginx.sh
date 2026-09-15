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
# 8.10.0: 锁目录内写时间戳，锁龄超过 600s 判为残留（kill -9 / 断电 / 进程被杀，
# EXIT trap 不会执行）并强制接管——此前残留锁会让自动同步从此永久静默停摆。
LOCK_MAX_AGE=600
if ! mkdir "$LOCK" 2>/dev/null; then
  lock_age="$LOCK_MAX_AGE"
  [ -f "$LOCK/ts" ] && lock_age=$(( $(date +%s) - $(cat "$LOCK/ts" 2>/dev/null || echo 0) ))
  lock_pid="$(cat "$LOCK/pid" 2>/dev/null || echo '')"
  # 8.16.5: 判据从「只看锁龄」升级为「先看持锁进程是否还活着」。
  # 钩子是用 nohup 起的后台任务，提交命令一返回就可能被整进程组带走（SIGKILL 无法 trap，
  # trap EXIT 不会执行，锁留在原地）。此前只能干等 600s 才自动接管，表现是
  # 「自动同步静默停摆、要人工 rm 锁 + 手动补跑」（2026-09-15 连踩两次）。
  # 进程已死 → 立刻接管；进程还在 → 按原逻辑留 pending 待补跑。
  if [ -n "$lock_pid" ] && ! kill -0 "$lock_pid" 2>/dev/null; then
    log "⚠️ 同步锁的持锁进程 ${lock_pid} 已不存在（锁龄 ${lock_age}s），立即接管"
    rm -rf "$LOCK"
  elif [ -z "$lock_pid" ] && [ "$lock_age" -gt 30 ]; then
    # 没有 pid 的锁只可能来自「旧版脚本」或「mkdir 与写 pid 之间被 kill」——
    # 一次正常同步约 8s，超过 30s 还没写 pid 就一定没有活着的持有者。
    log "⚠️ 同步锁无持锁进程记录且已存在 ${lock_age}s（>30s），判定为陈旧锁，立即接管"
    rm -rf "$LOCK"
  elif [ "$lock_age" -gt "$LOCK_MAX_AGE" ]; then
    log "⚠️ 同步锁已残留 ${lock_age}s（>${LOCK_MAX_AGE}s），判定为陈旧锁，强制接管"
    rm -rf "$LOCK"
  else
    touch "$PENDING"
    log "已有同步在跑，本次标记为待补跑"
    exit 0
  fi
  if ! mkdir "$LOCK" 2>/dev/null; then
    touch "$PENDING"
    log "接管失败（另一进程刚好抢到锁），本次标记为待补跑"
    exit 0
  fi
fi
date +%s > "$LOCK/ts"
echo $$ > "$LOCK/pid"
trap 'rm -rf "$LOCK" 2>/dev/null' EXIT

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
# 原生 IE 启动器（工作台弹窗里的配置包下载链接指向网关机；失败不阻塞主同步）
if [ -z "$scp_err" ]; then
  for f in "配置工作台-原生IE直达.bat" "setup-native-ie.bat" "启动病历-原生IE.bat" "启动病历-原生IE.vbs" "launch_ie.vbs"; do
    [ -f "$DIR/$f" ] || continue
    scp -o BatchMode=yes -o ConnectTimeout=8 \
      "$DIR/$f" "$WIN_USER@$WIN_HOST:$WIN_DIR/" 2>>"$LOG" || { scp_err="launcher:$f"; break; }
  done
fi

if [ -n "$scp_err" ]; then
  log "❌ 同步失败（${scp_err}）。下次提交会自动重试；也可手动跑 bash hooks/sync-to-nginx.sh"
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
  rm -rf "$LOCK" 2>/dev/null
  trap - EXIT # 8.10.0: 锁已移交，解除本进程的清锁责任，防止退出时误删补跑进程的新锁
  log "检测到待补跑标记，立即再同步一次"
  "$0"
  exit $?
fi
