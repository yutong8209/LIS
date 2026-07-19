# AGENTS.md

## What this is

A Mac toolbox (`~/脚本`) centered on **iMedicalLIS-enhancer.user.js** — a Tampermonkey userscript for a hospital LIS at `http://192.168.31.111:9111/iMedicalLIS/*` (via nginx proxy) or `http://10.0.29.100/iMedicalLIS/*` (direct). Modules include report review automation, patient result export, QC data export, and QC chart enhancement. Supporting scripts provide screenshot and browser automation.

## Key files

| File | Purpose |
|---|---|
| `iMedicalLIS-enhancer.user.js` | Main userscript. Report review automation, batch approve, hotkeys, result classification, QC data export. |
| `serve.py` / `serve.js` | Local HTTP server on `localhost:8765`（推荐 **serve.py**）serving userscript + `vendor/` for TM auto-update. |
| `vendor/xlsx.full.min.js` | SheetJS 本地副本（质控导出，不走公网 CDN） |
| `start_serve_mac.command` | Mac startup script — double-click or add to Login Items. |
| `start_serve.bat` | Windows 启动 serve（质控导出必需） |
| `外送对账.py` / `外送对账.bat` / `外送对账.command` | 外送少收分析（机构账单 vs LIS 导出） |
| `Windows安装-含质控.md` | **Windows 整包转移**（审核 + 质控 + 外送对账） |
| `browser_control.py` | CLI for screenshot, click, type, key — outputs JSON. |
| `image-reader.py` | CLI to read local image metadata (path, format, size). |
| `image-reader-hook.py` | Stdin hook that detects image paths in text and prints info. |
| `mcp-image-reader/` | MCP server: `read_image`, `describe_image` tools. |
| `质控模板/` | 9 个质控数据上传模板 xlsx（血常规/生化/凝血/血脂/尿常规/内分泌/肿瘤/心肌/传染病） |
| `lis_proxy.py` | 反向代理 & 代码缓存器 — 默认只缓存静态前端到 `cache/`（`--cache-api` 才缓存接口） |
| `menubar/lis-audit.5s.sh` | SwiftBar 菜单栏插件 — 显示当前筛选范围的可批审/异常待审数（读 serve.py 的 `/stats`） |
| `HANDTEST.md` | 发布前手测清单（批审 / F4 必测） |
| `requirements.txt` | Python 依赖 |

## Commands

```bash
# Dev server (serves userscript + vendor for Tampermonkey)
python3 ~/脚本/serve.py
# or: node ~/脚本/serve.js
# Windows: 双击 start_serve.bat（质控 Excel 依赖此服务）

# Screenshot from desktop (returns base64)
python3 ~/脚本/browser_control.py screenshot

# Read image metadata
python3 ~/脚本/image-reader.py "/path/to/image.png"

# LIS 前端缓存代理（默认不缓存 API）
python3 ~/脚本/lis_proxy.py
python3 ~/脚本/lis_proxy.py --cache-api   # 仅调试接口时
```

Windows 整包转移（审核 + 质控 + 外送对账）：见 **`Windows安装-含质控.md`**。

## Dependencies & setup

```bash
pip3 install -r ~/脚本/requirements.txt
```

- **Python packages**: 见 `requirements.txt`（`pillow`, `mss`, `pyautogui`, 可选 `mcp`）
- **MCP config**: each MCP server has its own `config.json` in its subdirectory（勿提交密钥）。
- Tampermonkey 更新前请保持 **serve.py 运行**，否则 SheetJS `@require` 与脚本更新会失败。
- **菜单栏功能**（可选）：`brew install --cask swiftbar`（`jq` 系统自带 `/usr/bin/jq`）。菜单栏读数依赖 **serve.py 在线**。⚠️ **已取消开机自启**：launchd 服务 `com.yutong.lis-serve` 已 `unload`（plist 仍保留在 `~/Library/LaunchAgents/` 备用），不再开机自启/崩溃自拉起。改为**手动开关**：
  - 用的时候双击 `start_lis_menubar.command` → 启动 serve.py（nohup 后台）+ 打开 SwiftBar
  - 不用的时候双击 `stop_lis_menubar.command` → 退出 SwiftBar + 停止 serve.py（无后台残留）
  - 想恢复开机自启：`launchctl load ~/Library/LaunchAgents/com.yutong.lis-serve.plist`
  数据由 userscript 的 `renderWSCategoryBar` 推送到 `POST /stats`，落盘 `.cache/menubar_stats.json`。
  - **⚠️ 中文路径坑（必读）**：SwiftBar 的 `PluginDirectory` 偏好会把中文「脚本」存成字面 unicode 转义（`\u811a\u672c`），导致它读不到 `~/脚本/menubar`。正确做法：建纯英文软链接 `ln -sfn "/Users/yutong/脚本/menubar" "/Users/yutong/lis-menubar"`，再把 `PluginDirectory` 设为 `/Users/yutong/lis-menubar`（纯 ASCII）。改插件后若菜单栏没更新，先 `pkill -x SwiftBar && open -a SwiftBar` 重启，再 `open "swiftbar://refreshallplugins"`。
  - 插件：`menubar/lis-audit.5s.sh`（Apple 风格 SF Symbols + 分类对齐下拉，深色菜单栏专用配色）。下拉每行点击可跳转：经由 `menubar/lis_jump.sh` 发 `POST /cmd`（goto 分类）给 serve.py，userscript 轮询消费后切到对应工作台标签（normal/abnormal/pending/incomplete/all），并 `open -a "Google Chrome"` 聚焦已开的 LIS 标签。

## Coding conventions

- All scripts use UTF-8.
- Comments and UI strings are in **Chinese (简体中文)**. Match this.
- `browser_control.py` and MCP servers output **JSON** — preserve this contract.
- The userscript targets `192.168.31.111:9111` (nginx proxy) and `10.0.29.100` (direct). Do not change host/port without confirming.
- Userscript version is in the `@version` header. Bump on meaningful changes.
- **审核热路径**（`continueAuditQueue` / `clickNativeAuditButton` / `executeNativeAudit` / F4）改动后必须按 `HANDTEST.md` 手测，不要只改本地不回归。

## 发布流程（每次改完必做）

1. **Bump** `@version`（有意义变更时）
2. **手测**：至少 `HANDTEST.md` §1 批审 + §2 F4
3. **Commit**：中文说明，写清改了什么、为什么
4. **Push**：`git push` 到 `origin/main`（用户要求每次更新后自动推送，不要只改本地）
5. **Diff 摘要**：回复里用 `git show --stat` 或 `git diff` 概括变更文件与要点，方便用户核对

## Gotchas

- `browser_control.py` uses `mss` for screenshots (not pyautogui) — captures full primary monitor.
- `pyautogui.typewrite()` only handles ASCII — Chinese input needs a different approach.
- No automated test suite. Verify with `HANDTEST.md`.
- 密码：HTTP 内网无 WebCrypto 时仅为 base64 可逆存储，勿在共享电脑勾选记住密码。
- `cache/` 可能曾含接口响应；默认代理已改为不缓存 API，可定期清空 cache。
