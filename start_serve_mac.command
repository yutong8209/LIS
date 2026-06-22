#!/bin/bash
cd "$HOME/脚本"
echo "========================================="
echo "  脚本服务器已启动"
echo "  地址: http://localhost:8765/"
echo "  关闭此窗口停止服务"
echo "========================================="
python3 serve.py
