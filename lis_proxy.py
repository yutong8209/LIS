#!/usr/bin/env python3
"""
LIS 反向代理 & 代码缓存器
=========================
把浏览器流量经过此代理，自动将所有 HTML / JS / CSS / JSON / 接口响应
保存到本地 cache/ 文件夹，方便直接在编辑器里浏览和搜索 LIS 前端源码。

用法:
    python3 lis_proxy.py                          # 默认: 代理 192.168.31.111:9111，监听 9112
    python3 lis_proxy.py --target 10.0.29.100     # 直连地址
    python3 lis_proxy.py --port 9113               # 自定义监听端口
    python3 lis_proxy.py --cache-api               # 连 API 响应也缓存（仅调试用）

浏览器设置:
    1. 设置 HTTP 代理指向 localhost:9112
    2. 正常访问 http://192.168.31.111:9111/iMedicalLIS/ （或 10.0.29.100 直连）
    3. 所有响应自动保存到 ./cache/ 文件夹
    4. 用编辑器打开 ./cache/ 即可搜索和浏览所有前端代码
"""

import http.server
import urllib.request
import urllib.error
import os
import sys
import json
import hashlib
import threading
import time
import argparse
import re
from pathlib import Path
from datetime import datetime
from urllib.parse import urlparse, unquote


# 配置（运行时由参数覆盖）
TARGET = '10.0.29.100'
LISTEN_PORT = 9112
LISTEN_HOST = '127.0.0.1'
CACHE_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'cache')
# 默认不缓存 API/接口响应（可能含检验业务数据）；仅缓存静态前端资源
CACHE_API = False
# 8.9.0: --verbose 才打印请求头/Body 调试日志——Body 预览可能含患者数据，默认不应落终端
VERBOSE = False

# 强制直连：urlopen 默认读取 http_proxy/HTTPS_PROXY 环境变量，
# 内网 LIS 流量绝不能被路由到系统代理（会 502/超时，甚至把内网数据发出外网）
_DIRECT_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))

# 需要缓存的文件类型
STATIC_EXTS = {
    '.js': 'js', '.mjs': 'js',
    '.css': 'css',
    '.html': 'html', '.htm': 'html',
    '.json': 'json', '.xml': 'json',
    '.csp': 'html',
    '.ashx': 'other',
    '.aspx': 'html', '.asp': 'html',
    '.svg': 'svg', '.ico': 'ico',
    '.png': 'img', '.jpg': 'img', '.jpeg': 'img', '.gif': 'img', '.webp': 'img',
    '.woff': 'font', '.woff2': 'font', '.ttf': 'font', '.eot': 'font',
    '.map': 'map',
}

# API 路径模式
API_PATTERNS = [
    r'/ashx/', r'/api/', r'/ashBT', r'/ash[A-Z]',
    r'\.ashx', r'\.csp', r'WorkGroup', r'Report',
]

# 全局统计（ThreadingHTTPServer 下多线程并发更新，加锁）
stats = {'cached': 0, 'forwarded': 0, 'api_saved': 0, 'errors': 0}
_stats_lock = threading.Lock()


def safe_path(url_path):
    path = unquote(url_path).lstrip('/')
    path = re.sub(r'[<>:"|?*]', '_', path)
    parts = [p for p in path.replace('\\', '/').split('/') if p and p != '.']
    if any(p == '..' for p in parts):
        raise ValueError('path traversal rejected')
    return '/'.join(parts)


def resolve_cache_file(subdir, relative_path):
    """确保写入路径落在 CACHE_DIR 内。"""
    root = Path(CACHE_DIR).resolve()
    base = (root / subdir).resolve()
    dest = (base / relative_path).resolve()
    if dest != root and not str(dest).startswith(str(root) + os.sep):
        raise ValueError('cache path escapes CACHE_DIR')
    return dest


