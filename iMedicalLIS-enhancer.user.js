// ==UserScript==
// @name         iMedicalLIS 增强助手
// @namespace    lis-enhancer-local
// @version      6.28.4
// @description  报告审核增强 + 质控图面板 — 批量审核 + L-J质控图 + 质控数据编辑（纯本地运行，无任何上传）
// @author       LIS-Enhancer
// @match        http://10.0.29.100/iMedicalLIS/*
// @match        http://192.168.31.111:9111/iMedicalLIS/*
// @grant        GM_addStyle
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

    const WG = [
        { dr:'1', name:'临检', color:'#e74c3c', icon:'🩸' },
        { dr:'3', name:'生化', color:'#3498db', icon:'🧪' },
        { dr:'4', name:'免疫', color:'#2ecc71', icon:'🛡️' },
    ];
    const WG_MAP = {}; WG.forEach(w => WG_MAP[w.dr] = w);

    const REFRESH = 30000;
    const K = { au:'LIS_AuInfo_Persist', ent:'LIS_EntryInfo_Persist', pwd:'LIS_AuthPwd_Persist', tgt:'LIS_NavigateTarget', caPwd:'LIS_CAPwd_Persist', caAuth:'LIS_CAAuth_Persist' };

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
    const encPwd = p => { try { return btoa(unescape(encodeURIComponent(p))); } catch(e) { return p; } };
    const decPwd = e => { try { return decodeURIComponent(escape(atob(e))); } catch(e) { return e; } };
    const savePwd = p => { try { localStorage.setItem(K.pwd, encPwd(p)); } catch(e){} };
    const loadPwd = () => { try { const v=localStorage.getItem(K.pwd); return v?decPwd(v):''; } catch(e){ return ''; } };
    const saveCAPwd = p => { try { localStorage.setItem(K.caPwd, encPwd(p)); } catch(e){} };
    const loadCAPwd = () => { try { const v=localStorage.getItem(K.caPwd); return v?decPwd(v):''; } catch(e){ return ''; } };
    const saveCAAuth = () => { try { localStorage.setItem(K.caAuth, JSON.stringify({ time: Date.now(), wg: wgDR() })); } catch(e){} };
    const loadCAAuth = () => { try { const v=localStorage.getItem(K.caAuth); if(!v) return null; const o=JSON.parse(v); return o; } catch(e){ return null; } };
    const clearCAAuth = () => { try { localStorage.removeItem(K.caAuth); } catch(e){} };

    // ==================== 调试日志 ====================
    const DEBUG = true;
    const _dbgLog = [];
    const dbg = (...args) => {
        if (DEBUG) {
            const msg = args.map(a => typeof a === 'object' ? JSON.stringify(a) : String(a)).join(' ');
            console.log('[LIS]', msg);
            _dbgLog.push(msg);
        }
    };
    // 在页面底部显示调试面板（Alt+D 切换）
    function showDebugPanel() {
        let panel = document.getElementById('lis-debug-panel');
        if (panel) { panel.remove(); return; }
        panel = document.createElement('div');
        panel.id = 'lis-debug-panel';
        panel.style.cssText = 'position:fixed;bottom:0;left:0;right:0;z-index:999999;background:#1e1e1e;color:#0f0;font:12px monospace;padding:10px;max-height:40vh;overflow:auto';
        panel.innerHTML = '<b>LIS Debug Log (Alt+D 关闭)</b><br>' + _dbgLog.join('<br>');
        document.body.appendChild(panel);
    }

    async function fetchJ(u) { const r=await fetch(u,{credentials:'same-origin'}); if(!r.ok) throw new Error(r.status); return r.json(); }

    // 高亮搜索文本
    function highlightText(text, query) {
        if (!query || !text) return text || '';
        const q = query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const re = new RegExp('(' + q + ')', 'gi');
        return text.replace(re, '<span class="lis-highlight">$1</span>');
    }

    // ==================== 样式 ====================
    GM_addStyle(`
/* --- 浮动按钮 --- */
#lis-fab{position:fixed;bottom:80px;right:20px;z-index:99999;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;cursor:pointer;font-size:26px;box-shadow:0 4px 18px rgba(102,126,234,.55);transition:transform .3s,box-shadow .3s;display:flex;align-items:center;justify-content:center;user-select:none}
#lis-fab:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(102,126,234,.6)}
#lis-fab:active{cursor:grabbing}
#lis-fab-tip{position:fixed;bottom:84px;right:20px;z-index:99998;background:rgba(0,0,0,.8);color:#fff;padding:6px 12px;border-radius:6px;font-size:11px;pointer-events:none;opacity:0;transition:.3s;white-space:pre-line}
#lis-fab-tip.show{opacity:1}

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
#lis-ws{position:fixed!important;inset:0!important;z-index:100000!important;background:rgba(0,0,0,.55);/* backdrop-filter:blur(3px) removed for perf */;display:none}
#lis-ws.show{display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important}
#lis-ws-hd{background:#faf6ef;padding:8px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0!important;border-bottom:1px solid #e8ecf1;min-height:0}
#lis-ws-hd h3{margin:0;font-size:14px;white-space:nowrap;color:#2c3e50;font-weight:700}
#lis-ws-hd .ws-tabs{display:flex;gap:4px}
#lis-ws-hd .ws-tab{padding:4px 14px;border-radius:4px;border:1px solid rgba(255,255,255,.25);background:transparent;color:#fff;cursor:pointer;font-size:12px;font-weight:600;transition:.2s}
#lis-ws-hd .ws-tab.on{background:rgba(255,255,255,.2);border-color:#fff}
#lis-ws-hd .ws-filt{display:flex;gap:4px;flex-wrap:wrap}
#lis-ws-hd .ws-fb{padding:3px 10px;border-radius:3px;border:1px solid rgba(255,255,255,.3);background:transparent;color:#fff;cursor:pointer;font-size:11px;transition:.2s}
#lis-ws-hd .ws-fb.on{background:#fdf9f3;color:#2c3e50}
#lis-ws-hd .ws-search{padding:5px 10px;border:1px solid #dee2e6;border-radius:6px;font-size:12px;width:160px;outline:none;transition:.2s}
#lis-ws-hd .ws-acts{display:flex;gap:4px;margin-left:auto}
#lis-ws-hd .ws-acts button{padding:4px 10px;border:none;border-radius:6px;cursor:pointer;font-size:11px;font-weight:600;transition:.2s;opacity:.85}

/* --- 数据表 --- */
#lis-ws-body{flex:1!important;overflow-y:auto!important;overflow-x:hidden;background:#fff;font-family:'Microsoft YaHei','Segoe UI',sans-serif;min-height:0!important;position:relative;z-index:1}
#lis-ws-body table{width:100%;border-collapse:collapse;font-size:13px;height:fit-content}
#lis-ws-body thead{position:sticky;top:0;z-index:2}
#lis-ws-body th{background:linear-gradient(180deg,#3d566e,#2c3e50);color:#ecf0f1;padding:10px 12px;text-align:left;font-weight:600;white-space:nowrap;cursor:pointer;user-select:none;border-bottom:2px solid #1a252f;transition:background .2s}
#lis-ws-body th:hover{background:#4a6785}
#lis-ws-body th::after{content:' ⇅';font-size:10px;opacity:.5}
#lis-ws-body th.sort-asc::after{content:' ↑';opacity:1}
#lis-ws-body th.sort-desc::after{content:' ↓';opacity:1}
#lis-ws-body td{padding:8px 12px;border-bottom:1px solid #f0f0f0;white-space:nowrap;transition:background .15s}
#lis-ws-body tr{cursor:pointer;transition:background .2s}
#lis-ws-body tbody tr:nth-child(even){background:#fafbfc}
#lis-ws-body tbody tr:nth-child(odd){background:#fff}
#lis-ws-body tr:hover{background:#e8f4fd;box-shadow:inset 0 0 0 1px #b3d4fc}
#lis-ws-body tr.sel{background:#d4efdf;box-shadow:inset 0 0 0 2px #27ae60}
#lis-ws-body tr:hover{background:#e8f4fd;box-shadow:inset 0 0 0 1px #b3d4fc}
#lis-ws-body tr.active-row{background:#e3f2fd;box-shadow:inset 0 0 0 2px #2196f3;border-left:4px solid #1565c0}
#lis-ws-body tr.st-1{background:#fffde7;border-left:3px solid #f39c12}
#lis-ws-body tr.st-2{background:#e3f2fd;border-left:3px solid #2196f3}
#lis-ws-body tr.st-3{background:#e8f5e9;border-left:3px solid #4caf50}
#lis-ws-body tr.st-4{background:#f3e5f5;border-left:3px solid #9c27b0}
#lis-ws-body tr.st-5{background:#f5f5f5;color:#bbb;border-left:3px solid #9e9e9e}
.wg-tag{display:inline-block;padding:3px 8px;border-radius:4px;font-size:11px;font-weight:600;color:#fff;text-shadow:0 1px 2px rgba(0,0,0,.2)}
.st-tag{display:inline-block;padding:2px 8px;border-radius:4px;font-size:11px;font-weight:600}
.st-1t{background:#fff3e0;color:#e65100}.st-2t{background:#e3f2fd;color:#1565c0}.st-3t{background:#e8f5e9;color:#2e7d32}.st-4t{background:#f3e5f5;color:#7b1fa2}.st-5t{background:#eeeeee;color:#9e9e9e}
.st-0t{background:#e0f7fa;color:#00695c}
.stars{color:#f39c12;font-size:12px}
.lis-highlight{background:#fff176;border-radius:2px;padding:0 2px}

/* --- 底部 --- */
#lis-ws-ft{background:#ecf0f1;padding:6px 20px;display:flex;align-items:center;justify-content:space-between;font-size:12px;color:#7f8c8d;flex-shrink:0!important}

/* --- 仪器标签栏 --- */
#lis-ws-tabs{background:#f5f0e8;padding:6px 16px;display:flex;flex-direction:column;gap:0;flex-shrink:0!important;overflow-x:auto;scrollbar-width:none;position:relative;z-index:3;border-bottom:1px solid #e8ecf1}
#lis-ws-tabs::-webkit-scrollbar{display:none}
.ws-wg-row{display:flex;align-items:center;gap:6px;padding-bottom:5px;border-bottom:1px solid #e8ecf1}
.ws-mach-row{display:flex;align-items:center;gap:5px;padding-top:5px;overflow-x:auto;scrollbar-width:none}
.ws-mach-row::-webkit-scrollbar{display:none}
.ws-wg-tab{padding:4px 14px;border-radius:16px;border:1px solid #dee2e6;background:#fff;color:#555;cursor:pointer;font-size:12px;font-weight:600;transition:.2s;white-space:nowrap;display:flex;align-items:center;gap:5px}
.ws-wg-tab:hover{background:#eaf2fb;border-color:#b3d4fc;color:#2c3e50}
.ws-wg-tab.on{background:#3498db;border-color:#3498db;color:#fff;font-weight:700}
.ws-mach-tab{padding:3px 12px;border-radius:14px;border:1px solid #dee2e6;background:#fff;color:#666;cursor:pointer;font-size:11px;font-weight:500;transition:.2s;white-space:nowrap;display:flex;align-items:center;gap:4px}
.ws-mach-tab:hover{background:#eaf2fb;border-color:#b3d4fc;color:#2c3e50}
.ws-mach-tab.on{background:#2c3e50;border-color:#2c3e50;color:#fff;font-weight:600}
.ws-mach-tab .mach-cnt{background:#eef1f5;color:#666;border-radius:10px;padding:0 6px;font-size:9px;min-width:16px;text-align:center;line-height:1.6}
.ws-mach-tab.on .mach-cnt{background:rgba(255,255,255,.25);color:#fff}

/* --- 分类标签栏 --- */
#lis-ws-bar{background:#faf6ef;padding:5px 16px;display:flex;align-items:center;gap:6px;border-bottom:1px solid #e8ecf1;flex-shrink:0!important;font-size:12px;flex-wrap:wrap;position:relative;z-index:3}
.cat-tab{padding:4px 12px;border-radius:14px;border:1px solid #dee2e6;background:#fff;cursor:pointer;font-size:11px;font-weight:600;transition:.2s;white-space:nowrap;display:flex;align-items:center;gap:4px}
.cat-tab:hover{border-color:#3498db;background:#eaf2f8}
.cat-tab.on{border-color:#3498db;background:linear-gradient(135deg,#3498db,#2980b9);color:#fff;box-shadow:0 2px 8px rgba(52,152,219,.25)}
.cat-tab .cat-cnt{border-radius:8px;padding:0 6px;font-size:10px;min-width:16px;text-align:center;line-height:1.6}
.cat-tab.on .cat-cnt{background:rgba(255,255,255,.25);color:#fff}
.cat-tab:not(.on) .cat-cnt{background:#f0f0f0;color:#666}
.cat-tab.cat-normal .cat-cnt{background:#e8f5e9;color:#2e7d32}
.cat-tab.cat-abnormal .cat-cnt{background:#fce4ec;color:#c62828}
.cat-tab.cat-incomplete .cat-cnt{background:#fff3e0;color:#e65100}
.cat-tab.cat-pending .cat-cnt{background:#e3f2fd;color:#1565c0}
.cat-sep{width:1px;height:24px;background:#dee2e6;margin:0 4px}
.cat-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.cat-stats{color:#7f8c8d;font-size:11px}

/* --- 一键批审横幅 --- */
.ws-normal-banner{background:linear-gradient(135deg,#e8f5e9,#c8e6c9);border:1px solid #a5d6a7;border-radius:8px;padding:12px 20px;margin:12px 16px;display:flex;align-items:center;gap:12px;flex-shrink:0}
.ws-normal-banner .nb-text{font-size:14px;font-weight:600;color:#2e7d32;flex:1}
.ws-normal-banner .nb-btn,.nb-btn{padding:8px 24px;border:none;border-radius:6px;background:linear-gradient(135deg,#27ae60,#2ecc71);color:#fff;font-size:14px;font-weight:700;cursor:pointer;box-shadow:0 3px 10px rgba(39,174,96,.3);transition:.2s;white-space:nowrap}
.ws-normal-banner .nb-btn:hover,.nb-btn:hover{transform:translateY(-1px);box-shadow:0 5px 15px rgba(39,174,96,.4)}
.ws-normal-banner .nb-btn:active,.nb-btn:active{transform:translateY(0)}

/* --- 异常标本卡片 --- */
.ws-abnormal-list{padding:8px 12px;display:flex;flex-direction:column;gap:5px;overflow-y:auto;flex:1}
.ws-abnormal-card{background:#fff;border:1px solid #e0e0e0;border-left:3px solid #e74c3c;border-radius:5px;padding:8px 12px;cursor:pointer;transition:.15s;display:flex;align-items:center;gap:10px}
.ws-abnormal-card:hover{background:#f8f9fa;border-color:#bbb}
.ws-abnormal-card.focused{border-left:4px solid #1565c0;background:#e3f2fd;box-shadow:0 2px 8px rgba(33,150,243,.2)}
.ws-abnormal-card.has-critical{border-left:3px solid #c62828;background:#fff5f5}
.ws-abnormal-card.has-critical.focused{border-left:4px solid #c62828;background:#ffebee;box-shadow:0 2px 8px rgba(198,40,40,.2)}
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
.ws-abnormal-hint{background:#e3f2fd;border-radius:5px;padding:6px 12px;margin:0 12px;font-size:12px;color:#1565c0;display:flex;align-items:center;gap:6px}
.ws-abnormal-hint kbd{background:#fff;border:1px solid #bbdefb;border-radius:3px;padding:1px 5px;font-size:11px;font-family:monospace}

/* --- 不完整提示 --- */
.ws-incomplete-banner{background:#fff3e0;border:1px solid #ffe0b2;border-radius:8px;padding:10px 20px;margin:12px 16px;font-size:13px;color:#e65100;font-weight:600}

/* --- 分类加载中 --- */
.ws-category-loading{text-align:center;padding:40px;color:#999;font-size:14px}
.ws-category-loading .cat-prog{font-size:12px;color:#bbb;margin-top:8px}

/* --- 确保内容可滚动 --- */
#lis-ws-body::-webkit-scrollbar{width:10px}
#lis-ws-body::-webkit-scrollbar-track{background:#f1f1f1;border-radius:5px}
#lis-ws-body::-webkit-scrollbar-thumb{background:#888;border-radius:5px}
#lis-ws-body::-webkit-scrollbar-thumb:hover{background:#555}
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


/* --- 质控面板 v7 --- */
#lis-qc-fab{position:fixed;bottom:152px;right:20px;z-index:99999;width:56px;height:56px;border-radius:50%;background:linear-gradient(135deg,#00b894,#00cec9);color:#fff;border:none;cursor:pointer;font-size:11px;font-weight:700;box-shadow:0 4px 14px rgba(0,184,148,.5);transition:transform .3s,box-shadow .3s;display:flex;align-items:center;justify-content:center;flex-direction:column;line-height:1.1;user-select:none}
#lis-qc-fab:hover{transform:scale(1.1);box-shadow:0 6px 20px rgba(0,184,148,.6)}
#lis-qc-fab .fab-icon{font-size:20px}
#lis-qc-fab .fab-label{font-size:8px;letter-spacing:.5px}
#lis-qc-panel{position:fixed!important;inset:0!important;z-index:100005!important;background:#f5f0e8;display:none;flex-direction:column;font-family:'Microsoft YaHei','Segoe UI',sans-serif}
#lis-qc-panel.show{display:flex!important}
.qc-toolbar{background:#2c3e50;color:#fff;padding:8px 16px;display:flex;align-items:center;gap:10px;flex-shrink:0}
.qc-toolbar h3{margin:0;font-size:14px;font-weight:700;white-space:nowrap}
.qc-toolbar .qc-tb-sep{width:1px;height:20px;background:rgba(255,255,255,.3)}
.qc-toolbar label{font-size:11px;color:rgba(255,255,255,.7);white-space:nowrap}
.qc-toolbar select,.qc-toolbar input[type=date]{padding:4px 8px;border:1px solid rgba(255,255,255,.2);border-radius:4px;font-size:12px;background:rgba(255,255,255,.1);color:#fff;outline:none}
.qc-toolbar select option{background:#2c3e50;color:#fff}
.qc-toolbar input[type=date]::-webkit-calendar-picker-indicator{filter:invert(1)}
.qc-toolbar .qc-tb-btn{padding:4px 12px;border:none;border-radius:4px;font-size:11px;font-weight:600;cursor:pointer;transition:.15s}
.qc-toolbar .qc-tb-btn:hover{filter:brightness(1.15)}
.qc-toolbar .qc-tb-btn.btn-primary{background:#3498db;color:#fff}
.qc-toolbar .qc-tb-btn.btn-success{background:#27ae60;color:#fff}
.qc-toolbar .qc-tb-btn.btn-warning{background:#e67e22;color:#fff}
.qc-toolbar .qc-tb-close{margin-left:auto;background:none;border:none;color:rgba(255,255,255,.7);cursor:pointer;font-size:18px;padding:4px 8px;border-radius:4px}
.qc-toolbar .qc-tb-close:hover{color:#fff;background:rgba(255,255,255,.1)}
.qc-main{flex:1;display:flex;overflow:hidden;min-height:0}
.qc-sidebar{width:240px;min-width:200px;background:#fff;border-right:1px solid #e0e0e0;display:flex;flex-direction:column;flex-shrink:0}
.qc-sidebar-hd{padding:10px 12px;border-bottom:1px solid #eee;display:flex;align-items:center;gap:6px}
.qc-sidebar-hd input{flex:1;padding:5px 8px;border:1px solid #ddd;border-radius:4px;font-size:12px;outline:none}
.qc-sidebar-hd input:focus{border-color:#3498db}
.qc-item-list{flex:1;overflow-y:auto;padding:4px 0}
.qc-item{padding:8px 12px;cursor:pointer;border-left:3px solid transparent;transition:.15s;font-size:12px}
.qc-item:hover{background:#f0f7ff}
.qc-item.active{background:#e3f2fd;border-left-color:#3498db;font-weight:600}
.qc-item .qi-name{font-weight:600;color:#2c3e50;margin-bottom:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qc-item .qi-mat{font-size:11px;color:#888;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qc-item .qi-level{font-size:10px;color:#fff;background:#9b59b6;border-radius:3px;padding:1px 5px;display:inline-block;margin-top:2px}
.qc-content{flex:1;display:flex;flex-direction:column;min-width:0;overflow:hidden}
.qc-chart-wrap{flex:1;position:relative;min-height:300px;background:#fff;border-bottom:1px solid #e0e0e0}
.qc-chart-wrap canvas{display:block;width:100%;height:100%}
.qc-chart-tooltip{position:absolute;background:rgba(44,62,80,.92);color:#fff;padding:8px 12px;border-radius:6px;font-size:11px;pointer-events:none;display:none;z-index:10;white-space:nowrap;box-shadow:0 2px 8px rgba(0,0,0,.3)}
.qc-chart-tooltip .tt-title{font-weight:700;margin-bottom:4px}
.qc-chart-tooltip .tt-row{display:flex;justify-content:space-between;gap:12px}
.qc-stats-bar{display:flex;gap:16px;padding:8px 16px;background:#f8f9fa;border-bottom:1px solid #e0e0e0;flex-shrink:0;flex-wrap:wrap;align-items:center}
.qc-stats-bar .stat-item{font-size:11px;color:#555;display:flex;align-items:center;gap:4px}
.qc-stats-bar .stat-item b{color:#2c3e50}
.qc-stats-bar .stat-item .stat-label{color:#999}
.qc-data-wrap{height:200px;min-height:120px;overflow:auto;flex-shrink:0;background:#fff}
.qc-data-wrap table{width:100%;border-collapse:collapse;font-size:12px}
.qc-data-wrap th{position:sticky;top:0;background:#3d566e;color:#ecf0f1;padding:6px 10px;text-align:left;font-weight:600;white-space:nowrap;z-index:1}
.qc-data-wrap td{padding:5px 10px;border-bottom:1px solid #f0f0f0;white-space:nowrap}
.qc-data-wrap tbody tr:hover{background:#e8f4fd}
.qc-data-wrap tbody tr:nth-child(even){background:#fafbfc}
.qc-data-wrap td[contenteditable=true]{background:#fff9c4;outline:2px solid #f39c12;border-radius:2px}
.qc-data-wrap .status-ok{color:#27ae60;font-weight:600}
.qc-data-wrap .status-warn{color:#e67e22;font-weight:600}
.qc-data-wrap .status-loss{color:#e74c3c;font-weight:600}
.qc-data-wrap .status-ns{color:#999}
.qc-level-bar{display:flex;gap:4px;align-items:center;padding:0 12px}
.qc-level-btn{padding:3px 10px;border:1px solid rgba(255,255,255,.3);border-radius:3px;background:transparent;color:rgba(255,255,255,.7);cursor:pointer;font-size:11px;transition:.15s}
.qc-level-btn.on{background:rgba(255,255,255,.2);color:#fff;border-color:#fff}
.qc-level-btn:hover{color:#fff}
.qc-empty-msg{text-align:center;padding:60px 20px;color:#95a5a6;font-size:14px}
.qc-empty-msg .ico{font-size:48px;margin-bottom:12px;display:block}
.qc-loading{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;background:rgba(255,255,255,.8);z-index:5;font-size:13px;color:#666}
.qc-iframe-fallback{flex:1;border:none;width:100%;height:100%}
    
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
  #lis-ws-hd .ws-search{width:140px}
  #lis-ws-bar{padding:4px 12px}
}
@media(max-width:900px){
  #lis-ws-hd h3{font-size:14px}
  #lis-ws-hd .ws-tab{padding:3px 8px;font-size:11px}
  #lis-ws-hd .ws-fb{padding:2px 6px;font-size:10px}
  #lis-ws-body th,#lis-ws-body td{padding:6px 8px}
  #lis-ws-body{font-size:12px}
}
@media(max-width:700px){
  #lis-ws-hd{flex-direction:column;align-items:flex-start;padding:6px 10px}
  #lis-ws-hd .ws-acts{margin-left:0;margin-top:8px}
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

    function initAuth() {
        // 恢复
        restoreAuth();
        // 拦截 setItem
        const orig = sessionStorage.setItem.bind(sessionStorage);
        sessionStorage.setItem = function(k,v) {
            orig(k,v);
            if (k==='AuInfo')   { try { localStorage.setItem(K.au, v); } catch(e){} }
            if (k==='EntryInfo'){ try { localStorage.setItem(K.ent, v); } catch(e){} }
        };
        // 拦截 clear
        const origC = sessionStorage.clear.bind(sessionStorage);
        sessionStorage.clear = function() {
            let a=null,e=null;
            try { a=sessionStorage.getItem('AuInfo'); e=sessionStorage.getItem('EntryInfo'); } catch(x){}
            origC();
            try { if(a) orig('AuInfo',a); if(e) orig('EntryInfo',e); } catch(x){}
        };
        setInterval(restoreAuth, 3000);

        // 密码自动填充
        if (isAuthPage()) fillAuthPage();
        else if (isReportPage()) fillBatchPage();

        dbg('认证模块就绪');
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
        const tryFill = () => {
            const pwd = loadPwd();
            if (!pwd) return false;
            const inputs = document.querySelectorAll('input[type="password"], input[onfocus*="password"]');
            for (const inp of inputs) {
                if (!inp.value) {
                    inp.value = pwd;
                    inp.type = 'password';
                    inp.dispatchEvent(new Event('input',{bubbles:true}));
                    inp.dispatchEvent(new Event('change',{bubbles:true}));
                }
                if (!inp._lisListen) {
                    inp._lisListen = true;
                    inp.addEventListener('change', () => { if(inp.value) savePwd(inp.value); });
                    inp.addEventListener('keydown', e => { if(e.keyCode===13 && inp.value) savePwd(inp.value); });
                }
            }
            return inputs.length > 0;
        };
        if (!tryFill()) {
            const ob = new MutationObserver(() => { if(tryFill()) ob.disconnect(); });
            ob.observe(document.body, {childList:true, subtree:true});
            setTimeout(() => ob.disconnect(), 10000);
            [500,1000,2000].forEach(t => setTimeout(tryFill, t));
        }
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
        setInterval(() => {
            const f = document.getElementById('text_AuthUserLoginPasssword');
            if (f && f.offsetParent!==null && !f._lisFilled) fillBatchPwd();
        }, 2000);
    }

    function fillBatchPwd() {
        const pwd = loadPwd();
        if (!pwd) return;
        const f = document.getElementById('text_AuthUserLoginPasssword');
        if (f && !f.value && f.offsetParent!==null) {
            f.value = pwd; f.type='password';
            f.dispatchEvent(new Event('input',{bubbles:true}));
            f._lisFilled = true;
        }
        if (f && !f._lisListen) {
            f._lisListen = true;
            f.addEventListener('change', () => { if(f.value) savePwd(f.value); });
            f.addEventListener('keydown', e => { if(e.keyCode===13 && f.value) savePwd(f.value); });
        }
    }

    function fillIframe(ifr) {
        try {
            const doc = ifr.contentDocument;
            if (!doc) return;
            const pwd = loadPwd();
            if (!pwd) return;
            doc.querySelectorAll('input[type="password"], input[onfocus*="password"]').forEach(inp => {
                if (!inp.value) { inp.value=pwd; inp.type='password'; inp.dispatchEvent(new Event('input',{bubbles:true})); }
                if (!inp._lisListen) {
                    inp._lisListen = true;
                    inp.addEventListener('change', () => { if(inp.value) savePwd(inp.value); });
                    inp.addEventListener('keydown', e => { if(e.keyCode===13 && inp.value) savePwd(inp.value); });
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
        localStorage.setItem(LOGIN_WG_KEY, dr);

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
    //  模块 C：一体化工作台（核心）
    // ============================================================
    let wsData = [];      // 加载的标本数据
    let wsMachines = [];  // 当前加载的仪器列表
    let wsActiveMachine = ''; // 当前选中的仪器 DR, ''=全部
    let wsActiveWG = ''; // 当前选中的工作组 DR, ''=全部工作组
    let wsCategory = 'normal'; // 当前分类: 'normal'/'abnormal'/'incomplete'/'all'
    let wsClassifiedCache = {}; // 分类缓存 {[reportDR]: {status, items, row, reportDR}}
    let wsClassifying = false;  // 分类进行中标记
    let wsAbnormalIndex = -1;   // 异常视图当前焦点索引
    let wsChecked = new Set(); // 选中的 ReportDR 集合
    let wsSort = { field:'AcceptDT', asc:false };
    let wsTimer = null;
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

    function invalidateCaches() {
        _filteredCache = null;
        _filteredCacheKey = '';
        _countsCache = null;
        _countsCacheKey = '';
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

    function detailLRUSet(key, val) {
        if (_detailLRU.has(key)) _detailLRU.delete(key);
        if (_detailLRU.size >= _DETAIL_LRU_MAX) {
            const first = _detailLRU.keys().next().value;
            _detailLRU.delete(first);
        }
        _detailLRU.set(key, val);
    }

    // 打开工作台
    function openWS() {
        // 防重入：如果已打开，不做任何操作
        const wsEl = $('#lis-ws');
        if (wsEl.classList.contains('show')) { dbg('[WS] openWS 被调用但已打开，跳过'); return; }
        dbg('[WS] openWS 被调用');
        console.trace('[WS] openWS 调用栈');

        wsActiveWG = wgDR() || ''; // 默认显示当前工作组，无法获取时显示全部
        wsActiveMachine = '';
        wsCategory = 'normal';
        wsClassifiedCache = {};
        wsClassifying = false;
        wsAbnormalIndex = -1;
        wsChecked.clear();
        wsData = [];
        wsMachines = [];
        wsMachineCounts = {};
        wsEl.classList.add('show');
        // 强制 flex 布局（LIS 系统 CSS 会覆盖）
        wsEl.style.cssText = 'display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important;position:fixed!important;inset:0!important;z-index:100000!important';
        document.body.style.overflow = 'hidden';
        renderWSHeader();
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
        loadWSData();
        startWSRefresh();
    }

    function closeWS() {
        const wsEl = $('#lis-ws');
        if (!wsEl.classList.contains('show')) { dbg('[WS] closeWS 被调用但未打开，跳过'); return; }
        dbg('[WS] closeWS 被调用');
        console.trace('[WS] closeWS 调用栈');
        wsEl.classList.remove('show');
        wsEl.style.cssText = 'display:none!important';
        document.body.style.overflow = '';
        stopWSRefresh();
    }

    function startWSRefresh() { stopWSRefresh(); wsTimer = setInterval(loadWSData, REFRESH); }
    function stopWSRefresh() { if(wsTimer){clearInterval(wsTimer);wsTimer=null;} }

    // --- 加载数据 ---
    async function loadWSData() {
        if (wsLoading) return;
        wsLoading = true;
        const qi = document.getElementById('lis-qi');
        if (qi) qi.textContent = '加载中...';

        const curDR = wgDR();
        const targetWGs = WG; // 加载所有工作组的数据
        clearMachineCache(); // 每次刷新清空机器缓存

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
            allData.push(...r.data);
            allMachines.push(...r.machines);
        }

        wsData = allData;
        wsMachines = allMachines;
        calcMachineCounts();

        wsLoading = false;
        if (qi) qi.textContent = `${wsData.length} 条 | ${new Date().toLocaleTimeString()}`;
        invalidateCaches();
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
        classifyAllSpecimens();
        
        // 更新CA认证状态
        updateCAStatus();
    }

    const _mcCache = {};
    function clearMachineCache() { for (const k in _mcCache) delete _mcCache[k]; }
    async function loadMachines(dr) {
        if (dr in _mcCache) return _mcCache[dr];
        const data = await fetchJ(WGM + '?Method=FindWGMbyWorkGroup&WorkGroupDR=' + dr);
        const rows = (data && data.rows) ? data.rows : (Array.isArray(data) ? data : []);
        _mcCache[dr] = rows;
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
            ReportDR: r.Labno || r.RegNo || ('P_' + Math.random().toString(36).substr(2, 8)),
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

            const status = String(r.Status || r.ReportStatus || '');
            if (status === '3' || status === '4') return; // 已审核不计入
            if (status === '0') return; // 待排样不计入结果不完整
            const complete = String(r.IsComplete || '');
            if (complete !== '1') {
                wsMachineCounts[mdr].incomplete++;
                wsMachineCounts['_all'].incomplete++;
                return;
            }
            // 完整标本，检查分类缓存
            const cached = wsClassifiedCache[r.ReportDR];
            if (cached && (cached.status === 'ABNORMAL' || cached.status === 'CRITICAL')) {
                wsMachineCounts[mdr].abnormalReady++;
                wsMachineCounts['_all'].abnormalReady++;
            } else {
                wsMachineCounts[mdr].normalReady++;
                wsMachineCounts['_all'].normalReady++;
            }
        });
    }

    // --- 过滤 & 排序 ---
    function filteredData() {
        // 读取当前搜索框值（不能用旧的 wsSearchQuery）
        const _q = ($('#lis-ws-search') || {}).value || '';
        // 缓存检查
        const ck = wsActiveWG + '|' + wsActiveMachine + '|' + wsCategory + '|' + _q + '|' + (wsSort.field + wsSort.asc);
        if (_filteredCache && _filteredCacheKey === ck) return _filteredCache;
        let d = wsData;
        // 工作组过滤
        if (wsActiveWG) d = d.filter(r => r._wg === wsActiveWG);
        // 仪器过滤
        if (wsActiveMachine) d = d.filter(r => r._mdr === wsActiveMachine);
        // 分类过滤
        if (wsCategory === 'normal') {
            d = d.filter(r => {
                const status = String(r.Status || r.ReportStatus || '');
                if (status === '3' || status === '4') return false;
                const complete = String(r.IsComplete || '');
                if (complete !== '1') return false;
                const cached = wsClassifiedCache[r.ReportDR];
                return !cached || cached.status === 'NORMAL';
            });
        } else if (wsCategory === 'abnormal') {
            d = d.filter(r => {
                const status = String(r.Status || r.ReportStatus || '');
                if (status === '3' || status === '4') return false;
                const complete = String(r.IsComplete || '');
                if (complete !== '1') return false;
                const cached = wsClassifiedCache[r.ReportDR];
                return cached && (cached.status === 'ABNORMAL' || cached.status === 'CRITICAL');
            });
        } else if (wsCategory === 'incomplete') {
            d = d.filter(r => {
                const status = String(r.Status || r.ReportStatus || '');
                if (status === '3' || status === '4') return false;
                if (status === '0') return false; // 待排样不显示在结果不完整中
                const complete = String(r.IsComplete || '');
                if (complete !== '1') return true;
                // IsComplete='1' 但分类为 UNCERTAIN 的也算不完整（与 renderWSCategoryBar 计数逻辑一致）
                const cached = wsClassifiedCache[r.ReportDR];
                if (!cached) return false; // 未分类的不算不完整
                return cached.status !== 'NORMAL' && cached.status !== 'ABNORMAL' && cached.status !== 'CRITICAL';
            });
        } else if (wsCategory === 'pending') {
            d = d.filter(r => {
                const status = String(r.Status || r.ReportStatus || '');
                // 待排样：Status = '0'
                return status === '0';
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
        // 排序
        const {field, asc} = wsSort;
        d.sort((a,b) => {
            const va = (a[field]||'').toString(), vb = (b[field]||'').toString();
            return asc ? va.localeCompare(vb,'zh') : vb.localeCompare(va,'zh');
        });

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

            const status = String(r.Status || r.ReportStatus || '');
            if (status === '0') { pendingCount++; return; }
            if (status === '3' || status === '4') return;
            const complete = String(r.IsComplete || '');

            // 工作组的 normalReady/abnormalReady
            if (wgCounts[wg]) {
                if (complete !== '1') { wgCounts[wg].incomplete++; }
                else {
                    const cached = wsClassifiedCache[r.ReportDR];
                    if (cached && (cached.status === 'ABNORMAL' || cached.status === 'CRITICAL')) wgCounts[wg].abnormalReady++;
                    else if (cached && cached.status !== 'NORMAL') wgCounts[wg].incomplete++; // UNCERTAIN 算不完整
                    else wgCounts[wg].normalReady++;
                }
            }
            // 仪器的 normalReady/abnormalReady/incomplete
            if (complete !== '1') {
                machCounts[mdr].incomplete++;
                machCounts['_all'].incomplete++;
                incompleteCount++;
                return;
            }
            const cached = wsClassifiedCache[r.ReportDR];
            if (cached && (cached.status === 'ABNORMAL' || cached.status === 'CRITICAL')) {
                machCounts[mdr].abnormalReady++;
                machCounts['_all'].abnormalReady++;
                abnormalCount++;
            } else if (cached && cached.status !== 'NORMAL') {
                // UNCERTAIN 算不完整（与 renderWSCategoryBar 计数逻辑一致）
                machCounts[mdr].incomplete++;
                machCounts['_all'].incomplete++;
                incompleteCount++;
            } else {
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
            <h3>🔬 工作台</h3>
            <input type="text" class="ws-search" id="lis-ws-search" placeholder="🔍 搜索姓名/检验号/流水号..." />
            <div class="ws-acts">
                <button id="lis-ws-ca" style="background:#9b59b6;color:#fff;border-radius:6px" title="CA认证">🔑 CA认证</button>
                <button id="lis-ws-qc" style="background:#00b894;color:#fff;border-radius:6px" title="质控面板">📊</button>
                <button id="lis-ws-refresh" style="background:#3498db;color:#fff;border-radius:6px">🔄</button>
                <button id="lis-ws-pwd" style="background:#f39c12;color:#fff;border-radius:6px" title="密码">🔐</button>
                <button id="lis-ws-close" style="background:#e74c3c;color:#fff;border-radius:6px">✕</button>
            </div>`;

        document.getElementById('lis-ws-ca').addEventListener('click', handleCAAuth);
        
        // 初始检查CA状态
        updateCAStatus();
        document.getElementById('lis-ws-qc').addEventListener('click', () => {
            closeWS();
            if (!_qcPanelEl) createQCPanel();
            openQCPanel();
        });
        document.getElementById('lis-ws-refresh').addEventListener('click', () => {
            dbg('刷新按钮被点击');
            loadWSData();
        });
        document.getElementById('lis-ws-close').addEventListener('click', closeWS);
        document.getElementById('lis-ws-pwd').addEventListener('click', openPwdDlg);
        let st;
        document.getElementById('lis-ws-search').addEventListener('input', () => { clearTimeout(st); st=setTimeout(()=>renderWSTable(),200); });
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
            const status = String(r.Status || r.ReportStatus || '');
            if (status === '3' || status === '4') return;
            const complete = String(r.IsComplete || '');
            if (complete !== '1') return;
            const cached = wsClassifiedCache[r.ReportDR];
            if (cached && (cached.status === 'ABNORMAL' || cached.status === 'CRITICAL')) wgCounts[wg].abnormalReady++;
            else wgCounts[wg].normalReady++;
        });

        // 第一行：工作组标签
        let h = '<div class="ws-wg-row">';
        WG.forEach(w => {
            const c = wgCounts[w.dr] || {total:0};
            h += `<button class="ws-wg-tab ${wsActiveWG===w.dr?'on':''}" data-wg="${w.dr}">
                ${w.icon} ${w.name} <span class="mach-cnt">${c.total}</span>
            </button>`;
        });
        // 全部工作组
        const allTotal = WG.reduce((s,w) => s + (wgCounts[w.dr]?.total||0), 0);
        h += `<button class="ws-wg-tab ${!wsActiveWG?'on':''}" data-wg="">
            全部 <span class="mach-cnt">${allTotal}</span>
        </button>`;
        h += '</div>';

        // 第二行：仪器标签（仅显示选中工作组的仪器）
        h += '<div class="ws-mach-row">';
        // 全部仪器按钺（按当前工作组筛选）
        let ac = mc['_all'] || {total:0, normalReady:0, abnormalReady:0, incomplete:0};
        if (wsActiveWG) {
            ac = {total:0, normalReady:0, abnormalReady:0, incomplete:0};
            wsMachines.filter(m => m._wg === wsActiveWG).forEach(m => {
                const mc2 = mc[m.RowID] || {total:0, normalReady:0, abnormalReady:0, incomplete:0};
                ac.total += mc2.total; ac.normalReady += mc2.normalReady;
                ac.abnormalReady += mc2.abnormalReady; ac.incomplete += mc2.incomplete;
            });
        }
        h += `<button class="ws-mach-tab ${!wsActiveMachine?'on':''}" data-m="">
            全部仪器 <span class="mach-cnt">${ac.total}</span>
        </button>`;

        // 筛选当前工作组的仪器
        const wgMachines = wsMachines.filter(m => !wsActiveWG || m._wg === wsActiveWG);
        wgMachines.forEach(m => {
            const c = mc[m.RowID] || {total:0, normalReady:0, abnormalReady:0, incomplete:0};
            h += `<button class="ws-mach-tab ${wsActiveMachine===m.RowID?'on':''}" data-m="${m.RowID}">
                ${m.CName||m.Name} <span class="mach-cnt">${c.total}</span>
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
            const status = String(r.Status || r.ReportStatus || '');
            // 待排样：Status = '0'
            if (status === '0') { pendingCount++; return; } // 待排样单独分类
            if (status === '3' || status === '4') return; // 已审核的不算
            const complete = String(r.IsComplete || '');
            if (complete !== '1') { incompleteCount++; return; }
            // 完整的标本，检查分类缓存
            const cached = wsClassifiedCache[r.ReportDR];
            if (cached) {
                if (cached.status === 'NORMAL') normalCount++;
                else if (cached.status === 'ABNORMAL' || cached.status === 'CRITICAL') abnormalCount++;
                else incompleteCount++; // UNCERTAIN 也算不完整
            } else {
                // 未分类的暂时算正常可审
                normalCount++;
            }
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

        // 分类标签事件
        bar.querySelectorAll('.cat-tab').forEach(b => b.addEventListener('click', () => {
            invalidateCaches();
            wsCategory = b.dataset.cat;
            wsAbnormalIndex = -1;
            // 不清空 wsChecked，保留用户勾选
            renderWSCategoryBar();
            renderWSTable();
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

    function renderWSTable() {
        const body = $('#lis-ws-body');
        // 强制 flex 和滚动（LIS 系统 CSS 会覆盖）
        body.style.cssText = 'flex:1!important;overflow-y:auto!important;min-height:0!important;position:relative';
        // 移除旧的异常视图键盘监听
        if (_abnormalKeyHandler) {
            document.removeEventListener('keydown', _abnormalKeyHandler);
            _abnormalKeyHandler = null;
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
            h += `<tr class="${wsChecked.has(r.ReportDR)?'sel':''}" data-i="${i}" data-rdr="${r.ReportDR||''}">`;
            h += `<td><input type="checkbox" class="lis-ws-ck" data-rdr="${r.ReportDR||''}" ${ck} /></td>`;
            h += `<td>${highlightText(r._mn||'', wsSearchQuery)}</td>`;
            h += `<td>${highlightText(r.PatName||'', wsSearchQuery)}</td>`;
            h += `<td><b>${highlightText(r.Labno||'', wsSearchQuery)}</b></td>`;
            h += `<td>${highlightText(r.TestSetDesc||'', wsSearchQuery)}</td>`;
            h += `<td>${r.AcceptDT||''}</td>`;
            h += '</tr>';
        });
        h += '</tbody></table>';
        body.innerHTML = h;

        // 一键批审按钮
        const batchBtn = document.getElementById('lis-norm-batch');
        if (batchBtn) {
            batchBtn.addEventListener('click', () => {
                const formatted = data.map(r => ({ status: 'NORMAL', items: [], row: r, reportDR: r.ReportDR }));
                confirmAndBatchAudit(formatted);
            });
        }

        _bindTableEvents(body, data, 'normal');
    }

    // --- 异常待审视图（卡片式）---
    function renderAbnormalView(data, body) {
        if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) wsAbnormalIndex = 0;

        let h = `<div class="ws-abnormal-hint">
            <kbd>Enter</kbd> 审核 <kbd>↑↓</kbd> 切换 <kbd>点击</kbd> 详情
        </div>`;
        h += '<div class="ws-abnormal-list">';

        data.forEach((r, i) => {
            const cached = wsClassifiedCache[r.ReportDR];
            const items = cached ? cached.items : [];
            const abnormalItems = items.filter(it => it.status !== 'NORMAL');
            const hasCritical = items.some(it => it.status === 'CRITICAL');
            const hasInfectionWarning = cached && cached.infectionWarning;
            const focused = i === wsAbnormalIndex ? ' focused' : '';

            h += `<div class="ws-abnormal-card${focused}${hasCritical ? ' has-critical' : ''}${hasInfectionWarning ? ' has-infection-warning' : ''}" data-i="${i}" data-rdr="${r.ReportDR||''}">`;
            h += `<span class="ab-card-name">${highlightText(r.PatName||'', wsSearchQuery)}</span>`;
            h += `<span class="ab-card-no">${highlightText(r.Labno||'', wsSearchQuery)}</span>`;
            h += `<span class="ab-card-test">${highlightText(r._mn||'', wsSearchQuery)}</span>`;
            h += '<div class="ab-card-items">';
            abnormalItems.forEach(it => {
                let cls = 'uncertain';
                if (it.status === 'CRITICAL') cls = 'critical';
                else if (it.status === 'HIGH') cls = 'high';
                else if (it.status === 'LOW') cls = 'low';
                else if (it.status === 'ABNORMAL') cls = 'abnormal';
                h += `<span class="ab-card-item ${cls}">${it.name} ${it.result}${it.unit||''}</span>`;
            });
            if (hasInfectionWarning) {
                h += `<span class="ab-card-item infection-warning">⚠ ${cached.infectionWarning}</span>`;
            }
            if (abnormalItems.length === 0 && !hasInfectionWarning) {
                h += '<span class="ab-card-item uncertain">异常</span>';
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
                const i = parseInt(card.dataset.i);
                if (i < 0 || i >= data.length) return;
                // 更新聚焦状态
                const cards = document.querySelectorAll('.ws-abnormal-card');
                if (cards[wsAbnormalIndex]) cards[wsAbnormalIndex].classList.remove('focused');
                wsAbnormalIndex = i;
                if (cards[wsAbnormalIndex]) cards[wsAbnormalIndex].classList.add('focused');
                openDetailPanel(data[i], 'abnormal', i);
            });
        });

        // 键盘导航
        _abnormalKeyHandler = e => {
            if (wsCategory !== 'abnormal') return;
            // 详情面板打开时不处理键盘（由详情面板自己的处理器处理）
            if (detailPanel && detailPanel.classList.contains('show')) return;
            // 如果详情面板的捕获处理器已处理，跳过
            if (e.defaultPrevented) return;
            const curData = filteredData();
            if (e.key === 'ArrowDown' || e.key === 'j') {
                e.preventDefault();
                moveAbnormalFocus(1, curData);
            } else if (e.key === 'ArrowUp' || e.key === 'k') {
                e.preventDefault();
                moveAbnormalFocus(-1, curData);
            } else if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                auditAbnormalSpecimen(curData[wsAbnormalIndex]);
            } else if (e.key === 'Enter' && e.shiftKey) {
                e.preventDefault();
                if (curData[wsAbnormalIndex]) openDetailPanel(curData[wsAbnormalIndex]);
            } else if (e.key === 'Escape') {
                wsCategory = 'normal';
                renderWSCategoryBar();
                renderWSTable();
            }
        };
        document.addEventListener('keydown', _abnormalKeyHandler);

        // 滚动到聚焦卡片
        _scrollAbnormalFocus();
    }

    function moveAbnormalFocus(dir, data) {
        const cards = document.querySelectorAll('.ws-abnormal-card');
        if (cards.length === 0) return;
        // 移除旧聚焦
        if (cards[wsAbnormalIndex]) cards[wsAbnormalIndex].classList.remove('focused');
        // 计算新索引
        wsAbnormalIndex = Math.max(0, Math.min(data.length - 1, wsAbnormalIndex + dir));
        // 添加新聚焦
        if (cards[wsAbnormalIndex]) cards[wsAbnormalIndex].classList.add('focused');
        _scrollAbnormalFocus();
    }

    function _scrollAbnormalFocus() {
        const cards = document.querySelectorAll('.ws-abnormal-card');
        if (cards[wsAbnormalIndex]) {
            cards[wsAbnormalIndex].scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
    }

    let _abnormalAuditInProgress = false;

    async function auditAbnormalSpecimen(specimen) {
        if (!specimen || _abnormalAuditInProgress) return;
        _abnormalAuditInProgress = true;
        dbg('异常列表审核开始:', specimen.PatName);

        try {
            // 安全校验: 危急值不能通过工作台审核
            const cached = wsClassifiedCache[specimen.ReportDR];
            if (cached && cached.status === 'CRITICAL') {
                showToast(`🚨 ${specimen.PatName} 有危急值，必须在原始LIS中审核`, 'error');
                return;
            }

            let iframeWin = getReportIframeWin();
            if (!iframeWin) {
                showToast('正在加载报告页面...', 'warning');
                iframeWin = await ensureReportPageLoaded();
            }
            if (!iframeWin) {
                await new Promise(r => setTimeout(r, 1000));
                iframeWin = getReportIframeWin() || await ensureReportPageLoaded();
            }
            if (!iframeWin) { showToast('报告页面加载失败', 'error'); return; }

            const jq = iframeWin.jQuery || iframeWin.$;
            const me = iframeWin.me;
            if (!jq || !me) {
                showToast('报告页面未就绪，请稍后重试', 'error');
                dbg('审核失败: jq=', !!jq, 'me=', !!me);
                return;
            }

            const reportDR = specimen.ReportDR;

            // 安全校验: 结果必须完整
            const complete = String(specimen.IsComplete || '');
            if (complete !== '1') {
                showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
                return;
            }

            // 安全校验: 不能是已审核状态
            const status = String(specimen.Status || specimen.ReportStatus || '');
            if (status === '3' || status === '4') {
                showToast(`跳过: ${specimen.PatName} 已审核`, 'warning');
                return;
            }

            // 安全校验: 工作组匹配
            const curDR = wgDR();
            const spDR = specimen._wg || '';
            if (spDR && curDR && spDR !== curDR) {
                const wgName = (WG_MAP[spDR] || {}).name || spDR;
                showToast(`标本属于${wgName}，请先切换工作组`, 'warning');
                return;
            }

            // 在原生 datagrid 中选中该标本
            let selected = selectNativeRowByReportDR(iframeWin, reportDR);
            if (!selected) {
                dbg('首次选行失败，按仪器刷新 datagrid...');
                const mdr = specimen._mdr || specimen.WorkGroupMachineDR || '';
                try {
                    if (mdr) {
                        const me2 = iframeWin.me;
                        if (me2) me2.WorkGroupMachineDR = mdr;
                        if (jq('#cmb_WorkGroupMachine').length) {
                            jq('#cmb_WorkGroupMachine').combogrid('setValue', mdr);
                        }
                        const dateStr = jq('#dt_wlReportDate').length ? (jq('#dt_wlReportDate').datebox('getValue') || jq('#dt_wlReportDate').datebox('getText') || today()) : today();
                        const findStr = '&WorkGroupMachineDR=' + mdr + '&ReportStatus=&SttAccDate=' + dateStr;
                        if (typeof iframeWin.ShowWorkList === 'function') iframeWin.ShowWorkList(findStr);
                        else if (typeof iframeWin.FindFast === 'function') iframeWin.FindFast(findStr);
                    }
                } catch(e) { dbg('刷新datagrid异常:', e); }
                // 循环等待 datagrid 加载正确的数据
                for (let w = 0; w < 5 && !selected; w++) {
                    await new Promise(r => setTimeout(r, 1500));
                    iframeWin = getReportIframeWin() || iframeWin;
                    selected = selectNativeRowByReportDR(iframeWin, reportDR);
                    if (!selected) dbg('等待 datagrid 刷新...', w + 1);
                }
            }
            if (!selected) {
                showToast('未在原生列表中找到该标本', 'error');
                return;
            }
            await new Promise(r => setTimeout(r, 600));

            // 使用原生审核按钮
            const auditResult = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth');
            if (auditResult === 'incomplete') {
                showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
                return;
            }
            if (!auditResult) {
                clearCAAuth(); // 审核失败，清除CA认证状态
                showToast('审核失败', 'error');
                return;
            }
            showToast(`已审核: ${specimen.PatName}`, 'success');

            // 确保焦点在主页面
            try { window.focus(); } catch(e) {}

            delete wsClassifiedCache[specimen.ReportDR];
            wsData = wsData.filter(r => r.ReportDR !== specimen.ReportDR);
            calcMachineCounts();
            renderWSTabs();
            renderWSCategoryBar();

            const newData = filteredData();
            if (newData.length === 0) {
                wsCategory = 'normal';
            }
            renderWSCategoryBar();
            renderWSTable();
        } catch(e) {
            dbg('审核失败:', e);
            showToast('审核失败: ' + e.message, 'error');
        } finally {
            _abnormalAuditInProgress = false;
            dbg('异常列表审核结束');
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

            h += `<tr data-i="${i}" data-rdr="${r.ReportDR||''}">`;
            h += `<td>${highlightText(r._mn||'', wsSearchQuery)}</td>`;
            h += `<td>${highlightText(r.PatName||'', wsSearchQuery)}</td>`;
            h += `<td><b>${highlightText(r.Labno||'', wsSearchQuery)}</b></td>`;
            h += `<td>${highlightText(r.TestSetDesc||'', wsSearchQuery)}</td>`;
            h += `<td>${icHTML}</td>`;
            h += `<td>${r.AcceptDT||''}</td>`;
            h += '</tr>';
        });
        h += '</tbody></table>';
        body.innerHTML = h;

        // 行点击 → 详情
        body.querySelectorAll('tr[data-rdr]').forEach(tr => tr.addEventListener('click', e => {
            const i = parseInt(tr.dataset.i);
            if (i >= 0 && i < data.length) openDetailPanel(data[i]);
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
            h += `<tr class="st-${statusVal} ${wsChecked.has(r.ReportDR)?'sel':''}" data-i="${i}" data-rdr="${r.ReportDR||''}">`;
            h += `<td><input type="checkbox" class="lis-ws-ck" data-rdr="${r.ReportDR||''}" ${ck} /></td>`;
            h += `<td>${highlightText(r._mn||'', wsSearchQuery)}</td>`;
            h += `<td><span class="st-tag ${st.cls}">${st.t}</span></td>`;
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
            h += `<td>${r.AcceptDT||''}</td>`;
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
            const i = parseInt(tr.dataset.i);
            if (i >= 0 && i < data.length) openDetailPanel(data[i], source || 'all', i);
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
            const i = parseInt(tr.dataset.i);
            if (i >= 0 && i < data.length) navigateToSpecimen(data[i]);
        };

        body.addEventListener('click', handlers.click);
        body.addEventListener('change', handlers.change);
        body.addEventListener('dblclick', handlers.dblclick);
        body._delegatedHandler = handlers;
    }

    // --- 确认并批量审核 ---
    function confirmAndBatchAudit(normalData) {
        console.log('[LIS] confirmAndBatchAudit called, count:', normalData.length);
        dbg('confirmAndBatchAudit 被调用, normalData.length:', normalData.length);
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
                                <span class="ab-name">${r.row.PatName||'未知'}</span>
                                <span class="ab-detail">${r.row.Labno||''} | ${r.row.TestSetDesc||''}</span>
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
        localStorage.setItem(K.tgt, JSON.stringify({
            wgDR: targetDR, machineDR: mdr, labno: labno, reportDR: reportDR, time: Date.now()
        }));

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
        const unreviewed = selectedSpecimens.filter(r => r.ReportStatus !== '3');
        if (unreviewed.length === 0) {
            toast('选中的标本已全部审核', 'w');
            return;
        }

        // 创建审核确认对话框
        const formatted = unreviewed.map(r => ({ status: 'NORMAL', items: [], row: r, reportDR: r.ReportDR }));
        confirmAndBatchAudit(formatted);
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

    function createDetailPanel() {
        if (detailPanel) return detailPanel;
        detailPanel = document.createElement('div');
        detailPanel.id = 'lis-detail-panel';
        detailPanel.innerHTML = `
            <div id="lis-detail-hd">
                <div style="flex:1;min-width:0">
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

        // 添加遮罩层（点击可关闭详情面板）
        const overlay = document.createElement('div');
        overlay.id = 'lis-detail-overlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:35vw;height:100vh;z-index:100004;display:none;cursor:pointer';
        document.body.appendChild(overlay);
        overlay.addEventListener('click', closeDetailPanel);

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
        console.log('[LIS-DEBUG] openDetailPanel', specimen.ReportDR, specimen.PatName, source);
        createDetailPanel();
        // 清理异常视图键盘监听，防止与详情面板冲突
        if (_abnormalKeyHandler) {
            document.removeEventListener('keydown', _abnormalKeyHandler);
            _abnormalKeyHandler = null;
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
            subtitleEl.innerHTML = `<span>${getStatusText(specimen.Status || specimen.ReportStatus)}</span> · 检验号: ${specimen.Labno || '-'} · 流水号: ${specimen.EpisodeNo || '-'} · ${specimen.TestSetDesc || ''} · 仪器: ${specimen._mn || '-'} · ${specimen.AcceptDT || ''}`;
        }
        const detailExtra = document.getElementById('lis-detail-extra');
        // 立即填充患者信息（优先缓存，回退到 specimen 本身）
        const _cr = (wsClassifiedCache[specimen.ReportDR] || {}).row || specimen;
        const _parts = [];
        if (_cr.Sex) _parts.push(_cr.Sex);
        if (_cr.Age) _parts.push(_cr.Age + (_cr.AgeUnit || ''));
        if (_cr.Location) _parts.push(_cr.Location);
        if (_cr.Ward) _parts.push(_cr.Ward);
        if (_cr.BedNo) _parts.push('床' + _cr.BedNo);
        if (_cr.Specimen) _parts.push(_cr.Specimen);
        if (_cr.Doctor) _parts.push(_cr.Doctor);
        if (detailExtra) detailExtra.textContent = _parts.length ? _parts.join(' · ') : '加载中...';

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
        if (overlay) overlay.style.display = 'block';

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
                // 方向键切换上/下一个标本
                const data = filteredData();
                if (data.length === 0) return;
                const curIdx = data.findIndex(r => r.ReportDR === (currentDetailSpecimen && currentDetailSpecimen.ReportDR));
                let newIdx = curIdx + (e.key === 'ArrowDown' ? 1 : -1);
                if (newIdx < 0) newIdx = data.length - 1;
                if (newIdx >= data.length) newIdx = 0;
                _removeDetailKeyHandler();
                detailPanel.classList.remove('show');
                currentDetailSpecimen = null;
                openDetailPanel(data[newIdx], detailSource, newIdx);
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

    let _detailAuditInProgress = false;

    // 从详情面板审核当前标本并自动跳转下一个
    async function _auditFromDetailPanel() {
        if (!currentDetailSpecimen || _detailAuditInProgress) {
            dbg('详情审核跳过: specimen=', !!currentDetailSpecimen, 'inProgress=', _detailAuditInProgress);
            return;
        }
        _detailAuditInProgress = true;
        dbg('详情审核开始:', currentDetailSpecimen.PatName);

        try {
            const specimen = currentDetailSpecimen;
            const source = detailSource;
            const idx = detailSourceIndex;

            // 获取下一个标本的 ReportDR（用 ReportDR 而非索引，防止数据变化导致索引失效）
            let nextReportDR = null;
            if (source && idx >= 0) {
                const data = filteredData();
                if (idx + 1 < data.length) nextReportDR = data[idx + 1].ReportDR;
            }

            // 直接调用 LabResultSave 审核
            await ensureCAAuthenticated();
            let iframeWin = getReportIframeWin();
            if (!iframeWin) iframeWin = await ensureReportPageLoaded();
            if (!iframeWin) {
                showToast('报告页面未加载', 'error');
                dbg('详情审核失败: iframeWin 为空');
                return;
            }

            const jq = iframeWin.jQuery || iframeWin.$;
            const me = iframeWin.me;
            if (!jq || !me) {
                showToast('报告页面未就绪，请稍后重试', 'error');
                dbg('详情审核失败: jq=', !!jq, 'me=', !!me);
                return;
            }
            const reportDR = specimen.ReportDR;

            // 安全校验: 结果必须完整
            const complete = String(specimen.IsComplete || '');
            if (complete !== '1') {
                showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
                dbg('详情审核跳过: 结果不完整', specimen.PatName);
                return;
            }

            // 安全校验: 不能是已审核状态
            const status = String(specimen.Status || specimen.ReportStatus || '');
            if (status === '3' || status === '4') {
                showToast(`跳过: ${specimen.PatName} 已审核`, 'warning');
                return;
            }

            // 安全校验: 工作组匹配
            const curDR = wgDR();
            const spDR = specimen._wg || '';
            if (spDR && curDR && spDR !== curDR) {
                const wgName = (WG_MAP[spDR] || {}).name || spDR;
                showToast(`标本属于${wgName}，请先切换工作组`, 'warning');
                dbg('工作组不匹配: 标本=', spDR, '当前=', curDR);
                return;
            }

            // 在原生 datagrid 中选中该标本
            let selected = selectNativeRowByReportDR(iframeWin, reportDR);
            if (!selected) {
                dbg('首次选行失败，按仪器刷新 datagrid...');
                const jq2 = iframeWin.jQuery || iframeWin.$;
                const mdr = specimen._mdr || specimen.WorkGroupMachineDR || '';
                try {
                    if (mdr) {
                        const me2 = iframeWin.me;
                        if (me2) me2.WorkGroupMachineDR = mdr;
                        if (jq2 && jq2('#cmb_WorkGroupMachine').length) {
                            jq2('#cmb_WorkGroupMachine').combogrid('setValue', mdr);
                        }
                        const dateStr = jq2 && jq2('#dt_wlReportDate').length ? (jq2('#dt_wlReportDate').datebox('getValue') || jq2('#dt_wlReportDate').datebox('getText') || today()) : today();
                        const findStr = '&WorkGroupMachineDR=' + mdr + '&ReportStatus=&SttAccDate=' + dateStr;
                        if (typeof iframeWin.ShowWorkList === 'function') iframeWin.ShowWorkList(findStr);
                        else if (typeof iframeWin.FindFast === 'function') iframeWin.FindFast(findStr);
                    }
                } catch(e) { dbg('刷新datagrid异常:', e); }
                await new Promise(r => setTimeout(r, 2500));
                iframeWin = getReportIframeWin() || iframeWin;
                selected = selectNativeRowByReportDR(iframeWin, reportDR);
            }
            if (!selected) {
                showToast('未在原生列表中找到该标本', 'error');
                return;
            }
            await new Promise(r => setTimeout(r, 600));

            // 使用原生审核按钮
            const auditResult = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth');
            if (auditResult === 'incomplete') {
                showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
                return;
            }
            if (!auditResult) {
                clearCAAuth(); // 审核失败，清除CA认证状态
                showToast('审核失败', 'error');
                return;
            }
            showToast(`已审核: ${specimen.PatName}`, 'success');
            dbg('详情审核成功:', specimen.PatName, 'ReportDR:', reportDR);

            // 确保焦点在主页面（审核操作后焦点可能留在 iframe 中）
            try { window.focus(); } catch(e) {}

            // 从数据中移除
            delete wsClassifiedCache[specimen.ReportDR];
            wsData = wsData.filter(r => r.ReportDR !== specimen.ReportDR);
            calcMachineCounts();
            renderWSTabs();
            renderWSCategoryBar();
            renderWSTable();

            // 关闭当前详情面板（不触发 Escape 逻辑）
            _removeDetailKeyHandler();
            detailPanel.classList.remove('show');
            currentDetailSpecimen = null;

            // 自动打开下一个标本的详情
            if (nextReportDR) {
                await new Promise(r => setTimeout(r, 300));
                const newData = filteredData();
                const nextSpecimen = newData.find(r => r.ReportDR === nextReportDR);
                dbg('下一个标本: 数据量=', newData.length, 'ReportDR=', nextReportDR, 'found=', !!nextSpecimen);
                if (nextSpecimen) {
                    const nextIdx = newData.indexOf(nextSpecimen);
                    openDetailPanel(nextSpecimen, source, nextIdx);
                } else {
                    if (source === 'abnormal') {
                        wsCategory = 'normal';
                    }
                    renderWSTable();
                }
            } else {
                renderWSTable();
            }
        } catch(e) {
            dbg('详情面板审核失败:', e);
            showToast('审核失败: ' + e.message, 'error');
        } finally {
            _detailAuditInProgress = false;
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
        if (wsCategory === 'abnormal' && !_abnormalKeyHandler) {
            const curData = filteredData();
            if (curData.length > 0) {
                _abnormalKeyHandler = e => {
                    if (wsCategory !== 'abnormal') return;
                    if (detailPanel && detailPanel.classList.contains('show')) return;
                    if (e.defaultPrevented) return;
                    const d = filteredData();
                    if (e.key === 'ArrowDown' || e.key === 'j') {
                        e.preventDefault(); moveAbnormalFocus(1, d);
                    } else if (e.key === 'ArrowUp' || e.key === 'k') {
                        e.preventDefault(); moveAbnormalFocus(-1, d);
                    } else if (e.key === 'Enter' && !e.shiftKey) {
                        e.preventDefault(); auditAbnormalSpecimen(d[wsAbnormalIndex]);
                    } else if (e.key === 'Enter' && e.shiftKey) {
                        e.preventDefault(); if (d[wsAbnormalIndex]) openDetailPanel(d[wsAbnormalIndex]);
                    } else if (e.key === 'Escape') {
                        wsCategory = 'normal'; renderWSCategoryBar(); renderWSTable();
                    }
                };
                document.addEventListener('keydown', _abnormalKeyHandler);
                dbg('异常视图键盘监听已恢复');
            }
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
        return map[status] || '未知';
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
                const hisNum = parseFloat(h.result);
                let cls = 'normal';
                if (!isNaN(hisNum) && r.ValueLow && r.ValueHigh) {
                    const low = parseFloat(r.ValueLow);
                    const high = parseFloat(r.ValueHigh);
                    if (hisNum > high) cls = 'high';
                    else if (hisNum < low) cls = 'low';
                }
                if (!h.date) cls = 'nodate';
                const dateStr = h.date ? h.date.split(' ')[0].replace(/^\d{2}(\d{2})/, '$1') : '';
                dates.push(dateStr);
                cells.push(`<span class="hist-tag ${cls}">${h.result}</span>`);
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
                    if (res) items.push({ result: String(res).trim(), date: String(dt).trim() });
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
                            if (res) items.push({ result: String(res).trim(), date: String(dt).trim() });
                        }
                        continue;
                    } catch(e) {}
                }

                // 格式3: "值(日期), 值(日期)" 格式
                const matches = trimmed.match(/([^(),]+)\(([^)]+)\)/g);
                if (matches) {
                    for (const m of matches) {
                        const parts = m.match(/(.+)\((.+)\)/);
                        if (parts) items.push({ result: parts[1].trim(), date: parts[2].trim() });
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
                            if (res) items.push({ result: res.trim(), date: date });
                        } else {
                            if (rec) items.push({ result: rec, date: '' });
                        }
                    }
                    continue;
                }

                // 格式5: 用分隔符隔开的纯值（逗号、分号、竖线）
                if (trimmed.includes(',') || trimmed.includes(';') || trimmed.includes('|')) {
                    const sep = trimmed.includes(',') ? ',' : (trimmed.includes(';') ? ';' : '|');
                    const vals = trimmed.split(sep).map(v => v.trim()).filter(Boolean);
                    for (const v of vals) {
                        items.push({ result: v, date: '' });
                    }
                    continue;
                }

                // 格式6: 单个值
                items.push({ result: trimmed, date: '' });
            }
        }

        return items;
    }

    async function loadDetailResults(specimen) {
        const body = document.getElementById('lis-detail-body');
        if (!body) return;
        const rdr = specimen.ReportDR || '';

        // LRU 缓存命中
        const cached = detailLRUGet(rdr);
        if (cached) {
            dbg('详情缓存命中:', rdr);
            body.innerHTML = cached.html;
            return;
        }

        try {
            const ss = buildSS(specimen._wg || wgDR());

            // 注意：原始系统使用 Status 字段，不是 ReportStatus
            const statusVal = specimen.Status || specimen.ReportStatus || '';

            // 构建查询参数 - 使用正确的 API 获取标本详细结果
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
            let data = await fetchJ(CSP + '?' + p.toString());

            let itemInfo = (data && data.ItemInfo) ? data.ItemInfo : [];
            const labInfo = (data && data.LabInfo) ? data.LabInfo : [];

            // 调试：打印所有项目的字段和 PreResult
            if (itemInfo.length > 0) {
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
                body.innerHTML = '<div style="text-align:center;padding:40px;color:#999">未找到结果数据</div>';
                return;
            }
            // 渲染结果
            let html = '';

            // 统计摘要栏
            const totalItems = itemInfo.length;
            const doneItems = itemInfo.filter(r => r.Result && r.Result.trim() && r.Result.trim() !== '-').length;
            const abnItems = itemInfo.filter(r => { const f=(r.AbFlag||'').toUpperCase(); return f==='H'||f==='HH'||f==='L'||f==='LL'||f==='A'||f==='N'; }).length;
            const critItems = itemInfo.filter(r => { const f=(r.AbFlag||'').toUpperCase(); return f==='HH'||f==='LL'; }).length;
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
            const thDates = hdrDates.map(d => d ? `<th style="font-size:11px">${d}</th>` : '<th style="font-size:11px">-</th>').join('');

            html += `<thead><tr><th>项目</th><th>结果</th><th>参考范围</th><th>状态</th>${thDates}</tr></thead>`;
            html += '<tbody>';

            itemInfo.forEach(r => {
                const result = (r.TextRes && r.TextRes.trim()) ? r.TextRes.trim() : (r.Result || '-');
                const unit = r.Unit || '';
                const refRange = r.RefRanges || '-';
                const abnormalFlag = (r.AbFlag || '').toUpperCase().trim();

                const isEmpty = !r.Result || r.Result.trim() === '' || r.Result.trim() === '-';
                let isAbnormal = false, isCritical = false;
                let statusText = isEmpty ? '⏳ 待检' : '✓';
                let rowStyle = isEmpty ? 'background:#fafafa;color:#bbb' : '';

                if (abnormalFlag === 'HH' || abnormalFlag === 'LL') {
                    isAbnormal = true; isCritical = true;
                    statusText = abnormalFlag === 'HH' ? '↑↑ 危急' : '↓↓ 危急';
                    rowStyle = 'background:#fff5f5;border-left:3px solid #e74c3c';
                } else if (abnormalFlag === 'H') {
                    isAbnormal = true; statusText = '↑ 高';
                    rowStyle = 'background:#fff8e1;border-left:3px solid #ff9800';
                } else if (abnormalFlag === 'L' || abnormalFlag === 'N') {
                    isAbnormal = true; statusText = '↓ 低';
                    rowStyle = 'background:#e3f2fd;border-left:3px solid #2196f3';
                } else if (abnormalFlag === 'A') {
                    isAbnormal = true; statusText = '⚠ 异常';
                    rowStyle = 'background:#fce4ec;border-left:3px solid #e91e63';
                } else if (r.ValueLow && r.ValueHigh) {
                    const numResult = parseFloat(result);
                    const low = parseFloat(r.ValueLow), high = parseFloat(r.ValueHigh);
                    if (!isNaN(numResult)) {
                        if (numResult > high) { isAbnormal = true; statusText = '↑ 高'; rowStyle = 'background:#fff8e1;border-left:3px solid #ff9800'; }
                        else if (numResult < low) { isAbnormal = true; statusText = '↓ 低'; rowStyle = 'background:#e3f2fd;border-left:3px solid #2196f3'; }
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

                html += `<tr style="${rowStyle}">
                    <td style="font-weight:500;max-width:120px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${r.CName || ''}">${r.CName || '-'}</td>
                    <td class="${statusClass}" style="font-weight:700;font-size:13px;white-space:nowrap">${result}${unit ? ' <span style="font-size:10px;color:#999;font-weight:400">' + unit + '</span>' : ''}</td>
                    <td style="color:#888;font-size:11px;white-space:nowrap">${refWithUnit}</td>
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
                        const diffH = Math.floor(diffMs / 3600000);
                        const diffM = Math.floor((diffMs % 3600000) / 60000);
                        timeDelta = diffH > 0 ? diffH + '小时' + diffM + '分' : diffM + '分钟';
                    } catch(e) {}
                }

                // 更新深色头部患者详情行
                const extraEl = document.getElementById('lis-detail-extra');
                if (extraEl) {
                    const parts = [];
                    if (info.Sex) parts.push(info.Sex);
                    if (info.Age) parts.push(info.Age + (info.AgeUnit || ''));
                    if (info.Location) parts.push(info.Location);
                    if (info.Ward) parts.push(info.Ward);
                    if (info.BedNo) parts.push('床' + info.BedNo);
                    if (info.Specimen) parts.push(info.Specimen);
                    if (info.Doctor) parts.push(info.Doctor);
                    let extraText = parts.join(' · ');
                    if (info.Diagnose) extraText += ' · 🏥 ' + info.Diagnose;
                    extraEl.textContent = extraText;
                }

                // 异常警告（内联）
                if (critItems > 0) {
                    html += '<div style="margin-top:6px;padding:6px 10px;background:#fff5f5;border-radius:4px;font-size:11px;border:1px solid #ffcdd2">';
                    html += '<span style="color:#e74c3c;font-weight:700">🚨 危急值 ' + critItems + ' 项</span>';
                    html += '<span style="margin-left:12px;color:#c62828;font-size:10px">须在原始LIS中审核</span>';
                    html += '</div>';
                } else if (abnItems > 0) {
                    html += '<div style="margin-top:6px;padding:6px 10px;background:#fff8e1;border-radius:4px;font-size:11px;border:1px solid #ffecb3">';
                    html += '<span style="color:#ff9800;font-weight:600">⚠ 异常项目 ' + abnItems + ' 项</span>';
                    html += '</div>';
                }

                // 传染病历史比对
                const cached = wsClassifiedCache[specimen.ReportDR];
                if (cached && cached.infectionWarning) {
                    html += '<div style="margin-top:6px;padding:6px 10px;background:#fff3e0;border-radius:4px;font-size:11px;border:1px solid #ffcc80">';
                    html += '<span style="color:#e65100;font-weight:700">⚠️ 与历史结果不一致</span>';
                    html += '<div style="color:#bf360c;font-size:10px;margin-top:2px">' + cached.infectionWarning + '</div>';
                    html += '</div>';
                }
            }

            body.innerHTML = html;
            // 存入 LRU 缓存
            detailLRUSet(rdr, { html, ts: Date.now() });

        } catch (e) {
            dbg('加载详细结果失败:', e);
            body.innerHTML = `
                <div style="text-align:center;padding:40px;color:#e74c3c">
                    <p>❌ 加载失败</p>
                    <p style="font-size:12px">${e.message}</p>
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
                <span>🔒 数据仅在本地处理 | 行点击 → 详情</span>
                <span>Enter=审核异常 | ↑↓=移动 | Esc=关闭</span>
            </div>`;
        document.body.appendChild(ws);

        // 监控工作台属性变化（检测是否有外部代码修改 class 或 style）
        const wsAttrObserver = new MutationObserver(muts => {
            for (const m of muts) {
                if (m.type === 'attributes' && m.target.id === 'lis-ws') {
                    dbg('[WS] #lis-ws 属性变化:', m.attributeName, 'class=', ws.className, 'style=', ws.style.cssText);
                    console.trace('[WS] #lis-ws 属性变化调用栈');
                }
            }
        });
        wsAttrObserver.observe(ws, { attributes: true, attributeFilter: ['class', 'style'] });

        // 浮动按钮（可拖动）
        const fab = document.createElement('button');
        fab.id = 'lis-fab';
        fab.innerHTML = '🔬';
        fab.title = '拖动移动 | 点击打开工作台';
        document.body.appendChild(fab);

        const tip = document.createElement('div');
        tip.id = 'lis-fab-tip';
        tip.textContent = '点击打开审核工作台';
        document.body.appendChild(tip);

        // 拖动功能
        let fabDragging = false, fabMoved = false, fabStartX, fabStartY, fabOrigX, fabOrigY;
        fab.addEventListener('mousedown', e => {
            fabDragging = true; fabMoved = false;
            fabStartX = e.clientX; fabStartY = e.clientY;
            const rect = fab.getBoundingClientRect();
            fabOrigX = rect.left; fabOrigY = rect.top;
            e.preventDefault();
        });
        document.addEventListener('mousemove', e => {
            if (!fabDragging) return;
            const dx = e.clientX - fabStartX, dy = e.clientY - fabStartY;
            if (Math.abs(dx) > 3 || Math.abs(dy) > 3) fabMoved = true;
            if (fabMoved) {
                fab.style.transition = 'none';
                fab.style.left = (fabOrigX + dx) + 'px';
                fab.style.top = (fabOrigY + dy) + 'px';
                fab.style.right = 'auto';
                fab.style.bottom = 'auto';
            }
        });
        document.addEventListener('mouseup', () => { fabDragging = false; });
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
    function openPwdDlg() {
        let o = document.getElementById('lis-pwdo');
        if (!o) {
            o = document.createElement('div');
            o.id = 'lis-pwdo';
            o.innerHTML = `<div id="lis-pwdp">
                <h4>🔐 密码管理</h4>
                <label style="font-size:13px;color:#555;display:block;margin-bottom:6px">审核密码（与登录密码不同）</label>
                <input type="password" id="lis-pwdi" placeholder="输入审核密码" />
                <div class="sts" id="lis-pwds"></div>
                <label style="font-size:13px;color:#555;display:block;margin-bottom:6px;margin-top:16px">CA认证密码（与登录账号一致）</label>
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
            document.getElementById('lis-pwdsave').addEventListener('click', () => {
                const auditPwd = document.getElementById('lis-pwdi').value;
                const caPwd = document.getElementById('lis-cawdi').value;
                if (auditPwd) savePwd(auditPwd);
                if (caPwd) saveCAPwd(caPwd);
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
        document.getElementById('lis-pwdi').value = loadPwd();
        document.getElementById('lis-pwds').textContent = loadPwd() ? '当前已保存审核密码' : '尚未保存审核密码';
        document.getElementById('lis-cawdi').value = loadCAPwd();
        document.getElementById('lis-cawds').textContent = loadCAPwd() ? '当前已保存CA密码' : '尚未保存CA密码';
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
                <input type="text" id="lis-lu" placeholder="用户名" value="${creds?creds.user:''}" autocomplete="username" />
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
                btn.style.background = btn.style.borderColor = wgs.find(w=>w.dr===btn.dataset.dr).color;
                btn.style.color = '#fff';
                selectedWG = btn.dataset.dr;
            });
        });

        // 登录按钮
        const loginBtn = document.getElementById('lis-lbtn');
        loginBtn.addEventListener('click', () => doLogin(selectedWG));

        // Enter 快捷键
        box.addEventListener('keydown', e => {
            if (e.keyCode === 13) doLogin(selectedWG);
        });

        // 如果有保存的凭证，聚焦到登录按钮
        if (creds) {
            loginBtn.focus();
        }
    }

    function doLogin(wgDR) {
        const user = document.getElementById('lis-lu').value.trim();
        const pwd = document.getElementById('lis-lp').value;
        if (!user || !pwd) { toast('请输入用户名和密码', 'w'); return; }

        const btn = document.getElementById('lis-lbtn');
        btn.disabled = true;
        btn.textContent = '⏳ 登录中...';

        // 只保存用户名
        saveLoginCreds(user, wgDR);
        localStorage.setItem(LOGIN_WG_KEY, wgDR);

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

    function getImmuneMachines() {
        // 从缓存获取免疫组的仪器列表
        const machines = _mcCache['4'] || [];
        return machines.map(m => ({
            dr: m.RowID,
            name: m.CName || m.Name || m.RowID
        }));
    }

    // ============================================================
    //  模块 D：质控面板 v7（独立 L-J 质控图）
    // ============================================================

    const _qcAPI = {
        config: null,
        QC_CSP: BASE + '/csp/jquery.easyui.dhcclassjson.csp',
        QC_ASHX: BASE + '/sys/ashx/ashBTQualityControl.ashx',
        init() {
            try {
                const raw = localStorage.getItem('LIS_QC_API_Config');
                if (raw) this.config = JSON.parse(raw);
            } catch(e) {}
        },
        saveConfig() {
            try { localStorage.setItem('LIS_QC_API_Config', JSON.stringify(this.config)); } catch(e) {}
        },
        async loadQCItemTree(wgDR) {
            // 尝试通过 CSP 加载质控项目树
            try {
                const ss = buildSS(wgDR);
                const p = new URLSearchParams();
                p.set('ClassName', 'LIS.WS.BLL.QC.DHCRPQCSet');
                p.set('QueryName', 'QryQCSetByWGM');
                p.set('FunModul', 'JSON');
                p.set('P0', wgDR);
                p.set('P14', ss);
                const data = await fetchJ(this.QC_CSP + '?' + p.toString());
                if (data && data.rows && data.rows.length > 0) return data.rows;
            } catch(e) { dbg('[QC] loadQCItemTree CSP 失败:', e.message); }

            // 回退：尝试 ashx 方式
            try {
                const data = await fetchJ(this.QC_ASHX + '?Method=GetQCSetByWorkGroup&WorkGroupDR=' + wgDR);
                if (data && data.rows && data.rows.length > 0) return data.rows;
                if (Array.isArray(data) && data.length > 0) return data;
            } catch(e) { dbg('[QC] loadQCItemTree ashx 失败:', e.message); }

            return [];
        },
        async loadQCData(params) {
            // params: { InstrumentCode, MaterialCode, TcCode, Level, StartDate, EndDate }
            try {
                const p = new URLSearchParams();
                p.set('ClassName', 'LIS.WS.BLL.QC.DHCRPQCData');
                p.set('QueryName', 'QryQCDataForChart');
                p.set('FunModul', 'JSON');
                p.set('P0', params.InstrumentCode || '');
                p.set('P1', params.MaterialCode || '');
                p.set('P2', params.TcCode || '');
                p.set('P3', params.Level || '1');
                p.set('P4', params.StartDate || '');
                p.set('P5', params.EndDate || '');
                const data = await fetchJ(this.QC_CSP + '?' + p.toString());
                if (data && data.rows) return data.rows;
                if (Array.isArray(data)) return data;
            } catch(e) { dbg('[QC] loadQCData CSP 失败:', e.message); }

            // 回退 ashx
            try {
                const p2 = new URLSearchParams();
                p2.set('Method', 'GetQCData');
                p2.set('InstrumentCode', params.InstrumentCode || '');
                p2.set('MaterialCode', params.MaterialCode || '');
                p2.set('TcCode', params.TcCode || '');
                p2.set('Level', params.Level || '1');
                p2.set('StartDate', params.StartDate || '');
                p2.set('EndDate', params.EndDate || '');
                const data = await fetchJ(this.QC_ASHX + '?' + p2.toString());
                if (data && data.rows) return data.rows;
                if (Array.isArray(data)) return data;
            } catch(e) { dbg('[QC] loadQCData ashx 失败:', e.message); }

            return [];
        },
        async saveQCData(params) {
            try {
                const p = new URLSearchParams();
                p.set('ClassName', 'LIS.WS.BLL.QC.DHCRPQCData');
                p.set('QueryName', 'UpdateQCData');
                p.set('FunModul', 'JSON');
                p.set('P0', params.InstrumentCode || '');
                p.set('P1', params.MaterialCode || '');
                p.set('P2', params.TcCode || '');
                p.set('P3', params.Level || '1');
                p.set('P4', params.Date || '');
                p.set('P5', params.Result || '');
                p.set('P6', params.QCID || '');
                const data = await fetchJ(this.QC_CSP + '?' + p.toString());
                return data;
            } catch(e) {
                dbg('[QC] saveQCData 失败:', e.message);
                return null;
            }
        }
    };

    // --- 质控面板状态 ---
    let _qcPanelEl = null;
    let _qcState = {
        open: false,
        machines: [],
        activeMachine: '',
        items: [],
        activeItem: null,
        activeLevel: 1,
        data: [],
        stats: null,
        startDate: (() => { const d=new Date(); d.setDate(d.getDate()-30); return d.toISOString().split('T')[0]; })(),
        endDate: today(),
        searchQuery: '',
        pendingChanges: new Map(),
        chartCanvas: null,
        hoveredPoint: null
    };

    // --- 初始化质控面板 ---
    function initQCPanel() {
        _qcAPI.init();
        createQCFab();
    }

    function createQCFab() {
        if (document.getElementById('lis-qc-fab')) return;
        const fab = document.createElement('button');
        fab.id = 'lis-qc-fab';
        fab.innerHTML = '<span class="fab-icon">📊</span><span class="fab-label">QC</span>';
        fab.title = '打开质控面板';
        fab.addEventListener('click', () => {
            if (!_qcPanelEl) createQCPanel();
            openQCPanel();
        });
        document.body.appendChild(fab);
    }

    function createQCPanel() {
        if (_qcPanelEl) return _qcPanelEl;
        _qcPanelEl = document.createElement('div');
        _qcPanelEl.id = 'lis-qc-panel';
        _qcPanelEl.innerHTML = `
            <div class="qc-toolbar">
                <h3>📊 质控面板</h3>
                <span class="qc-tb-sep"></span>
                <label>工作组:</label>
                <select id="qc-wg-sel"></select>
                <label>仪器:</label>
                <select id="qc-mach-sel"><option value="">加载中...</option></select>
                <span class="qc-tb-sep"></span>
                <label>开始:</label>
                <input type="date" id="qc-start-date">
                <label>结束:</label>
                <input type="date" id="qc-end-date">
                <div class="qc-level-bar" id="qc-level-bar"></div>
                <span class="qc-tb-sep"></span>
                <button class="qc-tb-btn btn-primary" id="qc-btn-refresh">🔄 刷新</button>
                <button class="qc-tb-btn btn-success" id="qc-btn-save" style="display:none">💾 保存修改</button>
                <button class="qc-tb-btn btn-warning" id="qc-btn-fallback">🌐 嵌入模式</button>
                <button class="qc-tb-close" id="qc-btn-close">✕</button>
            </div>
            <div class="qc-main">
                <div class="qc-sidebar">
                    <div class="qc-sidebar-hd">
                        <input type="text" id="qc-search" placeholder="🔍 搜索项目...">
                    </div>
                    <div class="qc-item-list" id="qc-item-list">
                        <div class="qc-empty-msg"><span class="ico">📋</span>请先选择仪器</div>
                    </div>
                </div>
                <div class="qc-content">
                    <div class="qc-stats-bar" id="qc-stats-bar"></div>
                    <div class="qc-chart-wrap" id="qc-chart-wrap">
                        <canvas id="qc-chart-canvas"></canvas>
                        <div class="qc-chart-tooltip" id="qc-chart-tooltip"></div>
                        <div class="qc-empty-msg" id="qc-chart-empty" style="position:absolute;inset:0"><span class="ico">📈</span>选择项目后显示 L-J 质控图</div>
                    </div>
                    <div class="qc-data-wrap" id="qc-data-wrap">
                        <div class="qc-empty-msg" id="qc-data-empty"><span class="ico">📋</span>选择项目后显示质控数据</div>
                    </div>
                </div>
            </div>`;
        document.body.appendChild(_qcPanelEl);

        // 工具栏事件
        document.getElementById('qc-btn-close').addEventListener('click', closeQCPanel);
        document.getElementById('qc-btn-refresh').addEventListener('click', refreshQCPanel);
        document.getElementById('qc-btn-save').addEventListener('click', saveQCPendingChanges);
        document.getElementById('qc-btn-fallback').addEventListener('click', openQCFallbackMode);
        document.getElementById('qc-start-date').value = _qcState.startDate;
        document.getElementById('qc-end-date').value = _qcState.endDate;
        document.getElementById('qc-start-date').addEventListener('change', e => { _qcState.startDate = e.target.value; if (_qcState.activeItem) loadAndRenderQCData(); });
        document.getElementById('qc-end-date').addEventListener('change', e => { _qcState.endDate = e.target.value; if (_qcState.activeItem) loadAndRenderQCData(); });

        // 工作组选择
        const wgSel = document.getElementById('qc-wg-sel');
        WG.forEach(w => {
            const opt = document.createElement('option');
            opt.value = w.dr; opt.textContent = w.icon + ' ' + w.name;
            wgSel.appendChild(opt);
        });
        wgSel.value = wgDR() || '4';
        wgSel.addEventListener('change', async () => {
            _qcState.activeMachine = '';
            _qcState.items = [];
            _qcState.activeItem = null;
            _qcState.data = [];
            _qcState.stats = null;
            _qcState.pendingChanges.clear();
            updateSaveBtn();
            renderQCItemList();
            await loadQCMachines(wgSel.value);
        });

        // 仪器选择
        document.getElementById('qc-mach-sel').addEventListener('change', async (e) => {
            _qcState.activeMachine = e.target.value;
            _qcState.activeItem = null;
            _qcState.data = [];
            _qcState.stats = null;
            _qcState.pendingChanges.clear();
            updateSaveBtn();
            if (_qcState.activeMachine) {
                await loadQCItemTree();
            } else {
                _qcState.items = [];
                renderQCItemList();
            }
        });

        // 搜索
        document.getElementById('qc-search').addEventListener('input', (e) => {
            _qcState.searchQuery = e.target.value.toLowerCase();
            renderQCItemList();
        });

        // Chart resize
        const ro = new ResizeObserver(() => { if (_qcState.stats) renderLJChart(); });
        ro.observe(document.getElementById('qc-chart-wrap'));

        // Chart hover
        const chartWrap = document.getElementById('qc-chart-wrap');
        chartWrap.addEventListener('mousemove', handleChartHover);
        chartWrap.addEventListener('mouseleave', () => {
            _qcState.hoveredPoint = null;
            const tt = document.getElementById('qc-chart-tooltip');
            if (tt) tt.style.display = 'none';
        });

        return _qcPanelEl;
    }

    function openQCPanel() {
        if (!_qcPanelEl) createQCPanel();
        _qcState.open = true;
        _qcPanelEl.classList.add('show');
        document.body.style.overflow = 'hidden';
        // 加载仪器
        loadQCMachines(document.getElementById('qc-wg-sel').value);
    }

    function closeQCPanel() {
        _qcState.open = false;
        if (_qcPanelEl) _qcPanelEl.classList.remove('show');
        document.body.style.overflow = '';
    }

    async function loadQCMachines(wgDR) {
        const sel = document.getElementById('qc-mach-sel');
        sel.innerHTML = '<option value="">加载中...</option>';
        try {
            const machines = await loadMachines(wgDR);
            _qcState.machines = machines;
            sel.innerHTML = '<option value="">全部仪器</option>';
            machines.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.RowID;
                opt.textContent = m.CName || m.Name || m.RowID;
                sel.appendChild(opt);
            });
            sel.value = _qcState.activeMachine;
        } catch(e) {
            sel.innerHTML = '<option value="">加载失败</option>';
            dbg('[QC] loadMachines 失败:', e);
        }
    }

    async function loadQCItemTree() {
        const listEl = document.getElementById('qc-item-list');
        listEl.innerHTML = '<div class="qc-empty-msg"><span class="ico">⏳</span>加载质控项目...</div>';
        const wgSel = document.getElementById('qc-wg-sel');
        const wgDR = wgSel.value;
        const machDR = _qcState.activeMachine;

        let items = await _qcAPI.loadQCItemTree(wgDR);

        // 如果 API 加载失败，尝试从质控页面 iframe 提取
        if (!items || items.length === 0) {
            dbg('[QC] API 加载项目列表失败，尝试 iframe 方式');
            items = await discoverQCItemsViaIframe(wgDR, machDR);
        }

        // 如果还是没有，尝试通过解析质控数据查询页面
        if (!items || items.length === 0) {
            items = await discoverQCItemsViaDataView(wgDR, machDR);
        }

        _qcState.items = items || [];
        renderQCItemList();
    }

    async function discoverQCItemsViaIframe(wgDR, machDR) {
        return new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
            iframe.src = BASE + '/qc/form/frmQCDrawLJ.aspx?MenuDR=159&NotIndependent=1';
            document.body.appendChild(iframe);

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) { resolved = true; iframe.remove(); resolve([]); }
            }, 15000);

            iframe.onload = () => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    // 尝试从页面中提取质控项目信息
                    const scripts = doc.querySelectorAll('script');
                    let items = [];
                    scripts.forEach(s => {
                        const text = s.textContent || '';
                        // 查找质控项目数据
                        const match = text.match(/var\s+qcItems?\s*=\s*(\[[\s\S]*?\]);/);
                        if (match) {
                            try { items = JSON.parse(match[1]); } catch(e) {}
                        }
                    });

                    // 如果没有找到 JS 变量，尝试从 datagrid 提取
                    if (items.length === 0) {
                        try {
                            const jq = iframe.contentWindow.jQuery;
                            if (jq && jq.fn.datagrid) {
                                const rows = jq('.datagrid-body').find('tr');
                                rows.each(function() {
                                    const cells = jq(this).find('td');
                                    if (cells.length >= 3) {
                                        items.push({
                                            name: cells.eq(0).text().trim(),
                                            abbr: cells.eq(1).text().trim(),
                                            material: cells.eq(2).text().trim(),
                                            code: cells.eq(3) ? cells.eq(3).text().trim() : ''
                                        });
                                    }
                                });
                            }
                        } catch(e) {}
                    }

                    // 也尝试从全局变量中提取
                    if (items.length === 0) {
                        try {
                            const win = iframe.contentWindow;
                            const vars = ['qcSetData', 'qcItems', 'itemData', 'QryData'];
                            for (const v of vars) {
                                if (win[v] && Array.isArray(win[v]) && win[v].length > 0) {
                                    items = win[v];
                                    break;
                                }
                            }
                        } catch(e) {}
                    }

                    resolved = true;
                    clearTimeout(timeout);
                    iframe.remove();
                    resolve(items);
                } catch(e) {
                    resolved = true;
                    clearTimeout(timeout);
                    iframe.remove();
                    resolve([]);
                }
            };
        });
    }

    async function discoverQCItemsViaDataView(wgDR, machDR) {
        // 尝试通过质控数据查询页面发现项目
        return new Promise((resolve) => {
            const iframe = document.createElement('iframe');
            iframe.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;left:-9999px';
            iframe.src = BASE + '/qc/form/frmQCDataView.aspx';
            document.body.appendChild(iframe);

            let resolved = false;
            const timeout = setTimeout(() => {
                if (!resolved) { resolved = true; iframe.remove(); resolve([]); }
            }, 15000);

            iframe.onload = () => {
                try {
                    const doc = iframe.contentDocument || iframe.contentWindow.document;
                    const win = iframe.contentWindow;

                    // 尝试从全局变量中提取
                    let items = [];
                    const vars = ['qcItems', 'itemData', 'TcData', 'instrumentItems'];
                    for (const v of vars) {
                        if (win[v] && Array.isArray(win[v]) && win[v].length > 0) {
                            items = win[v];
                            break;
                        }
                    }

                    // 尝试从 datagrid 提取
                    if (items.length === 0) {
                        try {
                            const jq = win.jQuery;
                            if (jq) {
                                const grids = jq('.datagrid-fbody, .datagrid-body');
                                grids.each(function() {
                                    const rows = jq(this).find('tr');
                                    rows.each(function() {
                                        const cells = jq(this).find('td');
                                        if (cells.length >= 2) {
                                            items.push({
                                                name: cells.eq(0).text().trim(),
                                                code: cells.eq(1) ? cells.eq(1).text().trim() : ''
                                            });
                                        }
                                    });
                                });
                            }
                        } catch(e) {}
                    }

                    resolved = true;
                    clearTimeout(timeout);
                    iframe.remove();
                    resolve(items);
                } catch(e) {
                    resolved = true;
                    clearTimeout(timeout);
                    iframe.remove();
                    resolve([]);
                }
            };
        });
    }

    function renderQCItemList() {
        const listEl = document.getElementById('qc-item-list');
        if (!_qcState.items || _qcState.items.length === 0) {
            listEl.innerHTML = '<div class="qc-empty-msg"><span class="ico">📋</span>暂无质控项目</div>';
            return;
        }

        const q = _qcState.searchQuery;
        const filtered = q ? _qcState.items.filter(item => {
            const name = (item.name || item.TCName || item.TestCodeDesc || item.CName || '').toLowerCase();
            const mat = (item.material || item.MaterialName || '').toLowerCase();
            const code = (item.code || item.TcCode || item.TestCode || '').toLowerCase();
            return name.includes(q) || mat.includes(q) || code.includes(q);
        }) : _qcState.items;

        if (filtered.length === 0) {
            listEl.innerHTML = '<div class="qc-empty-msg"><span class="ico">🔍</span>无匹配项目</div>';
            return;
        }

        let h = '';
        filtered.forEach((item, idx) => {
            const name = item.name || item.TCName || item.TestCodeDesc || item.CName || '未知项目';
            const mat = item.material || item.MaterialName || '';
            const code = item.code || item.TcCode || item.TestCode || '';
            const levels = item.levels || item.LevelCount || 1;
            const isActive = _qcState.activeItem && (
                (_qcState.activeItem.TcCode || _qcState.activeItem.code) === (item.TcCode || item.code)
            );
            h += `<div class="qc-item ${isActive ? 'active' : ''}" data-idx="${idx}" data-code="${code}" title="${name}">`;
            h += `<div class="qi-name">${name}</div>`;
            if (mat) h += `<div class="qi-mat">${mat}</div>`;
            h += '</div>';
        });
        listEl.innerHTML = h;

        listEl.querySelectorAll('.qc-item').forEach(el => {
            el.addEventListener('click', () => {
                const idx = parseInt(el.dataset.idx);
                selectQCItem(filtered[idx]);
            });
        });
    }

    function selectQCItem(item) {
        _qcState.activeItem = item;
        _qcState.activeLevel = 1;
        _qcState.pendingChanges.clear();
        updateSaveBtn();
        renderQCItemList();
        renderLevelBar(item);
        loadAndRenderQCData();
    }

    function renderLevelBar(item) {
        const bar = document.getElementById('qc-level-bar');
        const levels = item.levels || item.LevelCount || 1;
        if (levels <= 1) { bar.innerHTML = ''; return; }
        let h = '';
        for (let i = 1; i <= levels; i++) {
            h += `<button class="qc-level-btn ${_qcState.activeLevel === i ? 'on' : ''}" data-level="${i}">L${i}</button>`;
        }
        bar.innerHTML = h;
        bar.querySelectorAll('.qc-level-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                _qcState.activeLevel = parseInt(btn.dataset.level);
                _qcState.pendingChanges.clear();
                updateSaveBtn();
                renderLevelBar(item);
                loadAndRenderQCData();
            });
        });
    }

    async function loadAndRenderQCData() {
        if (!_qcState.activeItem) return;
        const item = _qcState.activeItem;
        const chartEmpty = document.getElementById('qc-chart-empty');
        const dataEmpty = document.getElementById('qc-data-empty');
        if (chartEmpty) chartEmpty.style.display = 'none';
        if (dataEmpty) dataEmpty.style.display = 'none';

        // 显示加载中
        const chartWrap = document.getElementById('qc-chart-wrap');
        let loadingEl = chartWrap.querySelector('.qc-loading');
        if (!loadingEl) {
            loadingEl = document.createElement('div');
            loadingEl.className = 'qc-loading';
            loadingEl.textContent = '⏳ 加载质控数据...';
            chartWrap.appendChild(loadingEl);
        }

        const params = {
            InstrumentCode: item.InstrumentCode || item.MachineDR || _qcState.activeMachine || '',
            MaterialCode: item.MaterialCode || item.MatDR || '',
            TcCode: item.TcCode || item.code || item.TestCode || '',
            Level: _qcState.activeLevel,
            StartDate: _qcState.startDate,
            EndDate: _qcState.endDate
        };

        dbg('[QC] 加载数据:', params);
        const data = await _qcAPI.loadQCData(params);

        if (loadingEl) loadingEl.remove();

        if (!data || data.length === 0) {
            document.getElementById('qc-chart-empty').style.display = '';
            document.getElementById('qc-chart-empty').innerHTML = '<span class="ico">📭</span>该时间段无质控数据';
            document.getElementById('qc-data-empty').style.display = '';
            document.getElementById('qc-data-empty').innerHTML = '<span class="ico">📭</span>无质控数据';
            _qcState.data = [];
            _qcState.stats = null;
            renderQCStatsBar();
            return;
        }

        // 标准化数据格式
        _qcState.data = data.map(r => ({
            date: r.QCDate || r.Date || r.TestDate || '',
            result: parseFloat(r.Result || r.QCResult || r.Value || 0),
            target: parseFloat(r.Target || r.Mean || r靶值 || 0),
            sd: parseFloat(r.SD || r.StandardDeviation || 0),
            level: r.Level || r.QCLevel || _qcState.activeLevel,
            id: r.RowID || r.QCID || r.ID || '',
            rule: r.QCRule || r.Rule || '',
            material: r.MaterialName || r.MatName || '',
            tcName: r.TCName || r.TestCodeDesc || item.name || ''
        }));

        // 计算统计量
        calcQCStats();
        renderQCStatsBar();
        renderLJChart();
        renderQCDataTable();
    }

    function calcQCStats() {
        const data = _qcState.data;
        if (!data || data.length === 0) { _qcState.stats = null; return; }

        const values = data.map(d => d.result).filter(v => !isNaN(v) && v !== 0);
        if (values.length === 0) { _qcState.stats = null; return; }

        const mean = values.reduce((s, v) => s + v, 0) / values.length;
        const variance = values.reduce((s, v) => s + Math.pow(v - mean, 2), 0) / (values.length - 1 || 1);
        const sd = Math.sqrt(variance);
        const cv = mean !== 0 ? (sd / mean * 100) : 0;

        // 使用第一个数据点的设定靶值和标准差（如果有）
        const firstTarget = data[0].target;
        const firstSD = data[0].sd;
        const useTarget = firstTarget > 0 ? firstTarget : mean;
        const useSD = firstSD > 0 ? firstSD : sd;

        _qcState.stats = {
            target: useTarget,
            sd: useSD,
            cv: firstTarget > 0 && firstSD > 0 ? (firstSD / firstTarget * 100) : cv,
            calcMean: mean,
            calcSD: sd,
            calcCV: cv,
            count: values.length,
            min: Math.min(...values),
            max: Math.max(...values),
            range: Math.max(...values) - Math.min(...values)
        };
    }

    function renderQCStatsBar() {
        const bar = document.getElementById('qc-stats-bar');
        if (!_qcState.stats) { bar.innerHTML = ''; return; }
        const s = _qcState.stats;
        bar.innerHTML = `
            <div class="stat-item"><span class="stat-label">靶值:</span> <b>${s.target.toFixed(3)}</b></div>
            <div class="stat-item"><span class="stat-label">SD:</span> <b>${s.sd.toFixed(3)}</b></div>
            <div class="stat-item"><span class="stat-label">CV%:</span> <b>${s.cv.toFixed(2)}%</b></div>
            <div class="stat-item"><span class="stat-label">计算均值:</span> <b>${s.calcMean.toFixed(3)}</b></div>
            <div class="stat-item"><span class="stat-label">计算SD:</span> <b>${s.calcSD.toFixed(3)}</b></div>
            <div class="stat-item"><span class="stat-label">计算CV%:</span> <b>${s.calcCV.toFixed(2)}%</b></div>
            <div class="stat-item"><span class="stat-label">数据点:</span> <b>${s.count}</b></div>
            <div class="stat-item"><span class="stat-label">范围:</span> <b>${s.min.toFixed(2)} ~ ${s.max.toFixed(2)}</b></div>`;
    }

    // ==================== L-J 图 Canvas 渲染 ====================
    const _qcChart = {
        padding: { top: 40, right: 30, bottom: 50, left: 60 },
        colors: {
            bg: '#ffffff',
            grid: '#f0f0f0',
            axis: '#333333',
            target: '#27ae60',
            sd1: '#3498db',
            sd2: '#e67e22',
            sd3: '#e74c3c',
            pointOk: '#27ae60',
            pointWarn: '#e67e22',
            pointLoss: '#e74c3c',
            text: '#555555',
            textLight: '#999999'
        }
    };

    function renderLJChart() {
        const canvas = document.getElementById('qc-chart-canvas');
        if (!canvas || !_qcState.stats || !_qcState.data.length) return;

        const wrap = document.getElementById('qc-chart-wrap');
        const rect = wrap.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = rect.width;
        const h = rect.height;

        canvas.width = w * dpr;
        canvas.height = h * dpr;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';

        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        _qcChart.drawGrid(ctx, w, h);
        _qcChart.drawSDLines(ctx, w, h);
        _qcChart.drawDataPoints(ctx, w, h);
        _qcChart.drawTitle(ctx, w);
    }

    _qcChart.drawGrid = function(ctx, w, h) {
        const p = this.padding;
        const cw = w - p.left - p.right;
        const ch = h - p.top - p.bottom;

        // 背景
        ctx.fillStyle = this.colors.bg;
        ctx.fillRect(0, 0, w, h);

        // 网格线
        ctx.strokeStyle = this.colors.grid;
        ctx.lineWidth = 0.5;

        // 水平网格线（10条）
        for (let i = 0; i <= 10; i++) {
            const y = p.top + (ch / 10) * i;
            ctx.beginPath();
            ctx.moveTo(p.left, y);
            ctx.lineTo(p.left + cw, y);
            ctx.stroke();
        }

        // 垂直网格线
        const data = _qcState.data;
        const dayCount = data.length;
        const step = Math.max(1, Math.ceil(dayCount / 20));
        for (let i = 0; i < dayCount; i += step) {
            const x = p.left + (cw / (dayCount - 1 || 1)) * i;
            ctx.beginPath();
            ctx.moveTo(x, p.top);
            ctx.lineTo(x, p.top + ch);
            ctx.stroke();
        }

        // 坐标轴
        ctx.strokeStyle = this.colors.axis;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(p.left, p.top);
        ctx.lineTo(p.left, p.top + ch);
        ctx.lineTo(p.left + cw, p.top + ch);
        ctx.stroke();

        // X 轴标签（日期）
        ctx.fillStyle = this.colors.textLight;
        ctx.font = '10px sans-serif';
        ctx.textAlign = 'center';
        for (let i = 0; i < dayCount; i += step) {
            const x = p.left + (cw / (dayCount - 1 || 1)) * i;
            const dateStr = data[i].date || '';
            const label = dateStr.length >= 10 ? dateStr.substring(8, 10) : (i + 1).toString();
            ctx.fillText(label, x, p.top + ch + 16);
        }

        // Y 轴刻度
        const stats = _qcState.stats;
        if (stats) {
            const yMin = stats.target - 4 * stats.sd;
            const yMax = stats.target + 4 * stats.sd;
            ctx.textAlign = 'right';
            ctx.fillStyle = this.colors.text;
            for (let i = 0; i <= 8; i++) {
                const val = yMin + (yMax - yMin) * (1 - i / 8);
                const y = p.top + (ch / 8) * i;
                ctx.fillText(val.toFixed(2), p.left - 6, y + 3);
            }
        }

        // X 轴标题
        ctx.fillStyle = this.colors.text;
        ctx.font = '11px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText('日期', p.left + cw / 2, p.top + ch + 35);

        // Y 轴标题
        ctx.save();
        ctx.translate(15, p.top + ch / 2);
        ctx.rotate(-Math.PI / 2);
        ctx.fillText('浓度', 0, 0);
        ctx.restore();
    };

    _qcChart.drawSDLines = function(ctx, w, h) {
        const p = this.padding;
        const cw = w - p.left - p.right;
        const ch = h - p.top - p.bottom;
        const stats = _qcState.stats;
        if (!stats || stats.sd === 0) return;

        const yMin = stats.target - 4 * stats.sd;
        const yMax = stats.target + 4 * stats.sd;
        const range = yMax - yMin;

        const yScale = (val) => p.top + ch * (1 - (val - yMin) / range);

        // 绘制 SD 区域背景
        // ±2SD 区域（浅黄色警告区）
        ctx.fillStyle = 'rgba(241, 196, 15, 0.06)';
        ctx.fillRect(p.left, yScale(stats.target + 2 * stats.sd), cw, yScale(stats.target - 2 * stats.sd) - yScale(stats.target + 2 * stats.sd));

        // ±1SD 区域（浅绿色正常区）
        ctx.fillStyle = 'rgba(46, 204, 113, 0.08)';
        ctx.fillRect(p.left, yScale(stats.target + stats.sd), cw, yScale(stats.target - stats.sd) - yScale(stats.target + stats.sd));

        const drawLine = (val, color, dash, label) => {
            const y = yScale(val);
            ctx.strokeStyle = color;
            ctx.lineWidth = val === stats.target ? 2 : 1;
            ctx.setLineDash(dash);
            ctx.beginPath();
            ctx.moveTo(p.left, y);
            ctx.lineTo(p.left + cw, y);
            ctx.stroke();
            ctx.setLineDash([]);

            // 标签
            ctx.fillStyle = color;
            ctx.font = '10px sans-serif';
            ctx.textAlign = 'right';
            ctx.fillText(label, p.left + cw + 28, y + 3);
        };

        drawLine(stats.target + 3 * stats.sd, this.colors.sd3, [6, 3], '+3SD');
        drawLine(stats.target + 2 * stats.sd, this.colors.sd2, [6, 3], '+2SD');
        drawLine(stats.target + stats.sd, this.colors.sd1, [4, 4], '+1SD');
        drawLine(stats.target, this.colors.target, [], '靶值');
        drawLine(stats.target - stats.sd, this.colors.sd1, [4, 4], '-1SD');
        drawLine(stats.target - 2 * stats.sd, this.colors.sd2, [6, 3], '-2SD');
        drawLine(stats.target - 3 * stats.sd, this.colors.sd3, [6, 3], '-3SD');
    };

    _qcChart.drawDataPoints = function(ctx, w, h) {
        const p = this.padding;
        const cw = w - p.left - p.right;
        const ch = h - p.top - p.bottom;
        const stats = _qcState.stats;
        const data = _qcState.data;
        if (!stats || !data.length || stats.sd === 0) return;

        const yMin = stats.target - 4 * stats.sd;
        const yMax = stats.target + 4 * stats.sd;
        const range = yMax - yMin;

        const yScale = (val) => p.top + ch * (1 - (val - yMin) / range);
        const xScale = (i) => p.left + (cw / (data.length - 1 || 1)) * i;

        // 连线
        ctx.strokeStyle = 'rgba(52, 152, 219, 0.3)';
        ctx.lineWidth = 1;
        ctx.beginPath();
        data.forEach((d, i) => {
            const x = xScale(i);
            const y = yScale(d.result);
            if (i === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
        });
        ctx.stroke();

        // 数据点
        data.forEach((d, i) => {
            const x = xScale(i);
            const y = yScale(d.result);
            const deviation = Math.abs(d.result - stats.target) / stats.sd;

            let color = this.colors.pointOk;
            let radius = 4;
            if (deviation >= 3) { color = this.colors.pointLoss; radius = 6; }
            else if (deviation >= 2) { color = this.colors.pointWarn; radius = 5; }
            else if (deviation >= 1) { radius = 4; }

            // 检查 pending changes
            const key = d.date + '|' + d.id;
            if (_qcState.pendingChanges.has(key)) {
                color = '#9b59b6'; // 紫色表示已修改
                radius = 6;
            }

            ctx.fillStyle = color;
            ctx.beginPath();
            ctx.arc(x, y, radius, 0, Math.PI * 2);
            ctx.fill();

            // 白色边框
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 1.5;
            ctx.stroke();
        });

        // 存储坐标映射用于悬停检测
        this._pointCoords = data.map((d, i) => ({
            x: xScale(i),
            y: yScale(d.result),
            data: d,
            index: i
        }));
    };

    _qcChart.drawTitle = function(ctx, w) {
        if (!_qcState.activeItem) return;
        const item = _qcState.activeItem;
        const name = item.name || item.TCName || item.TestCodeDesc || '';
        const mat = item.material || item.MaterialName || '';
        const title = name + (mat ? ' — ' + mat : '') + '  ' + _qcState.startDate + ' 至 ' + _qcState.endDate;

        ctx.fillStyle = '#2c3e50';
        ctx.font = 'bold 12px sans-serif';
        ctx.textAlign = 'center';
        ctx.fillText(title, w / 2, 20);
    };

    function handleChartHover(e) {
        const canvas = document.getElementById('qc-chart-canvas');
        if (!canvas || !_qcChart._pointCoords) return;

        const rect = canvas.getBoundingClientRect();
        const mx = e.clientX - rect.left;
        const my = e.clientY - rect.top;

        const threshold = 15;
        let closest = null;
        let minDist = Infinity;

        for (const pt of _qcChart._pointCoords) {
            const dist = Math.sqrt(Math.pow(mx - pt.x, 2) + Math.pow(my - pt.y, 2));
            if (dist < threshold && dist < minDist) {
                minDist = dist;
                closest = pt;
            }
        }

        const tt = document.getElementById('qc-chart-tooltip');
        if (!closest) {
            _qcState.hoveredPoint = null;
            tt.style.display = 'none';
            return;
        }

        _qcState.hoveredPoint = closest;
        const d = closest.data;
        const stats = _qcState.stats;
        const deviation = stats ? ((d.result - stats.target) / stats.sd).toFixed(2) : '--';
        const statusText = Math.abs(parseFloat(deviation)) >= 3 ? '🔴 失控' :
                          Math.abs(parseFloat(deviation)) >= 2 ? '🟡 警告' :
                          Math.abs(parseFloat(deviation)) >= 1 ? '🔵 关注' : '🟢 正常';

        tt.innerHTML = `
            <div class="tt-title">${d.date || '未知日期'}</div>
            <div class="tt-row"><span>结果:</span><b>${d.result.toFixed(3)}</b></div>
            <div class="tt-row"><span>靶值:</span><span>${stats ? stats.target.toFixed(3) : '--'}</span></div>
            <div class="tt-row"><span>偏差(SD):</span><span>${deviation}</span></div>
            <div class="tt-row"><span>状态:</span><span>${statusText}</span></div>
            ${d.rule ? '<div class="tt-row"><span>规则:</span><span>' + d.rule + '</span></div>' : ''}
            ${_qcState.pendingChanges.has(d.date + '|' + d.id) ? '<div class="tt-row"><span style="color:#9b59b6">✏️ 已修改</span></div>' : ''}`;

        // 定位
        let tx = closest.x + 15;
        let ty = closest.y - 10;
        const wrapRect = document.getElementById('qc-chart-wrap').getBoundingClientRect();
        if (tx + 180 > wrapRect.width) tx = closest.x - 185;
        if (ty < 0) ty = 10;
        tt.style.left = tx + 'px';
        tt.style.top = ty + 'px';
        tt.style.display = 'block';
    }

    // ==================== 可编辑数据表 ====================
    function renderQCDataTable() {
        const wrap = document.getElementById('qc-data-wrap');
        const data = _qcState.data;
        const stats = _qcState.stats;

        if (!data || data.length === 0) {
            wrap.innerHTML = '<div class="qc-empty-msg" id="qc-data-empty"><span class="ico">📋</span>无质控数据</div>';
            return;
        }

        let h = '<table><thead><tr>';
        h += '<th>日期</th><th>结果</th><th>靶值</th><th>SD</th><th>偏差(SD)</th><th>CV%</th><th>状态</th><th>质控规则</th>';
        h += '</tr></thead><tbody>';

        data.forEach((d, i) => {
            const deviation = stats && stats.sd > 0 ? (d.result - stats.target) / stats.sd : 0;
            const absDev = Math.abs(deviation);
            let statusCls = 'status-ok';
            let statusText = '正常';
            if (absDev >= 3) { statusCls = 'status-loss'; statusText = '失控'; }
            else if (absDev >= 2) { statusCls = 'status-warn'; statusText = '警告'; }
            else if (absDev >= 1) { statusCls = 'status-warn'; statusText = '关注'; }

            const key = d.date + '|' + d.id;
            const isModified = _qcState.pendingChanges.has(key);

            h += `<tr data-idx="${i}" ${isModified ? 'style="background:#f3e5f5"' : ''}>`;
            h += `<td>${d.date || ''}</td>`;
            h += `<td class="qc-editable" data-idx="${i}" data-field="result" title="双击编辑">${isModified ? '✏️ ' : ''}${d.result.toFixed(3)}</td>`;
            h += `<td>${stats ? stats.target.toFixed(3) : '--'}</td>`;
            h += `<td>${stats ? stats.sd.toFixed(3) : '--'}</td>`;
            h += `<td>${deviation.toFixed(2)}</td>`;
            h += `<td>${stats && stats.target ? (d.result / stats.target * 100 - 100).toFixed(2) : '--'}%</td>`;
            h += `<td class="${statusCls}">${statusText}</td>`;
            h += `<td>${d.rule || ''}</td>`;
            h += '</tr>';
        });

        h += '</tbody></table>';
        wrap.innerHTML = h;

        // 双击编辑
        wrap.querySelectorAll('.qc-editable').forEach(td => {
            td.addEventListener('dblclick', () => {
                const idx = parseInt(td.dataset.idx);
                const field = td.dataset.field;
                const currentVal = _qcState.data[idx][field];
                const input = document.createElement('input');
                input.type = 'number';
                input.step = '0.001';
                input.value = currentVal;
                input.style.cssText = 'width:80px;padding:2px 4px;border:1px solid #3498db;border-radius:3px;font-size:12px';
                td.textContent = '';
                td.appendChild(input);
                input.focus();
                input.select();

                const commit = () => {
                    const newVal = parseFloat(input.value);
                    if (!isNaN(newVal) && newVal !== currentVal) {
                        const key = _qcState.data[idx].date + '|' + _qcState.data[idx].id;
                        _qcState.pendingChanges.set(key, {
                            ..._qcState.data[idx],
                            result: newVal,
                            originalResult: currentVal
                        });
                        _qcState.data[idx].result = newVal;
                        updateSaveBtn();
                    }
                    calcQCStats();
                    renderQCStatsBar();
                    renderLJChart();
                    renderQCDataTable();
                };

                input.addEventListener('blur', commit);
                input.addEventListener('keydown', (ke) => {
                    if (ke.key === 'Enter') { ke.preventDefault(); input.blur(); }
                    if (ke.key === 'Escape') { input.value = currentVal; input.blur(); }
                });
            });
        });
    }

    function updateSaveBtn() {
        const btn = document.getElementById('qc-btn-save');
        if (btn) {
            const count = _qcState.pendingChanges.size;
            if (count > 0) {
                btn.style.display = '';
                btn.textContent = '💾 保存修改 (' + count + ')';
            } else {
                btn.style.display = 'none';
            }
        }
    }

    async function saveQCPendingChanges() {
        if (_qcState.pendingChanges.size === 0) return;
        const changes = Array.from(_qcState.pendingChanges.values());
        let success = 0;
        let fail = 0;

        for (const chg of changes) {
            const params = {
                InstrumentCode: _qcState.activeItem?.InstrumentCode || '',
                MaterialCode: _qcState.activeItem?.MaterialCode || '',
                TcCode: chg.id || _qcState.activeItem?.TcCode || '',
                Level: _qcState.activeLevel,
                Date: chg.date,
                Result: chg.result.toString(),
                QCID: chg.id || ''
            };
            const result = await _qcAPI.saveQCData(params);
            if (result) success++; else fail++;
        }

        _qcState.pendingChanges.clear();
        updateSaveBtn();
        renderQCDataTable();
        renderLJChart();

        if (fail === 0) {
            toast('✅ 成功保存 ' + success + ' 条质控结果');
        } else {
            toast('⚠️ 保存完成：' + success + ' 成功，' + fail + ' 失败', 'w');
        }
    }

    function openQCFallbackMode() {
        // 降级模式：嵌入原始质控页面
        if (!_qcPanelEl) createQCPanel();
        const content = document.querySelector('.qc-content');
        if (!content) return;

        const wgDR = document.getElementById('qc-wg-sel').value;
        const machDR = _qcState.activeMachine;
        const url = BASE + '/qc/form/frmQCDrawLJ.aspx?MenuDR=159&NotIndependent=1';

        content.innerHTML = `<iframe class="qc-iframe-fallback" src="${url}" id="qc-iframe"></iframe>`;
    }

    function refreshQCPanel() {
        if (_qcState.activeItem) {
            loadAndRenderQCData();
        } else if (_qcState.activeMachine) {
            loadQCItemTree();
        }
    }

    // ============================================================
    // ============================================================
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
#lis-audit-confirm{position:fixed;inset:0;z-index:100020;background:rgba(0,0,0,.6);display:none;align-items:center;justify-content:center}
#lis-audit-confirm.show{display:flex}
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
    let _auditLockTs = 0;
    const AUDIT_LOCK_TIMEOUT = 60000; // 60秒自动释放卡死的锁
    function acquireAuditLock(tag) {
        if (_auditInProgress && (Date.now() - _auditLockTs > AUDIT_LOCK_TIMEOUT)) {
            dbg('审核锁超时自动释放 (held by', tag, ')');
            _auditInProgress = false;
        }
        if (_auditInProgress) return false;
        _auditInProgress = true;
        _auditLockTs = Date.now();
        return true;
    }
    function releaseAuditLock() {
        _auditInProgress = false;
        _auditLockTs = 0;
    }

    // --- 检测是否在报告处理页面 ---
    function isReportPageActive() {
        // 检查是否在主框架中
        try {
            if (window !== window.top) return false;
        } catch(e) { return false; }
        // 在主页面上始终返回 true（工具栏始终显示）
        return true;
    }

    // --- 获取原生 EasyUI datagrid 的行数据 ---
    function getNativeDatagridRows() {
        const w = uw();
        if (!w.$) return [];
        // 尝试多种选择器找到 datagrid
        const selectors = ['#dg', '#dgReport', '.datagrid-f', 'table.datagrid-f', '#workList', '.datagrid-view'];
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
        const selectors = ['#dg', '#dgReport', '.datagrid-f'];
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
        const selectors = ['#dg', '#dgReport', '.datagrid-f'];
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
        const selectors = ['#dg', '#dgReport', '.datagrid-f'];
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
    function ensureReportPageLoaded() {
        return new Promise((resolve) => {
            // 已经加载
            const win = getReportIframeWin();
            if (win) { resolve(win); return; }

            // 点击"报告处理"菜单加载页面
            dbg('报告处理页面未加载，自动打开...');
            const links = document.querySelectorAll('a');
            for (const a of links) {
                if (a.textContent.trim() === '报告处理') {
                    a.click();
                    break;
                }
            }

            // 轮询等待 iframe 加载（最多 15 秒）
            let waited = 0;
            const interval = setInterval(() => {
                waited += 300;
                const w = getReportIframeWin();
                if (w) {
                    clearInterval(interval);
                    dbg('报告处理页面加载完成');
                    resolve(w);
                } else if (waited >= 15000) {
                    clearInterval(interval);
                    dbg('报告处理页面加载超时');
                    resolve(null);
                }
            }, 300);
        });
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

    // --- 工作台 CA 认证按钮 ---
    async function handleCAAuth() {
        const btn = document.getElementById('lis-ws-ca');
        if (!btn) return;
        btn.disabled = true;
        btn.textContent = '⏳ 认证中...';
        btn.style.background = '#7f8c8d';

        const caPwd = loadCAPwd();
        if (!caPwd) {
            showToast('请先设置CA密码', 'warning');
            btn.textContent = '🔑 CA认证'; btn.style.background = '#9b59b6'; btn.disabled = false; return;
        }

        try {
            let iframeWin = getReportIframeWin();
            if (!iframeWin) {
                showToast('正在加载报告页面...', 'warning');
                iframeWin = await ensureReportPageLoaded();
            }
            if (!iframeWin) { showToast('未找到报告页面', 'error'); btn.textContent = '🔑 CA认证'; btn.style.background = '#9b59b6'; btn.disabled = false; return; }

            let jq = iframeWin.jQuery || iframeWin.$;
            let me = iframeWin.me;
            if (!jq || !me) {
                for (let w = 0; w < 15; w++) {
                    await sleep(400);
                    iframeWin = getReportIframeWin();
                    if (iframeWin) { jq = iframeWin.jQuery || iframeWin.$; me = iframeWin.me; if (jq && me) break; }
                }
            }
            if (!jq || !me) { showToast('报告页面未就绪', 'error'); btn.textContent = '🔑 CA认证'; btn.style.background = '#9b59b6'; btn.disabled = false; return; }

            // 检查审核登录状态
            const authStatus = getAuditStatusText(iframeWin);
            if (authStatus && authStatus.indexOf('未登录') !== -1) {
                showToast('审核用户未登录...', 'warning');
                const loginOK = await handleAuditLogin(iframeWin, jq);
                if (!loginOK) { showToast('审核登录失败', 'error'); btn.textContent = '🔑 CA认证'; btn.style.background = '#9b59b6'; btn.disabled = false; return; }
                await sleep(500);
            }

            // 尝试选中第一行（可选）
            const dg = jq('#dgWorkList');
            if (dg.length) {
                try {
                    const rows = dg.datagrid('getRows');
                    if (rows && rows.length > 0) dg.datagrid('selectRow', 0);
                } catch(e) {}
            }

            // 点击审核按钮触发CA窗口
            const auditBtn = iframeWin.document.getElementById('btn_ReportAuth') || document.getElementById('btn_ReportAuth');
            if (!auditBtn) { showToast('未找到审核按钮', 'error'); btn.textContent = '🔑 CA认证'; btn.style.background = '#9b59b6'; btn.disabled = false; return; }

            jq(auditBtn).click();
            await sleep(1000);

            // 检查CA窗口
            let caWin = jq('#win_CAUserLogin');
            let waited = 0;
            while ((!caWin.length || !caWin.is(':visible')) && waited < 3000) {
                await sleep(300); waited += 300; caWin = jq('#win_CAUserLogin');
            }

            if (caWin.length && caWin.is(':visible')) {
                const caOK = await handleCALogin(iframeWin);
                if (caOK) {
                    showToast('✅ CA 认证成功', 'success');
                    btn.textContent = '✅ 已认证'; btn.style.background = '#27ae60'; saveCAAuth();
                } else {
                    showToast('CA 认证失败', 'error');
                    btn.textContent = '🔑 CA认证'; btn.style.background = '#9b59b6'; clearCAAuth();
                }
            } else {
                showToast('✅ CA 已认证', 'success');
                btn.textContent = '✅ 已认证'; btn.style.background = '#27ae60'; saveCAAuth();
            }

            // 清理
            await sleep(300);
            try {
                const doc = iframeWin.document;
                const dialogs = doc.querySelectorAll('.window, .messager-window');
                for (const d of dialogs) {
                    if (d.style.display === 'none') continue;
                    const body = d.querySelector('.panel-body');
                    if (!body) continue;
                    const text = (body.textContent || '');
                    if (text.indexOf('必填') !== -1 || text.indexOf('确认') !== -1) {
                        const btns = d.querySelectorAll('a.l-btn, button');
                        for (const b of btns) {
                            if ((b.textContent || '').trim() === '取消') { jq(b).click(); break; }
                        }
                    }
                }
            } catch(e) {}
            try { window.focus(); } catch(e) {}

        } catch(e) {
            showToast('CA认证异常: ' + e.message, 'error');
            btn.textContent = '🔑 CA认证'; btn.style.background = '#9b59b6';
        }
        btn.disabled = false;
    }

    async function handleCALogin(iframeWin) {
        const doc = iframeWin.document;
        const jq = iframeWin.jQuery || iframeWin.$;
        const caWin = jq('#win_CAUserLogin');
        if (!caWin.length || !caWin.is(':visible')) return true;

        const caPwd = loadCAPwd();
        if (!caPwd) { showToast('请先设置CA密码', 'warning'); return false; }

        const caUser = uname() || loadLoginCreds()?.user;
        if (!caUser) { showToast('无法获取用户名', 'error'); return false; }

        dbg('CA: 检测到 CA 窗口');

        // 最多重试 3 次
        for (let attempt = 1; attempt <= 3; attempt++) {
            dbg('CA 尝试 ' + attempt + '/3');

            // 等待 iframe 加载（最多 15 秒）
            let caIframe = null;
            for (let i = 0; i < 50; i++) {
                caIframe = doc.querySelector('#win_CAUserLogin iframe');
                if (caIframe && caIframe.contentDocument && caIframe.contentDocument.body && caIframe.contentDocument.body.childElementCount > 0) break;
                await sleep(300);
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
                    userInput.focus(); userInput.value = caUser;
                    userInput.dispatchEvent(new Event('focus', {bubbles:true}));
                    userInput.dispatchEvent(new Event('input', {bubbles:true}));
                    userInput.dispatchEvent(new Event('change', {bubbles:true}));
                    userInput.dispatchEvent(new Event('blur', {bubbles:true}));
                }
                if (pwdInput) {
                    pwdInput.focus(); pwdInput.value = caPwd;
                    pwdInput.dispatchEvent(new Event('focus', {bubbles:true}));
                    pwdInput.dispatchEvent(new Event('input', {bubbles:true}));
                    pwdInput.dispatchEvent(new Event('change', {bubbles:true}));
                    pwdInput.dispatchEvent(new Event('blur', {bubbles:true}));
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
                    // 检查错误
                    if (i > 0 && i % 10 === 0) {
                        const errText = (caDoc.body?.textContent || '') + ' ' + (doc.querySelector('#win_CAUserLogin .panel-body')?.textContent || '');
                        if (errText.indexOf('账号锁定') !== -1 || errText.indexOf('账户锁定') !== -1) {
                            showToast('CA 账号已锁定', 'error');
                            return false;
                        }
                    }
                }

                if (attempt < 3) {
                    showToast('CA 重试 (' + attempt + '/3)...', 'warning');
                    if (pwdInput) pwdInput.value = '';
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

    // --- 点击原生审核按钮并处理 CA ---
    // 返回值：true=成功, false=失败, 'incomplete'=结果不完整（跳过）
    async function clickNativeAuditButton(iframeWin, btnId) {
        // 按钮在 iframe 的工具栏里
        let btn = null;
        if (iframeWin) {
            btn = iframeWin.document.getElementById(btnId);
        }
        if (!btn) {
            // 回退：主页面
            btn = document.getElementById(btnId);
        }
        if (!btn) {
            // 再回退：按文本搜索
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
        if (!btn) { dbg('按钮 ' + btnId + ' 不存在'); return false; }

        const jq = iframeWin ? (iframeWin.jQuery || iframeWin.$) : window.jQuery;
        const doc = iframeWin ? iframeWin.document : document;

        // 点击按钮
        jq(btn).click();

        // 轮询等待对话框出现（最多 2 秒，每 200ms 检查一次）
        let statusText = '';
        for (let poll = 0; poll < 10; poll++) {
            await sleep(200);
            statusText = getAuditStatusText(iframeWin);
            if (statusText && statusText.indexOf('未登录') !== -1) break;
            // 检查是否有 EasyUI 弹窗出现
            const hasDialog = doc.querySelector('.window:not([style*="display: none"]), .messager-window:not([style*="display: none"])');
            if (hasDialog) break;
        }

        // 检查是否有"审核用户未登录"提示
        if (statusText && statusText.indexOf('未登录') !== -1) {
            dbg('检测到审核用户未登录，尝试自动登录...');
            showToast('审核用户未登录，正在自动登录...', 'warning');
            const loginOK = await handleAuditLogin(iframeWin, jq);
            if (!loginOK) {
                showToast('审核登录失败，请手动登录', 'error');
                return false;
            }
            // 登录成功，重新点击审核按钮
            await sleep(300);
            jq(btn).click();
            await sleep(600);
        }

        // 检查是否有 CA 窗口
        const caWin = jq('#win_CAUserLogin');
        if (caWin.length && caWin.is(':visible')) {
            const loginOK = await handleCALogin(iframeWin);
            if (!loginOK) {
                clearCAAuth(); // CA认证失败，清除本地状态
                return false;
            }
            await sleep(300);
            jq(btn).click();
            await sleep(600);
        }

        // 审核操作后，将焦点归还主页面
        try { window.focus(); } catch(e) {}

        // 只检查结果不完整的对话框（这是必须取消的情况）
        const allWindows = doc.querySelectorAll('.window, .panel, .dialog, [class*="window"], [class*="dialog"], .messager-window, .messager');
        for (const w of allWindows) {
            if (w.style.display === 'none') continue;
            if (w.offsetParent === null && !w.classList.contains('messager-window')) continue;
            const body = w.querySelector('.panel-body, .window-body, .dialog-content, .body, .messager-body');
            if (!body) continue;
            const text = (body.textContent || '').trim();
            if (!text) continue;

            // 只检测结果不完整的对话框
            if (text.indexOf('必填项目') !== -1 || 
                text.indexOf('未存数据') !== -1 || 
                text.indexOf('结果为空') !== -1 ||
                text.indexOf('结果不完整') !== -1 ||
                text.indexOf('无结果') !== -1 ||
                text.indexOf('没有结果') !== -1 ||
                text.indexOf('未录入') !== -1 ||
                text.indexOf('请录入') !== -1) {
                dbg('检测到结果不完整对话框，取消审核: ' + text.substring(0, 50));
                // 点击"取消"按钮
                const btns = w.querySelectorAll('a.l-btn, button, input[type="button"]');
                for (const b of btns) {
                    const bText = (b.textContent || b.value || '').trim();
                    if (bText === '取消' || bText === 'No' || bText === '否' || bText === '关闭') {
                        jq(b).click();
                        dbg('已点击取消按钮');
                        break;
                    }
                }
                return 'incomplete';
            }
        }

        dbg('审核按钮点击完成');
        return true;
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

    // 更新CA状态显示
    async function updateCAStatus() {
        const caBtn = document.getElementById('lis-ws-ca');
        if (!caBtn) return;
        
        caBtn.textContent = '⏳ 检查中...';
        caBtn.style.background = '#7f8c8d';
        
        const status = await checkRealCAStatus();
        if (status.authenticated) {
            caBtn.textContent = '✅ 已认证';
            caBtn.style.background = '#27ae60';
            saveCAAuth(); // 保存认证状态
        } else {
            caBtn.textContent = '🔑 CA认证';
            caBtn.style.background = '#9b59b6';
            clearCAAuth(); // 清除可能过期的状态
        }
    }

    // --- 确保CA已认证（审核前调用，已认证则跳过）---
    async function ensureCAAuthenticated() {
        // 快速检查：本地缓存 + 实际状态
        const cached = loadCAAuth();
        if (cached && (Date.now() - cached.time < 3600000)) {
            const real = await checkRealCAStatus();
            if (real.authenticated) return true;
        }

        dbg('CA: 自动认证开始');
        const caBtn = document.getElementById('lis-ws-ca');
        if (caBtn) { caBtn.textContent = '⏳ 认证中...'; caBtn.style.background = '#7f8c8d'; }

        try {
            let iframeWin = getReportIframeWin();
            if (!iframeWin) iframeWin = await ensureReportPageLoaded();
            if (!iframeWin) { if (caBtn) { caBtn.textContent = '🔑 CA认证'; caBtn.style.background = '#9b59b6'; } return false; }

            let jq = iframeWin.jQuery || iframeWin.$;
            let me = iframeWin.me;
            if (!jq || !me) {
                for (let w = 0; w < 15; w++) {
                    await sleep(400);
                    iframeWin = getReportIframeWin();
                    if (iframeWin) { jq = iframeWin.jQuery || iframeWin.$; me = iframeWin.me; if (jq && me) break; }
                }
            }
            if (!jq || !me) { if (caBtn) { caBtn.textContent = '🔑 CA认证'; caBtn.style.background = '#9b59b6'; } return false; }

            // 检查审核登录
            const authStatus = getAuditStatusText(iframeWin);
            if (authStatus && authStatus.indexOf('未登录') !== -1) {
                await handleAuditLogin(iframeWin, jq);
                await sleep(500);
            }

            // 检查CA窗口是否已经打开（不点击审核按钮，避免副作用）
            let caWin = jq('#win_CAUserLogin');
            let result = false;
            if (caWin.length && caWin.is(':visible')) {
                // CA 窗口已打开，直接处理登录
                result = await handleCALogin(iframeWin);
            } else {
                // 没有CA窗口 = 已认证（或需要在审核时才弹出）
                result = true;
            }

            if (result) {
                saveCAAuth();
                if (caBtn) { caBtn.textContent = '✅ 已认证'; caBtn.style.background = '#27ae60'; }
                showToast('✅ CA 自动认证成功', 'success');
            } else {
                if (caBtn) { caBtn.textContent = '🔑 CA认证'; caBtn.style.background = '#9b59b6'; }
            }

            // 清理
            await sleep(300);
            try {
                const doc = iframeWin.document;
                const dialogs = doc.querySelectorAll('.window, .messager-window');
                for (const d of dialogs) {
                    if (d.style.display === 'none') continue;
                    const body = d.querySelector('.panel-body');
                    if (!body) continue;
                    const text = (body.textContent || '');
                    if (text.indexOf('必填') !== -1 || text.indexOf('确认') !== -1) {
                        const btns = d.querySelectorAll('a.l-btn, button');
                        for (const b of btns) {
                            if ((b.textContent || '').trim() === '取消') { jq(b).click(); break; }
                        }
                    }
                }
            } catch(e) {}
            try { window.focus(); } catch(e) {}

            return result;
        } catch(e) {
            dbg('CA自动认证异常:', e);
            if (caBtn) { caBtn.textContent = '🔑 CA认证'; caBtn.style.background = '#9b59b6'; }
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
            if (authLoginBtn) {
                jq(authLoginBtn).click();
                dbg('已点击审核登录按钮');
                await sleep(500);

                // 查找并填写密码
                const doc = iframeWin.document;
                const pwdInput = doc.querySelector('#text_AuthUserLoginPasssword')
                    || doc.querySelector('input[type="password"]');
                if (pwdInput) {
                    const pwd = loadPwd();
                    if (pwd) {
                        pwdInput.value = pwd;
                        pwdInput.dispatchEvent(new Event('input', {bubbles:true}));
                        pwdInput.dispatchEvent(new Event('change', {bubbles:true}));
                        dbg('已自动填写审核密码');
                        await sleep(200);
                        // 点击确定按钮
                        const okBtn = doc.querySelector('#win_AuthLogin a.l-btn, #win_BatchAuthUserLogin a.l-btn');
                        if (okBtn) {
                            jq(okBtn).click();
                            dbg('已点击审核登录确定');
                            await sleep(600);
                            return true;
                        }
                    }
                }
            }
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
        // 点击原生审核按钮（自动处理 CA 登录）
        return await clickNativeAuditButton(iframeWin, 'btn_ReportAuth');
    }

    // --- 初审 ---
    async function simulateNativeInitialReview() {
        let iframeWin = getReportIframeWin();
        if (!iframeWin) iframeWin = await ensureReportPageLoaded();
        if (!iframeWin) return false;
        if (!ensureSelectedGrid(iframeWin)) return false;
        return await clickNativeAuditButton(iframeWin, 'btn_ReportEnt');
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
        return await clickNativeAuditButton(iframeWin, 'btn_ReportAuth');
    }

    // --- 结果分类 ---
    function classifyResultItem(item) {
        // 关键：结果为空/缺失 → UNCERTAIN
        const result = (item.Result || '').trim();
        if (!result || result === '-' || result === '未检' || result === ' ') return 'UNCERTAIN';

        const flag = (item.AbFlag || '').toUpperCase().trim();
        if (flag === 'HH' || flag === 'LL') return 'CRITICAL';  // 危急值
        if (flag === 'H') return 'HIGH';
        if (flag === 'L' || flag === 'N') return 'LOW';
        if (flag === 'A') return 'ABNORMAL';

        // 回退：数值比较
        if (item.ValueLow && item.ValueHigh) {
            const num = parseFloat(result);
            const low = parseFloat(item.ValueLow);
            const high = parseFloat(item.ValueHigh);
            if (!isNaN(num)) {
                if (num > high) return 'HIGH';
                if (num < low) return 'LOW';
            }
        }

        // 无法判断（非数值结果等）→ UNCERTAIN
        if (isNaN(parseFloat(result)) && !flag) {
            return 'UNCERTAIN';
        }

        return 'NORMAL';
    }

    // --- 后台分类所有未审核的完整标本 ---
    async function classifyAllSpecimens() {
        if (wsClassifying) return;
        wsClassifying = true;

        // 筛选需要分类的标本：未审核 + 结果完整 + 未缓存
        const toClassify = wsData.filter(r => {
            const status = String(r.Status || r.ReportStatus || '');
            if (status === '3' || status === '4') return false;
            const complete = String(r.IsComplete || '');
            if (complete !== '1') return false;
            return !wsClassifiedCache[r.ReportDR];
        });

        if (toClassify.length === 0) { wsClassifying = false; return; }

        dbg('开始分类', toClassify.length, '个标本...');

        // 批量分类（每批 8 个）
        for (let i = 0; i < toClassify.length; i += 8) {
            const batch = toClassify.slice(i, i + 8);
            const results = await Promise.all(batch.map(r => fetchAndClassifySpecimen(r)));
            results.forEach(r => {
                if (r && r.reportDR) {
                    wsClassifiedCache[r.reportDR] = r;
                }
            });
            // 每批完成后更新计数和标签
            invalidateCaches();
            calcMachineCounts();
            renderWSCategoryBar();
            await new Promise(r => setTimeout(r, 50)); // 让 UI 有机会更新
        }

        wsClassifying = false;
        dbg('分类完成');
        renderWSCategoryBar();
        renderWSTable();
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

            const data = await fetchJ(CSP + '?' + p.toString());
            const itemInfo = (data && data.ItemInfo) ? data.ItemInfo : [];
            const labInfo = (data && data.LabInfo) ? data.LabInfo : [];

            const classifications = itemInfo.map(item => ({
                name: item.CName || '',
                result: item.Result || '',
                unit: item.Unit || '',
                refRange: item.RefRanges || '',
                abFlag: item.AbFlag || '',
                status: classifyResultItem(item),
                preResult: item.PreResult || null
            }));

            // 传染病历史结果比对（x8 仪器）
            const isInfectionPanel = checkInfectionPanel(row, classifications);
            if (isInfectionPanel) {
                return {
                    status: 'ABNORMAL',
                    items: classifications,
                    labInfo: labInfo[0] || {},
                    row,
                    reportDR,
                    infectionWarning: isInfectionPanel
                };
            }

            // 关键安全检查：无结果 → UNCERTAIN，绝不自动审核
            if (itemInfo.length === 0) {
                return { status: 'UNCERTAIN', items: [], labInfo: labInfo[0] || {}, row, reportDR };
            }

            const hasAbnormal = classifications.some(c => c.status === 'HIGH' || c.status === 'LOW' || c.status === 'ABNORMAL' || c.status === 'CRITICAL');
            const hasUncertain = classifications.some(c => c.status === 'UNCERTAIN');
            const hasComplete = row.IsComplete === '1';
            // 检查是否有结果为空的项目
            const hasEmptyResults = classifications.some(c => !c.result || c.result === '-');

            let overallStatus = 'NORMAL';
            if (hasAbnormal) overallStatus = 'ABNORMAL';
            else if (hasUncertain || !hasComplete || hasEmptyResults) overallStatus = 'UNCERTAIN';

            return {
                status: overallStatus,
                items: classifications,
                labInfo: labInfo[0] || {},
                row,
                reportDR
            };
        } catch(e) {
            dbg('获取标本详情失败:', row.PatName, e);
            return { status: 'UNCERTAIN', items: [], row, reportDR, error: e.message };
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
        if (r.includes('+') || r.includes('阳性') || r.includes('阳')) return true;
        // 数值 > 1（S/CO 值通常 >1 为阳性）
        const num = parseFloat(r);
        if (!isNaN(num) && num > 1) return true;
        return false;
    }

    // 判断是否阴性结果
    function isNegativeResult(result) {
        if (!result) return true;
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
        let normal = 0, abnormal = 0, uncertain = 0;

        // 并发获取（每批10个）
        const allResults = [];
        for (let i = 0; i < toCheck.length; i += 10) {
            const batch = toCheck.slice(i, i + 10);
            const results = await Promise.all(batch.map(r => fetchAndClassifySpecimen(r)));
            allResults.push(...results);
            results.forEach(r => {
                if (r.status === 'NORMAL') normal++;
                else if (r.status === 'ABNORMAL') abnormal++;
                else uncertain++;
            });
        }

        statEl.innerHTML = `
            <span class="st-normal" title="全部正常，可批量审核">正常: ${normal}</span>
            <span class="st-abnormal" title="有异常结果，需人工审核">异常: ${abnormal}</span>
            ${uncertain > 0 ? `<span class="st-uncertain" title="无法判断，需人工审核">待定: ${uncertain}</span>` : ''}
            <span class="st-total">共: ${total}</span>
        `;

        // 保存分类结果供后续使用（复用已获取的数据，不重复请求）
        window._lisClassifiedRows = toCheck;
        window._lisClassifiedResults = allResults;
    }

    // --- 快速审核当前标本 ---
    async function quickAuditCurrent() {
        if (!acquireAuditLock('quickAudit')) return;

        const selected = getNativeSelectedRow();
        if (!selected) {
            releaseAuditLock();
            showToast('请先选择一个标本', 'warning');
            return;
        }

        const pwd = loadPwd();
        if (!pwd) {
            releaseAuditLock();
            showToast('请先设置审核密码（点击 🔐 按钮）', 'warning');
            openPwdDlg();
            return;
        }

        const btn = document.getElementById('lis-tb-quick');
        if (btn) { btn.disabled = true; btn.textContent = '⏳ 审核中...'; }

        try {
            const result = await fetchAndClassifySpecimen(selected);

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

            const auditOK = await simulateNativeAudit();
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
            releaseAuditLock();
            if (btn) { btn.disabled = false; btn.textContent = '⚡ 审核'; }
        }
    }

    // --- 跳转到下一个待审核标本 ---
    function advanceToNextSpecimen() {
        const rows = getNativeDatagridRows();
        const selected = getNativeSelectedRow();
        if (!selected) return;

        const currentIndex = rows.indexOf(selected);
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

        const currentIndex = rows.indexOf(selected);
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
        if (!acquireAuditLock('showBatchDialog')) return;

        const pwd = loadPwd();
        if (!pwd) {
            showToast('请先设置审核密码（点击 🔐 按钮）', 'warning');
            openPwdDlg();
            return;
        }

        const eligible = getAuditEligibleRows();
        if (eligible.length === 0) {
            showToast('没有待审核的标本', 'success');
            return;
        }

        // 显示进度
        showToast(`正在分析 ${eligible.length} 个标本...`, 'warning');

        // 获取所有标本的分类
        const results = [];
        for (let i = 0; i < eligible.length; i += 5) {
            const batch = eligible.slice(i, i + 5);
            const batchResults = await Promise.all(batch.map(r => fetchAndClassifySpecimen(r)));
            results.push(...batchResults);
        }

        const normalSpecimens = results.filter(r => r.status === 'NORMAL');
        const abnormalSpecimens = results.filter(r => r.status === 'ABNORMAL');
        const uncertainSpecimens = results.filter(r => r.status === 'UNCERTAIN');

        // 释放锁（对话框会自己管理审核锁）
        releaseAuditLock();
        // 创建确认对话框
        showAuditConfirmDialog(normalSpecimens, abnormalSpecimens, uncertainSpecimens);
    }

    // --- 显示审核确认对话框 ---
    function showAuditConfirmDialog(normal, abnormal, uncertain) {
        // 兼容旧调用：showAuditConfirmDialog([specimens]) — 走确认对话框
        if (Array.isArray(normal) && abnormal === undefined) {
            const specimens = normal;
            if (specimens.length === 0) { toast('没有可审核的标本', 'w'); return; }
            const formatted = specimens.map(s => ({
                status: 'NORMAL',
                items: [],
                row: s,
                reportDR: s.ReportDR || s.reportDR || ''
            }));
            confirmAndBatchAudit(formatted);
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
                                <span class="ab-name">${r.row.PatName || '未知'}</span>
                                <span class="ab-detail">${r.row.Labno || ''} | ${r.row.TestSetDesc || ''}</span>
                                <span class="ab-tag" style="background:#fce4ec;color:#c62828">⚠ ${names}</span>
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
                            <span class="ab-name">${r.row.PatName || '未知'}</span>
                            <span class="ab-detail">${r.row.Labno || ''} | ${r.row.TestSetDesc || ''}</span>
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
                                <span class="ab-name">${r.row.PatName || '未知'}</span>
                                <span class="ab-detail">${r.row.Labno || ''} | ${r.row.TestSetDesc || ''}</span>
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

        document.getElementById('lis-ab-close').addEventListener('click', () => dialog.remove());
        document.getElementById('lis-ab-cancel').addEventListener('click', () => dialog.remove());
        dialog.addEventListener('click', e => { if (e.target === dialog) dialog.remove(); });

        confirmBtn.addEventListener('click', () => {
            dialog.remove();
            executeBatchAudit(normal).catch(e => {
                console.error('[LIS] 批审异常:', e);
            });
        });

        document.getElementById('lis-ab-export').addEventListener('click', () => {
            exportAuditTrail(normal, abnormal, uncertain);
        });

        // ESC 关闭
        const escHandler = e => {
            if (e.key === 'Escape') {
                dialog.remove();
                document.removeEventListener('keydown', escHandler);
            }
        };
        document.addEventListener('keydown', escHandler);
    }

    // --- 按 ReportDR 在原生 datagrid 中选中行 ---
    function selectNativeRowByReportDR(iframeWin, reportDR) {
        const jq = iframeWin.jQuery || iframeWin.$;
        if (!jq) { dbg('selectNativeRow: jq 不存在'); return false; }
        const selectors = ['#dgWorkList', '#dg', '#dgReport', '.datagrid-f'];
        for (const sel of selectors) {
            const el = jq(sel);
            if (el.length && el.datagrid) {
                try {
                    const rows = el.datagrid('getRows');
                    if (!rows || rows.length === 0) { dbg('selectNativeRow:', sel, '无行数据'); continue; }
                    for (let i = 0; i < rows.length; i++) {
                        if (String(rows[i].ReportDR) === String(reportDR)) {
                            el.datagrid('selectRow', i);
                            dbg('选中原生行:', i, 'ReportDR:', reportDR, 'selector:', sel);
                            return true;
                        }
                    }
                    dbg('selectNativeRow:', sel, '未找到 ReportDR:', reportDR, '共', rows.length, '行, 列表:', rows.slice(0,5).map(r => r.ReportDR).join(','));
                } catch(e) { dbg('selectNativeRow error:', sel, e); }
            }
        }
        dbg('selectNativeRow: 所有选择器都未找到 datagrid');
        return false;
    }

    // --- 执行批量审核（使用原生审核按钮，安全）---
    async function executeBatchAudit(normalSpecimens) {
        if (normalSpecimens.length === 0) return;
        if (!acquireAuditLock('batchAudit')) { showToast('正在审核中，请稍候', 'warning'); return; }
        await ensureCAAuthenticated();

        // 显示进度条
        const progress = document.createElement('div');
        progress.id = 'lis-audit-progress';
        progress.innerHTML = `
            <div style="font-size:16px;font-weight:600;color:#2c3e50;margin-bottom:8px">正在审核...</div>
            <div class="prog-bar"><div class="prog-fill" id="lis-prog-fill" style="width:0%"></div></div>
            <div class="prog-text" id="lis-prog-text">0 / ${normalSpecimens.length}</div>
        `;
        document.body.appendChild(progress);
        progress.classList.add('show');

        try {
            let iframeWin = getReportIframeWin();
            if (!iframeWin) {
                showToast('正在加载报告页面...', 'warning');
                iframeWin = await ensureReportPageLoaded();
            }
            if (!iframeWin) {
                showToast('❌ 未找到报告处理页面', 'error');
                releaseAuditLock();
                progress.remove();
                return;
            }

            // 等待 iframe 就绪（jq 和 me 可能还没加载）
            let jq = iframeWin.jQuery || iframeWin.$;
            let me = iframeWin.me;
            if (!jq || !me) {
                dbg('等待 iframe 就绪...');
                for (let w = 0; w < 20; w++) {
                    await new Promise(r => setTimeout(r, 500));
                    iframeWin = getReportIframeWin();
                    if (iframeWin) {
                        jq = iframeWin.jQuery || iframeWin.$;
                        me = iframeWin.me;
                        if (jq && me) break;
                    }
                }
            }
            if (!jq || !me) {
                showToast('报告页面未就绪，请稍后重试', 'error');
                dbg('批审失败: jq=', !!jq, 'me=', !!me);
                releaseAuditLock();
                progress.remove();
                return;
            }

            // 构建允许审核的 ReportDR 白名单 —— 只有列表中的才能审核
            const allowedReportDRs = new Set();
            for (const sp of normalSpecimens) {
                const rdr = sp.reportDR || (sp.row && sp.row.ReportDR);
                if (rdr) allowedReportDRs.add(String(rdr));
            }
            dbg('批审白名单:', allowedReportDRs.size, '个 ReportDR');

            let successCount = 0;
            let failCount = 0;
            let skipCount = 0;

            closeCAWindow(iframeWin);

            // 按仪器分组（不同仪器需要切换 iframe 的工作列表）
            const groups = {};
            for (const sp of normalSpecimens) {
                const row = sp.row || {};
                const mdr = row._mdr || row.WorkGroupMachineDR || '';
                if (!groups[mdr]) groups[mdr] = [];
                groups[mdr].push(sp);
            }
            const machineKeys = Object.keys(groups);
            dbg('批审分组:', machineKeys.length, '个仪器', machineKeys);

            let globalIdx = 0;
            for (const mdr of machineKeys) {
                const group = groups[mdr];

                // 切换 iframe 到该仪器的工作列表
                if (machineKeys.length > 1 || group[0].row._mdr) {
                    dbg('切换到仪器:', mdr);
                    try {
                        // 设置 iframe 的仪器选择
                        if (me.WorkGroupMachineDR !== undefined) me.WorkGroupMachineDR = mdr;
                        // 尝试设置 combogrid
                        try { jq('#cmb_WorkGroupMachine').combogrid('setValue', mdr); } catch(e) {}
                        // 触发工作列表刷新（使用 iframeWin 而不是 uw()）
                        const dateStr = jq('#dt_wlReportDate').length ? 
                            (jq('#dt_wlReportDate').datebox('getValue') || today()) : today();
                        const findStr = '&WorkGroupMachineDR=' + mdr + '&ReportStatus=&SttAccDate=' + dateStr;
                        if (typeof iframeWin.ShowWorkList === 'function') {
                            iframeWin.ShowWorkList(findStr);
                        } else if (typeof iframeWin.FindFast === 'function') {
                            iframeWin.FindFast(findStr);
                        }
                        // 等待工作列表加载完成
                        await new Promise(r => setTimeout(r, 1200));
                        // 刷新 iframe 引用（切换后可能重载）
                        iframeWin = getReportIframeWin();
                        if (iframeWin) {
                            jq = iframeWin.jQuery || iframeWin.$;
                            me = iframeWin.me;
                        }
                        // 等待 datagrid 数据加载
                        if (jq) {
                            for (let w = 0; w < 3; w++) {
                                try {
                                    const testRows = jq('#dgWorkList').datagrid('getRows');
                                    if (testRows && testRows.length > 0) break;
                                } catch(e) {}
                                await new Promise(r => setTimeout(r, 500));
                            }
                        }
                    } catch(e) {
                        dbg('切换仪器失败:', mdr, e);
                    }
                }

                for (const specimen of group) {
                    // 每次审核前重新获取 iframe 引用
                    if (!jq || !me) {
                        iframeWin = getReportIframeWin();
                        if (iframeWin) {
                            jq = iframeWin.jQuery || iframeWin.$;
                            me = iframeWin.me;
                        }
                    }
                    if (!jq || !me) {
                        dbg('批审跳过: iframe 未就绪', specimen.row && specimen.row.PatName);
                        skipCount++;
                        continue;
                    }
                    const reportDR = specimen.reportDR || (specimen.row && specimen.row.ReportDR);
                    const row = specimen.row || {};

                    // 更新进度
                    globalIdx++;
                    const fill = document.getElementById('lis-prog-fill');
                    const text = document.getElementById('lis-prog-text');
                    if (fill) fill.style.width = ((globalIdx / normalSpecimens.length) * 100) + '%';
                    if (text) text.textContent = `${globalIdx} / ${normalSpecimens.length} - ${row.PatName || ''}`;

                    // 安全校验1: reportDR 不能为空
                    if (!reportDR) {
                        dbg('批审跳过: reportDR 为空', row.PatName);
                        skipCount++;
                        continue;
                    }

                    // 安全校验2: 必须在白名单中
                    if (!allowedReportDRs.has(String(reportDR))) {
                        dbg('批审拦截: reportDR', reportDR, '不在白名单中!');
                        skipCount++;
                        continue;
                    }

                    // 安全校验3: 危急值不能批审
                    const cached = wsClassifiedCache[reportDR];
                    if (cached && cached.status === 'CRITICAL') {
                        dbg('批审跳过: 危急值', row.PatName);
                        skipCount++;
                        continue;
                    }

                    // 安全校验4: 结果必须完整
                    const complete = String(row.IsComplete || '');
                    if (complete !== '1') {
                        dbg('批审跳过: 结果不完整', row.PatName, 'IsComplete=', complete);
                        skipCount++;
                        continue;
                    }

                    // 安全校验5: 不能是已审核状态
                    const status = String(row.Status || row.ReportStatus || '');
                    if (status === '3' || status === '4') {
                        dbg('批审跳过: 已审核/复审', row.PatName, 'Status=', status);
                        skipCount++;
                        continue;
                    }

                    try {
                        // 在原生 datagrid 中选中该标本的行
                        const selected = selectNativeRowByReportDR(iframeWin, reportDR);
                        if (!selected) {
                            dbg('批审跳过: 原生列表中未找到', row.PatName, 'ReportDR:', reportDR);
                            skipCount++;
                            continue;
                        }
                        // 等待行选中后表单加载
                        await new Promise(r => setTimeout(r, 300));

                        // 点击原生审核按钮（自动处理 CA、不完整提示等）— 带 10 秒超时
                        const auditResult = await Promise.race([
                            clickNativeAuditButton(iframeWin, 'btn_ReportAuth'),
                            new Promise((_, rej) => setTimeout(() => rej(new Error('审核超时(10s)')), 10000))
                        ]);
                        if (auditResult === 'incomplete') {
                            dbg('批审跳过: 结果不完整', row.PatName);
                            skipCount++;
                        } else if (auditResult) {
                            successCount++;
                            dbg('批审成功:', row.PatName, 'ReportDR:', reportDR);
                        } else {
                            failCount++;
                            dbg('批审失败:', row.PatName);
                        }
                    } catch(e) {
                        failCount++;
                        dbg('批审异常:', row.PatName, e.message);
                    } finally {
                        // 无论成功失败，都刷新 iframe 引用
                        await new Promise(r => setTimeout(r, 300));
                        try {
                            iframeWin = getReportIframeWin();
                            if (iframeWin) {
                                jq = iframeWin.jQuery || iframeWin.$;
                                me = iframeWin.me;
                            }
                        } catch(e) {}
                    }
                }
            }

            const fill = document.getElementById('lis-prog-fill');
            const text = document.getElementById('lis-prog-text');
            if (fill) fill.style.width = '100%';
            if (text) text.textContent = `完成: ${successCount} 成功, ${failCount} 失败`;

            if (successCount > 0) {
                const skipMsg = skipCount > 0 ? `，跳过 ${skipCount} 个` : '';
                const failMsg = failCount > 0 ? `，${failCount} 个失败` : '';
                showToast(`✅ 已审核 ${successCount} 个标本${skipMsg}${failMsg}`, 'success');
            } else {
                showToast('❌ 审核全部失败', 'error');
            }

            setTimeout(() => {
                progress.remove();
                loadWSData();
            }, 2000);

        } catch(e) {
            dbg('批量审核失败:', e);
            showToast('审核失败: ' + e.message, 'error');
        } finally {
            releaseAuditLock();
            // 确保进度条被清理（如果 try 中途 return）
            setTimeout(() => {
                const p = document.getElementById('lis-audit-progress');
                if (p) p.remove();
            }, 3000);
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
            r.status === 'NORMAL' ? '正常' : r.status === 'ABNORMAL' ? '异常' : '待定',
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
        URL.revokeObjectURL(url);
        showToast('已导出审核清单', 'success');
    }

    // --- Toast 提示（审核专用）---
    function showToast(msg, type = 'success') {
        const el = document.createElement('div');
        el.className = 'lis-audit-toast ' + type;
        el.textContent = msg;
        document.body.appendChild(el);
        setTimeout(() => el.remove(), 3000);
    }

    // --- 键盘快捷键注册 ---
    function registerAuditShortcuts() {
        document.addEventListener('keydown', e => {
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
            // 搜索所有可能的按钮元素
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

        // 递归搜索所有 iframe
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

        // 搜索所有全局函数
        const funcNames = [];
        for (const key of Object.keys(w)) {
            if (typeof w[key] === 'function' && /audit|sign|sub|save|check|confirm|report|login|auth|review/i.test(key)) {
                funcNames.push(key);
            }
        }
        dbg('全局函数: ' + funcNames.join(', '));

        // injectToolbar(); // 已禁用：不需要顶部原生工具栏
        // updateToolbarStats(); // 已禁用：工具栏已移除
        registerAuditShortcuts();
        // setInterval(updateToolbarStats, 30000); // 已禁用

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
        dbg('iMedicalLIS 增强助手 v7.0.0');
        dbg('隐私模式：所有数据仅本地处理，无任何上传');
        dbg('========================================');

        initAuth();

        if (isAuthPage()) return; // 在审核登录 iframe 中，只做密码填充

        if (isLoginPage()) {
            initLoginPage();
            return;
        }

        // 检测是否在主框架中（非 iframe）
        // UI 和工作组切换功能只在主框架中运行
        let _isMain = false;
        try { _isMain = (window === window.top) || !!document.getElementById('sl_changeworkgroup'); } catch(e) {}

        if (!_isMain) {
            // iframe 中只做认证，不创建 UI
            dbg('iframe 中运行，跳过 UI');
            return;
        }

        // initQBar(); // 已禁用：不需要顶部快速切换条
        createWS();
        checkNavigateTarget();
        initReportEnhance();
        initQCPanel();

        dbg('就绪 | 左键🔬=工作组 | 右键🔬=全科 | Ctrl+Shift+L/A');
    }

    if (document.readyState==='complete') init();
    else window.addEventListener('load', init);

})();
