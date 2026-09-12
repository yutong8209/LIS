#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
bark_relay.py — 科室网关机(192.168.31.111)上的 Bark 推送中转服务
================================================================
背景：自动审核推送原来由各工作机本机的 serve.py 转发（POST http://127.0.0.1:8765/notify），
Windows 机开自动审核前必须先开 start_serve.bat。本服务把「收推送 → 转发 Bark 云端」
搬到常开的 nginx 网关机上，nginx 把 /notify* 反代到本服务（127.0.0.1:8766，仅回环），
所有机器的 userscript 直接推 http://192.168.31.111:9111/notify，本机不再需要开 serve.py。

API 与 serve.py 完全同构（userscript 零改动即可切换 / 本机 serve 仍可作兜底）：
  POST /notify         {title, body, level, subtitle?} → {accepted: true|false}
                       （subtitle 为 8.10.3 新增的可选副标题；不传则与升级前行为一致）
  GET  /notify_status  → {configured, enabled, last, ts}（不含 bark_key）
安全：
  - 仅绑定 127.0.0.1，外部只能经 nginx 反代进入；nginx 9111 站点自带 IP 白名单
  - POST Origin 白名单（同 serve.py）：LIS 两个入口 + 无 Origin 视为本机脚本
  - 配置文件 notify_config.json 与脚本同目录（含 bark_key/加密密钥，勿放进 nginx 网络目录）
  - 端到端加密与 serve.py 同实现：Bark App「加密设置」配了 Key 即启用，失败 fail-closed 不发明文
