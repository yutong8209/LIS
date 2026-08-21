#!/usr/bin/env python3
"""
MCP Image Reader Server
调用视觉模型 (mimo-v2.5) 识别图片，返回文字描述。
"""

import base64
import io
import os
import sys
import json
import urllib.request
from pathlib import Path

LOG_FILE = Path(__file__).parent / "mcp.log"

def log(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"[{__import__('datetime').datetime.now()}] {msg}\n")

log("Server starting...")

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

try:
    from PIL import Image
    HAS_PIL = True
except ImportError:
    HAS_PIL = False

app = Server("image-reader")


@app.list_tools()
async def list_tools():
    tools = [
        Tool(
            name="read_image",
            description="读取图片文件并返回基本信息（尺寸、格式等）",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "图片文件路径"}
                },
                "required": ["path"]
            }
        ),
        Tool(
            name="describe_image",
            description="调用视觉模型识别图片内容，返回文字描述。用于读取截图、代码截图、错误信息等。",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {"type": "string", "description": "图片文件路径"},
                    "prompt": {"type": "string", "description": "可选：自定义识别提示词"}
                },
                "required": ["path"]
            }
        )
    ]
    return tools


@app.call_tool()
async def call_tool(name: str, arguments: dict):
    log(f"Tool called: {name} with {arguments}")
    try:
        if name == "read_image":
            return await read_image(arguments["path"])
        elif name == "describe_image":
            prompt = arguments.get("prompt", "")
            return await describe_image(arguments["path"], prompt)
        else:
            return [TextContent(type="text", text=f"未知工具: {name}")]
    except Exception as e:
        log(f"Error: {str(e)}")
        return [TextContent(type="text", text=f"错误: {str(e)}")]


async def read_image(path: str):
    """读取图片基本信息"""
    path = Path(path).resolve()
    if not path.exists():
        return [TextContent(type="text", text=f"错误: 文件不存在 - {path}")]
    if not HAS_PIL:
        return [TextContent(type="text", text="错误: 未安装Pillow库")]
    with Image.open(path) as img:
        info = (
            f"文件: {path.name}\n"
            f"格式: {img.format}\n"
            f"模式: {img.mode}\n"
            f"尺寸: {img.width} x {img.height}\n"
            f"大小: {path.stat().st_size / 1024:.2f} KB"
        )
        return [TextContent(type="text", text=info)]


async def describe_image(path: str, custom_prompt: str = ""):
    """调用视觉模型识别图片内容"""
    path = Path(path).resolve()
    log(f"Describe: {path}")

    if not path.exists():
        return [TextContent(type="text", text=f"错误: 文件不存在 - {path}")]

    # 读取图片转 base64
    if HAS_PIL:
        with Image.open(path) as img:
            orig_w, orig_h = img.size
            info = f"图片: {path.name} | 尺寸: {orig_w}x{orig_h} | 格式: {img.format}"
            if img.mode in ('RGBA', 'LA', 'P'):
                img = img.convert('RGB')
            # 压缩大图：最长边不超过 800px
            max_size = 800
            if max(orig_w, orig_h) > max_size:
                ratio = max_size / max(orig_w, orig_h)
                img = img.resize((int(orig_w * ratio), int(orig_h * ratio)), Image.LANCZOS)
                log(f"Resized: {orig_w}x{orig_h} -> {img.width}x{img.height}")
            buf = io.BytesIO()
            img.save(buf, format='JPEG', quality=80)
            b64_data = base64.b64encode(buf.getvalue()).decode()
            media_type = "image/jpeg"
    else:
        with open(path, 'rb') as f:
            b64_data = base64.b64encode(f.read()).decode()
        ext = path.suffix.lower()
        mime_map = {'.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
                    '.gif': 'image/gif', '.bmp': 'image/bmp', '.webp': 'image/webp'}
        media_type = mime_map.get(ext, 'image/png')
        info = f"图片: {path.name}"

    # 视觉 API 配置
    api_base = os.environ.get('VISION_API_BASE',
                              os.environ.get('ANTHROPIC_BASE_URL',
                                             'https://token-plan-cn.xiaomimimo.com/anthropic'))
    api_key = os.environ.get('VISION_API_KEY',
                             os.environ.get('ANTHROPIC_AUTH_TOKEN', ''))
    model = os.environ.get('VISION_MODEL', 'mimo-v2.5')

    if not api_key:
        return [TextContent(type="text", text="错误: 未配置 VISION_API_KEY")]

    default_prompt = (
        "请详细描述这张图片的内容。如果是代码截图、错误信息、终端输出、UI界面等，"
        "请完整保留关键信息，包括代码文字、变量名、错误提示等。"
    )
    prompt = custom_prompt if custom_prompt else default_prompt

    log(f"Calling vision API: model={model}")

    # Anthropic Messages API
    url = api_base.rstrip('/') + '/v1/messages'
    payload = json.dumps({
        "model": model,
        "max_tokens": 1024,
        "messages": [{
            "role": "user",
            "content": [
                {
                    "type": "image",
                    "source": {
                        "type": "base64",
                        "media_type": media_type,
                        "data": b64_data
                    }
                },
                {"type": "text", "text": prompt}
            ]
        }]
    }).encode()

    req = urllib.request.Request(url, data=payload, headers={
        "x-api-key": api_key,
        "anthropic-version": "2023-06-01",
        "content-type": "application/json"
    })

    # 重试机制：最多重试3次
    max_retries = 3
    last_error = None

    for attempt in range(max_retries):
        try:
            log(f"API call attempt {attempt + 1}/{max_retries}")

            # 优先使用 httpx
            try:
                import httpx
                with httpx.Client(timeout=60) as client:
                    resp = client.post(url, content=payload, headers={
                        "x-api-key": api_key,
                        "anthropic-version": "2023-06-01",
                        "content-type": "application/json"
                    })
                    resp.raise_for_status()
                    data = resp.json()
            except ImportError:
                log("httpx not found, using urllib")
                with urllib.request.urlopen(req, timeout=60) as resp:
                    data = json.loads(resp.read())

            # 解析响应
            content = data.get("content", [])
            log(f"API response status: 200, content blocks: {len(content)}")

            if not content:
                log("Warning: empty content in response")
                if attempt < max_retries - 1:
                    import time
                    time.sleep(2)
                    continue
                return [TextContent(type="text", text="视觉模型返回空内容，请重试")]

            for block in content:
                if block.get("type") == "text" and block.get("text", "").strip():
                    result = f"[{info}]\n\n{block['text']}"
                    log(f"Result: {block['text'][:100]}...")
                    return [TextContent(type="text", text=result)]

            log(f"Warning: no text block found in content: {json.dumps(content, ensure_ascii=False)[:200]}")
            if attempt < max_retries - 1:
                import time
                time.sleep(2)
                continue
            return [TextContent(type="text", text="视觉模型未返回文本内容，请重试")]

        except Exception as e:
            last_error = e
            log(f"Attempt {attempt + 1} failed: {e}")
            if attempt < max_retries - 1:
                import time
                time.sleep(2)
                continue

    log(f"All {max_retries} attempts failed")
    return [TextContent(type="text", text=f"视觉 API 调用失败（重试{max_retries}次）: {last_error}")]


if __name__ == "__main__":
    import asyncio
    log("Starting server...")

    async def main():
        async with stdio_server() as (read_stream, write_stream):
            await app.run(read_stream, write_stream, app.create_initialization_options())

    asyncio.run(main())
