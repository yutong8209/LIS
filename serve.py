#!/usr/bin/env python3
"""本地脚本服务器 - 配合 Tampermonkey 自动更新 + 质控导出"""
import http.server
import json
import os
from urllib.parse import urlparse

from qc_export import generate_zip

PORT = 8765
ROOT = os.path.dirname(os.path.abspath(__file__))
FILE = os.path.join(ROOT, 'iMedicalLIS-enhancer.user.js')
CONFIG_FILE = os.path.join(ROOT, 'qc-export-config.json')


def cors_headers(handler):
    handler.send_header('Access-Control-Allow-Origin', '*')
    handler.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
    handler.send_header('Access-Control-Allow-Headers', 'Content-Type')


class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):
        self.send_response(204)
        cors_headers(self)
        self.end_headers()

    def do_GET(self):
        path = urlparse(self.path).path
        if path in ('/', '/iMedicalLIS-enhancer.user.js'):
            try:
                with open(FILE, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                self.send_header('Cache-Control', 'no-cache')
                cors_headers(self)
                self.end_headers()
                self.wfile.write(content.encode('utf-8'))
                print(f'[{self.log_date_time_string()}] 脚本已提供 ({len(content)} bytes)')
            except Exception as e:
                self.send_response(500)
                cors_headers(self)
                self.end_headers()
                self.wfile.write(str(e).encode())
        elif path == '/qc-export/config.json':
            try:
                with open(CONFIG_FILE, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/json; charset=utf-8')
                self.send_header('Cache-Control', 'no-cache')
                cors_headers(self)
                self.end_headers()
                self.wfile.write(content.encode('utf-8'))
            except Exception as e:
                self.send_response(500)
                cors_headers(self)
                self.end_headers()
                self.wfile.write(str(e).encode())
        else:
            self.send_response(404)
            cors_headers(self)
            self.end_headers()
            self.wfile.write(b'Not found')

    def do_POST(self):
        path = urlparse(self.path).path
        if path != '/qc-export/generate':
            self.send_response(404)
            cors_headers(self)
            self.end_headers()
            self.wfile.write(b'Not found')
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
            body = self.rfile.read(length).decode('utf-8') if length else '{}'
            payload = json.loads(body)
            zip_bytes = generate_zip(payload)
            year = payload.get('year', '')
            month = payload.get('month', '')
            filename = f'质控上传_{year}-{int(month):02d}.zip'
            self.send_response(200)
            self.send_header('Content-Type', 'application/zip')
            self.send_header('Content-Disposition', f'attachment; filename="{filename}"')
            cors_headers(self)
            self.end_headers()
            self.wfile.write(zip_bytes)
            print(f'[{self.log_date_time_string()}] 质控导出 zip ({len(zip_bytes)} bytes)')
        except Exception as e:
            self.send_response(500)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            cors_headers(self)
            self.end_headers()
            self.wfile.write(json.dumps({'error': str(e)}, ensure_ascii=False).encode('utf-8'))

    def log_message(self, format, *args):
        pass


print('========================================')
print('  脚本服务器已启动')
print(f'  地址: http://localhost:{PORT}/')
print(f'  更新URL: http://localhost:{PORT}/iMedicalLIS-enhancer.user.js')
print(f'  质控配置: http://localhost:{PORT}/qc-export/config.json')
print('========================================')
print('  使用方法:')
print('  1. 保持此窗口运行')
print('  2. 编辑 iMedicalLIS-enhancer.user.js')
print('  3. 在 Tampermonkey 面板点击脚本的"更新"按钮')
print('========================================')

http.server.HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()