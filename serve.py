#!/usr/bin/env python3
"""本地脚本服务器 - 配合 Tampermonkey 自动更新"""
import http.server
import os

PORT = 8765
FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'iMedicalLIS-enhancer.user.js')

class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path in ('/', '/iMedicalLIS-enhancer.user.js'):
            try:
                with open(FILE, 'r', encoding='utf-8') as f:
                    content = f.read()
                self.send_response(200)
                self.send_header('Content-Type', 'application/javascript; charset=utf-8')
                self.send_header('Cache-Control', 'no-cache')
                self.end_headers()
                self.wfile.write(content.encode('utf-8'))
                print(f'[{self.log_date_time_string()}] 脚本已提供 ({len(content)} bytes)')
            except Exception as e:
                self.send_response(500)
                self.end_headers()
                self.wfile.write(str(e).encode())
        else:
            self.send_response(404)
            self.end_headers()
            self.wfile.write(b'Not found')

    def log_message(self, format, *args):
        pass  # 静默日志

print('========================================')
print('  脚本服务器已启动')
print(f'  地址: http://localhost:{PORT}/')
print(f'  更新URL: http://localhost:{PORT}/iMedicalLIS-enhancer.user.js')
print('========================================')
print('  使用方法:')
print('  1. 保持此窗口运行')
print('  2. 编辑 iMedicalLIS-enhancer.user.js')
print('  3. 在 Tampermonkey 面板点击脚本的"更新"按钮')
print('========================================')

http.server.HTTPServer(('127.0.0.1', PORT), Handler).serve_forever()