def detect_type(url_path, content_type=''):
    ext = os.path.splitext(url_path.split('?')[0])[1].lower()
    if ext in STATIC_EXTS:
        return STATIC_EXTS[ext]
    ct = content_type.lower()
    if 'javascript' in ct: return 'js'
    if 'css' in ct: return 'css'
    if 'html' in ct: return 'html'
    if 'json' in ct: return 'json'
    if 'xml' in ct: return 'json'
    if 'image/' in ct: return 'img'
    if 'font/' in ct: return 'font'
    return 'other'


def is_api_path(url_path):
    for p in API_PATTERNS:
        if re.search(p, url_path, re.IGNORECASE):
            return True
    return False


def content_hash(data):
    return hashlib.md5(data).hexdigest()[:8]


def save_file(filepath, data, headers=None):
    os.makedirs(os.path.dirname(filepath), exist_ok=True)
    with open(filepath, 'wb') as f:
        f.write(data)
    if headers:
        meta_path = filepath + '.__meta__'
        meta = {
            'saved_at': datetime.now().isoformat(),
            'size': len(data),
            'headers': {k: v for k, v in headers.items()
                        if k.lower() in ('content-type', 'last-modified', 'etag')},
        }
        with open(meta_path, 'w', encoding='utf-8') as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)


def save_manifest(entry):
    manifest_path = os.path.join(CACHE_DIR, 'manifest.jsonl')
    with open(manifest_path, 'a', encoding='utf-8') as f:
        f.write(json.dumps(entry, ensure_ascii=False) + '\n')


def cache_response(method, url_path, query, content_type, body):
    file_type = detect_type(url_path, content_type)
    safe = safe_path(url_path)

    if method == 'POST':
        body_hash = content_hash(body) if body else 'empty'
        query_str = '__q_' + re.sub(r'[<>:"|?*&=]', '_', query)[:80] if query else ''
        filename = safe + query_str + '__' + body_hash + '.json'
        filepath = str(resolve_cache_file(file_type, filename))
        save_file(filepath, body)
        with _stats_lock:
            stats['api_saved'] += 1
        return filepath

    if file_type in ('js', 'css', 'svg', 'ico', 'img', 'font', 'map'):
        filepath = str(resolve_cache_file(file_type, safe))
        save_file(filepath, body)
        with _stats_lock:
            stats['cached'] += 1
        return filepath

    if query:
        safe_query = re.sub(r'[<>:"|?*&=]', '_', query)[:120]
        base, ext = os.path.splitext(safe)
        rel = base + '__' + safe_query + ext
    else:
        rel = safe

    filepath = str(resolve_cache_file(file_type, rel))
    save_file(filepath, body)
    with _stats_lock:
        stats['cached'] += 1
    return filepath


