#!/usr/bin/env python3
"""本地脚本服务器 - 配合 Tampermonkey 自动更新，并托管 vendor 依赖（SheetJS 等）"""
import base64
import http.server
import mimetypes
import os
import json
import secrets
import string
import sys
import threading
import time
import urllib.request
from urllib.parse import urlparse, unquote

PORT = 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(ROOT, 'iMedicalLIS-enhancer.user.js')
VENDOR = os.path.join(ROOT, 'vendor')

STATS_FILE = os.path.join(ROOT, '.cache', 'menubar_stats.json')
_stats_lock = threading.Lock()
_stats_data = {'ok': False, 'ts': 0}


def _load_stats():
    global _stats_data
    try:
        with open(STATS_FILE, 'r', encoding='utf-8') as f:
            _stats_data = json.load(f)
    except Exception:
        pass


_load_stats()

CMD_FILE = os.path.join(ROOT, '.cache', 'menubar_cmd.json')
_cmd_lock = threading.Lock()
_cmd_data = {'id': 0, 'action': None, 'cat': None, 'consumed': True}


def _load_cmd():
    global _cmd_data
    try:
        with open(CMD_FILE, 'r', encoding='utf-8') as f:
            _cmd_data = json.load(f)
        # 重启前写入但未被 userscript 认领的指令一律作废，避免重启后重放（与「重启后不再重放旧指令」语义对齐）
        if isinstance(_cmd_data, dict) and not _cmd_data.get('consumed', True):
            _cmd_data['consumed'] = True
            try:
                with open(CMD_FILE, 'w', encoding='utf-8') as f:
                    json.dump(_cmd_data, f, ensure_ascii=False)
            except Exception:
                pass
    except Exception:
        pass


_load_cmd()

# ── Bark 推送（自动审核关键事件 → iPhone / Apple Watch）──────────────────────
# 配置：notify_config.json（不入库，勿提交）：
#   {"bark_key": "你在 Bark App 里的设备码", "enabled": true}
NOTIFY_CONFIG_FILE = os.path.join(ROOT, 'notify_config.json')
BARK_PUSH_URL = 'https://api.day.app/push'
_NOTIFY_LEVELS = {'active', 'passive', 'timeSensitive', 'critical'}
# 最近一次 /notify 处理结果（供 userscript 设置界面 GET /notify_status 实时展示；不含 bark_key 本身）
_notify_last = None
# 浏览器来源白名单：只有 LIS 页面（userscript）可以触发推送/写入统计与指令；
# 无 Origin 的请求视为本机脚本（curl、SwiftBar shell、test_bark_push.sh）放行。
# 其它网页一律 403 —— 浏览器跨源 POST 无法伪造/省略 Origin，可防任意网页 drive-by
# 静默调 /notify 向手机发 critical 推送（穿透勿扰）轰炸，或伪造菜单栏读数/指令。
NOTIFY_ALLOWED_ORIGINS = {
    'http://10.0.29.100',
    'http://192.168.31.111:9111',
}


