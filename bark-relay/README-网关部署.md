# 网关机 Bark 推送中转部署（192.168.31.111）

> 目的：自动审核推送不再依赖各工作机本机开 serve.py —— 由常开的 nginx 网关机收
> `POST http://192.168.31.111:9111/notify`（nginx 反代到本机回环的 bark_relay），转发 Bark 云端。
> 两台 Windows 机从此**完全不需要**打开 start_serve.bat；Mac 的 serve.py 只剩菜单栏功能（可选）。

## 目录与安全红线

- 服务目录：`D:\bark-relay\`（**不要**放进 `D:\nginx-1.31.2\lis-tools\`——那是 HTTP 网络目录，
  `notify_config.json` 里有 bark_key 和推送加密密钥，放进去等于把密钥发给全科室）
- nginx 只把 `/notify` 和 `/notify_status` 两个路径反代到 `127.0.0.1:8766`（bark_relay 仅绑回环），
  9111 站点原有的 IP 白名单照常生效
- Origin 白名单与 serve.py 相同（LIS 两个入口），其余网页跨源请求一律 403

## 部署步骤（网关机上）

1. 把本目录整个拷到网关机 `D:\bark-relay\`（bark_relay.py + notify_config.json + 两个 bat）。
   `notify_config.json` 内容与 Mac 上 `~/脚本/notify_config.json` 相同（bark_key + 加密配置）。
2. 双击 **安装开机自启.bat** —— 创建计划任务 `LIS-BarkRelay`（登录自启）并立即启动，
   脚本末尾会自检 `http://127.0.0.1:8766/healthz`，应输出含 `"configured"` 的 JSON。
3. 改 nginx 配置（`D:\nginx-1.31.2\conf\nginx.conf`），在 9111 的 `location /lis-tools/` 之前加：

   ```nginx
        location /notify {
            proxy_pass http://127.0.0.1:8766;
            proxy_set_header X-Real-IP $remote_addr;
        }
   ```

   （`/notify_status` 以 `/notify` 开头，天然一起命中，无需单独写。）
4. 验证并重载 nginx：

   ```bat
   cd /d D:\nginx-1.31.2
   nginx.exe -t
   nginx.exe -s reload
   ```

5. 端到端验证（任意一台工作机上）：

   ```bash
   curl http://192.168.31.111:9111/notify_status -H "Origin: http://192.168.31.111:9111"
   # 应返回 {"configured": true, "enabled": true, ..., "relay": "gateway"}
   ```

   或直接在 LIS 页面开自动审核设置弹窗，推送状态框应显示「网关中转」。

## userscript 侧行为（8.9.7+）

- 推送端点按顺序尝试：**网关中转 → 本机 8765（serve.py，兜底）**，哪个通用哪个并记住；
  网关恢复后下一次推送自动切回网关。
- 某次推送发送失败会进本地补发队列（既有机制），与端点无关。

## 升级：8.10.3 副标题（subtitle）

userscript 8.10.3 起，合并推送把「仪器分布 + 核收时间区间」放进 Bark **副标题**
（Apple Watch 上与标题一同稳定可见）。这需要本服务一并升级：

1. 把新版 `bark_relay.py` 覆盖到网关机 `D:\bark-relay\bark_relay.py`
   （`notify_config.json` 不用动，密钥照旧）
2. 重启服务：双击 **启动推送中转.bat**，或在任务计划里重启 `LIS-BarkRelay`
3. 验证：`curl http://192.168.31.111:9111/notify_status -H "Origin: http://192.168.31.111:9111"`
   仍返回 `{"configured": true, ...}`；再在 LIS 里跑一轮自动审核，手机通知应出现副标题一行

**不升级也不会坏**：旧版忽略 `subtitle` 字段，标题/正文照常送达，只是少一行副标题。
推送加密开启时，副标题与标题/正文一起进密文（Bark 云与 APNs 只见密文）。

## 日常运维

- 日志：`D:\bark-relay\bark_relay.log`（约 2MB 自动轮转），含每次 Bark 转发结果与安全拦截记录
- 改 `notify_config.json`（如换 Bark 设备码）后无需重启：每次推送都重新读配置
- 卸载：双击 **卸载开机自启.bat**，再删掉 nginx.conf 里的 `location /notify` 块并 reload

## 回滚

userscript 8.9.7 起网关不通时自动落回本机 serve.py，因此网关侧任何故障都不会丢推送，
只需在各机重新打开 start_serve.bat 即可回到旧模式。