配置：notify_config.json（同目录，模板见 notify_config.example.json）
运行：python bark_relay.py [--port 8766]
"""
import base64
import http.server
import json
import os
import secrets
import string
import sys
import threading
import time
import urllib.request
import urllib.error
from urllib.parse import urlparse, unquote

ROOT = os.path.dirname(os.path.abspath(__file__))
NOTIFY_CONFIG_FILE = os.path.join(ROOT, 'notify_config.json')
LOG_FILE = os.path.join(ROOT, 'bark_relay.log')
BARK_PUSH_URL = 'https://api.day.app/push'
_NOTIFY_LEVELS = {'active', 'passive', 'timeSensitive', 'critical'}
_notify_last = None
_notify_lock = threading.Lock()

# 质控配置持久化存储（批号、操作者、映射等多机共享）
QC_CONFIG_FILE = os.path.join(ROOT, 'qc_config.json')
_qc_lock = threading.Lock()
QC_MAX_BODY = 1048576  # 1MB 上限（含 mappings 大字典）

# 8.10.0 安全加固：/notify 经 nginx 反代后，任何能访问 9111 的机器用 curl（无 Origin）
# 即可调用——Origin 白名单只约束浏览器，挡不住脚本。加全局最小受理间隔 + 在途重试线程
# 上限 + 请求体上限，防止恶意/误发请求轰炸手机，或用海量重试线程/大 body 耗尽资源。
NOTIFY_MIN_INTERVAL = 1.0     # 相邻两次受理的最小间隔（秒）；超限返回 429+rate_limited
NOTIFY_MAX_INFLIGHT = 8       # 在途推送线程上限（每条推送最长约 33s 重试）
NOTIFY_MAX_BODY = 65536       # 请求体上限（字节）
_notify_rate_lock = threading.Lock()
_notify_last_accept_ts = 0.0
_notify_inflight = 0

# 浏览器来源白名单：只有 LIS 页面（userscript）可以触发推送；
# 无 Origin 的请求视为本机脚本（curl、test_bark_push.sh）放行。其它网页一律 403。
NOTIFY_ALLOWED_ORIGINS = {
    'http://10.0.29.100',
    'http://192.168.31.111:9111',
}


def _log(msg):
    line = f'[{time.strftime("%Y-%m-%d %H:%M:%S")}] {msg}'
    print(line, flush=True)
    try:
        # 简单尺寸上限（约 2MB 截断），避免日志无限增长
        if os.path.exists(LOG_FILE) and os.path.getsize(LOG_FILE) > 2 * 1024 * 1024:
            os.replace(LOG_FILE, LOG_FILE + '.old')
        with open(LOG_FILE, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def _load_notify_config():
    try:
        with open(NOTIFY_CONFIG_FILE, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}

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

# ── 复用 serve.py 的推送转发逻辑（同款重试/加密/状态记录）──────────────────────

def _notify_bark(key, title, body, level, subtitle='', group='', sound=''):
    """后台线程转发到 Bark 云端 → APNs → iPhone（Apple Watch 镜像）。失败仅记日志，不阻塞响应。"""
    global _notify_last
    if level not in _NOTIFY_LEVELS:
        level = 'active'
    enc_payload = None
    enc_err = None
    try:
        enc_cfg = _load_encrypt_cfg(_load_notify_config())
        if enc_cfg:
            enc_key, fixed_iv = enc_cfg
            # 8.10.3: subtitle（副标题）同属隐私内容，一起进密文；8.10.6: group / sound 进密文
            inner_obj = {'title': title, 'body': body}
            if subtitle:
                inner_obj['subtitle'] = subtitle
            if group:
                inner_obj['group'] = group
            if sound:
                inner_obj['sound'] = sound
            inner = json.dumps(inner_obj, ensure_ascii=False)
            iv_str = fixed_iv or ''.join(secrets.choice(string.ascii_letters + string.digits) for _ in range(16))
            ct = base64.b64encode(aes_cbc_encrypt(inner.encode('utf-8'), enc_key, iv_str.encode('utf-8'))).decode('ascii')
            enc_payload = {'ciphertext': ct, 'iv': iv_str}
    except Exception as e:
        enc_err = e
        enc_payload = None
    payload = {'device_key': key, 'level': level}
    if group:
        payload['group'] = group
    if sound:
        payload['sound'] = sound
    if enc_payload is not None:
        payload.update(enc_payload)
        log_tail = f'[{group or "default"}] {title} - [已加密 {len(payload["ciphertext"])}B 密文]'
    elif enc_err is not None:
        _log(f'Bark 推送放弃（加密配置无效，fail-closed）: {enc_err}')
        with _notify_lock:
            _notify_last = {'ts': time.time(), 'ok': False, 'title': str(title)[:60], 'detail': f'加密配置无效: {str(enc_err)[:100]}'}
        return
    else:
        # 8.10.3: 未启用加密时把 title/subtitle/body 明文放进 payload。
        payload['title'] = title
        payload['body'] = body
        if subtitle:
            payload['subtitle'] = subtitle
        log_tail = f'[{group or "default"}] {title} - {body}'
    data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        BARK_PUSH_URL, data=data,
        headers={'Content-Type': 'application/json; charset=utf-8'},
        method='POST',
    )
    last_err = None
    for attempt in range(3):
        try:
            with urllib.request.urlopen(req, timeout=10) as resp:
                resp.read()
                _log(f'Bark 推送成功 [{level}] {log_tail}')
                with _notify_lock:
                    _notify_last = {'ts': time.time(), 'ok': True, 'title': str(title)[:60], 'detail': f'Bark 转发成功 [{level}]' + ('（密文）' if enc_payload else '')}
                return
        except Exception as e:
            last_err = e
            _log(f'Bark 推送失败（第 {attempt + 1}/3 次）: {e}')
            if attempt < 2:
                time.sleep(1 + attempt)
    with _notify_lock:
        _notify_last = {'ts': time.time(), 'ok': False, 'title': str(title)[:60], 'detail': str(last_err)[:120]}


def _notify_guarded(key, title, body, level, subtitle='', group='', sound=''):
    """包装 _notify_bark：无论成败都释放在途计数（8.10.0 限流配套）。"""
    global _notify_inflight
    try:
        _notify_bark(key, title, body, level, subtitle, group, sound)
    except Exception as e:
        _log(f'_notify_bark 未预期异常: {e}')
    finally:
        with _notify_rate_lock:
            _notify_inflight -= 1


class RelayHandler(http.server.BaseHTTPRequestHandler):
    server_version = 'LISBarkRelay/1.0'

    def _origin_allowed(self):
        """POST 来源白名单：LIS 页面 Origin 放行；无 Origin（本机脚本）放行；其余 403。"""
        origin = (self.headers.get('Origin') or '').strip().rstrip('/').lower()
        return (not origin) or origin in NOTIFY_ALLOWED_ORIGINS

    def _send_json(self, obj, code=200):
        body = json.dumps(obj, ensure_ascii=False).encode('utf-8')
        self.send_response(code)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With')
        self.send_header('Access-Control-Max-Age', '86400')
        self.end_headers()

    def do_GET(self):
        path = unquote(urlparse(self.path).path)
        if path in ('/notify_status', '/healthz'):
            if path == '/notify_status' and not self._origin_allowed():
                _log(f'[security] 拒绝非白名单 Origin 的 GET {path}: {self.headers.get("Origin")}')
                self._send_json({'error': 'Origin not allowed'}, code=403)
                return
            cfg = _load_notify_config()
            key = (cfg.get('bark_key') or '').strip()
            with _notify_lock:
                last = _notify_last
            self._send_json({
                'configured': bool(key),
                'enabled': bool(cfg.get('enabled', True)),
                'last': last,
                'ts': int(time.time() * 1000),
                'relay': 'gateway',
            })
            return
        if path in ('/qc_config', '/qc-config'):
            if not self._origin_allowed():
                _log(f'[security] 拒绝非白名单 Origin 的 GET {path}: {self.headers.get("Origin")}')
                self._send_json({'error': 'Origin not allowed'}, code=403)
                return
            with _qc_lock:
                try:
                    if os.path.exists(QC_CONFIG_FILE):
                        with open(QC_CONFIG_FILE, 'r', encoding='utf-8') as f:
                            data = json.load(f)
                        if not isinstance(data, dict):
                            data = {}
                        self._send_json({
                            'ok': True,
                            'config': data.get('config'),
                            'mappings': data.get('mappings'),
                            'updated_at': data.get('updated_at', 0),
                            'updated_by': data.get('updated_by', '')
                        })
                    else:
                        self._send_json({'ok': True, 'config': None, 'mappings': None, 'updated_at': 0})
                except Exception as e:
                    _log(f'/qc_config 读取异常: {e}')
                    self._send_json({'ok': False, 'error': str(e)[:120]}, code=500)
            return
        self._send_json({'error': 'not found'}, code=404)

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        if path in ('/qc_config', '/qc-config'):
            if not self._origin_allowed():
                _log(f'[security] 拒绝非白名单 Origin 的 POST {path}: {self.headers.get("Origin")}')
                self._send_json({'error': 'Origin not allowed'}, code=403)
                return
            try:
                length = int(self.headers.get('Content-Length', 0) or 0)
                if length <= 0 or length > QC_MAX_BODY:
                    self._send_json({'error': 'payload invalid or too large'}, code=413)
                    return
                raw = self.rfile.read(length)
                payload = json.loads(raw.decode('utf-8'))
                if not isinstance(payload, dict):
                    self._send_json({'error': 'invalid json object'}, code=400)
                    return
                with _qc_lock:
                    existing = {}
                    if os.path.exists(QC_CONFIG_FILE):
                        try:
                            with open(QC_CONFIG_FILE, 'r', encoding='utf-8') as f:
                                existing = json.load(f)
                            if not isinstance(existing, dict):
                                existing = {}
                        except Exception:
                            existing = {}
                    if 'config' in payload and isinstance(payload['config'], dict):
                        existing['config'] = payload['config']
                    if 'mappings' in payload and isinstance(payload['mappings'], dict):
                        existing['mappings'] = payload['mappings']
                    now_ts = int(time.time() * 1000)
                    existing['updated_at'] = payload.get('updated_at') or now_ts
                    client_ip = self.headers.get('X-Real-IP') or self.client_address[0]
                    existing['updated_by'] = client_ip
                    # 原子落盘
                    tmp_file = QC_CONFIG_FILE + '.tmp'
                    with open(tmp_file, 'w', encoding='utf-8') as f:
                        json.dump(existing, f, ensure_ascii=False, indent=2)
                    os.replace(tmp_file, QC_CONFIG_FILE)
                _log(f'[qc_config] 已保存质控配置 (来自 {client_ip})，updated_at={existing["updated_at"]}')
                self._send_json({'ok': True, 'updated_at': existing['updated_at']})
            except Exception as e:
                _log(f'/qc_config 保存异常: {e}')
                self._send_json({'ok': False, 'error': str(e)[:120]}, code=500)
            return
        if path != '/notify':
            self._send_json({'error': 'not found'}, code=404)
            return
        if not self._origin_allowed():
            _log(f'[security] 拒绝非白名单 Origin 的 POST {path}: {self.headers.get("Origin")}')
            self._send_json({'error': 'Origin not allowed'}, code=403)
            return
        global _notify_last_accept_ts, _notify_inflight, _notify_last
        try:
            length = int(self.headers.get('Content-Length', 0) or 0)
            # 8.10.0: 请求体上限 + 拒绝负值（read(-n) 会挂到 EOF）
            if length < 0 or length > NOTIFY_MAX_BODY:
                self._send_json({'error': 'payload too large'}, code=413)
                return
            # 8.10.0: 全局限流——白名单外的本机脚本/局域网请求也能打到这里，
            # 防轰炸手机与重试线程耗尽。429+rate_limited 告知客户端属临时拒绝、可稍后重试
            with _notify_rate_lock:
                now = time.time()
                if now - _notify_last_accept_ts < NOTIFY_MIN_INTERVAL:
                    self._send_json({'accepted': False, 'rate_limited': True}, code=429)
                    return
                if _notify_inflight >= NOTIFY_MAX_INFLIGHT:
                    _log(f'[security] 在途推送已达上限 {NOTIFY_MAX_INFLIGHT}，拒绝新推送')
                    self._send_json({'accepted': False, 'rate_limited': True}, code=429)
                    return
                _notify_last_accept_ts = now
                _notify_inflight += 1
            # 8.10.1: 名额已占，之后任何异常路径都必须归还——此前 json.loads 抛错走最外层
            # except 时没有递减，实测 8 次畸形 JSON 后 _notify_inflight 恒为 8，
            # 合法推送被永久 429（须重启进程才恢复）。现用 handed_off + finally 保证恰好归还一次：
            # 只有真正把推送交给 _notify_guarded 线程时才由线程侧归还，其余路径在此归还。
            handed_off = False
            try:
                raw = self.rfile.read(length) if length else b'{}'
                data = json.loads(raw.decode('utf-8'))
                if not isinstance(data, dict):
                    self._send_json({'error': 'invalid json object'}, code=400)
                    return
                title = str(data.get('title') or '自动审核')
                body = str(data.get('body') or '')
                level = str(data.get('level') or 'active')
                # 8.10.3: subtitle；8.10.6: group / sound
                subtitle = str(data.get('subtitle') or '')
                group = str(data.get('group') or '')
                sound = str(data.get('sound') or '')
                cfg = _load_notify_config()
                key = (cfg.get('bark_key') or '').strip()
                if not key or not cfg.get('enabled', True):
                    _log(f'[notify] 未配置 bark_key 或 enabled=false，忽略推送: {title} - {body[:80]}')
                    with _notify_lock:
                        _notify_last = {'ts': time.time(), 'ok': False, 'title': str(title)[:60], 'detail': '未配置 bark_key 或 enabled=false，已忽略'}
                    self._send_json({'accepted': False})
                    return
                threading.Thread(target=_notify_guarded, args=(key, title, body, level, subtitle, group, sound), daemon=True).start()
                handed_off = True
                self._send_json({'accepted': True})
            finally:
                if not handed_off:
                    with _notify_rate_lock:
                        _notify_inflight -= 1
        except Exception as e:
            _log(f'/notify 处理异常: {e}')
            self._send_json({'error': str(e)[:120]}, code=500)

    def log_message(self, format, *args):
        pass  # 静默 access 日志，业务日志走 _log()


def main():
    port = 8766
    if '--port' in sys.argv:
        try:
            port = int(sys.argv[sys.argv.index('--port') + 1])
        except Exception:
            pass
    # 8.10.0: 端口占用时明确记日志——计划任务以 pythonw 跑、无控制台，静默死亡极难排查
    try:
        server = http.server.ThreadingHTTPServer(('127.0.0.1', port), RelayHandler)
    except OSError as e:
        _log(f'❌ 端口 {port} 绑定失败（errno={getattr(e, "errno", "?")}）：可能已有 bark_relay 在运行，本次退出')
        return
    _log(f'bark_relay 已启动 http://127.0.0.1:{port}（配置: {NOTIFY_CONFIG_FILE}）')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