def _load_notify_config():
    try:
        with open(NOTIFY_CONFIG_FILE, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _notify_bark(key, title, body, level):
    """后台线程转发到 Bark 云端 → APNs → iPhone（Apple Watch 镜像）。失败仅打印，不阻塞 serve。"""
    global _notify_last
    if level not in _NOTIFY_LEVELS:
        level = 'active'
    # ── 8.8.23: 推送内容端到端加密（Bark App「加密设置」配了 Key 即启用）──
    # 开启后 title/body 全部进 AES 密文，Bark 云与 APNs 只见密文；level 等非敏感参数仍明文传递。
    # 加密失败一律不回退明文（fail-closed），避免隐私内容意外裸奔。
    enc_payload = None
    enc_err = None
    try:
        enc_cfg = _load_encrypt_cfg(_load_notify_config())
        if enc_cfg:
            enc_key, fixed_iv = enc_cfg
            inner = json.dumps({'title': title, 'body': body}, ensure_ascii=False)
            iv_str = fixed_iv or ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16))
            ct = base64.b64encode(aes_cbc_encrypt(inner.encode('utf-8'), enc_key, iv_str.encode('utf-8'))).decode('ascii')
            enc_payload = {'ciphertext': ct, 'iv': iv_str}
    except Exception as e:
        enc_err = e
        enc_payload = None
    payload = {'device_key': key, 'level': level}
    log_tail = f'{title} - {body}'
    if enc_payload is not None:
        payload.update(enc_payload)
        log_tail = f'{title} - [已加密 {len(payload["ciphertext"])}B 密文]'  # 加密后控制台不再落明文正文
    elif enc_err is not None:
        # 配置了加密但加密失败：宁可不发也不发明文
        print(f'[{time.strftime("%H:%M:%S")}] Bark 推送放弃（加密配置无效，fail-closed）: {enc_err}')
        _notify_last = {'ts': time.time(), 'ok': False, 'title': str(title)[:60], 'detail': f'加密配置无效: {str(enc_err)[:100]}'}
        return
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        BARK_PUSH_URL, data=data,
        headers={'Content-Type': 'application/json; charset=utf-8'},
        method='POST',
    )
    # 8.8.34: 失败重试（最多 3 次，线性退避 1s/2s）——此前单次尝试，Bark 云瞬断即丢推送，
    # 且 userscript 旧版不读响应，两端都不可观测。Request 对象可复用（data 不变）。
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                print(f'[{time.strftime("%H:%M:%S")}] Bark 推送成功 [{level}] {log_tail}')
                _notify_last = {'ts': time.time(), 'ok': True, 'title': str(title)[:60], 'detail': f'Bark 转发成功 [{level}]' + ('（密文）' if enc_payload else '')}
                return
        except Exception as e:
            last_err = e
            print(f'[{time.strftime("%H:%M:%S")}] Bark 推送失败（第 {attempt + 1}/3 次）: {e}')
            if attempt < 2:
                time.sleep(1 + attempt)
    _notify_last = {'ts': time.time(), 'ok': False, 'title': str(title)[:60], 'detail': str(last_err)[:120]}


# ── Bark 推送加密（纯 Python AES-128/256-CBC + PKCS7，零第三方依赖）──────────
# 与 Bark App「设置 → 加密设置」对应：算法 AES128/AES256、模式 CBC、Padding pkcs7。
# App 里填的 Key（16/32 位）须与 notify_config.json 的 encrypt_key 完全一致；
# IV 建议在 notify_config.json 留空 → 每次推送随机生成并随请求传给客户端解密。

_SBOX = None


def _init_aes_tables():
    """生成 AES S 盒（程序化构造，避免手抄 256 项出错）"""
    global _SBOX
    if _SBOX is not None:
        return
    sbox = [0] * 256
    p = q = 1
    while True:
        p = p ^ ((p << 1) & 0xFF) ^ (0x1B if p & 0x80 else 0)          # p *= x (GF(2^8))
        q ^= (q << 1) & 0xFF
        q ^= (q << 2) & 0xFF
        q ^= (q << 4) & 0xFF
        q &= 0xFF
        if q & 0x80:
            q ^= 0x09                                                   # q /= x
        rotl = lambda v, r: ((v << r) | (v >> (8 - r))) & 0xFF
        x = q ^ rotl(q, 1) ^ rotl(q, 2) ^ rotl(q, 3) ^ rotl(q, 4)
        sbox[p] = (x ^ 0x63) & 0xFF
        if p == 1:
            break
    sbox[0] = 0x63
    _SBOX = sbox


def _xtime(a):
    return ((a << 1) ^ 0x1B) & 0xFF if a & 0x80 else (a << 1)


def _aes_key_expansion(key):
    _init_aes_tables()
    nk = len(key) // 4          # 4=AES128, 6=AES192, 8=AES256
    nr = nk + 6                 # 轮数 10/12/14
    words = [list(key[4 * i:4 * i + 4]) for i in range(nk)]
    rcon = 1
    for i in range(nk, 4 * (nr + 1)):
        temp = list(words[i - 1])
        if i % nk == 0:
            temp = [_SBOX[temp[(j + 1) % 4]] for j in range(4)]         # RotWord + SubWord
            temp[0] ^= rcon
            rcon = _xtime(rcon)
        elif nk > 6 and i % nk == 4:
            temp = [_SBOX[b] for b in temp]                             # SubWord（AES256 额外轮）
        words.append([temp[j] ^ words[i - nk][j] for j in range(4)])
    return words, nr