class LISProxyHandler(http.server.BaseHTTPRequestHandler):

    def log_message(self, fmt, *args):
        ts = datetime.now().strftime('%H:%M:%S')
        print('  [{}] {}'.format(ts, args[0]))

    def do_GET(self):    self._proxy('GET')
    def do_POST(self):   self._proxy('POST')
    def do_OPTIONS(self):self._proxy('OPTIONS')
    def do_PUT(self):    self._proxy('PUT')
    def do_DELETE(self): self._proxy('DELETE')

    def do_CONNECT(self):
        """HTTPS 隧道请求 — 返回 501（不支持）"""
        self.send_error(501, 'HTTPS tunnel not supported')
        self.end_headers()

    def _proxy(self, method):
        parsed = urlparse(self.path)
        url_path = parsed.path
        query = parsed.query
        # HTTP 代理的 self.path 可能是完整 URL，需要解析
        _parsed = urlparse(self.path)
        if _parsed.scheme in ('http', 'https'):
            target_url = self.path  # self.path 已是完整 URL
        else:
            target_url = 'http://' + TARGET + self.path

        content_length = int(self.headers.get('Content-Length', 0))
        req_body = self.rfile.read(content_length) if content_length > 0 else None

        req_headers = {}
        for key, val in self.headers.items():
            if key.lower() in ('host', 'connection', 'transfer-encoding', 'keep-alive', 'accept-encoding'):
                continue
            req_headers[key] = val
        # Host 头根据实际目标 URL 设置
        _tparsed = urlparse(target_url)
        req_headers['Host'] = _tparsed.netloc or TARGET

        # ── 调试日志（8.9.0: 默认关闭——请求头/Body 预览可能含患者数据，加 --verbose 才输出）──
        if VERBOSE:
            print('\n' + '='*60)
            print(f'  📡 {method} {self.path}')
            print(f'  → 转发到: {target_url}')
            print(f'  → Host: {req_headers.get("Host", "(无)")}')
            print(f'  → 请求头 ({len(req_headers)} 个):')
            for k,v in req_headers.items():
                val_show = v[:60] + '...' if len(v) > 60 else v
                print(f'    {k}: {val_show}')
            if req_body:
                body_preview = req_body[:200].decode('utf-8', errors='replace')
                print(f'  → Body ({len(req_body)} bytes): {body_preview}')
            print('='*60)
            sys.stdout.flush()

        try:
            req = urllib.request.Request(target_url, data=req_body, headers=req_headers, method=method)
            # LIS 主服务器用长超时，其他服务器用短超时
            _timeout = 60 if TARGET in target_url else 3
            resp = _DIRECT_OPENER.open(req, timeout=_timeout)
            resp_body = resp.read()
            resp_headers = dict(resp.getheaders())
            resp_status = resp.status
        except urllib.error.HTTPError as e:
            resp_status = e.code
            resp_body = e.read()
            resp_headers = dict(e.headers)
        except urllib.error.URLError as e:
            import traceback
            traceback.print_exc()
            print(f'  ❌ URLError: {e.reason}')
            self.send_error(502, 'Bad Gateway: {}'.format(e.reason))
            with _stats_lock:
                stats['errors'] += 1
            return
        except Exception as e:
            import traceback
            traceback.print_exc()
            print(f'  ❌ 代理异常: {e}')
            self.send_error(502, 'Proxy Error: {}'.format(e))
            with _stats_lock:
                stats['errors'] += 1
            return

        content_type = resp_headers.get('Content-Type', '') or resp_headers.get('content-type', '')
        file_type = detect_type(url_path, content_type)

        # 默认只缓存静态前端资源；API/POST 需显式 --cache-api（可能含业务数据）
        static_types = ('js', 'css', 'html', 'svg', 'ico', 'img', 'font', 'map')
        if CACHE_API:
            should_cache = True
            if method == 'GET' and file_type == 'other' and not is_api_path(url_path):
                should_cache = False
        else:
            # detect_type 已按扩展名/Content-Type 确认是静态资源才进 static_types，
            # 不再叠加 is_api_path 子串过滤——否则 /Report/js/common.js 这类纯静态也会被误排除
            should_cache = file_type in static_types and method == 'GET'

        if should_cache and resp_body:
            try:
                cached_path = cache_response(method, url_path, query, content_type, resp_body)
            except ValueError as e:
                print('  ⚠️  跳过非法缓存路径: {}'.format(e))
                cached_path = None
            if cached_path:
                save_manifest({
                    'time': datetime.now().isoformat(),
                    'method': method,
                    'url': self.path,
                    'status': resp_status,
                    'type': file_type,
                    'size': len(resp_body),
                    'path': os.path.relpath(cached_path, CACHE_DIR),
                })

        with _stats_lock:
            stats['forwarded'] += 1

        try:
            self.send_response(resp_status)
        except Exception:
            return

        for key, val in resp_headers.items():
            if key.lower() in ('transfer-encoding', 'connection', 'content-encoding',
                               'content-length', 'keep-alive'):
                continue
            self.send_header(key, val)
        self.send_header('Content-Length', str(len(resp_body)))
        self.send_header('Access-Control-Allow-Origin', '*')
        self.end_headers()
        self.wfile.write(resp_body)

        icon = '📦' if should_cache and resp_body else '⏭️ '
        size_kb = len(resp_body) / 1024
        print('  {} {} {}  -> {}  ({:.1f} KB){}'.format(
            icon, method, self.path[:80], resp_status, size_kb,
            '  [{}]'.format(file_type) if should_cache and resp_body else ''))


