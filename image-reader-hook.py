#!/usr/bin/env python3
"""
图片识别 Hook - 自动检测用户消息中的图片文件并读取
"""

import os
import sys
import re
import json
from pathlib import Path

# 图片文件扩展名
IMAGE_EXTENSIONS = {'.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp', '.tiff', '.tif'}

_EXT = r'(?:png|jpg|jpeg|gif|bmp|webp|tiff|tif)'

def find_image_files(text):
    """在文本中查找图片文件路径（支持引号包裹的含空格路径，如 Mac 截屏文件名）。

    正则刻意不使用反斜杠转义（用否定字符类代替 \s、[/\\]），保证跨平台/跨写入方式稳定。
    """
    patterns = [
        # 引号包裹的 Windows 路径（体内允许空格与反斜杠，如 "D:\截屏 2026.png"）
        r"""["']([A-Za-z]:[^"']+.""" + _EXT + r""")["']""",
        # 引号包裹的 Unix 路径（体内允许空格，Mac 截屏「浮光截屏 2026-...png」依赖此分支）
        r"""["']([/~][^"']+.""" + _EXT + r""")["']""",
        # 未加引号的 Windows 路径（不含空格）
        r"""[A-Za-z]:[^ "'<>|?*]+.""" + _EXT,
        # 未加引号的 Unix 路径（不含空格）
        r"""[/~][^ "'<>|?*]+.""" + _EXT,
    ]

    found = set()
    for pattern in patterns:
        for match in re.findall(pattern, text, re.IGNORECASE):
            # findall 对带捕获组的模式返回捕获内容，否则返回整体匹配
            path = match if isinstance(match, str) else (match[0] if match else '')
            # 清理引号与可能粘连的中文句尾标点（。，、）等）
            path = path.strip('"').strip("'").rstrip('。，、；）)》]')
            path = os.path.expanduser(path)
            if Path(path).suffix.lower() in IMAGE_EXTENSIONS:
                found.add(path)

    return list(found)

def read_image_info(path):
    """读取图片信息"""
    try:
        from PIL import Image
        path = Path(os.path.expanduser(path)).resolve()

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
        # 不干扰 stdout 契约：错误只打到 stderr，便于排查
        print(f"[image-reader-hook] {e}", file=sys.stderr)

if __name__ == "__main__":
    main()
