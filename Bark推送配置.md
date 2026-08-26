# Bark 手机推送配置（自动审核关键事件 → iPhone / Apple Watch）

自动审核（`autoAuditTick`）在**关键事件**发生时，把**去标识摘要**推送到 iPhone 通知中心；Apple Watch 开启「镜像 iPhone 提醒」后自动同步振铃显示，无需任何手表端配置。

## 推送内容（只推关键事件，防刷屏）

| 事件 | 标题 | 正文 | 级别 |
|---|---|---|---|
| 自动审核一轮完成 | `🤖 自动审核完成一轮` | `正常 a · 异常 b · 留人工 c`；有留人工时追加按标本展开的摘要（每标本一行 `标本号 时间` + 一行异常项，如 `钾(K) 6.8(3.50-5.30) 危急`） | `active` |
| 危急红线留人工 | `⚠️ 自动审核：危急红线 N 例留人工` | 计数 + 红线类别分布（危急值/含负值/传染病阳性/心肌标志物/疑似堵孔各 N 例）+ 按标本展开的异常摘要（每项附参考范围） | `critical`（穿透勿扰/静音） |
| 审核时长到点自动停止 | `⏰ 自动审核已停止` | 状态说明 | `active` |
| 手动关闭自动审核 | `🛑 自动审核已关闭` | 状态说明 | `active` |

> **隐私口径（8.8.15 起）**：推送正文含三类信息——① 数字计数（正常/异常/留人工、各红线类别例数）；② **留人工标本的检验号（标本号）与接收时间**（即工作台卡片显示的时间，用于手机端定位标本，已确认不属于病人隐私）；③ **异常项目**（检验项目名 + 数值 + 参考范围 + 方向标记，不显示单位）。**绝不**包含姓名、住院号、床号、科室、ReportDR 等身份信息；摘要按标本展开、最多 8 行，每个标本最多列 6 个异常项（超出标 `等N项`）。

## 链路

```
浏览器 userscript ──POST /notify──▶ serve.py(127.0.0.1:8765) ──POST https://api.day.app/push──▶ Bark 云 ──APNs──▶ iPhone 通知中心 ──镜像──▶ Apple Watch
```

- Bark 云（api.day.app）只做通知转发、无状态不存储内容，设备码只是推送寻址标识。
- 推送由 serve.py 的后台线程发出：失败仅打印日志，绝不阻塞审核流程。

## 配置步骤

1. **iPhone 安装 Bark**：App Store 搜「Bark」安装（免费开源，作者 Finb）。
2. **复制设备码**：打开 Bark → 底部「设置」→ 「设备」→ 点「复制设备码」（形如 `xxxxxxx...xxxxxxxx`，一串字母数字）。
3. **写入本地配置**（不入库）：在 `~/脚本/` 下创建 `notify_config.json`（可先复制模板）：

   ```bash
   cp ~/脚本/notify_config.example.json ~/脚本/notify_config.json
   # 然后把 bark_key 改为你的设备码，enabled 保持 true
   ```

   也可以直接写：

   ```json
   {
     "bark_key": "你的设备码",
     "enabled": true
   }
   ```

4. **保证 serve.py 在运行**（Tampermonkey 更新与推送都依赖它）：
   - 双击 `start_lis_menubar.command` 启动（若已按 launchd 管理则无需手动）。
5. **iPhone 允许 Bark 通知**：设置 → 通知 → Bark → 允许通知（建议开「锁屏/横幅/声音」）。
6. **Apple Watch 镜像提醒**：Watch App → 通知 → 开启「镜像 iPhone 提醒」。手表与 iPhone 蓝牙/局域网相连时，iPhone 通知自动上手表。
7. **浏览器里刷新 LIS 页面**，让新版本 userscript（≥8.8.12）生效，然后跑一轮自动审核即可收到推送。

## 测试推送

```bash
bash ~/脚本/test_bark_push.sh
```

脚本会：读 `notify_config.json` → 若未配置则提示 → 否则向本机 `/notify` 发一条测试推送（走完整链路）。也可加 `--direct` 直接调 Bark 云接口验证设备码本身。

## 级别说明

- `active`：正常提醒（锁屏+横幅）。
- `critical`：**穿透勿扰/专注模式**，建议只给「危急红线留人工」用（iOS 还要求 Bark 里开启「通知直达」开关才生效）。
- `passive` / `timeSensitive`：预留，当前未使用。

## 常见问题

| 现象 | 处理 |
|---|---|
| 没收到推送 | ① `notify_config.json` 是否存在且 `enabled:true`？② serve.py 是否在运行？③ 手机勿扰是否拦截了 `critical` 之外的推送？④ 看 serve.py 日志有无 `[notify]` 失败打印 |
| `[notify] 未配置 bark_key` | 没写 `notify_config.json`，推送被安全丢弃 |
| `[notify] Bark API 失败` | 设备码错误/网络问题；用 `test_bark_push.sh --direct` 复现 |
| 同一条重复推送 | 已内置 60 秒内容去重，正常不会重复 |
| 推送正文会出现哪些信息 | 数字计数 + 留人工标本的检验号与接收时间 + 异常项目（项目名/数值/参考范围/方向，不显示单位）。姓名、住院号、床号、科室等身份信息**永远不会**出现在推送里 |
| 想彻底关闭 | 把 `enabled` 改为 `false`，或删除 `notify_config.json` |

## 安全

- `notify_config.json` 已加入 `.gitignore`（本地密钥，**严禁**提交）；仓库内只保留 `notify_config.example.json` 占位模板。
- 推送内容隐私：计数 + 标本号/接收时间 + 异常项目名与数值，**绝无**姓名/住院号/床号/科室等身份信息；Bark 云（api.day.app）无状态不存储，仅转发到你的 iPhone。