def main():
    global TARGET, LISTEN_PORT, LISTEN_HOST, CACHE_DIR, CACHE_API

    parser = argparse.ArgumentParser(description='LIS 反向代理 & 代码缓存器')
    parser.add_argument('--target', '-t', default='192.168.31.111:9111',
                        help='目标服务器 (默认: 192.168.31.111:9111)')
    parser.add_argument('--port', '-p', type=int, default=9112,
                        help='监听端口 (默认: 9112)')
    parser.add_argument('--bind', '-b', default='127.0.0.1',
                        help='监听地址 (默认: 127.0.0.1，仅本机)')
    parser.add_argument('--cache-dir', '-d', default=None, help='缓存目录')
    parser.add_argument('--clear', action='store_true', help='启动前清空缓存')
    parser.add_argument('--cache-api', action='store_true',
                        help='缓存 API/接口响应（可能含业务数据，仅调试时用）')
    parser.add_argument('--verbose', action='store_true',
                        help='打印每个请求的头部/Body 调试日志（可能含患者数据，慎用）')
    args = parser.parse_args()

    TARGET = args.target
    LISTEN_PORT = args.port
    LISTEN_HOST = args.bind
    CACHE_API = bool(args.cache_api)
    VERBOSE = bool(args.verbose)
    if args.cache_dir:
        CACHE_DIR = os.path.abspath(args.cache_dir)

    if args.clear and os.path.exists(CACHE_DIR):
        import shutil
        shutil.rmtree(CACHE_DIR)
        print('  🗑️  缓存已清空')

    os.makedirs(CACHE_DIR, exist_ok=True)

    save_manifest({
        'time': datetime.now().isoformat(),
        'event': 'proxy_start',
        'target': TARGET,
        'port': LISTEN_PORT,
    })

    print()
    print('  ╔══════════════════════════════════════════╗')
    print('  ║     🔬 LIS 代码缓存代理                  ║')
    print('  ╠══════════════════════════════════════════╣')
    print('  ║  目标服务器: {:<27}║'.format(TARGET))
    print('  ║  代理监听:   {}:{:<18}║'.format(LISTEN_HOST, LISTEN_PORT))
    print('  ╠══════════════════════════════════════════╣')
    print('  ║  状态查看:   http://localhost:{:<10}║'.format(LISTEN_PORT))
    print('  ║  API缓存:    {:<27}║'.format('开启(含业务数据)' if CACHE_API else '关闭(仅静态)'))
    print('  ╚══════════════════════════════════════════╝')
    print()
    print('  📋 使用方法:')
    print('  1. 设置浏览器 HTTP 代理 → localhost:{}'.format(LISTEN_PORT))
    print('  2. 访问 http://{}/iMedicalLIS/'.format(TARGET))
    print('  3. 浏览各个页面，静态前端代码缓存到 cache/ 目录')
    print('  4. 用编辑器打开 cache/ 搜索前端代码')
    print()
    if not CACHE_API:
        print('  🔒 默认不缓存 API（保护业务数据）。调试接口可加 --cache-api')
    print('  💡 先把 LIS 主要页面都点一遍，缓存自动累积')
    print('  按 Ctrl+C 停止代理')
    print('─' * 46)

    # 8.9.0: ThreadingHTTPServer——单线程 HTTPServer 会把浏览器并发请求完全串行化，
    # 开着代理浏览 LIS 明显卡顿；多线程后各请求并行转发（stats 已加锁）
    server = http.server.ThreadingHTTPServer((LISTEN_HOST, LISTEN_PORT), LISProxyHandler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print('\n\n  🛑 代理已停止')
        print('  📦 共缓存 {} 个文件，转发 {} 个请求，保存 {} 个 API 响应'.format(
            stats['cached'], stats['forwarded'], stats['api_saved']))
        print('  📁 缓存目录: {}'.format(CACHE_DIR))
        server.server_close()


if __name__ == '__main__':
    main()
