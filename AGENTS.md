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
| `hooks/` | **自动同步+纪律守卫钩子**（`core.hooksPath` 已指向此目录，对任何 agent/人的提交生效）：pre-commit 拦「改脚本不 bump @version」和「改 vendor 不更新 VENDOR_SHA256」；post-commit 在提交涉及 `.user.js`/`vendor` 时**前台** scp 到科室 nginx 并 curl 回验版本（8.16.20 起改前台：此前 `nohup ... &` 会被整进程组带走，日志报的 `No route to host` 是假象；不在科室网段时由 `nc -z -G 2` 预检 2s 内跳过）；日志 `.cache/nginx_sync.log`；`LIS_NO_SYNC=1 git commit` 跳过自动同步，`--no-verify` 跳过守卫检查 |
| `launchd/com.yutong.lis-nginx-sync.plist` | **Mac 宿主机自动同步守护**（已部署至 `~/Library/LaunchAgents/`）：通过 `WatchPaths` 监听 Git 提交与脚本改动，即使由带沙箱隔离的工具（如 WorkBuddy AI）提交代码，宿主机守护服务也会在 2s 内自动接管并 scp 同步至网关机，彻底消除手动补跑。 |
| `同步脚本到nginx.command` | 手动同步脚本到 nginx 网关机（一般用不到，钩子与守护服务会自动同步） |
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
2. **Commit**：中文说明，写清改了什么、为什么。**commit 后 post-commit 钩子与 Mac 宿主机守护服务会自动把 userscript + vendor scp 到科室 nginx 并 curl 回验版本**——无需手动干预，失败自动留给下次提交重试，日志在 `.cache/nginx_sync.log`，跳过一次用 `LIS_NO_SYNC=1 git commit ...`，手动补跑 `bash hooks/sync-to-nginx.sh`
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
- **自动审核日志的两条口径（8.17.1 / 8.17.2）**：①**最终态收敛**——日志按轮次追加，同一标本可能先被记成「正常通过」、后续轮次又因 `wsData` 未刷新被记成「留人工/已审核跳过」，所以 `rebuildAutoAuditedTodaySet` 以该标本在今日日志里的**最后一条结论**为准（不是「出现过成功就算」）；②**谁做的**——另存一份当日人工审核留痕 `LIS_HumanAuditLog`，人工审过的标本不挂 `🤖 自动` 徽章，且「自动审核记录」里已被人工补审的「未通过」条目**默认折叠**（工具栏 `✅ 已人工处理` 可展开，灰调 + `✅ 已人工审核`）。
  - **留痕的两个打点位置缺一不可**：① `executeNativeAudit`（详情面板 / 详情面板回车 / 卡片回车 / F4 定位审核）按 `isRobotAuditCtx()` 判定；② `continueAuditQueue` 的三处批审成功点按 `!queue._autoMode` 判定——**批审主循环是直接调 `clickNativeAuditButton`，压根不过 `executeNativeAudit`**，8.17.1 就是漏了这里导致「人工 F4 审掉的标本不折叠」。
  - ⚠️ **不要用 `_autoAuditRunning` 判断「这次审核是不是机器人发起的」**：一轮自动审核可能持续几十秒到几分钟（整批 `await executeBatchAudit` 期间它一直是 `true`），用户在轮次进行中插入的手动审核会被误判成机器人。用 `robotAuditBegin/End` 显式包裹。
  - ⚠️ 折叠判定只作用于 `t === 'skip'` 的条目；**不要**加「机器人今天审过它就不折叠」——机器人审掉的标本是另一条 `audited` 条目（不受折叠影响），加了反而会把「机器人先失败、后来人工补审」的 skip 条目钉在列表里。
  - 8.17.3 起折叠判定函数是 `aaHandledReason(dr)`（**返回原因文案**，空串=已处理），`isAAHandledByHuman` 只是 `=== ''` 的包装；未折叠的「未通过」卡片把原因写进 `title`（悬停可见）——现场再反馈「怎么还在」时，用户悬停即可自带答案。
  - 改动这两处后必跑 `node auto_audit_log_hygiene_test.mjs`（80 断言）+ `node audit_queue_context_test.mjs`（89 断言）。⚠️ 同一条标本的「成功」与「留人工」事件必须带同一个 `reportDR`，否则累积器按 id 去重时会把它们当成两条标本（既算通过又算留人工）。
  - ③**徽章数据源要全量（8.17.8）**——日志明细 `audited` 只存 50 条（`AUTO_AUDIT_LOG_DETAIL_MAX`，服务记录查看器展示体积），`autoAuditLogAdd` 另存**去重全量**的 `auditedDRs`（纯 DR 字符串数组，无上限）；`rebuildAutoAuditedTodaySet`（🤖 徽章集合）必须读 `audited`+`auditedDRs` **并集**，只看 `audited` 会在大批量（>50/轮）时漏标，用户会误以为标本没审掉。tick 直记、`aaSettleAccum` 结算两条落日志路径都要带 `auditedDRs`。
