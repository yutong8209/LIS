#!/usr/bin/env node
/**
 * 本地脚本服务器（仅静态服务：用户脚本 + vendor）
 * ⚠️ 不含 serve.py 的 /stats、/cmd、/cmd/claim 菜单栏桥——
 *    菜单栏统计/点击跳转、批审指令功能必须用 python3 serve.py
 * 用法: node serve.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const PORT = 8765;
const ROOT = __dirname;
const SCRIPT = path.join(ROOT, 'iMedicalLIS-enhancer.user.js');
const VENDOR = path.join(ROOT, 'vendor');

const ALLOWED = {
    '/': SCRIPT,
    '/iMedicalLIS-enhancer.user.js': SCRIPT,
    '/vendor/xlsx.full.min.js': path.join(VENDOR, 'xlsx.full.min.js'),
};

const server = http.createServer((req, res) => {
    const reqPath = new URL(req.url, 'http://127.0.0.1').pathname;
    let file = ALLOWED[reqPath];
    if (!file && reqPath.startsWith('/vendor/')) {
        const name = path.basename(reqPath);
        const candidate = path.join(VENDOR, name);
        // 8.15.3: 与 serve.py 对齐——用 resolve 归一化后再比对前缀（VENDOR 本身含符号链接时
        // 原 startsWith 判断会失真）；补花括号修掉 eslint curly error
        const vendorRoot = path.resolve(VENDOR);
        const resolved = path.resolve(candidate);
        if ((resolved === vendorRoot || resolved.startsWith(vendorRoot + path.sep)) && fs.existsSync(resolved)) {
            file = resolved;
        }
    }
    if (!file || !fs.existsSync(file)) {
        res.writeHead(404);
        res.end('Not found');
        return;
    }
    try {
        const content = fs.readFileSync(file);
        res.writeHead(200, {
            'Content-Type': 'application/javascript; charset=utf-8',
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*',
            'Content-Length': content.length
        });
        res.end(content);
        console.log(`[${new Date().toLocaleTimeString()}] ${reqPath} (${content.length} bytes)`);
    } catch (e) {
        res.writeHead(500);
        res.end('Error: ' + e.message);
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`========================================`);
    console.log(`  脚本服务器已启动`);
    console.log(`  地址: http://localhost:${PORT}/`);
    console.log(`  更新URL: http://localhost:${PORT}/iMedicalLIS-enhancer.user.js`);
    console.log(`  SheetJS: http://localhost:${PORT}/vendor/xlsx.full.min.js`);
    console.log(`========================================`);
});
