#!/bin/bash
# 同步脚本到 nginx 网关机：userscript + vendor → nginx 那台电脑的 D:\nginx-1.31.2\lis-tools\
#
# ⚠️ 目标是「装 nginx 的那台网关电脑」（192.168.31.111，监听 9111 的那台），
#    不是装篡改猴的两台客户端（LIS_Office@.251 / lenovo@.32）——客户端会自动从 nginx 拉更新，不用推。
#
# 前提：nginx 网关机已开启 OpenSSH 服务器（开启方法见脚本末尾的错误提示）
# ❗❗ 按实际情况改下面这行：nginx 网关机的 Windows 登录用户名 ❗❗
WIN_USER="1"
WIN_HOST="192.168.31.111"     # nginx 网关机 IP（= 篡改猴更新地址里的那台）
WIN_DIR="D:/nginx-1.31.2/lis-tools"   # nginx 静态目录（与 nginx.conf 里的 alias 保持一致）

# 清理代理环境变量，强制局域网直连
unset http_proxy https_proxy all_proxy ALL_PROXY HTTP_PROXY HTTPS_PROXY
export NO_PROXY="localhost,127.0.0.1,192.168.*,10.*"
export no_proxy="localhost,127.0.0.1,192.168.*,10.*"

DIR="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$DIR/.cache"
# 先记一行「开始」：否则脚本在 scp 阶段就失败（下面的 exit 1）时，日志里什么都看不到，
# 事后无法区分「没点过」和「点了但失败」（本次排查就踩过这个坑）。
cmd_log() { echo "[$(date '+%F %T')] $*" >>"$DIR/.cache/nginx_sync.log"; }
cmd_log "==> 手动同步（同步脚本到nginx.command，本地 $(sed -n 's|^// @version[[:space:]]*||p' "$DIR/iMedicalLIS-enhancer.user.js" | head -1)）"
echo "==> 同步脚本 + vendor + 原生IE启动器 → $WIN_USER@$WIN_HOST:$WIN_DIR/"
echo "    iMedicalLIS-enhancer.user.js + vendor/xlsx.full.min.js + vendor/jszip.min.js"
echo "    + 配置工作台-原生IE直达.bat / setup-native-ie.bat / 启动病历-原生IE.bat(.vbs) / launch_ie.vbs"
scp -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=2 \
  "$DIR/iMedicalLIS-enhancer.user.js" "$WIN_USER@$WIN_HOST:$WIN_DIR/" || {
  echo
  echo "❌ 传输失败。若从未开启过 SSH，请在 nginx 那台 Windows 上："
  echo "   ① 设置 → 应用 → 可选功能 → 添加可选功能 → 搜索并安装「OpenSSH 服务器」"
  echo "   ② 管理员 PowerShell 执行：Start-Service sshd; Set-Service sshd -StartupType Automatic"
  echo "   ③ 确认 D:\\nginx-1.31.2\\lis-tools\\ 和 D:\\nginx-1.31.2\\lis-tools\\vendor\\ 目录已建好"
  cmd_log "❌ 手动同步失败：userscript scp 传输失败（网关不可达 / SSH 未开 / 免密未配）"
  exit 1
}
scp -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=2 \
  "$DIR/vendor/xlsx.full.min.js" "$DIR/vendor/jszip.min.js" "$WIN_USER@$WIN_HOST:$WIN_DIR/vendor/" || {
  echo "❌ vendor 传输失败：确认 nginx 机 D:\\nginx-1.31.2\\lis-tools\\vendor\\ 目录已存在"
  cmd_log "❌ 手动同步失败：vendor scp 传输失败"
  exit 1
}
# 8.15.4: 补上原生 IE 启动器（合并为单次 scp，减少频繁建立连接）
launcher_files=()
for f in "配置工作台-原生IE直达.bat" "setup-native-ie.bat" "启动病历-原生IE.bat" "启动病历-原生IE.vbs" "launch_ie.vbs"; do
  [ -f "$DIR/$f" ] && launcher_files+=("$DIR/$f")
done
if [ ${#launcher_files[@]} -gt 0 ]; then
  scp -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=2 \
    "${launcher_files[@]}" "$WIN_USER@$WIN_HOST:$WIN_DIR/" || {
    echo "⚠️ 启动器传输失败（不影响脚本与 vendor，可稍后重试）"
  }
fi
# ==================== 版本回验（scp 成功 ≠ nginx 真的在提供新版） ====================
# 缓存 / 目录写错 / nginx 未 reload 都会让「传输成功」变成静默失效，所以必须回验实际返回的版本。
# 显式 --noproxy '*'：本机代理会拦内网并把回验变成 502 假象（本次排查中被误导过一次）。
local_ver="$(grep -m1 '^// @version' "$DIR/iMedicalLIS-enhancer.user.js" | sed 's/.*@version[[:space:]]*//')"
remote_ver="$(curl --noproxy '*' -s -m 8 "http://$WIN_HOST:9111/lis-tools/iMedicalLIS-enhancer.user.js" \
  | grep -m1 '^// @version' | sed 's/.*@version[[:space:]]*//')"
echo
if [ "$remote_ver" = "$local_ver" ]; then
  echo "✅ 同步完成并回验通过：网关已提供 $remote_ver"
  echo "   三台电脑的篡改猴会各自自动检查更新；急着要的话在篡改猴「实用工具」里手动点「检查更新」。"
  sync_result="✅ 同步成功并验证：nginx 已提供 ${local_ver}（手动 command）"
else
  echo "⚠️ scp 已完成，但网关实际返回「${remote_ver:-无响应}」，本地是 $local_ver"
  echo "   请检查网关机 nginx（D:\\nginx-1.31.2\\lis-tools\\ 与 nginx.conf 的 alias 是否一致）后重跑本脚本。"
  sync_result="⚠️ scp 完成但回验不一致：网关返回「${remote_ver:-无响应}」，本地 ${local_ver}"
fi
# 写进与 hooks/sync-to-nginx.sh 同一个日志，便于事后核对「哪次是手动推的、推的是哪版」
mkdir -p "$DIR/.cache"
echo "[$(date '+%F %T')] ${sync_result}" >>"$DIR/.cache/nginx_sync.log"
echo
echo "（日志：$DIR/.cache/nginx_sync.log）"
