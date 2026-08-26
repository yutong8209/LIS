# Bark 手机推送配置（自动审核关键事件 → iPhone / Apple Watch）

自动审核（`autoAuditTick`）在**关键事件**发生时，把**聚合计数/状态**推送到 iPhone 通知中心；Apple Watch 开启「镜像 iPhone 提醒」后自动同步振铃显示，无需任何手表端配置。

## 推送内容（只推关键事件，防刷屏）

| 事件 | 标题 | 级别 |
|---|---|---|
| 自动审核一轮完成 | `🤖 自动审核完成一轮`（正常 a · 异常 b · 留人工 c） | `active` |
| 危急红线留人工 | `⚠️ 自动审核：危急红线 N 例留人工` | `critical`（穿透勿扰/静音） |
| 审核时长到点自动停止 | `⏰ 自动审核已停止` | `active` |
| 手动关闭自动审核 | `🛑 自动审核已关闭` | `active` |

> **隐私红线**：推送只包含数字计数与状态文字，**绝不**包含患者/标本姓名、检验结果数值、科室等业务数据（userscript 头部第 23–31 行的隐私约定：业务数据仅本地处理）。

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
| 想彻底关闭 | 把 `enabled` 改为 `false`，或删除 `notify_config.json` |

## 安全

- `notify_config.json` 已加入 `.gitignore`（本地密钥，**严禁**提交）；仓库内只保留 `notify_config.example.json` 占位模板。
- 推送内容聚合化：只有计数与状态，无任何可识别业务数据。