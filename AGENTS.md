# AGENTS.md

## What this is

A Mac toolbox (`~/脚本`) centered on **iMedicalLIS-enhancer.user.js** — a Tampermonkey userscript for a hospital LIS at `http://192.168.31.111:9111/iMedicalLIS/*` (via nginx proxy) or `http://10.0.29.100/iMedicalLIS/*` (direct). Modules include report review automation, patient result export, QC data export, and QC chart enhancement. Supporting scripts provide screenshot and browser automation.

## Key files

| File | Purpose |
|---|---|
| `iMedicalLIS-enhancer.user.js` | Main userscript. Report review automation, batch approve, hotkeys, result classification, QC data export. |
| `serve.py` / `serve.js` | Local HTTP server on `localhost:8765` serving the userscript for Tampermonkey auto-update. |
| `start_serve_mac.command` | Mac startup script — double-click or add to Login Items. |
| `browser_control.py` | CLI for screenshot, click, type, key — outputs JSON. |
| `image-reader.py` | CLI to read local image metadata (path, format, size). |
| `image-reader-hook.py` | Stdin hook that detects image paths in text and prints info. |
| `mcp-image-reader/` | MCP server: `read_image`, `describe_image` tools. |
| `质控模板/` | 9 个质控数据上传模板 xlsx（血常规/生化/凝血/血脂/尿常规/内分泌/肿瘤/心肌/传染病） |

## Commands

```bash
# Dev server (serves userscript for Tampermonkey)
python3 ~/脚本/serve.py
# or: node ~/脚本/serve.js

# Screenshot from desktop (returns base64)
python3 ~/脚本/browser_control.py screenshot

# Read image metadata
python3 ~/脚本/image-reader.py "/path/to/image.png"
```

## Dependencies & setup

- **Python packages**: `pillow`, `mss`, `pyautogui`
- **MCP config**: each MCP server has its own `config.json` in its subdirectory.

## Coding conventions

- All scripts use UTF-8.
- Comments and UI strings are in **Chinese (简体中文)**. Match this.
- `browser_control.py` and MCP servers output **JSON** — preserve this contract.
- The userscript targets `192.168.31.111:9111` (nginx proxy) and `10.0.29.100` (direct). Do not change host/port without confirming.
- Userscript version is in the `@version` header. Bump on meaningful changes.

## 发布流程（每次改完必做）

1. **Bump** `@version`（有意义变更时）
2. **Commit**：中文说明，写清改了什么、为什么
3. **Push**：`git push` 到 `origin/main`（用户要求每次更新后自动推送，不要只改本地）
4. **Diff 摘要**：回复里用 `git show --stat` 或 `git diff` 概括变更文件与要点，方便用户核对

## Gotchas

- `browser_control.py` uses `mss` for screenshots (not pyautogui) — captures full primary monitor.
- `pyautogui.typewrite()` only handles ASCII — Chinese input needs a different approach.
- No test suite, no lint, no typecheck. Verify changes by running the scripts manually.

## Key files (续)

| `lis_proxy.py` | 反向代理 & 代码缓存器 — 自动抓取 LIS 前端代码到本地 `cache/` 目录 |
