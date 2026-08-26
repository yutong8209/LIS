#!/usr/bin/env python3
"""本地脚本服务器 - 配合 Tampermonkey 自动更新，并托管 vendor 依赖（SheetJS 等）"""
import http.server
import mimetypes
import os
import json
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


def _load_notify_config():
    try:
        with open(NOTIFY_CONFIG_FILE, 'r', encoding='utf-8') as f:
            cfg = json.load(f)
        return cfg if isinstance(cfg, dict) else {}
    except Exception:
        return {}


def _notify_bark(key, title, body, level):
    """后台线程转发到 Bark 云端 → APNs → iPhone（Apple Watch 镜像）。失败仅打印，不阻塞 serve。"""
    if level not in _NOTIFY_LEVELS:
        level = 'active'
    payload = json.dumps({
        'device_key': key,
        'title': title,
        'body': body,
        'level': level,
    }, ensure_ascii=False).encode('utf-8')
    req = urllib.request.Request(
        BARK_PUSH_URL, data=payload,
        headers={'Content-Type': 'application/json; charset=utf-8'},
        method='POST',
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            print(f'[{time.strftime("%H:%M:%S")}] Bark 推送成功 [{level}] {title} - {body}')
    except Exception as e:
        print(f'[{time.strftime("%H:%M:%S")}] Bark 推送失败: {e}')


ALLOWED = {
    '/': SCRIPT,
    '/iMedicalLIS-enhancer.user.js': SCRIPT,
    '/vendor/xlsx.full.min.js': os.path.join(VENDOR, 'xlsx.full.min.js'),
}


class Handler(http.server.BaseHTTPRequestHandler):
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
        # 菜单栏指令读取（SwiftBar 点击 → 通知 userscript 切分类）
        if path == '/cmd':
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
        global _stats_data, _cmd_data
        path = unquote(urlparse(self.path).path)
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
