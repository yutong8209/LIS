#!/bin/bash
# 同步脚本到 nginx 机（科室电脑）：userscript + vendor → C:\lis-tools\
# 前提：nginx 那台 Windows 已开启 OpenSSH 服务器（开启方法见脚本末尾的错误提示）
# ↓↓↓ 按实际情况改这两行 ↓↓↓
WIN_USER="Administrator"      # nginx Windows 电脑的登录用户名
WIN_HOST="192.168.31.111"     # nginx 电脑的内网 IP（就是篡改猴更新地址里的那台）
WIN_DIR="C:/lis-tools"        # nginx 静态目录（与 nginx.conf 里的 alias 保持一致）

DIR="$(cd "$(dirname "$0")" && pwd)"
echo "==> 同步 3 个文件 → $WIN_USER@$WIN_HOST:$WIN_DIR/"
echo "    iMedicalLIS-enhancer.user.js + vendor/xlsx.full.min.js + vendor/jszip.min.js"
scp "$DIR/iMedicalLIS-enhancer.user.js" "$WIN_USER@$WIN_HOST:$WIN_DIR/" || {
  echo
  echo "❌ 传输失败。若从未开启过 SSH，请在 nginx 那台 Windows 上："
  echo "   ① 设置 → 应用 → 可选功能 → 添加可选功能 → 搜索并安装「OpenSSH 服务器」"
  echo "   ② 管理员 PowerShell 执行：Start-Service sshd; Set-Service sshd -StartupType Automatic"
  echo "   ③ 确认 C:\\lis-tools\\ 和 C:\\lis-tools\\vendor\\ 目录已建好"
  exit 1
}
scp "$DIR/vendor/xlsx.full.min.js" "$DIR/vendor/jszip.min.js" "$WIN_USER@$WIN_HOST:$WIN_DIR/vendor/" || {
  echo "❌ vendor 传输失败：确认 nginx 机 C:\\lis-tools\\vendor\\ 目录已存在"
  exit 1
}
echo
echo "✅ 同步完成。三台电脑的篡改猴会各自自动检查更新；急着要的话在篡改猴「实用工具」里手动点「检查更新」。"
