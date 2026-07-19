#!/usr/bin/env python3
"""本地脚本服务器 - 配合 Tampermonkey 自动更新，并托管 vendor 依赖（SheetJS 等）"""
import http.server
import mimetypes
import os
import json
import threading
import time
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

ALLOWED = {
    '/': SCRIPT,
    '/iMedicalLIS-enhancer.user.js': SCRIPT,
    '/vendor/xlsx.full.min.js': os.path.join(VENDOR, 'xlsx.full.min.js'),
}


class Handler(http.server.BaseHTTPRequestHandler):
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
            self.end_headers()
            self.wfile.write(str(e).encode())

    def do_POST(self):
        path = unquote(urlparse(self.path).path)
        if path != '/stats':
            self.send_response(404)
            self.end_headers()
            return
        try:
            length = int(self.headers.get('Content-Length', 0))
            raw = self.rfile.read(length) if length else b'{}'
            data = json.loads(raw.decode('utf-8'))
            data['ts'] = int(time.time())
            data['ok'] = True
            global _stats_data
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
            self.end_headers()
            self.wfile.write(str(e).encode())

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

http.server.HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
