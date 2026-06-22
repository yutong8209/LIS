# MCP Image Reader

图片识别 MCP 服务器，为 2.5pro 模型提供图片读取能力。

## 功能

- `read_image` - 读取图片基本信息（尺寸、格式等）
- `describe_image` - 读取图片并返回 base64，由模型直接识别内容

## 安装依赖

```bash
pip install mcp pillow
```

## 配置

已自动配置到 `~/.claude/settings.json`：

```json
{
  "mcpServers": {
    "image-reader": {
      "command": "python",
      "args": ["D:/脚本/mcp-image-reader/server.py"]
    }
  }
}
```

## 使用方法

重启 Claude Code 后，可以直接使用：

```
读取图片: D:/脚本/mcp-image-reader/test.png
```

图片内容由 2.5pro 模型直接识别，无需 OCR。

## 测试图片

已创建测试图片: `D:/脚本/mcp-image-reader/test.png`
