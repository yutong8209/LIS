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
  exit 1
}
scp -o BatchMode=yes -o ConnectTimeout=8 -o ConnectionAttempts=2 \
  "$DIR/vendor/xlsx.full.min.js" "$DIR/vendor/jszip.min.js" "$WIN_USER@$WIN_HOST:$WIN_DIR/vendor/" || {
  echo "❌ vendor 传输失败：确认 nginx 机 D:\\nginx-1.31.2\\lis-tools\\vendor\\ 目录已存在"
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
echo
echo "✅ 同步完成。三台电脑的篡改猴会各自自动检查更新；急着要的话在篡改猴「实用工具」里手动点「检查更新」。"
