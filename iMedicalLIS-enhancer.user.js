// ==UserScript==
// @name         iMedicalLIS 增强助手
// @namespace    lis-enhancer-local
// @version      7.20.31
// @description  报告审核增强 — 批量审核 + 审核工作台 + 病人结果筛选导出 + 质控录入辅助 + 热键（纯本地运行，无任何上传）
// @author       LIS-Enhancer
// @match        http://10.0.29.100/iMedicalLIS/*
// @match        http://192.168.31.111:9111/iMedicalLIS/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @updateURL    http://localhost:8765/iMedicalLIS-enhancer.user.js
// @downloadURL  http://localhost:8765/iMedicalLIS-enhancer.user.js
// @run-at       document-idle
// @noframes     false
// ==/UserScript==

(function () {
    'use strict';

    /* ============================================================
       🔒 隐私声明
       - 所有数据仅在本地浏览器内处理
       - 不向任何外部服务器发送请求
       - 仅与本院内网 10.0.29.100 通信
       - 密码以 base64 编码存储在 localStorage（同源隔离）
       ============================================================ */

    // ==================== 常量 ====================
    const BASE = location.origin + '/iMedicalLIS';
    const CSP  = BASE + '/csp/jquery.easyui.dhcclassjson.csp';
    const WGM  = BASE + '/sys/ashx/ashBTWorkGroupMachine.ashx';
    const RPT  = BASE + '/sys/ashx/ashReportCommon.ashx';

    const NATIVE_WORKLIST_SEL = '#dgWorkList';
    const DATAGRID_SELECTORS = [NATIVE_WORKLIST_SEL, '#dg', '#dgReport', '.datagrid-f'];
    const DATAGRID_SELECTORS_EXTENDED = ['#dg', '#dgReport', '.datagrid-f', 'table.datagrid-f', '#workList', '.datagrid-view'];

    const WG = [
        { dr:'1', name:'临检', color:'#e74c3c', icon:'🩸' },
        { dr:'3', name:'生化', color:'#3498db', icon:'🧪' },
        { dr:'4', name:'免疫', color:'#2ecc71', icon:'🛡️' },
    ];
    const WG_MAP = {}; WG.forEach(w => WG_MAP[w.dr] = w);

    const REFRESH = 30000;
    const K = { au:'LIS_AuInfo_Persist', ent:'LIS_EntryInfo_Persist', pwd:'LIS_AuthPwd_Persist', tgt:'LIS_NavigateTarget', caPwd:'LIS_CAPwd_Persist', caAuth:'LIS_CAAuth_Persist', auditQueue:'LIS_AuditQueue_Persist', auditQueueLock:'LIS_AuditQueueLock', wsState:'LIS_WSState_Persist' };
    const CLASSIFY_STALE_MS = 5 * 60 * 1000;
    const AUDIT_QUEUE_LOCK_TTL = 45000;

    // ==================== 工具 ====================
    const $  = s => document.querySelector(s);
    const $$ = s => document.querySelectorAll(s);
    const uw = () => { try { return unsafeWindow; } catch(e) { return window; } };
    const g  = k => { try { return uw()[k]; } catch(e) { return undefined; } };
    const ssDR   = () => g('SessionStr') || '';
    const wgDR   = () => g('WorkGroupDR') || '';
    const uid    = () => { const s = ssDR(); return s ? s.split('^')[0] : g('LoginUserDR')||''; };
    const uname  = () => g('LoginUserName') || '';
    const buildSS = dr => uid() + '^' + dr + '^0^8^1';
    const today  = () => { const d=new Date(); return d.getFullYear()+'-'+String(d.getMonth()+1).padStart(2,'0')+'-'+String(d.getDate()).padStart(2,'0'); };
    // 旧版 base64 编码（保持向后兼容）
    const encPwd = p => { try { return btoa(unescape(encodeURIComponent(p))); } catch(e) { return p; } };
    const decPwd = e => { try { if (!e || e.startsWith('V2:')) return ''; return decodeURIComponent(escape(atob(e))); } catch(e) { return ''; } };
    const isPatientResultPanelEvent = e => {
        const t = e && e.target;
        return !!(t && t.closest && t.closest('#lis-pr-panel'));
    };
    const isEditableEventTarget = e => {
        const t = e && e.target;
        if (!t) return false;
        const tag = String(t.tagName || '').toUpperCase();
        return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
    };

    // ==================== AES-GCM 密码加密 ====================
    // 威胁模型：密钥硬编码在脚本中，能读取脚本源码的攻击者可解密。
    // 比 base64 强在：PBKDF2 派生增加逆向成本 + 随机 IV 防止相同密码产生相同密文。
    // 注意：crypto.subtle 仅在 secure context（HTTPS 或 localhost）下可用。
    // 非安全上下文（如 http://10.x.x.x）会自动回退到 base64。
    const _cryptoAvailable = !!(typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.importKey);
    let _cryptoKey = null;
    async function getCryptoKey() {
        if (!_cryptoAvailable) return null;
        if (_cryptoKey) return _cryptoKey;
        try {
            const enc = new TextEncoder();
            const seed = enc.encode('lis-enhancer-v7.7.7-salt');
            const km = await crypto.subtle.importKey('raw', seed, 'PBKDF2', false, ['deriveKey']);
            _cryptoKey = await crypto.subtle.deriveKey(
                { name:'PBKDF2', salt:enc.encode(location.origin), iterations:100000, hash:'SHA-256' },
                km, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']
            );
            return _cryptoKey;
        } catch(e) { return null; }
    }
    function toB64(buf) { const bytes = new Uint8Array(buf); let s = ''; for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]); return btoa(s); }
    function fromB64(str) { const bin = atob(str); const buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i); return buf; }
    async function encPwdV2(plain) {
        const key = await getCryptoKey();
        if (!key) return encPwd(plain); // crypto 不可用，直接 base64
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, key, new TextEncoder().encode(plain));
        return 'V2:' + toB64(iv) + ':' + toB64(ct);
    }
    async function decPwdV2(stored) {
        if (!stored) return '';
        if (stored.startsWith('V2:')) {
            const key = await getCryptoKey();
            if (!key) return ''; // crypto 不可用，无法解密 V2
            try {
                const parts = stored.slice(3).split(':');
                const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv: fromB64(parts[0]) }, key, fromB64(parts[1]));
                return new TextDecoder().decode(pt);
            } catch(e) { return ''; }
        }
        if (stored.startsWith('B64:')) return decPwd(stored.slice(4));
        return decPwd(stored); // 旧格式
    }
    // 清除无法解密的 V2 数据（crypto 不可用时）
    function repairPwdStorage() {
        if (_cryptoAvailable) return;
        [K.pwd, K.caPwd].forEach(k => {
            const v = localStorage.getItem(k);
            if (v && v.startsWith('V2:')) {
                dbg('清除无法解密的 V2 密码:', k);
                localStorage.removeItem(k);
            }
        });
    }

    // 同步 API（保持向后兼容，用于非 async 上下文）
    const savePwd = p => { try { localStorage.setItem(K.pwd, encPwd(p)); } catch(e){} };
    const loadPwd = () => { try { const v=localStorage.getItem(K.pwd); return v?decPwd(v):''; } catch(e){ return ''; } };
    const saveCAPwd = p => { try { localStorage.setItem(K.caPwd, encPwd(p)); } catch(e){} };
    const loadCAPwd = () => { try { const v=localStorage.getItem(K.caPwd); return v?decPwd(v):''; } catch(e){ return ''; } };

    // 异步 API（AES-GAM 加密，用于 async 上下文）
    async function savePwdAsync(p) {
        try { localStorage.setItem(K.pwd, await encPwdV2(p)); } catch(e) { savePwd(p); }
    }
    async function loadPwdAsync() {
        try { const v = localStorage.getItem(K.pwd); return v ? await decPwdV2(v) : ''; } catch(e) { return loadPwd(); }
    }
    async function saveCAPwdAsync(p) {
        try { localStorage.setItem(K.caPwd, await encPwdV2(p)); } catch(e) { saveCAPwd(p); }
    }
    async function loadCAPwdAsync() {
        try { const v = localStorage.getItem(K.caPwd); return v ? await decPwdV2(v) : ''; } catch(e) { return loadCAPwd(); }
    }
    async function migratePwdStorage() {
        if (!_cryptoAvailable) { repairPwdStorage(); return; }
        try {
            const pwd = loadPwd();
            if (pwd && !localStorage.getItem(K.pwd)?.startsWith('V2:')) await savePwdAsync(pwd);
            const caPwd = loadCAPwd();
            if (caPwd && !localStorage.getItem(K.caPwd)?.startsWith('V2:')) await saveCAPwdAsync(caPwd);
        } catch(e) {}
    }
    const saveCAAuth = (dr) => { try { localStorage.setItem(K.caAuth, JSON.stringify({ time: Date.now(), wg: dr || wgDR() })); } catch(e){} };
    const loadCAAuth = () => { try { const v=localStorage.getItem(K.caAuth); if(!v) return null; const o=JSON.parse(v); return o; } catch(e){ return null; } };
    const clearCAAuth = () => { try { localStorage.removeItem(K.caAuth); } catch(e){} };
    const esc = s => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    const escAttr = s => esc(s);
    // 通过原生 setter 设置 input 值（兼容 EasyUI/React 等框架）
    function setNativeInputValue(el, value) {
        try {
            // 尝试使用所属 document 的原生 setter
            var win = el.ownerDocument ? el.ownerDocument.defaultView : window;
            if (!win) win = window;
            var setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
            if (setter && setter.set) {
                el.focus();
                setter.set.call(el, value);
            } else {
                el.focus();
                el.value = value;
            }
        } catch(e) {
            el.focus();
            el.value = value;
        }
        el.dispatchEvent(new Event('focus', {bubbles:true}));
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        el.dispatchEvent(new Event('blur', {bubbles:true}));
    }


    // ==================== 调试日志 ====================
    const DEBUG = false;
    const _dbgLog = [];
    const dbg = (...args) => {
        if (DEBUG) {
            const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            console.log('[LIS]', msg);
            _dbgLog.push(msg); if (_dbgLog.length > 500) _dbgLog.splice(0, _dbgLog.length - 500);
        }
    };
    // 在页面底部显示调试面板（Alt+D 切换）
    function showDebugPanel() {
        let panel = document.getElementById('lis-debug-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'lis-debug-panel';
        panel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999999;background:#1e1e1e;color:#0f0;font:12px monospace;padding:10px;max-height:40vh;overflow:auto';
        panel.innerHTML = '<b>LIS Debug Log (Alt+D 关闭)</b><br>' + _dbgLog.map(l => esc(l)).join('<br>');
        document.body.appendChild(panel);
    }

    async function fetchJ(u, timeoutMs, externalSignal) {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
        let externalAbort = null;
        try {
            if (externalSignal) {
                if (externalSignal.aborted) ctrl.abort();
                else {
                    externalAbort = () => ctrl.abort();
                    externalSignal.addEventListener('abort', externalAbort, { once: true });
                }
            }
            const r = await fetch(u, { credentials: 'same-origin', signal: ctrl.signal });
            if (!r.ok) throw new Error('HTTP ' + r.status);
            const text = await r.text();
            if (!text || (text.trim()[0] !== '{' && text.trim()[0] !== '[')) throw new Error('非JSON响应');
            return JSON.parse(text);
        } catch(e) {
            if (e.name === 'AbortError') dbg(externalSignal && externalSignal.aborted ? 'fetch 已取消:' : 'fetch 超时:', u);
            else console.error('[LIS] fetch error:', e);
            throw e;
        } finally {
            clearTimeout(timer);
            if (externalSignal && externalAbort) externalSignal.removeEventListener('abort', externalAbort);
        }
    }

    async function fetchJRetry(u, timeoutMs, externalSignal, tries, gapMs) {
        const maxTries = Math.max(1, tries || 1);
        for (let i = 1; i <= maxTries; i += 1) {
            try {
                return await fetchJ(u, timeoutMs, externalSignal);
            } catch(e) {
                if (e.name === 'AbortError' || i >= maxTries) throw e;
                await new Promise(r => setTimeout(r, gapMs || 250));
            }
        }
        return null;
    }

    // 高亮搜索文本（自动转义防 XSS，缓存正则）
    let _hlQuery = '', _hlRegex = null;
    function highlightText(text, query) {
        if (!query || !text) return esc(text || '');
        const safe = esc(text);
        if (query !== _hlQuery) {
            _hlQuery = query;
            _hlRegex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
        }
        return safe.replace(_hlRegex, '<span class="lis-highlight">$1</span>');
    }

    // ==================== 样式 ====================
    GM_addStyle(`
/* --- 浮动按钮 --- */
#lis-fab{position:fixed;bottom:80px;right:20px;z-index:99999;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;cursor:pointer;font-size:26px;box-shadow:0 4px 18px rgba(102,126,234,.55);transition:transform .3s,box-shadow .3s;display:flex;align-items:center;justify-content:center;user-select:none}
#lis-fab:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(102,126,234,.6)}
#lis-fab:active{cursor:grabbing}
#lis-fab-tip{position:fixed;bottom:84px;right:20px;z-index:99998;background:rgba(0,0,0,.8);color:#fff;padding:6px 12px;border-radius:6px;font-size:11px;pointer-events:none;opacity:0;transition:.3s;white-space:pre-line}
#lis-fab-tip.show{opacity:1}

/* --- 病人结果筛选导出 --- */
#lis-pr-fab{position:fixed;right:20px;bottom:152px;z-index:99999;width:52px;height:52px;border-radius:50%;border:none;background:linear-gradient(145deg,#168276,#0f6b62);color:#fff;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 4px 16px rgba(22,130,118,.35);display:flex;align-items:center;justify-content:center;user-select:none;transition:transform .2s,box-shadow .2s}
#lis-pr-fab:hover{transform:scale(1.06);box-shadow:0 6px 20px rgba(22,130,118,.45)}
#lis-pr-panel{position:fixed!important;inset:0!important;z-index:100006!important;background:#e8edf2;display:none;flex-direction:column;font-family:'Microsoft YaHei','Segoe UI',sans-serif;color:#1f2933}
#lis-pr-panel.show{display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important}
#lis-pr-hd{min-height:48px;display:flex;align-items:center;gap:10px;padding:0 16px;background:linear-gradient(90deg,#fff 0%,#f4faf8 100%);border-bottom:1px solid #d7e3de;flex-shrink:0;box-shadow:0 1px 0 rgba(22,130,118,.06)}
#lis-pr-hd .pr-hd-main{display:flex;flex-direction:column;gap:1px;min-width:0}
#lis-pr-hd h3{margin:0;font-size:15px;color:#14504a;font-weight:800;letter-spacing:.02em}
#lis-pr-hd .pr-hd-sub{font-size:11px;color:#6b7c78;font-weight:500}
#lis-pr-hd .pr-spacer{flex:1}
#lis-pr-hd button{height:30px;min-width:30px;border:1px solid #c5d6d0;background:#fff;color:#4a5f5a;border-radius:8px;padding:0 10px;font-size:13px;font-weight:700;cursor:pointer;transition:background .15s,border-color .15s,color .15s}
#lis-pr-hd button:hover{background:#f0f7f4;border-color:#168276;color:#0f6f65}
#lis-pr-hd .pr-close{font-size:18px;line-height:1;padding:0 10px;color:#8a9a94}
#lis-pr-filter-scroll{flex:0 0 auto;overflow:visible;padding:12px 14px 6px;background:#e8edf2}
#lis-pr-tools{display:flex;flex-direction:column;gap:10px}
.pr-card{background:#fff;border:1px solid #dce6e2;border-radius:10px;box-shadow:0 1px 3px rgba(31,45,55,.05);overflow:hidden}
.pr-card-hd{display:flex;align-items:center;gap:8px;padding:8px 12px;background:linear-gradient(180deg,#f8fbfa,#f2f7f5);border-bottom:1px solid #e8efec;font-size:12px;font-weight:800;color:#2a4a44;letter-spacing:.03em}
.pr-card-ico{font-size:14px;line-height:1;opacity:.9}
.pr-card-bd{padding:10px 12px 12px}
.pr-row{display:flex;flex-wrap:wrap;align-items:flex-end;gap:8px 10px}
.pr-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(108px,1fr));gap:8px 10px;align-items:end}
.pr-grid-wide{grid-column:1/-1}
#lis-pr-tools label,#lis-pr-filter-scroll label{display:flex;flex-direction:column;gap:4px;font-size:11px;color:#5a6b66;font-weight:700;line-height:1.1}
#lis-pr-tools input,#lis-pr-tools select,#lis-pr-filter-scroll input,#lis-pr-filter-scroll select{width:100%;height:32px;box-sizing:border-box;border:1px solid #cdd8d4;border-radius:8px;padding:0 10px;font-size:12px;color:#1f2933;background:#fafcfb;outline:none;transition:border-color .15s,box-shadow .15s,background .15s}
#lis-pr-tools input:focus,#lis-pr-tools select:focus,#lis-pr-filter-scroll input:focus,#lis-pr-filter-scroll select:focus{border-color:#168276;background:#fff;box-shadow:0 0 0 3px rgba(22,130,118,.1)}
#lis-pr-tools .pr-date,#lis-pr-filter-scroll .pr-date{min-width:128px;flex:0 0 128px}
#lis-pr-tools .pr-date input{cursor:pointer}
#lis-pr-tools .pr-date-shortcuts{display:flex;align-items:flex-end;gap:6px;flex-wrap:wrap}
#lis-pr-tools .pr-date-shortcuts button{height:32px;min-width:58px;padding:0 12px;border:1px solid #c5d6d0;border-radius:8px;background:#fff;color:#3d524c;font-size:11px;font-weight:700;cursor:pointer;transition:background .15s,border-color .15s}
#lis-pr-tools .pr-date-shortcuts button:hover{background:#eef7f3;border-color:#168276;color:#0f6f65}
.pr-mach-section{margin-top:10px}
.pr-mach-label{font-size:11px;font-weight:800;color:#5a6b66;margin-bottom:6px}
.pr-mach-hint{font-size:10px;color:#8a9a94;margin-top:6px;line-height:1.4}
#lis-pr-machine-tree{display:flex;flex-direction:column;gap:8px;padding:0;background:transparent;border:none;overflow:visible}
.pr-wg-block{border:1px solid #d0ddd8;border-radius:8px;background:#f6faf8;padding:8px 10px 10px}
.pr-wg-block[data-wg="1"]{border-top:3px solid #e74c3c}
.pr-wg-block[data-wg="3"]{border-top:3px solid #3498db}
.pr-wg-block[data-wg="4"]{border-top:3px solid #2ecc71}
.pr-wg-title{display:flex!important;flex-direction:row!important;align-items:center;gap:8px;margin:0 0 8px;font-size:12px;font-weight:800;color:#2a4a44;line-height:1.3;cursor:pointer;user-select:none}
.pr-wg-title input{width:15px!important;height:15px!important;margin:0;flex-shrink:0;accent-color:#168276}
.pr-wg-mach-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px 8px}
.pr-mach-option{display:flex!important;flex-direction:row!important;align-items:flex-start;gap:7px;margin:0;padding:7px 9px;font-size:12px!important;font-weight:600!important;color:#2c3e46!important;line-height:1.4!important;background:#fff;border:1px solid #dde5e1;border-radius:7px;cursor:pointer;white-space:normal!important;word-break:break-word;overflow:visible!important;max-width:none!important;text-overflow:unset!important;transition:border-color .12s,background .12s}
.pr-mach-option:hover{border-color:#168276;background:#f0f7f4}
.pr-mach-option:has(input:checked){border-color:#168276;background:#e8f5f1;box-shadow:inset 0 0 0 1px rgba(22,130,118,.15)}
.pr-mach-option input{width:15px!important;height:15px!important;margin:2px 0 0;flex-shrink:0;accent-color:#168276}
#lis-pr-tools .pr-toggle{grid-column:span 2;height:32px;flex-direction:row!important;align-items:center;justify-content:flex-start;gap:8px;border:1px solid #cdd8d4;border-radius:8px;background:#fafcfb;padding:0 10px;cursor:pointer;align-self:end}
#lis-pr-tools .pr-toggle:hover{border-color:#168276;background:#f0f7f4}
#lis-pr-tools .pr-toggle input{width:15px;height:15px;margin:0;accent-color:#168276}
#lis-pr-actions{display:flex;align-items:center;gap:8px;padding:10px 14px;background:#fff;border-top:1px solid #dce6e2;border-bottom:1px solid #dce6e2;flex-shrink:0;box-shadow:0 -2px 8px rgba(0,0,0,.04)}
#lis-pr-actions button{height:34px;border-radius:8px;padding:0 16px;font-size:12px;font-weight:800;cursor:pointer;border:1px solid transparent;transition:background .15s,border-color .15s,transform .1s}
#lis-pr-actions button:active{transform:scale(.98)}
#lis-pr-query{background:linear-gradient(180deg,#1a9a8c,#168276);color:#fff;border-color:#127a6e;min-width:88px;box-shadow:0 2px 6px rgba(22,130,118,.25)}
#lis-pr-query:hover{background:linear-gradient(180deg,#1eb3a3,#1a9588)}
#lis-pr-export{background:#fff;color:#2a5a52;border-color:#b8ccc6}
#lis-pr-export:hover{background:#f0f7f4;border-color:#168276}
#lis-pr-clear{background:transparent;color:#6b7c78;border-color:#d0ddd8}
#lis-pr-clear:hover{background:#f5f7f6;color:#334155}
#lis-pr-cancel{background:#fff3e0;color:#c2410c;border-color:#fdba74}
#lis-pr-actions .pr-act-spacer{flex:1}
#lis-pr-actions .pr-act-hint{font-size:10px;color:#8a9a94;max-width:200px;line-height:1.35}
#lis-pr-date-picker{position:fixed;z-index:100020;width:252px;background:#fff;border:1px solid #b9cbd9;border-radius:6px;box-shadow:0 8px 24px rgba(31,45,61,.18);padding:8px;font-family:'Microsoft YaHei','Segoe UI',sans-serif}
#lis-pr-date-picker .pr-dp-head{display:flex;gap:6px;margin-bottom:8px;align-items:center}
#lis-pr-date-picker select{height:26px;border:1px solid #c3ced8;border-radius:4px;background:#fff;color:#213547;font-size:12px;padding:0 4px;flex:1}
#lis-pr-date-picker .pr-dp-today{height:26px;border:1px solid #9dc6df;border-radius:4px;background:#f7fbff;color:#246489;font-size:12px;font-weight:700;padding:0 8px;cursor:pointer}
#lis-pr-date-picker .pr-dp-week,#lis-pr-date-picker .pr-dp-days{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
#lis-pr-date-picker .pr-dp-week span{font-size:10px;color:#7b8b96;text-align:center;padding:2px 0}
#lis-pr-date-picker .pr-dp-days button{height:26px;border:1px solid transparent;border-radius:4px;background:#fff;color:#213547;font-size:12px;padding:0;cursor:pointer}
#lis-pr-date-picker .pr-dp-days button.blank{visibility:hidden;pointer-events:none}
#lis-pr-date-picker .pr-dp-days button:hover{background:#edf7ff;border-color:#9dc6df}
#lis-pr-date-picker .pr-dp-days button.on{background:#145b86;border-color:#145b86;color:#fff;font-weight:700}
#lis-pr-status{padding:6px 14px;font-size:11px;color:#5a6b66;background:#fafcfb;flex-shrink:0;border-bottom:1px solid #e8efec}
#lis-pr-status.ok{color:#0f6f65;background:#eef7f3}
#lis-pr-status.error{color:#c62828;background:#fff5f5}
#lis-pr-status.info{color:#1565c0;background:#f3f8ff}
#lis-pr-body{flex:1;min-height:0;overflow-y:auto;overflow-x:auto;background:#f7f9fb;padding:8px;position:relative;z-index:1}
#lis-pr-body table{width:100%;border-collapse:separate;border-spacing:0;background:#fff;border:1px solid #dce3eb;border-radius:6px;overflow:hidden;font-size:12px}
#lis-pr-body th{position:sticky;top:0;background:#edf2f7;color:#334155;padding:7px 8px;text-align:left;border-bottom:1px solid #d7dee8;white-space:nowrap;z-index:1}
#lis-pr-body td{padding:6px 8px;border-bottom:1px solid #edf1f5;white-space:nowrap;vertical-align:middle}
#lis-pr-body tr:nth-child(even){background:#fbfcfd}
#lis-pr-body tr:hover{background:#eef7f5}
#lis-pr-body .pr-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#7b8b96;font-size:13px;text-align:center;line-height:1.7}
#lis-pr-body .pr-abn{color:#c62828;font-weight:700}
#lis-pr-body .pr-low{color:#1565c0;font-weight:700}
#lis-pr-body .pr-high{color:#e65100;font-weight:700}
#lis-pr-body .pr-critical{color:#b71c1c;font-weight:800}
/* --- 顶部快速切换条 --- */
#lis-qbar{position:fixed;top:4px;left:50%;transform:translateX(-50%) translateY(-120%);z-index:99998;background:rgba(44,62,80,.92);backdrop-filter:blur(8px);padding:3px 10px;display:flex;align-items:center;gap:5px;transition:.3s;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.25);opacity:0}
#lis-qbar.show{transform:translateX(-50%) translateY(0);opacity:1}
#lis-qbar button.qb{padding:2px 8px;border-radius:3px;border:none;cursor:pointer;font-size:11px;font-weight:600;color:#fff;transition:.15s;line-height:1.4}
#lis-qbar button.qb:hover{filter:brightness(1.2)}
#lis-qbar button.qb.on{box-shadow:0 0 0 1.5px #fff}
#lis-qbar .qb-info{color:#f1c40f;font-size:10px;margin-left:4px;white-space:nowrap}
#lis-qbar .qb-x{color:#bdc3c7;cursor:pointer;font-size:12px;padding:1px 4px;border-radius:3px;margin-left:4px;opacity:.6}
#lis-qbar .qb-x:hover{opacity:1;background:rgba(255,255,255,.1)}

/* --- 全屏工作台 --- */
#lis-ws{position:fixed!important;inset:0!important;z-index:100000!important;background:#eef2f6;display:none;color:#1f2933;font-family:'Microsoft YaHei','Segoe UI',sans-serif}
#lis-ws.show{display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important}
#lis-ws-hd{background:#fff;padding:8px 14px;display:flex;align-items:center;gap:12px;flex-shrink:0!important;border-bottom:1px solid #d7dee8;box-shadow:0 1px 0 rgba(31,41,51,.04)}
#lis-ws-hd .ws-title{display:flex;align-items:center;gap:8px;min-width:128px}
#lis-ws-hd .ws-title-dot{width:9px;height:24px;border-radius:2px;background:#168276;display:inline-block}
#lis-ws-hd h3{margin:0;font-size:15px;line-height:1;color:#17212b;font-weight:700;white-space:nowrap;letter-spacing:0}
#lis-ws-hd .ws-search-wrap{position:relative;flex:0 1 360px;min-width:220px}
#lis-ws-hd .ws-search-wrap::before{content:'⌕';position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#6b7785;font-size:14px}
#lis-ws-hd .ws-search{width:100%;box-sizing:border-box;padding:7px 10px 7px 30px;border:1px solid #cbd5df;border-radius:6px;font-size:12px;outline:none;background:#f9fbfd;color:#1f2933;transition:border-color .15s,background .15s}
#lis-ws-hd .ws-search:focus{background:#fff;border-color:#168276;box-shadow:0 0 0 2px rgba(22,130,118,.12)}
#lis-ws-hd .ws-acts{display:flex;gap:6px;margin-left:auto;align-items:center}
#lis-ws-hd .ws-icon-btn{width:30px;height:30px;border:1px solid #cbd5df;border-radius:6px;background:#fff;color:#354657;cursor:pointer;font-size:14px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,border-color .15s,color .15s}
#lis-ws-hd .ws-icon-btn:hover{background:#f2f6f8;border-color:#168276;color:#0f6f65}
#lis-ws-hd .ws-icon-btn.danger:hover{border-color:#c62828;color:#c62828;background:#fff5f5}
@keyframes lis-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
#lis-ws-hd .ws-icon-btn.spinning{animation:lis-spin .8s linear infinite;pointer-events:none;opacity:.6}

/* --- 数据表 --- */
#lis-ws-body{flex:1!important;overflow:auto!important;background:#f7f9fb;font-family:'Microsoft YaHei','Segoe UI',sans-serif;min-height:0!important;position:relative;z-index:1;padding:0 10px 10px}
#lis-ws-body table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;background:#fff;border:1px solid #dce3eb;border-radius:6px;overflow:hidden}
#lis-ws-body thead{position:sticky;top:0;z-index:2}
#lis-ws-body th{background:#edf2f7;color:#334155;padding:7px 9px;text-align:left;font-weight:700;white-space:nowrap;cursor:pointer;user-select:none;border-bottom:1px solid #d7dee8;transition:background .15s}
#lis-ws-body th:hover{background:#e3ebf3}
#lis-ws-body th::after{content:' ⇅';font-size:10px;opacity:.42}
#lis-ws-body th.sort-asc::after{content:' ↑';opacity:1}
#lis-ws-body th.sort-desc::after{content:' ↓';opacity:1}
#lis-ws-body td{padding:6px 9px;border-bottom:1px solid #edf1f5;white-space:nowrap;transition:background .12s;vertical-align:middle}
#lis-ws-body tr{cursor:pointer;transition:background .12s}
#lis-ws-body tbody tr:nth-child(even){background:#fbfcfd}
#lis-ws-body tbody tr:nth-child(odd){background:#fff}
#lis-ws-body tbody tr:last-child td{border-bottom:none}
#lis-ws-body tr:hover{background:#eef7f5}
#lis-ws-body tr.sel{background:#e6f4ef;box-shadow:inset 3px 0 0 #168276}
#lis-ws-body tr.active-row{background:#e8f1fb;box-shadow:inset 3px 0 0 #2f6fb3}
#lis-ws-body tr.st-1{box-shadow:inset 3px 0 0 #d89000}
#lis-ws-body tr.st-2{box-shadow:inset 3px 0 0 #2f6fb3}
#lis-ws-body tr.st-3{box-shadow:inset 3px 0 0 #168276}
#lis-ws-body tr.st-4{box-shadow:inset 3px 0 0 #8a5db7}
#lis-ws-body tr.st-5{color:#8a97a6;box-shadow:inset 3px 0 0 #9aa5b1}
.wg-tag{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.2)}
.st-tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.st-1t{background:#fff3e0;color:#e65100}.st-2t{background:#e3f2fd;color:#1565c0}.st-3t{background:#e8f5e9;color:#2e7d32}.st-4t{background:#f3e5f5;color:#7b1fa2}.st-5t{background:#eeeeee;color:#9e9e9e}
.st-0t{background:#e0f7fa;color:#00695c}
.stars{color:#f39c12;font-size:12px}
.lis-highlight{background:#fff176;border-radius:2px;padding:0 2px}

/* --- 底部 --- */
#lis-ws-ft{background:#fff;padding:5px 14px;display:flex;align-items:center;justify-content:space-between;font-size:11px;color:#6b7785;flex-shrink:0!important;border-top:1px solid #d7dee8}

/* --- 仪器标签栏 --- */
#lis-ws-tabs{background:#fff;padding:7px 14px 6px;display:flex;flex-direction:column;gap:6px;flex-shrink:0!important;overflow-x:auto;scrollbar-width:none;position:relative;z-index:3;border-bottom:1px solid #d7dee8}
#lis-ws-tabs::-webkit-scrollbar{display:none}
.ws-wg-row,.ws-mach-row{display:flex;align-items:center;gap:6px;overflow-x:auto;scrollbar-width:none}
.ws-wg-row{padding-bottom:6px;border-bottom:1px solid #edf1f5}
.ws-mach-row::-webkit-scrollbar{display:none}
.ws-wg-tab,.ws-mach-tab{border:1px solid #d7dee8;background:#fff;color:#334155;cursor:pointer;transition:background .15s,border-color .15s,color .15s;white-space:nowrap;display:flex;align-items:center;gap:6px;letter-spacing:0}
.ws-wg-tab{padding:5px 10px;border-radius:6px;font-size:12px;font-weight:700}
.ws-wg-tab:hover,.ws-mach-tab:hover{background:#f2f8f7;border-color:#7ebbb3}
.ws-wg-tab.on{background:#168276;border-color:#168276;color:#fff}
.ws-mach-tab{padding:4px 9px;border-radius:5px;font-size:11px;font-weight:600}
.ws-mach-tab.on{background:#34495e;border-color:#34495e;color:#fff}
.ws-tab-name{overflow:hidden;text-overflow:ellipsis;max-width:150px}
.mach-cnt{background:#eef2f6;color:#475569;border-radius:10px;padding:0 6px;font-size:10px;min-width:16px;text-align:center;line-height:1.55;font-weight:700}
.ws-wg-tab.on .mach-cnt,.ws-mach-tab.on .mach-cnt{background:rgba(255,255,255,.22);color:#fff}
.ws-tab-stat{display:inline-flex;align-items:center;color:#6b7785;font-size:10px;font-weight:700}
.ws-wg-tab.on .ws-tab-stat{color:rgba(255,255,255,.82)}

/* --- 分类标签栏 --- */
#lis-ws-bar{background:#f7f9fb;padding:7px 14px;display:flex;align-items:center;gap:6px;border-bottom:1px solid #d7dee8;flex-shrink:0!important;font-size:12px;flex-wrap:wrap;position:relative;z-index:3}
.cat-tab{padding:5px 10px;border-radius:6px;border:1px solid #d7dee8;background:#fff;cursor:pointer;font-size:11px;font-weight:700;transition:background .15s,border-color .15s,color .15s;white-space:nowrap;display:flex;align-items:center;gap:6px;color:#334155}
.cat-tab:hover{border-color:#7ebbb3;background:#f2f8f7}
.cat-tab.on{border-color:#168276;background:#168276;color:#fff}
.cat-tab .cat-cnt{border-radius:10px;padding:0 7px;font-size:10px;min-width:16px;text-align:center;line-height:1.6;font-weight:800}
.cat-tab.on .cat-cnt{background:rgba(255,255,255,.22);color:#fff}
.cat-tab:not(.on) .cat-cnt{background:#eef2f6;color:#475569}
.cat-tab.cat-normal:not(.on) .cat-cnt{background:#e6f4ef;color:#0f6f65}
.cat-tab.cat-abnormal:not(.on) .cat-cnt{background:#fde8e8;color:#b91c1c}
.cat-tab.cat-incomplete:not(.on) .cat-cnt{background:#fff2d7;color:#9a5b00}
.cat-tab.cat-pending:not(.on) .cat-cnt{background:#e7f0fb;color:#235a96}
.cat-sep{width:1px;height:24px;background:#dee2e6;margin:0 4px}
.cat-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.cat-stats{color:#6b7785;font-size:11px}

/* --- 一键批审横幅 --- */
.ws-normal-banner{background:#fff;border:1px solid #cfe3df;border-left:4px solid #168276;border-radius:6px;padding:8px 12px;margin:10px 0;display:flex;align-items:center;gap:12px;flex-shrink:0}
.ws-normal-banner .nb-text{font-size:13px;font-weight:700;color:#0f6f65;flex:1}
.ws-normal-banner .nb-btn,.nb-btn{padding:7px 14px;border:none;border-radius:6px;background:#168276;color:#fff;font-size:12px;font-weight:800;cursor:pointer;transition:background .15s;white-space:nowrap;box-shadow:none}
.ws-normal-banner .nb-btn:hover,.nb-btn:hover{background:#0f6f65}
.ws-normal-banner .nb-btn:active,.nb-btn:active{filter:brightness(.95)}

/* --- 异常标本卡片 --- */
.ws-abnormal-list{padding:10px 0;display:flex;flex-direction:column;gap:5px;overflow-y:auto;flex:1}
.ws-abnormal-card{background:#fff;border:1px solid #dce3eb;border-left:4px solid #d14b4b;border-radius:6px;padding:7px 10px;cursor:pointer;transition:background .12s,border-color .12s;display:flex;align-items:center;gap:10px}
.ws-abnormal-card:hover{background:#fffafa;border-color:#e4b3b3}
.ws-abnormal-card.focused{border-left-color:#2f6fb3;background:#eef6ff;box-shadow:0 0 0 1px rgba(47,111,179,.12)}
.ws-abnormal-card.auditing{border-left-color:#168276;background:#eef7f5;box-shadow:0 0 0 1px rgba(22,130,118,.14)}
.ws-abnormal-card.has-critical{border-left-color:#b91c1c;background:#fff7f7}
.ws-abnormal-card.has-critical.focused{border-left-color:#b91c1c;background:#ffeded;box-shadow:0 0 0 1px rgba(185,28,28,.14)}
.ws-abnormal-card.has-infection-warning{border-left-color:#d97706;background:#fffbeb}
.ws-abnormal-card.has-infection-warning.focused{border-left-color:#d97706;background:#fef3c7;box-shadow:0 0 0 1px rgba(217,119,6,.14)}
.ab-card-top{display:flex;align-items:center;gap:8px;min-width:0;flex:1}
.ab-card-name{font-size:14px;font-weight:600;color:#2c3e50;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px}
.ab-card-no{font-size:12px;color:#888;white-space:nowrap}
.ab-card-test{font-size:12px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px}
.ab-card-items{display:flex;flex-wrap:nowrap;gap:5px;overflow:hidden;flex:1}
.ab-card-item{padding:2px 8px;border-radius:3px;font-size:11px;font-weight:600;white-space:nowrap}
.ab-card-item.critical{background:#ffebee;color:#c62828}
.ab-card-item.high{background:#fff3e0;color:#e65100}
.ab-card-item.low{background:#e3f2fd;color:#1565c0}
.ab-card-item.abnormal{background:#fce4ec;color:#e91e63}
.ab-card-item.infection-warning{background:#fff3e0;color:#e65100;font-weight:700}
.ab-card-item.uncertain{background:#f5f5f5;color:#757575}
.ab-card-hint{font-size:11px;color:#bbb;white-space:nowrap;margin-left:auto}
.ws-abnormal-machine{position:sticky;top:0;z-index:2;background:#f1f5f9;border:1px solid #d7dee8;border-radius:5px;padding:4px 10px;margin:8px 0 2px;font-size:11px;font-weight:600;color:#475569;letter-spacing:.02em}
.ws-abnormal-hint{background:#fff;border:1px solid #d7dee8;border-left:4px solid #2f6fb3;border-radius:6px;padding:7px 10px;margin:10px 0 0;font-size:12px;color:#334155;display:flex;align-items:center;gap:6px}
.ws-abnormal-hint kbd{background:#f7f9fb;border:1px solid #cbd5df;border-radius:3px;padding:1px 5px;font-size:11px;font-family:monospace}

/* --- 不完整提示 --- */
.ws-incomplete-banner{background:#fff;border:1px solid #f1d3a2;border-left:4px solid #d89000;border-radius:6px;padding:8px 12px;margin:10px 0;font-size:13px;color:#8a5600;font-weight:700}

/* --- 分类加载中 --- */
.ws-category-loading{text-align:center;padding:40px;color:#999;font-size:14px}
.ws-category-loading .cat-prog{font-size:12px;color:#bbb;margin-top:8px}

/* --- 确保内容可滚动 --- */
#lis-ws-body::-webkit-scrollbar{width:9px;height:9px}
#lis-ws-body::-webkit-scrollbar-track{background:#edf1f5}
#lis-ws-body::-webkit-scrollbar-thumb{background:#b4c0cc;border-radius:5px}
#lis-ws-body::-webkit-scrollbar-thumb:hover{background:#8f9aa7}
#lis-ws-body table{min-height:0}

/* --- 批审面板 --- */
#lis-batch{position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:100001;background:#fff;border-radius:10px 10px 0 0;box-shadow:0 -4px 20px rgba(0,0,0,.2);padding:14px 20px;display:none;width:480px}
#lis-batch.show{display:block}
#lis-batch h4{margin:0 0 8px;font-size:14px;color:#2c3e50}
#lis-batch .bf{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
#lis-batch .bf label{font-size:12px;color:#555}
#lis-batch .bf input{padding:4px 8px;border:1px solid #ddd;border-radius:3px;font-size:12px}
#lis-batch .bf button{padding:5px 14px;border:none;border-radius:4px;cursor:pointer;font-size:12px;font-weight:600}

/* --- 密码弹窗 --- */
#lis-pwdo{position:fixed;inset:0;z-index:100002;background:rgba(0,0,0,.5);display:none;align-items:center;justify-content:center}
#lis-pwdo.show{display:flex}
#lis-pwdp{background:#fff;border-radius:10px;padding:24px 30px;width:380px;box-shadow:0 10px 40px rgba(0,0,0,.3)}
#lis-pwdp h4{margin:0 0 16px;color:#2c3e50;font-size:16px}
#lis-pwdp input{width:100%;padding:8px 10px;border:1px solid #ddd;border-radius:4px;font-size:14px;margin-bottom:10px;box-sizing:border-box}
#lis-pwdp .pa{display:flex;gap:10px;justify-content:flex-end;margin-top:8px}
#lis-pwdp button{padding:8px 18px;border:none;border-radius:4px;cursor:pointer;font-size:13px;font-weight:600}
#lis-pwdp .b-save{background:#2ecc71;color:#fff}
#lis-pwdp .b-clr{background:#e74c3c;color:#fff}
#lis-pwdp .b-can{background:#95a5a6;color:#fff}
#lis-pwdp .tip{font-size:11px;color:#95a5a6;margin-top:12px;line-height:1.5}
#lis-pwdp .sts{font-size:12px;margin-top:6px}

/* --- 病人结果分页控件 --- */
#lis-pr-pagination{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:8px;padding:10px 12px;background:#fff;border-top:2px solid #d7dee8;font-size:12px;color:#334155;box-shadow:0 -4px 12px rgba(0,0,0,.1);margin-top:8px}
#lis-pr-pagination button{height:28px;border:1px solid #cbd5df;background:#fff;color:#246489;border-radius:5px;padding:0 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
#lis-pr-pagination button:hover:not(:disabled){background:#f5fbff;border-color:#4f9cca}
#lis-pr-pagination button:disabled{opacity:.4;cursor:not-allowed}
#lis-pr-pagination .pr-pg-info{color:#6b7785;white-space:nowrap}
#lis-pr-pagination .pr-pg-jump{display:flex;align-items:center;gap:4px}
#lis-pr-pagination .pr-pg-jump input{width:52px;height:26px;border:1px solid #cbd5df;border-radius:4px;padding:0 6px;font-size:12px;text-align:center}
#lis-pr-pagination .pr-pg-total{margin-left:auto;color:#6b7785;white-space:nowrap}

/* --- Toast --- */
.lis-t{position:fixed;top:50px;right:20px;z-index:100003;padding:10px 18px;border-radius:6px;font-size:13px;color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:lis-si .3s ease;pointer-events:none}
.lis-t.e{background:#e74c3c}.lis-t.w{background:#f39c12}.lis-t.s{background:#2ecc71}
@keyframes lis-si{from{transform:translateX(100%);opacity:0}}

/* --- 空状态 --- */
.ws-empty{text-align:center;padding:60px;color:#95a5a6;font-size:15px}
.ws-empty .ico{font-size:48px;margin-bottom:12px}

/* --- 加载 --- */
.ws-spin{display:inline-block;width:18px;height:18px;border:2px solid #ddd;border-top:2px solid #3498db;border-radius:50%;animation:lis-sp .7s linear infinite;vertical-align:middle;margin-right:4px}
@keyframes lis-sp{to{transform:rotate(360deg)}}

/* --- 质控录入辅助 --- */
#lis-qc-panel{position:fixed;top:34px;left:60px;width:560px;height:520px;min-width:360px;min-height:340px;z-index:100004;background:#fff;border:1px solid #b9d5ea;border-radius:6px;box-shadow:0 4px 16px rgba(59,116,153,.18);display:flex;flex-direction:column;overflow:hidden;font-family:'Microsoft YaHei','Segoe UI',sans-serif;color:#213547;box-sizing:border-box;resize:none}
#lis-qc-panel.collapsed{height:34px;bottom:auto;width:240px;min-width:240px;min-height:34px}
#lis-qc-panel.collapsed #lis-qc-body,#lis-qc-panel.collapsed .lis-qc-meta,#lis-qc-panel.collapsed #lis-qc-tools{display:none}
#lis-qc-head{height:34px;flex-shrink:0;display:flex;align-items:center;gap:6px;padding:0 8px;background:linear-gradient(180deg,#eaf6fd,#d7edf9);border-bottom:1px solid #b9d5ea;box-sizing:border-box;cursor:move;user-select:none;overflow:hidden;touch-action:none}
#lis-qc-title{font-size:13px;font-weight:700;color:#145b86;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;flex:1 1 auto;min-width:0}
.lis-qc-meta{font-size:11px;color:#5f7484;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:150px;flex:0 1 auto}
#lis-qc-head .lis-qc-actions{display:flex;align-items:center;gap:4px;flex:0 0 auto}
#lis-qc-head button,#lis-qc-tools button{border:1px solid #9dc6df;background:#fff;color:#246489;border-radius:4px;height:24px;min-width:26px;padding:0 8px;font-size:12px;line-height:22px;cursor:pointer}
#lis-qc-head button:hover,#lis-qc-tools button:hover{background:#f3fbff;border-color:#4f9cca}
#lis-qc-close{font-size:16px;line-height:20px;padding:0 6px;color:#8aa}
#lis-qc-body{display:flex;flex-direction:column;min-height:0;flex:1;background:#f8fcff}
#lis-qc-tools{height:30px;flex-shrink:0;display:flex;align-items:center;gap:6px;padding:4px 8px;border-bottom:1px solid #d8eaf5;box-sizing:border-box;background:#fff}
#lis-qc-tools .lis-qc-tip{font-size:12px;color:#7a8c99;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1}
#lis-qc-frame-wrap{display:none;height:26%;min-height:110px;border-bottom:1px solid #d8eaf5;background:#fff;position:relative}
#lis-qc-frame{width:100%;height:100%;border:0;background:#fff}
#lis-qc-local{flex:1;min-height:0;background:#fff;position:relative;overflow-y:auto;display:flex;flex-direction:column}
#lis-qc-local .qc-chart-wrap{flex:1;display:flex;flex-direction:column;min-height:0}
#lis-qc-local svg{width:100%;flex:1;min-height:0}
#lis-qc-empty{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;text-align:center;color:#7b8b96;font-size:13px;line-height:1.6;padding:20px;box-sizing:border-box;background:#f8fcff}
#lis-qc-resize{position:absolute;right:2px;bottom:2px;width:16px;height:16px;cursor:se-resize;z-index:2;background:linear-gradient(135deg,transparent 50%,#7ea7c7 50%);clip-path:polygon(100% 0,100% 100%,0 100%);touch-action:none}
#lis-qc-panel.show-native #lis-qc-frame-wrap{display:block}
#lis-qc-panel.show-native #lis-qc-local{min-height:120px}
#lis-qc-panel.show-native #lis-qc-local{height:auto}
#lis-qc-panel.qc-interacting #lis-qc-frame{pointer-events:none}
#lis-qc-panel .qc-axis{stroke:#93a7b5;stroke-width:0.8}
#lis-qc-panel .qc-grid{stroke:#d8e5ee;stroke-width:0.8}
#lis-qc-panel .qc-line{stroke:#168276;stroke-width:1.6;fill:none}
#lis-qc-panel .qc-dot{fill:#168276;stroke:#fff;stroke-width:1.2}
#lis-qc-panel .qc-dot.above{fill:#e67e22}
#lis-qc-panel .qc-dot.below{fill:#2980b9}
#lis-qc-panel .qc-dot.eq{fill:#95a5a6}
#lis-qc-panel .qc-dot.warn{fill:#c0392b}
#lis-qc-panel .qc-dot.loss{fill:#7d1049}
.qc-chart-wrap{padding:0 0 4px}
.qc-chart-title{font-size:10px;color:#5a7a8a;font-weight:600;padding:2px 0 0 4px;background:#f8fcff}
#lis-qc-panel .qc-label{fill:#536b7a;font-size:8px}
#lis-qc-panel .qc-sd{fill:#6d8190;font-size:8px;font-weight:600}
#lis-qc-panel .qc-info{fill:#2c6e8a;font-size:9px;font-weight:700}
#lis-qc-panel .qc-xbar{stroke:#168276;stroke-width:0.8;stroke-dasharray:3 2}
#lis-qc-panel .qc-sd1{stroke:#9fd2c3;stroke-width:0.6;stroke-dasharray:3 3}
#lis-qc-panel .qc-sd2{stroke:#f2c66d;stroke-width:0.6;stroke-dasharray:3 3}
#lis-qc-panel .qc-sd3{stroke:#df8a8a;stroke-width:0.6;stroke-dasharray:3 3}
#lis-qc-panel.dragging{opacity:.96}
.qc-tip{display:none;position:fixed;top:0;left:0;pointer-events:none;z-index:999999;background:rgba(30,50,70,.92);border-radius:4px;padding:3px 8px;font-size:11px;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,.18);will-change:transform}
.qc-tip-date{color:#7ec8e3;font-weight:700}
.qc-tip-val{color:#f0e68c}
#lis-qc-fab{position:fixed;right:20px;bottom:20px;z-index:100004;width:36px;height:36px;border-radius:50%;background:linear-gradient(135deg,#2980b9,#1a6ea0);color:#fff;font-size:11px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center;box-shadow:0 2px 10px rgba(0,0,0,.25);transition:transform .15s}
#lis-qc-fab:hover{transform:scale(1.15);background:linear-gradient(135deg,#3498db,#2471a3)}


    
/* --- 登录页优化 --- */
#lis-login-box{position:fixed;top:50%;right:40px;transform:translateY(-50%);z-index:99999;background:rgba(255,255,255,.97);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.15);padding:20px 24px;width:300px;font-family:'Microsoft YaHei',sans-serif}
#lis-login-box h4{margin:0 0 14px;font-size:15px;color:#2c3e50;text-align:center}
#lis-login-box .lis-lb-row{margin-bottom:10px}
#lis-login-box .lis-lb-row label{display:block;font-size:12px;color:#666;margin-bottom:3px}
#lis-login-box .lis-lb-row input{width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box}
#lis-login-box .lis-lb-row input:focus{border-color:#3498db;outline:none;box-shadow:0 0 0 2px rgba(52,152,219,.15)}
#lis-login-box .lis-lb-wg{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
#lis-login-box .lis-lb-wg button{flex:1;min-width:70px;padding:6px 8px;border:2px solid #e0e0e0;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;transition:.2s}
#lis-login-box .lis-lb-wg button:hover{border-color:#3498db;background:#eaf2f8}
#lis-login-box .lis-lb-wg button.sel{border-color:#3498db;background:#3498db;color:#fff}
#lis-login-box .lis-lb-login{width:100%;padding:9px;border:none;border-radius:6px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px;transition:.2s}
#lis-login-box .lis-lb-login:hover{filter:brightness(1.1);transform:translateY(-1px)}
#lis-login-box .lis-lb-login:disabled{opacity:.6;cursor:not-allowed}
#lis-login-box .lis-lb-tip{font-size:11px;color:#999;text-align:center;margin-top:10px;line-height:1.4}
#lis-login-box .lis-lb-remember{display:flex;align-items:center;gap:6px;font-size:12px;color:#666;margin-top:6px}
#lis-login-box .lis-lb-remember input{width:auto}

    
/* --- 待审速览 --- */
.ws-audit-bar{background:linear-gradient(180deg,#f8f9fa,#fff);padding:10px 20px;border-bottom:2px solid #3498db;display:flex;align-items:center;gap:8px;flex-shrink:0;box-shadow:0 2px 4px rgba(0,0,0,.05)}
.ws-audit-bar .ab-label{font-size:12px;color:#555;font-weight:600;margin-right:4px;white-space:nowrap}
.ws-audit-bar .ab-btn{padding:6px 14px;border-radius:6px;border:2px solid #dee2e6;background:#fff;cursor:pointer;font-size:12px;font-weight:600;transition:background .2s;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.ws-audit-bar .ab-btn:hover{border-color:#3498db;background:#eaf2f8;transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,.1)}
.ws-audit-bar .ab-btn.on{border-color:#3498db;background:linear-gradient(135deg,#3498db,#2980b9);color:#fff;box-shadow:0 2px 8px rgba(52,152,219,.3)}
.ws-audit-bar .ab-btn.ready{border-color:#27ae60;color:#27ae60}
.ws-audit-bar .ab-btn.ready.on{background:linear-gradient(135deg,#27ae60,#1e8449);color:#fff;border-color:#27ae60;box-shadow:0 2px 8px rgba(39,174,96,.3)}
.ws-audit-bar .ab-count{font-size:13px;font-weight:700;margin-left:8px;padding:4px 12px;border-radius:12px;box-shadow:inset 0 1px 2px rgba(0,0,0,.1)}
.ws-audit-bar .ab-count.green{background:linear-gradient(135deg,#e8f5e9,#c8e6c9);color:#2e7d32}
.ws-audit-bar .ab-count.orange{background:linear-gradient(135deg,#fff3e0,#ffe0b2);color:#e65100}
.ws-audit-bar .ab-sep{width:1px;height:24px;background:#dee2e6;margin:0 6px}
.complete-star{color:#f39c12;font-size:12px}
.complete-empty{color:#e74c3c;font-size:12px}
.complete-partial{color:#ff9800;font-size:12px}

/* --- 标本详情面板 --- */
#lis-detail-panel{position:fixed;top:0;right:0;width:65vw;max-width:900px;min-width:600px;height:100vh;z-index:100005;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,.2);transform:translateX(100%);transition:transform .3s ease;display:flex;flex-direction:column}
#lis-detail-panel.show{transform:translateX(0)}
#lis-detail-panel{overflow:hidden!important}
#lis-detail-hd{background:linear-gradient(135deg,#1a252f,#2c3e50);color:#fff;padding:12px 20px;display:flex;align-items:flex-start;justify-content:space-between;flex-shrink:0;line-height:1.4}
#lis-detail-hd h4{margin:0;font-size:16px}
#lis-detail-hd .detail-close{background:none;border:none;color:#fff;font-size:20px;cursor:pointer;padding:4px 8px;border-radius:4px;transition:background .2s}
#lis-detail-hd .detail-close:hover{background:rgba(255,255,255,.2)}
#lis-detail-info{padding:0px 16px;background:transparent;border-bottom:none;flex-shrink:0;font-size:12px}



#lis-detail-body{flex:1!important;overflow-y:scroll!important;overflow-x:hidden!important;padding:16px 20px;min-height:0!important;max-height:calc(100vh - 120px)!important;position:relative;overscroll-behavior:contain;contain:content}
#lis-detail-body .result-section{margin-bottom:20px}
#lis-detail-body .result-section h5{margin:0 0 12px;color:#2c3e50;font-size:14px;padding-bottom:8px;border-bottom:2px solid #3498db}
.result-table{width:100%;border-collapse:collapse;font-size:12px}
.result-table th{background:#34495e;color:#ecf0f1;padding:5px 8px;text-align:left;font-weight:600;white-space:nowrap;font-size:11px}
.result-table td{padding:4px 8px;border-bottom:1px solid #eee;overflow:hidden;text-overflow:ellipsis}
.result-table tr:hover{background:#f5f5f5}
.result-table .abnormal{color:#e74c3c;font-weight:600}
.result-table .abnormal.critical{color:#b71c1c;font-weight:700;font-size:15px;text-shadow:0 0 1px rgba(231,76,60,.3)}
.result-table .abnormal.high{color:#e65100}
.result-table .abnormal.low{color:#1565c0}
.result-table .normal{color:#27ae60}
.result-table .history{background:#f8f9fa}
.result-table .hist-tag{display:inline-block;margin:1px 2px;padding:2px 6px;border-radius:3px;font-size:11px;white-space:nowrap;line-height:1.4}
.result-table .hist-tag.normal{background:#e8f5e9;color:#2e7d32;border-left:3px solid #4caf50}
.result-table .hist-tag.abnormal{background:#fce4ec;color:#c62828;border-left:3px solid #e74c3c}
.result-table .hist-tag.high{background:#fff3e0;color:#e65100;border-left:3px solid #ff9800}
.result-table .hist-tag.low{background:#e3f2fd;color:#1565c0;border-left:3px solid #2196f3}
.result-table .hist-tag.critical{background:#ffebee;color:#c62828;border-left:3px solid #e74c3c;font-weight:700}
.result-table .hist-tag.nodate{background:#f5f5f5;color:#999;border-left:3px solid #bbb}
.result-table .hist-date{font-size:9px;color:#999;display:block;margin-top:-1px}
#lis-detail-footer{padding:12px 20px;background:#f8f9fa;border-top:1px solid #eee;display:flex;gap:10px;justify-content:flex-end;flex-shrink:0}
#lis-detail-footer button{padding:8px 16px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;transition:background .2s}
#lis-detail-footer .btn-audit{background:#27ae60;color:#fff}
#lis-detail-footer .btn-audit:hover{background:#1e8449}
#lis-detail-footer .btn-close{background:#95a5a6;color:#fff}
#lis-detail-footer .btn-close:hover{background:#7f8c8d}
#lis-detail-loading{text-align:center;padding:40px;color:#999}
#lis-detail-loading .spinner{display:inline-block;width:24px;height:24px;border:3px solid #ddd;border-top:3px solid #3498db;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

    /* --- 响应式 --- */
@media(max-width:1200px){
  #lis-ws-hd{flex-wrap:wrap;padding:6px 12px;gap:6px}
  #lis-ws-hd .ws-search-wrap{flex:1 1 260px;min-width:180px}
  #lis-ws-bar{padding:4px 12px}
}
@media(max-width:900px){
  #lis-ws-hd h3{font-size:14px}
  .ws-wg-tab{padding:4px 8px;font-size:11px}
  .ws-mach-tab,.cat-tab{padding:4px 7px;font-size:10px}
  .ws-tab-name{max-width:112px}
  #lis-ws-body th,#lis-ws-body td{padding:6px 8px}
  #lis-ws-body{font-size:12px}
}
@media(max-width:700px){
  #lis-ws-hd{flex-direction:column;align-items:flex-start;padding:6px 10px}
  #lis-ws-hd .ws-title{min-width:0}
  #lis-ws-hd .ws-search-wrap{width:100%;min-width:0;flex:auto}
  #lis-ws-hd .ws-acts{margin-left:0}
  #lis-ws-bar{flex-wrap:wrap}
  #lis-ws-body{font-size:11px}
}
    `);

    // ==================== Toast ====================
    function toast(msg, type='s') {
        const el = document.createElement('div');
        el.className = 'lis-t ' + type;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    // ============================================================
    //  模块 A：审核登录持久化 + 密码自动填充
    // ============================================================
    function isAuthPage() {
        return location.href.indexOf('frmAuthUserLogin') > -1 || location.href.indexOf('frmEntryUserLogin') > -1;
    }
    function isReportPage() {
        return location.href.indexOf('frmLisReportResultM') > -1;
    }
    function isLoginPage() {
        return location.href.indexOf('Login.aspx') > -1;
    }

    let _authPersistenceInited = false;
    function initAuthPersistence() {
        if (_authPersistenceInited) return;
        _authPersistenceInited = true;
        restoreAuth();
        const orig = sessionStorage.setItem.bind(sessionStorage);
        sessionStorage.setItem = function(k,v) {
            orig(k,v);
            if (k==='AuInfo')   { try { localStorage.setItem(K.au, v); } catch(e){} }
            if (k==='EntryInfo'){ try { localStorage.setItem(K.ent, v); } catch(e){} }
        };
        const origC = sessionStorage.clear.bind(sessionStorage);
        sessionStorage.clear = function() {
            let a=null,e=null;
            try { a=sessionStorage.getItem('AuInfo'); e=sessionStorage.getItem('EntryInfo'); } catch(x){}
            origC();
            try { if(a) orig('AuInfo',a); if(e) orig('EntryInfo',e); } catch(x){}
        };
        _authTimer = setInterval(restoreAuth, 3000);
        dbg('认证持久化就绪');
    }

    function initAuthFill() {
        if (isAuthPage()) fillAuthPage();
        else if (isReportPage()) fillBatchPage();
    }

    function restoreAuth() {
        const wsOpen = document.getElementById('lis-ws') && document.getElementById('lis-ws').classList.contains('show');
        try {
            if (!sessionStorage.getItem('AuInfo')) {
                const s = localStorage.getItem(K.au);
                if (s) {
                    sessionStorage.setItem('AuInfo', s);
                    // 工作台打开时不调用 refreshAuthUI，避免触发 LIS 页面重渲染导致闪烁
                    if (!wsOpen) refreshAuthUI();
                    else dbg('[WS] 工作台打开中，跳过 refreshAuthUI');
                }
            } else { localStorage.setItem(K.au, sessionStorage.getItem('AuInfo')); }
        } catch(e){}
        try {
            if (!sessionStorage.getItem('EntryInfo')) {
                const s = localStorage.getItem(K.ent);
                if (s) sessionStorage.setItem('EntryInfo', s);
            } else { localStorage.setItem(K.ent, sessionStorage.getItem('EntryInfo')); }
        } catch(e){}
    }

    function refreshAuthUI() {
        try {
            const w = uw();
            if (typeof w.GetAuthLoginInfo === 'function') {
                if (w.me) { w.me.AuthUserDR=''; w.me.IsAuthLogin=0; w.me.EntryUserDR=''; w.me.IsEntryLogon=0; }
                w.GetAuthLoginInfo();
            }
        } catch(e){}
    }

    // 审核登录页面（iframe 中）
    function fillAuthPage() {
        const tryFill = async () => {
            const pwd = await loadPwdAsync();
            if (!pwd) return false;
            const inputs = document.querySelectorAll('input[type="password"], input[onfocus*="password"]');
            for (const inp of inputs) {
                if (!inp.value) {
                    setNativeInputValue(inp, pwd);
                    inp.type = 'password';
                }
                if (!inp._lisListen) {
                    inp._lisListen = true;
                    inp.addEventListener('change', () => { if(inp.value) savePwdAsync(inp.value); });
                    inp.addEventListener('keydown', e => { if(e.keyCode===13 && inp.value) savePwdAsync(inp.value); });
                }
            }
            return inputs.length > 0;
        };
        tryFill().then(ok => {
            if (ok) return;
            const ob = new MutationObserver(() => { tryFill().then(filled => { if(filled) ob.disconnect(); }); });
            ob.observe(document.body, {childList:true, subtree:true});
            setTimeout(() => ob.disconnect(), 60000);
            [500,1000,2000].forEach(t => setTimeout(() => tryFill(), t));
        });
    }

    // 报告处理页面：批审窗口
    function fillBatchPage() {
        // MutationObserver
        const ob = new MutationObserver(muts => {
            for (const m of muts) for (const n of m.addedNodes) {
                if (n.nodeType!==1) continue;
                if (n.querySelector && (n.querySelector('#text_AuthUserLoginPasssword') || n.querySelector('#text_EntryUserPasssword')))
                    setTimeout(fillBatchPwd, 50);
                if (n.tagName==='IFRAME')
                    n.addEventListener('load', () => { setTimeout(()=>fillIframe(n),100); setTimeout(()=>fillIframe(n),500); });
            }
        });
        ob.observe(document.body, {childList:true, subtree:true});
        // 定期扫描
        _batchScanTimer = setInterval(() => {
            const f = document.getElementById('text_AuthUserLoginPasssword');
            if (f && f.offsetParent!==null && !f._lisFilled) fillBatchPwd();
        }, 2000);
    }

    async function fillBatchPwd() {
        const pwd = await loadPwdAsync();
        if (!pwd) return;
        const f = document.getElementById('text_AuthUserLoginPasssword');
        if (f && !f.value && f.offsetParent!==null) {
            setNativeInputValue(f, pwd);
            f.type='password';
            f._lisFilled = true;
        }
        if (f && !f._lisListen) {
            f._lisListen = true;
            f.addEventListener('change', () => { if(f.value) savePwdAsync(f.value); });
            f.addEventListener('keydown', e => { if(e.keyCode===13 && f.value) savePwdAsync(f.value); });
        }
    }

    async function fillIframe(ifr) {
        try {
            const doc = ifr.contentDocument;
            if (!doc) return;
            const pwd = await loadPwdAsync();
            if (!pwd) return;
            doc.querySelectorAll('input[type="password"], input[onfocus*="password"]').forEach(inp => {
                if (!inp.value) { setNativeInputValue(inp, pwd); inp.type='password'; }
                if (!inp._lisListen) {
                    inp._lisListen = true;
                    inp.addEventListener('change', () => { if(inp.value) savePwdAsync(inp.value); });
                    inp.addEventListener('keydown', e => { if(e.keyCode===13 && inp.value) savePwdAsync(inp.value); });
                }
            });
        } catch(e){}
    }

    // ============================================================
    //  模块 B：快速切换条
    // ============================================================
    let _qbarHideTimer = null;
    function initQBar() {
        const bar = document.createElement('div');
        bar.id = 'lis-qbar';
        const cur = wgDR();
        let h = '';
        WG.forEach(w => {
            h += `<button class="qb ${w.dr===cur?'on':''}" data-d="${w.dr}" style="background:${w.color}">${w.icon}${w.name}</button>`;
        });
        h += `<span class="qb-info" id="lis-qi"></span><span class="qb-x" id="lis-qx" title="收起">✕</span>`;
        bar.innerHTML = h;
        document.body.appendChild(bar);

        // 短暂显示后自动隐藏
        setTimeout(() => bar.classList.add('show'), 300);
        _qbarHideTimer = setTimeout(() => bar.classList.remove('show'), 4000);

        bar.addEventListener('click', e => {
            const b = e.target.closest('.qb');
            if (!b || b.dataset.d===cur) return;
            switchWG(b.dataset.d);
        });

        // 鼠标移到顶部 3px 区域时显示
        document.addEventListener('mousemove', e => {
            if (e.clientY < 3) {
                bar.classList.add('show');
                clearTimeout(_qbarHideTimer);
            }
        });
        // 鼠标离开切换条后自动隐藏
        bar.addEventListener('mouseleave', () => {
            clearTimeout(_qbarHideTimer);
            _qbarHideTimer = setTimeout(() => bar.classList.remove('show'), 2000);
        });
        // 点击 X 立即隐藏
        document.getElementById('lis-qx').addEventListener('click', () => {
            bar.classList.remove('show');
        });
    }

    function switchWG(dr) {
        const curDR = wgDR();
        if (dr === curDR) return;
        const wgName = (WG_MAP[dr]||{}).name || dr;
        toast('正在切换到 ' + wgName + '...', 'w');
        try { localStorage.setItem('LIS_LastWorkGroup', dr); } catch(e) {}

        // 方法1：直接操作原生切换下拉框 + 调用原生 changeLogin 函数
        try {
            const sel = document.getElementById('sl_changeworkgroup');
            if (sel && typeof changeLogin === 'function') {
                sel.value = dr;
                changeLogin(sel);
                return;
            }
            // 也检查父窗口（如果在 iframe 中运行）
            if (window.parent && window.parent !== window) {
                const psel = window.parent.document.getElementById('sl_changeworkgroup');
                if (psel && typeof window.parent.changeLogin === 'function') {
                    psel.value = dr;
                    window.parent.changeLogin(psel);
                    return;
                }
            }
        } catch(e) {
            dbg('原生切换方式1失败:', e);
        }

        // 方法2：调用 changeLoginSys
        try {
            const w = (typeof changeLoginSys === 'function') ? window : 
                      (window.parent && typeof window.parent.changeLoginSys === 'function') ? window.parent : null;
            if (w) {
                const idField = document.getElementById('changeLoginID') || 
                                (window.parent ? window.parent.document.getElementById('changeLoginID') : null);
                const nameField = document.getElementById('changeLoginName') || 
                                  (window.parent ? window.parent.document.getElementById('changeLoginName') : null);
                const typeField = document.getElementById('changeLoginType') || 
                                  (window.parent ? window.parent.document.getElementById('changeLoginType') : null);
                if (idField) idField.value = dr;
                if (nameField) nameField.value = wgName;
                if (typeField) typeField.value = 'workGroup';
                w.changeLoginSys(null);
                return;
            }
        } catch(e) {
            dbg('原生切换方式2失败:', e);
        }

        // 方法3：所有原生方式都失败，回退到登录页
        toast('原生切换不可用，跳转登录页...', 'w');
        localStorage.setItem('LIS_AutoLogin', '1');
        setTimeout(() => {
            location.href = BASE + '/login/form/Login.aspx';
        }, 500);
    }

    // ============================================================
    //  模块 QC：质控数据录入页辅助
    // ============================================================
    let qcInputInited = false;
    let qcPanelCollapsed = false;
    let qcPanelShowNative = false;
    let qcPanelClosed = false;
    let qcRefreshTimer = null;
    let qcProbeTimer = null;
    let qcLastKey = '';
    const QC_POS_KEY = 'lis-qc-panel-pos';

    function qcSavePos() {
        const panel = document.getElementById('lis-qc-panel');
        if (!panel) return;
        try {
            const pos = { l: panel.offsetLeft, t: panel.offsetTop, w: panel.offsetWidth, h: panel.offsetHeight };
            localStorage.setItem(QC_POS_KEY, JSON.stringify(pos));
        } catch(e) {}
    }
    function qcRestorePos() {
        try {
            const raw = localStorage.getItem(QC_POS_KEY);
            if (!raw) return null;
            return JSON.parse(raw);
        } catch(e) { return null; }
    }
    let qcLastFrameUrl = '';

    let qcIFrame = null; // 质控页面所在的 iframe 元素
    let qcWin = null;    // 质控页面的 window（可能是 iframe.contentWindow 或 window）
    let qcDoc = null;    // 质控页面的 document

    // 尝试在当前页面的 iframe 中查找质控页面
    function qcFindIFrame() {
        const frames = document.querySelectorAll('iframe');
        for (const f of frames) {
            try {
                const href = f.contentWindow && f.contentWindow.location && f.contentWindow.location.href || '';
                if (href.indexOf('/qc/form/frmQCDataInputNew') > -1) return f;
            } catch(e) { /* 跨域无法访问 */ }
        }
        // 也检查 src 属性（跨域时无法读 contentWindow.location）
        for (const f of frames) {
            const src = f.src || '';
            if (src.indexOf('/qc/form/frmQCDataInputNew') > -1) return f;
        }
        return null;
    }

    function isQCDataInputPage() {
        // 先检查当前页面
        if (location.href.indexOf('/qc/form/frmQCDataInputNew') > -1) return true;
        const hasQcGrids = document.getElementById('dgData') && document.getElementById('dgTestCode');
        const hasQcControls = document.getElementById('dglevelno') || document.getElementById('cmbMach') || document.getElementById('cmbMat');
        if (hasQcGrids && hasQcControls) return true;
        // 再检查 iframe
        const f = qcFindIFrame();
        try {
        if (f && f.contentDocument) {
            const doc = f.contentDocument;
            const grids = doc.getElementById('dgData') && doc.getElementById('dgTestCode');
            const controls = doc.getElementById('dglevelno') || doc.getElementById('cmbMach') || doc.getElementById('cmbMat');
            if (grids && controls) return true;
        }
        } catch(e) {}
        return false;
    }

    // 获取质控页面的上下文（window/document/jQuery）
    function qcGetCtx() {
        // 如果当前就是质控页
        if (location.href.indexOf('/qc/form/frmQCDataInputNew') > -1 || (document.getElementById('dgData') && document.getElementById('dgTestCode'))) {
            return { win: window, doc: document };
        }
        // 否则从 iframe 获取
        try {
            if (qcIFrame && qcIFrame.contentWindow && qcIFrame.contentDocument) {
                return { win: qcIFrame.contentWindow, doc: qcIFrame.contentDocument };
            }
        } catch(e) {}
        const f = qcFindIFrame();
        try {
            if (f && f.contentWindow && f.contentDocument) {
                qcIFrame = f;
                return { win: f.contentWindow, doc: f.contentDocument };
            }
        } catch(e) {}
        return { win: window, doc: document };
    }

    function getJQ() {
        const ctx = qcGetCtx();
        return (ctx.win.jQuery || ctx.win.$ || g('jQuery') || g('$') || window.jQuery || window.$);
    }

    function qcTryEasyUI(fn, fallback) {
        try { return fn(); } catch(e) { return fallback; }
    }

    function qcEasyValue(selector, plugin, method) {
        const jq = getJQ();
        if (!jq || !jq(selector)[plugin]) return '';
        return qcTryEasyUI(() => jq(selector)[plugin](method || 'getValue'), '');
    }

    function qcSelectedRow(selector) {
        const jq = getJQ();
        if (!jq || !jq(selector).datagrid) return null;
        return qcTryEasyUI(() => jq(selector).datagrid('getSelected'), null);
    }

    function qcSelectedRows(selector) {
        const jq = getJQ();
        if (!jq || !jq(selector).datagrid) return [];
        return qcTryEasyUI(() => jq(selector).datagrid('getSelections') || [], []);
    }

    function qcGridRows(selector) {
        const jq = getJQ();
        if (!jq || !jq(selector).datagrid) return [];
        return qcTryEasyUI(() => jq(selector).datagrid('getRows') || [], []);
    }

    function qcBuildContext() {
        const test = qcSelectedRow('#dgTestCode');
        const levels = qcSelectedRows('#dglevelno');
        const rows = qcGridRows('#dgData');
        const level = levels[0] || (rows.length ? { LevelNo: rows[0].LevelNo, CName: 'Level' + rows[0].LevelNo, MatLotDR: rows[0].MaterialLotDR } : null);
        const qcf = String((test && test.QcFlag) || '').split('^');
        const machineDR = qcEasyValue('#cmbMach', 'combobox', 'getValue') || (rows[0] && rows[0].MachineParameterDR) || qcf[3] || '';
        const machineName = qcEasyValue('#cmbMach', 'combobox', 'getText') || (rows[0] && rows[0].MachineParameterName) || '';
        const startDate = qcEasyValue('#startdate', 'datebox', 'getValue') || today();
        const endDate = qcEasyValue('#enddate', 'datebox', 'getValue') || today();
        const testCodeDR = (test && test.RowID) || (rows[0] && rows[0].TestCodeDR) || qcf[4] || '';
        const matDR = (test && test.MatDR) || (rows[0] && rows[0].MaterialDR) || '';
        const matLotDR = (level && level.MatLotDR) || (test && test.MatLotRowID) || (rows[0] && rows[0].MaterialLotDR) || qcf[2] || '';
        const mapType = qcf[1] || '0';
        return {
            test, levels, rows, level, machineDR, machineName, startDate, endDate,
            testCodeDR, matDR, matLotDR, mapType,
            testName: (test && (test.CName || test.Synonym || test.Code)) || (rows[0] && rows[0].TCName) || '',
            materialName: (test && test.MaterialName) || (rows[0] && rows[0].MaterialLotName) || '',
            levelNo: level && level.LevelNo ? String(level.LevelNo) : ''
        };
    }

    function qcContextKey(ctx) {
        const levelPart = (ctx.levels || []).map(l => l.LevelNo).sort().join(',') || ctx.levelNo || '';
        return [ctx.machineDR, ctx.testCodeDR, ctx.matLotDR, levelPart, ctx.startDate, ctx.endDate].join('|');
    }

    function qcNativeUrl(ctx) {
        if (!ctx.machineDR || !ctx.testCodeDR) return '';
        const p = new URLSearchParams();
        p.set('MachineDR', ctx.machineDR);
        p.set('MatLotDr', ctx.matLotDR || '');
        p.set('TestCodeDR', ctx.testCodeDR);
        p.set('StartDate', ctx.startDate || today());
        p.set('EndDate', ctx.endDate || today());
        p.set('MapType', ctx.mapType || '0');
        return BASE + '/qc/facade/frmQCDrawLJFacade.aspx?' + p.toString();
    }

    function qcAverageValue(row) {
        const vals = [];
        for (let i = 1; i <= 7; i++) {
            const n = parseFloat(row['Result' + i]);
            if (!Number.isNaN(n)) vals.push(n);
        }
        if (vals.length) return vals.reduce((a, b) => a + b, 0) / vals.length;
        const candidates = [row.DayAve, row.Result, row.TextRes, row.TestResultPosNeg];
        for (const v of candidates) {
            const n = parseFloat(v);
            if (!Number.isNaN(n)) return n;
        }
        return null;
    }

    function qcParseDate(s) {
        const d = String(s || '').trim();
        if (!d) return NaN;
        if (/^\d{4}-\d{2}-\d{2}/.test(d)) return new Date(d.slice(0, 10) + 'T00:00:00').getTime();
        if (/^\d{8}$/.test(d)) return new Date(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + 'T00:00:00').getTime();
        const parsed = Date.parse(d);
        return Number.isNaN(parsed) ? NaN : parsed;
    }

    function qcFormatXLabel(dateStr, fewPoints) {
        const d = String(dateStr || '');
        if (fewPoints && d.length >= 10) return d.slice(5, 10).replace('-', '/');
        if (d.length >= 10) return d.slice(8, 10);
        return d.slice(-2);
    }

    // 横轴定位：少量点靠左固定间距，避免 2～3 个点拉满整图
    function qcXPositions(points, left, plotW) {
        const n = points.length;
        const leftPad = 10;
        if (n === 1) return [left + leftPad];

        const dates = points.map(p => qcParseDate(p.date));
        const hasDates = dates.every(t => !Number.isNaN(t));
        const fewPoints = n <= 4;

        if (fewPoints) {
            const slot = Math.min(44, Math.max(30, plotW / 10));
            const x0 = left + leftPad;
            return points.map((_, i) => x0 + i * slot);
        }

        if (hasDates) {
            let minT = Math.min(...dates);
            let maxT = Math.max(...dates);
            const dayMs = 86400000;
            const minSpan = 7 * dayMs;
            const edgePad = 0.5 * dayMs;
            minT -= edgePad;
            if (maxT - minT < minSpan) maxT = minT + minSpan;
            else maxT += edgePad;
            const span = maxT - minT || dayMs;
            return dates.map(t => left + (t - minT) / span * plotW);
        }

        const slot = Math.min(40, plotW / Math.max(n, 8));
        const x0 = left + leftPad;
        return points.map((_, i) => x0 + i * slot);
    }

    // 绘制单个浓度的质控图 SVG
    function qcBuildSVG(points, levelLabel) {
        if (!points.length) return '';
        const xbarPoint = points.find(p => !Number.isNaN(p.xbar) && !Number.isNaN(p.sd));
        const xbar = xbarPoint ? xbarPoint.xbar : points.reduce((a, p) => a + p.value, 0) / points.length;
        const sdRaw = xbarPoint ? xbarPoint.sd : 0;
        const xbarStr = (xbarPoint && xbarPoint.xbarStr) || String(xbar);
        const sdStr = (xbarPoint && xbarPoint.sdStr) || String(sdRaw);
        const spread = sdRaw > 0 ? sdRaw : Math.max(0.0001, (Math.max(...points.map(p => p.value)) - Math.min(...points.map(p => p.value))) / 6);
        const values = points.map(p => p.value).concat([xbar - 3 * spread, xbar + 3 * spread]);
        let minY = Math.min(...values), maxY = Math.max(...values);
        if (minY === maxY) { minY -= 1; maxY += 1; }
        const padY = (maxY - minY) * 0.08;
        minY -= padY; maxY += padY;
        const w = 480, h = 140, left = 40, right = 10, top = 10, bottom = 18;
        const plotW = w - left - right, plotH = h - top - bottom;
        const xs = qcXPositions(points, left, plotW);
        const fewPoints = points.length <= 4;
        const x = i => xs[i];
        const y = v => top + (maxY - v) * plotH / (maxY - minY);
        const fmt = v => {
            const abs = Math.abs(v);
            return abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
        };
        const lineFor = (v, cls, label) => {
            if (v < minY || v > maxY) return '';
            const yy = y(v);
            return `<line class="${cls}" x1="${left}" y1="${yy}" x2="${w-right}" y2="${yy}"></line><text class="qc-sd" x="3" y="${yy+3}">${esc(label)}</text>`;
        };
        const path = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
        const dots = points.map((p, i) => {
            const diff = p.value - xbar;
            const z = Math.abs(diff) / spread;
            // 颜色优先级：outlier > 偏离方向
            let cls;
            if (z >= 3) cls = 'loss';
            else if (z >= 2) cls = 'warn';
            else if (diff === 0) cls = 'eq';
            else if (diff > 0) cls = 'above';
            else cls = 'below';
            return `<circle class="qc-dot ${cls}" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.2" data-date="${esc(p.date||'')}" data-val="${esc(fmt(p.value))}"></circle>`;
        }).join('');
        const last = points[points.length - 1];
        const xLabels = points.map((p, i) => {
            const label = qcFormatXLabel(p.date, fewPoints);
            return `<text class="qc-label" x="${x(i).toFixed(1)}" y="${h-3}" text-anchor="middle">${esc(label)}</text>`;
        }).join('');
        return `
            <div class="qc-chart-title">${esc(levelLabel)}</div>
            <svg viewBox="0 0 ${w} ${h}" preserveAspectRatio="xMidYMid meet" aria-label="质控趋势图">
                <rect x="0" y="0" width="${w}" height="${h}" fill="#fff"></rect>
                ${lineFor(xbar + 3 * spread, 'qc-sd3', '+3SD')}
                ${lineFor(xbar + 2 * spread, 'qc-sd2', '+2SD')}
                ${lineFor(xbar + spread, 'qc-sd1', '+1SD')}
                ${lineFor(xbar, 'qc-xbar', 'X')}
                ${lineFor(xbar - spread, 'qc-sd1', '-1SD')}
                ${lineFor(xbar - 2 * spread, 'qc-sd2', '-2SD')}
                ${lineFor(xbar - 3 * spread, 'qc-sd3', '-3SD')}
                <line class="qc-axis" x1="${left}" y1="${top}" x2="${left}" y2="${h-bottom}"></line>
                <line class="qc-axis" x1="${left}" y1="${h-bottom}" x2="${w-right}" y2="${h-bottom}"></line>
                <path class="qc-line" d="${path}"></path>
                ${dots}
                ${xLabels}
                <text class="qc-info" x="${w-right}" y="${top+8}" text-anchor="end">靶值 ${esc(xbarStr)}  SD ${esc(sdStr)}</text>
            </svg>`;
    }

    function qcDrawLocal(ctx) {
        const host = document.getElementById('lis-qc-local');
        if (!host) return;
        const rows = ctx.rows || [];
        // 找出所有浓度
        const levelMap = {};
        rows.forEach(r => {
            const ln = String(r.LevelNo || '1');
            if (!levelMap[ln]) levelMap[ln] = [];
            const v = qcAverageValue(r);
            if (v !== null && !Number.isNaN(v)) {
                levelMap[ln].push({ date: r.TestDate || r.AddDate || '', value: v, xbar: parseFloat(r.SetUpX), sd: parseFloat(r.SetUpSD), xbarStr: String(r.SetUpX ?? ''), sdStr: String(r.SetUpSD ?? '') });
            }
        });
        const levelNos = Object.keys(levelMap).sort();
        if (!levelNos.length) {
            host.innerHTML = '<div id="lis-qc-empty">当前项目/浓度暂无可绘制数据。<br>录入或切换项目后会自动刷新。</div>';
            return;
        }
        let html = '';
        const activeLevels = ctx.levels && ctx.levels.length > 1 ? levelNos : [ctx.levelNo || levelNos[0]];
        const drawLevels = activeLevels.filter(ln => levelMap[ln] && levelMap[ln].length > 0);
        if (!drawLevels.length) { html = '<div id="lis-qc-empty">暂无可绘制数据。</div>'; }
        else {
            drawLevels.forEach(ln => {
                const pts = levelMap[ln].slice(-45).sort((a, b) => {
                    const ta = qcParseDate(a.date);
                    const tb = qcParseDate(b.date);
                    if (!Number.isNaN(ta) && !Number.isNaN(tb)) return ta - tb;
                    return String(a.date || '').localeCompare(String(b.date || ''));
                });
                const label = 'Level ' + ln;
                html += `<div class="qc-chart-wrap">${qcBuildSVG(pts, label)}</div>`;
            });
        }
        host.innerHTML = html;
        // 悬浮 tooltip（挂到 body 上用 fixed 定位，不触发容器 reflow）
        let tip = document.getElementById('lis-qc-tooltip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'lis-qc-tooltip';
            tip.className = 'qc-tip';
            const td = document.createElement('span'); td.className = 'qc-tip-date';
            const tv = document.createElement('span'); tv.className = 'qc-tip-val';
            tip.appendChild(td); tip.appendChild(document.createTextNode(' ')); tip.appendChild(tv);
            document.body.appendChild(tip);
        }
        const tipDate = tip.querySelector('.qc-tip-date');
        const tipVal = tip.querySelector('.qc-tip-val');
        if (!host._lisQcTipBound) {
            host._lisQcTipBound = true;
            host.addEventListener('mousemove', e => {
                const dot = e.target.closest('.qc-dot');
                if (!dot) { tip.style.display = 'none'; return; }
                const date = dot.getAttribute('data-date') || '';
                const val = dot.getAttribute('data-val') || '';
                tipDate.textContent = (date.length >= 10 ? date.slice(8, 10) : date) + '日';
                tipVal.textContent = val;
                tip.style.display = 'block';
                tip.style.transform = `translate(${e.clientX + 10}px,${e.clientY - 26}px)`;
            });
            host.addEventListener('mouseleave', () => { tip.style.display = 'none'; });
        }
    }

    function qcUpdatePanel(forceFrame) {
        const panel = document.getElementById('lis-qc-panel');
        if (!panel) return;
        const ctx = qcBuildContext();
        const title = document.getElementById('lis-qc-title');
        const meta = panel.querySelector('.lis-qc-meta');
        const tip = panel.querySelector('.lis-qc-tip');
        const frame = document.getElementById('lis-qc-frame');
        if (!ctx.testCodeDR || !ctx.machineDR) {
            if (title) title.textContent = '质控图';
            if (meta) meta.textContent = '请选择仪器和项目';
            if (tip) tip.textContent = '等待右侧项目列表选择完成';
            if (frame) frame.removeAttribute('src');
            qcDrawLocal({ rows: [], levelNo: '' });
            return;
        }
        const key = qcContextKey(ctx);
        if (!forceFrame && key === qcLastKey) {
            qcDrawLocal(ctx);
            return;
        }
        qcLastKey = key;
        const levelText = ctx.levelNo ? 'Level' + ctx.levelNo : '全部浓度';
        if (title) title.textContent = ctx.testName || '质控图';
        if (meta) meta.textContent = `${levelText} | ${ctx.startDate} 至 ${ctx.endDate}`;
        if (tip) tip.textContent = `${ctx.machineName || ctx.machineDR} / ${ctx.materialName || ctx.matLotDR || '质控物'}`;
        const url = qcNativeUrl(ctx);
        if (frame && url && (forceFrame || url !== qcLastFrameUrl)) {
            qcLastFrameUrl = url;
            frame.src = url;
        }
        qcDrawLocal(ctx);
    }

    function qcScheduleRefresh(forceFrame, delay) {
        clearTimeout(qcRefreshTimer);
        qcRefreshTimer = setTimeout(() => qcUpdatePanel(!!forceFrame), delay == null ? 180 : delay);
    }

    function qcOpenNative() {
        const url = qcNativeUrl(qcBuildContext());
        if (url) window.open(url, '_blank');
    }

    function qcVisibleRect(el) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return null;
        return r;
    }

    // 获取 iframe 内元素在主框架视口中的坐标
    function qcVisibleRectInMain(el, ctx) {
        if (!el) return null;
        const r = el.getBoundingClientRect();
        if (!r || r.width <= 0 || r.height <= 0) return null;
        // 如果元素就在当前页面，直接返回
        if (ctx.win === window) return r;
        // 否则加上 iframe 的偏移
        try {
            const iframeEl = qcIFrame || qcFindIFrame();
            if (!iframeEl) return r;
            const iframeRect = iframeEl.getBoundingClientRect();
            return {
                left: r.left + iframeRect.left,
                top: r.top + iframeRect.top,
                right: r.right + iframeRect.left,
                bottom: r.bottom + iframeRect.top,
                width: r.width,
                height: r.height
            };
        } catch(e) { return r; }
    }

    let _qcLastPosKey = '';
    function qcPlacePanel() {
        const panel = document.getElementById('lis-qc-panel');
        if (!panel || qcPanelCollapsed) return;
        // 优先恢复上次保存的位置
        if (!panel.dataset.userMoved) {
            const saved = qcRestorePos();
            if (saved) {
                const vw = window.innerWidth || document.documentElement.clientWidth || 1280;
                const vh = window.innerHeight || document.documentElement.clientHeight || 720;
                const w = Math.min(Math.max(Number(saved.w) || 560, 360), Math.max(360, vw - 8));
                const h = Math.min(Math.max(Number(saved.h) || 420, 340), Math.max(340, vh - 8));
                const l = Math.max(0, Math.min(Number(saved.l) || 0, Math.max(0, vw - w)));
                const t = Math.max(0, Math.min(Number(saved.t) || 0, Math.max(0, vh - h)));
                panel.dataset.userMoved = '1';
                panel.classList.add('lis-qc-placed');
                panel.style.left = l + 'px';
                panel.style.top = t + 'px';
                panel.style.width = w + 'px';
                panel.style.height = h + 'px';
                panel.style.right = 'auto';
                panel.style.bottom = 'auto';
                return;
            }
        }
        // 用户手动拖动或缩放后不再自动挪回去；双击标题栏可恢复自动位置。
        if (panel.dataset.userMoved) return;
        // 如果位置没变就跳过（避免重复设置样式触发抖动）
        const viewportW = window.innerWidth || document.documentElement.clientWidth || 1280;
        const dataGrid = qcGetCtx().doc.getElementById('dgData');
        const testGrid = qcGetCtx().doc.getElementById('dgTestCode');
        const leftRect = qcVisibleRectInMain(dataGrid, qcGetCtx());
        const rightRect = qcVisibleRectInMain(testGrid, qcGetCtx());
        let width = Math.min(560, Math.max(360, Math.round(viewportW * 0.36)));
        let left = Math.max(46, Math.round(viewportW * 0.03));
        if (leftRect && rightRect) {
            const gapW = Math.round(rightRect.left - leftRect.right);
            if (gapW >= 360) {
                left = Math.max(46, Math.round(leftRect.right + 12));
                width = Math.min(560, gapW - 20);
            }
        }
        const h = Math.max(340, Math.round((window.innerHeight || 720) * 0.62));
        const posKey = `${left}|34|${width}|${h}`;
        if (posKey === _qcLastPosKey) return;
        _qcLastPosKey = posKey;
        panel.classList.add('lis-qc-placed');
        panel.style.left = left + 'px';
        panel.style.right = 'auto';
        panel.style.top = '34px';
        panel.style.bottom = 'auto';
        panel.style.width = width + 'px';
        panel.style.height = h + 'px';
        panel.style.minWidth = '360px';
    }

    function qcCreatePanel() {
        if (document.getElementById('lis-qc-panel')) return;
        const panel = document.createElement('div');
        panel.id = 'lis-qc-panel';
        panel.innerHTML = `
            <div id="lis-qc-head">
                <span id="lis-qc-title">质控图</span>
                <span class="lis-qc-meta">等待选择项目</span>
                <span class="lis-qc-actions">
                    <button id="lis-qc-native" title="显示/隐藏原生质控图">原生</button>
                    <button id="lis-qc-open" title="打开原生质控图">新窗</button>
                    <button id="lis-qc-collapse" title="收起/展开">_</button>
                    <button id="lis-qc-close" title="关闭质控面板">&times;</button>
                </span>
            </div>
            <div id="lis-qc-body">
                <div id="lis-qc-tools">
                    <span class="lis-qc-tip">随右侧项目和浓度自动刷新</span>
                    <button id="lis-qc-refresh" title="刷新质控图">刷新</button>
                </div>
                <div id="lis-qc-frame-wrap"><iframe id="lis-qc-frame" title="LIS 原生质控图"></iframe></div>
                <div id="lis-qc-local"><div id="lis-qc-empty">请选择右侧项目，质控图会显示在这里。</div></div>
                <div id="lis-qc-resize" title="拖动调整大小"></div>
            </div>`;
        document.body.appendChild(panel);
        qcPlacePanel();
        document.getElementById('lis-qc-refresh').addEventListener('click', () => qcScheduleRefresh(true, 0));
        document.getElementById('lis-qc-native').addEventListener('click', () => {
            qcPanelShowNative = !qcPanelShowNative;
            panel.classList.toggle('show-native', qcPanelShowNative);
            qcScheduleRefresh(true, 0);
        });
        document.getElementById('lis-qc-open').addEventListener('click', qcOpenNative);
        document.getElementById('lis-qc-collapse').addEventListener('click', () => {
            qcPanelCollapsed = !qcPanelCollapsed;
            panel.classList.toggle('collapsed', qcPanelCollapsed);
            if (!qcPanelCollapsed) setTimeout(qcPlacePanel, 0);
        });
        document.getElementById('lis-qc-close').addEventListener('click', () => {
            panel.style.display = 'none';
            qcPanelClosed = true;
            showQCFab();
        });
        // 悬浮按钮（关闭面板后可重新打开，可拖动）
        let fab = document.getElementById('lis-qc-fab');
        if (!fab) {
            fab = document.createElement('div');
            fab.id = 'lis-qc-fab';
            fab.textContent = 'QC';
            fab.title = '拖动移动 | 点击打开质控面板';
            fab.style.display = 'none';
            // 恢复上次位置
            try {
                const fp = JSON.parse(localStorage.getItem('lis-qc-fab-pos') || 'null');
                if (fp && typeof fp.l === 'number') {
                    fab.style.left = fp.l + 'px'; fab.style.top = fp.t + 'px';
                    fab.style.right = 'auto'; fab.style.bottom = 'auto';
                }
            } catch(e) {}
            document.body.appendChild(fab);
        }
        function showQCFab() { fab.style.display = 'flex'; }
        function hideQCFab() { fab.style.display = 'none'; }
        // 拖动 QC FAB
        let qfDrag = false, qfMoved = false, qfSX, qfSY, qfOL, qfOT;
        fab.addEventListener('pointerdown', e => {
            qfDrag = true; qfMoved = false;
            qfSX = e.clientX; qfSY = e.clientY;
            qfOL = fab.offsetLeft; qfOT = fab.offsetTop;
            fab.setPointerCapture(e.pointerId);
            fab.style.transition = 'none';
            e.preventDefault();
        });
        fab.addEventListener('pointermove', e => {
            if (!qfDrag) return;
            const dx = e.clientX - qfSX, dy = e.clientY - qfSY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) qfMoved = true;
            if (qfMoved) {
                fab.style.left = Math.max(0, qfOL + dx) + 'px';
                fab.style.top = Math.max(0, qfOT + dy) + 'px';
                fab.style.right = 'auto'; fab.style.bottom = 'auto';
            }
        });
        fab.addEventListener('pointerup', () => {
            qfDrag = false; fab.style.transition = '';
            if (qfMoved) {
                try { localStorage.setItem('lis-qc-fab-pos', JSON.stringify({ l: fab.offsetLeft, t: fab.offsetTop })); } catch(e) {}
            }
        });
        fab.addEventListener('click', () => {
            if (qfMoved) return;
            panel.style.display = '';
            qcPanelClosed = false;
            hideQCFab();
            qcScheduleRefresh(true, 0);
        });
        // 面板可见时隐藏悬浮按钮
        const fabObs = new MutationObserver(() => {
            if (panel.style.display === 'none') showQCFab(); else hideQCFab();
        });
        fabObs.observe(panel, { attributes: true, attributeFilter: ['style'] });
        // 拖拽移动面板
        const head = document.getElementById('lis-qc-head');
        const resize = document.getElementById('lis-qc-resize');
        const beginQCInteract = () => {
            panel.style.left = panel.offsetLeft + 'px';
            panel.style.top = panel.offsetTop + 'px';
            panel.style.width = panel.offsetWidth + 'px';
            panel.style.height = panel.offsetHeight + 'px';
            panel.style.right = 'auto';
            panel.style.bottom = 'auto';
            panel.style.transition = 'none';
            panel.classList.add('dragging');
            panel.classList.add('qc-interacting');
            document.body.style.userSelect = 'none';
        };
        const endQCInteract = () => {
            panel.dataset.userMoved = '1';
            panel.style.transition = '';
            panel.classList.remove('dragging');
            panel.classList.remove('qc-interacting');
            document.body.style.userSelect = '';
            qcSavePos();
        };
        head.addEventListener('pointerdown', e => {
            if (e.target.tagName === 'BUTTON') return;
            beginQCInteract();
            const startX = e.clientX;
            const startY = e.clientY;
            const startLeft = panel.offsetLeft;
            const startTop = panel.offsetTop;
            const width = panel.offsetWidth;
            const height = panel.offsetHeight;
            head.setPointerCapture(e.pointerId);
            const move = ev => {
                const vw = window.innerWidth, vh = window.innerHeight;
                const nl = startLeft + (ev.clientX - startX);
                const nt = startTop + (ev.clientY - startY);
                panel.style.left = Math.max(0, Math.min(nl, vw - width)) + 'px';
                panel.style.top = Math.max(0, Math.min(nt, vh - height)) + 'px';
            };
            const up = ev => {
                try { head.releasePointerCapture(ev.pointerId); } catch(x) {}
                head.removeEventListener('pointermove', move);
                head.removeEventListener('pointerup', up);
                head.removeEventListener('pointercancel', up);
                endQCInteract();
            };
            head.addEventListener('pointermove', move);
            head.addEventListener('pointerup', up);
            head.addEventListener('pointercancel', up);
            e.preventDefault();
        });
        head.addEventListener('dblclick', () => {
            delete panel.dataset.userMoved;
            panel.classList.remove('dragging');
            _qcLastPosKey = '';
            qcPlacePanel();
        });
        resize.addEventListener('pointerdown', e => {
            beginQCInteract();
            const startX = e.clientX;
            const startY = e.clientY;
            const startW = panel.offsetWidth;
            const startH = panel.offsetHeight;
            const left = panel.offsetLeft;
            const top = panel.offsetTop;
            resize.setPointerCapture(e.pointerId);
            const move = ev => {
                const vw = window.innerWidth, vh = window.innerHeight;
                const minW = 360, minH = 340;
                const maxW = vw - left - 8;
                const maxH = vh - top - 8;
                const nw = Math.max(minW, Math.min(startW + (ev.clientX - startX), maxW));
                const nh = Math.max(minH, Math.min(startH + (ev.clientY - startY), maxH));
                panel.style.width = nw + 'px';
                panel.style.height = nh + 'px';
            };
            const up = ev => {
                try { resize.releasePointerCapture(ev.pointerId); } catch(x) {}
                resize.removeEventListener('pointermove', move);
                resize.removeEventListener('pointerup', up);
                resize.removeEventListener('pointercancel', up);
                endQCInteract();
            };
            resize.addEventListener('pointermove', move);
            resize.addEventListener('pointerup', up);
            resize.addEventListener('pointercancel', up);
            e.preventDefault();
        });
    }

    function qcWrapEasyUIOption(selector, plugin, name, after) {
        const jq = getJQ();
        if (!jq || !jq(selector)[plugin]) return;
        qcTryEasyUI(() => {
            const opts = jq(selector)[plugin]('options');
            if (!opts || opts['_lisQc_' + name]) return;
            const old = opts[name];
            opts['_lisQc_' + name] = true;
            opts[name] = function() {
                const ret = typeof old === 'function' ? old.apply(this, arguments) : undefined;
                setTimeout(after, 0);
                return ret;
            };
        });
    }

    function qcBindPageEvents() {
        qcWrapEasyUIOption('#dgTestCode', 'datagrid', 'onSelect', () => qcScheduleRefresh(true, 350));
        qcWrapEasyUIOption('#dgTestCode', 'datagrid', 'onLoadSuccess', () => qcScheduleRefresh(true, 500));
        qcWrapEasyUIOption('#dglevelno', 'datagrid', 'onSelect', () => qcScheduleRefresh(true, 250));
        qcWrapEasyUIOption('#dglevelno', 'datagrid', 'onUnselect', () => qcScheduleRefresh(true, 250));
        qcWrapEasyUIOption('#dglevelno', 'datagrid', 'onCheckAll', () => qcScheduleRefresh(true, 250));
        qcWrapEasyUIOption('#dglevelno', 'datagrid', 'onUncheckAll', () => qcScheduleRefresh(true, 250));
        qcWrapEasyUIOption('#dgData', 'datagrid', 'onLoadSuccess', () => qcScheduleRefresh(false, 250));
        qcWrapEasyUIOption('#dgData', 'datagrid', 'onAfterEdit', () => qcScheduleRefresh(false, 120));
        qcWrapEasyUIOption('#cmbMach', 'combobox', 'onSelect', () => qcScheduleRefresh(true, 700));
        qcWrapEasyUIOption('#cmbMat', 'combobox', 'onSelect', () => qcScheduleRefresh(true, 700));
        qcWrapEasyUIOption('#startdate', 'datebox', 'onSelect', () => qcScheduleRefresh(true, 700));
        qcWrapEasyUIOption('#enddate', 'datebox', 'onSelect', () => qcScheduleRefresh(true, 700));
        // 事件监听绑定到质控页面所在的 document（可能是 iframe）
        const ctx = qcGetCtx();
        const targetDoc = ctx.doc;
        targetDoc.addEventListener('keyup', e => {
            if (e.target && /^(INPUT|TEXTAREA)$/i.test(e.target.tagName)) qcScheduleRefresh(false, 260);
        }, true);
        ['click', 'change'].forEach(ev => targetDoc.addEventListener(ev, () => {
            qcScheduleRefresh(false, 320);
        }, true));
        window.addEventListener('resize', () => {
            qcPlacePanel();
            qcScheduleRefresh(false, 260);
        });
        const dataDiv = targetDoc.getElementById('dataDiv');
        if (dataDiv) {
            const ob = new MutationObserver(() => {
                qcScheduleRefresh(false, 300);
            });
            ob.observe(dataDiv, { childList: true, subtree: true, characterData: true });
        }
    }

    function initQCInputEnhance() {
        if (qcInputInited) return;
        if (!isQCDataInputPage()) return;
        const wait = (left) => {
            const jq = getJQ();
            const ctx = qcGetCtx();
            const ready = jq && jq('#dgTestCode').length && jq('#dgTestCode').datagrid && ctx.doc.getElementById('dgData');
            if (!ready) {
                if (left > 0) setTimeout(() => wait(left - 1), 300);
                return;
            }
            qcInputInited = true;
            qcCreatePanel();
            qcBindPageEvents();
            qcScheduleRefresh(true, 800);
            dbg('[LIS-QC] 质控录入辅助已加载');
        };
        wait(80);
    }

    function startQCInputProbe() {
        if (qcProbeTimer) return;
        const probe = () => {
            const isQC = isQCDataInputPage();
            const panel = document.getElementById('lis-qc-panel');
            if (isQC && !qcInputInited && !qcPanelClosed) initQCInputEnhance();
            else if (qcInputInited && panel) {
                if (isQC && !qcPanelClosed) {
                    panel.style.display = '';
                    qcPlacePanel();
                } else if (!isQC) {
                    panel.style.display = 'none';
                }
            }
        };
        probe();
        qcProbeTimer = setInterval(probe, 1000);
    }


    // ============================================================
    //  模块 PR：病人结果筛选导出（独立小工具）— v7.15 重构
    // ============================================================
    let prData = [];
    let prBusy = false;
    let prComposing = false;
    let prAbortCtrl = null;        // 当前查询的 AbortController
    let prQuerySeq = 0;            // 查询序号，防止旧查询回写新结果
    let prPage = 1;                // 当前页码（从 1 开始）
    let prDatePickerCleanup = null;
    let prLastDetailFailures = 0;
    const prPageSize = 100;        // 每页行数
    const _prDetailCache = new Map(); // 详情结果 LRU 缓存
    const _prDetailInflight = new Map(); // 正在读取的明细请求，防止重复点击重复请求
    const _prWorkListCache = new Map();  // 标本列表短缓存，切换筛选条件时复用
    const _PR_DETAIL_MAX = 12000;     // PR 模块缓存上限（结果查询一次性查询量大）
    const _PR_WORKLIST_MAX = 20;
    const _PR_WORKLIST_TTL = 120000;  // 2 分钟内同日期/工作组/仪器/状态复用标本列表
    const PR_WORKLIST_PAGE_SIZE = 1000;
    const PR_WORKLIST_MAX_PAGES = 500;

    function prTodayOffset(days) {
        const d = new Date();
        d.setDate(d.getDate() + (days || 0));
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function prStatusText(status) {
        const map = {'0':'待排样','1':'登记','2':'初审','3':'审核','4':'复审','5':'取消'};
        return map[String(status || '')] || String(status || '');
    }

    function prSetStatus(text, type) {
        const el = document.getElementById('lis-pr-status');
        if (!el) return;
        el.textContent = text || '';
        el.classList.remove('ok', 'error', 'info');
        if (type === 'error') el.classList.add('error');
        else if (type === 'ok') el.classList.add('ok');
        else if (type === 'info') el.classList.add('info');
    }

    function prSetBusy(on) {
        prBusy = !!on;
        ['lis-pr-query','lis-pr-export','lis-pr-cancel'].forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;
            if (id === 'lis-pr-cancel') btn.style.display = on ? '' : 'none';
            else btn.disabled = prBusy;
        });
    }

    function prCancel() {
        prQuerySeq++;
        if (prAbortCtrl) { prAbortCtrl.abort(); prAbortCtrl = null; }
        prSetStatus('已取消查询。', 'info');
        prSetBusy(false);
    }

    /* ---------- LRU 缓存（复用工作台 _detailLRU 模式） ---------- */
    function prCacheGet(key) {
        if (!_prDetailCache.has(key)) return null;
        const v = _prDetailCache.get(key);
        _prDetailCache.delete(key);
        _prDetailCache.set(key, v);  // 移到最新
        return v;
    }
    function prCacheSet(key, val) {
        if (_prDetailCache.has(key)) _prDetailCache.delete(key);
        if (_prDetailCache.size >= _PR_DETAIL_MAX) {
            const first = _prDetailCache.keys().next().value;
            _prDetailCache.delete(first);
        }
        _prDetailCache.set(key, val);
    }
    function prMachineParameterDR(row) {
        return row.MachineParameterDR || row.MachParamDR || row.MachineParamDR || row.ParamDR || '';
    }
    function prWorkGroupMachineDR(row) {
        return row.WorkGroupMachineDR || row.WorkGroupMachine || row.MachineDR || row._mdr || '';
    }
    function prCacheKey(specimen) {
        return (specimen.ReportDR || specimen.TodoReportDR || '') + '|' + prMachineParameterDR(specimen) + '|' + prWorkGroupMachineDR(specimen) + '|' + (specimen.Status || specimen.ReportStatus || '');
    }

    function prWorkListCacheKey(filters) {
        return [filters.start, filters.end, (filters.wgs || []).join(','), (filters.machines || []).join(','), filters.status || ''].join('|');
    }

    function prWorkListCacheGet(key) {
        const hit = _prWorkListCache.get(key);
        if (!hit) return null;
        if (Date.now() - hit.ts > _PR_WORKLIST_TTL) {
            _prWorkListCache.delete(key);
            return null;
        }
        _prWorkListCache.delete(key);
        _prWorkListCache.set(key, hit);
        return hit.rows;
    }

    function prWorkListCacheSet(key, rows) {
        if (_prWorkListCache.has(key)) _prWorkListCache.delete(key);
        while (_prWorkListCache.size >= _PR_WORKLIST_MAX) {
            _prWorkListCache.delete(_prWorkListCache.keys().next().value);
        }
        _prWorkListCache.set(key, { ts: Date.now(), rows });
    }

    function prCleanFilterText(value) {
        const text = String(value || '').trim();
        if (!text) return '';
        const lower = text.toLowerCase();
        if (/^(如|例如|示例)\s*/.test(text)) return '';
        if (lower === '姓名 / 检验号 / 住院号') return '';
        if (text === '门诊 / 住院' || text === '诊断关键字') return '';
        return text;
    }

    function prSplitTerms(value) {
        const text = prCleanFilterText(value);
        if (!text) return [];
        return text.split(/[\s,，、|；;]+/).map(s => s.trim().toLowerCase()).filter(Boolean);
    }

    function prTextMatchAny(value, queryOrTerms) {
        const terms = Array.isArray(queryOrTerms) ? queryOrTerms : prSplitTerms(queryOrTerms);
        if (!terms.length) return true;
        const text = String(value || '').toLowerCase();
        return terms.some(term => text.includes(term));
    }

    function prSelectedValues(id) {
        const el = document.getElementById(id);
        if (!el) return [];
        if (el.multiple) return Array.from(el.selectedOptions || []).map(o => o.value).filter(Boolean);
        return el.value ? [el.value] : [];
    }

    function prCheckedValues(selector) {
        return Array.from(document.querySelectorAll(selector + ':checked')).map(el => el.value).filter(Boolean);
    }

    function prLooksLikePatientType(text) {
        return /^(门诊|住院|体检|急诊|留观|住院病人|门诊病人)$/i.test(String(text || '').trim());
    }

    function prAutoCorrectPatientTypeFields() {
        const patientType = document.getElementById('lis-pr-patient-type');
        const dept = document.getElementById('lis-pr-dept');
        const ward = document.getElementById('lis-pr-ward');
        if (patientType && !String(patientType.value || '').trim()) {
            if (dept && prLooksLikePatientType(dept.value)) {
                patientType.value = String(dept.value || '').trim();
                dept.value = '';
            } else if (ward && prLooksLikePatientType(ward.value)) {
                patientType.value = String(ward.value || '').trim();
                ward.value = '';
            }
        }
    }

    function prNormalizeFilters(filters) {
        filters.q = prCleanFilterText(filters.q).toLowerCase();
        filters.patientType = prCleanFilterText(filters.patientType).toLowerCase();
        filters.dept = prCleanFilterText(filters.dept).toLowerCase();
        filters.ward = prCleanFilterText(filters.ward).toLowerCase();
        filters.doctor = prCleanFilterText(filters.doctor).toLowerCase();
        filters.diagnosis = prCleanFilterText(filters.diagnosis).toLowerCase();
        filters.specimen = prCleanFilterText(filters.specimen).toLowerCase();
        filters.item = prCleanFilterText(filters.item).toLowerCase();
        filters.resultText = prCleanFilterText(filters.resultText).toLowerCase();
        filters.qTerms = prSplitTerms(filters.q);
        filters.patientTypeTerms = prSplitTerms(filters.patientType);
        filters.deptTerms = prSplitTerms(filters.dept);
        filters.wardTerms = prSplitTerms(filters.ward);
        filters.doctorTerms = prSplitTerms(filters.doctor);
        filters.diagnosisTerms = prSplitTerms(filters.diagnosis);
        filters.specimenTerms = prSplitTerms(filters.specimen);
        filters.itemTerms = prSplitTerms(filters.item);
        filters.resultTextTerms = prSplitTerms(filters.resultText);

        /* 常见误填：把“住院/门诊/体检”填到科室或病区时，自动按病人类型处理。 */
        ['dept', 'ward'].forEach(key => {
            if (!filters.patientType && prLooksLikePatientType(filters[key])) {
                filters.patientType = filters[key];
                filters.patientTypeTerms = prSplitTerms(filters.patientType);
                filters[key] = '';
                filters[key + 'Terms'] = [];
            }
        });
        return filters;
    }

    function prActiveFilterSummary(filters) {
        const parts = [];
        parts.push(`${filters.start || today()} 至 ${filters.end || today()}`);
        const wgNames = (filters.wgs || []).map(dr => (WG.find(w => String(w.dr) === String(dr)) || {}).name || dr);
        parts.push(`工作组=${wgNames.length ? wgNames.join('/') : '全部'}`);
        if ((filters.machines || []).length) {
            const names = Array.from(document.querySelectorAll('.lis-pr-machine-check:checked')).map(o => {
                const label = o.closest('label');
                const wg = (WG_MAP[o.dataset.wg] || {}).name || o.dataset.wg || '';
                return (wg ? wg + '-' : '') + ((label && label.textContent || o.value || '').trim());
            });
            parts.push(`仪器=${names.join('/')}`);
        }
        if (filters.status) parts.push(`状态=${prStatusText(filters.status)}`);
        if (filters.q) parts.push(`综合=${filters.q}`);
        if (filters.patientType) parts.push(`病人类型=${filters.patientType}`);
        if (filters.dept) parts.push(`科室=${filters.dept}`);
        if (filters.ward) parts.push(`病区=${filters.ward}`);
        if (filters.doctor) parts.push(`医生=${filters.doctor}`);
        if (filters.diagnosis) parts.push(`诊断=${filters.diagnosis}`);
        if (filters.sex) parts.push(`性别=${filters.sex}`);
        if (!Number.isNaN(filters.ageMin)) parts.push(`年龄>=${filters.ageMin}`);
        if (!Number.isNaN(filters.ageMax)) parts.push(`年龄<=${filters.ageMax}`);
        if (filters.specimen) parts.push(`标本=${filters.specimen}`);
        if (filters.item) parts.push(`项目=${filters.item}`);
        if (filters.judge) parts.push(`判断=${classifyStatusText(filters.judge)}`);
        if (filters.resultText) parts.push(`结果文本=${filters.resultText}`);
        if (filters.resultOp && !Number.isNaN(filters.resultValue)) parts.push(`数值${filters.resultOp}${filters.resultValue}`);
        if (!Number.isNaN(filters.resultMin)) parts.push(`数值>=${filters.resultMin}`);
        if (!Number.isNaN(filters.resultMax)) parts.push(`数值<=${filters.resultMax}`);
        if (filters.abnormal) parts.push('仅异常结果');
        return parts.join('，');
    }

    function prGetFilters() {
        prAutoCorrectPatientTypeFields();
        const val = id => ((document.getElementById(id) || {}).value || '').trim();
        return prNormalizeFilters({
            start: val('lis-pr-start') || today(),
            end: val('lis-pr-end') || today(),
            wgs: prCheckedValues('.lis-pr-wg-check'),
            machines: prCheckedValues('.lis-pr-machine-check'),
            status: val('lis-pr-status-filter'),
            q: val('lis-pr-q').toLowerCase(),
            patientType: val('lis-pr-patient-type').toLowerCase(),
            dept: val('lis-pr-dept').toLowerCase(),
            ward: val('lis-pr-ward').toLowerCase(),
            doctor: val('lis-pr-doctor').toLowerCase(),
            diagnosis: val('lis-pr-diagnosis').toLowerCase(),
            sex: val('lis-pr-sex'),
            ageMin: parseFloat((document.getElementById('lis-pr-age-min') || {}).value),
            ageMax: parseFloat((document.getElementById('lis-pr-age-max') || {}).value),
            specimen: val('lis-pr-specimen').toLowerCase(),
            item: val('lis-pr-item').toLowerCase(),
            resultText: val('lis-pr-result-text').toLowerCase(),
            resultOp: val('lis-pr-result-op'),
            resultValue: parseFloat((document.getElementById('lis-pr-result-value') || {}).value),
            resultMin: parseFloat((document.getElementById('lis-pr-result-min') || {}).value),
            resultMax: parseFloat((document.getElementById('lis-pr-result-max') || {}).value),
            judge: val('lis-pr-judge'),
            abnormal: (document.getElementById('lis-pr-abnormal') || {}).checked || false
        });
    }

    async function prLoadMachinesForWG(wg) {
        const box = document.getElementById('lis-pr-machine-tree');
        if (!box) return;
        const oldSelected = new Set(prCheckedValues('.lis-pr-machine-check'));
        const oldWGs = new Set(prCheckedValues('.lis-pr-wg-check'));
        box.innerHTML = '<span style="font-size:11px;color:#8a9a94;padding:8px 4px;align-self:center">仪器列表加载中...</span>';
        const targetWGs = WG;
        try {
            const groups = await Promise.all(targetWGs.map(async w => {
                const machines = await loadMachines(w.dr).catch(() => []);
                return { wg: w, machines: sortWSMachines((Array.isArray(machines) ? machines : []).map(m => ({...m, _wg: w.dr, _wgn: w.name}))) };
            }));
            box.innerHTML = groups.map(g => {
                const wgChecked = oldWGs.has(g.wg.dr) ? ' checked' : '';
                const items = g.machines.length ? g.machines.map(m => {
                    const value = (m._wg || '') + '|' + (m.RowID || '');
                    const checked = oldSelected.has(value) ? ' checked' : '';
                    const name = esc(m.CName || m.Name || m.RowID || '');
                    return `<label class="pr-mach-option"><input type="checkbox" class="lis-pr-machine-check" data-wg="${esc(g.wg.dr)}" value="${esc(value)}"${checked}><span>${name}</span></label>`;
                }).join('') : '<div style="font-size:12px;color:#9aa5b1;padding:4px 0">未加载到仪器</div>';
                return `<div class="pr-wg-block" data-wg="${esc(g.wg.dr)}">
                    <label class="pr-wg-title"><input type="checkbox" class="lis-pr-wg-check" value="${esc(g.wg.dr)}"${wgChecked}><span>${esc(g.wg.name)}</span></label>
                    <div class="pr-wg-mach-grid">${items}</div>
                </div>`;
            }).join('');
        } catch(e) {
            prSetStatus('仪器列表加载失败: ' + e.message, 'error');
        }
    }

    function prNormalizeWorkRow(r, wg, machine, machineMap) {
        const rowMdr = prWorkGroupMachineDR(r) || machine.RowID || '';
        const known = rowMdr && machineMap ? machineMap.get(String(rowMdr)) : null;
        const rowMachineName = prFirstText(
            r.WorkGroupMachineName, r.WorkGroupMachineDesc, r.MachineName, r.MachName, r.Machine,
            known && (known.CName || known.Name || known.RowID),
            machine.CName, machine.Name, machine.RowID
        );
        return {
            ...r,
            _wg: wg.dr,
            _wgn: wg.name,
            _mn: rowMachineName,
            _mdr: rowMdr
        };
    }

    /* 确保 loadMachines 结果被缓存（即使为空） */
    async function prLoadMachinesCached(dr) {
        const data = await loadMachines(dr).catch(() => []);
        return Array.isArray(data) ? data : [];
    }

    /* 并行加载所有工作组的标本列表 */
    async function prLoadRows(filters, signal) {
        const cacheKey = prWorkListCacheKey(filters);
        const cachedRows = prWorkListCacheGet(cacheKey);
        if (cachedRows) {
            prSetStatus(`复用标本列表缓存：${cachedRows.length} 个标本。`, 'info');
            return cachedRows;
        }
        const machinePairs = (filters.machines || []).map(v => {
            const parts = String(v).split('|');
            return { wg: parts[0] || '', mdr: parts.slice(1).join('|') || '' };
        }).filter(x => x.wg && x.mdr);
        const selectedWGs = filters.wgs || [];
        const effectiveWGSet = new Set(selectedWGs);
        machinePairs.forEach(x => effectiveWGSet.add(x.wg));
        const effectiveWGs = Array.from(effectiveWGSet).filter(Boolean);
        const targetWGs = effectiveWGs.length ? WG.filter(w => effectiveWGs.includes(w.dr)) : WG;
        const wgTotal = targetWGs.length;
        dbg('prLoadRows 有效查询范围:', '工作组=' + (targetWGs.map(w => w.name).join('/') || '全部'), '仪器=' + (machinePairs.map(x => x.wg + '|' + x.mdr).join(',') || '全部'));

        /* 所有工作组并行加载 */
        let requestFailed = false;
        const wgPromises = targetWGs.map(async (w, wgIdx) => {
            if (signal && signal.aborted) return [];
            let machines;
            try {
                machines = await loadMachines(w.dr);
            } catch(e) {
                requestFailed = true;
                dbg('病人结果仪器列表加载失败:', w.name, e.message);
                machines = [];
            }
            machines = Array.isArray(machines) ? machines : [];
            const selectedMachineDRs = machinePairs.filter(x => x.wg === w.dr).map(x => String(x.mdr));
            const machineMap = new Map(machines.map(m => [String(m.RowID || ''), m]));
            const targetMachines = selectedMachineDRs.length
                ? machines.filter(m => selectedMachineDRs.includes(String(m.RowID)))
                : machines;
            if (selectedMachineDRs.length && !targetMachines.length) {
                dbg('病人结果：已选择仪器但当前工作组未匹配到仪器，跳过:', w.name, selectedMachineDRs.join(','));
                return [];
            }
            const useGroupFallback = !selectedMachineDRs.length;
            const queryTargets = useGroupFallback
                ? [{ RowID: '', CName: '全部仪器', Name: '全部仪器', _groupFallback: true }]
                : targetMachines;
            const ss = buildSS(w.dr);
            const fetchTarget = async (m, mIdx, total) => {
                if (signal && signal.aborted) return [];
                const mname = m.CName || m.Name || m.RowID || '';
                prSetStatus(`正在查询 [${w.name}] ${mname}（工作组 ${wgIdx + 1}/${wgTotal}，仪器 ${mIdx + 1}/${total}）...`, 'info');
                const p = new URLSearchParams();
                p.set('ClassName','LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
                p.set('QueryName','QryWorkList');
                p.set('FunModul','MTHD');
                p.set('P0', filters.status || '');
                p.set('P1', filters.start);
                p.set('P2', filters.end);
                p.set('P10', m.RowID || '');
                p.set('P11', 'N^^^^');
                p.set('P14', ss);
                try {
                    const list = await prFetchWorkListRange(p, filters.start, filters.end, signal);
                    return list.map(r => prNormalizeWorkRow(r, w, m, machineMap));
                } catch(e) {
                    if (e.name === 'AbortError') return [];
                    requestFailed = true;
                    dbg('病人结果查询失败:', w.name, mname, e.message);
                    return [];
                }
            };
            let results;
            if (useGroupFallback) {
                const groupRows = await fetchTarget(queryTargets[0], 0, 1);
                const taggedWgm = groupRows.filter(r => prWorkGroupMachineDR(r)).length;
                if (groupRows.length > 0 && taggedWgm < groupRows.length && machines.length) {
                    dbg('病人结果：整组查询缺少部分仪器DR，自动退回逐台仪器查询:', w.name, '标本数=' + groupRows.length, '带仪器DR=' + taggedWgm);
                    const machinePromises = machines.filter(m => m.RowID).map((m, mIdx) => fetchTarget(m, mIdx, machines.length));
                    results = await Promise.all(machinePromises);
                } else {
                    results = [groupRows];
                }
            } else {
                const machinePromises = queryTargets.map((m, mIdx) => fetchTarget(m, mIdx, queryTargets.length));
                results = await Promise.all(machinePromises);
            }
            const wgCount = results.flat().length;
            dbg('prLoadRows 工作组:', w.name, '仪器数=' + queryTargets.length, '标本数=' + wgCount, 'fallback=' + useGroupFallback);
            return results.flat();
        });

        const wgResults = await Promise.all(wgPromises);
        const rows = wgResults.flat();
        dbg('prLoadRows 完成:', '总标本数=' + rows.length, '工作组数=' + wgTotal, 'requestFailed=' + requestFailed);
        // 只在有结果且无失败时缓存，避免缓存空结果
        if (!(signal && signal.aborted) && !requestFailed && rows.length > 0) prWorkListCacheSet(cacheKey, rows);
        return rows;
    }

    function prFilterRows(rows, filters) {
        let data = rows;
        if (filters.q) {
            data = data.filter(r => [
                r.PatName, r.Labno, r.EpisodeNo, r.RegNo, r.AdmNo, r.RecordNo,
                r.TestSetDesc, r.Location, r.LocationName, r.Ward, r.WardName
            ].some(v => prTextMatchAny(v, filters.qTerms)));
        }
        if (filters.sex) data = data.filter(r => {
            const sex = String(r.Sex || r.Species || '');
            return !sex || sex.includes(filters.sex);
        });
        /* 患者类型、科室、病区、诊断、标本等字段在工作列表中经常不完整。
           这些条件统一放到明细读取后严格筛选，避免全年查询时提前漏标本。 */
        return data;
    }

    function prMayHaveResult(row) {
        const resultFlag = String(row.ResultFlag || '').toUpperCase();
        const complete = String(row.IsComplete || '');
        if (resultFlag === 'N' && complete === '0') return false;
        return true;
    }

    function prNeedsDetailEvenWithoutResult(filters) {
        return !!(filters.doctor || filters.diagnosis || filters.ward || filters.ageMin === filters.ageMin ||
            filters.ageMax === filters.ageMax || filters.item || filters.resultText || filters.judge ||
            filters.abnormal || filters.resultOp || filters.resultMin === filters.resultMin || filters.resultMax === filters.resultMax);
    }

    function prTextMatch(value, q) {
        return !q || String(value || '').toLowerCase().includes(q);
    }

    function prDateRanges(startText, endText) {
        const start = prParseDateText(startText);
        const end = prParseDateText(endText);
        if (!start || !end || start > end) return [{ start: startText, end: endText }];
        const ranges = [];
        let cur = new Date(start.getFullYear(), start.getMonth(), start.getDate());
        while (cur <= end) {
            const monthEnd = new Date(cur.getFullYear(), cur.getMonth() + 1, 0);
            const segEnd = monthEnd < end ? monthEnd : end;
            ranges.push({ start: prFormatDateObj(cur), end: prFormatDateObj(segEnd) });
            cur = new Date(segEnd.getFullYear(), segEnd.getMonth(), segEnd.getDate() + 1);
        }
        return ranges;
    }

    function prWorkRowDedupeKey(r) {
        const parts = [
            r.ReportDR || r.TodoReportDR || '',
            r.Labno || '',
            r.EpisodeNo || '',
            r.RegNo || r.AdmNo || r.RecordNo || '',
            r._wg || r.WorkGroupDR || '',
            r._mdr || prWorkGroupMachineDR(r) || '',
            r.Status || r.ReportStatus || '',
            r.AcceptDT || r.SttAccDate || r.AcceptDate || r.TransmitDate || ''
        ];
        if (parts.some(Boolean)) return parts.join('|');
        try { return JSON.stringify(r); } catch(e) { return String(Math.random()); }
    }

    function prDedupeWorkRows(rows) {
        const seen = new Set();
        const out = [];
        rows.forEach(r => {
            const key = prWorkRowDedupeKey(r);
            if (seen.has(key)) return;
            seen.add(key);
            out.push(r);
        });
        return out;
    }

    function prRowsFromResponse(data) {
        return (data && data.rows) ? data.rows : (Array.isArray(data) ? data : []);
    }

    function prTotalFromResponse(data, fallback) {
        const total = Number(data && data.total);
        return Number.isFinite(total) && total >= 0 ? total : fallback;
    }

    async function prFetchWorkListPages(params, signal) {
        const pageSize = PR_WORKLIST_PAGE_SIZE;
        const out = [];
        const seen = new Set();
        for (let page = 1; page <= PR_WORKLIST_MAX_PAGES; page += 1) {
            if (signal && signal.aborted) return out;
            const p = new URLSearchParams(params.toString());
            p.set('page', String(page));
            p.set('rows', String(pageSize));
            const data = await fetchJRetry(CSP + '?' + p.toString(), 30000, signal, 2, 300);
            const rows = prRowsFromResponse(data);
            let fresh = 0;
            rows.forEach(r => {
                const key = prWorkRowDedupeKey(r);
                if (!seen.has(key)) {
                    seen.add(key);
                    fresh += 1;
                    out.push(r);
                }
            });
            const total = prTotalFromResponse(data, 0);
            if (rows.length < pageSize) break;
            /* LIS 有时 total 不准：满页时主动多探一页；如果下一页全重复则停止，避免死循环。 */
            if (page > 1 && rows.length > 0 && fresh === 0) break;
            if (total > 0 && out.length >= total && rows.length < pageSize) break;
        }
        return out;
    }

    async function prFetchWorkListRange(baseParams, start, end, signal) {
        const ranges = prDateRanges(start, end);
        if (ranges.length <= 1) return prFetchWorkListPages(baseParams, signal);
        const out = [];
        for (let i = 0; i < ranges.length; i += 1) {
            if (signal && signal.aborted) break;
            const seg = ranges[i];
            const p = new URLSearchParams(baseParams.toString());
            p.set('P1', seg.start);
            p.set('P2', seg.end);
            prSetStatus(`正在分段查询 ${seg.start} 至 ${seg.end}（${i + 1}/${ranges.length}）...`, 'info');
            out.push(...await prFetchWorkListPages(p, signal));
        }
        return prDedupeWorkRows(out);
    }

    function prFirstText() {
        for (let i = 0; i < arguments.length; i += 1) {
            const v = arguments[i];
            if (v == null) continue;
            const text = String(v).trim();
            if (text) return text;
        }
        return '';
    }

    function prPatientTypeText(specimen, labInfo) {
        specimen = specimen || {};
        labInfo = labInfo || {};
        const direct = prFirstText(
            specimen.AdmType, specimen.AdmTypeName, specimen.AdmissionType, specimen.AdmissionTypeName,
            specimen.PatientTypeName, specimen.PatientType, specimen.PatientClassName, specimen.PatientClass,
            specimen.PatTypeName, specimen.PatType, specimen.PatTypeDesc, specimen.VisitTypeName, specimen.VisitType,
            labInfo.AdmType, labInfo.AdmTypeName, labInfo.AdmissionType, labInfo.AdmissionTypeName,
            labInfo.PatientTypeName, labInfo.PatientType, labInfo.PatientClassName, labInfo.PatientClass,
            labInfo.PatTypeName, labInfo.PatType, labInfo.PatTypeDesc, labInfo.VisitTypeName, labInfo.VisitType
        );
        if (direct) return direct;
        const inpatientHint = prFirstText(
            specimen.AdmNo, specimen.InHospNo, specimen.InpatientNo, specimen.InPatientNo, specimen.HospitalNo,
            labInfo.AdmNo, labInfo.InHospNo, labInfo.InpatientNo, labInfo.InPatientNo, labInfo.HospitalNo,
            specimen.BedNo, specimen.Bed, labInfo.BedNo, labInfo.Bed
        );
        const wardHint = prFirstText(specimen.Ward, specimen.WardName, labInfo.Ward, labInfo.WardName);
        if (inpatientHint || wardHint) return '住院';
        const outpatientHint = prFirstText(
            specimen.ClinicNo, specimen.OutpatientNo, specimen.OutPatientNo, specimen.OPNo,
            labInfo.ClinicNo, labInfo.OutpatientNo, labInfo.OutPatientNo, labInfo.OPNo
        );
        if (outpatientHint) return '门诊';
        return '';
    }

    function prAsArray(value) {
        if (!value) return [];
        if (Array.isArray(value)) return value;
        if (Array.isArray(value.rows)) return value.rows;
        return [value];
    }

    function prNumberPass(value, filters) {
        if (filters.resultOp && Number.isNaN(filters.resultValue)) return true;
        const parsed = parseComparableNumber(value);
        if (!parsed || Number.isNaN(parsed.value)) {
            return !filters.resultOp && Number.isNaN(filters.resultValue) && Number.isNaN(filters.resultMin) && Number.isNaN(filters.resultMax);
        }
        const n = parsed.value;
        if (filters.resultOp && !Number.isNaN(filters.resultValue)) {
            const v = filters.resultValue;
            if (filters.resultOp === 'gt' && !(n > v)) return false;
            if (filters.resultOp === 'gte' && !(n >= v)) return false;
            if (filters.resultOp === 'lt' && !(n < v)) return false;
            if (filters.resultOp === 'lte' && !(n <= v)) return false;
            if (filters.resultOp === 'eq' && !(Math.abs(n - v) < 1e-9)) return false;
        }
        if (!Number.isNaN(filters.resultMin) && n < filters.resultMin) return false;
        if (!Number.isNaN(filters.resultMax) && n > filters.resultMax) return false;
        return true;
    }

    function prResultPass(row, filters) {
        if (filters.patientType && !prTextMatchAny(row.patientType, filters.patientTypeTerms)) return false;
        if (filters.sex && !String(row.sex || '').includes(filters.sex)) return false;
        if (filters.dept && !prTextMatchAny([row.location, row.ward].filter(Boolean).join(' '), filters.deptTerms)) return false;
        if (filters.ward && !prTextMatchAny(row.ward, filters.wardTerms)) return false;
        if (filters.doctor && !prTextMatchAny(row.doctor, filters.doctorTerms)) return false;
        if (filters.specimen && !prTextMatchAny(row.specimen, filters.specimenTerms)) return false;
        if (filters.item && !prTextMatchAny([row.itemName, row.itemSynonym, row.testSet].filter(Boolean).join(' '), filters.itemTerms)) return false;
        if (filters.resultText && !prTextMatchAny([row.result, row.abFlag, classifyStatusText(row.status)].filter(Boolean).join(' '), filters.resultTextTerms)) return false;
        if (filters.diagnosis && !prTextMatchAny(row.diagnosis, filters.diagnosisTerms)) return false;
        if (filters.judge && row.status !== filters.judge) return false;
        if (filters.abnormal && row.status === 'NORMAL') return false;
        /* 年龄筛选 */
        if (!Number.isNaN(filters.ageMin) || !Number.isNaN(filters.ageMax)) {
            const age = parseFloat(row.age);
            if (Number.isNaN(age)) return false;
            if (!Number.isNaN(filters.ageMin) && age < filters.ageMin) return false;
            if (!Number.isNaN(filters.ageMax) && age > filters.ageMax) return false;
        }
        if ((filters.resultOp && !Number.isNaN(filters.resultValue)) || !Number.isNaN(filters.resultMin) || !Number.isNaN(filters.resultMax)) {
            if (!prNumberPass(row.result, filters)) return false;
        }
        return true;
    }

    /* 清理参考范围中的日期格式 */
    function cleanRefRange(ref) {
        if (!ref) return '';
        ref = ref.replace(/\d{4}-\d{2}-\d{2}/g, '').replace(/\d{2}-\d{2}/g, '').replace(/\d{4}\/\d{2}\/\d{2}/g, '');
        ref = ref.replace(/\s+/g, ' ').replace(/,\s*,/g, ',').replace(/^[\s,]+|[\s,]+$/g, '');
        return ref.trim();
    }

    function prRowsFromDetailData(specimen, data) {
        const itemInfo = prAsArray(data && data.ItemInfo);
        const labInfo = prAsArray(data && data.LabInfo)[0] || {};
        return itemInfo.map(item => {
            const result = ((item.TextRes && String(item.TextRes).trim()) ? item.TextRes : (item.Result || '')).trim();
            const status = classifyResultItem(item);
            return {
                workGroup: specimen._wgn || '',
                machine: specimen._mn || '',
                patient: specimen.PatName || labInfo.PatName || '',
                patientType: prPatientTypeText(specimen, labInfo),
                sex: specimen.Sex || labInfo.Sex || labInfo.Species || '',
                age: specimen.Age || labInfo.Age || '',
                labno: specimen.Labno || '',
                episodeNo: specimen.EpisodeNo || '',
                regNo: specimen.RegNo || labInfo.RegNo || '',
                recordNo: specimen.RecordNo || labInfo.RecordNo || '',
                location: specimen.Location || specimen.LocationName || labInfo.Location || labInfo.LocationName || '',
                ward: specimen.Ward || specimen.WardName || labInfo.Ward || labInfo.WardName || '',
                doctor: specimen.Doctor || specimen.DoctorName || specimen.ReqDoctorName || specimen.ApplyDoctorName || labInfo.Doctor || labInfo.DoctorName || labInfo.ReqDoctorName || '',
                diagnosis: specimen.Diagnose || specimen.Diagnosis || labInfo.Diagnose || labInfo.Diagnosis || '',
                specimen: specimen.Specimen || specimen.SpecimenDesc || labInfo.Specimen || labInfo.SpecimenDesc || '',
                testSet: specimen.TestSetDesc || '',
                acceptDT: specimen.AcceptDT || labInfo.AcceptDT || '',
                reportStatus: prStatusText(specimen.Status || specimen.ReportStatus),
                itemName: item.CName || item.Name || '',
                itemSynonym: item.Synonym || item.Code || '',
                result,
                unit: item.Unit || item.Units || '',
                refRange: cleanRefRange(item.RefRanges || item.RefRange || item.ReferenceRange || ''),
                abFlag: item.AbFlag || '',
                status
            };
        });
    }

    async function prFetchResultRows(specimen, filters, signal) {
        if (signal && signal.aborted) return [];
        const reportDR = specimen.ReportDR || specimen.TodoReportDR || '';
        if (!reportDR) return [];

        /* 检查 LRU 缓存 */
        const ck = prCacheKey(specimen);
        const cached = prCacheGet(ck);
        if (cached) {
            return cached.filter(row => prResultPass(row, filters));
        }

        const rawCache = (typeof _classifyRawCache !== 'undefined') ? _classifyRawCache[reportDR] : null;
        if (rawCache && rawCache.data) {
            const rows = prRowsFromDetailData(specimen, rawCache.data);
            prCacheSet(ck, rows);
            return rows.filter(row => prResultPass(row, filters));
        }

        const inflight = _prDetailInflight.get(ck);
        if (inflight) {
            const rows = await inflight;
            return rows.filter(row => prResultPass(row, filters));
        }

        const promise = (async () => {
            const ss = buildSS(specimen._wg || (filters.wgs && filters.wgs[0]) || wgDR());
            const p = new URLSearchParams();
            p.set('ClassName', 'LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
            p.set('QueryName', 'GetReportInfoAll');
            p.set('FunModul', 'MTHD');
            p.set('P0', reportDR);
            p.set('P1', prMachineParameterDR(specimen));
            p.set('P2', prWorkGroupMachineDR(specimen));
            p.set('P3', specimen.Status || specimen.ReportStatus || '');
            p.set('P4', specimen.EpisodeNo || '');
            p.set('P5', specimen.TransmitDate || '');
            p.set('P14', ss);
            let data = await fetchJRetry(CSP + '?' + p.toString(), 20000, signal, 2, 250);
            let itemInfo = prAsArray(data && data.ItemInfo);
            if (itemInfo.length === 0 && (specimen.Status || specimen.ReportStatus)) {
                p.set('P3', '');
                data = await fetchJRetry(CSP + '?' + p.toString(), 20000, signal, 2, 250);
            }
            const rows = prRowsFromDetailData(specimen, data);
            prCacheSet(ck, rows);
            return rows;
        })();

        _prDetailInflight.set(ck, promise);
        let allRows;
        try {
            allRows = await promise;
        } finally {
            _prDetailInflight.delete(ck);
        }

        return allRows.filter(row => prResultPass(row, filters));
    }

    function prRenderTable(rows) {
        const body = document.getElementById('lis-pr-body');
        if (!body) return;
        if (!rows.length) {
            body.innerHTML = '<div class="pr-empty">暂无结果。<br>请调整筛选条件后点击查询。</div>';
            return;
        }

        const totalRows = rows.length;
        const totalPages = Math.max(1, Math.ceil(totalRows / prPageSize));
        if (prPage > totalPages) prPage = totalPages;
        if (prPage < 1) prPage = 1;
        const startIdx = (prPage - 1) * prPageSize;
        const endIdx = Math.min(startIdx + prPageSize, totalRows);
        const pageRows = rows.slice(startIdx, endIdx);

        let h = '<table><thead><tr><th>姓名</th><th>性别</th><th>年龄</th><th>类型</th><th>科室</th><th>诊断</th><th>检验号</th><th>流水号</th><th>仪器</th><th>标本</th><th>组合</th><th>项目</th><th>结果</th><th>参考范围</th><th>状态</th><th>核收时间</th></tr></thead><tbody>';
        pageRows.forEach(r => {
            const cls = r.status === 'CRITICAL' ? 'pr-critical' : (r.status === 'HIGH' ? 'pr-high' : (r.status === 'LOW' ? 'pr-low' : (r.status === 'ABNORMAL' ? 'pr-abn' : '')));
            h += `<tr>
                <td>${esc(r.patient)}</td>
                <td>${esc(r.sex)}</td>
                <td>${esc(r.age)}</td>
                <td>${esc(r.patientType)}</td>
                <td>${esc(r.location || r.ward)}</td>
                <td>${esc(r.diagnosis)}</td>
                <td>${esc(r.labno)}</td>
                <td>${esc(r.episodeNo)}</td>
                <td>${esc(r.machine)}</td>
                <td>${esc(r.specimen)}</td>
                <td>${esc(r.testSet)}</td>
                <td>${esc(r.itemName)}</td>
                <td class="${cls}">${esc(r.result)}${r.unit ? ' ' + esc(r.unit) : ''}</td>
                <td>${esc(r.refRange)}</td>
                <td>${esc(classifyStatusText(r.status))}</td>
                <td>${esc(r.acceptDT)}</td>
            </tr>`;
        });
        h += '</tbody></table>';

        /* 分页控件 */
        h += `<div id="lis-pr-pagination">
            <button id="lis-pr-pg-prev" ${prPage <= 1 ? 'disabled' : ''}>上一页</button>
            <span class="pr-pg-info">第 ${prPage}/${totalPages} 页</span>
            <button id="lis-pr-pg-next" ${prPage >= totalPages ? 'disabled' : ''}>下一页</button>
            <span class="pr-pg-jump">跳转到 <input id="lis-pr-pg-input" type="number" min="1" max="${totalPages}" value="${prPage}" placeholder="页码"> 页</span>
            <span class="pr-pg-total">共 ${totalRows} 条</span>
        </div>`;

        body.innerHTML = h;

        /* 绑定分页事件 */
        const prevBtn = document.getElementById('lis-pr-pg-prev');
        const nextBtn = document.getElementById('lis-pr-pg-next');
        const jumpInput = document.getElementById('lis-pr-pg-input');
        if (prevBtn) prevBtn.addEventListener('click', () => { prPage--; prRenderTable(prData); });
        if (nextBtn) nextBtn.addEventListener('click', () => { prPage++; prRenderTable(prData); });
        if (jumpInput) jumpInput.addEventListener('keydown', e => {
            if (e.key === 'Enter') {
                const v = parseInt(jumpInput.value, 10);
                if (!isNaN(v) && v >= 1 && v <= totalPages) { prPage = v; prRenderTable(prData); }
            }
        });
    }

    function prCsvCell(value) {
        return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
    }

    function prExportCSV() {
        if (!prData.length) { showToast('没有可导出的结果', 'warning'); return; }
        if (prLastDetailFailures > 0) {
            const ok = window.confirm(`本次查询有 ${prLastDetailFailures} 个标本明细读取失败，导出的结果可能不完整。仍然导出吗？`);
            if (!ok) return;
        }
        const headers = ['工作组','仪器','姓名','病人类型','性别','年龄','检验号','流水号','登记号','病案号','科室','病区','医生','诊断','标本','组合','核收时间','报告状态','项目','结果','单位','参考范围','异常标志','判断'];
        const rows = prData.map(r => [
            r.workGroup, r.machine, r.patient, r.patientType, r.sex, r.age, r.labno, r.episodeNo, r.regNo, r.recordNo,
            r.location, r.ward, r.doctor, r.diagnosis, r.specimen, r.testSet, r.acceptDT, r.reportStatus, r.itemName,
            r.result, r.unit, r.refRange, r.abFlag, classifyStatusText(r.status)
        ]);
        const csv = '\uFEFF' + headers.map(prCsvCell).join(',') + '\n' + rows.map(row => row.map(prCsvCell).join(',')).join('\n');
        const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const f = prGetFilters();
        a.download = `病人结果_${f.start}_${f.end}.csv`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('病人结果已导出', 'success');
    }

    function prClearFilters() {
        [
            'lis-pr-q','lis-pr-patient-type','lis-pr-dept','lis-pr-ward','lis-pr-doctor',
            'lis-pr-diagnosis','lis-pr-age-min','lis-pr-age-max','lis-pr-specimen',
            'lis-pr-item','lis-pr-result-text','lis-pr-result-value','lis-pr-result-min','lis-pr-result-max'
        ].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        ['lis-pr-status-filter','lis-pr-sex','lis-pr-judge','lis-pr-result-op'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.value = '';
        });
        document.querySelectorAll('.lis-pr-wg-check,.lis-pr-machine-check').forEach(el => { el.checked = false; });
        const abnormal = document.getElementById('lis-pr-abnormal');
        if (abnormal) abnormal.checked = false;
        prSetStatus('筛选条件已清空。', 'info');
    }

    function prSetDateRange(kind) {
        const start = document.getElementById('lis-pr-start');
        const end = document.getElementById('lis-pr-end');
        if (!start || !end) return;
        prCloseDatePicker();
        if (kind === 'month') {
            start.value = prTodayOffset(-29);
            end.value = today();
        } else if (kind === 'year') {
            start.value = prTodayOffset(-364);
            end.value = today();
        } else {
            start.value = today();
            end.value = today();
        }
    }

    function prParseDateText(text) {
        const m = String(text || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
        if (!m) return null;
        const y = Number(m[1]);
        const mo = Number(m[2]);
        const d = Number(m[3]);
        const dt = new Date(y, mo - 1, d);
        if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
        return dt;
    }

    function prFormatDateObj(d) {
        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
    }

    function prDaysInMonth(year, month) {
        return new Date(year, month, 0).getDate();
    }

    function prCloseDatePicker() {
        const old = document.getElementById('lis-pr-date-picker');
        if (old) old.remove();
        if (prDatePickerCleanup) {
            prDatePickerCleanup();
            prDatePickerCleanup = null;
        }
    }

    function prOpenDatePicker(input) {
        if (!input) return;
        prCloseDatePicker();
        const base = prParseDateText(input.value) || new Date();
        let viewYear = base.getFullYear();
        let viewMonth = base.getMonth() + 1;
        const selected = prFormatDateObj(base);
        const picker = document.createElement('div');
        picker.id = 'lis-pr-date-picker';

        const render = () => {
            const minYear = Math.min(2020, new Date().getFullYear() - 6, viewYear - 2);
            const maxYear = Math.max(2035, new Date().getFullYear() + 2, viewYear + 2);
            const years = [];
            for (let y = minYear; y <= maxYear; y += 1) {
                years.push(`<option value="${y}"${y === viewYear ? ' selected' : ''}>${y}年</option>`);
            }
            const months = [];
            for (let m = 1; m <= 12; m += 1) {
                months.push(`<option value="${m}"${m === viewMonth ? ' selected' : ''}>${m}月</option>`);
            }
            const firstDay = new Date(viewYear, viewMonth - 1, 1).getDay();
            const count = prDaysInMonth(viewYear, viewMonth);
            const days = [];
            for (let i = 0; i < firstDay; i += 1) days.push('<button type="button" class="blank" tabindex="-1"></button>');
            for (let d = 1; d <= count; d += 1) {
                const value = viewYear + '-' + String(viewMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
                days.push(`<button type="button" data-date="${value}" class="${value === input.value ? 'on' : ''}">${d}</button>`);
            }
            picker.innerHTML = `
                <div class="pr-dp-head">
                    <select class="pr-dp-year">${years.join('')}</select>
                    <select class="pr-dp-month">${months.join('')}</select>
                    <button type="button" class="pr-dp-today">今天</button>
                </div>
                <div class="pr-dp-week"><span>日</span><span>一</span><span>二</span><span>三</span><span>四</span><span>五</span><span>六</span></div>
                <div class="pr-dp-days">${days.join('')}</div>`;
            const yearSel = picker.querySelector('.pr-dp-year');
            const monthSel = picker.querySelector('.pr-dp-month');
            yearSel.addEventListener('change', () => {
                viewYear = Number(yearSel.value);
                render();
            });
            monthSel.addEventListener('change', () => {
                viewMonth = Number(monthSel.value);
                render();
            });
            picker.querySelector('.pr-dp-today').addEventListener('click', e => {
                e.stopPropagation();
                input.value = today();
                prCloseDatePicker();
            });
            picker.querySelectorAll('.pr-dp-days button[data-date]').forEach(btn => {
                btn.addEventListener('click', e => {
                    e.stopPropagation();
                    input.value = btn.dataset.date || selected;
                    prCloseDatePicker();
                });
            });
        };
        render();
        document.body.appendChild(picker);
        const rect = input.getBoundingClientRect();
        picker.style.left = Math.min(rect.left, window.innerWidth - picker.offsetWidth - 8) + 'px';
        picker.style.top = Math.min(rect.bottom + 4, window.innerHeight - picker.offsetHeight - 8) + 'px';
        const closeOnOutside = e => {
            if (e.target === input || picker.contains(e.target)) return;
            prCloseDatePicker();
        };
        const closeOnEsc = e => {
            if (e.key === 'Escape') prCloseDatePicker();
        };
        prDatePickerCleanup = () => {
            document.removeEventListener('mousedown', closeOnOutside, true);
            document.removeEventListener('keydown', closeOnEsc, true);
        };
        setTimeout(() => {
            document.addEventListener('mousedown', closeOnOutside, true);
            document.addEventListener('keydown', closeOnEsc, true);
        }, 0);
    }

    function prProtectChineseInput(panel) {
        const isTextInput = el => el && /^(INPUT|TEXTAREA)$/i.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'radio';
        panel.addEventListener('compositionstart', e => {
            if (isTextInput(e.target)) prComposing = true;
            e.stopPropagation();
        }, true);
        panel.addEventListener('compositionend', e => {
            if (isTextInput(e.target)) {
                setTimeout(() => { prComposing = false; }, 0);
            }
            e.stopPropagation();
        }, true);
        panel.addEventListener('beforeinput', e => {
            if (isTextInput(e.target)) e.stopPropagation();
        }, true);
        panel.addEventListener('input', e => {
            if (isTextInput(e.target)) e.stopPropagation();
        }, true);
        panel.addEventListener('keydown', e => {
            if (!isTextInput(e.target) && !(e.target && e.target.tagName === 'SELECT')) return;
            if (e.isComposing || prComposing || e.keyCode === 229) {
                e.stopPropagation();
                return;
            }
            if (e.key === 'Enter' || e.key === 'Escape') return;
            e.stopPropagation();
        }, true);
        panel.addEventListener('keyup', e => {
            if (isTextInput(e.target)) e.stopPropagation();
        }, true);
    }

    /* 修复：只拦截工具栏区域的滚轮（工具栏 overflow:visible 需手动滚动），
       #lis-pr-body 使用原生 overflow:auto 滚动，不阻止默认行为 */
    function prBindWheelScroll(panel) {
        /* 筛选区一次性展示，滚轮交给结果区原生滚动 */
    }

    /* 批次节流延迟（ms） */
    const PR_THROTTLE_MS = 50;

    /* 主查询函数（重构版：并行加载 + 取消 + 缓存 + 进度） */
    async function prQuery() {
        if (prBusy) return;
        const filters = prGetFilters();
        const activeSummary = prActiveFilterSummary(filters);
        if (filters.resultOp && Number.isNaN(filters.resultValue)) {
            prSetStatus('已选择数值关系，请填写比较值。', 'error');
            showToast('请填写结果比较值', 'warning');
            return;
        }
        const querySeq = ++prQuerySeq;
        prSetBusy(true);
        prAbortCtrl = new AbortController();
        const signal = prAbortCtrl.signal;
        prData = [];
        prLastDetailFailures = 0;
        prRenderTable([]);
        try {
            /* 阶段1：并行加载标本列表 */
            prSetStatus((filters.wgs || []).length ? '正在查询选中工作组标本列表...' : '正在并行查询所有工作组...', 'info');
            const allRows = await prLoadRows(filters, signal);
            if (signal.aborted || querySeq !== prQuerySeq) return;
            const rows = prFilterRows(allRows, filters);
            if (!rows.length) {
                if (querySeq !== prQuerySeq) return;
                prSetStatus(`未找到符合条件的标本（共查询 ${allRows.length} 条记录）。当前生效：${activeSummary}`, 'info');
                return;
            }
            const mustReadDetail = prNeedsDetailEvenWithoutResult(filters);
            const detailRows = mustReadDetail ? rows : rows.filter(prMayHaveResult);
            const skippedNoResult = rows.length - detailRows.length;
            if (!detailRows.length) {
                prSetStatus(`找到 ${rows.length} 个标本，但工作列表显示暂无结果。当前生效：${activeSummary}`, 'info');
                return;
            }
            /* 智能判断是否需要结果明细 */
            /* 阶段2：批次读取明细（带节流 + 进度 + 缓存复用） */
            prSetStatus(`找到 ${rows.length} 个标本，${skippedNoResult ? '跳过 ' + skippedNoResult + ' 个暂无结果标本，' : ''}正在读取结果明细...`, 'info');
            let resultRows = [];
            const batchSize = detailRows.length > 3000 ? 24 : (detailRows.length > 800 ? 20 : 15);
            let lastRenderAt = 0;
            let detailFailures = 0;
            for (let i = 0; i < detailRows.length; i += batchSize) {
                if (signal.aborted || querySeq !== prQuerySeq) return;
                const batch = detailRows.slice(i, i + batchSize);
                const lists = await Promise.all(batch.map(r => prFetchResultRows(r, filters, signal).catch(e => {
                    if (e.name === 'AbortError') return [];
                    dbg('病人结果明细失败:', r.Labno || r.ReportDR, e.message);
                    detailFailures += 1;
                    return [];
                })));
                if (signal.aborted || querySeq !== prQuerySeq) return;
                lists.forEach(list => resultRows.push(...list));
                const done = Math.min(i + batch.length, detailRows.length);
                if (resultRows.length && (resultRows.length - lastRenderAt >= 500 || done === detailRows.length)) {
                    prData = resultRows;
                    prRenderTable(prData);
                    lastRenderAt = resultRows.length;
                }
                prSetStatus(`正在读取结果明细 ${done} / ${detailRows.length}，已得到 ${resultRows.length} 条结果${detailFailures ? '，失败 ' + detailFailures + ' 个标本' : ''}${skippedNoResult ? '，已跳过 ' + skippedNoResult + ' 个暂无结果标本' : ''}...`, detailFailures ? 'error' : 'info');

                /* 批次间节流（避免服务端限流） */
                if (i + batchSize < detailRows.length) {
                    await new Promise(r => setTimeout(r, PR_THROTTLE_MS));
                }
            }

            if (signal.aborted || querySeq !== prQuerySeq) return;
            prData = resultRows;
            prLastDetailFailures = detailFailures;
            prPage = 1;
            prRenderTable(prData);
            const cacheHits = _prDetailCache.size;
            const zeroHint = prData.length ? '' : ` 当前生效：${activeSummary}`;
            const failHint = detailFailures ? `，${detailFailures} 个标本明细读取失败，请重查后再作为完整结果导出` : '';
            prSetStatus(`完成：${rows.length} 个标本，${prData.length} 条结果${skippedNoResult ? '，跳过 ' + skippedNoResult + ' 个暂无结果标本' : ''}${failHint}。明细缓存 ${cacheHits} 个标本。${zeroHint}`, detailFailures ? 'error' : (prData.length ? 'ok' : 'info'));
        } catch(e) {
            if (querySeq !== prQuerySeq) return;
            if (e.name === 'AbortError') { prSetStatus('查询已取消。', 'info'); return; }
            prSetStatus('查询失败: ' + e.message, 'error');
            showToast('病人结果查询失败: ' + e.message, 'error');
        } finally {
            if (querySeq === prQuerySeq) {
                prAbortCtrl = null;
                prSetBusy(false);
            }
        }
    }

    function createPatientResultTool() {
        if (document.getElementById('lis-pr-fab')) return;
        const fab = document.createElement('button');
        fab.id = 'lis-pr-fab';
        fab.textContent = '结果';
        fab.title = '病人结果筛选导出';
        document.body.appendChild(fab);

        const panel = document.createElement('div');
        panel.id = 'lis-pr-panel';
        panel.innerHTML = `
            <div id="lis-pr-hd">
                <div class="pr-hd-main">
                    <h3>病人结果筛选导出</h3>
                    <span class="pr-hd-sub">本地查询 · 不离开浏览器 · 可导出 CSV</span>
                </div>
                <span class="pr-spacer"></span>
                <button id="lis-pr-mini" title="最小化">—</button>
                <button class="pr-close" id="lis-pr-close" title="关闭">×</button>
            </div>
            <div id="lis-pr-filter-scroll">
                <div id="lis-pr-tools">
                    <div class="pr-card">
                        <div class="pr-card-hd"><span class="pr-card-ico">📅</span>标本范围</div>
                        <div class="pr-card-bd">
                            <div class="pr-row">
                                <label class="pr-date">开始日期<input type="text" id="lis-pr-start" readonly placeholder="选择日期"></label>
                                <label class="pr-date">结束日期<input type="text" id="lis-pr-end" readonly placeholder="选择日期"></label>
                                <div class="pr-date-shortcuts">
                                    <button type="button" data-range="today">今天</button>
                                    <button type="button" data-range="month">近一月</button>
                                    <button type="button" data-range="year">近一年</button>
                                </div>
                            </div>
                            <div class="pr-mach-section">
                                <div class="pr-mach-label">工作组 / 仪器</div>
                                <div id="lis-pr-machine-tree"></div>
                                <div class="pr-mach-hint">不勾选 = 全部；勾选工作组名 = 整组；也可单独勾选仪器</div>
                            </div>
                            <div class="pr-grid" style="margin-top:10px">
                                <label>状态<select id="lis-pr-status-filter">
                                    <option value="">全部</option><option value="1">登记</option><option value="2">初审</option><option value="3">审核</option><option value="4">复审</option>
                                </select></label>
                                <label class="pr-grid-wide">综合搜索<input type="text" id="lis-pr-q" placeholder="姓名 / 检验号 / 住院号"></label>
                            </div>
                        </div>
                    </div>
                    <div class="pr-card">
                        <div class="pr-card-hd"><span class="pr-card-ico">👤</span>患者信息</div>
                        <div class="pr-card-bd">
                            <div class="pr-grid">
                                <label>病人类型<input type="text" id="lis-pr-patient-type" placeholder="体检"></label>
                                <label>科室<input type="text" id="lis-pr-dept" placeholder="科室"></label>
                                <label>病区<input type="text" id="lis-pr-ward" placeholder="病区"></label>
                                <label>医生<input type="text" id="lis-pr-doctor" placeholder="医生"></label>
                                <label class="pr-grid-wide">诊断<input type="text" id="lis-pr-diagnosis" placeholder="诊断关键字"></label>
                                <label>性别<select id="lis-pr-sex"><option value="">全部</option><option value="男">男</option><option value="女">女</option></select></label>
                                <label>年龄 ≥<input type="number" id="lis-pr-age-min" placeholder="岁"></label>
                                <label>年龄 ≤<input type="number" id="lis-pr-age-max" placeholder="岁"></label>
                                <label>标本<input type="text" id="lis-pr-specimen" placeholder="血清"></label>
                            </div>
                        </div>
                    </div>
                    <div class="pr-card">
                        <div class="pr-card-hd"><span class="pr-card-ico">🧪</span>项目结果</div>
                        <div class="pr-card-bd">
                            <div class="pr-grid">
                                <label class="pr-grid-wide">项目名称<input type="text" id="lis-pr-item" placeholder="如 HBsAg"></label>
                                <label>判断<select id="lis-pr-judge">
                                    <option value="">全部</option><option value="NORMAL">正常</option><option value="HIGH">偏高</option><option value="LOW">偏低</option><option value="ABNORMAL">异常</option><option value="CRITICAL">危急</option><option value="UNCERTAIN">待定</option>
                                </select></label>
                                <label>结果文本<input type="text" id="lis-pr-result-text" placeholder="阳性 / +"></label>
                                <label>关系<select id="lis-pr-result-op">
                                    <option value="">不筛</option><option value="gt">&gt;</option><option value="gte">≥</option><option value="lt">&lt;</option><option value="lte">≤</option><option value="eq">=</option>
                                </select></label>
                                <label>比较值<input type="number" step="any" id="lis-pr-result-value" placeholder="数值"></label>
                                <label>数值 ≥<input type="number" step="any" id="lis-pr-result-min"></label>
                                <label>数值 ≤<input type="number" step="any" id="lis-pr-result-max"></label>
                                <label class="pr-toggle"><input type="checkbox" id="lis-pr-abnormal"><span>仅异常结果</span></label>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
            <div id="lis-pr-actions">
                <button id="lis-pr-query">查询</button>
                <button id="lis-pr-cancel" style="display:none">停止</button>
                <button id="lis-pr-clear">清空条件</button>
                <button id="lis-pr-export">导出 CSV</button>
                <span class="pr-act-spacer"></span>
                <span class="pr-act-hint">数据仅在本机处理，不会上传</span>
            </div>
            <div id="lis-pr-status">请选择条件后点击「查询」。</div>
            <div id="lis-pr-body"><div class="pr-empty">点击「查询」后显示病人结果明细。<br>导出的是结果数据，不是正式报告单。</div></div>`;
        document.body.appendChild(panel);

        const start = document.getElementById('lis-pr-start');
        const end = document.getElementById('lis-pr-end');
        if (start) start.value = today();
        if (end) end.value = today();
        prLoadMachinesForWG([]);


        document.getElementById('lis-pr-mini').addEventListener('click', () => {
            prCloseDatePicker();
            panel.classList.remove('show');
        });
        document.getElementById('lis-pr-close').addEventListener('click', () => {
            prCloseDatePicker();
            panel.classList.remove('show');
        });
        document.getElementById('lis-pr-query').addEventListener('click', prQuery);
        document.getElementById('lis-pr-cancel').addEventListener('click', prCancel);
        document.getElementById('lis-pr-clear').addEventListener('click', prClearFilters);
        document.getElementById('lis-pr-export').addEventListener('click', prExportCSV);
        panel.querySelectorAll('.pr-date-shortcuts button').forEach(btn => {
            btn.addEventListener('click', () => prSetDateRange(btn.dataset.range || 'today'));
        });
        [start, end].forEach(el => {
            if (!el) return;
            el.addEventListener('click', () => prOpenDatePicker(el));
            el.addEventListener('keydown', e => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    prOpenDatePicker(el);
                } else if (e.key === 'Escape') {
                    prCloseDatePicker();
                }
            });
        });

        /* FAB 拖动 */
        const FAB_POS_KEY = 'lis-pr-fab-pos';
        // 恢复位置
        try {
            const fp = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
            if (fp && typeof fp.l === 'number') {
                fab.style.left = fp.l + 'px';
                fab.style.top = fp.t + 'px';
                fab.style.right = 'auto';
                fab.style.bottom = 'auto';
                fab.style.position = 'fixed';
            }
        } catch(e) {}
        // 拖动 + 点击
        let fabDx = 0, fabDy = 0, fabDownX = 0, fabDownY = 0;
        fab.addEventListener('mousedown', e => {
            fabDx = e.clientX - fab.offsetLeft;
            fabDy = e.clientY - fab.offsetTop;
            fabDownX = e.clientX;
            fabDownY = e.clientY;
            const onMove = ev => {
                fab.style.left = (ev.clientX - fabDx) + 'px';
                fab.style.top = (ev.clientY - fabDy) + 'px';
                fab.style.right = 'auto';
                fab.style.bottom = 'auto';
                fab.style.position = 'fixed';
            };
            const onUp = ev => {
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
                const dist = Math.abs(ev.clientX - fabDownX) + Math.abs(ev.clientY - fabDownY);
                if (dist < 5) {
                    // 没怎么动，算点击
                    panel.classList.toggle('show');
                } else {
                    // 拖动了，保存位置
                    try { localStorage.setItem(FAB_POS_KEY, JSON.stringify({ l: fab.offsetLeft, t: fab.offsetTop })); } catch(e) {}
                }
            };
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
            e.preventDefault();
        });
        prProtectChineseInput(panel);
        prBindWheelScroll(panel);
        panel.addEventListener('keydown', e => {
            if (e.isComposing || prComposing || e.keyCode === 229) return;
            if (e.key === 'Enter' && !e.shiftKey && e.target && /INPUT|SELECT/.test(e.target.tagName)) {
                e.preventDefault();
                prQuery();
            }
            if (e.key === 'Escape') panel.classList.remove('show');
        });
    }
    // ============================================================
    //  模块 C：一体化工作台（核心）
    // ============================================================
    let wsData = [];      // 加载的标本数据
    let wsMachines = [];  // 当前加载的仪器列表
    let wsActiveMachine = ''; // 当前选中的仪器 DR, ''=全部
    let wsActiveWG = ''; // 当前选中的工作组 DR, ''=全部工作组
    let wsCategory = 'normal'; // 当前分类: 'normal'/'abnormal'/'incomplete'/'all'
    let wsClassifiedCache = {}; // 分类缓存 {[reportDR]: {status, items, row, reportDR}}
    const _CLASSIFIED_CACHE_MAX = 1000;
    let wsClassifying = false;  // 分类进行中标记
    let wsAbnormalIndex = -1;   // 异常视图当前焦点索引
    let wsChecked = new Set(); // 选中的 ReportDR 集合
    let wsSort = { field:'AcceptDT', asc:false };
    let wsTimer = null;
    let _authTimer = null;
    let _batchScanTimer = null;
    let wsSearchQuery = '';
    let wsLoading = false;
    let wsMachineCounts = {}; // { machineDR: {total, normalReady, abnormalReady, incomplete} }

    // --- 性能优化：缓存 ---
    let _detailLRU = new Map(); // 详情结果 LRU 缓存，最多 50 条
    const _DETAIL_LRU_MAX = 50;
    let _filteredCache = null;   // filteredData() 结果缓存
    let _filteredCacheKey = '';  // 缓存键
    let _countsCache = null;    // 统一计数缓存
    let _countsCacheKey = '';    // 计数缓存键
    let _classifyRawCache = {}; // 分类时的原始 API 响应缓存，供详情面板复用
    let _classifyVersion = 0; // 分类结果版本，驱动过滤缓存失效
    let _wsLoadSeq = 0; // 工作台加载序号，防止旧请求覆盖新刷新
    let _classifyRunSeq = 0; // 分类运行序号，防止旧分类任务影响新刷新
    let _lastWSNonEmptyAt = 0; // 最近一次成功加载到标本的时间，用于强制刷新兜底
    let _normalKeyHandler = null; // 普通视图键盘监听
    let _abnormalFocusDR = '';
    let _wsSearchTimer = null;
    const _tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

    function specimenFingerprint(row) {
        if (!row) return '';
        return [
            row.ReportDR,
            row.Status || row.ReportStatus,
            row.IsComplete,
            row.AcceptDT,
            row.TransmitDate,
            row._mdr,
            row._pending ? '1' : '0'
        ].map(v => String(v || '')).join('|');
    }

    function isClassificationStale(row) {
        if (!row || !row.ReportDR) return true;
        const cached = wsClassifiedCache[row.ReportDR];
        if (!cached) return true;
        const fp = specimenFingerprint(row);
        if (cached.fingerprint !== fp) return true;
        const age = Date.now() - (cached._classifiedAt || cached._accessTs || 0);
        return age > CLASSIFY_STALE_MS;
    }

    function pruneStaleClassificationCache(newData) {
        const newMap = new Map((newData || []).map(r => [String(r.ReportDR), specimenFingerprint(r)]));
        let changed = false;
        for (const dr of Object.keys(wsClassifiedCache)) {
            if (!newMap.has(dr)) {
                delete wsClassifiedCache[dr];
                changed = true;
                continue;
            }
            const cached = wsClassifiedCache[dr];
            const fp = newMap.get(dr);
            if (cached.fingerprint !== fp) {
                delete wsClassifiedCache[dr];
                changed = true;
            }
        }
        if (changed) _classifyVersion++;
        return changed;
    }

    function attachClassificationMeta(result, row) {
        if (!result || !row) return result;
        result.fingerprint = specimenFingerprint(row);
        result._classifiedAt = Date.now();
        result.row = row;
        return result;
    }

    function invalidateCaches(options = {}) {
        _filteredCache = null;
        _filteredCacheKey = '';
        _countsCache = null;
        _countsCacheKey = '';
        if (options.detail) _detailLRU.clear();
        if (options.raw) _classifyRawCache = {};
    }

    function detailLRUGet(key) {
        if (_detailLRU.has(key)) {
            const v = _detailLRU.get(key);
            _detailLRU.delete(key);
            _detailLRU.set(key, v);
            return v;
        }
        return null;
    }
    function detailLRUHas(key) {
        return _detailLRU.has(key);
    }

    function detailLRUSet(key, val) {
        if (_detailLRU.has(key)) _detailLRU.delete(key);
        if (_detailLRU.size >= _DETAIL_LRU_MAX) {
            const first = _detailLRU.keys().next().value;
            _detailLRU.delete(first);
        }
        _detailLRU.set(key, val);
    }

    const WS_CATEGORIES = ['normal', 'abnormal', 'incomplete', 'pending', 'all'];

    function saveWSState() {
        try {
            localStorage.setItem(K.wsState, JSON.stringify({
                wg: wsActiveWG,
                cat: wsCategory,
                mdr: wsActiveMachine
            }));
        } catch(e) {}
    }

    function loadWSState() {
        const fallback = { wg: wgDR() || '', cat: 'normal', mdr: '' };
        try {
            const saved = JSON.parse(localStorage.getItem(K.wsState) || '{}');
            const wg = Object.prototype.hasOwnProperty.call(saved, 'wg') ? String(saved.wg) : fallback.wg;
            const cat = WS_CATEGORIES.includes(saved.cat) ? saved.cat : fallback.cat;
            const mdr = Object.prototype.hasOwnProperty.call(saved, 'mdr') ? String(saved.mdr) : fallback.mdr;
            return { wg, cat, mdr };
        } catch(e) {
            return fallback;
        }
    }

    function applyWSState(state) {
        wsActiveWG = state.wg;
        wsCategory = state.cat;
        wsActiveMachine = state.mdr;
    }

    function normalizeWSMachineSelection() {
        if (!wsActiveMachine) return;
        const ok = wsMachines.some(m =>
            String(m.RowID) === String(wsActiveMachine) && (!wsActiveWG || m._wg === wsActiveWG)
        );
        if (!ok) wsActiveMachine = '';
    }

    // 打开工作台
    function openWS() {
        // 防重入：如果已打开，不做任何操作
        const wsEl = $('#lis-ws');
        if (!wsEl) return;
        if (wsEl.classList.contains('show')) { dbg('[WS] openWS 被调用但已打开，跳过'); return; }
        dbg('[WS] openWS 被调用');
        if (DEBUG) console.trace('[WS] openWS 调用栈');

        applyWSState(loadWSState());
        _abnormalPrewarmDR = '';
        _abnormalNativeReadyDR = '';
        wsClassifiedCache = {};
        _classifyVersion++;
        wsClassifying = false;
        wsLoading = false; // 重置加载状态，防止上次 closeWS 时 loadWSData 还在运行
        wsAbnormalIndex = -1;
        wsChecked.clear();
        wsData = [];
        wsMachines = [];
        wsMachineCounts = {};
        invalidateCaches({ detail: true, raw: true });
        wsEl.classList.add('show');
        // 强制 flex 布局（LIS 系统 CSS 会覆盖）
        wsEl.style.cssText = 'display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important;position:fixed!important;inset:0!important;z-index:100000!important';
        document.body.style.overflow = 'hidden';
        renderWSHeader();
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
        updateWSFooter();
        loadWSData().then(() => {
            if (wsCategory === 'abnormal') prefetchAbnormalAuditContext();
        });
        startWSRefresh();
        if (wsCategory === 'abnormal') prefetchReportPageForWS();
    }

    function closeWS() {
        const wsEl = $('#lis-ws');
        if (!wsEl) return;
        if (!wsEl.classList.contains('show')) { dbg('[WS] closeWS 被调用但未打开，跳过'); return; }
        saveWSState();
        dbg('[WS] closeWS 被调用');
        if (DEBUG) console.trace('[WS] closeWS 调用栈');
        wsEl.classList.remove('show');
        wsEl.style.cssText = 'display:none!important';
        document.body.style.overflow = '';
        stopWSRefresh();
        // 清理键盘监听器
        _removeAbnormalKeyHandler();
        if (_normalKeyHandler) {
            document.removeEventListener('keydown', _normalKeyHandler);
            _normalKeyHandler = null;
        }
        _removeDetailKeyHandler();
        clearTimeout(_abnormalPrewarmTimer);
        _abnormalPrewarmTimer = null;
        wsLoading = false; // 重置加载状态，防止下次 openWS 被阻塞
    }

    function findWSSpecimenByReportDR(reportDR) {
        const target = String(reportDR || '');
        if (!target) return null;
        const fromFiltered = filteredData().find(r => String(r.ReportDR || '') === target);
        if (fromFiltered) return fromFiltered;
        return wsData.find(r => String(r.ReportDR || '') === target) || null;
    }

    function resolveQueueItemRow(item) {
        if (!item) return null;
        return wsData.find(r => String(r.ReportDR) === String(item.reportDR)) || null;
    }

    function acquireQueueLock() {
        try {
            const raw = localStorage.getItem(K.auditQueueLock);
            if (raw) {
                const lock = JSON.parse(raw);
                if (lock.owner !== _tabId && Date.now() - (lock.ts || 0) < AUDIT_QUEUE_LOCK_TTL) return false;
            }
            localStorage.setItem(K.auditQueueLock, JSON.stringify({ owner: _tabId, ts: Date.now() }));
            return true;
        } catch(e) { return true; }
    }

    function refreshQueueLock() {
        try {
            localStorage.setItem(K.auditQueueLock, JSON.stringify({ owner: _tabId, ts: Date.now() }));
        } catch(e) {}
    }

    function releaseQueueLock() {
        try {
            const raw = localStorage.getItem(K.auditQueueLock);
            if (!raw) return;
            const lock = JSON.parse(raw);
            if (lock.owner === _tabId) localStorage.removeItem(K.auditQueueLock);
        } catch(e) {}
    }

    function isWSVisible() {
        const wsEl = document.getElementById('lis-ws');
        return !!(wsEl && wsEl.classList.contains('show'));
    }

    function keepWorkbenchOnTop(reason) {
        const wsEl = document.getElementById('lis-ws');
        if (!wsEl) return;
        if (!wsEl.classList.contains('show')) {
            applyWSState(loadWSState());
            invalidateCaches(); // 确保使用最新数据渲染
            wsEl.classList.add('show');
            renderWSHeader();
            renderWSTabs();
            renderWSCategoryBar();
            renderWSTable();
            updateWSFooter();
            startWSRefresh();
            if (!wsData.length) loadWSData();
        }
        wsEl.style.cssText = 'display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important;position:fixed!important;inset:0!important;z-index:100000!important';
        document.body.style.overflow = 'hidden';
        dbg('[WS] 批审保持工作台置顶: ' + (reason || ''));
    }

    function startWSRefresh() { stopWSRefresh(); wsTimer = setInterval(() => loadWSData(), REFRESH); }
    function stopWSRefresh() { if(wsTimer){clearInterval(wsTimer);wsTimer=null;} }

    // --- 加载数据 ---
    async function loadWSData(options = {}) {
        const force = !!(options && options.force);
        if (wsLoading && !force) return { skipped: true };
        const seq = force ? ++_wsLoadSeq : _wsLoadSeq;
        if (force) {
            wsLoading = false;
            wsClassifying = false;
            wsClassifiedCache = {};
            _classifyVersion++;
            wsChecked.clear();
            wsAbnormalIndex = -1;
            wsMachineCounts = {};
            invalidateCaches();
        }
        try {
        wsLoading = true;
        const qi = document.getElementById('lis-qi');
        if (qi) qi.textContent = force ? '强制刷新中...' : '加载中...';

        const curDR = wgDR();
        const targetWGs = WG; // 加载所有工作组的数据

        const allData = [];
        const allMachines = [];

        // 并行加载所有工作组
        const wgResults = await Promise.all(targetWGs.map(async (w) => {
            let machines;
            try {
                machines = await loadMachines(w.dr);
            } catch(e) { machines = []; }

            const ss = buildSS(w.dr);
            const wgData = [];
            const wgMachines = [];

            // 并行加载该工作组下所有仪器
            const machineResults = await Promise.all(machines.filter(m => m.RowID).map(async (m) => {
                const result = { rows: [], pending: [], machine: m };
                try {
                    result.rows = await loadWL(m.RowID, ss);
                    try {
                        result.pending = await loadPendingForMachine(m.RowID, ss);
                    } catch(e) {}
                } catch(e) {}
                return result;
            }));

            for (const mr of machineResults) {
                const m = mr.machine;
                mr.rows.forEach(r => {
                    r._wg = w.dr; r._wgn = w.name; r._wgc = w.color; r._wgi = w.icon;
                    r._mn = m.CName || m.Name || m.RowID; r._mdr = m.RowID;
                });
                mr.pending.forEach(r => {
                    r._wg = w.dr; r._wgn = w.name; r._wgc = w.color; r._wgi = w.icon;
                    r._mn = m.CName || m.Name || m.RowID; r._mdr = m.RowID;
                });
                wgData.push(...mr.rows, ...mr.pending);
                wgMachines.push({ ...m, _wg: w.dr, _wgn: w.name, _wgc: w.color, _wgi: w.icon });
            }

            return { data: wgData, machines: wgMachines };
        }));

        for (const r of wgResults) {
            if (seq !== _wsLoadSeq) return;
            allData.push(...r.data);
            allMachines.push(...r.machines);
        }
        if (seq !== _wsLoadSeq) return;

        // 防止空数据覆盖已有数据（网络异常/会话过期时服务器可能返回空）
        if (allData.length === 0 && wsData.length > 0) {
            dbg('刷新返回空数据，保留原有', wsData.length, '条');
            if (qi) qi.textContent = `刷新失败，保留 ${wsData.length} 条 | ${new Date().toLocaleTimeString()}`;
            if (force) showToast('工作台强制刷新仍返回空数据，可能需要重新登录或刷新浏览器页面', 'warning');
            return { ok: false, empty: true, preserved: true };
        }
        wsData = allData;
        wsMachines = allMachines;
        if (wsData.length > 0) _lastWSNonEmptyAt = Date.now();
        normalizeWSMachineSelection();
        pruneStaleClassificationCache(wsData);
        calcMachineCounts();

        if (qi) qi.textContent = `${wsData.length} 条 | ${new Date().toLocaleTimeString()}`;
        invalidateCaches({ raw: true, detail: true });
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable(); // 先用未分类数据渲染，让用户立即看到标本列表
        updateWSFooter();
        // 分类在后台进行，每批次完成后更新计数，最终更新表格
        classifyAllSpecimens(seq).catch(e => dbg('分类启动异常:', e));
        if (wsCategory === 'abnormal') prefetchAbnormalAuditContext();
        return { ok: true, count: wsData.length };
        } catch(e) {
            dbg('loadWSData 异常:', e);
            if (qi) qi.textContent = '加载失败';
            return { ok: false, error: e };
        } finally {
            if (seq === _wsLoadSeq) wsLoading = false;
        }
    }

    async function forceRefreshWS() {
        dbg('[WS] 强制刷新工作台状态');
        stopWSRefresh();
        clearMachineCache();
        const oldData = wsData;
        const oldMachines = wsMachines;
        const oldCounts = wsMachineCounts;
        const oldClassified = wsClassifiedCache;
        const hadData = wsData.length > 0 || _lastWSNonEmptyAt > 0;
        wsLoading = false;
        wsClassifying = false;
        wsClassifiedCache = {};
        _classifyVersion++;
        wsChecked.clear();
        wsAbnormalIndex = -1;
        invalidateCaches({ detail: true, raw: true });
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
        updateWSFooter();
        try {
            const result = await loadWSData({ force: true });
            if (hadData && result && result.empty) {
                wsData = oldData;
                wsMachines = oldMachines;
                wsMachineCounts = oldCounts;
                wsClassifiedCache = oldClassified;
                _classifyVersion++;
                invalidateCaches({ detail: true, raw: true });
                renderWSTabs();
                renderWSCategoryBar();
                renderWSTable();
                updateWSFooter();
                showToast('工作台仍返回 0，正在刷新浏览器页面...', 'warning');
                setTimeout(() => {
                    try { window.location.reload(); } catch(e) {}
                }, 800);
            }
        } finally {
            if (isWSVisible()) startWSRefresh();
        }
    }

    const _mcCache = {};
    function clearMachineCache() { for (const k in _mcCache) delete _mcCache[k]; }
    async function loadMachines(dr) {
        if (dr in _mcCache) return _mcCache[dr];
        const data = await fetchJ(WGM + '?Method=FindWGMbyWorkGroup&WorkGroupDR=' + dr);
        const rows = (data && data.rows) ? data.rows : (Array.isArray(data) ? data : []);
        // 不缓存空结果，避免网络异常后永久返回空
        if (rows.length > 0) _mcCache[dr] = rows;
        return rows;
    }

    async function loadWL(mdr, ss) {
        const p = new URLSearchParams();
        p.set('ClassName','LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
        p.set('QueryName','QryWorkList'); p.set('FunModul','MTHD');
        // P0: ReportStatus (空=全部)
        // P1: SttAccDate (开始日期)
        // P2: EndAccDate (结束日期)
        // P10: WorkGroupMachineDR (仪器DR，空=全部)
        // P11: ReportType (N^^^^)
        // P14: SessionStr
        p.set('P0', '');  // 空=全部状态
        p.set('P1', today());
        p.set('P2', today());
        p.set('P10', mdr || '');
        p.set('P11', 'N^^^^');
        p.set('P14', ss);
        const data = await fetchJ(CSP + '?' + p.toString());
        return (data && data.rows) ? data.rows : (Array.isArray(data) ? data : []);
    }


    async function loadPendingForMachine(wgmDR, ss) {
        const p = new URLSearchParams();
        p.set('ClassName', 'LIS.WS.BLL.OT.DHCOTMain');
        p.set('QueryName', 'QryStatVisitStatusDetail');
        p.set('FunModul', 'JSON');
        p.set('P0', wgmDR || '');
        p.set('P1', '0');
        p.set('P14', ss);
        const data = await fetchJ(CSP + '?' + p.toString());
        const rows = (data && data.rows) ? data.rows : (Array.isArray(data) ? data : []);
        return rows.map(r => ({
            ...r,
            ReportDR: 'pending:' + String(wgmDR || '') + ':' + String(r.Labno || '') + ':' + String(r.RegNo || ''),
            Status: '0', ReportStatus: '0', IsComplete: '0',
            EpisodeNo: r.RegNo || '',
            AcceptDT: ((r.AcceptDate || '') + ' ' + (r.AcceptTime || '')).trim(),
            _pending: true
        }));
    }
    function calcMachineCounts() {
        wsMachineCounts = {};
        wsMachineCounts['_all'] = {total:0, normalReady:0, abnormalReady:0, incomplete:0};
        wsData.forEach(r => {
            const mdr = r._mdr || '_unknown';
            if (!wsMachineCounts[mdr]) wsMachineCounts[mdr] = {total:0, normalReady:0, abnormalReady:0, incomplete:0};
            wsMachineCounts[mdr].total++;
            wsMachineCounts['_all'].total++;

            const bucket = getWSAuditBucket(r);
            if (bucket === 'audited' || bucket === 'pending') return;
            if (bucket === 'incomplete') {
                wsMachineCounts[mdr].incomplete++;
                wsMachineCounts['_all'].incomplete++;
                return;
            }
            if (bucket === 'abnormal') {
                wsMachineCounts[mdr].abnormalReady++;
                wsMachineCounts['_all'].abnormalReady++;
            } else if (bucket === 'normal') {
                wsMachineCounts[mdr].normalReady++;
                wsMachineCounts['_all'].normalReady++;
            }
        });
    }

    function getWSAuditBucket(r) {
        const status = String(r.Status || r.ReportStatus || '');
        if (status === '3' || status === '4') return 'audited';
        if (status === '0') return 'pending';
        const complete = String(r.IsComplete || '');
        if (complete !== '1') return 'incomplete';
        const cached = wsClassifiedCache[r.ReportDR];
        if (!cached) return 'incomplete'; // 分类未完成时不进入正常可审，避免误批审
        if (cached.status === 'NORMAL') return 'normal';
        if (cached.status === 'ABNORMAL' || cached.status === 'CRITICAL') return 'abnormal';
        return 'incomplete';
    }

    function getMachineSortRank(machine) {
        const name = ((machine && (machine.CName || machine.Name || machine.RowID)) || '').toLowerCase();
        const wg = String((machine && machine._wg) || '');
        const rules = wg === '1'
            ? [
                ['血细胞', /血细胞|血球|血常规|bc-|xn|xs|sysmex|mindray|迈瑞/],
                ['血凝', /血凝|凝血|coag|cs-|ca-|stago|acl/],
                ['尿液', /尿液|尿沉渣|尿干化|尿常规|uf|uc|urisys|ave/],
                ['粪便', /粪便|大便|便|fec|ob/],
                ['血流变', /血流变|流变|hemorheology/],
                ['手工杂项', /手工|杂项|manual/],
            ]
            : wg === '4'
                ? [
                    ['800', /dxi\s*800|dxi800|化学发光仪800|800/],
                    ['x8', /maglumi\s*x?8|maglumix8|x8/],
                    ['1600', /1600|getein/],
                    ['wan200', /wan\s*200|wan200/],
                    ['手工杂项', /手工|杂项|manual/],
                ]
                : [];
        for (let i = 0; i < rules.length; i++) {
            if (rules[i][1].test(name)) return i;
        }
        return 100;
    }

    function sortWSMachines(machines) {
        return [...machines].sort((a, b) => {
            const ra = getMachineSortRank(a);
            const rb = getMachineSortRank(b);
            if (ra !== rb) return ra - rb;
            const na = a.CName || a.Name || a.RowID || '';
            const nb = b.CName || b.Name || b.RowID || '';
            return na.localeCompare(nb, 'zh');
        });
    }

    function specimenMachineRank(row) {
        const wg = String(row._wg || '');
        const mdr = prWorkGroupMachineDR(row);
        return getMachineSortRank({ CName: row._mn || '', Name: row._mn || '', RowID: mdr, _wg: wg });
    }

    function compareSpecimensByMachineGroup(a, b) {
        const wgA = String(a._wg || '');
        const wgB = String(b._wg || '');
        const wgCmp = wgA.localeCompare(wgB, 'zh');
        if (wgCmp) return wgCmp;

        const rankA = specimenMachineRank(a);
        const rankB = specimenMachineRank(b);
        if (rankA !== rankB) return rankA - rankB;

        const mdrA = prWorkGroupMachineDR(a);
        const mdrB = prWorkGroupMachineDR(b);
        const mdrCmp = String(mdrA).localeCompare(String(mdrB), 'zh');
        if (mdrCmp) return mdrCmp;

        return String(a._mn || '').localeCompare(String(b._mn || ''), 'zh');
    }

    function compareSpecimensForAudit(a, b) {
        const g = compareSpecimensByMachineGroup(a, b);
        if (g) return g;
        const va = String(a.AcceptDT || '');
        const vb = String(b.AcceptDT || '');
        const dtCmp = vb.localeCompare(va, 'zh');
        if (dtCmp) return dtCmp;
        return String(a.Labno || '').localeCompare(String(b.Labno || ''), 'zh');
    }

    function compareAuditQueueItems(a, b) {
        const rowA = resolveQueueItemRow(a) || { _wg: a.wg, _mdr: a.mdr, AcceptDT: '', Labno: a.labno };
        const rowB = resolveQueueItemRow(b) || { _wg: b.wg, _mdr: b.mdr, AcceptDT: '', Labno: b.labno };
        const g = compareSpecimensByMachineGroup(rowA, rowB);
        if (g) return g;
        const va = String(rowA.AcceptDT || '');
        const vb = String(rowB.AcceptDT || '');
        const dtCmp = vb.localeCompare(va, 'zh');
        if (dtCmp) return dtCmp;
        return String(a.labno || '').localeCompare(String(b.labno || ''), 'zh');
    }

    function sortSpecimensForAudit(rows) {
        return [...rows].sort(compareSpecimensForAudit);
    }

    // --- 过滤 & 排序 ---
    function filteredData() {
        // 读取当前搜索框值（不能用旧的 wsSearchQuery）
        const _q = ($('#lis-ws-search') || {}).value || '';
        // 缓存检查
        const ck = wsActiveWG + '|' + wsActiveMachine + '|' + wsCategory + '|' + _q + '|' + (wsSort.field + wsSort.asc) + '|' + _classifyVersion;
        if (_filteredCache && _filteredCacheKey === ck) return _filteredCache;
        let d = [...wsData];
        // 工作组过滤
        if (wsActiveWG) d = d.filter(r => r._wg === wsActiveWG);
        // 仪器过滤
        if (wsActiveMachine) d = d.filter(r => r._mdr === wsActiveMachine);
        // 分类过滤
        if (wsCategory === 'normal') {
            d = d.filter(r => {
                return getWSAuditBucket(r) === 'normal';
            });
        } else if (wsCategory === 'abnormal') {
            d = d.filter(r => {
                return getWSAuditBucket(r) === 'abnormal';
            });
        } else if (wsCategory === 'incomplete') {
            d = d.filter(r => {
                return getWSAuditBucket(r) === 'incomplete';
            });
        } else if (wsCategory === 'pending') {
            d = d.filter(r => {
                return getWSAuditBucket(r) === 'pending';
            });
        }
        // 'all' = 不过滤分类
        // 搜索
        if (_q) {
            const ql = _q.toLowerCase();
            d = d.filter(r =>
                (r.PatName||'').toLowerCase().includes(ql) ||
                (r.Labno||'').toLowerCase().includes(ql) ||
                (r.EpisodeNo||'').toLowerCase().includes(ql) ||
                (r.RegNo||'').toLowerCase().includes(ql) ||
                (r.TestSetDesc||'').toLowerCase().includes(ql)
            );
        }
        wsSearchQuery = _q; // 保存搜索词用于高亮
        // 排序：批审/异常待审按仪器分组，同仪器内再按原排序字段
        const {field, asc} = wsSort;
        if (wsCategory === 'abnormal' || wsCategory === 'normal') {
            d.sort((a, b) => {
                const g = compareSpecimensByMachineGroup(a, b);
                if (g) return g;
                const va = (a[field] || '').toString();
                const vb = (b[field] || '').toString();
                return asc ? va.localeCompare(vb, 'zh') : vb.localeCompare(va, 'zh');
            });
        } else {
            d.sort((a, b) => {
                const va = (a[field] || '').toString();
                const vb = (b[field] || '').toString();
                return asc ? va.localeCompare(vb, 'zh') : vb.localeCompare(va, 'zh');
            });
        }

        dbg('过滤后数据量:', d.length, '分类:', wsCategory);
        _filteredCache = d;
        _filteredCacheKey = ck;
        return d;
    }

    // --- 统一计数：一次遍历产出工作组计数 + 分类计数 ---
    function calcUnifiedCounts() {
        const ck = wsData.length + '|' + wsActiveWG + '|' + wsActiveMachine;
        if (_countsCache && _countsCacheKey === ck) return _countsCache;

        // 工作组计数
        const wgCounts = {};
        WG.forEach(w => { wgCounts[w.dr] = {total:0, normalReady:0, abnormalReady:0, incomplete:0}; });
        // 分类计数（基于当前过滤）
        let normalCount = 0, abnormalCount = 0, incompleteCount = 0, pendingCount = 0;
        // 全部仪器汇总
        const machCounts = {};
        machCounts['_all'] = {total:0, normalReady:0, abnormalReady:0, incomplete:0};

        wsData.forEach(r => {
            // 工作组计数
            const wg = r._wg;
            if (wgCounts[wg]) {
                wgCounts[wg].total++;
            }
            // 仪器计数
            const mdr = r._mdr || '_unknown';
            if (!machCounts[mdr]) machCounts[mdr] = {total:0, normalReady:0, abnormalReady:0, incomplete:0};
            machCounts[mdr].total++;
            machCounts['_all'].total++;

            const bucket = getWSAuditBucket(r);
            if (bucket === 'pending') { pendingCount++; return; }
            if (bucket === 'audited') return;

            if (bucket === 'incomplete') {
                if (wgCounts[wg]) wgCounts[wg].incomplete++;
                machCounts[mdr].incomplete++;
                machCounts['_all'].incomplete++;
                incompleteCount++;
                return;
            }
            if (bucket === 'abnormal') {
                if (wgCounts[wg]) wgCounts[wg].abnormalReady++;
                machCounts[mdr].abnormalReady++;
                machCounts['_all'].abnormalReady++;
                abnormalCount++;
            } else if (bucket === 'normal') {
                if (wgCounts[wg]) wgCounts[wg].normalReady++;
                machCounts[mdr].normalReady++;
                machCounts['_all'].normalReady++;
                normalCount++;
            }
        });

        const result = { wgCounts, machCounts, normalCount, abnormalCount, incompleteCount, pendingCount };
        _countsCache = result;
        _countsCacheKey = ck;
        return result;
    }

    // --- 渲染：头部（简化版）---
    function renderWSHeader() {
        const hd = $('#lis-ws-hd');
        hd.style.flexShrink = '0';
        hd.innerHTML = `
            <div class="ws-title"><span class="ws-title-dot"></span><h3>审核工作台</h3></div>
            <div class="ws-search-wrap">
                <input type="text" class="ws-search" id="lis-ws-search" placeholder="姓名 / 检验号 / 流水号" />
            </div>
            <div class="ws-acts">
                <button class="ws-icon-btn" id="lis-ws-refresh" title="刷新">↻</button>
                <button class="ws-icon-btn" id="lis-ws-pwd" title="CA密码">钥</button>
                <button class="ws-icon-btn danger" id="lis-ws-close" title="关闭">×</button>
            </div>`;


        
        // 初始检查CA状态
        document.getElementById('lis-ws-refresh').addEventListener('click', () => {
            dbg('刷新按钮被点击');
            const btn = document.getElementById('lis-ws-refresh');
            if (btn) btn.classList.add('spinning');
            forceRefreshWS().finally(() => {
                if (btn) { btn.classList.remove('spinning'); }
            });
        });
        document.getElementById('lis-ws-close').addEventListener('click', closeWS);
        document.getElementById('lis-ws-pwd').addEventListener('click', openPwdDlg);
        document.getElementById('lis-ws-search').addEventListener('input', () => {
            invalidateCaches();
            clearTimeout(_wsSearchTimer);
            _wsSearchTimer = setTimeout(() => renderWSTable(), 200);
        });
    }

    // --- 渲染：仪器标签栏（两级：工作组 + 仪器）---
    function renderWSTabs() {
        const tabs = $('#lis-ws-tabs');
        if (!tabs) return;
        tabs.style.flexShrink = '0';
        const mc = wsMachineCounts;

        // 按工作组统计
        const wgCounts = {};
        WG.forEach(w => { wgCounts[w.dr] = {total:0, normalReady:0, abnormalReady:0}; });
        wsData.forEach(r => {
            const wg = r._wg;
            if (!wgCounts[wg]) return;
            wgCounts[wg].total++;
            const bucket = getWSAuditBucket(r);
            if (bucket === 'normal') wgCounts[wg].normalReady++;
            else if (bucket === 'abnormal') wgCounts[wg].abnormalReady++;
        });

        // 第一行：工作组标签
        let h = '<div class="ws-wg-row">';
        WG.forEach(w => {
            const c = wgCounts[w.dr] || {total:0};
            h += `<button class="ws-wg-tab ${wsActiveWG===w.dr?'on':''}" data-wg="${w.dr}">
                <span class="ws-tab-name">${w.name}</span>
                <span class="ws-tab-stat">正常${c.normalReady || 0}</span>
                <span class="ws-tab-stat">异常${c.abnormalReady || 0}</span>
                <span class="mach-cnt">总${c.total}</span>
            </button>`;
        });
        // 全部工作组
        const allTotal = WG.reduce((s,w) => s + (wgCounts[w.dr]?.total||0), 0);
        const allNormal = WG.reduce((s,w) => s + (wgCounts[w.dr]?.normalReady||0), 0);
        const allAbnormal = WG.reduce((s,w) => s + (wgCounts[w.dr]?.abnormalReady||0), 0);
        h += `<button class="ws-wg-tab ${!wsActiveWG?'on':''}" data-wg="">
            <span class="ws-tab-name">全部</span>
            <span class="ws-tab-stat">正常${allNormal}</span>
            <span class="ws-tab-stat">异常${allAbnormal}</span>
            <span class="mach-cnt">总${allTotal}</span>
        </button>`;
        h += '</div>';

        // 第二行：仪器标签（仅显示选中工作组的仪器）
        h += '<div class="ws-mach-row">';
        // 全部仪器按钺（按当前工作组筛选）
        let ac = mc['_all'] || {total:0, normalReady:0, abnormalReady:0, incomplete:0};
        if (wsActiveWG) {
            ac = {total:0, normalReady:0, abnormalReady:0, incomplete:0};
            sortWSMachines(wsMachines.filter(m => m._wg === wsActiveWG)).forEach(m => {
                const mc2 = mc[m.RowID] || {total:0, normalReady:0, abnormalReady:0, incomplete:0};
                ac.total += mc2.total; ac.normalReady += mc2.normalReady;
                ac.abnormalReady += mc2.abnormalReady; ac.incomplete += mc2.incomplete;
            });
        }
        h += `<button class="ws-mach-tab ${!wsActiveMachine?'on':''}" data-m="">
            <span class="ws-tab-name">全部仪器</span>
            <span class="mach-cnt">${ac.total}</span>
        </button>`;

        // 筛选当前工作组的仪器
        const wgMachines = sortWSMachines(wsMachines.filter(m => !wsActiveWG || m._wg === wsActiveWG));
        wgMachines.forEach(m => {
            const c = mc[m.RowID] || {total:0, normalReady:0, abnormalReady:0, incomplete:0};
            h += `<button class="ws-mach-tab ${wsActiveMachine===m.RowID?'on':''}" data-m="${escAttr(m.RowID)}">
                <span class="ws-tab-name">${esc(m.CName||m.Name)}</span>
                <span class="mach-cnt">${c.total}</span>
            </button>`;
        });
        h += '</div>';

        tabs.innerHTML = h;

        // 工作组标签事件
        tabs.querySelectorAll('.ws-wg-tab').forEach(b => b.addEventListener('click', () => {
            invalidateCaches();
            wsActiveWG = b.dataset.wg;
            wsActiveMachine = '';
            wsAbnormalIndex = -1;
            wsChecked.clear();
            saveWSState();
            renderWSTabs();
            renderWSCategoryBar();
            renderWSTable();
        }));

        // 仪器标签事件
        tabs.querySelectorAll('.ws-mach-tab').forEach(b => b.addEventListener('click', () => {
            invalidateCaches();
            wsActiveMachine = b.dataset.m;
            wsAbnormalIndex = -1;
            wsChecked.clear();
            saveWSState();
            renderWSTabs();
            renderWSCategoryBar();
            renderWSTable();
        }));
    }

    // --- 渲染：分类标签栏 ---
    function renderWSCategoryBar() {
        const bar = $('#lis-ws-bar');
        if (!bar) return;
        bar.style.flexShrink = '0';

        // 统计各分类数量（基于当前工作组+仪器过滤）
        let filtered = wsData;
        if (wsActiveWG) filtered = filtered.filter(r => r._wg === wsActiveWG);
        if (wsActiveMachine) filtered = filtered.filter(r => r._mdr === wsActiveMachine);

        let normalCount = 0, abnormalCount = 0, incompleteCount = 0, pendingCount = 0;
        filtered.forEach(r => {
            const bucket = getWSAuditBucket(r);
            if (bucket === 'normal') normalCount++;
            else if (bucket === 'abnormal') abnormalCount++;
            else if (bucket === 'incomplete') incompleteCount++;
            else if (bucket === 'pending') pendingCount++;
        });
        const totalCount = filtered.length;

        let h = '';

        // 左侧：一键批审按钮（放在最前面，避免被详情面板遮挡）
        if (wsCategory === 'normal' && normalCount > 0) {
            h += `<button class="nb-btn" id="lis-ws-batch" style="padding:5px 16px;font-size:12px;margin-right:8px">⚡ 一键批审 ${normalCount}</button>`;
        }

        h += `<button class="cat-tab cat-normal ${wsCategory==='normal'?'on':''}" data-cat="normal">
            ✅ 正常可审 <span class="cat-cnt">${normalCount}</span>
        </button>`;
        h += `<button class="cat-tab cat-abnormal ${wsCategory==='abnormal'?'on':''}" data-cat="abnormal">
            ⚠️ 异常待审 <span class="cat-cnt">${abnormalCount}</span>
        </button>`;
        h += `<button class="cat-tab cat-incomplete ${wsCategory==='incomplete'?'on':''}" data-cat="incomplete">
            📋 结果不完整 <span class="cat-cnt">${incompleteCount}</span>
        </button>`;
        h += `<button class="cat-tab cat-pending ${wsCategory==='pending'?'on':''}" data-cat="pending">
            📝 待排样 <span class="cat-cnt">${pendingCount}</span>
        </button>`;
        h += `<button class="cat-tab ${wsCategory==='all'?'on':''}" data-cat="all">
            📃 全部标本 <span class="cat-cnt">${totalCount}</span>
        </button>`;

        // 右侧：统计信息
        h += '<div class="cat-right">';
        if (wsCategory === 'abnormal' && abnormalCount > 0) {
            h += '<span class="cat-stats"><kbd>Enter</kbd> 审核 <kbd>↑↓</kbd> 移动</span>';
        }
        const fd = filteredData();
        h += `<span class="cat-stats">${fd.length} / ${totalCount} 条</span>`;
        h += '</div>';

        bar.innerHTML = h;
        updateWSFooter({ visible: fd.length, total: totalCount, normal: normalCount, abnormal: abnormalCount, incomplete: incompleteCount, pending: pendingCount });

        // 分类标签事件
        bar.querySelectorAll('.cat-tab').forEach(b => b.addEventListener('click', () => {
            invalidateCaches();
            wsCategory = b.dataset.cat;
            wsAbnormalIndex = -1;
            // 不清空 wsChecked，保留用户勾选
            saveWSState();
            renderWSCategoryBar();
            renderWSTable();
            if (wsCategory === 'abnormal') prefetchAbnormalAuditContext();
        }));

        // 一键批审按钮事件
        const batchBtn = document.getElementById('lis-ws-batch');
        if (batchBtn) {
            batchBtn.onclick = (ev) => {
                ev.stopPropagation();
                dbg('一键批审按钮被点击');
                try {
                    // 重新计算过滤数据（不依赖闭包中的 filtered）
                    let currentFiltered = wsData;
                    if (wsActiveWG) currentFiltered = currentFiltered.filter(r => r._wg === wsActiveWG);
                    if (wsActiveMachine) currentFiltered = currentFiltered.filter(r => r._mdr === wsActiveMachine);

                    // 智能选择：有勾选则只审选中的，否则审全部正常标本
                    let sourceData;
                    if (wsChecked.size > 0) {
                        sourceData = currentFiltered.filter(r => wsChecked.has(r.ReportDR));
                    } else {
                        sourceData = currentFiltered;
                    }
                    const normalData = sourceData.filter(r => {
                        const status = String(r.Status || r.ReportStatus || '');
                        if (status === '3' || status === '4') return false;
                        const complete = String(r.IsComplete || '');
                        if (complete !== '1') return false;
                        const cached = wsClassifiedCache[r.ReportDR];
                        return cached && cached.status === 'NORMAL';
                    }).map(r => ({ status: 'NORMAL', items: [], row: r, reportDR: r.ReportDR }));
                    if (normalData.length === 0) {
                        if (wsClassifying) {
                            showToast('标本正在分类中，请稍候再试', 'warning');
                        } else {
                            showToast('没有可审核的正常标本', 'warning');
                        }
                        return;
                    }
                    dbg('一键批审:', normalData.length, '个标本');
                    confirmAndBatchAudit(normalData);
                } catch(e) {
                    dbg('一键批审错误:', e);
                    showToast('批审出错: ' + e.message, 'error');
                }
            };
        }
    }

    // --- 渲染：数据表 ---
    // --- 渲染：数据表（分发到各分类视图）---
    let _abnormalKeyHandler = null; // 异常视图键盘监听器
    let _abnormalKeyTargets = [];
    function _rebindAbnormalKeyHandler() {
        if (_abnormalKeyHandler) return;
        _abnormalKeyHandler = e => {
            if (isPatientResultPanelEvent(e)) return;
            if (isEditableEventTarget(e)) return;
            if (wsCategory !== 'abnormal') return;
            if (detailPanel && detailPanel.classList.contains('show')) return;
            if (e.defaultPrevented) return;
            if (_abnormalAuditInProgress) {
                if (e.key === 'Enter') {
                    e.preventDefault(); e.stopImmediatePropagation();
                    _abnormalAuditQueued = true;
                    const ft = document.getElementById('lis-ws-ft-stat');
                    if (ft) ft.textContent = '审核进行中，下一条已排队...';
                }
                return;
            }
            const curData = filteredData();
            if (!curData.length) return;
            if (wsAbnormalIndex < 0 || wsAbnormalIndex >= curData.length) wsAbnormalIndex = 0;
            if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveAbnormalFocus(1, curData); }
            else if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveAbnormalFocus(-1, curData); }
            else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault(); e.stopImmediatePropagation();
                const sp = getAbnormalFocusSpecimen(curData);
                if (!sp) return;
                markAbnormalAuditUI(sp, 'start');
                void auditAbnormalSpecimen(sp);
            }
            else if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault(); e.stopImmediatePropagation();
                const sp = getAbnormalFocusSpecimen(curData);
                if (sp) openDetailPanel(sp, 'abnormal', wsAbnormalIndex);
            }
            else if (e.key === 'Escape') { wsCategory = 'normal'; saveWSState(); renderWSCategoryBar(); renderWSTable(); }
        };
        _abnormalKeyTargets = [document];
        const iframeWin = getReportIframeWin();
        if (iframeWin && iframeWin.document && iframeWin.document !== document) _abnormalKeyTargets.push(iframeWin.document);
        _abnormalKeyTargets.forEach(doc => {
            try { doc.addEventListener('keydown', _abnormalKeyHandler, true); } catch(e) {}
        });
    }

    function _removeAbnormalKeyHandler() {
        if (!_abnormalKeyHandler) return;
        (_abnormalKeyTargets.length ? _abnormalKeyTargets : [document]).forEach(doc => {
            try { doc.removeEventListener('keydown', _abnormalKeyHandler, true); } catch(e) {}
        });
        _abnormalKeyTargets = [];
        _abnormalKeyHandler = null;
    }

    function renderWSTable() {
        const body = $('#lis-ws-body');
        if (!body) return;
        // 强制 flex 和滚动（LIS 系统 CSS 会覆盖）
        body.style.cssText = 'flex:1!important;overflow:auto!important;min-height:0!important;position:relative';
        // 移除旧的异常视图键盘监听
        _removeAbnormalKeyHandler();
        if (_normalKeyHandler) {
            document.removeEventListener('keydown', _normalKeyHandler);
            _normalKeyHandler = null;
        }

        const data = filteredData();
        if (data.length === 0) {
            body.innerHTML = '<div class="ws-empty"><div class="ico">📭</div>暂无标本数据</div>';
            return;
        }

        switch (wsCategory) {
            case 'normal':   renderNormalView(data, body); break;
            case 'abnormal': renderAbnormalView(data, body); break;
            case 'incomplete': renderIncompleteView(data, body); break;
            default:         renderAllView(data, body); break;
        }

        // 安全网：异常视图下确保键盘 handler 存在
        if (wsCategory === 'abnormal' && !_abnormalKeyHandler) {
            _rebindAbnormalKeyHandler();
        }
        // 正常/全部/不完整视图：Escape 关闭工作台
        if (wsCategory !== 'abnormal') {
            _normalKeyHandler = (e) => {
                if (isPatientResultPanelEvent(e)) return;
                if (e.key === 'Escape') { e.preventDefault(); closeWS(); }
            };
            document.addEventListener('keydown', _normalKeyHandler);
        }
    }

    function updateWSFooter(counts) {
        const ft = document.getElementById('lis-ws-ft-stat');
        if (!ft) return;
        if (!counts) {
            counts = { visible: filteredData().length, total: wsData.length };
        }
        const groupName = wsActiveWG ? ((WG_MAP[wsActiveWG] || {}).name || wsActiveWG) : '全部工作组';
        const machineName = wsActiveMachine ? ((wsMachines.find(m => String(m.RowID) === String(wsActiveMachine)) || {}).CName || (wsMachines.find(m => String(m.RowID) === String(wsActiveMachine)) || {}).Name || '当前仪器') : '全部仪器';
        const parts = [`${groupName}`, `${machineName}`, `${counts.visible}/${counts.total || 0}条`];
        if (typeof counts.normal === 'number') parts.push(`正常${counts.normal}`);
        if (typeof counts.abnormal === 'number') parts.push(`异常${counts.abnormal}`);
        if (wsLoading) parts.push('刷新中');
        ft.textContent = parts.join(' · ');
    }

    // --- 正常可审视图 ---
    function renderNormalView(data, body) {
        let h = `<div class="ws-normal-banner">
            <span class="nb-text">✅ ${data.length} 个标本结果正常，可一键审核</span>
            <button class="nb-btn" id="lis-norm-batch">⚡ 一键批审 ${data.length}</button>
        </div>`;

        h += '<table><thead><tr>';
        h += '<th style="width:30px"><input type="checkbox" id="lis-ws-chka" /></th>';
        h += '<th>仪器</th><th>姓名</th><th>检验号</th><th>医嘱</th><th>核收时间</th>';
        h += '</tr></thead><tbody>';

        data.forEach((r, i) => {
            const ck = wsChecked.has(r.ReportDR) ? 'checked' : '';
            h += `<tr class="${wsChecked.has(r.ReportDR)?'sel':''}" data-i="${i}" data-rdr="${escAttr(r.ReportDR||'')}">`;
            h += `<td><input type="checkbox" class="lis-ws-ck" data-rdr="${escAttr(r.ReportDR||'')}" ${ck} /></td>`;
            h += `<td>${highlightText(r._mn||'', wsSearchQuery)}</td>`;
            h += `<td>${highlightText(r.PatName||'', wsSearchQuery)}</td>`;
            h += `<td><b>${highlightText(r.Labno||'', wsSearchQuery)}</b></td>`;
            h += `<td>${highlightText(r.TestSetDesc||'', wsSearchQuery)}</td>`;
            h += `<td>${esc(r.AcceptDT||'')}</td>`;
            h += '</tr>';
        });
        h += '</tbody></table>';
        body.innerHTML = h;

        // 一键批审按钮
        const batchBtn = document.getElementById('lis-norm-batch');
        if (batchBtn) {
            batchBtn.addEventListener('click', () => {
                const formatted = data
                    .map(r => wsClassifiedCache[r.ReportDR])
                    .filter(c => c && c.status === 'NORMAL');
                if (formatted.length !== data.length) {
                    showToast('部分标本尚未完成正常分类，请稍候刷新后再批审', 'warning');
                    return;
                }
                confirmAndBatchAudit(formatted);
            });
        }

        _bindTableEvents(body, data, 'normal');
    }

    function getAbnormalFocusSpecimen(data) {
        data = data || filteredData();
        if (!data.length) return null;
        const focused = document.querySelector('.ws-abnormal-card.focused');
        const focusDR = (focused && focused.dataset.rdr) || _abnormalFocusDR;
        if (focusDR) {
            const sp = findWSSpecimenByReportDR(focusDR);
            if (sp) {
                const idx = data.findIndex(r => String(r.ReportDR) === String(sp.ReportDR));
                if (idx >= 0) wsAbnormalIndex = idx;
                return sp;
            }
        }
        if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) wsAbnormalIndex = 0;
        return data[wsAbnormalIndex] || null;
    }

    // --- 异常待审视图（卡片式）---
    function renderAbnormalView(data, body) {
        if (_abnormalFocusDR) {
            const idx = data.findIndex(r => String(r.ReportDR) === String(_abnormalFocusDR));
            wsAbnormalIndex = idx >= 0 ? idx : (data.length ? 0 : -1);
        } else if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) {
            wsAbnormalIndex = data.length ? 0 : -1;
        }

        let h = `<div class="ws-abnormal-hint">
            <kbd>Enter</kbd> 审核 <kbd>↑↓</kbd> 切换 <kbd>点击</kbd> 详情 · 按仪器分组，审完一台再换下一台
        </div>`;
        h += '<div class="ws-abnormal-list">';

        let lastMachineKey = '';
        data.forEach((r, i) => {
            const machineKey = String(r._wg || '') + '|' + String(prWorkGroupMachineDR(r) || r._mn || '');
            if (machineKey !== lastMachineKey) {
                const machineLabel = r._mn || prWorkGroupMachineDR(r) || '未知仪器';
                h += `<div class="ws-abnormal-machine">🔬 ${esc(machineLabel)}</div>`;
                lastMachineKey = machineKey;
            }
            const cached = wsClassifiedCache[r.ReportDR];
            const items = cached ? cached.items : [];
            const abnormalItems = items.filter(it => it.status !== 'NORMAL');
            const hasCritical = (cached && cached.status === 'CRITICAL') || items.some(it => it.status === 'CRITICAL' || it.critical);
            const hasInfectionWarning = cached && cached.infectionWarning;
            const focused = i === wsAbnormalIndex ? ' focused' : '';

            h += `<div class="ws-abnormal-card${focused}${hasCritical ? ' has-critical' : ''}${hasInfectionWarning ? ' has-infection-warning' : ''}" data-i="${i}" data-rdr="${escAttr(r.ReportDR||'')}">`;
            h += `<span class="ab-card-name">${highlightText(r.PatName||'', wsSearchQuery)}</span>`;
            h += `<span class="ab-card-no">${highlightText(r.Labno||'', wsSearchQuery)}</span>`;
            h += `<span class="ab-card-test">${highlightText(r._mn||'', wsSearchQuery)}</span>`;
            h += '<div class="ab-card-items">';
            // 如果分类缓存没有具体项目，尝试从详情缓存获取
            let displayItems = abnormalItems;
            if (displayItems.length === 0 && !hasInfectionWarning) {
                const detailCached = detailLRUGet(r.ReportDR); // 需要提升优先级，因为用户可能点击查看
                if (detailCached && detailCached.html) {
                    // 从详情缓存 HTML 中提取异常项目
                    const _tmp = document.createElement('div');
                    _tmp.innerHTML = detailCached.html;
                    _tmp.querySelectorAll('tr').forEach(tr => {
                        const cls = tr.querySelector('td.abnormal');
                        if (cls) {
                            const tds = tr.querySelectorAll('td');
                            if (tds.length >= 4) {
                                const name = (tds[0].textContent||'').trim();
                                const result = (tds[1].textContent||'').trim();
                                const status = (tds[3].textContent||'').trim();
                                if (name && name !== '项目') displayItems.push({name, result, status: status.includes('高')?'HIGH':status.includes('低')?'LOW':'ABNORMAL'});
                            }
                        }
                    });
                }
                // 如果仍然没有，显示所有有结果的项目（可能 AbFlag 未标记）
                if (displayItems.length === 0 && items.length > 0) {
                    displayItems = items.filter(it => !isEmptyResultValue(it, it.result));
                }
            }
            displayItems.forEach(it => {
                let cls = 'uncertain';
                const st = it.status || '';
                if (st === 'CRITICAL') cls = 'critical';
                else if (st === 'HIGH') cls = 'high';
                else if (st === 'LOW') cls = 'low';
                else if (st === 'ABNORMAL') cls = 'abnormal';
                const prefix = st === 'CRITICAL' ? '危急 ' : '';
                h += `<span class="ab-card-item ${cls}">${esc(prefix+it.name+' '+it.result+(it.unit||''))}</span>`;
            });
            if (hasInfectionWarning) {
                h += `<span class="ab-card-item infection-warning">⚠ ${esc(cached.infectionWarning)}</span>`;
            }
            if (hasCritical && !displayItems.some(it => it.status === 'CRITICAL' || it.critical)) {
                h += '<span class="ab-card-item critical">🚨 危急值</span>';
            }
            if (displayItems.length === 0 && !hasInfectionWarning) {
                h += '<span class="ab-card-item uncertain">⚠ 待确认</span>';
            }
            h += '</div>';
            if (hasCritical) {
                h += `<span class="ab-card-hint" style="color:#c62828;font-weight:600">🚨 危急值</span>`;
            } else if (hasInfectionWarning) {
                h += `<span class="ab-card-hint" style="color:#e65100;font-weight:600">⚠ 历史不一致</span>`;
            } else {
                h += `<span class="ab-card-hint">Enter=审核</span>`;
            }
            h += '</div>';
        });
        h += '</div>';
        body.innerHTML = h;

        // 卡片点击 → 更新聚焦 + 打开详情
        body.querySelectorAll('.ws-abnormal-card').forEach(card => {
            card.addEventListener('click', () => {
                const specimen = findWSSpecimenByReportDR(card.dataset.rdr);
                if (!specimen) return;
                _abnormalFocusDR = String(specimen.ReportDR || '');
                const cards = document.querySelectorAll('.ws-abnormal-card');
                cards.forEach(c => c.classList.remove('focused'));
                card.classList.add('focused');
                wsAbnormalIndex = Math.max(0, filteredData().findIndex(r => String(r.ReportDR) === String(specimen.ReportDR)));
                openDetailPanel(specimen, 'abnormal', wsAbnormalIndex);
            });
        });

        // 键盘导航
        _rebindAbnormalKeyHandler();

        // 滚动到聚焦卡片
        _scrollAbnormalFocus();
        scheduleAbnormalAuditPrewarm();
    }

    function moveAbnormalFocus(dir, data) {
        data = data || filteredData();
        if (!data.length) return;
        const cur = getAbnormalFocusSpecimen(data);
        let idx = cur ? data.findIndex(r => String(r.ReportDR) === String(cur.ReportDR)) : wsAbnormalIndex;
        if (idx < 0) idx = 0;
        idx = Math.max(0, Math.min(data.length - 1, idx + dir));
        wsAbnormalIndex = idx;
        _abnormalFocusDR = String(data[idx].ReportDR || '');
        document.querySelectorAll('.ws-abnormal-card').forEach(c => c.classList.remove('focused'));
        const card = [...document.querySelectorAll('.ws-abnormal-card')].find(c => String(c.dataset.rdr) === _abnormalFocusDR);
        if (card) card.classList.add('focused');
        _scrollAbnormalFocus();
        scheduleAbnormalAuditPrewarm();
    }

    function _scrollAbnormalFocus() {
        const cards = document.querySelectorAll('.ws-abnormal-card');
        if (cards[wsAbnormalIndex]) {
            cards[wsAbnormalIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    function advanceAbnormalFocusAfterSkip(startIndex) {
        _abnormalNativeReadyDR = '';
        const data = filteredData();
        const cards = document.querySelectorAll('.ws-abnormal-card');
        if (!data.length || !cards.length) return;
        if (cards[wsAbnormalIndex]) cards[wsAbnormalIndex].classList.remove('focused');
        if (data.length === 1) {
            wsAbnormalIndex = 0;
        } else {
            wsAbnormalIndex = Math.min(Math.max(startIndex, 0), data.length - 1);
            wsAbnormalIndex = (wsAbnormalIndex + 1) % data.length;
        }
        if (cards[wsAbnormalIndex]) cards[wsAbnormalIndex].classList.add('focused');
        if (data[wsAbnormalIndex]) _abnormalFocusDR = String(data[wsAbnormalIndex].ReportDR || '');
        _scrollAbnormalFocus();
    }

    function nextPaint() {
        return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    }

    function clearAbnormalAuditingCard(reportDR) {
        const card = [...document.querySelectorAll('.ws-abnormal-card[data-rdr]')].find(c => String(c.dataset.rdr || '') === String(reportDR || ''));
        if (!card) return;
        card.classList.remove('auditing');
        card.removeAttribute('aria-busy');
        const hint = card.querySelector('.ab-card-hint');
        if (hint && hint.textContent === '正在审核...') hint.textContent = 'Enter=审核';
    }

    async function confirmAuditEventually(iframeWin, reportDR, patientName, options = {}) {
        const batchMode = !!options.batchMode;
        const ft = document.getElementById('lis-ws-ft-stat');
        if (ft) ft.textContent = `正在确认审核结果：${patientName || reportDR}`;
        const targetWasPresent = !!findNativeRowByReportDR(iframeWin, reportDR);
        const confirmed = await waitNativeActionResult(iframeWin, reportDR, ['3'], batchMode ? 2200 : 12000, true, { targetWasPresent, missingStableMs: batchMode ? 400 : 900, turbo: batchMode });
        if (confirmed && confirmed !== 'incomplete') return true;
        await sleep(batchMode ? 100 : 1500);
        const latestWin = getReportIframeWin() || iframeWin;
        const found = findNativeRowByReportDR(latestWin, reportDR);
        if (!found) return targetWasPresent;
        return isExpectedNativeStatus(found.row, ['3']);
    }

    let _abnormalAuditInProgress = false;
    let _abnormalAuditQueued = false;
    let _abnormalLastMdr = '';
    let _abnormalNativeReadyDR = '';
    let _abnormalPrewarmTimer = null;
    let _abnormalPrewarmDR = '';
    let _abnormalPrewarmPromise = null;
    let _reportPageLoadPromise = null;
    let _nativeUserSelectDR = '';
    let _nativeUserSelectAt = 0;
    let _nativeGuardTimer = null;

    function markAbnormalAuditUI(specimen, phase) {
        if (!specimen) return;
        const targetDR = String(specimen.ReportDR || '');
        const ft = document.getElementById('lis-ws-ft-stat');
        const name = specimen.PatName || specimen.Labno || targetDR;
        const card = [...document.querySelectorAll('.ws-abnormal-card[data-rdr]')].find(c => c.dataset.rdr === targetDR);
        if (phase === 'start' && ft) ft.textContent = `异常审核：准备 ${name}`;
        if (card && phase === 'start') {
            card.classList.add('auditing');
            card.setAttribute('aria-busy', 'true');
            const hint = card.querySelector('.ab-card-hint');
            if (hint) hint.textContent = '正在审核...';
        }
    }

    function prefetchReportPageForWS() {
        const existing = getReportIframeWin();
        if (existing) {
            installNativeDetailGuard(existing);
            return Promise.resolve(existing);
        }
        if (!_reportPageLoadPromise) {
            _reportPageLoadPromise = ensureReportPageLoaded({ keepWS: true, fast: true }).then(w => {
                if (w) installNativeDetailGuard(w);
                scheduleNativeDetailGuardInstall();
                return w;
            }).finally(() => {
                _reportPageLoadPromise = null;
            });
        }
        return _reportPageLoadPromise;
    }

    function prefetchAbnormalAuditContext() {
        if (wsCategory !== 'abnormal' || _abnormalAuditInProgress) return;
        scheduleAbnormalAuditPrewarm(0);
    }

    function scheduleAbnormalAuditPrewarm(delayMs) {
        if (wsCategory !== 'abnormal' || _abnormalAuditInProgress || !isWSVisible()) return;
        clearTimeout(_abnormalPrewarmTimer);
        const delay = typeof delayMs === 'number' ? delayMs : 0;
        _abnormalPrewarmTimer = setTimeout(() => {
            const data = filteredData();
            if (!data.length) return;
            if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) wsAbnormalIndex = 0;
            prewarmAbnormalAuditNative(data[wsAbnormalIndex]).catch(() => {});
        }, delay);
    }

    function isAbnormalSpecimenReady(reportDR) {
        const iframeWin = getReportIframeWin();
        return !!(iframeWin && reportDR && isReportDetailLoaded(iframeWin, reportDR));
    }

    async function prewarmAbnormalAuditNative(specimen) {
        if (!specimen || _abnormalAuditInProgress || !isWSVisible()) return;
        const reportDR = String(specimen.ReportDR || '');
        if (isAbnormalSpecimenReady(reportDR)) {
            _abnormalNativeReadyDR = reportDR;
            _abnormalPrewarmDR = reportDR;
            return;
        }
        if (_abnormalPrewarmPromise && _abnormalPrewarmDR === reportDR) {
            return _abnormalPrewarmPromise;
        }
        _abnormalPrewarmDR = reportDR;
        _abnormalPrewarmPromise = (async () => {
            let iframeWin = await prefetchReportPageForWS();
            if (!iframeWin) iframeWin = getReportIframeWin();
            if (!iframeWin) return;
            const item = specimenToAuditItem(specimen);
            const mdrKey = String(item.mdr || '');
            if (mdrKey) {
                const mdrChanged = mdrKey !== String(_abnormalLastMdr || '');
                const nativeMismatch = !nativeMachineMatches(iframeWin, mdrKey);
                if (mdrChanged || nativeMismatch) {
                    iframeWin = await refreshNativeWorkListForItem(iframeWin, item, { force: true, fast: true });
                    _abnormalLastMdr = mdrKey;
                } else {
                    _abnormalLastMdr = mdrKey;
                }
            }
            iframeWin = getReportIframeWin() || iframeWin;
            installNativeDetailGuard(iframeWin);
            if (!canScriptSelectNativeRow(iframeWin, reportDR)) {
                dbg('预热跳过：用户正在原生列表查看其他标本');
                return;
            }
            if (item.labno && typeof iframeWin.FindFast === 'function') {
                try { iframeWin.FindFast(item.labno); await sleep(60); } catch(e) {}
                iframeWin = getReportIframeWin() || iframeWin;
            }
            if (!selectNativeRowByReportDR(iframeWin, reportDR)) {
                await waitAndSelectNativeRow(iframeWin, item, { timeoutMs: 2800, pollMs: 30, skipListRefresh: !!mdrKey });
                iframeWin = getReportIframeWin() || iframeWin;
            }
            if (!isReportDetailLoaded(iframeWin, reportDR)) {
                await waitReportDetailReady(iframeWin, reportDR, 4500, { fastBatch: true });
            }
            iframeWin = getReportIframeWin() || iframeWin;
            if (isReportDetailLoaded(iframeWin, reportDR)) {
                _abnormalNativeReadyDR = reportDR;
            }
        })().finally(() => {
            if (_abnormalPrewarmDR === reportDR) _abnormalPrewarmPromise = null;
        });
        return _abnormalPrewarmPromise;
    }

    async function awaitAbnormalPrewarm(specimen) {
        try { await prewarmAbnormalAuditNative(specimen); } catch(e) {}
    }

    function specimenToAuditItem(specimen) {
        return {
            reportDR: specimen.ReportDR,
            mdr: prWorkGroupMachineDR(specimen) || '',
            labno: specimen.Labno || ''
        };
    }

    function nativeMachineMatches(iframeWin, mdrKey) {
        if (!mdrKey || !iframeWin || !iframeWin.me) return false;
        return String(iframeWin.me.WorkGroupMachineDR || '') === String(mdrKey);
    }

    async function ensureSpecimenReadyForAudit(iframeWin, specimen, ctx = {}) {
        const reportDR = specimen.ReportDR;
        const item = specimenToAuditItem(specimen);
        const mdrKey = String(item.mdr || '');
        const fast = !!ctx.abnormalFast;
        iframeWin = getReportIframeWin() || iframeWin;

        if (isReportDetailLoaded(iframeWin, reportDR)) {
            return { ok: true, iframeWin, lastMdr: ctx.lastMdr || mdrKey };
        }

        const mdrChanged = !!(mdrKey && mdrKey !== String(ctx.lastMdr || ''));
        const nativeMismatch = !!(mdrKey && !nativeMachineMatches(iframeWin, mdrKey));
        if (!mdrChanged && !nativeMismatch && selectNativeRowByReportDR(iframeWin, reportDR)) {
            if (isReportDetailLoaded(iframeWin, reportDR)) {
                return { ok: true, iframeWin, lastMdr: ctx.lastMdr || mdrKey };
            }
        }

        let listFresh = false;
        if (mdrKey && (mdrChanged || nativeMismatch)) {
            iframeWin = await refreshNativeWorkListForItem(iframeWin, item, { force: true, fast });
            ctx.lastMdr = mdrKey;
            listFresh = true;
        } else if (mdrKey) {
            ctx.lastMdr = mdrKey;
        }
        iframeWin = getReportIframeWin() || iframeWin;

        let selected = false;
        if (ctx.skipSelect) {
            selected = selectNativeRowByReportDR(iframeWin, reportDR);
        }
        if (!selected && !selectNativeRowByReportDR(iframeWin, reportDR)) {
            const selResult = await waitAndSelectNativeRow(iframeWin, item, {
                timeoutMs: fast ? (listFresh ? 2200 : 3000) : (listFresh ? 3500 : 5000),
                pollMs: fast ? 30 : 40,
                skipListRefresh: listFresh
            });
            if (!selResult.ok) return { ok: false, reason: 'select', iframeWin: selResult.iframeWin || iframeWin };
            iframeWin = selResult.iframeWin || iframeWin;
        }
        if (!isReportDetailLoaded(iframeWin, reportDR)) {
            const t1 = fast ? 3000 : 5000;
            const t2 = fast ? 1500 : 2500;
            let ready = await waitReportDetailReady(iframeWin, reportDR, t1, { fastBatch: true });
            if (!ready) {
                selectNativeRowByReportDR(iframeWin, reportDR);
                ready = await waitReportDetailReady(iframeWin, reportDR, t2, { fastBatch: true });
            }
            if (!ready) return { ok: false, reason: 'detail', iframeWin };
        }
        return { ok: true, iframeWin, lastMdr: ctx.lastMdr || mdrKey };
    }

    function removeAuditedAbnormalCard(reportDR, startIndex) {
        const q = ($('#lis-ws-search') || {}).value || '';
        if (q) {
            renderWSCategoryBar();
            renderWSTable();
            return;
        }
        const escDR = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(String(reportDR || '')) : String(reportDR || '').replace(/"/g, '\\"');
        const card = document.querySelector(`.ws-abnormal-card[data-rdr="${escDR}"]`);
        const list = card && card.parentElement;
        if (card) {
            const prev = card.previousElementSibling;
            const next = card.nextElementSibling;
            card.remove();
            if (prev && prev.classList && prev.classList.contains('ws-abnormal-machine')) {
                const nextIsCard = next && next.classList && next.classList.contains('ws-abnormal-card');
                if (!nextIsCard) prev.remove();
            }
        }

        const newData = filteredData();
        if (newData.length === 0) {
            wsCategory = 'normal';
            wsAbnormalIndex = -1;
            renderWSCategoryBar();
            renderWSTable();
            return;
        }

        wsAbnormalIndex = Math.min(Math.max(startIndex, 0), newData.length - 1);
        const cards = list ? [...list.querySelectorAll('.ws-abnormal-card')] : [];
        cards.forEach((c, i) => {
            c.dataset.i = String(i);
            c.classList.remove('focused');
        });
        if (cards[wsAbnormalIndex]) {
            cards[wsAbnormalIndex].classList.add('focused');
            _scrollAbnormalFocus();
        } else {
            renderWSTable();
            return;
        }
        renderWSCategoryBar();
        updateWSFooter();
    }

    function noteAbnormalNativeReadyAfterAudit(iframeWin, removedDR) {
        _abnormalNativeReadyDR = '';
        const data = filteredData();
        if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) return;
        const next = data[wsAbnormalIndex];
        if (!next || String(next.ReportDR) === String(removedDR)) return;
        if (isReportDetailLoaded(iframeWin, next.ReportDR)) {
            _abnormalNativeReadyDR = String(next.ReportDR);
            dbg('异常审核: 原生已定位下一条', next.ReportDR);
        } else {
            prewarmAbnormalAuditNative(next).catch(() => {});
        }
    }

    async function executeNativeAudit(iframeWin, specimen, options = {}) {
        const fast = options.fast !== false;
        const reportDR = specimen.ReportDR;
        let result = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth', {
            action: 'audit',
            expectedStatuses: ['3'],
            batchMode: fast,
            timeoutMs: fast ? 8000 : 15000,
            keepWS: !!options.keepWS,
            missingAsSuccess: true,
            targetReportDR: reportDR
        });
        if (!result) {
            iframeWin = getReportIframeWin() || iframeWin;
            result = await confirmAuditEventually(iframeWin, reportDR, specimen.PatName || specimen.Labno || '', { batchMode: fast });
        }
        return result;
    }

    async function auditAbnormalSpecimen(specimen) {
        if (_abnormalAuditInProgress) {
            _abnormalAuditQueued = true;
            const ft = document.getElementById('lis-ws-ft-stat');
            if (ft) ft.textContent = '审核进行中，下一条已排队...';
            return;
        }
        if (_auditInProgress) {
            showToast('正在批量审核中，请稍候', 'warning');
            return;
        }
        if (!specimen) {
            const data = filteredData();
            if (data.length) {
                wsAbnormalIndex = Math.max(0, Math.min(wsAbnormalIndex, data.length - 1));
                specimen = data[wsAbnormalIndex];
            }
        }
        if (!specimen) {
            showToast('没有可审核的异常标本', 'warning');
            return;
        }
        _abnormalAuditInProgress = true;
        _abnormalAuditQueued = false;
        markAbnormalAuditUI(specimen, 'start');
        // 安全超时：60 秒后显示警告，但不释放锁（finally 块负责释放）
        const _auditSafetyTimer = setTimeout(() => {
            if (_abnormalAuditInProgress) {
                dbg('异常审核安全超时：操作耗时超过 60 秒');
                showToast('异常审核操作耗时较长，请耐心等待', 'warning');
            }
        }, 60000);
        dbg('异常列表审核开始:', specimen.PatName);
        const resumeWSRefresh = !!wsTimer;
        stopWSRefresh();

        try {
            const startIndex = Math.max(0, wsAbnormalIndex);
            const targetDR = String(specimen.ReportDR || '');
            const ft = document.getElementById('lis-ws-ft-stat');
            if (ft) ft.textContent = `异常审核：${specimen.PatName || specimen.Labno || targetDR}`;

            const classCheck = validateAuditClassification(specimen.ReportDR, 'abnormal');
            if (!classCheck.ok) {
                showToast(classCheck.msg, classCheck.msg.indexOf('危急') !== -1 ? 'error' : 'warning');
                advanceAbnormalFocusAfterSkip(startIndex);
                return;
            }

            const complete = String(specimen.IsComplete || '');
            if (complete !== '1') {
                showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
                advanceAbnormalFocusAfterSkip(startIndex);
                return;
            }

            const status = String(specimen.Status || specimen.ReportStatus || '');
            if (status === '3' || status === '4') {
                showToast(`跳过: ${specimen.PatName} 已审核`, 'warning');
                advanceAbnormalFocusAfterSkip(startIndex);
                return;
            }

            const curDR = wgDR();
            const spDR = specimen._wg || '';
            if (spDR && curDR && spDR !== curDR) {
                const wgName = (WG_MAP[spDR] || {}).name || spDR;
                showToast(`切换到${wgName}继续审核`, 'warning');
                switchWG(spDR);
                return;
            }

            if (ft) ft.textContent = `异常审核：准备原生页面 ${specimen.PatName || specimen.Labno || targetDR}`;
            await awaitAbnormalPrewarm(specimen);

            let iframeWin = getReportIframeWin();
            if (!iframeWin) {
                if (ft) ft.textContent = `异常审核：加载报告页...`;
                iframeWin = await ensureReportPageLoaded({ keepWS: true, fast: true });
            }
            if (!iframeWin) {
                await sleep(80);
                iframeWin = getReportIframeWin() || await ensureReportPageLoaded({ keepWS: true, fast: true });
            }
            if (!iframeWin) {
                showToast('报告页面加载失败', 'error');
                advanceAbnormalFocusAfterSkip(startIndex);
                return;
            }

            const detailReady = isReportDetailLoaded(iframeWin, targetDR);
            if (ft) ft.textContent = detailReady
                ? `异常审核：审核中 ${specimen.PatName || specimen.Labno || targetDR}`
                : `异常审核：选中 ${specimen.PatName || specimen.Labno || targetDR}`;
            const skipSelect = _abnormalNativeReadyDR === targetDR || detailReady;
            let prep = { ok: detailReady, iframeWin, lastMdr: _abnormalLastMdr };
            if (!prep.ok) {
                prep = await ensureSpecimenReadyForAudit(iframeWin, specimen, { lastMdr: _abnormalLastMdr, skipSelect, abnormalFast: true });
            }
            _abnormalNativeReadyDR = '';
            iframeWin = prep.iframeWin || iframeWin;
            if (prep.lastMdr) _abnormalLastMdr = prep.lastMdr;
            if (!prep.ok) {
                const msg = prep.reason === 'detail' ? '报告详情未加载完成' : '未在原生列表中找到该标本';
                showToast(msg, prep.reason === 'detail' ? 'warning' : 'error');
                advanceAbnormalFocusAfterSkip(startIndex);
                return;
            }

            if (ft) ft.textContent = `异常审核：审核中 ${specimen.PatName || specimen.Labno || targetDR}`;
            let auditResult = await executeNativeAudit(iframeWin, specimen, { keepWS: true, fast: true });
            if (auditResult === 'incomplete') {
                showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
                advanceAbnormalFocusAfterSkip(startIndex);
                return;
            }
            if (!auditResult) {
                showToast('未确认审核成功，已跳到下一条', 'warning');
                advanceAbnormalFocusAfterSkip(startIndex);
                return;
            }
            if (ft) ft.textContent = `已审核: ${specimen.PatName || specimen.Labno || targetDR}`;

            // 确保焦点在主页面
            try { window.focus(); } catch(e) {}

            delete wsClassifiedCache[specimen.ReportDR];
            wsData = wsData.filter(r => r.ReportDR !== specimen.ReportDR);
            invalidateCaches();
            calcMachineCounts();
            noteAbnormalNativeReadyAfterAudit(iframeWin, targetDR);
            removeAuditedAbnormalCard(targetDR, startIndex);
        } catch(e) {
            dbg('审核失败:', e);
            showToast('审核失败: ' + e.message, 'error');
        } finally {
            clearTimeout(_auditSafetyTimer);
            clearAbnormalAuditingCard(specimen && specimen.ReportDR);
            _abnormalAuditInProgress = false;
            if (resumeWSRefresh && isWSVisible()) startWSRefresh();
            updateWSFooter();
            dbg('异常列表审核结束');
            if (_abnormalAuditQueued) {
                _abnormalAuditQueued = false;
                const data = filteredData();
                if (data.length) {
                    const idx = Math.max(0, Math.min(wsAbnormalIndex, data.length - 1));
                    setTimeout(() => auditAbnormalSpecimen(data[idx]), 30);
                }
            } else {
                prefetchAbnormalAuditContext();
            }
        }
    }

    // --- 结果不完整视图（只读）---
    function renderIncompleteView(data, body) {
        let h = '<div class="ws-incomplete-banner">⚠️ 以下标本结果不完整，不可审核</div>';

        h += '<table><thead><tr>';
        h += '<th>仪器</th><th>姓名</th><th>检验号</th><th>医嘱</th><th>完整度</th><th>核收时间</th>';
        h += '</tr></thead><tbody>';

        data.forEach((r, i) => {
            const ic = r.IsComplete;
            let icHTML = '';
            if (ic === '2') icHTML = `<span class="complete-partial">⚠️ 缺 ${r.NoResRows||'?'} 项</span>`;
            else if (ic === '0') icHTML = '<span class="complete-empty">❌ 无结果</span>';
            else icHTML = '<span style="color:#999">-</span>';

            h += `<tr data-i="${i}" data-rdr="${escAttr(r.ReportDR||'')}">`;
            h += `<td>${highlightText(r._mn||'', wsSearchQuery)}</td>`;
            h += `<td>${highlightText(r.PatName||'', wsSearchQuery)}</td>`;
            h += `<td><b>${highlightText(r.Labno||'', wsSearchQuery)}</b></td>`;
            h += `<td>${highlightText(r.TestSetDesc||'', wsSearchQuery)}</td>`;
            h += `<td>${icHTML}</td>`;
            h += `<td>${esc(r.AcceptDT||'')}</td>`;
            h += '</tr>';
        });
        h += '</tbody></table>';
        body.innerHTML = h;

        // 行点击 → 详情
        body.querySelectorAll('tr[data-rdr]').forEach(tr => tr.addEventListener('click', e => {
            const specimen = findWSSpecimenByReportDR(tr.dataset.rdr);
            if (specimen) openDetailPanel(specimen);
        }));
    }

    // --- 全部标本视图 ---
    function renderAllView(data, body) {
        const stMap = {
            '0':{t:'待排样',cls:'st-0t'},'1':{t:'登记',cls:'st-1t'},'2':{t:'初审',cls:'st-2t'},
            '3':{t:'审核',cls:'st-3t'},'4':{t:'复审',cls:''},'5':{t:'取消',cls:'st-5t'}
        };

        let h = '<table><thead><tr>';
        h += '<th style="width:30px"><input type="checkbox" id="lis-ws-chka" /></th>';
        h += '<th>仪器</th><th>状态</th><th>完整度</th><th>流水号</th><th>姓名</th><th>检验号</th><th>医嘱</th><th>核收时间</th>';
        h += '</tr></thead><tbody>';

        data.forEach((r, i) => {
            const statusVal = r.Status || r.ReportStatus || '';
            const st = stMap[statusVal] || {t:r.StatusDesc||'?',cls:''};
            const ck = wsChecked.has(r.ReportDR) ? 'checked' : '';
            h += `<tr class="st-${statusVal} ${wsChecked.has(r.ReportDR)?'sel':''}" data-i="${i}" data-rdr="${escAttr(r.ReportDR||'')}">`;
            h += `<td><input type="checkbox" class="lis-ws-ck" data-rdr="${escAttr(r.ReportDR||'')}" ${ck} /></td>`;
            h += `<td>${highlightText(r._mn||'', wsSearchQuery)}</td>`;
            h += `<td><span class="st-tag ${st.cls}">${esc(st.t)}</span></td>`;
            const ic = r.IsComplete;
            let icHTML = '';
            if (ic === '1') icHTML = '<span class="complete-star">⭐</span>';
            else if (ic === '2') icHTML = `<span class="complete-partial">⚠️ -${r.NoResRows||'?'}</span>`;
            else if (ic === '0') icHTML = '<span class="complete-empty">❌</span>';
            else icHTML = '<span style="color:#999">-</span>';
            h += `<td>${icHTML}</td>`;
            h += `<td><b>${highlightText(r.EpisodeNo||'', wsSearchQuery)}</b></td>`;
            h += `<td>${highlightText(r.PatName||'', wsSearchQuery)}</td>`;
            h += `<td>${highlightText(r.Labno||'', wsSearchQuery)}</td>`;
            h += `<td>${highlightText(r.TestSetDesc||'', wsSearchQuery)}</td>`;
            h += `<td>${esc(r.AcceptDT||'')}</td>`;
            h += '</tr>';
        });
        h += '</tbody></table>';
        body.innerHTML = h;

        _bindTableEvents(body, data, 'all');
    }

    // --- 通用表格事件绑定 ---
    // 事件委托：在 body 上监听，减少逐元素绑定
    function _bindTableEvents(body, data, source) {
        // 移除旧的委托监听器
        if (body._delegatedHandler) {
            body.removeEventListener('click', body._delegatedHandler.click);
            body.removeEventListener('change', body._delegatedHandler.change);
            body.removeEventListener('dblclick', body._delegatedHandler.dblclick);
        }

        const handlers = {};

        // click 委托：行点击 → 详情
        handlers.click = e => {
            const tr = e.target.closest('tr[data-rdr]');
            if (!tr) return;
            if (e.target.closest('input[type="checkbox"]')) return;
            body.querySelectorAll('tr.active-row').forEach(r => r.classList.remove('active-row'));
            tr.classList.add('active-row');
            const specimen = findWSSpecimenByReportDR(tr.dataset.rdr);
            if (!specimen) return;
            const idx = filteredData().findIndex(r => String(r.ReportDR) === String(specimen.ReportDR));
            openDetailPanel(specimen, source || 'all', idx >= 0 ? idx : parseInt(tr.dataset.i));
        };

        // change 委托：checkbox 选中
        handlers.change = e => {
            if (e.target.id === 'lis-ws-chka') {
                body.querySelectorAll('.lis-ws-ck').forEach(c => {
                    if (e.target.checked) wsChecked.add(c.dataset.rdr); else wsChecked.delete(c.dataset.rdr);
                    c.checked = e.target.checked;
                });
                return;
            }
            if (e.target.classList.contains('lis-ws-ck')) {
                if (e.target.checked) wsChecked.add(e.target.dataset.rdr); else wsChecked.delete(e.target.dataset.rdr);
                e.target.closest('tr').classList.toggle('sel', e.target.checked);
            }
        };

        // dblclick 委托：双击 → 原生界面
        handlers.dblclick = e => {
            const tr = e.target.closest('tr[data-rdr]');
            if (!tr) return;
            if (e.target.closest('input[type="checkbox"]')) return;
            const specimen = findWSSpecimenByReportDR(tr.dataset.rdr);
            if (specimen) navigateToSpecimen(specimen);
        };

        body.addEventListener('click', handlers.click);
        body.addEventListener('change', handlers.change);
        body.addEventListener('dblclick', handlers.dblclick);
        body._delegatedHandler = handlers;
    }

    // --- 确认并批量审核 ---
    function confirmAndBatchAudit(normalData) {
        dbg('confirmAndBatchAudit 被调用, normalData.length:', normalData.length);
        if (wsClassifying) {
            showToast('标本正在分类中，请等候分类完成后再批审', 'warning');
            return;
        }
        normalData = [...(normalData || [])].sort((a, b) => compareSpecimensForAudit(a.row || a, b.row || b));
        const stale = normalData.filter(sp => !isLiveNormalForBatch(sp.reportDR || (sp.row && sp.row.ReportDR)));
        if (stale.length > 0) {
            const first = stale[0].row || stale[0];
            showToast(`分类状态已变化或未完成：${first.PatName || first.Labno || ''}，请刷新工作台后重试`, 'error');
            return;
        }
        const blocked = normalData.filter(r => !isAutoAuditableClassified(r));
        if (blocked.length > 0) {
            const first = blocked[0];
            showToast(getAutoAuditBlockReason(first, first.row) || '包含不可自动审核的标本', 'error');
            return;
        }
        if (normalData.length === 0) { showToast('没有可审核的标本', 'warning'); return; }
        const existing = document.getElementById('lis-audit-confirm');
        if (existing) existing.remove();

        const dialog = document.createElement('div');
        dialog.id = 'lis-audit-confirm';
        dialog.innerHTML = `
            <div id="lis-audit-box">
                <div class="ab-hd">
                    <h4>确认批量审核</h4>
                    <button class="ab-close" id="lis-ab-close">✕</button>
                </div>
                <div class="ab-body">
                    <div class="ab-section">
                        <h5><span class="ab-count" style="background:#27ae60">${normalData.length}</span> 正常标本（将自动审核）</h5>
                        <div class="ab-list" style="max-height:300px;overflow-y:auto">
                            ${normalData.map(r => `<div class="ab-item">
                                <span class="ab-name">${esc(r.row.PatName||'未知')}</span>
                                <span class="ab-detail">${esc(r.row.Labno||'')} | ${esc(r.row.TestSetDesc||'')}</span>
                                <span class="ab-tag" style="background:#e8f5e9;color:#2e7d32">✓ 正常</span>
                            </div>`).join('')}
                        </div>
                    </div>
                </div>
                <div class="ab-ft">
                    <button class="ab-cancel" id="lis-ab-cancel">取消</button>
                    <button class="ab-confirm ok" id="lis-ab-confirm">确认审核 (${normalData.length})</button>
                </div>
            </div>`;
        document.body.appendChild(dialog);
        dialog.classList.add('show');

        const confirmBtn = document.getElementById('lis-ab-confirm');
        document.getElementById('lis-ab-close').addEventListener('click', () => dialog.remove());
        document.getElementById('lis-ab-cancel').addEventListener('click', () => dialog.remove());
        dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });
        confirmBtn.addEventListener('click', () => {
            dialog.remove();
            executeBatchAudit(normalData).catch(e => {
                console.error('[LIS] 批审异常:', e);
            });
        });
    }

    // --- 批审操作条 ---
    function updateBatchBar() {
        let bb = document.getElementById('lis-batch');
        if (!bb) {
            bb = document.createElement('div');
            bb.id = 'lis-batch';
            document.body.appendChild(bb);
        }
        if (wsChecked.size === 0) { bb.classList.remove('show'); return; }
        bb.classList.add('show');
        bb.innerHTML = `
            <h4>📋 已选 ${wsChecked.size} 个标本</h4>
            <div class="bf">
                <button id="lis-bb-detail" style="background:#9b59b6;color:#fff" title="查看选中标本详情">👁 查看详情</button>
                <button id="lis-bb-audit" style="background:#27ae60;color:#fff" title="F5 快捷审核">✅ 审核</button>
                <button id="lis-bb-nav" style="background:#3498db;color:#fff" title="在原生界面中打开">📂 打开</button>
                <button id="lis-bb-sel" style="background:#f39c12;color:#fff">☑ 全选当前</button>
                <button id="lis-bb-clr" style="background:#95a5a6;color:#fff">✕ 取消选择</button>
                <span style="font-size:11px;color:#999;margin-left:8px">💡 点击标本行查看详情 | F5 审核</span>
            </div>`;
        document.getElementById('lis-bb-audit').addEventListener('click', () => {
            auditSelectedSpecimens();
        });
        document.getElementById('lis-bb-detail').addEventListener('click', () => {
            // 查看第一个选中标本的详情
            const fd = filteredData();
            const first = fd.find(r => wsChecked.has(r.ReportDR));
            if (first) {
                openDetailPanel(first);
            } else {
                toast('请先选择标本', 'w');
            }
        });
        document.getElementById('lis-bb-nav').addEventListener('click', () => {
            // 导航到第一个选中的标本
            const fd = filteredData();
            const first = fd.find(r => wsChecked.has(r.ReportDR));
            if (first) navigateToSpecimen(first);
        });
        document.getElementById('lis-bb-sel').addEventListener('click', () => {
            filteredData().forEach(r => { if(r.ReportDR) wsChecked.add(r.ReportDR); });
            renderWSTable();
            updateBatchBar();
        });
        document.getElementById('lis-bb-clr').addEventListener('click', () => {
            wsChecked.clear();
            renderWSTable();
            updateBatchBar();
        });
    }

    // --- 导航到原生界面 ---
    function navigateToSpecimen(row) {
        const curDR = wgDR();
        const targetDR = row._wg;
        const labno = row.Labno;
        const mdr = row._mdr;
        const reportDR = row.ReportDR;

        // 保存导航目标
        try { localStorage.setItem(K.tgt, JSON.stringify({
            wgDR: targetDR, machineDR: mdr, labno: labno, reportDR: reportDR, time: Date.now()
        })); } catch(e) {}

        if (targetDR !== curDR) {
            // 需要切换工作组
            toast('正在切换到 ' + (WG_MAP[targetDR]||{}).name + '...', 'w');
            switchWG(targetDR);
            return;
        }

        // 同工作组：直接操作原生界面
        closeWS();

        // 尝试设置仪器选择
        try {
            const w = uw();
            if (w.me) {
                w.me.WorkGroupMachineDR = mdr;
                // 尝试设置 combogrid
                if (typeof w.$ !== 'undefined') {
                    try { w.$('#cmb_WorkGroupMachine').combogrid('setValue', mdr); } catch(e){}
                    // 设置快速搜索
                    try { w.$('#txt_FindFast').val(labno); } catch(e){}
                }
            }
            // 触发搜索
            if (typeof uw().FindFast === 'function') {
                uw().FindFast(labno);
            } else if (typeof uw().ShowWorkList === 'function') {
                const dateStr = today();
                const findStr = '&WorkGroupMachineDR=' + mdr + '&ReportStatus=&SttAccDate=' + dateStr;
                uw().ShowWorkList(findStr);
            }

            // 等待搜索结果加载并选中对应行
            setTimeout(() => {
                try {
                    const iframeWin = getReportIframeWin();
                    if (!iframeWin) return;
                    const jq = iframeWin.jQuery || iframeWin.$;
                    if (!jq) return;
                    const dg = jq('#dgWorkList');
                    if (!dg.length) return;
                    const rows = dg.datagrid('getRows');
                    if (!rows || rows.length === 0) return;
                    // 根据 ReportDR 或 Labno 选中对应行
                    for (let i = 0; i < rows.length; i++) {
                        if (String(rows[i].ReportDR) === String(reportDR) || 
                            String(rows[i].Labno) === String(labno)) {
                            dg.datagrid('selectRow', i);
                            dbg('导航: 已选中行', i, 'ReportDR:', reportDR);
                            break;
                        }
                    }
                } catch(e) {
                    dbg('导航选行失败:', e);
                }
            }, 1500);
        } catch(e) {
            dbg('导航失败:', e);
        }
    }

    let _saveQueueTimer = null;
    function saveAuditQueue(queue) {
        clearTimeout(_saveQueueTimer);
        _saveQueueTimer = setTimeout(() => {
            try {
                localStorage.setItem(K.auditQueue, JSON.stringify({ ...queue, time: Date.now() }));
            } catch(e) {}
        }, 200);
    }
    function saveAuditQueueNow(queue) {
        clearTimeout(_saveQueueTimer);
        try {
            localStorage.setItem(K.auditQueue, JSON.stringify({ ...queue, time: Date.now() }));
        } catch(e) {}
    }

    function loadAuditQueue() {
        try {
            const raw = localStorage.getItem(K.auditQueue);
            if (!raw) return null;
            const q = JSON.parse(raw);
            if (!q || !q.items || !q.time || Date.now() - q.time > 10 * 60 * 1000) {
                localStorage.removeItem(K.auditQueue);
                return null;
            }
            return q;
        } catch(e) { return null; }
    }

    function clearAuditQueue() {
        try { localStorage.removeItem(K.auditQueue); } catch(e) {}
    }

    function makeAuditQueue(specimens, mode) {
        const items = [];
        specimens.forEach(sp => {
            const row = sp.row || sp;
            const reportDR = sp.reportDR || row.ReportDR;
            if (!reportDR || !row) return;
            if (!isAutoAuditableClassified(sp)) return;
            items.push({
                reportDR: String(reportDR),
                wg: row._wg || wgDR(),
                mdr: prWorkGroupMachineDR(row) || '',
                labno: row.Labno || '',
                name: row.PatName || '',
                testSet: row.TestSetDesc || '',
                fingerprint: specimenFingerprint(row),
                status: sp.status || '',
                retry: 0
            });
        });
        items.sort(compareAuditQueueItems);
        return { mode: mode || 'batch', items, done: [], failed: [], skipped: [], current: 0, keepWS: isWSVisible() };
    }

    function currentQueueItem(queue) {
        if (!queue || !queue.items) return null;
        while (queue.current < queue.items.length) {
            const it = queue.items[queue.current];
            if (it && !it.done) return it;
            queue.current++;
        }
        return null;
    }

    async function ensureAuditQueueWorkGroup(queue) {
        const item = currentQueueItem(queue);
        if (!item) return true;
        const curDR = wgDR();
        if (!item.wg || item.wg === curDR) return true;
        queue.pausedForSwitch = true;
        saveAuditQueueNow(queue);
        const wgName = (WG_MAP[item.wg] || {}).name || item.wg;
        showToast('切换到' + wgName + '继续审核...', 'warning');
        switchWG(item.wg);
        return false;
    }

    function runAuditQueueResume(delayMs) {
        setTimeout(() => {
            const freshQueue = loadAuditQueue();
            if (!freshQueue || !freshQueue.items || (freshQueue.items.length - (freshQueue.current || 0)) <= 0) {
                clearAuditQueue();
                return;
            }
            delete freshQueue.pausedForSwitch;
            saveAuditQueueNow(freshQueue);
            continueAuditQueue(freshQueue).catch(e => {
                dbg('续跑批审队列失败:', e);
                showToast('续跑批审失败: ' + e.message, 'error');
            });
        }, delayMs);
    }

    function confirmAuditQueueResume(remaining) {
        const existing = document.getElementById('lis-queue-resume');
        if (existing) existing.remove();
        const dialog = document.createElement('div');
        dialog.id = 'lis-queue-resume';
        dialog.innerHTML = `
            <div id="lis-audit-box" style="max-width:420px">
                <div class="ab-hd">
                    <h4>继续批审？</h4>
                    <button class="ab-close" id="lis-qr-close">✕</button>
                </div>
                <div class="ab-body">
                    <p style="margin:0;font-size:13px;color:#334155;line-height:1.6">
                        发现上次未完成的批审队列，还有 <b>${remaining}</b> 个标本待处理。是否继续？
                    </p>
                </div>
                <div class="ab-ft">
                    <button class="ab-cancel" id="lis-qr-cancel">放弃</button>
                    <button class="ab-confirm ok" id="lis-qr-confirm">继续批审</button>
                </div>
            </div>`;
        document.body.appendChild(dialog);
        dialog.classList.add('show');
        const close = () => dialog.remove();
        document.getElementById('lis-qr-close').addEventListener('click', close);
        document.getElementById('lis-qr-cancel').addEventListener('click', () => { clearAuditQueue(); close(); });
        dialog.addEventListener('click', e => { if (e.target === dialog) close(); });
        document.getElementById('lis-qr-confirm').addEventListener('click', () => {
            close();
            showToast(`继续批审（${remaining} 个标本）...`, 'warning');
            runAuditQueueResume(300);
        });
    }

    function checkAuditQueueResume() {
        const queue = loadAuditQueue();
        if (!queue || !queue.items || queue.items.length === 0) return;
        const remaining = queue.items.length - (queue.current || 0);
        if (remaining <= 0) { clearAuditQueue(); return; }
        if (queue.pausedForSwitch) {
            showToast(`切换工作组后继续批审（${remaining} 个标本）...`, 'warning');
            runAuditQueueResume(1500);
            return;
        }
        confirmAuditQueueResume(remaining);
    }

    // --- F5 快捷键审核选中标本 ---
    function auditSelectedSpecimens() {
        if (wsChecked.size === 0) {
            toast('请先选择要审核的标本', 'w');
            return;
        }

        // 获取选中的标本
        const selectedSpecimens = wsData.filter(r => wsChecked.has(r.ReportDR));
        if (selectedSpecimens.length === 0) {
            toast('未找到选中的标本', 'w');
            return;
        }

        // 检查是否有未审核的标本
        const unreviewed = selectedSpecimens.filter(r => String(r.Status || r.ReportStatus || '') !== '3');
        if (unreviewed.length === 0) {
            toast('选中的标本已全部审核', 'w');
            return;
        }

        // 使用缓存的分类结果；只允许 NORMAL 进入自动审核
        const formatted = unreviewed.map(r => {
            const cached = wsClassifiedCache[r.ReportDR];
            if (cached) cached._accessTs = Date.now();
            return cached
                ? { status: cached.status, items: cached.items || [], row: r, reportDR: r.ReportDR }
                : { status: 'UNCERTAIN', items: [], row: r, reportDR: r.ReportDR };
        });
        const normalOnly = formatted.filter(isAutoAuditableClassified);
        const blocked = formatted.filter(r => !isAutoAuditableClassified(r));
        if (blocked.length > 0) {
            showToast(`已排除 ${blocked.length} 个异常/危急/待定标本`, 'warning');
        }
        if (normalOnly.length === 0) {
            showToast(blocked.length ? getAutoAuditBlockReason(blocked[0], blocked[0].row) : '没有可审核的正常标本', 'warning');
            return;
        }
        confirmAndBatchAudit(normalOnly);
    }

    // (showAuditConfirmDialog 和 performAudit 已删除，使用 confirmAndBatchAudit 替代)

    // ============================================================
    //  标本详情面板
    // ============================================================
    let detailPanel = null;
    let currentDetailSpecimen = null;
    let detailSource = null;  // 'abnormal' | 'normal' | null
    let detailSourceIndex = -1;
    let _detailKeyHandler = null; // 详情面板键盘监听器
    let _detailLoadSeq = 0; // 详情加载序号，防止旧请求覆盖当前标本

    function createDetailPanel() {
        if (detailPanel) return detailPanel;
        detailPanel = document.createElement('div');
        detailPanel.id = 'lis-detail-panel';
        detailPanel.innerHTML = `
            <div id="lis-detail-hd">
                <div style="flex:1;min-width:0;padding-right:10px">
                    <h4 id="lis-detail-title" style="margin:0;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📋 标本详情</h4>
                    <div id="lis-detail-subtitle" style="font-size:11px;color:rgba(255,255,255,.7);margin-top:3px"></div>
                    <div id="lis-detail-extra" style="font-size:11px;color:rgba(255,255,255,.6);margin-top:2px"></div>
                </div>
                <button class="detail-close" id="lis-detail-close">✕</button>
            </div>
            <div id="lis-detail-info"></div>
            <div id="lis-detail-body" style="flex:1;overflow-y:scroll;overflow-x:hidden;padding:16px 20px;min-height:0;max-height:calc(100vh - 120px)">
                <div id="lis-detail-loading">
                    <div class="spinner"></div>
                    <p>正在加载结果...</p>
                </div>
            </div>
            <div id="lis-detail-footer">
                <span style="font-size:11px;color:#999;margin-right:auto">↑↓ 切换 | Enter 审核 | Esc 关闭</span>
                <button class="btn-audit" id="lis-detail-audit">✅ 审核</button>
                <button class="btn-close" id="lis-detail-close-btn">关闭</button>
            </div>
        `;
        document.body.appendChild(detailPanel);

        // 透明层只保留占位，不拦截工作台列表点击；关闭请用按钮或 Esc。
        const overlay = document.createElement('div');
        overlay.id = 'lis-detail-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:35vw;height:100vh;z-index:100004;display:none;pointer-events:none';
        document.body.appendChild(overlay);

        // 事件绑定
        document.getElementById('lis-detail-close').addEventListener('click', closeDetailPanel);
        document.getElementById('lis-detail-close-btn').addEventListener('click', closeDetailPanel);
        document.getElementById('lis-detail-audit').addEventListener('click', () => {
            if (currentDetailSpecimen) {
                _auditFromDetailPanel();
            }
        });

        return detailPanel;
    }

    function openDetailPanel(specimen, source, sourceIndex) {
        dbg('openDetailPanel', specimen.ReportDR, specimen.PatName, source);
        createDetailPanel();
        // 清理异常视图键盘监听，防止与详情面板冲突
        _removeAbnormalKeyHandler();

        // 面板已打开时直接换内容，避免点击其它样本时先收回再二次点击。
        if (detailPanel.classList.contains('show')) {
            _switchDetailInPlace(specimen, source, sourceIndex);
            return;
        }

        currentDetailSpecimen = specimen;
        detailSource = source || null;
        detailSourceIndex = (sourceIndex !== undefined) ? sourceIndex : -1;

        // 更新标题
        const titleEl = document.getElementById('lis-detail-title');
        if (titleEl) {
            titleEl.textContent = `📋 ${specimen.PatName || '未知'}`;
        }
        const subtitleEl = document.getElementById('lis-detail-subtitle');
        if (subtitleEl) {
            subtitleEl.innerHTML = buildDetailSubtitle(specimen);
        }
        const detailExtra = document.getElementById('lis-detail-extra');
        // 立即填充患者信息（优先缓存，回退到 specimen 本身）
        const _cr = (wsClassifiedCache[specimen.ReportDR] || {}).row || specimen;
        if (detailExtra) detailExtra.textContent = buildDetailExtraText(_cr, specimen) || '加载中...';

        // 信息栏（紧凑状态条）
        const info = document.getElementById('lis-detail-info');
        if (info) {
            info.innerHTML = '<div style="height:1px"></div>';
        }

        // 显示加载中
        const body = document.getElementById('lis-detail-body');
        if (body) {
            body.innerHTML = `
                <div id="lis-detail-loading">
                    <div class="spinner"></div>
                    <p>正在加载结果...</p>
                </div>
            `;
        }

        // 显示面板和遮罩层
        detailPanel.classList.add('show');
        const overlay = document.getElementById('lis-detail-overlay');
        if (overlay) overlay.style.display = 'none';

        // 加载详细结果
        loadDetailResults(specimen);

        // 更新底部按钮
        const footer = document.getElementById('lis-detail-footer');
        if (footer) {
            // 移除旧的"原生界面"按钮
            const oldNative = document.getElementById('lis-detail-native');
            if (oldNative) oldNative.remove();
            // 添加"在原生界面中打开"按钮
            const nativeBtn = document.createElement('button');
            nativeBtn.id = 'lis-detail-native';
            nativeBtn.className = 'btn-close';
            nativeBtn.style.background = '#3498db';
            nativeBtn.textContent = '📂 原生界面';
            nativeBtn.addEventListener('click', () => {
                navigateToSpecimen(specimen);
                closeDetailPanel();
            });
            footer.insertBefore(nativeBtn, footer.firstChild);
        }

        // 注册详情面板键盘监听
        _removeDetailKeyHandler();
        _detailKeyHandler = (e) => {
            if (isPatientResultPanelEvent(e)) return;
            if (!detailPanel || !detailPanel.classList.contains('show')) return;
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopImmediatePropagation();
                closeDetailPanel();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                e.stopImmediatePropagation();
                dbg('Enter 键捕获 (详情面板), inProgress=', _detailAuditInProgress);
                _auditFromDetailPanel();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault();
                e.stopImmediatePropagation();
                // 方向键切换：原地更新内容，不关闭面板
                const data = filteredData();
                if (data.length === 0) return;
                const curIdx = data.findIndex(r => r.ReportDR === (currentDetailSpecimen && currentDetailSpecimen.ReportDR));
                let newIdx = curIdx + (e.key === 'ArrowDown' ? 1 : -1);
                if (newIdx < 0) newIdx = data.length - 1;
                if (newIdx >= data.length) newIdx = 0;
                _switchDetailInPlace(data[newIdx], detailSource, newIdx);
            }
        };
        document.addEventListener('keydown', _detailKeyHandler, true);
        dbg('详情面板键盘监听已注册, specimen:', specimen.PatName);
    }

    function _removeDetailKeyHandler() {
        if (_detailKeyHandler) {
            document.removeEventListener('keydown', _detailKeyHandler, true);
            _detailKeyHandler = null;
        }
    }

    function formatDetailTimeText(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::\d{2})?/);
        if (m) return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];
        const mt = raw.match(/^(\d{2}):(\d{2})(?::\d{2})?/);
        if (mt) return mt[1] + ':' + mt[2];
        return raw;
    }

    function detailTimeFrom(info, dtKey, dateKey, timeKey, fallback) {
        const dt = info && info[dtKey] ? info[dtKey] : '';
        const date = info && info[dateKey] ? info[dateKey] : '';
        const time = info && info[timeKey] ? info[timeKey] : '';
        return formatDetailTimeText(dt || [date, time].filter(Boolean).join(' ') || fallback || '');
    }

    function formatDetailBedNo(bedNo) {
        const bed = String(bedNo || '').trim();
        if (!bed) return '';
        return /^床/.test(bed) || /床$/.test(bed) ? bed : '床' + bed;
    }

    function buildDetailExtraText(info, fallback) {
        const r = info || {};
        const fb = fallback || {};
        const parts = [];
        const sex = r.Sex || r.Species || fb.Sex || fb.Species;
        const age = r.Age || fb.Age;
        const ageUnit = r.AgeUnit || fb.AgeUnit || '';
        const location = r.Location || r.LocationName || fb.Location || fb.LocationName;
        const ward = r.Ward || r.WardName || fb.Ward || fb.WardName;
        const admNo = r.AdmNo || fb.AdmNo;
        const recordNo = r.RecordNo || fb.RecordNo;
        const regNo = r.RegNo || fb.RegNo;
        const bed = formatDetailBedNo(r.BedNo || fb.BedNo);
        const specimen = r.Specimen || r.SpecimenDesc || fb.Specimen || fb.SpecimenDesc;
        const doctor = r.Doctor || r.DoctorName || fb.Doctor || fb.DoctorName;
        const diagnose = r.Diagnose || fb.Diagnose;
        const collectTime = detailTimeFrom(r, 'CollectDT', 'CollectDate', 'CollectTime', fb.CollectDT);
        const receiveTime = detailTimeFrom(r, 'ReceiveDT', 'ReceiveDate', 'ReceiveTime', fb.ReceiveDT);
        const acceptTime = detailTimeFrom(r, 'AcceptDT', 'AcceptDate', 'AcceptTime', fb.AcceptDT);
        const authTime = detailTimeFrom(r, 'AuthDT', 'AuthDate', 'AuthTime', fb.AuthDT);

        if (sex) parts.push(sex);
        if (age) parts.push(age + ageUnit);
        if (location) parts.push(location);
        if (ward) parts.push(ward);
        if (admNo) parts.push('住院号 ' + admNo);
        else if (recordNo) parts.push('病案号 ' + recordNo);
        else if (regNo) parts.push('登记号 ' + regNo);
        if (bed) parts.push(bed);
        if (specimen) parts.push(specimen);
        if (doctor) parts.push(doctor);
        if (collectTime) parts.push('采集 ' + collectTime);
        if (receiveTime) parts.push('接收 ' + receiveTime);
        if (acceptTime) parts.push('核收 ' + acceptTime);
        if (authTime) parts.push('审核 ' + authTime);
        if (diagnose) parts.push('🏥 ' + diagnose);
        return parts.join(' · ');
    }

    function buildDetailSubtitle(specimen) {
        return `<span>${getStatusText(specimen.Status || specimen.ReportStatus)}</span> · 检验号: ${esc(specimen.Labno || '-')} · 流水号: ${esc(specimen.EpisodeNo || '-')} · ${esc(specimen.TestSetDesc || '')} · 仪器: ${esc(specimen._mn || '-')}`;
    }

    // 原地切换详情面板内容（不关闭面板，避免闪烁）
    function _switchDetailInPlace(specimen, source, sourceIndex) {
        if (!detailPanel || !specimen) return;
        currentDetailSpecimen = specimen;
        detailSource = source || null;
        detailSourceIndex = (sourceIndex !== undefined) ? sourceIndex : -1;

        // 更新标题
        const titleEl = document.getElementById('lis-detail-title');
        if (titleEl) titleEl.textContent = `📋 ${specimen.PatName || '未知'}`;
        const subtitleEl = document.getElementById('lis-detail-subtitle');
        if (subtitleEl) subtitleEl.innerHTML = buildDetailSubtitle(specimen);
        const detailExtra = document.getElementById('lis-detail-extra');
        const _cr = (wsClassifiedCache[specimen.ReportDR] || {}).row || specimen;
        if (detailExtra) detailExtra.textContent = buildDetailExtraText(_cr, specimen) || '加载中...';

        // 信息栏
        const info = document.getElementById('lis-detail-info');
        if (info) info.innerHTML = '<div style="height:1px"></div>';

        // 显示加载中
        const body = document.getElementById('lis-detail-body');
        if (body) {
            body.innerHTML = '<div id="lis-detail-loading"><div class="spinner"></div><p>正在加载结果...</p></div>';
        }

        // 更新底部按钮
        const footer = document.getElementById('lis-detail-footer');
        if (footer) {
            const oldNative = document.getElementById('lis-detail-native');
            if (oldNative) oldNative.remove();
            const nativeBtn = document.createElement('button');
            nativeBtn.id = 'lis-detail-native';
            nativeBtn.className = 'btn-close';
            nativeBtn.style.background = '#3498db';
            nativeBtn.textContent = '📂 原生界面';
            nativeBtn.addEventListener('click', () => { navigateToSpecimen(specimen); closeDetailPanel(); });
            footer.insertBefore(nativeBtn, footer.firstChild);
        }

        // 加载详情（LRU 缓存命中时极快）
        loadDetailResults(specimen);

        // 重新注册键盘监听
        _removeDetailKeyHandler();
        _detailKeyHandler = (e) => {
            if (isPatientResultPanelEvent(e)) return;
            if (!detailPanel || !detailPanel.classList.contains('show')) return;
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopImmediatePropagation(); closeDetailPanel();
            } else if (e.key === 'Enter') {
                e.preventDefault(); e.stopImmediatePropagation(); _auditFromDetailPanel();
            } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                e.preventDefault(); e.stopImmediatePropagation();
                const data = filteredData();
                if (data.length === 0) return;
                const curIdx = data.findIndex(r => r.ReportDR === (currentDetailSpecimen && currentDetailSpecimen.ReportDR));
                let newIdx = curIdx + (e.key === 'ArrowDown' ? 1 : -1);
                if (newIdx < 0) newIdx = data.length - 1;
                if (newIdx >= data.length) newIdx = 0;
                _switchDetailInPlace(data[newIdx], detailSource, newIdx);
            }
        };
        document.addEventListener('keydown', _detailKeyHandler, true);
    }

    let _detailAuditInProgress = false;

    // 从详情面板审核当前标本并自动跳转下一个
    async function _auditFromDetailPanel() {
        if (!currentDetailSpecimen || _detailAuditInProgress) {
            dbg('详情审核跳过: specimen=', !!currentDetailSpecimen, 'inProgress=', _detailAuditInProgress);
            return;
        }
        if (_auditInProgress) {
            showToast('正在批量审核中，请稍候', 'warning');
            return;
        }
        if (_abnormalAuditInProgress) {
            showToast('正在审核异常标本中，请稍候', 'warning');
            return;
        }
        _detailAuditInProgress = true;
        // 安全超时：60 秒后显示警告，但不释放锁（finally 块负责释放）
        const _detailSafetyTimer = setTimeout(() => {
            if (_detailAuditInProgress) {
                dbg('详情审核安全超时：操作耗时超过 60 秒');
                showToast('详情审核操作耗时较长，请耐心等待', 'warning');
            }
        }, 60000);
        dbg('详情审核开始:', currentDetailSpecimen.PatName);
        const resumeWSRefresh = !!wsTimer;
        stopWSRefresh();

        try {
            const specimen = currentDetailSpecimen;
            const source = detailSource;
            const idx = detailSourceIndex;

            let nextReportDR = null;
            if (source && idx >= 0) {
                const data = filteredData();
                if (idx + 1 < data.length) nextReportDR = data[idx + 1].ReportDR;
            }

            let iframeWin = getReportIframeWin();
            if (!iframeWin) iframeWin = await ensureReportPageLoaded({ keepWS: true });
            if (!iframeWin) {
                showToast('报告页面未加载', 'error');
                return;
            }

            const reportDR = specimen.ReportDR;
            const classCtx = detailSource === 'abnormal' ? 'abnormal' : 'normal';
            const classCheck = validateAuditClassification(reportDR, classCtx);
            if (!classCheck.ok) {
                showToast(classCheck.msg, classCtx === 'abnormal' ? 'warning' : 'error');
                return;
            }
            if (detailPanel && detailPanel.dataset.rdr === String(reportDR) && detailPanel.dataset.hasCritical === '1') {
                showToast(`🚨 ${specimen.PatName || specimen.Labno || ''} 有危急值，必须在原始LIS中审核`, 'error');
                return;
            }

            const complete = String(specimen.IsComplete || '');
            if (complete !== '1') {
                showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
                return;
            }

            const status = String(specimen.Status || specimen.ReportStatus || '');
            if (status === '3' || status === '4') {
                showToast(`跳过: ${specimen.PatName} 已审核`, 'warning');
                return;
            }

            const curDR = wgDR();
            const spDR = specimen._wg || '';
            if (spDR && curDR && spDR !== curDR) {
                const wgName = (WG_MAP[spDR] || {}).name || spDR;
                showToast(`切换到${wgName}继续审核`, 'warning');
                switchWG(spDR);
                return;
            }

            let needPrep = true;
            try {
                const me = iframeWin.me;
                if (me && me.selectedGrid && isReportDetailLoaded(iframeWin, reportDR)) needPrep = false;
            } catch(e) {}
            if (needPrep) {
                const prep = await ensureSpecimenReadyForAudit(iframeWin, specimen, { lastMdr: _abnormalLastMdr });
                iframeWin = prep.iframeWin || iframeWin;
                if (prep.lastMdr) _abnormalLastMdr = prep.lastMdr;
                if (!prep.ok) {
                    const msg = prep.reason === 'detail' ? '报告详情未加载完成' : '未在原生列表中找到该标本';
                    showToast(msg, prep.reason === 'detail' ? 'warning' : 'error');
                    return;
                }
            }

            let auditResult = await executeNativeAudit(iframeWin, specimen, { keepWS: true, fast: true });
            if (auditResult === 'incomplete') {
                showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
                return;
            }
            if (!auditResult) {
                showToast('未确认审核成功，请核对原生列表状态', 'warning');
                return;
            }
            showToast(`已审核: ${specimen.PatName}`, 'success');
            dbg('详情审核成功:', specimen.PatName, 'ReportDR:', reportDR);

            // 确保焦点在主页面（审核操作后焦点可能留在 iframe 中）
            try { window.focus(); } catch(e) {}

            // 从数据中移除
            delete wsClassifiedCache[specimen.ReportDR];
            wsData = wsData.filter(r => r.ReportDR !== specimen.ReportDR);
            invalidateCaches();
            calcMachineCounts();

            // 自动切换到下一个标本（原地更新，不关闭面板）
            if (nextReportDR) {
                const newData = filteredData();
                const nextSpecimen = newData.find(r => r.ReportDR === nextReportDR);
                dbg('下一个标本: 数据量=', newData.length, 'ReportDR=', nextReportDR, 'found=', !!nextSpecimen);
                if (nextSpecimen) {
                    const nextIdx = newData.indexOf(nextSpecimen);
                    // 延迟更新工作台视图，先切换详情
                    requestAnimationFrame(() => {
                        renderWSCategoryBar();
                        renderWSTable();
                    });
                    _switchDetailInPlace(nextSpecimen, source, nextIdx);
                } else {
                    closeDetailPanel();
                    if (source === 'abnormal') wsCategory = 'normal';
                    renderWSCategoryBar();
                    renderWSTable();
                }
            } else {
                closeDetailPanel();
                renderWSCategoryBar();
                renderWSTable();
            }
        } catch(e) {
            dbg('详情面板审核失败:', e);
            showToast('审核失败: ' + e.message, 'error');
        } finally {
            clearTimeout(_detailSafetyTimer);
            _detailAuditInProgress = false;
            if (resumeWSRefresh && isWSVisible()) startWSRefresh();
            dbg('详情审核结束, inProgress 重置为 false');
        }
    }

    function closeDetailPanel() {
        _removeDetailKeyHandler();
        if (detailPanel) {
            detailPanel.classList.remove('show');
            currentDetailSpecimen = null;
            detailSource = null;
            detailSourceIndex = -1;
        }
        // 隐藏遮罩层
        const overlay = document.getElementById('lis-detail-overlay');
        if (overlay) overlay.style.display = 'none';
        // 如果当前是异常视图，恢复键盘监听
        if (wsCategory === 'abnormal') {
            _rebindAbnormalKeyHandler();
        }
    }

    function getStatusText(status) {
        const map = {
            '0': '📦 待排样',
            '1': '📋 登记',
            '2': '🔍 初审',
            '3': '✅ 审核',
            '4': '🔄 复审',
            '5': '❌ 取消'
        };
        return map[String(status)] || '未知';
    }

    // 解析并渲染单个检验项目的历次结果，返回 {cells:[], dates:[]}
    function renderHistoryItems(r) {
        const historyItems = parsePreResult(r);
        if (historyItems.length === 0) return { cells: ['', '', ''], dates: [] };

        // 按日期降序排列（最新的在前），无日期的排最后
        const sorted = [...historyItems].sort((a, b) => {
            if (!a.date && !b.date) return 0;
            if (!a.date) return 1;
            if (!b.date) return -1;
            return b.date.localeCompare(a.date);
        });
        const recent = sorted.slice(0, 3);
        const cells = [];
        const dates = [];
        for (let i = 0; i < 3; i++) {
            if (i < recent.length) {
                const h = recent[i];
                let cls = 'normal';
                // 优先用 AbFlag 判断颜色（从 PreResult 中提取）
                const ab = (h.abFlag || '').toUpperCase();
                if (ab === 'HH' || ab === 'LL') cls = 'critical';
                else if (ab === 'H') cls = 'high';
                else if (ab === 'L') cls = 'low';
                else if (ab === 'A') cls = 'abnormal';
                else {
                    // 回退：用参考范围数值比较
                    const histStatus = compareResultToRange(h.result, r.ValueLow, r.ValueHigh);
                    if (histStatus === 'HIGH') cls = 'high';
                    else if (histStatus === 'LOW') cls = 'low';
                }
                if (!h.date && cls === 'normal') cls = 'nodate';
                const dateStr = h.date ? h.date.split(' ')[0].replace(/^\d{2}(\d{2})/, '$1') : '';
                dates.push(dateStr);
                cells.push(`<span class="hist-tag ${cls}">${esc(h.result)}</span>`);
            } else {
                dates.push('');
                cells.push('<span style="color:#ddd">-</span>');
            }
        }
        return { cells, dates };
    }

    // 健壮解析 PreResult 字段（支持多种格式）
    function parsePreResult(r) {
        const items = [];

        // 尝试所有可能的 PreResult 来源
        const sources = [r.PreResult, r.PreResult1, r.PreResult2, r.PreResult3, r.LabResult, r.HistoryResult];

        for (const src of sources) {
            if (!src) continue;

            // 格式1: 已经是数组
            if (Array.isArray(src)) {
                for (const p of src) {
                    const res = p.Result || p.TCResult || p.result || p.PreResult || '';
                    const dt = p.AcceptDT || p.AcceptDate || p.date || p.Date || '';
                    const ab = (p.AbFlag || p.abFlag || p.Flag || '').toString().toUpperCase().trim();
                    if (res) items.push({ result: String(res).trim(), date: String(dt).trim(), abFlag: ab });
                }
                continue;
            }

            // 格式2: JSON 字符串
            if (typeof src === 'string') {
                const trimmed = src.trim();
                if (!trimmed) continue;

                // 尝试 JSON 解析
                if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
                    try {
                        const parsed = JSON.parse(trimmed);
                        const arr = Array.isArray(parsed) ? parsed : [parsed];
                        for (const p of arr) {
                            const res = p.Result || p.TCResult || p.result || p.PreResult || '';
                            const dt = p.AcceptDT || p.AcceptDate || p.date || p.Date || '';
                            const ab = (p.AbFlag || p.abFlag || p.Flag || '').toString().toUpperCase().trim();
                            if (res) items.push({ result: String(res).trim(), date: String(dt).trim(), abFlag: ab });
                        }
                        continue;
                    } catch(e) {}
                }

                // 格式3: "值(日期), 值(日期)" 格式
                const matches = trimmed.match(/([^(),]+)\(([^)]+)\)/g);
                if (matches) {
                    for (const m of matches) {
                        const parts = m.match(/(.+)\((.+)\)/);
                        if (parts) items.push({ result: parts[1].trim(), date: parts[2].trim(), abFlag: '' });
                    }
                    continue;
                }

                // 格式4: "值^标志^ID^日期" 格式（iMedicalLIS 历史结果格式）
                // 可能是单条 "5.57^H^10197009^20260607" 或逗号分隔多条
                if (trimmed.includes('^')) {
                    // 先按逗号拆分多条记录
                    const records = trimmed.split(',').map(r => r.trim()).filter(Boolean);
                    for (const rec of records) {
                        if (rec.includes('^')) {
                            const parts = rec.split('^');
                            const res = parts[0] || '';
                            const ab = (parts[1] || '').toString().toUpperCase().trim();
                            // parts[1] = 异常标志(H/L/A等), parts[2] = ID, parts[3] = 日期(YYYYMMDD)
                            let date = '';
                            if (parts[3]) {
                                const d = parts[3].trim();
                                if (d.length === 8) {
                                    date = d.slice(0,4) + '-' + d.slice(4,6) + '-' + d.slice(6,8);
                                } else {
                                    date = d;
                                }
                            }
                            if (res) items.push({ result: res.trim(), date: date, abFlag: ab });
                        } else {
                            if (rec) items.push({ result: rec, date: '', abFlag: '' });
                        }
                    }
                    continue;
                }

                // 格式5: 用分隔符隔开的纯值（逗号、分号、竖线）
                if (trimmed.includes(',') || trimmed.includes(';') || trimmed.includes('|')) {
                    const sep = trimmed.includes(',') ? ',' : (trimmed.includes(';') ? ';' : '|');
                    const vals = trimmed.split(sep).map(v => v.trim()).filter(Boolean);
                    for (const v of vals) {
                        items.push({ result: v, date: '', abFlag: '' });
                    }
                    continue;
                }

                // 格式6: 单个值
                items.push({ result: trimmed, date: '', abFlag: '' });
            }
        }

        return items;
    }



    async function loadDetailResults(specimen) {
        const body = document.getElementById('lis-detail-body');
        if (!body) return;
        const rdr = specimen.ReportDR || '';
        const seq = ++_detailLoadSeq;
        const isCurrentDetail = () => detailPanel && detailPanel.classList.contains('show') &&
            currentDetailSpecimen && String(currentDetailSpecimen.ReportDR || '') === String(rdr) &&
            seq === _detailLoadSeq;

        // LRU 缓存命中
        const cached = detailLRUGet(rdr);
        if (cached) {
            dbg('详情缓存命中:', rdr);
            if (!isCurrentDetail()) return;
            body.innerHTML = cached.html;
            return;
        }

        try {
            // 优先使用分类时缓存的原始数据（同一 API 调用）
            let data, itemInfo, labInfo;
            const ss = buildSS(specimen._wg || wgDR());
            const classifyCached = _classifyRawCache[rdr];
            if (classifyCached && (Date.now() - classifyCached.ts < 60000)) {
                dbg('详情命中分类缓存:', rdr);
                data = classifyCached.data;
                itemInfo = (data && data.ItemInfo) ? data.ItemInfo : [];
                labInfo = (data && data.LabInfo) ? data.LabInfo : [];
                delete _classifyRawCache[rdr]; // 用完即删
            } else {
                const statusVal = specimen.Status || specimen.ReportStatus || '';

                const p = new URLSearchParams();
                p.set('ClassName', 'LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
                p.set('QueryName', 'GetReportInfoAll');
                p.set('FunModul', 'MTHD');
                p.set('P0', specimen.ReportDR || '');
                p.set('P1', specimen.MachineParameterDR || '');
                p.set('P2', specimen.WorkGroupMachineDR || '');
                p.set('P3', statusVal);
                p.set('P4', specimen.EpisodeNo || '');
                p.set('P5', specimen.TransmitDate || '');
                p.set('P14', ss);

                dbg('加载标本详情:', specimen.ReportDR, statusVal);
                data = await fetchJ(CSP + '?' + p.toString());
                itemInfo = (data && data.ItemInfo) ? data.ItemInfo : [];
                labInfo = (data && data.LabInfo) ? data.LabInfo : [];

                if (itemInfo.length === 0 && statusVal) {
                    dbg('状态', statusVal, '返回空结果，用空状态重试');
                    p.set('P3', '');
                    data = await fetchJ(CSP + '?' + p.toString());
                    itemInfo = (data && data.ItemInfo) ? data.ItemInfo : [];
                    if (!labInfo.length) labInfo = (data && data.LabInfo) ? data.LabInfo : [];
                }
            }

            // 调试：打印所有项目的字段和 PreResult
            if (DEBUG && itemInfo.length > 0) {
                dbg('=== PreResult 诊断 ===');
                dbg('Item0 字段:', Object.keys(itemInfo[0]).join(', '));
                itemInfo.forEach((item, i) => {
                    const pr = item.PreResult;
                    const prType = Array.isArray(pr) ? 'array[' + pr.length + ']' : typeof pr;
                    dbg(`  ${i+1}. ${item.CName}: PreResult(${prType})=`, pr === null ? 'null' : pr === undefined ? 'undefined' : JSON.stringify(pr).slice(0, 200));
                    // 检查其他可能的历史字段
                    ['PreResult1','PreResult2','PreResult3','LabResult','HistoryResult','OldResult'].forEach(k => {
                        if (item[k] !== undefined && item[k] !== null && item[k] !== '') {
                            dbg(`    ${k}=`, JSON.stringify(item[k]).slice(0, 200));
                        }
                    });
                });
                dbg('=== 诊断结束 ===');
            }

            // 并行 fallback: 检查历史结果是否为空，同时发起备用查询
            const allPreEmpty = itemInfo.every(item => parsePreResult(item).length === 0);
            if (allPreEmpty && itemInfo.length > 0) {
                dbg('所有 PreResult 为空，并行尝试备用查询...');
                const fallbackPromises = [];
                // 备用查询1: 空状态参数
                const p2 = new URLSearchParams();
                p2.set('ClassName', 'LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
                p2.set('QueryName', 'GetReportInfoAll');
                p2.set('FunModul', 'MTHD');
                p2.set('P0', specimen.ReportDR || '');
                p2.set('P1', specimen.MachineParameterDR || '');
                p2.set('P2', specimen.WorkGroupMachineDR || '');
                p2.set('P3', '');
                p2.set('P4', specimen.EpisodeNo || '');
                p2.set('P5', specimen.TransmitDate || '');
                p2.set('P14', ss);
                fallbackPromises.push(fetchJ(CSP + '?' + p2.toString()).catch(() => null));
                // 备用查询2: GetPatientPreResult
                const episodeNo = specimen.EpisodeNo || (labInfo.length > 0 ? labInfo[0].EpisodeNo : '');
                const regNo = specimen.RegNo || (labInfo.length > 0 ? labInfo[0].RegNo : '');
                if (episodeNo || regNo) {
                    const pH = new URLSearchParams();
                    pH.set('ClassName', 'LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
                    pH.set('QueryName', 'GetPatientPreResult');
                    pH.set('FunModul', 'MTHD');
                    pH.set('P0', specimen.ReportDR || '');
                    pH.set('P1', episodeNo);
                    pH.set('P2', regNo);
                    pH.set('P14', ss);
                    fallbackPromises.push(fetchJ(CSP + '?' + pH.toString()).catch(() => null));
                } else {
                    fallbackPromises.push(Promise.resolve(null));
                }
                // 并行执行
                const [data2, histData] = await Promise.all(fallbackPromises);
                // 合并备用查询1结果
                if (data2) {
                    const itemInfo2 = (data2 && data2.ItemInfo) ? data2.ItemInfo : [];
                    if (itemInfo2.length > 0 && parsePreResult(itemInfo2[0]).length > 0) {
                        itemInfo = itemInfo2;
                    }
                }
                // 合并备用查询2结果
                if (histData && histData.length > 0) {
                    const histMap = {};
                    for (const h of histData) {
                        const key = h.TestCodeDR || h.TCCode || h.CName;
                        if (key) {
                            if (!histMap[key]) histMap[key] = [];
                            histMap[key].push(h);
                        }
                    }
                    for (const item of itemInfo) {
                        const key = item.TestCodeDR || item.TCCode || item.CName;
                        if (histMap[key] && histMap[key].length > 0) {
                            item.PreResult = histMap[key];
                        }
                    }
                }
            }

            if (itemInfo.length === 0) {
                if (!isCurrentDetail()) return;
                body.innerHTML = '<div style="text-align:center;padding:40px;color:#999">未找到结果数据</div>';
                return;
            }
            // 渲染结果
            let html = '';

            // 统计摘要栏
            const totalItems = itemInfo.length;
            const doneItems = itemInfo.filter(r => {
                const v = ((r.TextRes && String(r.TextRes).trim()) ? r.TextRes : (r.Result || '')).trim();
                return !isEmptyResultValue(r, v);
            }).length;
            const abnItems = itemInfo.filter(r => classifyResultItem(r) !== 'NORMAL' && classifyResultItem(r) !== 'UNCERTAIN').length;
            const critItems = itemInfo.filter(r => isCriticalResultItem(r)).length;
            const pendItems = totalItems - doneItems;

            html += '<div style="display:flex;align-items:center;gap:16px;padding:8px 0;font-size:12px;flex-wrap:wrap">';
            html += `<span style="font-weight:600">✅ 已检: ${doneItems}/${totalItems}</span>`;
            if (pendItems > 0) html += `<span style="color:#ff9800;font-weight:600">⏳ 待检: ${pendItems}</span>`;
            if (abnItems > 0) html += `<span style="color:#e74c3c;font-weight:600">⚠ 异常: ${abnItems}</span>`;
            if (critItems > 0) html += `<span style="color:#b71c1c;font-weight:700">🚨 危急: ${critItems}</span>`;
            html += '</div>';

            // 结果表格（紧凑布局）
            html += '<table class="result-table" style="font-size:12px">';

            // 收集历史日期
            const allDates = [[], [], []];
            itemInfo.forEach(r => {
                const hi = parsePreResult(r);
                const sorted = [...hi].sort((a, b) => {
                    if (!a.date && !b.date) return 0;
                    if (!a.date) return 1;
                    if (!b.date) return -1;
                    return b.date.localeCompare(a.date);
                });
                const recent = sorted.slice(0, 3);
                for (let i = 0; i < 3; i++) {
                    if (i < recent.length && recent[i].date) {
                        const d = recent[i].date.split(' ')[0].replace(/^\d{2}(\d{2})/, '$1');
                        if (d) allDates[i].push(d);
                    }
                }
            });
            const hdrDates = allDates.map(arr => {
                if (arr.length === 0) return '';
                const freq = {};
                arr.forEach(d => { freq[d] = (freq[d]||0)+1; });
                return Object.keys(freq).sort((a,b) => freq[b]-freq[a])[0];
            });
            const thDates = hdrDates.map(d => d ? `<th style="font-size:11px">${esc(d)}</th>` : '<th style="font-size:11px">-</th>').join('');

            html += `<thead><tr><th style='width:20px'>QC</th><th>项目</th><th>结果</th><th>参考范围</th><th>状态</th>${thDates}</tr></thead>`;
            html += '<tbody>';

            itemInfo.forEach(r => {
                const result = (r.TextRes && r.TextRes.trim()) ? r.TextRes.trim() : (r.Result || '-');
                const unit = r.Unit || r.Units || '';
                const refRange = r.RefRanges || '-';
                const abnormalFlag = (r.AbFlag || '').toUpperCase().trim();

                const rawResult = ((r.TextRes && String(r.TextRes).trim()) ? r.TextRes : (r.Result || '')).trim();
                const isEmpty = isEmptyResultValue(r, rawResult);
                let isAbnormal = false, isCritical = false;
                let statusText = isEmpty ? '⏳ 待检' : '✓';
                let rowStyle = isEmpty ? 'background:#fafafa;color:#bbb' : '';

                const itemStatus = classifyResultItem(r);
                const criticalByRange = itemStatus === 'CRITICAL';
                const panicStatus = compareResultToPanicRange(result, r);

                if (criticalByRange) {
                    isAbnormal = true; isCritical = true;
                    statusText = (abnormalFlag === 'LL' || panicStatus === 'LOW') ? '↓↓ 危急' : '↑↑ 危急';
                    rowStyle = 'background:#fff5f5;border-left:3px solid #e74c3c';
                } else if (abnormalFlag === 'H') {
                    isAbnormal = true; statusText = '↑ 高';
                    rowStyle = 'background:#fff8e1;border-left:3px solid #ff9800';
                } else if (abnormalFlag === 'L') {
                    isAbnormal = true; statusText = '↓ 低';
                    rowStyle = 'background:#e3f2fd;border-left:3px solid #2196f3';
                } else if (abnormalFlag === 'A') {
                    isAbnormal = true; statusText = '⚠ 异常';
                    rowStyle = 'background:#fce4ec;border-left:3px solid #e91e63';
                } else if (itemStatus === 'ABNORMAL') {
                    isAbnormal = true; statusText = '⚠ 异常';
                    rowStyle = 'background:#fce4ec;border-left:3px solid #e91e63';
                } else if (itemStatus === 'HIGH') {
                    isAbnormal = true; statusText = '↑ 高';
                    rowStyle = 'background:#fff8e1;border-left:3px solid #ff9800';
                } else if (itemStatus === 'LOW') {
                    isAbnormal = true; statusText = '↓ 低';
                    rowStyle = 'background:#e3f2fd;border-left:3px solid #2196f3';
                } else if (r.ValueLow && r.ValueHigh) {
                    const rangeStatus = compareResultToRange(result, r.ValueLow, r.ValueHigh);
                    if (rangeStatus === 'HIGH') {
                        isAbnormal = true; statusText = '↑ 高'; rowStyle = 'background:#fff8e1;border-left:3px solid #ff9800';
                    } else if (rangeStatus === 'LOW') {
                        isAbnormal = true; statusText = '↓ 低'; rowStyle = 'background:#e3f2fd;border-left:3px solid #2196f3';
                    }
                }

                let statusClass = isAbnormal ? 'abnormal' : 'normal';
                if (isCritical) statusClass = 'abnormal critical';
                else if (statusText.includes('高')) statusClass = 'abnormal high';
                else if (statusText.includes('低')) statusClass = 'abnormal low';

                // 参考范围带单位
                const refWithUnit = unit ? refRange + ' ' + unit : refRange;

                // 历史结果
                const hist = renderHistoryItems(r);

                                // QC 状态图标
                let qcHtml = '';
                const qcf = (r.QcFlag || '').split('^');
                const qcs = qcf[0] || '0';
                if (qcs === '0') {
                    qcHtml = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid #bbb;background:#f5f5f5" title="未做质控"></span>';
                } else if (qcs === '1') {
                    qcHtml = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#4caf50;box-shadow:0 0 4px rgba(76,175,80,.5)" title="质控正常"></span>';
                } else if (qcs === '2') {
                    qcHtml = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#ff9800;box-shadow:0 0 4px rgba(255,152,0,.5)" title="质控正常·警告未处理"></span>';
                } else if (qcs === '3') {
                    qcHtml = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#e74c3c;box-shadow:0 0 4px rgba(231,76,60,.5)" title="质控正常·失控未处理"></span>';
                } else if (qcs === '4') {
                    qcHtml = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#2196f3;box-shadow:0 0 4px rgba(33,150,243,.5)" title="质控正常·警告/失控已处理"></span>';
                } else if (qcs === '5') {
                    qcHtml = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#e74c3c;box-shadow:0 0 6px rgba(231,76,60,.7)" title="质控失控"></span>';
                } else if (qcs === '6') {
                    qcHtml = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#9e9e9e;box-shadow:0 0 4px rgba(158,158,158,.5)" title="批次过期"></span>';
                } else {
                    qcHtml = '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid #bbb;background:#f5f5f5" title="未知"></span>';
                }

                html += `<tr style="${rowStyle}">
                    <td style="text-align:center">${qcHtml}</td>
                    <td style="font-weight:500;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${esc(r.CName || '')}">${esc(r.CName || '-')}</td>
                    <td class="${statusClass}" style="font-weight:700;font-size:13px;white-space:nowrap">${esc(result)}${unit ? ' <span style="font-size:10px;color:#999;font-weight:400">' + esc(unit) + '</span>' : ''}</td>
                    <td style="color:#888;font-size:11px;white-space:nowrap">${esc(refWithUnit)}</td>
                    <td class="${statusClass}" style="white-space:nowrap;font-size:11px">${isCritical ? '<span style="color:#e74c3c;font-weight:700">' + statusText + '</span>' : statusText}</td>
                    <td style="font-size:11px">${hist.cells[0]}</td>
                    <td style="font-size:11px">${hist.cells[1]}</td>
                    <td style="font-size:11px">${hist.cells[2]}</td>
                </tr>`;
            });

            html += '</tbody></table>';

            // 患者信息（可折叠）
            if (labInfo.length > 0) {
                const info = labInfo[0];
                let timeDelta = '';
                if (info.CollectDT && info.ReceiveDT) {
                    try {
                        const diffMs = new Date(info.ReceiveDT) - new Date(info.CollectDT);
                        if (isNaN(diffMs)) throw new Error('invalid date');
                        const diffH = Math.floor(diffMs / 3600000);
                        const diffM = Math.floor((diffMs % 3600000) / 60000);
                        timeDelta = diffH > 0 ? diffH + '小时' + diffM + '分' : diffM + '分钟';
                    } catch(e) {}
                }

                // 更新深色头部患者详情行
                const extraEl = document.getElementById('lis-detail-extra');
                if (extraEl) {
                    extraEl.textContent = buildDetailExtraText(info, specimen);
                }

                // 异常警告（内联）
                if (critItems > 0) {
                    html += '<div style="margin-top:6px;padding:6px 10px;background:#fff5f5;border-radius:4px;font-size:11px;border:1px solid #ffcdd2">';
                    html += '<span style="color:#e74c3c;font-weight:700">🚨 危急值 ' + critItems + ' 项</span>';
                    html += '<span style="margin-left:12px;color:#c62828;font-size:10px">须在原始LIS中审核</span>';
                    html += '</div>';
                } else if (abnItems > 0) {
                    // 列出具体异常项目名称
                    const abnNames = itemInfo.filter(r => classifyResultItem(r) !== 'NORMAL' && classifyResultItem(r) !== 'UNCERTAIN')
                        .map(r => {
                            const st = classifyResultItem(r);
                            const arrow = st === 'CRITICAL'
                                ? (compareResultToPanicRange((r.TextRes && r.TextRes.trim()) ? r.TextRes : r.Result, r) === 'LOW' || String(r.AbFlag || '').toUpperCase() === 'LL' ? '↓↓危急' : '↑↑危急')
                                : st === 'HIGH' ? '↑' : st === 'LOW' ? '↓' : '⚠';
                            return esc((r.CName||'')+' '+(r.TextRes||r.Result||'')+' '+arrow);
                        });
                    html += '<div style="margin-top:6px;padding:6px 10px;background:#fff8e1;border-radius:4px;font-size:11px;border:1px solid #ffecb3">';
                    html += '<span style="color:#ff9800;font-weight:600">⚠ 异常项目 ' + abnItems + ' 项</span>';
                    if (abnNames.length > 0) html += '<span style="margin-left:8px;color:#e65100;font-size:10px">' + abnNames.join('、') + '</span>';
                    html += '</div>';
                }

                // 传染病历史比对
                const cached = wsClassifiedCache[specimen.ReportDR];
                if (cached && cached.infectionWarning) {
                    html += '<div style="margin-top:6px;padding:6px 10px;background:#fff3e0;border-radius:4px;font-size:11px;border:1px solid #ffcc80">';
                    html += '<span style="color:#e65100;font-weight:700">⚠️ 与历史结果不一致</span>';
                    html += '<div style="color:#bf360c;font-size:10px;margin-top:2px">' + esc(cached.infectionWarning) + '</div>';
                    html += '</div>';
                }
            }

            if (!isCurrentDetail()) return;
            body.innerHTML = html;
            const _dp = document.getElementById('lis-detail-panel');
            if (_dp) {
                _dp.dataset.rdr = String(rdr);
                _dp.dataset.hasCritical = critItems > 0 ? '1' : '0';
            }
            // 存入 LRU 缓存
            detailLRUSet(rdr, { html, ts: Date.now() });




        } catch (e) {
            dbg('加载详细结果失败:', e);
            if (!isCurrentDetail()) return;
            body.innerHTML = `
                <div style="text-align:center;padding:40px;color:#e74c3c">
                    <p>❌ 加载失败</p>
                    <p style="font-size:12px">${esc(e.message)}</p>
                </div>
            `;
        }
    }

    // 检查是否有待导航目标（页面加载后）
    function checkNavigateTarget() {
        try {
            const raw = localStorage.getItem(K.tgt);
            if (!raw) return;
            const tgt = JSON.parse(raw);
            if (!tgt || Date.now() - tgt.time > 30000) { localStorage.removeItem(K.tgt); return; }
            localStorage.removeItem(K.tgt);

            const curDR = wgDR();
            if (tgt.wgDR !== curDR) return; // 工作组不匹配，可能还在切换中

            // 延迟执行，等待页面完全加载
            setTimeout(() => {
                try {
                    const w = uw();
                    if (tgt.machineDR && w.me) {
                        w.me.WorkGroupMachineDR = tgt.machineDR;
                        if (typeof w.$ !== 'undefined') {
                            try { w.$('#cmb_WorkGroupMachine').combogrid('setValue', tgt.machineDR); } catch(e){}
                        }
                    }
                    if (tgt.labno) {
                        if (typeof w.$ !== 'undefined') {
                            try { w.$('#txt_FindFast').val(tgt.labno); } catch(e){}
                        }
                        if (typeof w.FindFast === 'function') {
                            w.FindFast(tgt.labno);
                        }
                    }
                    // 等待搜索结果加载并选中对应行
                    setTimeout(() => {
                        try {
                            const iframeWin = getReportIframeWin();
                            if (!iframeWin) return;
                            const jq = iframeWin.jQuery || iframeWin.$;
                            if (!jq) return;
                            const dg = jq('#dgWorkList');
                            if (!dg.length) return;
                            const rows = dg.datagrid('getRows');
                            if (!rows || rows.length === 0) return;
                            // 根据 ReportDR 或 Labno 选中对应行
                            for (let i = 0; i < rows.length; i++) {
                                if (String(rows[i].ReportDR) === String(tgt.reportDR) || 
                                    String(rows[i].Labno) === String(tgt.labno)) {
                                    dg.datagrid('selectRow', i);
                                    dbg('导航: 已选中行', i, 'ReportDR:', tgt.reportDR);
                                    break;
                                }
                            }
                        } catch(e) {
                            dbg('导航选行失败:', e);
                        }
                    }, 1500);
                } catch(e){}
            }, 1500);
        } catch(e){}
    }

    // --- 创建工作台 UI ---
    function createWS() {
        if (document.getElementById('lis-ws')) return; // 防止重复创建
        // 工作台容器
        const ws = document.createElement('div');
        ws.id = 'lis-ws';
        ws.innerHTML = `
            <div id="lis-ws-hd"></div>
            <div id="lis-ws-tabs"></div>
            <div id="lis-ws-bar"></div>
            <div id="lis-ws-body"></div>
            <div id="lis-ws-ft">
                <span>本地工作台</span>
                <span id="lis-ws-ft-stat"></span>
            </div>`;
        document.body.appendChild(ws);

        // 监控工作台属性变化（检测是否有外部代码修改 class 或 style）
        const wsAttrObserver = new MutationObserver(muts => {
            for (const m of muts) {
                if (m.type === 'attributes' && m.target.id === 'lis-ws') {
                    dbg('[WS] #lis-ws 属性变化:', m.attributeName, 'class=', ws.className, 'style=', ws.style.cssText);
                }
            }
        });
        wsAttrObserver.observe(ws, { attributes: true, attributeFilter: ['class', 'style'] });

        // 浮动按钮（可拖动，记忆位置）
        const fab = document.createElement('button');
        fab.id = 'lis-fab';
        fab.innerHTML = '🔬';
        fab.title = '拖动移动 | 点击打开工作台';
        // 恢复上次位置
        try {
            const wp = JSON.parse(localStorage.getItem('lis-fab-pos') || '');
            if (wp && typeof wp.l === 'number') {
                fab.style.left = wp.l + 'px'; fab.style.top = wp.t + 'px';
                fab.style.right = 'auto'; fab.style.bottom = 'auto';
            }
        } catch(e) {}
        document.body.appendChild(fab);

        const tip = document.createElement('div');
        tip.id = 'lis-fab-tip';
        tip.textContent = '点击打开审核工作台';
        document.body.appendChild(tip);

        // 拖动功能（pointer events）
        let fabDragging = false, fabMoved = false, fabStartX, fabStartY, fabOrigX, fabOrigY;
        fab.addEventListener('pointerdown', e => {
            fabDragging = true; fabMoved = false;
            fabStartX = e.clientX; fabStartY = e.clientY;
            fabOrigX = fab.offsetLeft; fabOrigY = fab.offsetTop;
            fab.setPointerCapture(e.pointerId);
            fab.style.transition = 'none';
            e.preventDefault();
        });
        fab.addEventListener('pointermove', e => {
            if (!fabDragging) return;
            const dx = e.clientX - fabStartX, dy = e.clientY - fabStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) fabMoved = true;
            if (fabMoved) {
                fab.style.left = Math.max(0, fabOrigX + dx) + 'px';
                fab.style.top = Math.max(0, fabOrigY + dy) + 'px';
                fab.style.right = 'auto';
                fab.style.bottom = 'auto';
            }
        });
        fab.addEventListener('pointerup', () => {
            fabDragging = false; fab.style.transition = '';
            if (fabMoved) {
                try { localStorage.setItem('lis-fab-pos', JSON.stringify({ l: fab.offsetLeft, t: fab.offsetTop })); } catch(e) {}
            }
        });
        // 点击（拖动后不触发）
        fab.addEventListener('click', e => { if (!fabMoved) openWS(); });
        fab.addEventListener('mouseenter', () => tip.classList.add('show'));
        fab.addEventListener('mouseleave', () => tip.classList.remove('show'));

        // 键盘快捷键
        document.addEventListener('keydown', e => {
            if (e.key==='Escape') { closeWS(); closePwdDlg(); }
        });
    }

    function toggleWS() {
        if ($('#lis-ws').classList.contains('show')) closeWS();
        else openWS();
    }

    // --- 密码设置弹窗 ---
    async function openPwdDlg() {
        let o = document.getElementById('lis-pwdo');
        if (!o) {
            o = document.createElement('div');
            o.id = 'lis-pwdo';
            o.innerHTML = `<div id="lis-pwdp">
                <h4>🔐 密码管理</h4>
                <label style="font-size:13px;color:#555;display:block;margin-bottom:6px">审核密码（与登录密码一致）</label>
                <input type="password" id="lis-pwdi" placeholder="输入审核密码" />
                <div class="sts" id="lis-pwds"></div>
                <label style="font-size:13px;color:#555;display:block;margin-bottom:6px;margin-top:16px">CA认证密码（与登录密码不同）</label>
                <input type="password" id="lis-cawdi" placeholder="输入CA认证密码" />
                <div class="sts" id="lis-cawds"></div>
                <div class="pa">
                    <button class="b-clr" id="lis-pwdc">清除全部</button>
                    <button class="b-can" id="lis-pwdca">取消</button>
                    <button class="b-save" id="lis-pwdsave">保存</button>
                </div>
                <div class="tip">💡 密码保存在浏览器 localStorage 中，仅本机可用。<br>保存后审核登录和CA认证将自动填充。</div>
            </div>`;
            document.body.appendChild(o);
            document.getElementById('lis-pwdsave').addEventListener('click', async () => {
                const auditPwd = document.getElementById('lis-pwdi').value;
                const caPwd = document.getElementById('lis-cawdi').value;
                if (auditPwd) await savePwdAsync(auditPwd);
                if (caPwd) await saveCAPwdAsync(caPwd);
                document.getElementById('lis-pwds').innerHTML='<span style="color:#27ae60">✓ 已保存</span>';
                document.getElementById('lis-cawds').innerHTML='<span style="color:#27ae60">✓ 已保存</span>';
                toast('密码已保存');
                setTimeout(closePwdDlg, 600);
            });
            document.getElementById('lis-pwdc').addEventListener('click', () => {
                try { localStorage.removeItem(K.pwd); localStorage.removeItem(K.caPwd); } catch(e){}
                document.getElementById('lis-pwdi').value='';
                document.getElementById('lis-cawdi').value='';
                document.getElementById('lis-pwds').innerHTML='<span style="color:#e74c3c">✓ 已清除</span>';
                document.getElementById('lis-cawds').innerHTML='<span style="color:#e74c3c">✓ 已清除</span>';
                toast('密码已清除','w');
            });
            document.getElementById('lis-pwdca').addEventListener('click', closePwdDlg);
            o.addEventListener('click', e => { if(e.target===o) closePwdDlg(); });
        }
        const pwd = await loadPwdAsync();
        document.getElementById('lis-pwdi').value = pwd;
        document.getElementById('lis-pwds').textContent = pwd ? '当前已保存审核密码' : '尚未保存审核密码';
        const caPwd = await loadCAPwdAsync();
        document.getElementById('lis-cawdi').value = caPwd;
        document.getElementById('lis-cawds').textContent = caPwd ? '当前已保存CA密码' : '尚未保存CA密码';
        o.classList.add('show');
        document.getElementById('lis-pwdi').focus();
    }
    function closePwdDlg() { const o=document.getElementById('lis-pwdo'); if(o) o.classList.remove('show'); }



    // ============================================================
    //  模块 E：登录页优化
    // ============================================================
    const LOGIN_CREDS_KEY = 'LIS_LoginCreds';
    const LOGIN_WG_KEY = 'LIS_LastWorkGroup';

    function initLoginPage() {
        dbg('检测到登录页面，启动登录优化');

        // 恢复保存的凭证
        const creds = loadLoginCreds();
        const lastWG = localStorage.getItem(LOGIN_WG_KEY) || '4';

        // 创建快速登录面板
        createLoginPanel(creds, lastWG);

        // 也尝试直接填充原生表单
        setTimeout(() => fillNativeLoginForm(creds, lastWG), 500);
        setTimeout(() => fillNativeLoginForm(creds, lastWG), 1500);

        // 如果有保存的凭证且是从切换工作组跳转来的，自动登录
        if (creds && localStorage.getItem('LIS_AutoLogin') === '1') {
            localStorage.removeItem('LIS_AutoLogin');
            dbg('检测到自动登录标记，' + (creds ? '有凭证' : '无凭证'));
            // 等页面加载完成后自动触发登录
            setTimeout(() => doLogin(lastWG), 2000);
        }
    }

    function loadLoginCreds() {
        try {
            const raw = localStorage.getItem(LOGIN_CREDS_KEY);
            if (!raw) return null;
            const obj = JSON.parse(decPwd(raw));
            return obj && obj.user ? obj : null;
        } catch(e) { return null; }
    }

    function saveLoginCreds(user, wg) {
        try {
            const obj = { user: user, ts: Date.now() };
            localStorage.setItem(LOGIN_CREDS_KEY, encPwd(JSON.stringify(obj)));
            if (wg) localStorage.setItem(LOGIN_WG_KEY, wg);
        } catch(e) {}
    }

    function clearLoginCreds() {
        try { localStorage.removeItem(LOGIN_CREDS_KEY); } catch(e) {}
    }

    function createLoginPanel(creds, lastWG) {
        const box = document.createElement('div');
        box.id = 'lis-login-box';

        const wgs = [
            { dr:'4', name:'免疫', color:'#2ecc71', icon:'🛡️' },
            { dr:'1', name:'临检', color:'#e74c3c', icon:'🩸' },
            { dr:'3', name:'生化', color:'#3498db', icon:'🧪' },
        ];

        let wgHTML = '';
        wgs.forEach(w => {
            wgHTML += `<button type="button" data-dr="${w.dr}" style="border-color:${w.dr===lastWG?w.color:'#e0e0e0'};background:${w.dr===lastWG?w.color:'#fff'};color:${w.dr===lastWG?'#fff':'#333'}">${w.icon} ${w.name}</button>`;
        });

        box.innerHTML = `
            <h4>⚡ 快速登录 — iMedicalLIS</h4>
            <div class="lis-lb-row">
                <label>用户名</label>
                <input type="text" id="lis-lu" placeholder="用户名" value="${creds?esc(creds.user):''}" autocomplete="username" />
            </div>
            <div class="lis-lb-row">
                <label>密码</label>
                <input type="password" id="lis-lp" placeholder="密码" autocomplete="current-password" />
            </div>
            <div class="lis-lb-row">
                <label>工作组</label>
                <div class="lis-lb-wg" id="lis-lwg">${wgHTML}</div>
            </div>
            <button class="lis-lb-login" id="lis-lbtn">🚀 登录</button>
            <div class="lis-lb-tip">
                🔒 仅保存用户名，密码需每次输入<br>
                快捷键: Enter 直接登录
            </div>`;
        document.body.appendChild(box);

        // 工作组选择
        let selectedWG = lastWG;
        box.querySelectorAll('.lis-lb-wg button').forEach(btn => {
            btn.addEventListener('click', () => {
                box.querySelectorAll('.lis-lb-wg button').forEach(b => {
                    b.classList.remove('sel');
                    b.style.background = '#fff';
                    b.style.color = '#333';
                    b.style.borderColor = '#e0e0e0';
                });
                btn.classList.add('sel');
                btn.style.background = btn.style.borderColor = (wgs.find(w=>w.dr===btn.dataset.dr) || {}).color || '#e0e0e0';
                btn.style.color = '#fff';
                selectedWG = btn.dataset.dr;
            });
        });

        // 登录按钮
        const loginBtn = document.getElementById('lis-lbtn');
        loginBtn.addEventListener('click', () => doLogin(selectedWG));

        // Enter 快捷键
        box.addEventListener('keydown', e => {
            if (e.key === 'Enter') doLogin(selectedWG);
        });

        // 如果有保存的凭证，聚焦到登录按钮
        if (creds) {
            loginBtn.focus();
        }
    }

    function doLogin(wgDR) {
        const luEl = document.getElementById('lis-lu');
        const lpEl = document.getElementById('lis-lp');
        if (!luEl || !lpEl) return;
        const user = luEl.value.trim();
        const pwd = lpEl.value;
        if (!user || !pwd) { toast('请输入用户名和密码', 'w'); return; }

        const btn = document.getElementById('lis-lbtn');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 登录中...'; }

        // 只保存用户名
        saveLoginCreds(user, wgDR);
        try { localStorage.setItem(LOGIN_WG_KEY, wgDR); } catch(e) {}

        // 必须走原生表单流程（服务器需要先 checkUser 创建安全组会话）
        fillNativeAndSubmit(user, pwd, wgDR);
    }
function fillNativeLoginForm(creds, lastWG) {
        try {
            const userField = document.getElementById('txtUserCode');
            const wgSelect = document.getElementById('cmbWorkGroup');

            if (creds && userField && !userField.value) {
                userField.value = creds.user;
                userField.dispatchEvent(new Event('input', {bubbles:true}));
                userField.dispatchEvent(new Event('change', {bubbles:true}));
            }
            // 等待工作组加载后设置默认
            setTimeout(() => {
                if (wgSelect && lastWG) {
                    const options = wgSelect.options;
                    for (let i = 0; i < options.length; i++) {
                        if (options[i].value === lastWG) {
                            wgSelect.value = lastWG;
                            break;
                        }
                    }
                }
            }, 1000);
        } catch(e) {}
    }

    function fillNativeAndSubmit(user, pwd, wgDR) {
        try {
            const userField = document.getElementById('txtUserCode');
            const pwdField = document.getElementById('txtPassword');

            // 1. 填充用户名
            if (userField) {
                userField.value = user;
                userField.dispatchEvent(new Event('input', {bubbles:true}));
            }

            // 2. 填充密码
            if (pwdField) {
                pwdField.value = pwd;
                pwdField.type = 'password';
                pwdField.dispatchEvent(new Event('input', {bubbles:true}));
            }

            // 3. 触发 checkUser() —— 关键！验证用户并加载工作组/安全组列表
            if (pwdField) {
                pwdField.dispatchEvent(new Event('blur', {bubbles:true}));
            }
            if (typeof checkUser === 'function') {
                checkUser();
            }

            // 4. 等待工作组列表加载完成后自动选择并提交
            let attempts = 0;
            const timer = setInterval(() => {
                attempts++;
                const wgSelect = document.getElementById('cmbWorkGroup');
                let targetFound = false;
                let hasOptions = false;

                if (wgSelect && wgSelect.options) {
                    hasOptions = wgSelect.options.length > 1;
                    for (let i = 0; i < wgSelect.options.length; i++) {
                        if (wgSelect.options[i].value === wgDR) {
                            targetFound = true;
                            break;
                        }
                    }
                }

                if (targetFound) {
                    clearInterval(timer);
                    wgSelect.value = wgDR;
                    wgSelect.dispatchEvent(new Event('change', {bubbles:true}));
                    setTimeout(() => {
                        const btn = document.getElementById('btnOK');
                        if (typeof login === 'function') login(btn);
                        else if (btn) btn.click();
                    }, 300);
                } else if (hasOptions) {
                    clearInterval(timer);
                    dbg('未找到工作组DR=' + wgDR + '，使用第一个');
                    wgSelect.selectedIndex = 1;
                    wgSelect.dispatchEvent(new Event('change', {bubbles:true}));
                    setTimeout(() => {
                        const btn = document.getElementById('btnOK');
                        if (typeof login === 'function') login(btn);
                        else if (btn) btn.click();
                    }, 300);
                } else if (attempts >= 20) {
                    clearInterval(timer);
                    toast('工作组加载超时，请手动选择', 'w');
                    const btn = document.getElementById('lis-lbtn');
                    if (btn) { btn.disabled = false; btn.textContent = '🚀 登录'; }
                }
            }, 500);

        } catch(e) {
            dbg('登录出错:', e);
            toast('自动登录出错，请手动登录', 'e');
            const btn = document.getElementById('lis-lbtn');
            if (btn) { btn.disabled = false; btn.textContent = '🚀 登录'; }
        }
    }

    //  模块 C2：报告处理页增强工具栏（审核流程优化核心）
    // ============================================================

    // --- 样式注入 ---
    GM_addStyle(`
/* --- 增强工具栏 --- */
#lis-toolbar{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:100010;background:rgba(26,82,118,.95);backdrop-filter:blur(6px);padding:3px 12px;display:none;align-items:center;gap:6px;font-family:'Microsoft YaHei',sans-serif;border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.3);transition:transform .2s,opacity .2s}
#lis-toolbar.show{display:flex}
#lis-toolbar.hide{transform:translateX(-50%) translateY(-100%);opacity:0;pointer-events:none}
#lis-toolbar .tb-title{color:#fff;font-size:11px;font-weight:600;white-space:nowrap}
#lis-toolbar .tb-sep{width:1px;height:16px;background:rgba(255,255,255,.3)}
#lis-toolbar .tb-stat{display:flex;gap:4px;align-items:center}
#lis-toolbar .tb-stat span{padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600;color:#fff}
#lis-toolbar .tb-stat .st-normal{background:#27ae60}
#lis-toolbar .tb-stat .st-abnormal{background:#e74c3c}
#lis-toolbar .tb-stat .st-uncertain{background:#f39c12}
#lis-toolbar .tb-stat .st-total{background:rgba(255,255,255,.2)}
#lis-toolbar .tb-btn{padding:3px 10px;border:none;border-radius:3px;font-size:11px;font-weight:600;cursor:pointer;transition:.15s;white-space:nowrap}
#lis-toolbar .tb-btn:hover{filter:brightness(1.1)}
#lis-toolbar .tb-btn:active{transform:scale(.95)}
#lis-toolbar .tb-btn.btn-audit{background:#27ae60;color:#fff}
#lis-toolbar .tb-btn.btn-batch{background:#e67e22;color:#fff}
#lis-toolbar .tb-btn.btn-refresh{background:#3498db;color:#fff}
#lis-toolbar .tb-btn.btn-pwd{background:#9b59b6;color:#fff}
#lis-toolbar .tb-btn:disabled{opacity:.5;cursor:not-allowed}
#lis-toolbar .tb-shortcut{color:rgba(255,255,255,.5);font-size:9px;margin-left:auto;white-space:nowrap}
#lis-toolbar .tb-shortcut kbd{background:rgba(255,255,255,.15);padding:0 3px;border-radius:2px;font-family:monospace}
#lis-toolbar .tb-close{background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;font-size:12px;padding:2px 4px;border-radius:3px;margin-left:4px}
#lis-toolbar .tb-close:hover{color:#fff;background:rgba(255,255,255,.15)}

/* 顶部悬停展开条 */
#lis-tb-hoverzone{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:100009;width:120px;height:4px;background:transparent;cursor:pointer;transition:background .2s}
#lis-tb-hoverzone:hover{background:rgba(26,82,118,.5);border-radius:0 0 4px 4px}
#lis-tb-hoverzone:hover::after{content:'▼ 审核';position:absolute;top:4px;left:50%;transform:translateX(-50%);background:rgba(26,82,118,.9);color:#fff;padding:2px 8px;border-radius:0 0 4px 4px;font-size:10px;white-space:nowrap}
#lis-tb-hoverzone.hidden{display:none}

/* --- 审核确认对话框 --- */
#lis-audit-confirm,#lis-queue-resume{position:fixed;inset:0;z-index:100020;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
#lis-audit-confirm.show,#lis-queue-resume.show{display:flex}
#lis-audit-box{background:#fff;border-radius:12px;width:560px;max-height:80vh;display:flex;flex-direction:column;box-shadow:0 20px 60px rgba(0,0,0,.4)}
#lis-audit-box .ab-hd{padding:16px 20px;border-bottom:1px solid #eee;display:flex;align-items:center;justify-content:space-between}
#lis-audit-box .ab-hd h4{margin:0;font-size:16px;color:#2c3e50}
#lis-audit-box .ab-hd .ab-close{background:none;border:none;font-size:20px;cursor:pointer;color:#999;padding:4px 8px;border-radius:4px}
#lis-audit-box .ab-hd .ab-close:hover{background:#f0f0f0}
#lis-audit-box .ab-body{flex:1;overflow-y:auto;padding:16px 20px}
#lis-audit-box .ab-section{margin-bottom:16px}
#lis-audit-box .ab-section h5{margin:0 0 8px;font-size:13px;display:flex;align-items:center;gap:6px}
#lis-audit-box .ab-section .ab-count{padding:2px 8px;border-radius:10px;font-size:11px;font-weight:600;color:#fff}
#lis-audit-box .ab-section .ab-list{max-height:150px;overflow-y:auto;border:1px solid #eee;border-radius:6px;font-size:12px}
#lis-audit-box .ab-section .ab-list .ab-item{padding:6px 10px;border-bottom:1px solid #f5f5f5;display:flex;align-items:center;gap:8px}
#lis-audit-box .ab-section .ab-list .ab-item:last-child{border-bottom:none}
#lis-audit-box .ab-section .ab-list .ab-item:hover{background:#f8f9fa}
#lis-audit-box .ab-section .ab-list .ab-item .ab-name{font-weight:600;color:#2c3e50;min-width:60px}
#lis-audit-box .ab-section .ab-list .ab-item .ab-detail{color:#666;flex:1;font-size:11px}
#lis-audit-box .ab-section .ab-list .ab-item .ab-tag{padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
#lis-audit-box .ab-ft{padding:12px 20px;border-top:1px solid #eee;display:flex;align-items:center;gap:10px}
#lis-audit-box .ab-ft .ab-confirm{padding:8px 20px;border:none;border-radius:6px;font-size:13px;font-weight:600;cursor:pointer;transition:.2s}
#lis-audit-box .ab-ft .ab-confirm:disabled{opacity:.5;cursor:not-allowed}
#lis-audit-box .ab-ft .ab-confirm.ok{background:#27ae60;color:#fff}
#lis-audit-box .ab-ft .ab-confirm.ok:hover:not(:disabled){background:#1e8449}
#lis-audit-box .ab-ft .ab-cancel{padding:8px 20px;border:none;border-radius:6px;font-size:13px;cursor:pointer;background:#95a5a6;color:#fff}
#lis-audit-box .ab-ft .ab-export{padding:8px 16px;border:1px solid #ddd;border-radius:6px;font-size:12px;cursor:pointer;background:#fff;margin-right:auto}
#lis-audit-box .ab-ft .ab-export:hover{background:#f0f0f0}
#lis-audit-box .ab-check{display:flex;align-items:center;gap:6px;font-size:12px;color:#555;margin-top:8px}
#lis-audit-box .ab-check input{width:auto}

/* --- 进度条 --- */
#lis-audit-progress{position:fixed;top:50%;left:50%;transform:translate(-50%,-50%);z-index:100021;background:#fff;border-radius:10px;padding:24px 30px;box-shadow:0 10px 40px rgba(0,0,0,.3);display:none;text-align:center}
#lis-audit-progress.show{display:block}
#lis-audit-progress .prog-bar{width:300px;height:6px;background:#eee;border-radius:3px;margin:12px 0;overflow:hidden}
#lis-audit-progress .prog-fill{height:100%;background:#27ae60;border-radius:3px;transition:width .3s}
#lis-audit-progress .prog-text{font-size:13px;color:#555}

/* --- Toast 审核结果 --- */
.lis-audit-toast{position:fixed;top:60px;left:50%;transform:translateX(-50%);z-index:100022;padding:10px 20px;border-radius:8px;font-size:13px;color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:lis-si .3s ease;pointer-events:none}
.lis-audit-toast.success{background:#27ae60}
.lis-audit-toast.warning{background:#f39c12}
.lis-audit-toast.error{background:#e74c3c}
    `);

    // --- 状态 ---
    let _toolbarVisible = false;
    let _auditInProgress = false;
    let _batchAbort = false;
    let _auditAbortFlag = false;
    let _auditLockTs = 0;
    let _auditLockId = 0;
    const AUDIT_LOCK_TIMEOUT = 45000; // 45秒超时警告（不自动释放）
    function acquireAuditLock(tag) {
        if (_auditInProgress && (Date.now() - _auditLockTs > AUDIT_LOCK_TIMEOUT)) {
            dbg('审核锁持有超过', AUDIT_LOCK_TIMEOUT / 1000, '秒，可能存在卡死 (held by', tag, ')');
            _auditAbortFlag = true;
            showToast('审核操作耗时较长，可能需要等待', 'warning');
        }
        if (_auditInProgress) return false;
        _auditInProgress = true;
        _auditAbortFlag = false;
        _auditLockTs = Date.now();
        _auditLockId++;
        return _auditLockId;
    }
    function releaseAuditLock(expectedLockId) {
        if (expectedLockId && expectedLockId !== _auditLockId) {
            dbg('releaseAuditLock: 锁已不属于当前操作，跳过释放 (expected=', expectedLockId, 'current=', _auditLockId, ')');
            return;
        }
        _batchAbort = false;
        _auditAbortFlag = false;
        _auditInProgress = false;
        _auditLockTs = 0;
    }

    // --- 检测是否在报告处理页面 ---
    function isReportPageActive() {
        // 检查是否在主框架中
        try {
            if (window !== window.top) return false;
        } catch(e) { return false; }
        if (getReportIframeWin()) return true;
        return [...document.querySelectorAll('a')].some(a => (a.textContent || '').trim() === '报告处理');
    }

    // --- 获取原生 EasyUI datagrid 的行数据 ---
    function getNativeDatagridRows() {
        const w = uw();
        if (!w.$) return [];
        // 尝试多种选择器找到 datagrid
        const selectors = DATAGRID_SELECTORS_EXTENDED;
        for (const sel of selectors) {
            try {
                const el = w.$(sel);
                if (el.length) {
                    // 尝试直接获取 datagrid 数据
                    if (el.datagrid) {
                        const rows = el.datagrid('getRows');
                        if (rows && rows.length > 0) return rows;
                    }
                    // 也检查子元素
                    const dgs = el.find('.datagrid-f');
                    for (let i = 0; i < dgs.length; i++) {
                        try {
                            const rows = w.$(dgs[i]).datagrid('getRows');
                            if (rows && rows.length > 0) return rows;
                        } catch(e) {}
                    }
                }
            } catch(e) {}
        }
        // 回退：搜索所有 datagrid 元素
        try {
            const dgs = w.$('.datagrid-f, .datagrid-view');
            for (let i = 0; i < dgs.length; i++) {
                try {
                    const rows = w.$(dgs[i]).datagrid('getRows');
                    if (rows && rows.length > 0) return rows;
                } catch(e) {}
            }
        } catch(e) {}
        return [];
    }

    // --- 获取当前选中的行 ---
    function getNativeSelectedRow() {
        const w = uw();
        if (!w.$) return null;
        const selectors = DATAGRID_SELECTORS;
        for (const sel of selectors) {
            const el = w.$(sel);
            if (el.length && el.datagrid) {
                try {
                    const selected = el.datagrid('getSelected');
                    if (selected) return selected;
                } catch(e) {}
            }
        }
        return null;
    }

    // --- 选中指定行 ---
    function selectNativeRow(index) {
        const w = uw();
        if (!w.$) return false;
        const selectors = DATAGRID_SELECTORS;
        for (const sel of selectors) {
            const el = w.$(sel);
            if (el.length && el.datagrid) {
                try {
                    el.datagrid('selectRow', index);
                    return true;
                } catch(e) {}
            }
        }
        return false;
    }

    // --- 触发行点击（加载详情）---
    function triggerNativeRowClick(index) {
        const w = uw();
        if (!w.$) return;
        const selectors = DATAGRID_SELECTORS;
        for (const sel of selectors) {
            const el = w.$(sel);
            if (el.length && el.datagrid) {
                try {
                    el.datagrid('selectRow', index);
                    // 触发行点击事件
                    const rows = el.datagrid('getRows');
                    if (rows && rows[index]) {
                        el.datagrid('onSelect', { index: index, row: rows[index] });
                    }
                    return true;
                } catch(e) {}
            }
        }
        return false;
    }

    // --- 获取报告处理 iframe 的 contentWindow（同步版）---
    function getReportIframeWin() {
        // 优先：当前窗口就有 ReportSave（脚本运行在 iframe 内）
        if (typeof ReportSave === 'function') return window;
        // 优先搜索 iframe_1172（报告处理页面）— 确保返回 iframe 窗口（含 me 对象）
        const iframe = document.getElementById('iframe_1172');
        if (iframe && iframe.contentWindow) {
            return iframe.contentWindow;
        }
        // 搜索所有 iframe，找包含审核按钮的
        const iframes = document.querySelectorAll('iframe');
        for (const ifr of iframes) {
            try {
                if (ifr.contentWindow) {
                    const doc = ifr.contentWindow.document;
                    if (doc.getElementById('btn_ReportAuth') || doc.getElementById('btn_ReportSave')) {
                        return ifr.contentWindow;
                    }
                }
            } catch(e) {}
        }
        // 回退：unsafeWindow 有 ReportSave（可能返回主页面窗口，缺少 me 对象）
        try { if (typeof uw().ReportSave === 'function') return uw(); } catch(e) {}
        return null;
    }

    // --- 确保报告处理页面已加载（异步版）---
    function ensureReportPageLoaded(options = {}) {
        const existing = getReportIframeWin();
        if (existing) return Promise.resolve(existing);
        if (_reportPageLoadPromise && !options.force) {
            return _reportPageLoadPromise.then(w => w || getReportIframeWin());
        }
        const fast = !!options.fast;
        const pollMs = fast ? 60 : 150;
        const maxWait = fast ? 12000 : 15000;
        const run = () => new Promise((resolve) => {
            dbg('报告处理页面未加载，自动打开...');
            const links = document.querySelectorAll('a');
            for (const a of links) {
                if (a.textContent.trim() === '报告处理') {
                    a.click();
                    break;
                }
            }
            let waited = 0;
            const tick = () => {
                const w = getReportIframeWin();
                if (w) {
                    dbg('报告处理页面加载完成');
                    if (options.keepWS) keepWorkbenchOnTop('报告处理页加载完成');
                    resolve(w);
                    return;
                }
                waited += pollMs;
                if (waited >= maxWait) {
                    dbg('报告处理页面加载超时');
                    resolve(null);
                    return;
                }
                setTimeout(tick, pollMs);
            };
            tick();
        });
        if (!options.force) {
            _reportPageLoadPromise = run().finally(() => { _reportPageLoadPromise = null; });
            return _reportPageLoadPromise;
        }
        return run();
    }

    // --- 确保 me.selectedGrid 有值（选中工作列表当前行）---
    function ensureSelectedGrid(iframeWin) {
        if (!iframeWin || !iframeWin.me) return false;
        // 已经有选中行
        if (iframeWin.me.selectedGrid) return true;
        // 尝试找到工作列表 datagrid 并选中第一行
        try {
            const jq = iframeWin.jQuery || iframeWin.$;
            if (!jq) return false;
            const wl = jq('#dgWorkList');
            if (wl.length && wl.datagrid) {
                const rows = wl.datagrid('getRows');
                if (rows && rows.length > 0) {
                    wl.datagrid('selectRow', 0);
                    iframeWin.me.selectedGrid = wl;
                    return true;
                }
            }
        } catch(e) { dbg('ensureSelectedGrid error:', e); }
        return false;
    }

    // --- 关闭 CA 认证窗口（如果打开）---
    function closeCAWindow(iframeWin) {
        try {
            const jq = iframeWin.jQuery || iframeWin.$;
            if (jq) {
                const caWin = jq('#win_CAUserLogin');
                if (caWin.length && caWin.is(':visible')) {
                    caWin.window('close');
                    dbg('已关闭 CA 认证窗口');
                }
            }
        } catch(e) {}
    }

    function getNativeWorkListSelectedDR(iframeWin) {
        try {
            const jq = iframeWin && (iframeWin.jQuery || iframeWin.$);
            if (!jq) return '';
            const wl = jq(NATIVE_WORKLIST_SEL);
            if (!wl.length || !wl.datagrid) return '';
            const selected = wl.datagrid('getSelected');
            return selected ? String(selected.ReportDR || '') : '';
        } catch(e) {
            return '';
        }
    }

    function isScriptOwnedNativeSelection() {
        return !!(_auditInProgress || _abnormalAuditInProgress || _detailAuditInProgress);
    }

    function onNativeUserRowSelect(reportDR) {
        _nativeUserSelectDR = String(reportDR || '');
        _nativeUserSelectAt = Date.now();
        if (!isScriptOwnedNativeSelection()) {
            clearTimeout(_abnormalPrewarmTimer);
            _abnormalPrewarmTimer = null;
        }
    }

    function canScriptSelectNativeRow(iframeWin, reportDR) {
        if (isScriptOwnedNativeSelection()) return true;
        const target = String(reportDR || '');
        if (!target) return false;
        const selDR = getNativeWorkListSelectedDR(iframeWin);
        if (selDR && selDR !== target) return false;
        if (_nativeUserSelectDR && _nativeUserSelectAt && Date.now() - _nativeUserSelectAt < 30000) {
            if (_nativeUserSelectDR !== target) return false;
        }
        return true;
    }

    function installNativeDetailGuard(iframeWin) {
        if (!iframeWin || iframeWin.__lisEnhancerGuard) return !!iframeWin.__lisEnhancerGuard;
        const jq = iframeWin.jQuery || iframeWin.$;
        if (!jq) return false;
        try {
            const wl = jq(NATIVE_WORKLIST_SEL);
            if (wl.length && wl.datagrid) {
                const opts = wl.datagrid('options') || {};
                if (!opts.__lisOnSelectWrapped) {
                    const origOnSelect = opts.onSelect;
                    opts.onSelect = function(rowIndex, rowData) {
                        if (rowData && rowData.ReportDR) onNativeUserRowSelect(rowData.ReportDR);
                        if (typeof origOnSelect === 'function') return origOnSelect.apply(this, arguments);
                    };
                    opts.__lisOnSelectWrapped = true;
                }
            }
            if (!jq.__lisDetailAjaxGuard) {
                jq.ajaxPrefilter(function(options) {
                    const d = options && options.data;
                    if (!d || d.QueryName !== 'GetReportInfoAll') return;
                    const captured = String(d.P0 || '');
                    const origSuccess = options.success;
                    options.success = function(RetData, textStatus) {
                        const me = iframeWin.me;
                        const cur = String((me && me.curReportDR) || '');
                        const sel = getNativeWorkListSelectedDR(iframeWin);
                        if (captured && cur !== captured && sel !== captured) {
                            dbg('丢弃过期标本详情响应:', captured, 'cur=', cur, 'sel=', sel);
                            try { if (typeof iframeWin.ajaxLoadEnd === 'function') iframeWin.ajaxLoadEnd(); } catch(e) {}
                            return;
                        }
                        if (origSuccess) return origSuccess.apply(this, arguments);
                    };
                });
                jq.__lisDetailAjaxGuard = true;
            }
            iframeWin.__lisEnhancerGuard = true;
            dbg('原生详情防竞态已安装');
            return true;
        } catch(e) {
            dbg('安装原生详情防护失败:', e.message);
            return false;
        }
    }

    function scheduleNativeDetailGuardInstall() {
        if (_nativeGuardTimer) return;
        let attempts = 0;
        const tick = () => {
            const w = getReportIframeWin();
            if (w && installNativeDetailGuard(w)) {
                _nativeGuardTimer = null;
                return;
            }
            attempts++;
            if (attempts < 120) _nativeGuardTimer = setTimeout(tick, 500);
            else _nativeGuardTimer = null;
        };
        tick();
    }

    function findNativeRowByReportDR(iframeWin, reportDR) {
        if (!iframeWin || !reportDR) return null;
        const jq = iframeWin.jQuery || iframeWin.$;
        const me = iframeWin.me;
        const target = String(reportDR);

        try {
            if (jq) {
                const wl = jq(NATIVE_WORKLIST_SEL);
                if (wl.length && wl.datagrid) {
                    const rows = wl.datagrid('getRows') || [];
                    for (let i = 0; i < rows.length; i++) {
                        if (String(rows[i].ReportDR || '') === target) {
                            return { row: rows[i], index: i, grid: wl };
                        }
                    }
                }
            }
        } catch(e) {}

        try {
            if (me && me.selectedGrid && me.selectedGrid.datagrid) {
                const selected = me.selectedGrid.datagrid('getSelected');
                if (selected && String(selected.ReportDR || '') === target) {
                    return {
                        row: selected,
                        index: me.selectedGrid.datagrid('getRowIndex', selected),
                        grid: me.selectedGrid
                    };
                }
                const rows = me.selectedGrid.datagrid('getRows') || [];
                for (let i = 0; i < rows.length; i++) {
                    if (String(rows[i].ReportDR || '') === target) {
                        return { row: rows[i], index: i, grid: me.selectedGrid };
                    }
                }
            }
        } catch(e) {}

        if (!jq) return null;
        const selectors = DATAGRID_SELECTORS;
        for (const sel of selectors) {
            try {
                const el = jq(sel);
                if (!el.length || !el.datagrid) continue;
                const rows = el.datagrid('getRows') || [];
                for (let i = 0; i < rows.length; i++) {
                    if (String(rows[i].ReportDR || '') === target) {
                        return { row: rows[i], index: i, grid: el };
                    }
                }
            } catch(e) {}
        }
        return null;
    }

    function classifyNativeMessage(text) {
        const t = (text || '').trim();
        if (!t) return '';
        if (t.indexOf('必填项目') !== -1 || t.indexOf('未存数据') !== -1 ||
            t.indexOf('结果为空') !== -1 || t.indexOf('结果不完整') !== -1 ||
            t.indexOf('无结果') !== -1 || t.indexOf('没有结果') !== -1 ||
            t.indexOf('未录入') !== -1 || t.indexOf('请录入') !== -1) {
            return 'incomplete';
        }
        if (t.indexOf('成功') !== -1 && t.indexOf('失败') === -1 && t.indexOf('错误') === -1) return 'success';
        if (t.indexOf('密码错误') !== -1 || t.indexOf('认证失败') !== -1 ||
            t.indexOf('账号锁定') !== -1 || t.indexOf('失败') !== -1 ||
            t.indexOf('错误') !== -1 || t.indexOf('不允许') !== -1 ||
            t.indexOf('未通过') !== -1) {
            return 'failure';
        }
        return '';
    }

    function readNativeMessageResult(doc, jq) {
        try {
            const allWins = doc.querySelectorAll('.messager-window:not([style*="display: none"]), .window:not([style*="display: none"])');
            for (const w of allWins) {
                if (w.offsetParent === null) continue;
                const body = w.querySelector('.messager-body, .panel-body');
                if (!body) continue;
                const text = (body.textContent || '').trim();
                const kind = classifyNativeMessage(text);
                if (!kind) continue;

                const btns = w.querySelectorAll('a.l-btn, button');
                for (const b of btns) {
                    const bText = (b.textContent || b.value || '').trim();
                    if (kind === 'incomplete' && (bText === '取消' || bText === 'No' || bText === '否' || bText === '关闭')) {
                        try { jq(b).click(); } catch(e) {}
                        break;
                    }
                    if (kind !== 'incomplete' && (bText === '确定' || bText === 'OK' || bText === '关闭' || bText === '是')) {
                        try { jq(b).click(); } catch(e) {}
                        break;
                    }
                }
                return kind;
            }
        } catch(e) {}
        return '';
    }

    function isNativeButtonDisabled(btn, jq) {
        if (!btn) return true;
        try {
            if (btn.disabled) return true;
            if (btn.getAttribute('disabled') !== null) return true;
            const cls = String(btn.className || '');
            if (/\bl-btn-disabled\b|\bdisabled\b/.test(cls)) return true;
            const parent = btn.closest && btn.closest('.l-btn');
            if (parent && /\bl-btn-disabled\b|\bdisabled\b/.test(String(parent.className || ''))) return true;
            if (jq && jq(btn).hasClass && (jq(btn).hasClass('l-btn-disabled') || jq(btn).hasClass('disabled'))) return true;
        } catch(e) {}
        return false;
    }

    async function waitNativeActionResult(iframeWin, targetReportDR, expectedStatuses, timeoutMs, missingAsSuccess = false, options = {}) {
        const doc = iframeWin ? iframeWin.document : document;
        const jq = iframeWin ? (iframeWin.jQuery || iframeWin.$) : window.jQuery;
        const me = iframeWin ? iframeWin.me : null;
        const end = Date.now() + timeoutMs;
        const turbo = !!options.turbo;
        const fastEnd = Date.now() + (turbo ? 2500 : 500);
        let sawTargetRow = !!options.targetWasPresent;
        let missingSince = 0;
        let failureSince = 0;
        const ignoreMessages = !!options.ignoreMessages;
        const missingStableMs = Number(options.missingStableMs || 700);
        const failureGraceMs = Number(options.failureGraceMs || 2500);
        if (targetReportDR && !sawTargetRow) {
            try { sawTargetRow = !!findNativeRowByReportDR(iframeWin, targetReportDR); } catch(e) {}
        }

        while (Date.now() < end) {
            await sleep(Date.now() < fastEnd ? (turbo ? 35 : 50) : (turbo ? 80 : 150));

            if (targetReportDR && expectedStatuses && expectedStatuses.length) {
                const found = findNativeRowByReportDR(iframeWin, targetReportDR);
                if (found) {
                    sawTargetRow = true;
                    missingSince = 0;
                    if (isExpectedNativeStatus(found.row, expectedStatuses)) {
                        dbg('原生操作成功（状态=' + getNativeStatusValues(found.row).join('/') + '）');
                        return true;
                    }
                } else if (missingAsSuccess && sawTargetRow) {
                    if (!missingSince) missingSince = Date.now();
                    if (Date.now() - missingSince >= missingStableMs) {
                        dbg('原生操作成功（目标行已稳定移出列表）');
                        return true;
                    }
                }
            }

            if (me && me.IsSaveSuccess === true) {
                me.IsSaveSuccess = false;
                if (!expectedStatuses || expectedStatuses.length === 0) return true;
                const found = targetReportDR ? findNativeRowByReportDR(iframeWin, targetReportDR) : null;
                if (found && isExpectedNativeStatus(found.row, expectedStatuses)) {
                    dbg('原生操作成功（IsSaveSuccess）');
                    return true;
                }
                if (!found && targetReportDR && missingAsSuccess && sawTargetRow) {
                    dbg('原生操作成功（IsSaveSuccess，目标行已移出）');
                    return true;
                }
                if (targetReportDR && String(me.curReportDR || '') === String(targetReportDR)) {
                    const sel = me.selectedGrid ? me.selectedGrid.datagrid('getSelected') : null;
                    if (sel && String(sel.ReportDR || '') === String(targetReportDR)) {
                        if (isExpectedNativeStatus(sel, expectedStatuses)) {
                            dbg('原生操作成功（IsSaveSuccess + 当前选中行状态）');
                            return true;
                        }
                        if (!found && missingAsSuccess && sawTargetRow) {
                            dbg('原生操作成功（IsSaveSuccess + curReportDR 匹配，行已移出）');
                            return true;
                        }
                    }
                }
            }

            const msg = ignoreMessages ? '' : readNativeMessageResult(doc, jq);
            if (msg === 'success') {
                if (!expectedStatuses || expectedStatuses.length === 0 || !targetReportDR) return true;
                const found = findNativeRowByReportDR(iframeWin, targetReportDR);
                if (found && isExpectedNativeStatus(found.row, expectedStatuses)) return true;
                if (!found && missingAsSuccess && sawTargetRow) return true;
                continue;
            }
            if (msg === 'incomplete') return 'incomplete';
            if (msg === 'failure') {
                if (!targetReportDR || !expectedStatuses || expectedStatuses.length === 0) return false;
                if (!failureSince) {
                    failureSince = Date.now();
                    dbg('检测到原生失败提示，继续短暂确认状态回写...');
                }
                if (Date.now() - failureSince >= failureGraceMs) return false;
                continue;
            }
            if (failureSince && Date.now() - failureSince >= failureGraceMs) return false;
        }
        return false;
    }

    function getNativeStatusValues(row) {
        if (!row) return [];
        return [
            row.Status, row.ReportStatus, row.StatusDesc, row.ReportStatusDesc,
            row.AuthStatus, row.AuthFlag, row.State, row.StateDesc
        ].filter(v => v !== undefined && v !== null).map(v => String(v).trim()).filter(Boolean);
    }

    function isExpectedNativeStatus(row, expectedStatuses) {
        const expected = (expectedStatuses || []).map(String);
        if (!expected.length) return true;
        const values = getNativeStatusValues(row);
        if (values.some(v => expected.includes(v))) return true;
        if (expected.includes('3')) {
            return values.some(v => (v === '审核' || v === '已审核' || v.indexOf('审核') !== -1) &&
                v.indexOf('未审核') === -1 && v.indexOf('待审核') === -1 &&
                v.indexOf('取审') === -1 && v.indexOf('取消') === -1);
        }
        return false;
    }

    function isReportDetailLoaded(iframeWin, reportDR) {
        if (!iframeWin || !reportDR) return false;
        try {
            const me = iframeWin.me;
            const target = String(reportDR);
            if (!me || String(me.curReportDR || '') !== target) return false;
            const jq = iframeWin.jQuery || iframeWin.$;
            if (!jq) return false;
            const leftRows = jq('#dgLeftReportItem').datagrid('getRows') || [];
            const rightRows = jq('#dgRightReportItem').length ? (jq('#dgRightReportItem').datagrid('getRows') || []) : [];
            if (!(leftRows.length || rightRows.length)) return false;
            const selected = me.selectedGrid ? me.selectedGrid.datagrid('getSelected') : null;
            return !!(selected && String(selected.ReportDR || '') === target);
        } catch(e) {
            return false;
        }
    }

    async function waitReportDetailReady(iframeWin, reportDR, timeoutMs = 5000, options = {}) {
        if (!iframeWin || !reportDR) return false;
        const fastBatch = !!options.fastBatch;
        const pollMs = fastBatch ? 50 : 150;
        const end = Date.now() + timeoutMs;
        if (isReportDetailLoaded(iframeWin, reportDR)) return true;
        while (Date.now() < end) {
            await sleep(pollMs);
            if (isReportDetailLoaded(iframeWin, reportDR)) return true;
        }
        return false;
    }


    async function handleCALogin(iframeWin, options = {}) {
        const fast = !!options.fast;
        const doc = iframeWin.document;
        const jq = iframeWin.jQuery || iframeWin.$;
        const caWin = jq('#win_CAUserLogin');
        if (!caWin.length || !caWin.is(':visible')) return true;

        const caPwd = await loadCAPwdAsync();
        if (!caPwd) { showToast('请先设置CA密码', 'warning'); return false; }

        const caUser = uname() || loadLoginCreds()?.user;
        if (!caUser) { showToast('无法获取用户名', 'error'); return false; }

        dbg('CA: 检测到 CA 窗口');
        updateBatchProgress('CA 认证中...', null);
        const ft = document.getElementById('lis-ws-ft-stat');
        if (ft) ft.textContent = 'CA 认证中...';
        const totalDeadline = Date.now() + (fast ? 35000 : 90000);

        // 最多重试 3 次
        for (let attempt = 1; attempt <= 3; attempt++) {
            if (Date.now() > totalDeadline) {
                dbg('CA: 总超时(90s)已到');
                showToast('CA 认证超时，请手动完成', 'error');
                return false;
            }
            dbg('CA 尝试 ' + attempt + '/3');

            let caIframe = null;
            const iframeWaitLoops = fast ? 20 : 50;
            for (let i = 0; i < iframeWaitLoops; i++) {
                caIframe = doc.querySelector('#win_CAUserLogin iframe');
                if (caIframe && caIframe.contentDocument && caIframe.contentDocument.body && caIframe.contentDocument.body.childElementCount > 0) break;
                await sleep(fast ? 150 : 300);
            }

            let caDoc = null;
            if (caIframe && caIframe.contentDocument && caIframe.contentDocument.body && caIframe.contentDocument.body.childElementCount > 0) {
                caDoc = caIframe.contentDocument;
            } else {
                caDoc = doc;
            }

            try {
                const toggleBtn = caDoc.getElementById('sp_showcapping');
                if (toggleBtn) { toggleBtn.click(); await sleep(500); }

                let userInput = caDoc.getElementById('txt_UserCode') || caDoc.querySelector('input[id*="UserCode"]');
                let pwdInput = caDoc.getElementById('txt_Password') || caDoc.querySelector('input[type="password"]');

                if (!pwdInput) {
                    const allInputs = caDoc.querySelectorAll('input');
                    for (const inp of allInputs) {
                        if (inp.type === 'password') pwdInput = inp;
                        if (inp.type === 'text' && !userInput) userInput = inp;
                    }
                }

                if (!pwdInput) {
                    dbg('CA: 密码框未找到');
                    if (attempt < 3) { await sleep(1000); continue; }
                    return false;
                }

                if (userInput) {
                    setNativeInputValue(userInput, caUser);
                }
                if (pwdInput) {
                    setNativeInputValue(pwdInput, caPwd);
                }
                await sleep(300);

                let loginBtn = caDoc.getElementById('bt_login') || caDoc.querySelector('a[id*="login"], button[id*="login"]');
                if (!loginBtn) {
                    const btns = caDoc.querySelectorAll('a.l-btn, button');
                    for (const b of btns) {
                        const text = (b.textContent || b.value || '').trim();
                        if (text.indexOf('登录') !== -1) { loginBtn = b; break; }
                    }
                }

                if (loginBtn) {
                    loginBtn.click();
                    dbg('CA: 登录按钮已点击');
                } else {
                    dbg('CA: 登录按钮未找到');
                    if (attempt < 3) { await sleep(1500); continue; }
                    return false;
                }

                // 等待结果
                for (let i = 0; i < 40; i++) {
                    await sleep(i < 20 ? 200 : 300);
                    if (!caWin.is(':visible')) {
                        dbg('CA: 登录成功');
                        return true;
                    }
                    // 检查错误（每次轮询都检查）
                    {
                        const errText = (caDoc.body?.textContent || '') + ' ' + (doc.querySelector('#win_CAUserLogin .panel-body')?.textContent || '');
                        if (errText.indexOf('账号锁定') !== -1 || errText.indexOf('账户锁定') !== -1) {
                            showToast('CA 账号已锁定', 'error');
                            return false;
                        }
                        if (errText.indexOf('密码错误') !== -1 || errText.indexOf('认证失败') !== -1) {
                            dbg('CA: 密码错误');
                            break;
                        }
                    }
                }

                if (attempt < 3) {
                    showToast('CA 重试 (' + attempt + '/3)...', 'warning');
                    if (pwdInput) setNativeInputValue(pwdInput, '');
                    await sleep(1500);
                }
            } catch(e) {
                dbg('CA 异常:', e);
                if (attempt < 3) { await sleep(1000); continue; }
            }
        }

        showToast('CA 认证失败，请手动完成', 'error');
        return false;
    }

    // --- 点击原生按钮并处理 CA/审核登录 ---
    // 返回值：true=成功, false=失败, 'incomplete'=结果不完整（跳过）
    async function clickNativeAuditButton(iframeWin, btnId, options = {}) {
        // 按钮在 iframe 的工具栏里
        let btn = null;
        if (iframeWin) {
            btn = iframeWin.document.getElementById(btnId);
        }
        if (!btn) {
            btn = document.getElementById(btnId);
        }
        if (!btn) {
            const searchDocs = iframeWin ? [iframeWin.document, document] : [document];
            for (const doc of searchDocs) {
                const allBtns = doc.querySelectorAll('a, button, input[type=button]');
                for (const b of allBtns) {
                    const text = (b.textContent || b.value || '').trim();
                    if (text === '审核' || text.includes('审核[') || (b.id && b.id.includes('Auth'))) {
                        btn = b;
                        break;
                    }
                }
                if (btn) break;
            }
        }
        const jq = iframeWin ? (iframeWin.jQuery || iframeWin.$) : window.jQuery;
        const doc = iframeWin ? iframeWin.document : document;
        const me = iframeWin ? iframeWin.me : null;

        if (!btn) { dbg('按钮 ' + btnId + ' 不存在'); return false; }
        if (!jq) { dbg('原生 jQuery 不存在'); return false; }

        const batchMode = !!options.batchMode;
        const isAudit = btnId === 'btn_ReportAuth' || options.action === 'audit';
        const expectedStatuses = options.expectedStatuses || (isAudit ? ['3'] : []);
        const timeoutMs = options.timeoutMs || (isAudit ? (batchMode ? 10000 : 15000) : 8000);
        const missingAsSuccess = options.missingAsSuccess !== undefined ? options.missingAsSuccess : false;
        const maxPoll = batchMode ? 8 : 20;
        const pollSleep = batchMode ? 60 : 200;
        const missingStableMs = batchMode ? 450 : 900;

        let targetReportDR = options.targetReportDR ? String(options.targetReportDR) : '';
        try {
            const sel = me && me.selectedGrid ? me.selectedGrid.datagrid('getSelected') : null;
            if (!targetReportDR && sel) targetReportDR = String(sel.ReportDR || '');
        } catch(e) {}
        const targetWasPresent = !!targetReportDR && !!findNativeRowByReportDR(iframeWin, targetReportDR);
        const waitOpts = { targetWasPresent, missingStableMs, failureGraceMs: batchMode ? 1200 : 3000, ignoreMessages: true, turbo: batchMode };

        if (isAudit && targetReportDR && !isReportDetailLoaded(iframeWin, targetReportDR)) {
            dbg('审核中止: 目标标本详情未就绪, targetReportDR=' + targetReportDR);
            return false;
        }

        if (isAudit && isNativeButtonDisabled(btn, jq)) {
            dbg('审核按钮不可用，跳过 targetReportDR=' + targetReportDR);
            return false;
        }

        // 优先直接调用原生 ReportSave（与按钮点击等价，避免 EasyUI 事件未触发）
        let auditTriggered = false;
        try {
            if (isAudit && typeof iframeWin.ReportSave === 'function') {
                iframeWin.ReportSave('A', '');
                auditTriggered = true;
                dbg('已调用 ReportSave(A), targetReportDR=' + targetReportDR);
            }
        } catch(e) {
            dbg('ReportSave 调用失败，回退按钮点击:', e.message);
        }
        if (!auditTriggered) {
            jq(btn).click();
            dbg('已点击审核按钮, targetReportDR=' + targetReportDR);
        }

        let caDetected = false;
        let authLoginDetected = false;
        const instant = await waitNativeActionResult(iframeWin, targetReportDR, expectedStatuses, batchMode ? 120 : 80, missingAsSuccess, waitOpts);
        if (instant !== false) return instant;

        for (let poll = 0; poll < maxPoll; poll++) {
            const early = await waitNativeActionResult(iframeWin, targetReportDR, expectedStatuses, batchMode ? 100 : 50, missingAsSuccess, waitOpts);
            if (early !== false) return early;

            await sleep(pollSleep);

            try {
                const caWin = jq('#win_CAUserLogin');
                if (caWin.length && caWin.is(':visible')) {
                    caDetected = true;
                    dbg('检测到 CA 认证窗口');
                    break;
                }
            } catch(e) {}

            try {
                const authWin = doc.querySelector('#win_AuthLogin, #win_EntryLogin');
                if (authWin && authWin.style.display !== 'none') {
                    const vis = jq(authWin);
                    if (vis.length && vis.is(':visible')) {
                        authLoginDetected = true;
                        dbg('检测到审核登录窗口，继续等待原生审核结果');
                    }
                }
            } catch(e) {}
        }

        // 如果检测到 CA 窗口，自动完成 CA 登录
        if (caDetected) {
            dbg('开始自动 CA 认证...');
            const caOK = await handleCALogin(iframeWin, { fast: batchMode });
            if (!caOK) { clearCAAuth(); return false; }
            saveCAAuth();
            if (options.keepWS) keepWorkbenchOnTop('CA认证完成');
            dbg('CA 认证成功，等待审核回调...');
            // CA 认证后，原生回调自动调用 ReportSave → 审核完成
            const caResult = await waitNativeActionResult(iframeWin, targetReportDR, expectedStatuses, timeoutMs, missingAsSuccess, { ...waitOpts, missingStableMs, failureGraceMs: batchMode ? 2000 : 3000 });
            if (caResult) return caResult;
            dbg('CA 审核等待超时，未确认成功');
            return false;
        }

        const result = await waitNativeActionResult(iframeWin, targetReportDR, expectedStatuses, timeoutMs, missingAsSuccess, { ...waitOpts, missingStableMs, failureGraceMs: batchMode ? 2000 : 3000 });
        if (result) return result;

        if (authLoginDetected) {
            showToast('出现审核登录窗口，请关闭后用原生审核按钮重新触发 CA', 'warning');
        }
        dbg('原生按钮点击完成，但未确认成功');
        return false;
    }

    // 实时检查CA认证状态
    async function checkRealCAStatus() {
        try {
            const iframeWin = getReportIframeWin();
            if (!iframeWin) return { authenticated: false, reason: '页面未加载' };
            
            const jq = iframeWin.jQuery || iframeWin.$;
            if (!jq) return { authenticated: false, reason: '页面未就绪' };
            
            // 检查CA窗口是否存在且可见
            const caWin = jq('#win_CAUserLogin');
            if (caWin.length && caWin.is(':visible')) {
                return { authenticated: false, reason: 'CA窗口已打开' };
            }
            
            // 检查审核用户是否已登录
            const authStatus = getAuditStatusText(iframeWin);
            if (authStatus && authStatus.indexOf('未登录') !== -1) {
                return { authenticated: false, reason: '审核用户未登录' };
            }
            
            return { authenticated: true, reason: '已认证' };
        } catch(e) {
            return { authenticated: false, reason: '检查失败: ' + e.message };
        }
    }


    // --- 确保CA已认证（审核前调用，自动触发CA认证流程）---
    async function ensureCAAuthenticated() {
        // 快速检查：如果 CA UKey 已绑定，跳过
        try {
            const iframeWin0 = getReportIframeWin();
            if (iframeWin0 && iframeWin0.CAMsg && iframeWin0.CAMsg.UkeyNoArray) {
                const _me0 = iframeWin0.me;
                const _userDR = _me0?.AuthUserDR || uid();
                if (_userDR && iframeWin0.CAMsg.UkeyNoArray[_userDR]) {
                    dbg('CA: UKey 已绑定，跳过认证');
                    return true;
                }
            }
        } catch(e) {}

        // 本地缓存检查（1小时内有效）
        const cached = loadCAAuth();
        if (cached && cached.wg === wgDR() && (Date.now() - cached.time < 3600000)) {
            dbg('CA: 使用本地缓存');
            return true;
        }

        dbg('CA: 需要认证，直接调用 CAMsg.Login');

        try {
            let iframeWin = getReportIframeWin();
            if (!iframeWin) iframeWin = await ensureReportPageLoaded();
            if (!iframeWin) { showToast('未找到报告页面', 'error'); return false; }

            // 等待 iframe 就绪
            for (let w = 0; w < 15; w++) {
                if (iframeWin.CAMsg && iframeWin.me) break;
                await sleep(400);
                iframeWin = getReportIframeWin();
            }
            if (!iframeWin || !iframeWin.CAMsg) { showToast('报告页面未就绪', 'error'); return false; }

            const jq = iframeWin.jQuery || iframeWin.$;
            const me = iframeWin.me;
            const CAMsg = iframeWin.CAMsg;

            // 直接调用 CAMsg.Login 触发 CA 认证（不点审核按钮，避免触发审核流程）
            const caUserDR = me?.AuthUserDR || uid();
            dbg('CA: 调用 CAMsg.Login, userDR=' + caUserDR);

            // 先检查 CA 窗口是否已经打开
            let caWin = jq('#win_CAUserLogin');
            if (caWin.length && caWin.is(':visible')) {
                dbg('CA: CA窗口已打开，直接处理登录');
                const caOK = await handleCALogin(iframeWin);
                if (caOK) { saveCAAuth(); showToast('✅ CA 认证成功', 'success'); return true; }
                clearCAAuth(); return false;
            }

            // 调用 CAMsg.Login 触发 CA 窗口
            CAMsg.Login(caUserDR, function() {
                dbg('CA: CAMsg.Login 回调触发');
            }, []);

            // 等待 CA 窗口出现（最多 15 秒）
            let waited = 0;
            caWin = jq('#win_CAUserLogin');
            while ((!caWin.length || !caWin.is(':visible')) && waited < 15000) {
                await sleep(500); waited += 500;
                caWin = jq('#win_CAUserLogin');
            }

            if (!caWin.length || !caWin.is(':visible')) {
                // CA窗口没出现 = 不需要CA认证 或 CA客户端未运行
                dbg('CA: 未弹出CA窗口（等了' + waited + 'ms），可能不需要CA认证或CA客户端未运行');
                saveCAAuth();
                return true;
            }

            // CA窗口已弹出，自动完成 capping 登录
            dbg('CA: CA窗口已弹出，自动登录');
            const caOK = await handleCALogin(iframeWin);

            if (caOK) {
                saveCAAuth();
                showToast('✅ CA 认证成功', 'success');
                return true;
            } else {
                clearCAAuth();
                showToast('CA 认证失败，请手动完成', 'error');
                return false;
            }

        } catch(e) {
            dbg('CA 认证异常:', e);
            showToast('CA 认证异常: ' + e.message, 'error');
            return false;
        }
    }


    function getAuditStatusText(iframeWin) {
        try {
            const doc = iframeWin ? iframeWin.document : document;
            // 尝试多种方式获取状态栏文本
            const statusBar = doc.querySelector('#sp_EntryLoginInfo, .statusbar, .panel-body .messager-info');
            if (statusBar) return statusBar.textContent || '';
            // 查找"审核用户未登录"文本
            const allText = doc.body ? doc.body.textContent : '';
            const idx = allText.indexOf('审核用户未登录');
            return idx !== -1 ? '审核用户未登录' : '';
        } catch(e) { return ''; }
    }

    async function handleAuditLogin(iframeWin, jq) {
        try {
            // 点击"审核登录"按钮
            const authLoginBtn = iframeWin.document.getElementById('btn_AuthLogin')
                || document.getElementById('btn_AuthLogin');
            if (!authLoginBtn) { dbg('审核登录按钮不存在'); return false; }
            jq(authLoginBtn).click();
            dbg('已点击审核登录按钮');
            await sleep(800);

            // showwin 在 dialog 里创建 iframe(#FRMdetail)，登录表单在这个 iframe 里
            const doc = iframeWin.document;
            const loginWin = doc.querySelector('#win_AuthLogin') || doc.querySelector('#win_BatchAuthUserLogin');
            if (!loginWin) { dbg('审核登录窗口未找到'); return false; }

            // 在 dialog 内部找 iframe（showwin 用的 #FRMdetail）
            const dialogIframe = loginWin.querySelector('iframe');
            let pwdInput = null;
            let okBtn = null;
            let loginDoc = doc; // 默认在父文档找

            if (dialogIframe) {
                try {
                    const iDoc = dialogIframe.contentDocument || dialogIframe.contentWindow.document;
                    if (iDoc && iDoc.body && iDoc.body.childElementCount > 0) {
                        loginDoc = iDoc;
                        dbg('审核登录表单在 dialog iframe 内');
                    }
                } catch(e) { dbg('访问 dialog iframe 失败:', e.message); }
            }

            // 在正确的文档里找密码框
            pwdInput = loginDoc.querySelector('#text_AuthUserLoginPasssword')
                || loginDoc.querySelector('input[type="password"]');
            if (!pwdInput) {
                // 再试一层 iframe
                const innerIframe = loginDoc.querySelector('iframe');
                if (innerIframe) {
                    try {
                        const iDoc2 = innerIframe.contentDocument || innerIframe.contentWindow.document;
                        if (iDoc2) {
                            pwdInput = iDoc2.querySelector('#text_AuthUserLoginPasssword')
                                || iDoc2.querySelector('input[type="password"]');
                            if (pwdInput) { loginDoc = iDoc2; dbg('密码框在更深层 iframe'); }
                        }
                    } catch(e) {}
                }
            }

            if (!pwdInput) {
                dbg('密码框未找到，尝试所有 iframe...');
                // 遍历所有 iframe 查找
                const allIframes = loginWin.querySelectorAll('iframe');
                for (const ifr of allIframes) {
                    try {
                        const iDoc = ifr.contentDocument || ifr.contentWindow.document;
                        if (!iDoc) continue;
                        pwdInput = iDoc.querySelector('#text_AuthUserLoginPasssword')
                            || iDoc.querySelector('input[type="password"]');
                        if (pwdInput) { loginDoc = iDoc; dbg('密码框在 iframe 中找到'); break; }
                        // 再深一层
                        const deep = iDoc.querySelectorAll('iframe');
                        for (const d of deep) {
                            try {
                                const dDoc = d.contentDocument || d.contentWindow.document;
                                if (!dDoc) continue;
                                pwdInput = dDoc.querySelector('#text_AuthUserLoginPasssword')
                                    || dDoc.querySelector('input[type="password"]');
                                if (pwdInput) { loginDoc = dDoc; dbg('密码框在深层 iframe'); break; }
                            } catch(e) {}
                        }
                        if (pwdInput) break;
                    } catch(e) {}
                }
            }

            if (!pwdInput) {
                dbg('❌ 审核登录密码框未找到');
                return false;
            }

            // 同时查找账户输入框（审核登录需要账户+密码）
            let acctInput = loginDoc.querySelector('#text_AuthUserCode')
                || loginDoc.querySelector('input[id*="UserCode"]')
                || loginDoc.querySelector('input[id*="Account"]')
                || loginDoc.querySelector('input[placeholder*="账户"]');
            // 如果没找到，在所有 input 里找第一个 text 类型的
            if (!acctInput) {
                const allInputs = loginDoc.querySelectorAll('input[type="text"], input:not([type])');
                for (const inp of allInputs) {
                    if (inp.id !== pwdInput.id && !inp.readOnly && !inp.disabled) {
                        acctInput = inp;
                        break;
                    }
                }
            }

            const pwd = await loadPwdAsync();
            if (!pwd) { dbg('❌ 未保存审核密码'); return false; }

            // 填写账户（用当前登录用户名）
            if (acctInput) {
                const userName = uname();
                if (userName) {
                    setNativeInputValue(acctInput, userName);
                    dbg('已填写审核账户: ' + userName);
                }
            } else {
                dbg('⚠️ 未找到账户输入框，仅填写密码');
            }

            // 填写密码
            setNativeInputValue(pwdInput, pwd);
            dbg('已自动填写审核密码');
            await sleep(300);

            // 找确定按钮（在 loginDoc 里）
            const btns = loginDoc.querySelectorAll('a.l-btn, button');
            for (const b of btns) {
                const text = (b.textContent || '').trim();
                if (text.includes('确定') || text.includes('登录') || text === 'OK') {
                    okBtn = b; break;
                }
            }
            // 也检查 dialog 按钮区域
            if (!okBtn) {
                const allBtns = loginWin.querySelectorAll('a.l-btn, button');
                for (const b of allBtns) {
                    const text = (b.textContent || '').trim();
                    if (text.includes('确定') || text.includes('登录')) { okBtn = b; break; }
                }
            }

            if (!okBtn) {
                dbg('❌ 审核登录确定按钮未找到');
                return false;
            }

            jq(okBtn).click();
            dbg('已点击审核登录确定');

            // 等待登录窗口关闭（最多 5 秒）
            for (let w = 0; w < 25; w++) {
                await sleep(200);
                if (!loginWin || loginWin.style.display === 'none' || !loginWin.offsetParent) {
                    dbg('审核登录窗口已关闭');
                    // 设置原生 me 状态
                    try {
                        const _me = iframeWin.me;
                        if (_me) {
                            _me.IsAuthLogin = 1;
                            const auInfo = sessionStorage.getItem('AuInfo');
                            if (auInfo) {
                                _me.AuthUserDR = auInfo.split('^')[0];
                            } else {
                                _me.AuthUserDR = uid();
                            }
                            dbg('已设置 me.IsAuthLogin=1, AuthUserDR=' + (_me.AuthUserDR || ''));
                        }
                    } catch(e) { dbg('设置审核状态异常:', e.message); }
                    return true;
                }
                // 检查是否有错误提示
                try {
                    const errWin = loginDoc.querySelector('.messager-window, .window');
                    if (errWin && errWin.style.display !== 'none') {
                        const errBody = errWin.querySelector('.messager-body, .panel-body');
                        if (errBody) {
                            const errText = (errBody.textContent || '').trim();
                            if (errText && (errText.includes('密码') || errText.includes('错误') || errText.includes('password') || errText.includes('fail'))) {
                                dbg('审核登录错误: ' + errText.substring(0, 50));
                                return false;
                            }
                        }
                    }
                } catch(e) {}
            }
            dbg('审核登录窗口超时未关闭');
            return false;
        } catch(e) {
            dbg('审核登录异常:', e);
            return false;
        }
    }

    function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

    // --- 通过原生按钮审核（带 CA 自动登录）---
    async function simulateNativeAudit() {
        let iframeWin = getReportIframeWin();
        if (!iframeWin) {
            showToast('正在加载报告处理页面...', 'warning');
            iframeWin = await ensureReportPageLoaded();
        }
        if (!iframeWin) {
            showToast('未找到报告处理页面，请先打开"报告处理"', 'error');
            return false;
        }
        // 确保工作列表有数据
        if (!ensureSelectedGrid(iframeWin)) {
            dbg('工作列表无选中行，尝试刷新...');
            try { iframeWin.RefreshWorkList(); } catch(e) {}
            await sleep(1500);
            if (!ensureSelectedGrid(iframeWin)) {
                showToast('工作列表无数据，请先加载标本', 'warning');
                return false;
            }
        }
        // 点击原生审核按钮（自动处理审核登录和 CA）
        return await clickNativeAuditButton(iframeWin, 'btn_ReportAuth', { action: 'audit', expectedStatuses: ['3'] });
    }

    // --- 初审 ---
    async function simulateNativeInitialReview() {
        let iframeWin = getReportIframeWin();
        if (!iframeWin) iframeWin = await ensureReportPageLoaded();
        if (!iframeWin) return false;
        if (!ensureSelectedGrid(iframeWin)) return false;
        return await clickNativeAuditButton(iframeWin, 'btn_ReportEnt', { action: 'entry', expectedStatuses: ['2', '3'] });
    }

    // --- 取审 ---
    function simulateNativeUndoAudit() {
        const iframeWin = getReportIframeWin();
        if (!iframeWin) return false;
        // 优先调用 ReportUndo 函数
        if (typeof iframeWin.ReportUndo === 'function') {
            if (!ensureSelectedGrid(iframeWin)) return false;
            try {
                const sel = iframeWin.me.selectedGrid.datagrid('getSelected');
                if (!sel) return false;
                dbg('直接调用 ReportUndo');
                iframeWin.ReportUndo(sel.ReportDR, '', '');
                return true;
            } catch(e) {
                dbg('ReportUndo 调用失败:', e);
                return false;
            }
        }
        // 回退：点击取审按钮
        try {
            const doc = iframeWin.document;
            const btn = doc.getElementById('btn_ReportUndo');
            if (btn) {
                const jq = iframeWin.jQuery;
                if (jq) { jq(btn).click(); return true; }
                btn.click(); return true;
            }
        } catch(e) {}
        return false;
    }

    // --- 保存 ---
    async function simulateNativeSave() {
        const iframeWin = getReportIframeWin();
        if (!iframeWin) return false;
        if (!ensureSelectedGrid(iframeWin)) return false;
        return await clickNativeAuditButton(iframeWin, 'btn_ReportSave', { action: 'save', expectedStatuses: [] });
    }

    // --- 结果分类 ---
    function parseComparableNumber(value) {
        const raw = String(value == null ? '' : value).trim()
            .replace(/[＜﹤]/g, '<')
            .replace(/[＞﹥]/g, '>')
            .replace(/[≤]/g, '<=')
            .replace(/[≥]/g, '>=')
            .replace(/,/g, '');
        if (!raw) return null;
        const m = raw.match(/^(<=|>=|<|>)?\s*([-+]?\d+(?:\.\d+)?)/);
        if (!m) return null;
        return { op: m[1] || '', value: parseFloat(m[2]), raw };
    }

    function compareResultToRange(result, lowValue, highValue) {
        const parsed = parseComparableNumber(result);
        if (!parsed || isNaN(parsed.value)) return '';
        const low = parseComparableNumber(lowValue);
        const high = parseComparableNumber(highValue);
        const hasLow = low && !isNaN(low.value);
        const hasHigh = high && !isNaN(high.value);

        // 带操作符的结果：只能在确定时返回 HIGH/LOW，否则返回 ''（不确定）
        if (parsed.op === '<' || parsed.op === '<=') {
            // "<X" 的实际值 < X，永远不能确定为 HIGH
            if (parsed.op === '<' && hasLow && parsed.value <= low.value) return 'LOW';
            if (parsed.op === '<=' && hasLow && parsed.value < low.value) return 'LOW';
            // 只有无边界限制时才可能是 NORMAL
            if (!hasLow && !hasHigh) return 'NORMAL';
            return '';  // 不确定
        }
        if (parsed.op === '>' || parsed.op === '>=') {
            // ">X" 的实际值 > X，永远不能确定为 LOW
            if (parsed.op === '>' && hasHigh && parsed.value >= high.value) return 'HIGH';
            if (parsed.op === '>=' && hasHigh && parsed.value > high.value) return 'HIGH';
            // 只有无边界限制时才可能是 NORMAL
            if (!hasLow && !hasHigh) return 'NORMAL';
            return '';  // 不确定
        }
        // 无操作符：标准数值比较
        if (hasHigh && parsed.value > high.value) return 'HIGH';
        if (hasLow && parsed.value < low.value) return 'LOW';
        return 'NORMAL';
    }

    function parseReferenceRange(refRange) {
        const raw = String(refRange || '').trim()
            .replace(/[－–—~～至]/g, '-')
            .replace(/[＜﹤]/g, '<')
            .replace(/[＞﹥]/g, '>')
            .replace(/[≤]/g, '<=')
            .replace(/[≥]/g, '>=')
            .replace(/,/g, '');
        if (!raw) return { low: '', high: '' };
        let m = raw.match(/([-+]?\d+(?:\.\d+)?)\s*-\s*([-+]?\d+(?:\.\d+)?)/);
        if (m) return { low: m[1], high: m[2] };
        m = raw.match(/^(?:<|<=)\s*([-+]?\d+(?:\.\d+)?)/);
        if (m) return { low: '', high: m[1] };
        m = raw.match(/^(?:>|>=)\s*([-+]?\d+(?:\.\d+)?)/);
        if (m) return { low: m[1], high: '' };
        m = raw.match(/(?:正常|参考|值)?[：:\s]*([-+]?\d+(?:\.\d+)?)\s*以下/);
        if (m) return { low: '', high: m[1] };
        m = raw.match(/(?:正常|参考|值)?[：:\s]*([-+]?\d+(?:\.\d+)?)\s*以上/);
        if (m) return { low: m[1], high: '' };
        return { low: '', high: '' };
    }

    function getItemRangeValues(item) {
        const low = item.ValueLow || item.LowValue || item.RefLow || item.ReferenceLow || '';
        const high = item.ValueHigh || item.HighValue || item.RefHigh || item.ReferenceHigh || '';
        if (low || high) return { low, high };
        return parseReferenceRange(item.RefRanges || item.RefRange || item.ReferenceRange || '');
    }

    function getItemPanicRangeValues(item) {
        const low = item.PanicLow || item.CriticalLow || item.CrisisLow || item.DangerLow || '';
        const high = item.PanicHigh || item.CriticalHigh || item.CrisisHigh || item.DangerHigh || '';
        return { low, high };
    }

    function compareResultToPanicRange(result, item) {
        const range = getItemPanicRangeValues(item || {});
        if (!range.low && !range.high) return '';
        return compareResultToRange(result, range.low, range.high);
    }

    function normalizeQualitativeText(value) {
        return String(value || '')
            .toUpperCase()
            .replace(/[＋﹢]/g, '+')
            .replace(/[－﹣]/g, '-')
            .replace(/\s+/g, '')
            .trim();
    }

    function isExplicitPositiveText(value) {
        const r = normalizeQualitativeText(value);
        if (!r) return false;
        if (r === '+' || /^\d+\+$/.test(r) || /^\++$/.test(r)) return true;
        return r.includes('阳性') || r.includes('弱阳') || r.includes('阳性(+)') ||
            r === 'POSITIVE' || r === 'POS' || r === 'REACTIVE' || r === 'REACT';
    }

    function isExplicitNegativeText(value) {
        const r = normalizeQualitativeText(value);
        if (!r) return false;
        if (r === '-' || r === '(-)' || r === 'NEGATIVE' || r === 'NEG' || r === 'NON-REACTIVE' || r === 'NONREACTIVE') return true;
        return r.includes('阴性') || r === '未见' || r === '未检出' || r === '未检测到';
    }

    function isNegativeReferenceText(value) {
        const r = normalizeQualitativeText(value);
        if (!r) return false;
        return r.includes('阴性') || r.includes('NEGATIVE') || r.includes('NON-REACTIVE') ||
            r.includes('NONREACTIVE') || r === '-' || r === 'NEG';
    }

    function isPositiveReferenceText(value) {
        const r = normalizeQualitativeText(value);
        if (!r || isNegativeReferenceText(r)) return false;
        return r.includes('阳性') || r.includes('POSITIVE') || r.includes('REACTIVE') ||
            r === '+' || r === 'POS';
    }

    function compareQualitativeToReference(result, item) {
        const ref = item.RefRanges || item.RefRange || item.ReferenceRange || item.ValueLow || item.ValueHigh || '';
        if (!ref) return '';
        const positive = isExplicitPositiveText(result);
        const negative = isExplicitNegativeText(result);
        if (!positive && !negative) return '';
        const refNegative = isNegativeReferenceText(ref);
        const refPositive = isPositiveReferenceText(ref);
        if (refNegative && positive) return 'ABNORMAL';
        if (refPositive && negative) return 'ABNORMAL';
        if (refNegative && negative) return 'NORMAL';
        if (refPositive && positive) return 'NORMAL';
        return '';
    }

    function isDashValidNegativeResult(item, result) {
        if (normalizeQualitativeText(result) !== '-') return false;
        const ref = item.RefRanges || item.RefRange || item.ReferenceRange || item.ValueLow || item.ValueHigh || '';
        const format = String(item.ResultFormat || '').toUpperCase();
        const name = String(item.CName || item.Code || item.Synonym || '').toUpperCase();
        if (isNegativeReferenceText(ref)) return true;
        if (format === 'X' || format === 'S' || String(item.IsCheckText || '') === '1') return true;
        return /尿|URINE|A\/C|ACR|ALB\/CRE|白蛋白|肌酐/.test(name);
    }

    function isEmptyResultValue(item, result) {
        const v = String(result == null ? '' : result).trim();
        if (!v || v === '未检' || v === ' ') return true;
        if (v === '-') return !isDashValidNegativeResult(item || {}, v);
        return false;
    }

    function isCriticalResultItem(item) {
        const flag = (item.AbFlag || item.CriticalFlag || item.CrisisFlag || item.DangerFlag || item.PanicFlag || '').toString().toUpperCase().trim();
        if (flag === 'HH' || flag === 'LL' || flag === 'CRITICAL' || flag === 'DANGER' || flag === 'PANIC') return true;
        if (String(item.IsPanic || item.Panic || '').trim() === '1') return true;
        const result = (item.TextRes && String(item.TextRes).trim()) ? item.TextRes : item.Result;
        const panicStatus = compareResultToPanicRange(result, item);
        if (panicStatus === 'HIGH' || panicStatus === 'LOW') return true;
        const text = [
            item.AbFlagDesc, item.CriticalFlagDesc, item.CrisisFlagDesc, item.DangerFlagDesc,
            item.ResultPrompt, item.Prompt, item.Alert, item.Tips, item.StatusDesc
        ].map(v => String(v || '')).join(' ');
        return text.indexOf('危急') !== -1 || text.indexOf('危急值') !== -1;
    }

    function isCriticalSpecimenRow(row) {
        if (!row) return false;
        if (String(row.IsPanic || row.Panic || '').trim() === '1') return true;
        if (row.PanicReportDR) return true;
        const text = [row.PanicFlag, row.PanicDesc, row.PanicText, row.Alert, row.Tips, row.FlagStr]
            .map(v => String(v || '')).join(' ');
        return text.indexOf('危急') !== -1 || text.indexOf('危急值') !== -1;
    }

    function classifyStatusText(status) {
        if (status === 'NORMAL') return '正常';
        if (status === 'CRITICAL') return '危急';
        if (status === 'ABNORMAL') return '异常';
        if (status === 'UNCERTAIN') return '待定';
        return status || '待定';
    }

    function isAutoAuditableClassified(result) {
        return !!result && result.status === 'NORMAL';
    }

    function getLiveClassification(reportDR) {
        if (!reportDR) return null;
        return wsClassifiedCache[String(reportDR)] || null;
    }

    function isLiveNormalForBatch(reportDR) {
        const live = getLiveClassification(reportDR);
        return !!live && live.status === 'NORMAL';
    }

    function validateAuditClassification(reportDR, context) {
        const live = getLiveClassification(reportDR);
        if (!live) return { ok: false, msg: '分类未完成，请稍候刷新' };
        if (live.status === 'CRITICAL') {
            return { ok: false, msg: getAutoAuditBlockReason(live, live.row) };
        }
        if (context === 'abnormal') {
            if (live.status === 'NORMAL') {
                return { ok: false, msg: '该标本已分类为正常，请到正常可审视图批审' };
            }
            if (live.status === 'UNCERTAIN') {
                return { ok: false, msg: '结果待定，需人工确认后再审核' };
            }
            return { ok: true };
        }
        if (live.status !== 'NORMAL') {
            return { ok: false, msg: getAutoAuditBlockReason(live, live.row) };
        }
        return { ok: true };
    }

    function getAutoAuditBlockReason(result, row) {
        const r = result || {};
        const specimen = row || r.row || {};
        const name = specimen.PatName || specimen.Labno || '';
        if (!r.status) return '未完成分类，需人工确认';
        if (r.status === 'CRITICAL') return `🚨 ${name} 有危急值，必须在原始LIS中审核`;
        if (r.status === 'ABNORMAL') return `⚠️ ${name} 有异常结果，需人工审核`;
        if (r.status === 'UNCERTAIN') return `⚠️ ${name} 结果待定，需人工确认`;
        if (r.status !== 'NORMAL') return `⚠️ ${name} 状态为${classifyStatusText(r.status)}，不可自动审核`;
        return '';
    }

    function classifyResultItem(item) {
        // 关键：结果为空/缺失 → UNCERTAIN
        const result = ((item.TextRes && String(item.TextRes).trim()) ? item.TextRes : (item.Result || '')).trim();
        if (isEmptyResultValue(item, result)) return 'UNCERTAIN';

        const flag = (item.AbFlag || '').toUpperCase().trim();
        if (isCriticalResultItem(item)) return 'CRITICAL';  // 危急值
        if (flag === 'H') return 'HIGH';
        if (flag === 'L') return 'LOW';
        if (flag === 'A') return 'ABNORMAL';

        const qualitativeStatus = compareQualitativeToReference(result, item);
        if (qualitativeStatus) return qualitativeStatus;
        if (isDashValidNegativeResult(item, result)) return 'NORMAL';

        // 回退：数值比较
        const range = getItemRangeValues(item);
        if (range.low || range.high) {
            const rangeStatus = compareResultToRange(result, range.low, range.high);
            if (rangeStatus) return rangeStatus;
        }

        // 无法判断（非数值结果等）→ UNCERTAIN
        if (!parseComparableNumber(result) && !flag) {
            return 'UNCERTAIN';
        }

        return 'NORMAL';
    }

    // --- 后台分类所有未审核的完整标本 ---
    async function classifyAllSpecimens(loadSeq = _wsLoadSeq) {
        if (wsClassifying) return;
        wsClassifying = true;
        const runSeq = ++_classifyRunSeq;
        try {
            if (loadSeq !== _wsLoadSeq) return;
            // 筛选需要分类的标本：未审核 + 结果完整 + 未缓存
            const toClassify = wsData.filter(r => {
                const status = String(r.Status || r.ReportStatus || '');
                if (status === '3' || status === '4') return false;
                const complete = String(r.IsComplete || '');
                if (complete !== '1') return false;
                return isClassificationStale(r);
            });

            if (toClassify.length === 0) {
                calcMachineCounts();
                renderWSTabs();
                renderWSCategoryBar();
                renderWSTable();
                return;
            }

            if (wsCategory === 'abnormal' || wsCategory === 'normal') {
                toClassify.sort((a, b) => {
                    const score = r => {
                        let s = 0;
                        if (wsActiveWG && r._wg === wsActiveWG) s -= 100;
                        if (wsActiveMachine && prWorkGroupMachineDR(r) === wsActiveMachine) s -= 50;
                        return s;
                    };
                    const diff = score(a) - score(b);
                    if (diff) return diff;
                    return compareSpecimensByMachineGroup(a, b);
                });
            }

            dbg('开始分类', toClassify.length, '个标本...');

            // 批量分类（每批 8 个）
            for (let i = 0; i < toClassify.length; i += 8) {
                if (loadSeq !== _wsLoadSeq) return;
                const batch = toClassify.slice(i, i + 8);
                const results = await Promise.all(batch.map(r => fetchAndClassifySpecimen(r)));
                if (loadSeq !== _wsLoadSeq) return;
                results.forEach(r => {
                    if (r && r.reportDR) {
                        r._accessTs = Date.now();
                        if (!r.fingerprint && r.row) attachClassificationMeta(r, r.row);
                        wsClassifiedCache[r.reportDR] = r;
                        _classifyVersion++;
                    }
                });
                // 缓存淘汰（按最近访问时间排序，淘汰最久未访问的）
                const cacheKeys = Object.keys(wsClassifiedCache);
                if (cacheKeys.length > _CLASSIFIED_CACHE_MAX) {
                    cacheKeys.sort((a, b) => (wsClassifiedCache[a]._accessTs || 0) - (wsClassifiedCache[b]._accessTs || 0));
                    cacheKeys.slice(0, cacheKeys.length - _CLASSIFIED_CACHE_MAX).forEach(k => {
                        delete wsClassifiedCache[k];
                        _classifyVersion++;
                    });
                }
                invalidateCaches();
                if (wsCategory === 'abnormal') prefetchAbnormalAuditContext();
                await new Promise(r => setTimeout(r, 0)); // 仅 yield，不加额外延迟
            }

            dbg('分类完成');
            if (loadSeq !== _wsLoadSeq) return;
            calcMachineCounts();
            renderWSTabs();
            renderWSCategoryBar();
            renderWSTable();
        } catch(e) {
            dbg('分类异常:', e);
        } finally {
            if (runSeq === _classifyRunSeq) wsClassifying = false;
        }
    }

    // --- 获取标本详情并分类 ---
    async function fetchAndClassifySpecimen(row) {
        const reportDR = row.ReportDR || row.TodoReportDR || '';
        if (!reportDR) return { status: 'UNCERTAIN', items: [], row };

        try {
            const ss = buildSS(row._wg || wgDR());
            const p = new URLSearchParams();
            p.set('ClassName', 'LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
            p.set('QueryName', 'GetReportInfoAll');
            p.set('FunModul', 'MTHD');
            p.set('P0', reportDR);
            p.set('P1', row.MachineParameterDR || '');
            p.set('P2', row.WorkGroupMachineDR || '');
            p.set('P3', row.Status || row.ReportStatus || '');
            p.set('P4', row.EpisodeNo || '');
            p.set('P5', row.TransmitDate || '');
            p.set('P14', ss);

            let data = await fetchJ(CSP + '?' + p.toString());
            let itemInfo = (data && data.ItemInfo) ? data.ItemInfo : [];
            const labInfo = (data && data.LabInfo) ? data.LabInfo : [];

            // 带状态查询返回空时，用空状态重试
            if (itemInfo.length === 0 && (row.Status || row.ReportStatus)) {
                p.set('P3', '');
                data = await fetchJ(CSP + '?' + p.toString());
                itemInfo = (data && data.ItemInfo) ? data.ItemInfo : [];
            }

            // 缓存原始数据供详情面板复用，避免重复请求
            if (itemInfo.length > 0) {
                _classifyRawCache[reportDR] = { data, ts: Date.now() };
                // 限制缓存大小，防止内存泄漏
                const keys = Object.keys(_classifyRawCache);
                if (keys.length > 200) {
                    const sorted = keys.sort((a, b) => (_classifyRawCache[a].ts || 0) - (_classifyRawCache[b].ts || 0));
                    for (let i = 0; i < sorted.length - 100; i++) delete _classifyRawCache[sorted[i]];
                }
            }

            const classifications = itemInfo.map(item => ({
                name: item.CName || '',
                CName: item.CName || '',
                Code: item.Code || '',
                Synonym: item.Synonym || '',
                result: (item.TextRes && String(item.TextRes).trim()) ? item.TextRes : (item.Result || ''),
                unit: item.Unit || item.Units || '',
                refRange: item.RefRanges || '',
                RefRanges: item.RefRanges || item.RefRange || item.ReferenceRange || '',
                ResultFormat: item.ResultFormat || '',
                IsCheckText: item.IsCheckText || '',
                abFlag: item.AbFlag || '',
                status: classifyResultItem(item),
                critical: isCriticalResultItem(item),
                panicLow: item.PanicLow || item.CriticalLow || '',
                panicHigh: item.PanicHigh || item.CriticalHigh || '',
                preResult: item
            }));

            // 传染病历史结果比对（x8 仪器）
            const isInfectionPanel = checkInfectionPanel(row, classifications);
            if (isInfectionPanel) {
                return attachClassificationMeta({
                    status: 'ABNORMAL',
                    items: classifications,
                    labInfo: labInfo[0] || {},
                    row,
                    reportDR,
                    infectionWarning: isInfectionPanel
                }, row);
            }

            // 关键安全检查：无结果 → UNCERTAIN，绝不自动审核
            if (itemInfo.length === 0) {
                return attachClassificationMeta({ status: 'UNCERTAIN', items: [], labInfo: labInfo[0] || {}, row, reportDR }, row);
            }

            const hasAbnormal = classifications.some(c => c.status === 'HIGH' || c.status === 'LOW' || c.status === 'ABNORMAL' || c.status === 'CRITICAL');
            const hasCritical = isCriticalSpecimenRow(row) || classifications.some(c => c.status === 'CRITICAL' || c.critical);
            const hasUncertain = classifications.some(c => c.status === 'UNCERTAIN');
            const hasComplete = row.IsComplete === '1';
            // 检查是否有结果为空的项目
            const hasEmptyResults = classifications.some(c => isEmptyResultValue(c, c.result));

            let overallStatus = 'NORMAL';
            if (hasCritical) overallStatus = 'CRITICAL';
            else if (hasAbnormal) overallStatus = 'ABNORMAL';
            else if (hasUncertain || !hasComplete || hasEmptyResults) overallStatus = 'UNCERTAIN';

            return attachClassificationMeta({
                status: overallStatus,
                items: classifications,
                labInfo: labInfo[0] || {},
                row,
                reportDR
            }, row);
        } catch(e) {
            dbg('获取标本详情失败:', row.PatName, e);
            return attachClassificationMeta({ status: 'UNCERTAIN', items: [], row, reportDR, error: e.message }, row);
        }
    }

    // --- 传染病项目历史比对 ---
    // x8 仪器的 8 个传染病项目：两对半 + 梅毒 + 丙肝 + 艾滋
    const INFECTION_ITEMS = [
        '乙肝表面抗原', 'HBsAg',
        '乙肝表面抗体', 'HBsAb',
        '乙肝e抗原', 'HBeAg',
        '乙肝e抗体', 'HBeAb',
        '乙肝核心抗体', 'HBcAb',
        '梅毒螺旋体抗体', 'TP', '梅毒',
        '丙型肝炎抗体', 'HCV', '丙肝',
        '人类免疫缺陷病毒抗体', 'HIV', '艾滋'
    ];

    function checkInfectionPanel(row, classifications) {
        // 只检查 x8 仪器
        const machineName = (row._mn || '').toLowerCase();
        if (!machineName.includes('x8') && !machineName.includes('传染病')) {
            return null;
        }

        // 找出传染病项目
        const infectionItems = classifications.filter(c => {
            const name = (c.name || '').toLowerCase();
            return INFECTION_ITEMS.some(item => name.includes(item.toLowerCase()));
        });

        if (infectionItems.length < 5) return null; // 不是完整的传染病面板

        // 检查是否有历史阳性现在阴性的情况
        const warnings = [];
        infectionItems.forEach(item => {
            const history = item.preResult;
            if (!history) return;

            // 解析历史结果
            const histItems = parsePreResult(history);
            if (histItems.length === 0) return;

            // 获取最近的历史结果
            const sorted = [...histItems].sort((a, b) => {
                const da = a.date ? new Date(a.date).getTime() : 0;
                const db = b.date ? new Date(b.date).getTime() : 0;
                return db - da;
            });
            const lastHist = sorted[0];
            const histResult = (lastHist.result || '').trim();

            // 判断历史是否阳性
            const isHistPositive = isPositiveResult(histResult);
            // 判断当前是否阴性
            const isCurrentNegative = isNegativeResult(item.result);

            // 历史阳性 → 现在阴性 = 异常
            if (isHistPositive && isCurrentNegative) {
                warnings.push(`${item.name}: 历史阳性(${histResult}) → 现阴性`);
            }
        });

        return warnings.length > 0 ? warnings.join('; ') : null;
    }

    // 判断是否阳性结果
    function isPositiveResult(result) {
        if (!result) return false;
        const r = result.toUpperCase().trim();
        // 阳性标记
        if (r === '+' || r === '阳性' || r === 'POSITIVE' || r === 'POS' || r === 'REACTIVE') return true;
        if (/^\+{1,4}$/.test(r) || r.includes('阳性') || r.includes('弱阳')) return true;
        // 数值 > 1（S/CO 值通常 >1 为阳性）
        const num = parseFloat(r);
        if (!isNaN(num) && num > 1) return true;
        return false;
    }

    // 判断是否阴性结果
    function isNegativeResult(result) {
        if (!result) return false;
        const r = result.toUpperCase().trim();
        if (r === '-' || r === '阴性' || r === 'NEGATIVE' || r === 'NEG' || r === 'NON-REACTIVE') return true;
        if (r.includes('阴性') || r.includes('阴')) return true;
        // 数值 < 1（S/CO 值通常 <1 为阴性）
        const num = parseFloat(r);
        if (!isNaN(num) && num < 1) return true;
        return false;
    }

    // --- 获取所有待审核标本 ---
    function getAuditEligibleRows() {
        const rows = getNativeDatagridRows();
        return rows.filter(r => {
            const status = String(r.Status || r.ReportStatus || '');
            // 只有"登记"(1)和"初审"(2)状态的标本可以审核
            return status === '1' || status === '2';
        });
    }

    // --- 注入工具栏 ---
    function injectToolbar() {
        if (document.getElementById('lis-toolbar')) return;

        const toolbar = document.createElement('div');
        toolbar.id = 'lis-toolbar';
        toolbar.innerHTML = `
            <span class="tb-title">🔬 审核</span>
            <span class="tb-sep"></span>
            <div class="tb-stat" id="lis-tb-stat">
                <span class="st-total" id="lis-tb-total">加载中...</span>
            </div>
            <span class="tb-sep"></span>
            <button class="tb-btn btn-audit" id="lis-tb-quick" title="审核当前标本并跳转下一个 (Alt+A)">⚡ 审核</button>
            <button class="tb-btn btn-batch" id="lis-tb-batch" title="批量审核所有正常标本 (Alt+B)">📋 批审</button>
            <button class="tb-btn btn-refresh" id="lis-tb-refresh" title="刷新">🔄</button>
            <button class="tb-btn btn-pwd" id="lis-tb-pwd" title="审核密码">🔐</button>
            <span class="tb-shortcut"><kbd>Alt+A</kbd>审核 <kbd>Alt+B</kbd>批审 <kbd>Alt+N</kbd>下一个</span>
            <button class="tb-close" id="lis-tb-close" title="隐藏工具栏">✕</button>
        `;
        document.body.appendChild(toolbar);

        // 顶部悬停展开条
        const hoverZone = document.createElement('div');
        hoverZone.id = 'lis-tb-hoverzone';
        document.body.appendChild(hoverZone);

        // 隐藏/显示工具栏
        document.getElementById('lis-tb-close').addEventListener('click', () => {
            toolbar.classList.remove('show');
            toolbar.classList.add('hide');
            hoverZone.classList.remove('hidden');
        });

        // 鼠标移到顶部展开条时显示工具栏
        hoverZone.addEventListener('mouseenter', () => {
            toolbar.classList.add('show');
            toolbar.classList.remove('hide');
            hoverZone.classList.add('hidden');
        });

        // 鼠标离开工具栏时自动隐藏（延迟2秒）
        let hideTimer = null;
        toolbar.addEventListener('mouseenter', () => { clearTimeout(hideTimer); });
        toolbar.addEventListener('mouseleave', () => {
            hideTimer = setTimeout(() => {
                toolbar.classList.remove('show');
                toolbar.classList.add('hide');
                hoverZone.classList.remove('hidden');
            }, 2000);
        });

        // 事件绑定
        document.getElementById('lis-tb-quick').addEventListener('click', quickAuditCurrent);
        document.getElementById('lis-tb-batch').addEventListener('click', showBatchAuditDialog);
        document.getElementById('lis-tb-refresh').addEventListener('click', updateToolbarStats);
        document.getElementById('lis-tb-pwd').addEventListener('click', openPwdDlg);
    }

    // --- 更新工具栏统计 ---
    async function updateToolbarStats() {
        const statEl = document.getElementById('lis-tb-stat');
        if (!statEl) return;

        const eligible = getAuditEligibleRows();
        const total = eligible.length;

        if (total === 0) {
            statEl.innerHTML = '<span class="st-total">✅ 无待审核标本</span>';
            return;
        }

        statEl.innerHTML = `<span class="st-total">待审核: ${total}</span><span style="color:rgba(255,255,255,.5);font-size:11px">点击刷新</span>`;

        // 异步获取每个标本的分类（只取前50个避免过慢）
        const toCheck = eligible.slice(0, 50);
        let normal = 0, abnormal = 0, critical = 0, uncertain = 0;

        // 并发获取（每批10个）
        const allResults = [];
        for (let i = 0; i < toCheck.length; i += 10) {
            const batch = toCheck.slice(i, i + 10);
            const results = await Promise.all(batch.map(r => fetchAndClassifySpecimen(r)));
            allResults.push(...results);
            results.forEach(r => {
                if (r.status === 'NORMAL') normal++;
                else if (r.status === 'CRITICAL') critical++;
                else if (r.status === 'ABNORMAL') abnormal++;
                else uncertain++;
            });
        }

        statEl.innerHTML = `
            <span class="st-normal" title="全部正常，可批量审核">正常: ${normal}</span>
            <span class="st-abnormal" title="有异常结果，需人工审核">异常: ${abnormal}</span>
            ${critical > 0 ? `<span class="st-abnormal" title="危急值，必须在原始LIS中审核">危急: ${critical}</span>` : ''}
            ${uncertain > 0 ? `<span class="st-uncertain" title="无法判断，需人工审核">待定: ${uncertain}</span>` : ''}
            <span class="st-total">共: ${total}</span>
        `;

        // 保存分类结果供后续使用（复用已获取的数据，不重复请求）
        window._lisClassifiedRows = toCheck;
        window._lisClassifiedResults = allResults;
    }

    // --- 快速审核当前标本 ---
    async function quickAuditCurrent() {
        const auditLockId = acquireAuditLock('quickAudit');
        if (!auditLockId) return;
        if (_abnormalAuditInProgress || _detailAuditInProgress) {
            showToast('正在审核异常标本或详情面板审核中，请稍候', 'warning');
            releaseAuditLock(auditLockId);
            return;
        }

        const selected = getNativeSelectedRow();
        if (!selected) {
            releaseAuditLock(auditLockId);
            showToast('请先选择一个标本', 'warning');
            return;
        }

        const btn = document.getElementById('lis-tb-quick');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 审核中...'; }

        try {
            // 优先使用已缓存的分类结果
            const cached = wsClassifiedCache[selected.ReportDR];
            const result = cached || await fetchAndClassifySpecimen(selected);

            if (result.status === 'CRITICAL') {
                showToast(getAutoAuditBlockReason(result, selected), 'error');
                return;
            }

            if (result.status === 'ABNORMAL') {
                const abnormalItems = result.items.filter(i => i.status !== 'NORMAL');
                const names = abnormalItems.map(i => `${i.name}(${i.result})`).join(', ');
                showToast(`⚠️ 异常标本: ${selected.PatName || ''} - ${names}`, 'warning');
                return;
            }

            if (result.status === 'UNCERTAIN') {
                showToast(`⚠️ 待定标本: ${selected.PatName || ''} - 需人工确认`, 'warning');
                return;
            }

            // 正常标本，执行审核
            const reportDR = result.reportDR;
            dbg('审核标本:', reportDR, selected.PatName);

            let iframeWin = getReportIframeWin() || await ensureReportPageLoaded();
            if (!iframeWin) {
                showToast('未找到报告处理页面，请先打开"报告处理"', 'error');
                return;
            }
            let auditOK = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth', { action: 'audit', expectedStatuses: ['3'], timeoutMs: 15000, missingAsSuccess: true, targetReportDR: reportDR });
            if (!auditOK) {
                auditOK = await confirmAuditEventually(iframeWin, reportDR, selected.PatName || selected.Labno || '');
            }
            if (auditOK === 'incomplete') {
                showToast(`⚠️ 跳过: ${selected.PatName || ''} — 结果不完整，不可审核`, 'warning');
            } else if (auditOK) {
                showToast(`✅ 已审核: ${selected.PatName || ''}`, 'success');
                advanceToNextSpecimen();
            } else {
                showToast('⚠️ 审核失败，请手动点击底部工具栏的"审核"按钮', 'warning');
            }

        } catch(e) {
            dbg('快速审核失败:', e);
            showToast('审核失败: ' + e.message, 'error');
        } finally {
            releaseAuditLock(auditLockId);
            if (btn) { btn.disabled = false; btn.textContent = '⚡ 审核'; }
        }
    }

    // --- 跳转到下一个待审核标本 ---
    function advanceToNextSpecimen() {
        const rows = getNativeDatagridRows();
        const selected = getNativeSelectedRow();
        if (!selected) return;

        const selectedDR = selected.ReportDR || '';
        const currentIndex = rows.findIndex(r => (r.ReportDR || '') === selectedDR);
        if (currentIndex === -1) return;

        // 找下一个待审核的标本
        for (let i = currentIndex + 1; i < rows.length; i++) {
            const status = String(rows[i].Status || rows[i].ReportStatus || '');
            if (status === '1' || status === '2') {
                triggerNativeRowClick(i);
                return;
            }
        }
        // 没有下一个了，从头找
        for (let i = 0; i < currentIndex; i++) {
            const status = String(rows[i].Status || rows[i].ReportStatus || '');
            if (status === '1' || status === '2') {
                triggerNativeRowClick(i);
                return;
            }
        }
        showToast('已到末尾，无更多待审核标本', 'success');
    }

    // --- 跳转到上一个待审核标本 ---
    function advanceToPrevSpecimen() {
        const rows = getNativeDatagridRows();
        const selected = getNativeSelectedRow();
        if (!selected) return;

        const selectedDR = selected.ReportDR || '';
        const currentIndex = rows.findIndex(r => (r.ReportDR || '') === selectedDR);
        if (currentIndex === -1) return;

        // 找上一个待审核的标本
        for (let i = currentIndex - 1; i >= 0; i--) {
            const status = String(rows[i].Status || rows[i].ReportStatus || '');
            if (status === '1' || status === '2') {
                triggerNativeRowClick(i);
                return;
            }
        }
        // 没有上一个了，从末尾找
        for (let i = rows.length - 1; i > currentIndex; i--) {
            const status = String(rows[i].Status || rows[i].ReportStatus || '');
            if (status === '1' || status === '2') {
                triggerNativeRowClick(i);
                return;
            }
        }
        showToast('已是第一个待审核标本', 'success');
    }

    // --- 批量审核对话框 ---
    async function showBatchAuditDialog() {
        const auditLockId = acquireAuditLock('showBatchDialog');
        if (!auditLockId) return;
        if (_abnormalAuditInProgress || _detailAuditInProgress) {
            showToast('正在审核异常标本或详情面板审核中，请稍候', 'warning');
            releaseAuditLock(auditLockId);
            return;
        }
        try {
            const eligible = getAuditEligibleRows();
            if (eligible.length === 0) {
                showToast('没有待审核的标本', 'success');
                return;
            }

            // 显示进度
            showToast(`正在分析 ${eligible.length} 个标本...`, 'warning');

            // 获取所有标本的分类（优先使用缓存）
            const results = [];
            const toFetch = [];
            for (const r of eligible) {
                const cached = wsClassifiedCache[r.ReportDR];
                if (cached && !isClassificationStale(r)) {
                    results.push(cached);
                } else {
                    toFetch.push(r);
                }
            }
            if (toFetch.length > 0) {
                for (let i = 0; i < toFetch.length; i += 8) {
                    const batch = toFetch.slice(i, i + 8);
                    const batchResults = await Promise.all(batch.map(r => fetchAndClassifySpecimen(r)));
                    results.push(...batchResults);
                }
            }

            const normalSpecimens = results.filter(r => r.status === 'NORMAL');
            const abnormalSpecimens = results.filter(r => r.status === 'ABNORMAL' || r.status === 'CRITICAL');
            const uncertainSpecimens = results.filter(r => r.status === 'UNCERTAIN');

            // 创建确认对话框（对话框确认后会重新获取批审锁）
            showAuditConfirmDialog(normalSpecimens, abnormalSpecimens, uncertainSpecimens);
        } finally {
            releaseAuditLock(auditLockId);
        }
    }

    // --- 显示审核确认对话框 ---
    function showAuditConfirmDialog(normal, abnormal, uncertain) {
        // 兼容旧调用：showAuditConfirmDialog([specimens]) — 走确认对话框
        if (Array.isArray(normal) && abnormal === undefined) {
            const specimens = normal;
            if (specimens.length === 0) { toast('没有可审核的标本', 'w'); return; }
            const formatted = specimens.map(s => {
                const cached = wsClassifiedCache[s.ReportDR];
                if (cached && !isClassificationStale(s)) return { ...cached, row: s, reportDR: s.ReportDR };
                return { status: 'UNCERTAIN', items: [], row: s, reportDR: s.ReportDR || '' };
            });
            const normalOnly = formatted.filter(isAutoAuditableClassified);
            if (normalOnly.length !== specimens.length) {
                showToast('部分标本不可自动审核，已取消批审', 'warning');
                return;
            }
            confirmAndBatchAudit(normalOnly);
            return;
        }
        // 移除已有的对话框
        const existing = document.getElementById('lis-audit-confirm');
        if (existing) existing.remove();

        const dialog = document.createElement('div');
        dialog.id = 'lis-audit-confirm';

        let abnormalHTML = '';
        if (abnormal.length > 0) {
            abnormalHTML = `
                <div class="ab-section">
                    <h5><span class="ab-count" style="background:#e74c3c">${abnormal.length}</span> 异常标本（需人工审核）</h5>
                    <div class="ab-list">
                        ${abnormal.map(r => {
                            const abnormalItems = r.items.filter(i => i.status !== 'NORMAL');
                            const names = abnormalItems.map(i => `${i.name} ${i.result}${i.unit}`).join(', ');
                            return `<div class="ab-item">
                                <span class="ab-name">${esc(r.row.PatName || '未知')}</span>
                                <span class="ab-detail">${esc(r.row.Labno || '')} | ${esc(r.row.TestSetDesc || '')}</span>
                                <span class="ab-tag" style="background:#fce4ec;color:#c62828">⚠ ${esc(names)}</span>
                            </div>`;
                        }).join('')}
                    </div>
                </div>`;
        }

        let uncertainHTML = '';
        if (uncertain.length > 0) {
            uncertainHTML = `
                <div class="ab-section">
                    <h5><span class="ab-count" style="background:#f39c12">${uncertain.length}</span> 待定标本（需人工确认）</h5>
                    <div class="ab-list">
                        ${uncertain.map(r => `<div class="ab-item">
                            <span class="ab-name">${esc(r.row.PatName || '未知')}</span>
                            <span class="ab-detail">${esc(r.row.Labno || '')} | ${esc(r.row.TestSetDesc || '')}</span>
                            <span class="ab-tag" style="background:#fff3e0;color:#e65100">?</span>
                        </div>`).join('')}
                    </div>
                </div>`;
        }

        dialog.innerHTML = `
            <div id="lis-audit-box">
                <div class="ab-hd">
                    <h4>📋 批量审核确认</h4>
                    <button class="ab-close" id="lis-ab-close">✕</button>
                </div>
                <div class="ab-body">
                    <div class="ab-section">
                        <h5><span class="ab-count" style="background:#27ae60">${normal.length}</span> 正常标本（将自动审核）</h5>
                        <div class="ab-list">
                            ${normal.map(r => `<div class="ab-item">
                                <span class="ab-name">${esc(r.row.PatName || '未知')}</span>
                                <span class="ab-detail">${esc(r.row.Labno || '')} | ${esc(r.row.TestSetDesc || '')}</span>
                                <span class="ab-tag" style="background:#e8f5e9;color:#2e7d32">✓ 正常</span>
                            </div>`).join('')}
                        </div>
                    </div>
                    ${abnormalHTML}
                    ${uncertainHTML}
                    <div class="ab-check">
                        <input type="checkbox" id="lis-ab-check" />
                        <label for="lis-ab-check">我确认以上 ${normal.length} 个正常标本的检验结果均适合自动审核</label>
                    </div>
                </div>
                <div class="ab-ft">
                    <button class="ab-export" id="lis-ab-export">📥 导出审核清单</button>
                    <button class="ab-cancel" id="lis-ab-cancel">取消</button>
                    <button class="ab-confirm ok" id="lis-ab-confirm" disabled>✅ 确认审核 (${normal.length})</button>
                </div>
            </div>
        `;

        document.body.appendChild(dialog);
        dialog.classList.add('show');

        // 事件绑定
        const confirmBtn = document.getElementById('lis-ab-confirm');
        const checkBtn = document.getElementById('lis-ab-check');

        checkBtn.addEventListener('change', () => {
            confirmBtn.disabled = !checkBtn.checked;
        });

        // ESC 关闭（与其他关闭路径共用清理）
        let escRemoved = false;
        const escHandler = e => {
            if (e.key === 'Escape') {
                cleanupAndRemove();
            }
        };
        const cleanupAndRemove = () => {
            if (!escRemoved) { document.removeEventListener('keydown', escHandler); escRemoved = true; }
            dialog.remove();
        };
        document.addEventListener('keydown', escHandler);

        document.getElementById('lis-ab-close').addEventListener('click', cleanupAndRemove);
        document.getElementById('lis-ab-cancel').addEventListener('click', cleanupAndRemove);
        dialog.addEventListener('click', e => { if (e.target === dialog) cleanupAndRemove(); });

        confirmBtn.addEventListener('click', () => {
            cleanupAndRemove();
            executeBatchAudit(normal).catch(e => {
                console.error('[LIS] 批审异常:', e);
            });
        });

        document.getElementById('lis-ab-export').addEventListener('click', () => {
            exportAuditTrail(normal, abnormal, uncertain);
        });
    }

    // --- 按 ReportDR 在原生工作列表中选中行 ---
    function selectNativeRowByReportDR(iframeWin, reportDR, options = {}) {
        const jq = iframeWin.jQuery || iframeWin.$;
        if (!jq) { dbg('selectNativeRow: jq 不存在'); return false; }
        installNativeDetailGuard(iframeWin);
        if (!options.force && !canScriptSelectNativeRow(iframeWin, reportDR)) {
            dbg('selectNativeRow: 用户正在查看其他标本，跳过自动选行');
            return false;
        }
        const selectors = options.allGrids ? DATAGRID_SELECTORS : [NATIVE_WORKLIST_SEL];
        for (const sel of selectors) {
            const el = jq(sel);
            if (el.length && el.datagrid) {
                try {
                    const rows = el.datagrid('getRows');
                    if (!rows || rows.length === 0) { dbg('selectNativeRow:', sel, '无行数据'); continue; }
                    for (let i = 0; i < rows.length; i++) {
                        if (String(rows[i].ReportDR) === String(reportDR)) {
                            const opts = el.datagrid('options') || {};
                            el.datagrid('selectRow', i);
                            if (iframeWin.me) {
                                iframeWin.me.selectedGrid = el;
                                iframeWin.me.curReportDR = String(reportDR);
                            }
                            try {
                                if (typeof opts.onSelect === 'function') opts.onSelect.call(el[0], i, rows[i]);
                                else if (typeof opts.onClickRow === 'function') opts.onClickRow.call(el[0], i, rows[i]);
                            } catch(e) { dbg('触发行选择回调异常:', e.message); }
                            const loaded = isReportDetailLoaded(iframeWin, reportDR);
                            dbg('选中原生行:', i, 'ReportDR:', reportDR, 'selector:', sel, 'detailReady=', loaded);
                            return true;
                        }
                    }
                    dbg('selectNativeRow:', sel, '未找到 ReportDR:', reportDR, '共', rows.length, '行, 列表:', rows.slice(0,5).map(r => r.ReportDR).join(','));
                } catch(e) { dbg('selectNativeRow error:', sel, e); }
            }
        }
        dbg('selectNativeRow: 工作列表未找到 datagrid 或目标行');
        return false;
    }

    async function refreshNativeWorkListForItem(iframeWin, item, options = {}) {
        if (!iframeWin || !item) return iframeWin;
        let jq = iframeWin.jQuery || iframeWin.$;
        const me = iframeWin.me;
        if (!jq || !me) return iframeWin;
        const mdrKey = String(item.mdr || '');
        const machineChanged = mdrKey && String(me.WorkGroupMachineDR || '') !== mdrKey;
        if (!machineChanged && !options.force) return iframeWin;
        try {
            if (item.mdr) {
                if (me.WorkGroupMachineDR !== undefined) me.WorkGroupMachineDR = item.mdr;
                try { jq('#cmb_WorkGroupMachine').combogrid('setValue', item.mdr); } catch(e) {}
            }
            const dateStr = jq('#dt_wlReportDate').length ?
                (jq('#dt_wlReportDate').datebox('getValue') || jq('#dt_wlReportDate').datebox('getText') || today()) : today();
            const findStr = '&WorkGroupMachineDR=' + (item.mdr || '') + '&ReportStatus=&SttAccDate=' + dateStr;
            if (typeof iframeWin.ShowWorkList === 'function') iframeWin.ShowWorkList(findStr);
            else if (typeof iframeWin.FindFast === 'function') iframeWin.FindFast(item.labno || findStr);
            await sleep(options.fast ? 70 : (options.force ? 120 : (machineChanged ? 100 : 60)));
        } catch(e) {
            dbg('刷新原生工作列表异常:', e);
        }
        return getReportIframeWin() || iframeWin;
    }

    function updateBatchProgress(text, pct) {
        const textEl = document.getElementById('lis-prog-text');
        const fillEl = document.getElementById('lis-prog-fill');
        if (textEl && text) textEl.textContent = text;
        if (fillEl && typeof pct === 'number') fillEl.style.width = Math.max(0, Math.min(100, pct)) + '%';
    }

    async function waitAndSelectNativeRow(iframeWin, item, options = {}) {
        const timeoutMs = typeof options === 'number' ? options : (options.timeoutMs || 9000);
        const pollMs = (typeof options === 'object' && options.pollMs) || 60;
        const skipListRefresh = typeof options === 'object' && !!options.skipListRefresh;
        const end = Date.now() + timeoutMs;
        let refreshed = skipListRefresh;
        iframeWin = getReportIframeWin() || iframeWin;
        if (iframeWin && selectNativeRowByReportDR(iframeWin, item.reportDR)) {
            return { ok: true, iframeWin };
        }
        if (item.labno && iframeWin && typeof iframeWin.FindFast === 'function') {
            try {
                iframeWin.FindFast(item.labno);
                await sleep(80);
                iframeWin = getReportIframeWin() || iframeWin;
                if (iframeWin && selectNativeRowByReportDR(iframeWin, item.reportDR)) {
                    return { ok: true, iframeWin };
                }
            } catch(e) {}
        }
        while (Date.now() < end) {
            if (!refreshed) {
                refreshed = true;
                iframeWin = await refreshNativeWorkListForItem(iframeWin, item, { force: true });
            } else {
                await sleep(pollMs);
            }
            iframeWin = getReportIframeWin() || iframeWin;
            if (iframeWin && selectNativeRowByReportDR(iframeWin, item.reportDR)) {
                return { ok: true, iframeWin };
            }
        }
        return { ok: false, iframeWin };
    }

    function peekNextBatchItem(queue) {
        if (!queue || !queue.items) return null;
        const idx = (queue.current || 0) + 1;
        return idx < queue.items.length ? queue.items[idx] : null;
    }

    function prepareNextBatchItemAfterAudit(iframeWin, queue, currentItem) {
        const next = peekNextBatchItem(queue);
        if (!next || !iframeWin || !iframeWin.me) return false;
        if (String(next.mdr || '') !== String(currentItem.mdr || '')) return false;
        try {
            const sel = iframeWin.me.selectedGrid ? iframeWin.me.selectedGrid.datagrid('getSelected') : null;
            return !!(sel && String(sel.ReportDR || '') === String(next.reportDR || ''));
        } catch(e) {
            return false;
        }
    }

    function requeueAuditItem(queue, item, reason) {
        item.retry = (item.retry || 0) + 1;
        if (item.retry <= 2) {
            queue.items.push(item);
            dbg('批审临时跳过，放回队尾重试:', item.name || item.labno || item.reportDR, reason, 'retry=', item.retry);
            return true;
        }
        queue.skipped.push({ ...item, reason });
        return false;
    }

    // --- 执行批量审核（逐行审核）---
    async function executeBatchAudit(normalSpecimens) {
        if (normalSpecimens.length === 0) return;
        if (wsClassifying) {
            showToast('标本正在分类中，请等候分类完成后再批审', 'warning');
            return;
        }
        const queue = makeAuditQueue(normalSpecimens, 'batch');
        if (queue.items.length === 0) { showToast('没有可审核的标本', 'warning'); return; }
        await continueAuditQueue(queue);
    }

    async function continueAuditQueue(queue) {
        if (!queue || !queue.items || queue.items.length === 0) return;
        if (wsClassifying) {
            showToast('标本正在分类中，稍候自动继续批审...', 'warning');
            saveAuditQueueNow(queue);
            setTimeout(() => continueAuditQueue(queue).catch(e => dbg('批审等待分类失败:', e)), 2000);
            return;
        }
        const auditLockId = acquireAuditLock('batchAudit');
        if (!auditLockId) { showToast('正在审核中，请稍候', 'warning'); return; }
        if (!acquireQueueLock()) {
            showToast('其他标签页正在批审，请稍候', 'warning');
            releaseAuditLock(auditLockId);
            return;
        }
        if (_abnormalAuditInProgress) {
            showToast('正在审核异常标本中，请稍候', 'warning');
            releaseAuditLock(auditLockId);
            releaseQueueLock();
            return;
        }
        if (_detailAuditInProgress) {
            showToast('正在详情面板审核中，请稍候', 'warning');
            releaseAuditLock(auditLockId);
            releaseQueueLock();
            return;
        }
        if (queue.keepWS) keepWorkbenchOnTop('批审开始');
        const resumeWSRefresh = !!wsTimer;
        stopWSRefresh();

        // 显示进度条
        let progress = document.getElementById('lis-audit-progress');
        if (progress) progress.remove();
        const _batchStartTime = Date.now();
        progress = document.createElement('div');
        progress.id = 'lis-audit-progress';
        progress.innerHTML = `
            <div style="display:flex;align-items:center;gap:12px;margin-bottom:8px">
                <span style="font-size:16px;font-weight:600;color:#2c3e50">正在审核...</span>
                <button id="lis-batch-stop" style="padding:2px 12px;font-size:12px;border:1px solid #e74c3c;background:#fff;color:#e74c3c;border-radius:4px;cursor:pointer">⏹ 停止</button>
            </div>
            <div class="prog-bar"><div class="prog-fill" id="lis-prog-fill" style="width:0%"></div></div>
            <div class="prog-text" id="lis-prog-text">0 / ${queue.items.length}</div>
        `;
        setTimeout(() => { const stopBtn = document.getElementById('lis-batch-stop'); if (stopBtn) stopBtn.onclick = () => { _batchAbort = true; stopBtn.textContent = '正在停止...'; stopBtn.disabled = true; }; }, 50);
        document.body.appendChild(progress);
        progress.classList.add('show');

        try {
            const sameWG = await ensureAuditQueueWorkGroup(queue);
            if (!sameWG) { progress.remove(); return; }

            let iframeWin = getReportIframeWin();
            if (!iframeWin) {
                showToast('正在加载报告页面...', 'warning');
                iframeWin = await ensureReportPageLoaded({ keepWS: queue.keepWS });
                if (queue.keepWS) keepWorkbenchOnTop('报告处理页加载完成');
            }
            if (!iframeWin) {
                showToast('❌ 未找到报告处理页面', 'error');
                progress.remove(); return;
            }

            // 等待 iframe 就绪
            let jq = iframeWin.jQuery || iframeWin.$;
            let me = iframeWin.me;
            if (!jq || !me) {
                dbg('等待 iframe 就绪...');
                for (let w = 0; w < 20; w++) {
                    await new Promise(r => setTimeout(r, 500));
                    iframeWin = getReportIframeWin();
                    if (iframeWin) { jq = iframeWin.jQuery || iframeWin.$; me = iframeWin.me; if (jq && me) break; }
                }
            }
            if (!jq || !me) {
                showToast('报告页面未就绪，请稍后重试', 'error');
                progress.remove(); return;
            }

            updateBatchProgress('准备批审，加载报告列表...', 0);

            let successCount = queue.done.length, failCount = queue.failed.length, skipCount = queue.skipped.length;
            let totalCount = queue.items.length;
            let queuePausedForSwitch = false;
            let batchLastMdr = String(me.WorkGroupMachineDR || '');
            let batchListFresh = false;
            let batchSkipSelect = false;
            _batchAbort = false;
            // 按仪器分组排序剩余项，先审完一台仪器再切换
            if (queue.current < queue.items.length - 1) {
                const remaining = queue.items.splice(queue.current);
                remaining.sort(compareAuditQueueItems);
                queue.items.push(...remaining);
            }

            const firstItem = currentQueueItem(queue);
            if (firstItem && firstItem.mdr && String(firstItem.mdr) !== batchLastMdr) {
                iframeWin = await refreshNativeWorkListForItem(iframeWin, firstItem, { force: true });
                if (iframeWin) { jq = iframeWin.jQuery || iframeWin.$; me = iframeWin.me; }
                batchLastMdr = String(firstItem.mdr);
                batchListFresh = true;
            }

            while (queue.current < queue.items.length) {
                if (_batchAbort) { dbg('批审被用户中止'); saveAuditQueueNow(queue); break; }
                if (_auditAbortFlag) { dbg('批审因审核锁超时被中止'); saveAuditQueueNow(queue); break; }

                const item = currentQueueItem(queue);
                if (!item) break;

                refreshQueueLock();
                const liveRow = resolveQueueItemRow(item);
                if (liveRow && String(liveRow.IsComplete || '') !== '1') {
                    queue.skipped.push({ ...item, reason: '结果不完整' });
                    skipCount++; queue.current++; saveAuditQueueNow(queue); continue;
                }
                let liveClassified = getLiveClassification(item.reportDR);
                if (!liveClassified || (liveRow && isClassificationStale(liveRow))) {
                    if (liveRow) {
                        try {
                            liveClassified = await fetchAndClassifySpecimen(liveRow);
                            if (liveClassified && liveClassified.reportDR) {
                                wsClassifiedCache[liveClassified.reportDR] = liveClassified;
                                _classifyVersion++;
                            }
                        } catch(e) {
                            dbg('批审前重分类失败:', item.reportDR, e.message);
                        }
                    }
                }
                if (!liveClassified) {
                    queue.skipped.push({ ...item, reason: '分类缓存缺失，需刷新后重试' });
                    skipCount++; queue.current++; saveAuditQueueNow(queue); continue;
                }
                if (!isAutoAuditableClassified(liveClassified)) {
                    queue.skipped.push({ ...item, reason: classifyStatusText(liveClassified.status) + '标本不可自动审核' });
                    skipCount++; queue.current++; saveAuditQueueNow(queue); continue;
                }

                if (item.wg && item.wg !== wgDR()) {
                    queue.pausedForSwitch = true;
                    saveAuditQueueNow(queue);
                    const wgName = (WG_MAP[item.wg] || {}).name || item.wg;
                    showToast('切换到' + wgName + '继续审核...', 'warning');
                    queuePausedForSwitch = true;
                    switchWG(item.wg);
                    break;
                }

                const mdrKey = String(item.mdr || '');
                const machineChanged = !!(mdrKey && mdrKey !== batchLastMdr);
                batchListFresh = false;
                totalCount = queue.items.length;
                let etaStr = '';
                if (queue.current > 0) {
                    const elapsed = Date.now() - _batchStartTime;
                    const perItem = elapsed / queue.current;
                    const remaining = perItem * (totalCount - queue.current);
                    const sec = Math.ceil(remaining / 1000);
                    etaStr = sec > 60 ? ` · 剩余约${Math.ceil(sec/60)}分钟` : ` · 剩余约${sec}秒`;
                }
                updateBatchProgress(`${queue.current + 1} / ${totalCount} - ${item.name || item.labno || item.reportDR}${item.retry ? '（重试' + item.retry + '）' : ''}${etaStr}`, queue.current / totalCount * 100);

                if (machineChanged) {
                    updateBatchProgress(`${queue.current + 1} / ${totalCount} - 切换仪器...`, queue.current / totalCount * 100);
                    iframeWin = await refreshNativeWorkListForItem(iframeWin, item, { force: true });
                    if (iframeWin) { jq = iframeWin.jQuery || iframeWin.$; me = iframeWin.me; }
                    batchLastMdr = mdrKey;
                    batchListFresh = true;
                }

                try {
                    if (!jq || !me) {
                        iframeWin = getReportIframeWin();
                        if (iframeWin) { jq = iframeWin.jQuery || iframeWin.$; me = iframeWin.me; }
                    }
                    if (!jq || !me) {
                        queue.failed.push({ ...item, reason: '页面未就绪' });
                        failCount++; queue.current++; saveAuditQueue(queue); continue;
                    }

                    let selectedOk = batchSkipSelect;
                    batchSkipSelect = false;
                    if (selectedOk && !isReportDetailLoaded(iframeWin, item.reportDR)) {
                        dbg('批审: 自动跳下一条校验失败，重新选行', item.reportDR);
                        selectedOk = false;
                    }
                    if (!selectedOk) {
                        updateBatchProgress(`${queue.current + 1} / ${totalCount} - 选中标本...`, queue.current / totalCount * 100);
                        const selectedResult = await waitAndSelectNativeRow(iframeWin, item, {
                            timeoutMs: batchListFresh ? 4500 : 6000,
                            pollMs: 50,
                            skipListRefresh: batchListFresh
                        });
                        iframeWin = selectedResult.iframeWin || iframeWin;
                        if (iframeWin) { jq = iframeWin.jQuery || iframeWin.$; me = iframeWin.me; }
                        selectedOk = selectedResult.ok;
                    }
                    if (!selectedOk) {
                        if (!requeueAuditItem(queue, item, '原生列表未找到')) skipCount++;
                        queue.current++; saveAuditQueue(queue); continue;
                    }

                    updateBatchProgress(`${queue.current + 1} / ${totalCount} - 加载详情...`, queue.current / totalCount * 100);
                    let detailReady = isReportDetailLoaded(iframeWin, item.reportDR);
                    if (!detailReady) {
                        detailReady = await waitReportDetailReady(iframeWin, item.reportDR, 7000, { fastBatch: true });
                    }
                    if (!detailReady) {
                        selectNativeRowByReportDR(iframeWin, item.reportDR);
                        detailReady = await waitReportDetailReady(iframeWin, item.reportDR, 4000, { fastBatch: true });
                    }
                    if (!detailReady) {
                        if (!requeueAuditItem(queue, item, '详情未加载完成')) skipCount++;
                        queue.current++; saveAuditQueue(queue); continue;
                    }

                    updateBatchProgress(`${queue.current + 1} / ${totalCount} - 审核中...`, queue.current / totalCount * 100);
                    let auditResult = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth', { action: 'audit', expectedStatuses: ['3'], batchMode: true, timeoutMs: 10000, keepWS: queue.keepWS, missingAsSuccess: false, targetReportDR: item.reportDR });
                    if (!auditResult) {
                        dbg('批审单条首次未确认，继续确认原生状态:', item.name || item.reportDR);
                        iframeWin = getReportIframeWin() || iframeWin;
                        auditResult = await confirmAuditEventually(iframeWin, item.reportDR, item.name || item.labno || '', { batchMode: true });
                    }
                    if (auditResult === 'incomplete') {
                        queue.skipped.push({ ...item, reason: '结果不完整' });
                        skipCount++;
                    } else if (auditResult) {
                        queue.done.push(item);
                        successCount++;
                        if (prepareNextBatchItemAfterAudit(iframeWin, queue, item)) {
                            batchSkipSelect = true;
                            dbg('批审: LIS 已自动跳到下一标本，跳过下次选行');
                        }
                    } else {
                        queue.failed.push({ ...item, reason: '审核未确认成功' });
                        failCount++;
                    }
                } catch(e) {
                    queue.failed.push({ ...item, reason: e.message });
                    failCount++;
                    dbg('逐行审核异常:', item.name, e.message);
                } finally {
                    queue.current++;
                    saveAuditQueueNow(queue);
                    await sleep(0);
                    try { iframeWin = getReportIframeWin(); if (iframeWin) { jq = iframeWin.jQuery || iframeWin.$; me = iframeWin.me; } } catch(e) {}
                }
            }

            const fill = document.getElementById('lis-prog-fill');
            const text = document.getElementById('lis-prog-text');
            if (fill) fill.style.width = '100%';
            if (text) text.textContent = `完成: ${successCount} 成功, ${failCount} 失败, ${skipCount} 跳过`;

            if (queuePausedForSwitch) {
                if (text) text.textContent = '正在切换工作组，稍后自动继续...';
                return;
            }

            if (queue.current >= queue.items.length) clearAuditQueue();
            if (successCount > 0) {
                const skipMsg = skipCount > 0 ? `，跳过 ${skipCount} 个` : '';
                const failMsg = failCount > 0 ? `，${failCount} 个失败` : '';
                showToast(`✅ 已审核 ${successCount} 个标本${skipMsg}${failMsg}`, 'success');
            } else {
                showToast('❌ 审核全部失败', 'error');
            }

            setTimeout(() => { if (queue.keepWS) keepWorkbenchOnTop('批审完成'); progress.remove(); loadWSData(); }, 2000);

        } catch(e) {
            dbg('批量审核失败:', e);
            showToast('审核失败: ' + e.message, 'error');
        } finally {
            releaseQueueLock();
            releaseAuditLock(auditLockId);
            if (resumeWSRefresh && isWSVisible()) startWSRefresh();
            setTimeout(() => { const p = document.getElementById('lis-audit-progress'); if (p) p.remove(); }, 3000);
        }
    }

    // --- 导出审核轨迹 CSV ---
    function exportAuditTrail(normal, abnormal, uncertain) {
        const all = [
            ...normal.map(r => ({ ...r, _classify: '正常' })),
            ...abnormal.map(r => ({ ...r, _classify: '异常' })),
            ...uncertain.map(r => ({ ...r, _classify: '待定' }))
        ];

        if (all.length === 0) {
            showToast('无数据可导出', 'warning');
            return;
        }

        const headers = ['分类', '姓名', '检验号', '流水号', '医嘱', '状态', '异常项目'];
        const rows = all.map(r => [
            r._classify,
            r.row.PatName || '',
            r.row.Labno || '',
            r.row.EpisodeNo || '',
            r.row.TestSetDesc || '',
            classifyStatusText(r.status),
            r.items.filter(i => i.status !== 'NORMAL').map(i => `${i.name}(${i.result})`).join('; ')
        ]);

        const content = '\uFEFF' + headers.join(',') + '\n' +
            rows.map(r => r.map(c => '"' + String(c).replace(/"/g, '""') + '"').join(',')).join('\n');

        const blob = new Blob([content], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `审核清单_${today()}.csv`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        showToast('已导出审核清单', 'success');
    }

    // --- Toast 提示（审核专用）---
    function showToast(msg, type = 'success') {
        const typeMap = { success: 's', error: 'e', warning: 'w', info: 'i' };
        toast(msg, typeMap[type] || type);
    }

    // --- 键盘快捷键注册 ---
    function registerAuditShortcuts() {
        document.addEventListener('keydown', e => {
            if (isPatientResultPanelEvent(e)) return;
            // 忽略输入框中的按键
            if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) return;
            // 忽略如果对话框打开
            if (document.getElementById('lis-audit-confirm')) return;

            if (e.altKey && (e.key === 'a' || e.key === 'A')) {
                e.preventDefault();
                quickAuditCurrent();
            } else if (e.altKey && (e.key === 'b' || e.key === 'B')) {
                e.preventDefault();
                showBatchAuditDialog();
            } else if (e.altKey && (e.key === 'n' || e.key === 'N')) {
                e.preventDefault();
                advanceToNextSpecimen();
            } else if (e.altKey && (e.key === 'p' || e.key === 'P')) {
                e.preventDefault();
                advanceToPrevSpecimen();
            } else if (e.altKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                loadWSData();
            } else if (e.altKey && (e.key === 'd' || e.key === 'D')) {
                e.preventDefault();
                showDebugPanel();
            }
        });
    }

    // --- 初始化报告页增强 ---
    function initReportEnhance() {
        if (!isReportPageActive()) return;

        if (DEBUG) {
            // 搜索原生审核函数
            const w = uw();
            const auditFuncs = [];
            for (const key of Object.keys(w)) {
                if (typeof w[key] === 'function' && /audit|review|check|report|sign|verify|confirm|save/i.test(key)) {
                    auditFuncs.push(key + ':' + typeof w[key]);
                }
            }
            dbg('找到的函数: ' + auditFuncs.join(', '));

            // 也搜索按钮的 onclick 处理器
            const allBtns = document.querySelectorAll('button[onclick], a[onclick], input[onclick]');
            allBtns.forEach(btn => {
                const oc = btn.getAttribute('onclick') || '';
                if (/audit|review|check|sign|save|report|confirm/i.test(oc)) {
                    dbg('按钮: ' + (btn.textContent||'').trim().substring(0,20) + ' → ' + oc.substring(0, 80));
                }
            });

            // 深度搜索所有按钮（包括 iframe）
            function searchButtons(doc, prefix) {
                const btns = doc.querySelectorAll('button, a, input[type="button"], input[type="submit"], span[onclick], div[onclick], td[onclick]');
                btns.forEach(btn => {
                    const text = (btn.textContent || btn.value || '').trim();
                    const oc = btn.getAttribute('onclick') || '';
                    const id = btn.id || '';
                    if (text.length > 0 && text.length < 20) {
                        dbg(prefix + '按钮: "' + text + '" id=' + id + ' onclick=' + (oc || 'none').substring(0, 100));
                    }
                });
            }
            searchButtons(document, '');

            function searchIframesAll(doc, depth) {
                if (depth > 5) return;
                doc.querySelectorAll('iframe').forEach((iframe, i) => {
                    try {
                        if (iframe.contentDocument) {
                            searchButtons(iframe.contentDocument, 'iframe' + depth + '_' + i + ':');
                            searchIframesAll(iframe.contentDocument, depth + 1);
                        }
                    } catch(e) {}
                });
            }
            searchIframesAll(document, 0);

            const funcNames = [];
            for (const key of Object.keys(w)) {
                if (typeof w[key] === 'function' && /audit|sign|sub|save|check|confirm|report|login|auth|review/i.test(key)) {
                    funcNames.push(key);
                }
            }
            dbg('全局函数: ' + funcNames.join(', '));
        }

        registerAuditShortcuts();
        scheduleNativeDetailGuardInstall();
        dbg('报告处理页增强已加载');
    }


    // ============================================================
    //  初始化
    // ============================================================
    let _inited = false;
    function init() {
        if (_inited) return;
        _inited = true;
        if (!location.href.includes('iMedicalLIS')) return;

        dbg('========================================');
        dbg('iMedicalLIS 增强助手 v7.20.31');
        dbg('隐私模式：所有数据仅本地处理，无任何上传');
        dbg('========================================');

        let _isMain = false;
        try { _isMain = (window === window.top) || !!document.getElementById('sl_changeworkgroup'); } catch(e) {}

        if (_isMain) {
            initAuthPersistence();
            migratePwdStorage();
        }
        initAuthFill();

        if (isAuthPage()) return;

        if (isLoginPage()) {
            initLoginPage();
            return;
        }

        if (!_isMain) return;

        // initQBar(); // 已禁用：不需要顶部快速切换条
        createWS();
        createPatientResultTool();
        checkNavigateTarget();
        checkAuditQueueResume();
        startQCInputProbe();
        injectToolbar();
        initReportEnhance();
        dbg('就绪 | 左键🔬=工作组 | 右键🔬=全科 | Ctrl+Shift+L/A');
    }

    // 页面卸载时清理所有定时器
    window.addEventListener('beforeunload', () => {
        if (_authTimer) { clearInterval(_authTimer); _authTimer = null; }
        if (_batchScanTimer) { clearInterval(_batchScanTimer); _batchScanTimer = null; }
        if (qcProbeTimer) { clearInterval(qcProbeTimer); qcProbeTimer = null; }
        if (wsTimer) { clearInterval(wsTimer); wsTimer = null; }
    });

    if (document.readyState==='complete') init();
    else window.addEventListener('load', init);

})();
