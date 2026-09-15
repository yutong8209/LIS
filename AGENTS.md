# AGENTS.md

## What this is

A Mac toolbox (`~/脚本`) centered on **iMedicalLIS-enhancer.user.js** — a Tampermonkey userscript for a hospital LIS at `http://192.168.31.111:9111/iMedicalLIS/*` (via nginx proxy) or `http://10.0.29.100/iMedicalLIS/*` (direct). Modules include report review automation, patient result export, QC data export, and QC chart enhancement. Supporting scripts provide screenshot and browser automation.

## Key files

| File | Purpose |
|---|---|
| `iMedicalLIS-enhancer.user.js` | Main userscript. Report review automation, batch approve, hotkeys, result classification, QC data export. |
| `serve.py` / `serve.js` | Local HTTP server on `localhost:8765`（推荐 **serve.py**）serving userscript + `vendor/` for TM auto-update. 8.9.7 起脚本/vendor 主源为科室 nginx，serve 主要剩 **Mac 菜单栏 /stats** 与**推送兜底**。 |
| `bark-relay/` | **8.9.7: 网关机 Bark 推送中转**（部署在 192.168.31.111 的 `D:\bark-relay\`，勿放进 nginx 网络目录）——nginx 把 `/notify*` 反代到它（127.0.0.1:8766），所有机器推送无需本机开 serve；部署步骤见 `bark-relay/README-网关部署.md`。userscript 推送端点：网关中转优先 → 本机 8765 兜底（粘滞记忆）。 |
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
| `hooks/` | **自动同步+纪律守卫钩子**（`core.hooksPath` 已指向此目录，对任何 agent/人的提交生效）：pre-commit 拦「改脚本不 bump @version」和「改 vendor 不更新 VENDOR_SHA256」；post-commit 在提交涉及 `.user.js`/`vendor` 时后台 scp 到科室 nginx 并 curl 回验版本；日志 `.cache/nginx_sync.log`；`LIS_NO_SYNC=1 git commit` 跳过自动同步，`--no-verify` 跳过守卫检查 |
| `同步脚本到nginx.command` | 手动同步脚本到 nginx 网关机（一般用不到，钩子会自动同步） |
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
- Tampermonkey 更新前请保持 **serve.py 运行**，否则 SheetJS `@require` 与脚本更新会失败。（8.9.7 起 vendor/脚本主源为科室 nginx，本条主要针对推送兜底与 Mac 菜单栏；推送主通道是网关机 bark-relay。）
- **菜单栏功能**（可选）：`brew install --cask swiftbar`（`jq` 系统自带 `/usr/bin/jq`）。菜单栏读数依赖 **serve.py 在线**。⚠️ **8.9.7 起已彻底禁用开机自启**：launchd 服务 `com.yutong.lis-serve` 已 `bootout` + `disable`（此前仅 unload 过一次，重启登录后 plist 又自动加载回来了——教训：LaunchAgents 目录里的 plist 必须 `launchctl disable` 或移走才算真禁用）。plist 文件仍留在 `~/Library/LaunchAgents/com.yutong.lis-serve.plist`（被 disable 挡住，不会加载；想删可手动 `rm`）。改为**手动开关**：
  - 用的时候双击 `start_lis_menubar.command` → 启动 serve.py（nohup 后台）+ 打开 SwiftBar
  - 不用的时候双击 `stop_lis_menubar.command` → 退出 SwiftBar + 停止 serve.py（无后台残留）
  - 想恢复开机自启：`launchctl enable gui/$(id -u)/com.yutong.lis-serve && launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.yutong.lis-serve.plist`（disable 挡着，单纯 load/bootstrap 拉不起来）
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

## 发布流程（每次改完必做，缺一不可）

> ⚠️ **铁律：改完代码 → 改版本号 → commit → push，四步必须在同一轮完成，不要拆到下一次。**
> Tampermonkey 靠 `@version` 检测更新，不改版本号用户端永远拉不到新代码。

1. **Bump `@version`** — 任何对 `.user.js` 的修改都必须递增版本号（`8.0.8` → `8.0.9`），不管改动大小。**pre-commit 钩子会自动拦下没递增的提交**（换 vendor 文件同理，须同步更新脚本内 `VENDOR_SHA256`）
2. **Commit**：中文说明，写清改了什么、为什么。**commit 后 post-commit 钩子会自动把 userscript + vendor scp 到科室 nginx 并 curl 回验版本**——失败自动留给下次提交重试，日志在 `.cache/nginx_sync.log`，跳过一次用 `LIS_NO_SYNC=1 git commit ...`，手动补跑 `bash hooks/sync-to-nginx.sh`
3. **Push**：`git push` 到 `origin/main`（不要只改本地，必须推送）
4. **验证**：`curl -s http://localhost:8765/iMedicalLIS-enhancer.user.js | head -4` 确认 serve 返回的是新版本号；如果不是，重启 serve.py。nginx 同步结果看 `.cache/nginx_sync.log` / `.cache/nginx_sync_state`
5. **手测**：至少 `HANDTEST.md` §1 批审 + §2 F4
6. **Diff 摘要**：回复里用 `git show --stat` 或 `git diff` 概括变更文件与要点，方便用户核对

## Gotchas

- `browser_control.py` uses `mss` for screenshots (not pyautogui) — captures full primary monitor.
- `pyautogui.typewrite()` only handles ASCII — Chinese input needs a different approach.
- No automated test suite. Verify with `HANDTEST.md`.
- 密码：HTTP 内网无 WebCrypto 时仅为 base64 可逆存储，勿在共享电脑勾选记住密码。
- `cache/` 可能曾含接口响应；默认代理已改为不缓存 API，可定期清空 cache。
- **代理与 GitHub 推送**：当前代理 App（Clash by Hako）采用系统虚拟网卡隧道模式（`utun4`），不依赖 `127.0.0.1:10808` 或其它本地监听端口。系统所有流量（包括 git / curl 等终端请求）由隧道自动透明接管分流。`git push origin main` 直接使用标准 HTTPS 即可直连推送，无需在 `~/.gitconfig` 或终端环境变量中显式配置 `http.proxy`。
- **工作台「不完整」与手工录入标本语义**：`getWSAuditBucket` 对自动化仪器仍以 LIS 源字段 `IsComplete==='1'` 为硬门槛（非1即 incomplete）。对于 **H900 电解质分析仪 / 手工杂项** 等手工录入标本，LIS 即使保存也不会置 `IsComplete=1`；8.10.23 起通过 `isSpecimenActuallyComplete` 检查实际结果明细，当且仅当全部项目已录入（无空项、无未检）时判定为完整，从而升入「待审」并允许检验人员人工审核（Enter/F4/详情审核）；未录入或缺项标本仍严格留在「不完整」，且自动化批审机器人永久排除这类手工仪器，确保医疗安全。
