#!/usr/bin/env python3
"""
MCP Image Reader Server
提供图片读取和识别功能（由 2.5pro 模型直接识别图片内容）
"""

import base64
import io
import os
import sys
from pathlib import Path

# 添加日志
LOG_FILE = Path(__file__).parent / "mcp.log"

def log(msg):
    with open(LOG_FILE, "a", encoding="utf-8") as f:
        f.write(f"[{__import__('datetime').datetime.now()}] {msg}\n")

log("Server starting...")

from mcp.server import Server
from mcp.server.stdio import stdio_server
from mcp.types import TextContent, Tool

# 尝试导入图片处理库
try:
    from PIL import Image
    HAS_PIL = True
    log("Pillow loaded")
except ImportError:
    HAS_PIL = False
    log("Pillow not found")



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
                    "path": {
                        "type": "string",
                        "description": "图片文件路径"
                    }
                },
                "required": ["path"]
            }
        ),
        Tool(
            name="describe_image",
            description="读取图片并返回 base64，由模型直接识别内容",
            inputSchema={
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "图片文件路径"
                    }
                },
                "required": ["path"]
            }
        )
    ]
    log(f"Listing {len(tools)} tools")
    return tools

@app.call_tool()
async def call_tool(name: str, arguments: dict):
    log(f"Tool called: {name} with {arguments}")
    try:
        if name == "read_image":
            return await read_image(arguments["path"])
        elif name == "describe_image":
            return await describe_image(arguments["path"])
        else:
            return [TextContent(type="text", text=f"未知工具: {name}")]
    except Exception as e:
        log(f"Error: {str(e)}")
        return [TextContent(type="text", text=f"错误: {str(e)}")]

async def read_image(path: str):
    """读取图片基本信息"""
    try:
        path = Path(path).resolve()
        log(f"Reading image: {path}")

        if not path.exists():
            return [TextContent(type="text", text=f"错误: 文件不存在 - {path}")]

        if not HAS_PIL:
            return [TextContent(type="text", text="错误: 未安装Pillow库，请运行: pip install pillow")]

        with Image.open(path) as img:
            info = {
                "文件路径": str(path),
                "格式": img.format,
                "模式": img.mode,
                "尺寸": f"{img.width} x {img.height}",
                "文件大小": f"{path.stat().st_size / 1024:.2f} KB"
            }

            result = "图片信息:\n"
            for key, value in info.items():
                result += f"  {key}: {value}\n"

            log(f"Success: {info}")
            return [TextContent(type="text", text=result)]
    except Exception as e:
        log(f"Error: {str(e)}")
        return [TextContent(type="text", text=f"读取图片失败: {str(e)}")]

async def describe_image(path: str):
    """读取图片并返回 base64，由模型直接识别内容"""
    try:
        import base64
        path = Path(path).resolve()
        log(f"Describe image: {path}")

        if not path.exists():
            return [TextContent(type="text", text=f"错误: 文件不存在 - {path}")]

        if not HAS_PIL:
            return [TextContent(type="text", text="错误: 未安装Pillow库")]

        with Image.open(path) as img:
            # 返回图片尺寸等基本信息，以及 base64 供模型识别
            info = f"图片: {path.name}\n尺寸: {img.width}x{img.height}\n格式: {img.format}\n"

            buf = io.BytesIO()
            img.save(buf, format="PNG")
            b64 = base64.b64encode(buf.getvalue()).decode()

            return [
                TextContent(type="text", text=info),
                TextContent(type="image", data=b64, mimeType="image/png")
            ]
    except Exception as e:
        log(f"Error: {str(e)}")
        return [TextContent(type="text", text=f"读取图片失败: {str(e)}")]

if __name__ == "__main__":
    import asyncio
    log("Starting server main...")

    async def main():
        async with stdio_server() as (read_stream, write_stream):
            await app.run(read_stream, write_stream, app.create_initialization_options())

    asyncio.run(main())
