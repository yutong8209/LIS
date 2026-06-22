#!/usr/bin/env python3
"""
图片识别工具 - 直接运行即可识别图片
用法: python image-reader.py <图片路径>
"""

import sys
import io
from pathlib import Path

# 设置stdout为UTF-8编码
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

try:
    from PIL import Image
except ImportError:
    print("错误: 未安装Pillow库")
    print("请运行: pip install pillow")
    sys.exit(1)

def read_image(path):
    """读取图片基本信息"""
    path = Path(path).resolve()
    if not path.exists():
        print(f"错误: 文件不存在 - {path}")
        return

    try:
        with Image.open(path) as img:
            print("图片信息:")
            print(f"  文件路径: {path}")
            print(f"  格式: {img.format}")
            print(f"  模式: {img.mode}")
            print(f"  尺寸: {img.width} x {img.height}")
            print(f"  文件大小: {path.stat().st_size / 1024:.2f} KB")
    except Exception as e:
        print(f"读取图片失败: {e}")

if __name__ == "__main__":
    if len(sys.argv) < 2:
        print("用法: python image-reader.py <图片路径>")
        print("示例: python image-reader.py D:/test.png")
    else:
        read_image(sys.argv[1])