def _aes_encrypt_block(block, words, nr):
    """单块加密。block/state 均为 16 字节列优先扁平数组（in[i] → 列 i//4 行 i%4）"""
    st = list(block)

    def add_round_key(rd):
        for c in range(4):
            for r in range(4):
                st[4 * c + r] ^= words[rd * 4 + c][r]

    def sub_bytes_shift_rows():
        out = [0] * 16
        for c in range(4):
            for r in range(4):
                # ShiftRows：第 r 行循环左移 r —— 新列 c 取旧列 (c+r)%4；先 SubBytes 再摆位
                out[4 * c + r] = _SBOX[st[4 * ((c + r) % 4) + r]]
        st[:] = out

    def mix_columns():
        out = [0] * 16
        for c in range(4):
            a = st[4 * c:4 * c + 4]
            for r in range(4):
                out[4 * c + r] = (_xtime(a[r]) ^ _xtime(a[(r + 1) % 4]) ^ a[(r + 1) % 4]
                                  ^ a[(r + 2) % 4] ^ a[(r + 3) % 4])
        st[:] = out

    add_round_key(0)
    for rd in range(1, nr):
        sub_bytes_shift_rows()
        mix_columns()
        add_round_key(rd)
    sub_bytes_shift_rows()
    add_round_key(nr)
    return bytes(st)


def aes_cbc_encrypt(plaintext: bytes, key: bytes, iv: bytes) -> bytes:
    """AES-CBC + PKCS7 加密（Bark 推送加密用）。key 16/24/32 字节，iv 16 字节"""
    if len(key) not in (16, 24, 32):
        raise ValueError(f'AES key 长度须为 16/24/32 字节，当前 {len(key)}')
    if len(iv) != 16:
        raise ValueError(f'AES iv 须为 16 字节，当前 {len(iv)}')
    pad_len = 16 - (len(plaintext) % 16)
    data = plaintext + bytes([pad_len]) * pad_len                       # PKCS7
    words, nr = _aes_key_expansion(key)
    prev = iv
    out = []
    for i in range(0, len(data), 16):
        blk = bytes(x ^ y for x, y in zip(data[i:i + 16], prev))
        prev = _aes_encrypt_block(blk, words, nr)
        out.append(prev)
    return b''.join(out)


def _load_encrypt_cfg(cfg):
    """读取推送加密配置。返回 None=不加密；(key_bytes, 固定iv或None)=加密。
    配置了 push_encrypt 但参数非法时抛异常（调用方 fail-closed 不发明文）。"""
    if not cfg.get('push_encrypt'):
        return None
    algo = str(cfg.get('encrypt_algo') or 'aes128').strip().lower()
    klen = {'aes128': 16, 'aes256': 32}.get(algo)
    if not klen:
        raise ValueError(f'未知 encrypt_algo「{algo}」（支持 aes128/aes256）')
    key_raw = str(cfg.get('encrypt_key') or '')
    key = key_raw.encode('utf-8')
    if len(key) != klen:
        raise ValueError(f'encrypt_key 须为 {klen} 位（{algo}），当前 {len(key)} 位')
    iv_raw = str(cfg.get('encrypt_iv') or '').strip()
    if iv_raw:
        if len(iv_raw.encode('utf-8')) != 16:
            raise ValueError(f'encrypt_iv 须为 16 位或留空（留空则每次推送自动随机），当前 {len(iv_raw.encode("utf-8"))} 位')
        iv = iv_raw  # 保持 str，由调用处统一 encode
    else:
        iv = None
    return key, iv


ALLOWED = {
    '/': SCRIPT,
    '/iMedicalLIS-enhancer.user.js': SCRIPT,
    '/vendor/xlsx.full.min.js': os.path.join(VENDOR, 'xlsx.full.min.js'),
}


