#!/usr/bin/env node
/**
 * 本地脚本服务器 - 配合 Tampermonkey 自动更新
 * 用法: node serve.js
 * 然后在 Tampermonkey 中安装/更新脚本时输入: http://localhost:8765/iMedicalLIS-enhancer.user.js
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = 8765;
const FILE = path.join(__dirname, 'iMedicalLIS-enhancer.user.js');

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/iMedicalLIS-enhancer.user.js') {
        try {
            const content = fs.readFileSync(FILE, 'utf-8');
            res.writeHead(200, {
                'Content-Type': 'application/javascript; charset=utf-8',
                'Cache-Control': 'no-cache'
            });
            res.end(content);
            console.log(`[${new Date().toLocaleTimeString()}] 脚本已提供 (${content.length} bytes)`);
        } catch (e) {
            res.writeHead(500);
            res.end('Error: ' + e.message);
        }
    } else {
        res.writeHead(404);
        res.end('Not found');
    }
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`========================================`);
    console.log(`  脚本服务器已启动`);
    console.log(`  地址: http://localhost:${PORT}/`);
    console.log(`  更新URL: http://localhost:${PORT}/iMedicalLIS-enhancer.user.js`);
    console.log(`========================================`);
    console.log(`  使用方法:`);
    console.log(`  1. 保持此窗口运行`);
    console.log(`  2. 编辑 iMedicalLIS-enhancer.user.js`);
    console.log(`  3. 在 Tampermonkey 面板点击脚本的"更新"按钮`);
    console.log(`  或者: Tampermonkey 设置中启用"检查更新"`);
    console.log(`========================================`);
});