- **工作台「不完整」与手工录入标本语义**：`getWSAuditBucket` 对自动化仪器仍以 LIS 源字段 `IsComplete==='1'` 为硬门槛（非1即 incomplete）。对于 **H900 电解质分析仪 / 手工杂项** 等手工录入标本，LIS 即使保存也不会置 `IsComplete=1`；8.10.23 起通过 `isSpecimenActuallyComplete` 检查实际结果明细，当且仅当全部项目已录入（无空项、无未检）时判定为完整，从而升入「待审」并允许检验人员人工审核（Enter/F4/详情审核）；未录入或缺项标本仍严格留在「不完整」，且自动化批审机器人永久排除这类手工仪器，确保医疗安全。
- **电子病历（HIS）入口有三个，别再加第四条分叉（8.17.4 / 8.17.5）**：三处都调**同一个** `openEnhancedEMR(labno, {labNo, patName, regNo, episodeNo, directNativeIE})` ——① 待审视图**右栏「详情页」（实时检视器）底部动作排**的 `📄 病历 (M)` 按钮，排在「↷ 跳过」「✓ 审核此标本」最外侧（`lis-insp-btn-emr`，见 `renderLiveInspector` 的 `ftHtml`）；② 待审视图 `M` 键（当前聚焦标本；Shift+M = 原生 IE）；③ 详情面板 `📄 病历` 按钮 + `M` 键。⚠️ 8.17.4 曾把按钮放在左栏标本卡片上，用户明确要求挪到右栏「跳过/审核此标本」边上——**别再加回卡片**（`ab-emr-btn` / `wsEmrBtnHTML` 已删除）。Shift+点击/Shift+M 需要该机器跑过 `配置工作台-原生IE直达.bat`（`lis-ie://` 协议 + DHCC 插件），详见 `DHCC病历插件诊断结论.md`。回归：`node workbench_emr_entry_test.mjs`（42 断言）。
- **门禁隔离与不完整标本自动化绝缘（8.18.0）**：
  - ① **前端门禁（单一事实来源）**：`isSpecimenActuallyComplete(row, cached)` 穿透检查明细项，只要有必填项未存数据（`hasMissingMandatory`）或有空结果（`hasEmptyResults`），一律判 `false`（杜绝粗粒度 `IsComplete='1'` 蒙蔽）；`getWSAuditBucket(r)` 核心卡口直接返回 `'incomplete'`，绝不返回 `'normal'` 或 `'abnormal'`，未出全标本死锁在「不完整」标签，直到确认项目全了才进入「待审」。
  - ② **自动化绝缘**：F4 批审主循环与自动审核机器人绝不审核不完整标本；万一触发原生「您还有项目：...等必填项目未存数据，是否确定审核？」弹窗，`classifyNativeMessage` 识别为 `incomplete`，自动化流程（F4 / 自动审核）在 `handleNativeMessageConfirm` 与 `closeNativeAuditSuccessMessage` 中主动点击【取消】中止原生审核，绝不点【确定】，并立即跳过记为「留人工」。
  - ③ **保留手动审核通道**：若检验人员确需人工审核不完整标本，可在详情面板或原生页手动触发；此时原生弹窗不被脚本代按，留给检验人员手动决定【确定】或【取消】。
  - 回归：`node audit_completeness_guard_test.mjs`（72 断言，全部通过）。