class Handler(http.server.BaseHTTPRequestHandler):
    def _origin_allowed(self):
        """POST 来源白名单：LIS 页面 Origin 放行；无 Origin（curl/SwiftBar 等本机脚本）放行；其余 403。
        浏览器对跨源 POST 会强制附加真实 Origin 且 JS 无法伪造，故可拦截其它网页的 drive-by 滥用。"""
        origin = (self.headers.get('Origin') or '').strip().rstrip('/').lower()
        return (not origin) or origin in NOTIFY_ALLOWED_ORIGINS

    def _reject_origin(self):
        self.send_response(403)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(b'Origin not allowed')

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        # 菜单栏统计读取
        if path == '/stats':
            # 8.8.34: 补来源白名单（与 8.8.21 的 /notify_status 对齐）——stats 含各机器待审/异常计数，
            # 虽只是聚合数字，也不应给任意网页跨源读取
            if not self._origin_allowed():
                print(f'[{time.strftime("%H:%M:%S")}] [security] 拒绝非白名单 Origin 的 GET {path}: {self.headers.get("Origin")}')
                self._reject_origin()
                return
            with _stats_lock:
                body = json.dumps(_stats_data, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return
        # 8.8.20: 推送链路状态（userscript 自动审核设置界面实时展示）。只暴露配置与否/开关/最近结果，绝不含 bark_key
        # 8.8.21: GET 同样走来源白名单 —— last.title 含红线例数等聚合信息，不给任意网页跨源读取
        if path == '/notify_status':
            if not self._origin_allowed():
                print(f'[{time.strftime("%H:%M:%S")}] [security] 拒绝非白名单 Origin 的 GET {path}: {self.headers.get("Origin")}')
                self._reject_origin()
                return
            cfg = _load_notify_config()
            key = (cfg.get('bark_key') or '').strip()
            body = json.dumps({
                'configured': bool(key),
                'enabled': bool(cfg.get('enabled', True)),
                'last': _notify_last,
                'ts': int(time.time() * 1000),
            }, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return
        # 菜单栏指令读取（SwiftBar 点击 → 通知 userscript 切分类）
        if path == '/cmd':
            # 8.8.34: 补来源白名单（与 8.8.21 口径一致）——指令内容（目标分类标签）公开可读虽无害，
            # 但白名单口径应统一，防任意网页探测本服务在线状态
            if not self._origin_allowed():
                print(f'[{time.strftime("%H:%M:%S")}] [security] 拒绝非白名单 Origin 的 GET {path}: {self.headers.get("Origin")}')
                self._reject_origin()
                return
            with _cmd_lock:
                body = json.dumps(_cmd_data, ensure_ascii=False).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(body)
            return
        # 允许 vendor/ 下已登记的静态文件
        filepath = ALLOWED.get(path)
        if not filepath and path.startswith('/vendor/'):
            name = os.path.basename(path)
            candidate = os.path.join(VENDOR, name)
            if os.path.isfile(candidate) and os.path.realpath(candidate).startswith(os.path.realpath(VENDOR) + os.sep):
                filepath = candidate

        if not filepath or not os.path.isfile(filepath):
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'Not found')
            return

        try:
            with open(filepath, 'rb') as f:
                content = f.read()
            ctype = 'application/javascript; charset=utf-8'
            if filepath.endswith('.css'):
                ctype = 'text/css; charset=utf-8'
            elif filepath.endswith('.map'):
                ctype = 'application/json'
            self.send_response(200)
            self.send_header('Content-Type', ctype)
            self.send_header('Content-Length', str(len(content)))
            self.send_header('Cache-Control', 'no-cache')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.end_headers()
            self.wfile.write(content)
            print(f'[{self.log_date_time_string()}] {path} ({len(content)} bytes)')
        except Exception as e:
            self.send_response(500)
            self.send_header('Access-Control-Allow-Origin', '*')  # 跨源 fetch 的 500 也要可读
            self.end_headers()
            self.wfile.write(str(e).encode())

    def do_POST(self):
        global _stats_data, _cmd_data, _notify_last
        path = unquote(urlparse(self.path).path)
        # 8.8.20: 来源白名单 —— 防其它网页 drive-by 静默调 /notify 给手机发推送（或伪造 /stats、/cmd）
        if not self._origin_allowed():
            print(f'[{time.strftime("%H:%M:%S")}] [security] 拒绝非白名单 Origin 的 POST {path}: {self.headers.get("Origin")}')
            self._reject_origin()
            return
        if path == '/stats':
            try:
                length = int(self.headers.get('Content-Length', 0))
                raw = self.rfile.read(length) if length else b'{}'
                data = json.loads(raw.decode('utf-8'))
                data['ts'] = int(time.time())
                data['ok'] = True
                with _stats_lock:
                    _stats_data = data
                    os.makedirs(os.path.dirname(STATS_FILE), exist_ok=True)
                    with open(STATS_FILE, 'w', encoding='utf-8') as f:
                        json.dump(data, f, ensure_ascii=False)
                self.send_response(204)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(str(e).encode())
        elif path == '/cmd':
            # SwiftBar 下拉点击 → 指令（goto 分类）。带 id 防重复消费。
            try:
                length = int(self.headers.get('Content-Length', 0))
                raw = self.rfile.read(length) if length else b'{}'
                data = json.loads(raw.decode('utf-8'))
                cmd = {
                    'id': int(time.time() * 1000),
                    'action': data.get('action'),
                    'cat': data.get('cat'),
                    'consumed': False,
                }
                with _cmd_lock:
                    _cmd_data = cmd
                    os.makedirs(os.path.dirname(CMD_FILE), exist_ok=True)
                    with open(CMD_FILE, 'w', encoding='utf-8') as f:
                        json.dump(cmd, f, ensure_ascii=False)
                self.send_response(204)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(str(e).encode())
        elif path == '/cmd/claim':
            # userscript 原子认领菜单栏指令，防止多个 LIS 标签重复执行，且重启后不再重放旧指令。
            try:
                length = int(self.headers.get('Content-Length', 0))
                raw = self.rfile.read(length) if length else b'{}'
                data = json.loads(raw.decode('utf-8'))
                cmd_id = data.get('id')
                claimed = False
                with _cmd_lock:
                    if _cmd_data.get('id') == cmd_id and not _cmd_data.get('consumed'):
                        _cmd_data = {**_cmd_data, 'consumed': True}
                        os.makedirs(os.path.dirname(CMD_FILE), exist_ok=True)
                        with open(CMD_FILE, 'w', encoding='utf-8') as f:
                            json.dump(_cmd_data, f, ensure_ascii=False)
                        claimed = True
                body = json.dumps({'claimed': claimed}, ensure_ascii=False).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body)))
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body)
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(str(e).encode())
        elif path == '/notify':
            # 自动审核关键事件 → Bark 推送。userscript 只发去标识摘要：聚合计数（正常/异常/留人工）、
            # 红线类别例数、按标本展开的异常项（标本号 + 接收时间 + 项目名/数值/方向标记/参考范围，
            # 8.8.14 起用户确认标本号与接收时间不属于病人隐私可带）。
            # 绝不含姓名/住院号/床号/科室/ReportDR 等身份信息（隐私红线：身份信息不出内网）。
            try:
                length = int(self.headers.get('Content-Length', 0))
                raw = self.rfile.read(length) if length else b'{}'
                data = json.loads(raw.decode('utf-8'))
                title = str(data.get('title') or '自动审核')
                body = str(data.get('body') or '')
                level = str(data.get('level') or 'active')
                cfg = _load_notify_config()
                key = (cfg.get('bark_key') or '').strip()
                if not key or not cfg.get('enabled', True):
                    # 未配置 Bark key：静默丢弃（不打扰用户），打印提示便于排查
                    print(f'[{time.strftime("%H:%M:%S")}] [notify] 未配置 bark_key（{NOTIFY_CONFIG_FILE}），忽略推送: {title} - {body}')
                    _notify_last = {'ts': time.time(), 'ok': False, 'title': str(title)[:60], 'detail': '未配置 bark_key 或 enabled=false，已忽略'}
                    accepted = False
                else:
                    threading.Thread(target=_notify_bark, args=(key, title, body, level), daemon=True).start()
                    accepted = True
                body_resp = json.dumps({'accepted': accepted}, ensure_ascii=False).encode('utf-8')
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Content-Length', str(len(body_resp)))
                self.send_header('Cache-Control', 'no-cache')
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(body_resp)
            except Exception as e:
                self.send_response(500)
                self.send_header('Access-Control-Allow-Origin', '*')
                self.end_headers()
                self.wfile.write(str(e).encode())
        else:
            self.send_response(404)
            self.end_headers()

    def log_message(self, format, *args):
        pass  # 静默 access 日志；成功提供在 do_GET 里打印


def _main():
    print('========================================')
    print('  脚本服务器已启动')
    print(f'  地址: http://localhost:{PORT}/')
    print(f'  更新URL: http://localhost:{PORT}/iMedicalLIS-enhancer.user.js')
    print(f'  SheetJS: http://localhost:{PORT}/vendor/xlsx.full.min.js')
    print('========================================')
    print('  使用方法:')
    print('  1. 保持此窗口运行')
    print('  2. 编辑 iMedicalLIS-enhancer.user.js')
    print('  3. 在 Tampermonkey 面板点击脚本的"更新"按钮')
    print('========================================')

    try:
        http.server.HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
    except KeyboardInterrupt:
        print('\n已停止')
    except OSError as e:
        # errno 48 = macOS EADDRINUSE / 98 = Linux EADDRINUSE（端口被占用）
        if getattr(e, 'errno', None) in (48, 98):
            print(f'❌ 端口 {PORT} 已被占用：serve.py 可能已在运行（菜单栏/Tampermonkey 更新依赖它）。')
            print('   如需重启请先结束旧进程: pkill -f serve.py')
            sys.exit(1)
        raise


# main guard：允许 test_bark_push.sh 等 import 本模块复用加密函数而不启动服务
if __name__ == '__main__':
    _main()
