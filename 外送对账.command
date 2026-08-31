#!/bin/bash
# 外送少收分析（双击运行）
# 逻辑：机构汇总表为基准；LIS 导出日期可更宽；只查「机构有、医院没有」→ 我院少收
# 用法：弹窗里 ⌘ 同时选中 机构xlsx + LIS的csv，再选保存位置

set -e
DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$DIR" || exit 1

export LANG=zh_CN.UTF-8
export LC_ALL=zh_CN.UTF-8

echo "=========================================="
echo "  外送少收分析"
echo "=========================================="
echo "  · 机构汇总表 = 固定基准"
echo "  · LIS 导出日期建议比机构单更宽"
echo "  · 只统计：机构有、医院没有 → 可能少收"
echo "  · 不统计：医院有、机构没有"
echo "  · 弹窗请 ⌘ 多选：机构 .xlsx + LIS .csv"
echo "=========================================="
echo ""

if ! command -v python3 >/dev/null 2>&1; then
  echo "错误：未找到 python3，请先安装 Python 3。"
  echo ""
  read -r -p "按回车关闭…"
  exit 1
fi

# 依赖检查（openpyxl / pandas）
if ! python3 -c "import pandas, openpyxl" 2>/dev/null; then
  echo "正在安装依赖 pandas、openpyxl …"
  python3 -m pip install --user pandas openpyxl || {
    echo "依赖安装失败，请手动执行：pip3 install pandas openpyxl"
    read -r -p "按回车关闭…"
    exit 1
  }
fi

# 默认少收模式（不带 --双向）
set +e
python3 "$DIR/外送对账.py"
RC=$?
set -e

echo ""
if [ "$RC" -eq 0 ]; then
  echo "完成。结果一般为「外送少收分析_时间戳.xlsx」，在下载文件夹或你刚才选择的路径。"
  # 尝试打开最近生成的少收分析表（下载目录优先）
  LATEST=""
  for d in "$HOME/Downloads" "$HOME/下载" "$DIR"; do
    [ -d "$d" ] || continue
    f=$(ls -t "$d"/外送少收分析*.xlsx 2>/dev/null | head -1)
    if [ -n "$f" ]; then
      LATEST="$f"
      break
    fi
  done
  if [ -n "$LATEST" ] && [ -f "$LATEST" ]; then
    echo "打开：$LATEST"
    open "$LATEST" 2>/dev/null || true
  fi
else
  echo "未完成（退出码 ${RC}）。若取消了选文件会如此；请重新双击再选。"
fi

echo ""
read -r -p "按回车关闭…"
exit "$RC"
