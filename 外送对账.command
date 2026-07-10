#!/bin/bash
# 双击运行：弹窗选择机构表 + LIS 导出，生成对账 Excel
cd "$(dirname "$0")" || exit 1
/usr/bin/env python3 "$(dirname "$0")/外送对账.py"
echo ""
read -r -p "按回车关闭…"