- **CA 密钥缓存必须是 Map，不能退回单槽（8.17.6）**：`getCryptoKey(keyId)` 按「ca:用户名」派生密钥（PBKDF2 **10 万轮，同步阻塞主线程，单次约 50~200ms**）。原来只缓存最后一把（`_cryptoKey`/`_cryptoKeyUid`），而 `caAccountsAll()` 会**逐个账号**解密 → 槽位互踢，N 个账号就是 N 次派生，每轮 CA 认证（每个工作组各一次）都重来；更糟的是 `updateCaUserBadge()`（工作台每次重绘、含 30s 自动刷新）也会走 `caDefaultAccount() → caAccountsAll()` → **每 30 秒在后台烧掉 N 次 PBKDF2**。现为 `const _cryptoKeyCache = new Map()`，每个 keyId 每会话只派生一次。⚠️ 别改成「一把全局密钥」——缓存键必须含 keyId，否则不同账号共用同一把密钥（安全问题）。回归：`node audit_latency_test.mjs`。
- **延迟优化优先「先校验再等」，但窗口不许缩水（8.17.6 / 8.17.7）**：本项目多处「轮询确认」原来写成 `for (…){ await sleep(N); 校验; }` —— 原生其实已经成功时白等一个 N。改成先校验、把 sleep 放到循环末尾即可省下一次盲等。**但必须保持总窗口（轮数×间隔）≥ 原值**：窗口缩了会把「已审成功但回写慢」的标本误判成失败 → 假留人工，属于医疗安全问题。8.17.6 的四处改动（批审主循环 6×250→13×120、executeNativeAudit 4×120→5×120、confirmAuditEventuallyLive 6×150→7×150、补审 300/500/1000 前各加一次校验）与 8.17.7 的 CA 表单微轮询（7×40ms=280ms 保持窗口）都按这个规矩做。
- **CA 认证全流程极速优化（8.17.7）**：在 8.17.6 Map 缓存基础上，彻底清空 `submitOnce` 中的死等待：①**消灭 post-login 500ms 硬盲等**（原来 `sleep(200)+sleep(300)`，现检测到 Ukey 时若原生已关窗直接 0ms 返回，若未关微轮询最多 80ms 自然关窗，后续 `ReportSave` 确认交由调用方已有重试链路接管，立省 420~500ms）；②**输入密码到点击登录从 200ms 压到 50ms**（DOM 同步分发，50ms 足够 EasyUI 同步，立省 150ms）；③**工作台启动时后台空闲预热**（`warmupCAAuthInBackground` 利用 `requestIdleCallback` 提前跑完 PBKDF2 派生放入 Map，用户首次点批审时 0ms 命中）。单次 CA 认证体感提速 550ms+。回归：`node audit_latency_test.mjs`（47 断言）。8.17.8 补一道**零开销**防御：点登录前同步校验账密框 `.value`、与预期不符即同步重设（读 `.value` 是同步属性访问，不引入任何等待），防「赋值未生效 → 空密码必败认证 → 夜间无人值守干等切换账号浮层 120s」。
- **两个工作组常量别混用（8.17.0）**：`WG` = 临检/生化/免疫（**审核 + 质控**口径，不含外送）；`WS_WG` = `WG + 外送(dr=5)`（**工作台**口径：加载/过滤/计数/标签/仪器多选/页脚/自动审核范围/仪器预热）。外送组是**纯追踪组**——工作台只显示「待排(0)/采集(9)」，标本一旦录入结果即从所有视图与统计中消失（`applyResults` 入库即丢 + `getWSAuditBucket` 兜底返回 `audited` + `classifyAllSpecimens` 跳过），因为外送报告由第三方出具、本科室不审核，所以外送标本永远不会进入待审视图 / F4 批审 / 自动审核队列。**工作台里新增遍历工作组的代码必须用 `WS_WG`**，漏改不报错、只会静默走错口径；患者历史浮层（`histCandidateSS` / `histLoad`）是唯一有意保留 `WG` 的地方。回归测试：`node external_wg_test.mjs`（含「工作台热路径 0 处裸 `WG.`」断言）。

