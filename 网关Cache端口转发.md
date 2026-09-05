# 网关 Caché 直连端口转发（DHCC EMR 病历控件）

> 2026-09-05 配置。修复「原生 IE 打开病历 → 192.168.31.111 未响应」。

## 原因

东华 iMedical HIS 的病历页（`epr.frames.view.csp`）里带两条 Caché 数据库直连串，
DHCC EMR Plugin 控件不走 HTTP，而是用它们直连数据库 1972 端口：

```js
var ServerNameSpace   = 'cn_iptcp:10.0.29.100[1972]:DHC-APP';  // HIS 主库
var CfgLayoutNameSpace = 'cn_iptcp:10.0.28.100[1972]:DHC-APP'; // 配置库
```

网关 nginx 原有的 `sub_filter '10.0.29.100' '192.168.31.111:9111'` 把第一条改写成了
`cn_iptcp:192.168.31.111:9111[1972]` —— 控件拿 Caché 协议去连 nginx 的 **HTTP 端口
9111**，握手永远等不到 → IE 页面「192.168.31.111 未响应」。
第二条 `10.0.28.100` 不在改写名单里，跨网段根本不可达，同样卡死。

## 修复（网关机 192.168.31.111）

1. **TCP 转发**（Windows portproxy，重启后仍生效）：

   ```bat
   netsh interface portproxy add v4tov4 listenaddress=192.168.31.111 listenport=1972 connectaddress=10.0.29.100 connectport=1972
   netsh interface portproxy add v4tov4 listenaddress=192.168.31.111 listenport=1973 connectaddress=10.0.28.100 connectport=1972
   ```

2. **防火墙放行**：

   ```bat
   netsh advfirewall firewall add rule name="LIS-Cache-1972" dir=in action=allow protocol=TCP localport=1972
   netsh advfirewall firewall add rule name="LIS-Cache-1973" dir=in action=allow protocol=TCP localport=1973
   ```

3. **nginx 精确改写**（`D:\nginx-1.31.2\conf\nginx.conf`，location `/` 内、必须放在
   `sub_filter '10.0.29.100' ...` 通配规则**之前**）：

   ```nginx
   sub_filter 'cn_iptcp:10.0.29.100[1972]' 'cn_iptcp:192.168.31.111[1972]';
   sub_filter 'cn_iptcp:10.0.28.100[1972]' 'cn_iptcp:192.168.31.111[1973]';
   ```

## 回验方法

```bash
# 连接串应显示 cn_iptcp:192.168.31.111[1972] / [1973]
# （需先从工作台点一次病历拿新鲜会话，或按 TPSID 自动登录流程抓页面）
curl -s "http://192.168.31.111:9111/imedical/web/csp/epr.frames.view.csp?..." | grep cn_iptcp

# TCP 连通
bash -c "echo > /dev/tcp/192.168.31.111/1972" && echo OK
bash -c "echo > /dev/tcp/192.168.31.111/1973" && echo OK
```

## 注意

- HIS/Caché 服务器若换 IP，需同步改 portproxy（`netsh interface portproxy show all` 查看）。
- nginx.conf 备份在网关机无，本仓库只有此说明；改前备份 `copy nginx.conf nginx.conf.bak`。
- 这套直连与浏览器无关：Chrome 弹窗路径（HISUI HTML5）不受影响，也不需要它。
