#!/usr/bin/env python3
"""
图片识别 Hook - 自动检测用户消息中的图片文件并读取
"""

import sys
import re
import json
from pathlib import Path

# 图片文件扩展名
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif'}

def find_image_files(text):
    """在文本中查找图片文件路径"""
    # 匹配 Windows 路径 (D:/path 或 D:\path)
    patterns = [
        r'[A-Za-z]:[/\\][^\s"\'<>|?*]+\.(?:png|jpg|jpeg|gif|bmp|webp|tiff|tif)',
        r'[/\\][^\s"\'<>|?*]+\.(?:png|jpg|jpeg|gif|bmp|webp|tiff|tif)',
    ]

    found = set()
    for pattern in patterns:
        matches = re.findall(pattern, text, re.IGNORECASE)
        for match in matches:
            # 清理路径
            path = match.strip('"\'')
            if Path(path).suffix.lower() in IMAGE_EXTENSIONS:
                found.add(path)

    return list(found)

def read_image_info(path):
    """读取图片信息"""
    try:
        from PIL import Image
        path = Path(path).resolve()

        if not path.exists():
            return f"错误: 文件不存在 - {path}"

        with Image.open(path) as img:
            info = {
                "文件路径": str(path),
                "格式": img.format,
                "模式": img.mode,
                "尺寸": f"{img.width} x {img.height}",
                "文件大小": f"{path.stat().st_size / 1024:.2f} KB"
            }

            result = "[图片信息]\n"
            for key, value in info.items():
                result += f"  {key}: {value}\n"

            return result
    except Exception as e:
        return f"读取图片失败: {e}"

def main():
    try:
        # 读取用户输入
        import io
        sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
        sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

        user_input = sys.stdin.read()

        # 查找图片文件
        image_files = find_image_files(user_input)

        if image_files:
            results = []
            for img_path in image_files:
                result = read_image_info(img_path)
                results.append(result)

            # 输出结果
            output = "\n\n".join(results)
            print(output)
        else:
            # 没有图片，输出空
            pass

    except Exception as e:
        # 静默失败，不影响用户交互
        pass

if __name__ == "__main__":
    main()
