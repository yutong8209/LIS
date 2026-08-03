// ==UserScript==
// @name         iMedicalLIS 增强助手
// @namespace    lis-enhancer-local
// @version      8.5.4
// @description  报告审核增强 — 批量审核 + 审核工作台 + 病人结果筛选导出（含外送/费用） + 质控录入辅助 + 质控数据导出 + 热键（纯本地运行，无任何上传）
// @author       LIS-Enhancer
// @match        http://10.0.29.100/iMedicalLIS/*
// @match        http://192.168.31.111:9111/iMedicalLIS/*
// @grant        GM_addStyle
// @grant        unsafeWindow
// @updateURL    http://localhost:8765/iMedicalLIS-enhancer.user.js
// @downloadURL  http://localhost:8765/iMedicalLIS-enhancer.user.js
// @run-at       document-idle
// @noframes     false
// @require      http://localhost:8765/vendor/xlsx.full.min.js
// @require      http://localhost:8765/vendor/jszip.min.js

// ==/UserScript==

(function () {
  'use strict';

  /* ============================================================
       🔒 隐私声明
       - 业务数据仅在本地浏览器内处理，不向公网上传检验结果
       - 仅与本院 LIS 内网通信；脚本更新/SheetJS 走本机 localhost:8765
       - 密码：HTTP 内网无 crypto.subtle 时用 base64 可逆编码存 localStorage
         （防顺手扫一眼，不能防读脚本的攻击者）。HTTPS 下可升为 AES-GCM V2
       - 请勿在共享电脑勾选「记住密码」；可用设置清除已存密码
       ============================================================ */

  // ==================== 常量 ====================
  const BASE = location.origin + '/iMedicalLIS';
  const CSP = BASE + '/csp/jquery.easyui.dhcclassjson.csp';
  const WGM = BASE + '/sys/ashx/ashBTWorkGroupMachine.ashx';
  const RPT = BASE + '/sys/ashx/ashReportCommon.ashx';

  const NATIVE_WORKLIST_SEL = '#dgWorkList';
  const DATAGRID_SELECTORS = [NATIVE_WORKLIST_SEL, '#dg', '#dgReport', '.datagrid-f'];
  const DATAGRID_SELECTORS_EXTENDED = [
    '#dg',
    '#dgReport',
    '.datagrid-f',
    'table.datagrid-f',
    '#workList',
    '.datagrid-view'
  ];

  // 审核工作台 / 质控：只含本科室自检组（不含外送）
  const WG = [
    { dr: '1', name: '临检', color: '#e74c3c', icon: '🩸' },
    { dr: '3', name: '生化', color: '#3498db', icon: '🧪' },
    { dr: '4', name: '免疫', color: '#2ecc71', icon: '🛡️' }
  ];
  // 仅「病人结果筛选导出」追加：外送标本（第三方回传结果，需对账金额；不进审核/质控台）
  const WG_EXPORT_ONLY = [{ dr: '5', name: '外送', color: '#9b59b6', icon: '📦' }];
  const WG_EXPORT = WG.concat(WG_EXPORT_ONLY);
  const WG_MAP = {};
  WG_EXPORT.forEach(w => {
    WG_MAP[w.dr] = w;
  });

  const REFRESH = 30000;
  const K = {
    au: 'LIS_AuInfo_Persist',
    ent: 'LIS_EntryInfo_Persist',
    pwd: 'LIS_AuthPwd_Persist',
    tgt: 'LIS_NavigateTarget',
    caPwd: 'LIS_CAPwd_Persist',
    caAuth: 'LIS_CAAuth_Persist',
    auditQueue: 'LIS_AuditQueue_Persist',
    auditQueueLock: 'LIS_AuditQueueLock',
    wsState: 'LIS_WSState_Persist'
  };
  const CLASSIFY_STALE_MS = 30 * 60 * 1000;
  const SCRIPT_VERSION = (typeof GM_info !== 'undefined' && GM_info.script && GM_info.script.version) || '7.61.1';
  const WS_REOPEN_KEY = 'LIS_WS_ReopenAfterReload';
  // 质控 Excel/ZIP 依赖本地 serve（@require 可能因未启动服务失败，导出时再补拉）
  const VENDOR_BASE = 'http://127.0.0.1:8765/vendor';
  const AUDIT_QUEUE_LOCK_TTL = 45000;
  // 批审单条硬超时（秒审 / 需 CA）；超时后二次校验，仍无果则跳过/重试，避免整批卡死
  // 秒审 / 首条 CA 后确认都宜短：真漏审靠队尾重试+补审，不靠首条空等十几秒
  const BATCH_ITEM_DEADLINE_MS = { caReady: 8000, needCA: 28000 };
  const BATCH_CONFIRM_MS = { normal: 1500, afterCA: 2500 };

  // ==================== 工具 ====================
  const $ = s => document.querySelector(s);
  const $$ = s => document.querySelectorAll(s);
  const uw = () => {
    try {
      return unsafeWindow;
    } catch (e) {
      return window;
    }
  };
  const getUIWindow = () => {
    try {
      return window.top || window;
    } catch (e) {
      return window;
    }
  };
  const getUIDoc = () => {
    try {
      return getUIWindow().document;
    } catch (e) {
      return document;
    }
  };
  const g = k => {
    try {
      return uw()[k];
    } catch (e) {
      return undefined;
    }
  };
  const ssDR = () => g('SessionStr') || '';
  const wgDR = () => g('WorkGroupDR') || '';
  const uid = () => {
    const s = ssDR();
    return s ? s.split('^')[0] : g('LoginUserDR') || '';
  };
  const uname = () => g('LoginUserName') || '';
  const buildSS = dr => uid() + '^' + dr + '^0^8^1';
  const today = () => {
    const d = new Date();
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  };
  // 旧版 base64 编码（保持向后兼容）
  const encPwd = p => {
    try {
      return btoa(unescape(encodeURIComponent(p)));
    } catch (e) {
      return p;
    }
  };
  const decPwd = e => {
    try {
      if (!e || e.startsWith('V2:')) {return '';}
      return decodeURIComponent(escape(atob(e)));
    } catch (e) {
      return '';
    }
  };
  const isPatientResultPanelEvent = e => {
    const t = e && e.target;
    return !!(t && t.closest && t.closest('#lis-pr-panel'));
  };
  const isEditableEventTarget = e => {
    const t = e && e.target;
    if (!t) {return false;}
    const tag = String(t.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || !!t.isContentEditable;
  };
  // 异常工作台 Enter 审核：仅忽略本工作台内的可编辑控件，不拦截 LIS 报告页 iframe 里的输入框
  const shouldIgnoreAbnormalKeyEvent = e => {
    if (isPatientResultPanelEvent(e)) {return true;}
    const t = e && e.target;
    if (!t || !t.closest) {return false;}
    if (t.closest('#lis-pr-panel')) {return true;}
    if (t.closest('#lis-detail-panel')) {return isEditableEventTarget(e);}
    if (t.closest('#lis-ws-search')) {return true;}
    return false;
  };

  // ==================== AES-GCM 密码加密 ====================
  // 威胁模型：密钥硬编码在脚本中，能读取脚本源码的攻击者可解密。
  // 比 base64 强在：PBKDF2 派生增加逆向成本 + 随机 IV 防止相同密码产生相同密文。
  // 注意：crypto.subtle 仅在 secure context（HTTPS 或 localhost）下可用。
  // 非安全上下文（如 http://10.x.x.x）会自动回退到 base64。
  const _cryptoAvailable = !!(typeof crypto !== 'undefined' && crypto.subtle && crypto.subtle.importKey);
  let _cryptoKey = null;
  async function getCryptoKey() {
    if (!_cryptoAvailable) {return null;}
    if (_cryptoKey) {return _cryptoKey;}
    try {
      const enc = new TextEncoder();
      // salt 加入 uid() 使每个用户的密钥不同，避免同 origin 共享密钥
      const seed = enc.encode('lis-enhancer-v8-salt-' + uid());
      const km = await crypto.subtle.importKey('raw', seed, 'PBKDF2', false, ['deriveKey']);
      _cryptoKey = await crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt: enc.encode(location.origin), iterations: 100000, hash: 'SHA-256' },
        km,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt']
      );
      return _cryptoKey;
    } catch (e) {
      return null;
    }
  }
  function toB64(buf) {
    const bytes = new Uint8Array(buf);
    let s = '';
    for (let i = 0; i < bytes.length; i++) {s += String.fromCharCode(bytes[i]);}
    return btoa(s);
  }
  function fromB64(str) {
    const bin = atob(str);
    const buf = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) {buf[i] = bin.charCodeAt(i);}
    return buf;
  }
  async function encPwdV2(plain) {
    const key = await getCryptoKey();
    if (!key) {console.warn('[LIS] crypto.subtle 不可用，密码将以 base64 降级存储（非加密）');return encPwd(plain);} // crypto 不可用，直接 base64
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plain));
    return 'V2:' + toB64(iv) + ':' + toB64(ct);
  }
  async function decPwdV2(stored) {
    if (!stored) {return '';}
    if (stored.startsWith('V2:')) {
      const key = await getCryptoKey();
      if (!key) {return '';} // crypto 不可用，无法解密 V2
      try {
        const parts = stored.slice(3).split(':');
        const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromB64(parts[0]) }, key, fromB64(parts[1]));
        return new TextDecoder().decode(pt);
      } catch (e) {
        return '';
      }
    }
    if (stored.startsWith('B64:')) {return decPwd(stored.slice(4));}
    return decPwd(stored); // 旧格式
  }
  // 清除无法解密的 V2 数据（crypto 不可用时）
  function repairPwdStorage() {
    if (_cryptoAvailable) {return;}
    [K.pwd, K.caPwd].forEach(k => {
      const v = localStorage.getItem(k);
      if (v && v.startsWith('V2:')) {
        dbg('清除无法解密的 V2 密码:', k);
        localStorage.removeItem(k);
      }
    });
  }

  // 同步 API（保持向后兼容，用于非 async 上下文）
  const savePwd = p => {
    try {
      localStorage.setItem(K.pwd, encPwd(p));
    } catch (e) {
      dbg('savePwd 失败:', e.message);
    }
  };
  const loadPwd = () => {
    try {
      const v = localStorage.getItem(K.pwd);
      return v ? decPwd(v) : '';
    } catch (e) {
      return '';
    }
  };
  const saveCAPwd = p => {
    try {
      localStorage.setItem(K.caPwd, encPwd(p));
    } catch (e) {
      dbg('saveCAPwd 失败:', e.message);
    }
  };
  const loadCAPwd = () => {
    try {
      const v = localStorage.getItem(K.caPwd);
      return v ? decPwd(v) : '';
    } catch (e) {
      return '';
    }
  };

  // 异步 API（AES-GAM 加密，用于 async 上下文）
  async function savePwdAsync(p) {
    try {
      localStorage.setItem(K.pwd, await encPwdV2(p));
    } catch (e) {
      savePwd(p);
    }
  }
  async function loadPwdAsync() {
    try {
      const v = localStorage.getItem(K.pwd);
      return v ? await decPwdV2(v) : '';
    } catch (e) {
      return loadPwd();
    }
  }
  async function saveCAPwdAsync(p) {
    try {
      localStorage.setItem(K.caPwd, await encPwdV2(p));
    } catch (e) {
      saveCAPwd(p);
    }
  }
  async function loadCAPwdAsync() {
    try {
      const v = localStorage.getItem(K.caPwd);
      return v ? await decPwdV2(v) : '';
    } catch (e) {
      return loadCAPwd();
    }
  }
  async function migratePwdStorage() {
    if (!_cryptoAvailable) {
      repairPwdStorage();
      return;
    }
    try {
      const pwd = loadPwd();
      if (pwd && !localStorage.getItem(K.pwd)?.startsWith('V2:')) {await savePwdAsync(pwd);}
      const caPwd = loadCAPwd();
      if (caPwd && !localStorage.getItem(K.caPwd)?.startsWith('V2:')) {await saveCAPwdAsync(caPwd);}
    } catch (e) {
      dbg('migratePwdStorage 失败:', e.message);
    }
  }
  const saveCAAuth = dr => {
    try {
      localStorage.setItem(K.caAuth, JSON.stringify({ time: Date.now(), wg: dr || wgDR() }));
    } catch (e) {
      dbg('saveCAAuth 失败:', e.message);
    }
  };
  const CA_AUTH_TTL = 8 * 60 * 60 * 1000; // CA 认证 8 小时过期
  const loadCAAuth = () => {
    try {
      const v = localStorage.getItem(K.caAuth);
      if (!v) {return null;}
      const o = JSON.parse(v);
      if (o && o.time && Date.now() - o.time > CA_AUTH_TTL) {
        dbg('CA 认证已过期（超过 8 小时），自动清除');
        clearCAAuth();
        return null;
      }
      return o;
    } catch (e) {
      return null;
    }
  };
  const clearCAAuth = () => {
    try {
      localStorage.removeItem(K.caAuth);
    } catch (e) {
      dbg('clearCAAuth 失败:', e.message);
    }
  };
  const esc = s =>
    String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  const escAttr = s => esc(s);
  // 通过原生 setter 设置 input 值（兼容 EasyUI/React 等框架）
  function setNativeInputValue(el, value) {
    try {
      // 尝试使用所属 document 的原生 setter
      let win = el.ownerDocument ? el.ownerDocument.defaultView : window;
      if (!win) {win = window;}
      const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, 'value');
      if (setter && setter.set) {
        el.focus();
        setter.set.call(el, value);
      } else {
        el.focus();
        el.value = value;
      }
    } catch (e) {
      el.focus();
      el.value = value;
    }
    el.dispatchEvent(new Event('focus', { bubbles: true }));
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    el.dispatchEvent(new Event('blur', { bubbles: true }));
  }

  // ==================== 调试日志 ====================
  const DEBUG = false;
  const _dbgLog = [];
  const dbg = (...args) => {
    if (DEBUG) {
      const msg = args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ');
      console.log('[LIS]', msg);
      _dbgLog.push(msg);
      if (_dbgLog.length > 500) {_dbgLog.splice(0, _dbgLog.length - 500);}
    }
  };
  // 在页面底部显示调试面板（Alt+D 切换）
  function showDebugPanel() {
    let panel = document.getElementById('lis-debug-panel');
    if (panel) {
      panel.remove();
      return;
    }
    panel = document.createElement('div');
    panel.id = 'lis-debug-panel';
    panel.style.cssText =
      'position:fixed;bottom:0;left:0;right:0;z-index:999999;background:#1e1e1e;color:#0f0;font:12px monospace;padding:10px;max-height:40vh;overflow:auto';
    panel.innerHTML = '<b>LIS Debug Log (Alt+D 关闭)</b><br>' + _dbgLog.map(l => esc(l)).join('<br>');
    document.body.appendChild(panel);
  }

  async function fetchJ(u, timeoutMs, externalSignal) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs || 15000);
    let externalAbort = null;
    try {
      if (externalSignal) {
        if (externalSignal.aborted) {ctrl.abort();}
        else {
          externalAbort = () => ctrl.abort();
          externalSignal.addEventListener('abort', externalAbort, { once: true });
        }
      }
      const r = await fetch(u, { credentials: 'same-origin', signal: ctrl.signal });
      if (!r.ok) {throw new Error('HTTP ' + r.status);}
      const text = await r.text();
      const trimmed = text.trim().replace(/^\uFEFF/, '');
      if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) {
        const hint = trimmed.length > 100 ? trimmed.slice(0, 100) + '...' : trimmed;
        dbg('非JSON响应:', r.status, r.headers.get('content-type'), hint);
        throw new Error(
          trimmed.includes('<html') || trimmed.includes('<!DOCTYPE')
            ? '会话可能已过期，请刷新页面重新登录'
            : '非JSON响应'
        );
      }
      return JSON.parse(trimmed);
    } catch (e) {
      if (e.name === 'AbortError') {dbg(externalSignal && externalSignal.aborted ? 'fetch 已取消:' : 'fetch 超时:', u);}
      else {console.error('[LIS] fetch error:', e);}
      throw e;
    } finally {
      clearTimeout(timer);
      if (externalSignal && externalAbort) {externalSignal.removeEventListener('abort', externalAbort);}
    }
  }

  async function fetchJRetry(u, timeoutMs, externalSignal, tries, gapMs) {
    const maxTries = Math.max(1, tries || 1);
    for (let i = 1; i <= maxTries; i += 1) {
      try {
        return await fetchJ(u, timeoutMs, externalSignal);
      } catch (e) {
        if (e.name === 'AbortError' || i >= maxTries) {throw e;}
        await new Promise(r => setTimeout(r, gapMs || 250));
      }
    }
    return null;
  }

  // 高亮搜索文本（自动转义防 XSS，缓存正则）
  let _hlQuery = '',
    _hlRegex = null;
  function highlightText(text, query) {
    if (!query || !text) {return esc(text || '');}
    const safe = esc(text);
    if (query !== _hlQuery) {
      _hlQuery = query;
      _hlRegex = new RegExp('(' + query.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + ')', 'gi');
    }
    return safe.replace(_hlRegex, '<span class="lis-highlight">$1</span>');
  }

  // ==================== 样式 ====================
  GM_addStyle(`
/* === Design Tokens === */
:root{
  --lis-primary:#c8956c;
  --lis-primary-hover:#b5845a;
  --lis-primary-light:#fffbeb;
  --lis-primary-lighter:#fef9ee;
  --lis-bg:#faf8f5;
  --lis-surface:#fffdfb;
  --lis-border:#e7e0d8;
  --lis-border-light:#f0ebe5;
  --lis-text:#292524;
  --lis-text-secondary:#78716c;
  --lis-text-muted:#a8a29e;
  --lis-success:#16a34a;
  --lis-warning:#d4a574;
  --lis-error:#dc2626;
  --lis-info:#c8956c;
  --lis-wg-hemato:#dc2626;
  --lis-wg-chemo:#c8956c;
  --lis-wg-immuno:#16a34a;
  --lis-wg-outsrc:#7c3aed;
  --lis-font:-apple-system,BlinkMacSystemFont,'SF Pro Text','PingFang SC','Helvetica Neue','Microsoft YaHei',sans-serif;
}

/* --- 浮动按钮 --- */
#lis-fab{position:fixed;bottom:80px;right:20px;z-index:99999;width:64px;height:64px;border-radius:50%;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;border:none;cursor:pointer;font-size:26px;box-shadow:0 4px 14px rgba(0,0,0,.18);transition:transform .3s,box-shadow .3s;display:flex;align-items:center;justify-content:center;user-select:none}
#lis-fab:hover{transform:scale(1.04);box-shadow:0 6px 20px rgba(102,126,234,.5)}
#lis-fab:active{cursor:grabbing}
#lis-fab-tip{position:fixed;bottom:84px;right:20px;z-index:99998;background:rgba(0,0,0,.8);color:#fff;padding:6px 12px;border-radius:6px;font-size:11px;pointer-events:none;opacity:0;transition:.3s;white-space:pre-line}
#lis-fab-tip.show{opacity:1}

/* --- 病人结果筛选导出 --- */
#lis-pr-fab{position:fixed;right:20px;bottom:152px;z-index:99999;width:52px;height:52px;border-radius:50%;border:none;background:#a87548;color:#fff;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 2px 10px rgba(0,0,0,.15);display:flex;align-items:center;justify-content:center;user-select:none;transition:transform .15s}
#lis-pr-fab:hover{background:#c8956c;transform:none}
#lis-pr-panel{position:fixed!important;inset:0!important;z-index:100006!important;background:var(--lis-bg);display:none;flex-direction:column;font-family:var(--lis-font);color:var(--lis-text)}
#lis-pr-panel.show{display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important}
#lis-pr-hd{height:40px;display:flex;align-items:center;gap:8px;padding:0 12px;background:var(--lis-primary-lighter);border-bottom:1px solid var(--lis-border);flex-shrink:0}
#lis-pr-hd h3{margin:0;font-size:14px;color:var(--lis-primary);white-space:nowrap;font-weight:800}
#lis-pr-hd .pr-spacer{flex:1}
#lis-pr-hd button,#lis-pr-tools button{height:26px;border:1px solid var(--lis-border);background:var(--lis-surface);color:var(--lis-primary);border-radius:4px;padding:0 10px;font-size:11px;font-weight:700;cursor:pointer}
#lis-pr-hd button:hover,#lis-pr-tools button:hover{background:var(--lis-primary-lighter);border-color:var(--lis-primary-hover)}
#lis-pr-hd .pr-close{font-size:18px;line-height:20px;padding:0 8px;color:#a8a29e}
/* 筛选区可滚动；底部操作条固定不挤出视口 */
#lis-pr-tools{display:flex;flex-direction:column;background:var(--lis-surface);border-bottom:1px solid var(--lis-border);flex-shrink:0;max-height:42vh;overflow:hidden;padding:0}
#lis-pr-tools-scroll{display:flex;flex-wrap:wrap;align-items:flex-end;gap:6px 8px;padding:6px 10px;overflow-y:auto;overflow-x:hidden;flex:1 1 auto;min-height:0}
#lis-pr-tools label{display:flex;flex:0 0 auto;flex-direction:column;gap:3px;font-size:10px;color:#78716c;font-weight:700;line-height:1.05;white-space:nowrap}
#lis-pr-tools input,#lis-pr-tools select{width:100%;height:26px;box-sizing:border-box;border:1px solid #ddd6ce;border-radius:4px;padding:2px 7px;font-size:12px;color:#292524;background:#fffdfb;outline:none}
#lis-pr-tools input:focus,#lis-pr-tools select:focus{border-color:#c8956c;box-shadow:0 0 0 2px rgba(200,149,108,.12)}
#lis-pr-tools .pr-date{width:126px}
#lis-pr-tools .pr-xs{width:76px}
#lis-pr-tools .pr-sm{width:104px}
#lis-pr-tools .pr-md{width:132px}
#lis-pr-tools .pr-lg{width:168px}
/* 工作组/仪器：整行铺开 + 自动换行，四组（含外送）一次看全，无需横拖 */
#lis-pr-tools .pr-mach-tree-wrap{flex:1 1 100%;width:100%;max-width:100%;align-self:stretch}
#lis-pr-machine-tree{display:flex;flex-wrap:wrap;gap:6px;align-items:stretch;border:1px solid #ddd6ce;border-radius:4px;background:#fffdfb;padding:6px;min-height:48px;max-height:120px;overflow:auto}
.pr-wg-box{border:1px solid #e7e0d8;border-radius:4px;background:#fef9ee;min-width:140px;max-width:200px;flex:1 1 140px}
.pr-wg-box[data-wg="1"]{border-top:2px solid #dc2626}
.pr-wg-box[data-wg="3"]{border-top:2px solid #c8956c}
.pr-wg-box[data-wg="4"]{border-top:2px solid #16a34a}
.pr-wg-box[data-wg="5"]{border-top:2px solid #7c3aed}
.pr-wg-head{height:22px;display:flex;align-items:center;gap:5px;padding:0 7px;font-size:11px;font-weight:800;color:#a87548;cursor:pointer;border-bottom:1px solid #f0ebe5;user-select:none}
.pr-wg-head input{width:12px!important;height:12px!important;margin:0}
.pr-wg-body{padding:4px 6px;display:flex;flex-direction:column;gap:3px;max-height:72px;overflow:auto}
.pr-wg-box.collapsed .pr-wg-body{display:none}
.pr-mach-option{display:flex!important;flex-direction:row!important;align-items:center;gap:5px;font-size:11px!important;font-weight:600!important;color:#44403c!important;line-height:1.2!important;white-space:nowrap;max-width:180px;overflow:hidden;text-overflow:ellipsis}
.pr-mach-option input{width:12px!important;height:12px!important;margin:0}
#lis-pr-tools .pr-wide{width:208px}
#lis-pr-tools .pr-xl{width:220px}
#lis-pr-tools .pr-section{flex:1 0 100%;display:flex;align-items:center;margin:2px 0 0;padding:3px 8px;font-size:11px;font-weight:600;color:var(--lis-text-secondary);background:transparent;border:none;border-bottom:1px solid var(--lis-border-light);border-radius:0}
#lis-pr-tools .pr-section:first-child{margin-top:0}
#lis-pr-tools .pr-actions{display:flex;flex:0 0 auto;align-items:center;justify-content:flex-end;gap:8px;width:100%;margin:0;padding:6px 10px;min-width:0;box-sizing:border-box;background:#faf5ef;border-top:1px solid #e7e0d8}
#lis-pr-tools .pr-actions button{min-width:72px;height:30px;font-size:12px}
#lis-pr-tools #lis-pr-query{background:var(--lis-primary);color:#fff;border-color:var(--lis-primary-hover);box-shadow:0 1px 4px rgba(200,149,108,.25)}
#lis-pr-tools #lis-pr-query:hover{background:var(--lis-primary-hover)}
#lis-pr-tools .pr-date input{cursor:pointer;background:#fffdfb}
#lis-pr-tools .pr-date-shortcuts{display:flex;align-items:flex-end;gap:4px}
#lis-pr-tools .pr-date-shortcuts button{min-width:54px;height:26px;padding:0 7px;color:var(--lis-text-secondary);background:var(--lis-primary-lighter);border-color:var(--lis-border);font-weight:700}
#lis-pr-tools .pr-toggle{height:26px;display:flex!important;flex-direction:row!important;align-items:center;align-self:flex-end;gap:6px;box-sizing:border-box;border:1px solid #ddd6ce;border-radius:4px;background:#fffdfb;color:#292524;font-size:12px;font-weight:700;padding:0 10px;white-space:nowrap;cursor:pointer;line-height:1}
#lis-pr-tools .pr-toggle:hover{border-color:#c8956c;background:#fef9ee}
#lis-pr-tools .pr-toggle input{width:13px;height:13px;margin:0;accent-color:var(--lis-primary)}
#lis-pr-date-picker{position:fixed;z-index:100020;width:252px;background:var(--lis-surface);border:1px solid var(--lis-border);border-radius:6px;box-shadow:0 8px 24px rgba(31,45,61,.18);padding:8px;font-family:var(--lis-font)}
#lis-pr-date-picker .pr-dp-head{display:flex;gap:6px;margin-bottom:8px;align-items:center}
#lis-pr-date-picker select{height:26px;border:1px solid #ddd6ce;border-radius:4px;background:#fffdfb;color:#292524;font-size:12px;padding:0 4px;flex:1}
#lis-pr-date-picker .pr-dp-today{height:26px;border:1px solid #c8956c;border-radius:4px;background:#fef9ee;color:#a87548;font-size:12px;font-weight:700;padding:0 8px;cursor:pointer}
#lis-pr-date-picker .pr-dp-week,#lis-pr-date-picker .pr-dp-days{display:grid;grid-template-columns:repeat(7,1fr);gap:3px}
#lis-pr-date-picker .pr-dp-week span{font-size:10px;color:#a8a29e;text-align:center;padding:2px 0}
#lis-pr-date-picker .pr-dp-days button{height:26px;border:1px solid transparent;border-radius:4px;background:#fffdfb;color:#292524;font-size:12px;padding:0;cursor:pointer}
#lis-pr-date-picker .pr-dp-days button.blank{visibility:hidden;pointer-events:none}
#lis-pr-date-picker .pr-dp-days button:hover{background:var(--lis-primary-lighter);border-color:var(--lis-border)}
#lis-pr-date-picker .pr-dp-days button.on{background:var(--lis-primary);border-color:var(--lis-primary);color:#fff;font-weight:700}
#lis-pr-status{padding:4px 10px;font-size:11px;color:#78716c;background:#fffdfb;flex-shrink:0;border-bottom:1px solid var(--lis-border-light)}
#lis-pr-status.ok{color:var(--lis-success);background:var(--lis-primary-light)}
#lis-pr-status.error{color:var(--lis-error);background:#fef2f2}
#lis-pr-status.info{color:#a87548;background:#fef9ee}
#lis-pr-body{flex:1;min-height:0;overflow-y:auto;overflow-x:auto;background:var(--lis-bg);padding:8px;position:relative;z-index:1}
#lis-pr-body table{width:100%;border-collapse:separate;border-spacing:0;background:var(--lis-surface);border:1px solid var(--lis-border-light);border-radius:8px;overflow:hidden;font-size:12px}
#lis-pr-body th{position:sticky;top:0;background:var(--lis-bg);color:var(--lis-text-secondary);padding:7px 8px;text-align:left;border-bottom:1px solid #e7e0d8;white-space:nowrap;z-index:1}
#lis-pr-body td{padding:6px 8px;border-bottom:1px solid #f0ebe5;white-space:nowrap;vertical-align:middle}
#lis-pr-body tr:nth-child(even){background:#fef9ee}
#lis-pr-body tr:hover{background:#fef3c7}
#lis-pr-body .pr-empty{display:flex;align-items:center;justify-content:center;height:100%;color:#7b8b96;font-size:13px;text-align:center;line-height:1.7}
#lis-pr-body .pr-abn{color:#c62828;font-weight:700}
#lis-pr-body .pr-low{color:#1565c0;font-weight:700}
#lis-pr-body .pr-high{color:#e65100;font-weight:700}
#lis-pr-body .pr-critical{color:#b71c1c;font-weight:800}
/* --- 顶部快速切换条 --- */

/* --- 全屏工作台 --- */
#lis-ws{position:fixed!important;inset:0!important;z-index:100000!important;background:var(--lis-bg);display:none;color:var(--lis-text);font-family:var(--lis-font)}
#lis-ws.show{display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important}
#lis-ws-hd{background:var(--lis-surface);padding:6px 14px;display:flex;align-items:center;gap:10px;flex-shrink:0!important;border-bottom:1px solid var(--lis-border);box-shadow:0 1px 0 rgba(31,41,51,.04)}
#lis-ws-hd .ws-title{display:flex;align-items:center;gap:8px;min-width:128px}
#lis-ws-hd .ws-title-dot{width:4px;height:20px;border-radius:2px;background:var(--lis-primary);display:inline-block}
#lis-ws-hd h3{margin:0;font-size:15px;line-height:1;color:var(--lis-text);font-weight:700;white-space:nowrap;letter-spacing:0}
#lis-ws-hd .ws-search-wrap{position:relative;flex:0 1 360px;min-width:220px}
#lis-ws-hd .ws-search-wrap::before{content:'⌕';position:absolute;left:10px;top:50%;transform:translateY(-50%);color:#6b7785;font-size:14px}
#lis-ws-hd .ws-search{width:100%;box-sizing:border-box;padding:7px 10px 7px 30px;border:1px solid var(--lis-border);border-radius:6px;font-size:12px;outline:none;background:var(--lis-primary-lighter);color:var(--lis-text);transition:border-color .15s,background .15s}
#lis-ws-hd .ws-search:focus{background:#fffdfb;border-color:var(--lis-primary);box-shadow:0 0 0 2px rgba(180,83,9,.12)}
#lis-ws-hd .ws-acts{display:flex;gap:6px;margin-left:auto;align-items:center}
#lis-ws-hd .ws-icon-btn{width:30px;height:30px;border:1px solid var(--lis-border);border-radius:6px;background:var(--lis-surface);color:var(--lis-text-secondary);cursor:pointer;font-size:14px;font-weight:700;display:inline-flex;align-items:center;justify-content:center;transition:background .15s,border-color .15s,color .15s}
#lis-ws-hd .ws-icon-btn:hover{background:var(--lis-primary-light);border-color:var(--lis-border);color:var(--lis-primary)}
#lis-ws-hd .ws-icon-btn.danger:hover{border-color:#dc2626;color:var(--lis-error);background:#fef2f2}
@keyframes lis-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}
#lis-ws-hd .ws-icon-btn.spinning{animation:lis-spin .8s linear infinite;pointer-events:none;opacity:.6}

/* --- 数据表 --- */
#lis-ws-body{flex:1!important;overflow:auto!important;background:var(--lis-bg);font-family:var(--lis-font);min-height:0!important;position:relative;z-index:1;padding:0 8px 8px}
#lis-ws-body table{width:100%;border-collapse:separate;border-spacing:0;font-size:12px;background:var(--lis-surface);border:1px solid var(--lis-border-light);border-radius:8px;overflow:hidden}
#lis-ws-body thead{position:sticky;top:0;z-index:2}
#lis-ws-body th{background:var(--lis-bg);color:var(--lis-text-secondary);padding:7px 9px;text-align:left;font-weight:700;white-space:nowrap;cursor:pointer;user-select:none;border-bottom:1px solid var(--lis-border);transition:background .15s}
#lis-ws-body th:hover{background:var(--lis-border-light)}
#lis-ws-body th::after{content:' ⇅';font-size:10px;opacity:.42}
#lis-ws-body th.sort-asc::after{content:' ↑';opacity:1}
#lis-ws-body th.sort-desc::after{content:' ↓';opacity:1}
#lis-ws-body td{padding:4px 9px;border-bottom:1px solid var(--lis-border-light);white-space:nowrap;transition:background .12s;vertical-align:middle}
#lis-ws-body tr{cursor:pointer;transition:background .12s}
#lis-ws-body tbody tr:nth-child(even){background:#fef9ee}
#lis-ws-body tbody tr:nth-child(odd){background:#fffdfb}
#lis-ws-body tbody tr:last-child td{border-bottom:none}
#lis-ws-body tr:hover{background:#fef3c7}
#lis-ws-body tr.sel{background:var(--lis-primary-light);box-shadow:inset 3px 0 0 var(--lis-primary)}
#lis-ws-body tr.active-row{background:#fef3c7;box-shadow:inset 3px 0 0 #c8956c}
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
#lis-ws-ft{background:var(--lis-surface);padding:4px 14px;display:flex;align-items:center;justify-content:space-between;font-size:11px;color:var(--lis-text-secondary);flex-shrink:0!important;border-top:1px solid var(--lis-border)}

/* --- 仪器标签栏 --- */
#lis-ws-tabs{background:var(--lis-surface);padding:5px 14px 4px;display:flex!important;align-items:flex-start!important;justify-content:flex-start!important;text-align:left!important;flex-shrink:0!important;overflow-x:auto;scrollbar-width:none;position:relative;z-index:3;border-bottom:1px solid var(--lis-border)}
#lis-ws-tabs::-webkit-scrollbar{display:none}
.ws-ws-row1{display:flex;align-items:center;gap:8px;flex-shrink:0}
.ws-wg-row{display:none}
.ws-wg-inline{display:flex;align-items:center;gap:3px;flex-shrink:0;margin-left:4px}
.ws-wg-inline .ws-wg-tab{padding:4px 9px;border-radius:5px;font-size:12px;font-weight:600}
.ws-wg-inline .ws-wg-tab .mach-cnt{font-size:10px;padding:0 5px;min-width:15px}
.ws-right-group{display:flex;align-items:center;gap:8px;margin-left:auto;padding-left:10px;border-left:1px solid var(--lis-border);flex-shrink:0}
.ws-cat-hd-inline{display:flex;align-items:center;gap:4px;flex-shrink:0;flex-wrap:wrap;min-width:0}
.ws-ws-row1{display:none}
.ws-cat-row-inline{display:flex;align-items:center;gap:4px;margin-left:auto;flex-shrink:0;flex-wrap:wrap;min-width:0}
.ws-mach-row{display:flex!important;align-items:center;justify-content:flex-start!important;align-self:flex-start!important;gap:4px;overflow-x:auto;scrollbar-width:none;margin:0!important;padding-top:4px;border-top:1px solid var(--lis-border-light);width:fit-content}
.ws-mach-row::-webkit-scrollbar{display:none}
.ws-wg-tab,.ws-mach-tab{border:1px solid var(--lis-border);background:var(--lis-surface);color:var(--lis-text);cursor:pointer;transition:background .15s,border-color .15s,color .15s;white-space:nowrap;display:flex;align-items:center;gap:6px;letter-spacing:0}
.ws-wg-tab{padding:5px 11px;border-radius:6px;font-size:13px;font-weight:600}
.ws-wg-tab:hover,.ws-mach-tab:hover{background:var(--lis-primary-lighter);border-color:var(--lis-primary-hover)}
.ws-wg-tab.on{background:var(--lis-primary);border-color:var(--lis-primary);color:#fff;border-radius:6px}
.ws-mach-tab{padding:4px 9px;border-radius:5px;font-size:12px;font-weight:500}
.ws-mach-tab.on{background:var(--lis-primary);border-color:var(--lis-primary);color:#fff}
.ws-mach-tab.ws-mach-multi{gap:5px}
.ws-mach-check{width:14px;height:14px;border:1px solid var(--lis-border);border-radius:3px;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;line-height:1;background:#fff;color:var(--lis-primary);flex:0 0 14px}
.ws-mach-tab.ws-mach-multi.on .ws-mach-check{background:rgba(255,255,255,.22);border-color:rgba(255,255,255,.5);color:#fff}
.ws-tab-name{overflow:hidden;text-overflow:ellipsis;max-width:150px}
.mach-cnt{background:var(--lis-primary-lighter);color:var(--lis-text-secondary);border-radius:10px;padding:0 6px;font-size:11px;min-width:17px;text-align:center;line-height:1.6;font-weight:700}
.ws-wg-tab.on .mach-cnt,.ws-mach-tab.on .mach-cnt{background:rgba(255,255,255,.22);color:#fff}
.ws-tab-stat{display:inline-flex;align-items:center;color:var(--lis-text-secondary);font-size:10px;font-weight:700}
.ws-mach-wrap{flex-wrap:wrap;gap:3px 4px}
.ws-mach-group{display:inline-flex;align-items:center;gap:3px;flex-wrap:wrap}
.ws-mach-group-label{font-size:10px;font-weight:700;padding:0 2px;white-space:nowrap;opacity:.8}
.ws-mach-filter-label{align-self:center;color:var(--lis-text-secondary);font-size:11px;font-weight:700;white-space:nowrap;margin-right:2px}
/* Compact instrument layout when all workgroups shown */
.ws-mach-row.all-wg{display:flex!important;justify-content:flex-start!important;flex-wrap:wrap;gap:4px 6px;align-items:center}
.ws-mach-row.all-wg .ws-mach-group{display:inline-flex;align-items:center;gap:3px;flex-wrap:nowrap;margin-right:4px;padding-left:7px;border-left:1px solid var(--lis-border-light)}
.ws-mach-row.all-wg .ws-mach-group-label{font-size:11px;font-weight:700;color:var(--lis-text-muted);white-space:nowrap;margin-right:3px}
.ws-mach-row.all-wg .ws-mach-tab{padding:3px 7px;font-size:11px;border-radius:4px;white-space:nowrap}
.ws-mach-row.all-wg .ws-tab-name{max-width:120px;overflow:hidden;text-overflow:ellipsis}
.ws-mach-row .ws-mach-all{margin:0 8px 0 0!important}
.ws-wg-tab.on .ws-tab-stat{color:rgba(255,255,255,.82)}

/* --- 分类标签栏 --- */
#lis-ws-bar{display:none}
.cat-tab{padding:3px 10px;border-radius:5px;border:1px solid var(--lis-border);background:var(--lis-surface);cursor:pointer;font-size:12px;font-weight:600;transition:background .15s,border-color .15s,color .15s;white-space:nowrap;display:flex;align-items:center;gap:5px;color:var(--lis-text)}
.cat-tab:hover{border-color:#7ebbb3;background:var(--lis-primary-lighter)}
.cat-tab.on{border-color:transparent;background:var(--lis-primary);color:#fff}
.cat-tab .cat-cnt{border-radius:10px;padding:0 6px;font-size:11px;min-width:15px;text-align:center;line-height:1.55;font-weight:700}
.cat-tab.on .cat-cnt{background:rgba(255,255,255,.22);color:#fff}
.cat-tab:not(.on) .cat-cnt{background:var(--lis-primary-lighter);color:var(--lis-text-secondary)}
.cat-tab.cat-normal:not(.on) .cat-cnt{background:var(--lis-primary-light);color:var(--lis-primary-hover)}
.cat-tab.cat-abnormal:not(.on) .cat-cnt{background:#fde8e8;color:var(--lis-error)}
.cat-tab.cat-incomplete:not(.on) .cat-cnt{background:#fff2d7;color:#9a5b00}
.cat-tab.cat-pending:not(.on) .cat-cnt{background:#e7f0fb;color:var(--lis-info)}
.cat-sep{width:1px;height:24px;background:#dee2e6;margin:0 4px}
.cat-right{margin-left:auto;display:flex;align-items:center;gap:8px}
.cat-stats{color:var(--lis-text-secondary);font-size:11px}

/* --- 一键批审横幅 --- */
.ws-normal-banner{background:var(--lis-surface);border:1px solid var(--lis-border-light);border-left:3px solid var(--lis-primary);border-radius:8px;padding:8px 12px;margin:8px 0;display:flex;align-items:center;gap:12px;flex-shrink:0}
.ws-normal-banner .nb-text{font-size:13px;font-weight:700;color:var(--lis-primary-hover);flex:1}
.ws-normal-banner .nb-btn,.nb-btn{padding:7px 14px;border:none;border-radius:6px;background:var(--lis-primary);color:#fff;font-size:12px;font-weight:800;cursor:pointer;transition:background .15s;white-space:nowrap;box-shadow:none}
.ws-normal-banner .nb-btn:hover,.nb-btn:hover{background:var(--lis-primary-hover)}
.ws-normal-banner .nb-btn:active,.nb-btn:active{filter:brightness(.95)}

/* --- 异常标本卡片 --- */
.ws-abnormal-list{padding:10px 0;display:flex;flex-direction:column;gap:5px;overflow-y:auto;flex:1}
.ws-abnormal-card{background:var(--lis-surface);border:1px solid var(--lis-border-light);border-left:3px solid var(--lis-error);border-radius:8px;padding:8px 12px;cursor:pointer;transition:background .12s,border-color .12s;display:flex;align-items:center;gap:10px}
.ws-abnormal-card:hover{background:var(--lis-primary-light);border-color:var(--lis-border)}
.ws-abnormal-card.focused{border-left-color:#2f6fb3;background:#eef6ff;box-shadow:0 0 0 1px rgba(47,111,179,.12)}
.ws-abnormal-card.auditing{border-left-color:#168276;background:#eef7f5;box-shadow:0 0 0 1px rgba(22,130,118,.14)}
.ws-abnormal-card.has-critical{border-left-color:#b91c1c;background:#fff7f7}
.ws-abnormal-card.has-critical.focused{border-left-color:#b91c1c;background:#ffeded;box-shadow:0 0 0 1px rgba(185,28,28,.14)}
.ws-abnormal-card.has-infection-warning{border-left-color:#d4a574;background:#fffbeb}
.ws-abnormal-card.has-infection-warning.focused{border-left-color:#d4a574;background:#fef3c7;box-shadow:0 0 0 1px rgba(212,165,116,.14)}
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
/* x8 传染病：梅毒/丙肝/HIV 阳性统一高亮（区别于乙肝两对半粉色，亮黄更醒目防漏发） */
.ab-card-item.inf-special,.result-table .inf-special{background:#fff176;color:#5d3a00;border:1px solid #f9a825;font-weight:800;text-shadow:0 1px 0 rgba(255,255,255,.5)}
.ab-card-hint{font-size:11px;color:#bbb;white-space:nowrap;margin-left:auto}
.ws-abnormal-machine{position:sticky;top:0;z-index:2;background:var(--lis-primary-lighter);border:1px solid var(--lis-border);border-radius:5px;padding:4px 10px;margin:8px 0 2px;font-size:11px;font-weight:600;color:#475569;letter-spacing:.02em}
.ws-abnormal-hint{background:var(--lis-surface);border:1px solid var(--lis-border);border-left:4px solid var(--lis-info);border-radius:6px;padding:7px 10px;margin:10px 0 0;font-size:12px;color:#334155;display:flex;align-items:center;gap:6px}
.ws-abnormal-hint kbd{background:#f7f9fb;border:1px solid #cbd5df;border-radius:3px;padding:1px 5px;font-size:11px;font-family:monospace}

/* --- 待审视图（融合正常 + 异常，单队列审核）--- */
.ws-audit-banner{background:var(--lis-surface);border:1px solid var(--lis-border-light);border-left:3px solid var(--lis-primary);border-radius:8px;padding:8px 12px;margin:8px 0 0;display:flex;align-items:center;gap:12px;flex-shrink:0}
.ws-audit-summary{font-size:13px;font-weight:600;color:var(--lis-text);flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ws-audit-sep{color:var(--lis-border);margin:0 6px;font-weight:400}
.ws-audit-critical{color:#c62828;font-weight:700}
.ab-card-badge{font-size:14px;flex:0 0 auto}
.ws-abnormal-card.is-normal{border-left-color:#2e7d32;background:#f4fbf6}
.ws-abnormal-card.is-normal:hover{background:#e9f7ee}
.ws-abnormal-card.is-normal.focused{border-left-color:#2f6fb3;background:#eef6ff;box-shadow:0 0 0 1px rgba(47,111,179,.12)}
.ab-card-time{font-size:11px;color:#999;white-space:nowrap}

/* --- 不完整提示 --- */
.ws-incomplete-banner{background:var(--lis-surface);border:1px solid var(--lis-border-light);border-left:3px solid var(--lis-warning);border-radius:6px;padding:8px 12px;margin:10px 0;font-size:13px;color:#8a5600;font-weight:700}

/* --- 分类加载中 --- */
.ws-category-loading{text-align:center;padding:40px;color:#999;font-size:14px}
.ws-category-loading .cat-prog{font-size:12px;color:#bbb;margin-top:8px}

/* --- 确保内容可滚动 --- */
#lis-ws-body::-webkit-scrollbar{width:9px;height:9px}
#lis-ws-body::-webkit-scrollbar-track{background:var(--lis-border-light)}
#lis-ws-body::-webkit-scrollbar-thumb{background:#d6c9bc;border-radius:5px}
#lis-ws-body::-webkit-scrollbar-thumb:hover{background:#b8a99a}
#lis-ws-body table{min-height:0}

/* --- 批审面板 --- */
#lis-batch{position:fixed;bottom:0;left:50%;transform:translateX(-50%);z-index:100001;background:#fff;border-radius:10px 10px 0 0;box-shadow:0 -2px 12px rgba(0,0,0,.1);padding:14px 20px;display:none;width:480px}
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
#lis-pr-pagination{position:sticky;bottom:0;z-index:5;display:flex;align-items:center;gap:8px;padding:10px 12px;background:var(--lis-surface);border-top:1px solid var(--lis-border);font-size:12px;color:var(--lis-text);box-shadow:0 -4px 12px rgba(0,0,0,.1);margin-top:8px}
#lis-pr-pagination button{height:28px;border:1px solid var(--lis-border);background:var(--lis-surface);color:var(--lis-primary);border-radius:5px;padding:0 12px;font-size:12px;font-weight:700;cursor:pointer;white-space:nowrap}
#lis-pr-pagination button:hover:not(:disabled){background:var(--lis-primary-lighter);border-color:var(--lis-primary-hover)}
#lis-pr-pagination button:disabled{opacity:.4;cursor:not-allowed}
#lis-pr-pagination .pr-pg-info{color:#6b7785;white-space:nowrap}
#lis-pr-pagination .pr-pg-jump{display:flex;align-items:center;gap:4px}
#lis-pr-pagination .pr-pg-jump input{width:52px;height:26px;border:1px solid #cbd5df;border-radius:4px;padding:0 6px;font-size:12px;text-align:center}
#lis-pr-pagination .pr-pg-total{margin-left:auto;color:#6b7785;white-space:nowrap}

/* --- Toast（须高于工作台 100000 / 详情面板 100005，否则详情打开时提示看不见）--- */
.lis-t{position:fixed;top:50px;right:20px;z-index:100050;padding:10px 18px;border-radius:6px;font-size:13px;color:#fff;box-shadow:0 4px 12px rgba(0,0,0,.2);animation:lis-si .3s ease;pointer-events:none}
.lis-t.e{background:#e74c3c}.lis-t.w{background:#f39c12}.lis-t.s{background:var(--lis-primary)}.lis-t.i{background:#3498db}
@keyframes lis-si{from{transform:translateX(100%);opacity:0}}
#lis-detail-footer .btn-audit:disabled{opacity:.7;cursor:wait}
#lis-detail-footer .btn-audit.busy{background:var(--lis-primary-hover)}

/* --- 空状态 --- */
.ws-empty{text-align:center;padding:60px;color:#95a5a6;font-size:15px}
.ws-empty .ico{font-size:48px;margin-bottom:12px}

/* --- 加载 --- */
.ws-spin{display:inline-block;width:18px;height:18px;border:2px solid #ddd;border-top:2px solid #3498db;border-radius:50%;animation:lis-sp .7s linear infinite;vertical-align:middle;margin-right:4px}
@keyframes lis-sp{to{transform:rotate(360deg)}}

/* --- 质控录入辅助 --- */
#lis-qc-panel{position:fixed;top:34px;left:60px;width:560px;height:520px;min-width:360px;min-height:340px;z-index:100004;background:#fff;border:1px solid #b9d5ea;border-radius:6px;box-shadow:0 4px 16px rgba(59,116,153,.18);display:flex;flex-direction:column;overflow:hidden;font-family:var(--lis-font);color:#213547;box-sizing:border-box;resize:none}
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
#lis-qc-fab:hover{transform:scale(1.06);background:linear-gradient(135deg,#3498db,#2471a3)}


    
/* --- 登录页优化 --- */
#lis-login-box{position:fixed;top:50%;right:40px;transform:translateY(-50%);z-index:99999;background:rgba(255,255,255,.97);border-radius:12px;box-shadow:0 8px 32px rgba(0,0,0,.15);padding:20px 24px;width:300px;font-family:var(--lis-font)}
#lis-login-box.dragging{opacity:.96;transform:none}
#lis-login-box h4{margin:0 0 14px;font-size:15px;color:#2c3e50;text-align:center;cursor:move;user-select:none;padding:2px 0}
#lis-login-box .lis-lb-row{margin-bottom:10px}
#lis-login-box .lis-lb-row label{display:block;font-size:12px;color:#666;margin-bottom:3px}
#lis-login-box .lis-lb-row input{width:100%;padding:7px 10px;border:1px solid #ddd;border-radius:4px;font-size:13px;box-sizing:border-box}
#lis-login-box .lis-lb-row input:focus{border-color:#3498db;outline:none;box-shadow:0 0 0 2px rgba(52,152,219,.15)}
#lis-login-box .lis-lb-wg{display:flex;flex-wrap:wrap;gap:6px;margin-top:4px}
#lis-login-box .lis-lb-wg button{flex:1;min-width:70px;padding:6px 8px;border:2px solid #e0e0e0;border-radius:6px;background:#fff;cursor:pointer;font-size:12px;font-weight:600;transition:.2s}
#lis-login-box .lis-lb-wg button:hover{border-color:#3498db;background:#eaf2f8}
#lis-login-box .lis-lb-wg button.sel{border-color:#3498db;background:#3498db;color:#fff}
#lis-login-box .lis-lb-login{width:100%;padding:9px;border:none;border-radius:6px;background:linear-gradient(135deg,#667eea,#764ba2);color:#fff;font-size:14px;font-weight:600;cursor:pointer;margin-top:8px;transition:.2s}
#lis-login-box .lis-lb-login:hover{filter:brightness(1.05);transform:none}
#lis-login-box .lis-lb-login:disabled{opacity:.6;cursor:not-allowed}
#lis-login-box .lis-lb-tip{font-size:11px;color:#999;text-align:center;margin-top:10px;line-height:1.4}
#lis-login-box .lis-lb-remember{display:flex;align-items:center;gap:6px;font-size:12px;color:#666;margin-top:6px}
#lis-login-box .lis-lb-remember input{width:auto}

    
/* --- 待审速览 --- */
.ws-audit-bar{background:linear-gradient(180deg,#fef9ee,#fffdfb);padding:10px 20px;border-bottom:2px solid #c8956c;display:flex;align-items:center;gap:8px;flex-shrink:0;box-shadow:0 2px 4px rgba(0,0,0,.05)}
.ws-audit-bar .ab-label{font-size:12px;color:#78716c;font-weight:600;margin-right:4px;white-space:nowrap}
.ws-audit-bar .ab-btn{padding:6px 14px;border-radius:6px;border:2px solid #e7e0d8;background:#fffdfb;cursor:pointer;font-size:12px;font-weight:600;transition:background .2s;white-space:nowrap;box-shadow:0 1px 3px rgba(0,0,0,.05)}
.ws-audit-bar .ab-btn:hover{border-color:#c8956c;background:#fef9ee;transform:translateY(-1px);box-shadow:0 2px 6px rgba(0,0,0,.1)}
.ws-audit-bar .ab-btn.on{border-color:#c8956c;background:linear-gradient(135deg,#c8956c,#a87548);color:#fff;box-shadow:0 2px 8px rgba(200,149,108,.3)}
.ws-audit-bar .ab-btn.ready{border-color:#16a34a;color:#16a34a}
.ws-audit-bar .ab-btn.ready.on{background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;border-color:#16a34a;box-shadow:0 2px 8px rgba(22,163,74,.3)}
.ws-audit-bar .ab-count{font-size:13px;font-weight:700;margin-left:8px;padding:4px 12px;border-radius:12px;box-shadow:inset 0 1px 2px rgba(0,0,0,.1)}
.ws-audit-bar .ab-count.green{background:linear-gradient(135deg,#f0fdf4,#dcfce7);color:#166534}
.ws-audit-bar .ab-count.orange{background:linear-gradient(135deg,#fffbeb,#fef3c7);color:#a87548}
.ws-audit-bar .ab-sep{width:1px;height:24px;background:#e7e0d8;margin:0 6px}
.complete-star{color:#f39c12;font-size:12px}
.complete-empty{color:#e74c3c;font-size:12px}
.complete-partial{color:#ff9800;font-size:12px}

/* --- 标本详情面板 --- */
#lis-detail-panel{position:fixed;top:0;right:0;width:65vw;max-width:900px;min-width:600px;height:100vh;z-index:100005;background:#fff;box-shadow:-4px 0 20px rgba(0,0,0,.2);transform:translateX(100%);transition:transform .3s ease;display:flex;flex-direction:column}
#lis-detail-panel.show{transform:translateX(0)}
#lis-detail-panel{overflow:hidden!important}
#lis-detail-hd{background:var(--lis-bg);color:var(--lis-text);border-bottom:1px solid var(--lis-border);padding:12px 20px;display:flex;align-items:flex-start;justify-content:space-between;flex-shrink:0;line-height:1.4}
#lis-detail-hd h4{margin:0;font-size:16px;color:var(--lis-text)}
#lis-detail-hd .detail-close{background:none;border:none;color:var(--lis-text-secondary);font-size:20px;cursor:pointer;padding:4px 8px;border-radius:4px;transition:background .2s}
#lis-detail-hd .detail-close:hover{background:var(--lis-primary-light);color:var(--lis-text)}
#lis-detail-info{padding:0px 16px;background:transparent;border-bottom:none;flex-shrink:0;font-size:12px}



#lis-detail-body{flex:1!important;overflow-y:scroll!important;overflow-x:hidden!important;padding:16px 20px;min-height:0!important;max-height:calc(100vh - 120px)!important;position:relative;overscroll-behavior:contain;contain:content;background:var(--lis-bg)}
#lis-detail-body .result-section{margin-bottom:20px}
#lis-detail-body .result-section h5{margin:0 0 12px;color:var(--lis-text);font-size:14px;padding-bottom:8px;border-bottom:1px solid var(--lis-border)}
.result-table{width:100%;border-collapse:collapse;font-size:12px}
.result-table th{background:var(--lis-bg);color:var(--lis-text-secondary);font-weight:600;padding:5px 8px;text-align:left;font-weight:600;white-space:nowrap;font-size:11px}
.result-table td{padding:4px 8px;border-bottom:1px solid #eee;overflow:hidden;text-overflow:ellipsis}
.result-table tr:hover{background:#f5f5f5}
.result-table .abnormal{color:#e74c3c;font-weight:600}
.result-table .abnormal.critical{color:#b71c1c;font-weight:700;font-size:15px;text-shadow:0 0 1px rgba(231,76,60,.3)}
.result-table .abnormal.high{color:#e65100}
.result-table .abnormal.low{color:#1565c0}
.result-table .normal{color:#43a047}
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
#lis-detail-footer .btn-audit{background:var(--lis-primary);color:#fff}
#lis-detail-footer .btn-audit:hover{background:var(--lis-primary-hover)}
#lis-detail-footer .btn-close{background:#95a5a6;color:#fff}
#lis-detail-footer .btn-close:hover{background:#7f8c8d}
#lis-detail-loading{text-align:center;padding:40px;color:#999}
#lis-detail-loading .spinner{display:inline-block;width:24px;height:24px;border:3px solid #ddd;border-top:3px solid #3498db;border-radius:50%;animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}

    /* --- 响应式 --- */
@media(max-width:1200px){
  #lis-ws-hd{flex-wrap:wrap;padding:6px 12px;gap:6px}
  #lis-ws-hd .ws-search-wrap{flex:1 1 260px;min-width:180px}
  /* responsive: cat tabs */
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
  .ws-right-group{margin-left:0;flex-wrap:wrap}
  .ws-cat-row-inline,.ws-cat-hd-inline{flex-wrap:wrap}
  #lis-ws-body{font-size:11px}
}
/* --- 质控数据导出 --- */
#lis-qe-fab{position:fixed;right:20px;bottom:224px;z-index:99999;width:52px;height:52px;border-radius:50%;border:none;background:#0d7c66;color:#fff;font-size:13px;font-weight:800;cursor:pointer;box-shadow:0 3px 14px rgba(13,124,102,.35);display:flex;align-items:center;justify-content:center;user-select:none;transition:transform .15s}
#lis-qe-fab:hover{background:#0077ED;transform:none}
#lis-qe-panel{position:fixed!important;inset:0!important;z-index:100007!important;background:var(--lis-bg);display:none;flex-direction:column;font-family:var(--lis-font);color:var(--lis-text)}
#lis-qe-panel.show{display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important}
#lis-qe-hd{height:40px;display:flex;align-items:center;gap:8px;padding:0 12px;background:var(--lis-primary-light);border-bottom:1px solid var(--lis-border);flex-shrink:0}
#lis-qe-hd h3{margin:0;font-size:14px;color:var(--lis-primary);white-space:nowrap;font-weight:800}
#lis-qe-hd .qe-spacer{flex:1}
#lis-qe-hd button{height:26px;border:1px solid var(--lis-border);background:var(--lis-surface);color:var(--lis-primary);border-radius:4px;padding:0 10px;font-size:11px;font-weight:700;cursor:pointer}
#lis-qe-hd button:hover{background:var(--lis-primary-lighter);border-color:var(--lis-primary-hover)}
#lis-qe-hd .qe-close{font-size:18px;line-height:20px;padding:0 8px;color:#7b8b96}
#lis-qe-body{flex:1;min-height:0;overflow-y:auto;overflow-x:hidden;background:var(--lis-bg);padding:12px 16px}
.qe-section{background:var(--lis-surface);border:1px solid var(--lis-border-light);border-radius:8px;padding:12px 14px;margin-bottom:10px}
.qe-section-title{font-size:12px;font-weight:800;color:var(--lis-primary);margin-bottom:8px;display:flex;align-items:center;gap:6px}
.qe-section-title::before{content:'';display:inline-block;width:3px;height:14px;background:var(--lis-primary);border-radius:2px}
.qe-row{display:flex;flex-wrap:wrap;gap:8px 12px;align-items:center}
.qe-row label{display:flex;align-items:center;gap:5px;font-size:12px;color:#334155;font-weight:600;cursor:pointer;white-space:nowrap}
.qe-row input[type="checkbox"]{width:14px;height:14px;accent-color:#0d7c66}
.qe-row input[type="text"],.qe-row input[type="number"]{height:26px;border:1px solid #c3ced8;border-radius:4px;padding:2px 7px;font-size:12px;color:#213547;background:#fff;outline:none;box-sizing:border-box}
.qe-row input[type="text"]:focus,.qe-row input[type="number"]:focus{border-color:#4db89e;box-shadow:0 0 0 2px rgba(77,184,158,.12)}
.qe-row select{height:26px;border:1px solid #c3ced8;border-radius:4px;padding:2px 4px;font-size:12px;color:#213547;background:#fff;outline:none}
.qe-lot-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:6px;width:100%}
.qe-lot-item{display:flex;align-items:center;gap:5px;font-size:11px;color:#475569}
.qe-lot-item span{min-width:60px;font-weight:700;color:#334155;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.qe-lot-item input{flex:1;min-width:0;height:24px;border:1px solid #d5dde5;border-radius:3px;padding:1px 5px;font-size:11px}
.qe-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.qe-actions button{height:30px;border:1px solid var(--lis-border);background:var(--lis-surface);color:var(--lis-primary);border-radius:5px;padding:0 14px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.qe-actions button:hover{background:var(--lis-primary-lighter);border-color:var(--lis-primary-hover)}
.qe-actions button.primary{background:var(--lis-primary);color:#fff;border-color:var(--lis-primary-hover);box-shadow:0 1px 4px rgba(13,124,102,.25)}
.qe-actions button.primary:hover{background:var(--lis-primary-hover)}
.qe-actions button:disabled{opacity:.5;cursor:not-allowed}
#lis-qe-status{padding:4px 0;font-size:11px;color:#6b7785}
#lis-qe-status.ok{color:var(--lis-success)}
#lis-qe-status.error{color:#c62828}
#lis-qe-status.info{color:#1565c0}
.qe-progress{margin-top:8px;background:#edf2f7;border-radius:6px;overflow:hidden;height:20px;position:relative;display:none}
.qe-progress.show{display:block}
.qe-progress-bar{height:100%;background:linear-gradient(90deg,var(--lis-primary),var(--lis-primary-light));transition:width .3s;border-radius:6px}
.qe-progress-text{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:700;color:#334155}
.qe-result-list{display:flex;flex-direction:column;gap:4px;margin-top:8px}
.qe-result-item{display:flex;align-items:center;gap:8px;padding:6px 10px;background:var(--lis-surface);border:1px solid var(--lis-border);border-radius:5px;font-size:12px}
.qe-result-item .qe-ri-name{flex:1;font-weight:700;color:#334155}
.qe-result-item .qe-ri-status{font-size:11px;font-weight:600}
.qe-result-item .qe-ri-status.ok{color:var(--lis-primary)}
.qe-result-item .qe-ri-status.err{color:#c62828}
.qe-result-item button{height:24px;border:1px solid var(--lis-border);background:var(--lis-surface);color:var(--lis-primary);border-radius:3px;padding:0 8px;font-size:10px;font-weight:700;cursor:pointer}
.qe-result-item button:hover{background:var(--lis-primary-lighter)}
.qe-immune-toggle{font-size:11px;color:var(--lis-primary);cursor:pointer;text-decoration:underline;user-select:none;margin-left:8px}
.qe-immune-lots{display:none;margin-top:6px}
.qe-immune-lots.show{display:block}
.qe-date-row{display:flex;gap:8px;align-items:center}
.qe-date-row input[type="month"]{height:26px;border:1px solid #c3ced8;border-radius:4px;padding:2px 7px;font-size:12px;color:#213547;background:#fff;outline:none}
.qe-mapping-info{font-size:10px;color:#7b8b96;margin-top:4px;line-height:1.4}
.qe-step{background:var(--lis-surface);border:1px solid var(--lis-border-light);border-radius:8px;padding:10px 14px;margin-bottom:8px}
.qe-step-hd{display:flex;align-items:center;gap:8px;margin-bottom:6px;cursor:pointer;user-select:none}
.qe-step-num{width:22px;height:22px;border-radius:50%;background:var(--lis-primary);color:#fff;font-size:12px;font-weight:800;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.qe-step-title{font-size:13px;font-weight:800;color:var(--lis-primary);flex:1}
.qe-step-desc{font-size:10px;color:#7b8b96;font-weight:400}
.qe-step-body{margin-top:4px}
.qe-save-btn{height:28px;border:1px solid var(--lis-primary);background:var(--lis-primary);color:#fff;border-radius:5px;padding:0 16px;font-size:12px;font-weight:700;cursor:pointer;transition:all .15s}
.qe-save-btn:hover{background:var(--lis-primary-hover)}
.qe-save-btn.saved{background:var(--lis-primary-light);border-color:var(--lis-primary-light)}

    `);

  // ==================== Toast ====================
  function toast(msg, type = 's') {
    // 最多保留 4 条，避免连点 F4 时右上角堆成一片
    const prev = document.querySelectorAll('.lis-t');
    if (prev.length >= 4) {
      for (let i = 0; i <= prev.length - 4; i++) {
        try {
          prev[i].remove();
        } catch (e) {}
      }
    }
    const el = document.createElement('div');
    el.className = 'lis-t ' + type;
    el.textContent = msg;
    document.body.appendChild(el);
    const ttl = type === 'e' || type === 'error' ? 5200 : 3000;
    setTimeout(() => {
      try {
        el.remove();
      } catch (e) {}
    }, ttl);
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
    if (_authPersistenceInited) {return;}
    _authPersistenceInited = true;
    restoreAuth();
    const orig = sessionStorage.setItem.bind(sessionStorage);
    sessionStorage.setItem = function (k, v) {
      orig(k, v);
      if (k === 'AuInfo') {
        try {
          localStorage.setItem(K.au, v);
        } catch (e) {}
      }
      if (k === 'EntryInfo') {
        try {
          localStorage.setItem(K.ent, v);
        } catch (e) {}
      }
    };
    const origC = sessionStorage.clear.bind(sessionStorage);
    sessionStorage.clear = function () {
      let a = null,
        e = null;
      try {
        a = sessionStorage.getItem('AuInfo');
        e = sessionStorage.getItem('EntryInfo');
      } catch (x) {}
      origC();
      try {
        if (a) {orig('AuInfo', a);}
        if (e) {orig('EntryInfo', e);}
      } catch (x) {}
    };
    _authTimer = setInterval(restoreAuth, 3000);
    dbg('认证持久化就绪');
  }

  function initAuthFill() {
    if (isAuthPage()) {fillAuthPage();}
    else if (isReportPage()) {fillBatchPage();}
  }

  function restoreAuth() {
    const wsOpen = document.getElementById('lis-ws') && document.getElementById('lis-ws').classList.contains('show');
    try {
      if (!sessionStorage.getItem('AuInfo')) {
        const s = localStorage.getItem(K.au);
        if (s) {
          sessionStorage.setItem('AuInfo', s);
          // 工作台打开时不调用 refreshAuthUI，避免触发 LIS 页面重渲染导致闪烁
          if (!wsOpen) {refreshAuthUI();}
          else {dbg('[WS] 工作台打开中，跳过 refreshAuthUI');}
        }
      } else {
        localStorage.setItem(K.au, sessionStorage.getItem('AuInfo'));
      }
    } catch (e) {
      dbg('restoreAuth AuInfo 失败:', e.message);
    }
    try {
      if (!sessionStorage.getItem('EntryInfo')) {
        const s = localStorage.getItem(K.ent);
        if (s) {sessionStorage.setItem('EntryInfo', s);}
      } else {
        localStorage.setItem(K.ent, sessionStorage.getItem('EntryInfo'));
      }
    } catch (e) {
      dbg('restoreAuth EntryInfo 失败:', e.message);
    }
  }

  function refreshAuthUI() {
    try {
      const w = uw();
      if (typeof w.GetAuthLoginInfo === 'function') {
        if (w.me) {
          w.me.AuthUserDR = '';
          w.me.IsAuthLogin = 0;
          w.me.EntryUserDR = '';
          w.me.IsEntryLogon = 0;
        }
        w.GetAuthLoginInfo();
      }
    } catch (e) {}
  }

  // 审核登录页面（iframe 中）
  function fillAuthPage() {
    const tryFill = async () => {
      const pwd = await loadPwdAsync();
      if (!pwd) {return false;}
      const inputs = document.querySelectorAll('input[type="password"], input[onfocus*="password"]');
      for (const inp of inputs) {
        if (!inp.value) {
          setNativeInputValue(inp, pwd);
          inp.type = 'password';
        }
        if (!inp._lisListen) {
          inp._lisListen = true;
          inp.addEventListener('change', () => {
            if (inp.value) {savePwdAsync(inp.value);}
          });
          inp.addEventListener('keydown', e => {
            if (e.keyCode === 13 && inp.value) {savePwdAsync(inp.value);}
          });
        }
      }
      return inputs.length > 0;
    };
    tryFill().then(ok => {
      if (ok) {return;}
      const ob = new MutationObserver(() => {
        tryFill().then(filled => {
          if (filled) {ob.disconnect();}
        });
      });
      ob.observe(document.body, { childList: true, subtree: true });
      setTimeout(() => ob.disconnect(), 60000);
      [500, 1000, 2000].forEach(t => setTimeout(() => tryFill(), t));
    });
  }

  // 报告处理页面：批审窗口
  function fillBatchPage() {
    // MutationObserver
    const ob = new MutationObserver(muts => {
      for (const m of muts)
      {for (const n of m.addedNodes) {
        if (n.nodeType !== 1) {continue;}
        if (
          n.querySelector &&
            (n.querySelector('#text_AuthUserLoginPasssword') || n.querySelector('#text_EntryUserPasssword'))
        )
        {setTimeout(fillBatchPwd, 50);}
        if (n.tagName === 'IFRAME')
        {n.addEventListener('load', () => {
          setTimeout(() => fillIframe(n), 100);
          setTimeout(() => fillIframe(n), 500);
        });}
      }}
    });
    ob.observe(document.body, { childList: true, subtree: true });
    // 120 秒后断开 observer，防止长期运行泄漏
    setTimeout(() => ob.disconnect(), 120000);
    // 定期扫描
    _batchScanTimer = setInterval(() => {
      const f = document.getElementById('text_AuthUserLoginPasssword');
      if (f && f.offsetParent !== null && !f._lisFilled) {fillBatchPwd();}
    }, 2000);
  }

  async function fillBatchPwd() {
    const pwd = await loadPwdAsync();
    if (!pwd) {return;}
    const f = document.getElementById('text_AuthUserLoginPasssword');
    if (f && !f.value && f.offsetParent !== null) {
      setNativeInputValue(f, pwd);
      f.type = 'password';
      f._lisFilled = true;
    }
    if (f && !f._lisListen) {
      f._lisListen = true;
      f.addEventListener('change', () => {
        if (f.value) {savePwdAsync(f.value);}
      });
      f.addEventListener('keydown', e => {
        if (e.keyCode === 13 && f.value) {savePwdAsync(f.value);}
      });
    }
  }

  async function fillIframe(ifr) {
    try {
      const doc = ifr.contentDocument;
      if (!doc) {return;}
      const pwd = await loadPwdAsync();
      if (!pwd) {return;}
      doc.querySelectorAll('input[type="password"], input[onfocus*="password"]').forEach(inp => {
        if (!inp.value) {
          setNativeInputValue(inp, pwd);
          inp.type = 'password';
        }
        if (!inp._lisListen) {
          inp._lisListen = true;
          inp.addEventListener('change', () => {
            if (inp.value) {savePwdAsync(inp.value);}
          });
          inp.addEventListener('keydown', e => {
            if (e.keyCode === 13 && inp.value) {savePwdAsync(inp.value);}
          });
        }
      });
    } catch (e) {}
  }

  // ============================================================
  //  模块 B：快速切换条（已移除，保留占位避免历史引用）
  // ============================================================
  function initQBar() {
    /* deprecated */
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
  let _qcObservers = null; // 存储 QC 模块 MutationObserver 引用，页面切换时清理
  let qcLastKey = '';
  const QC_POS_KEY = 'lis-qc-panel-pos';

  function qcSavePos() {
    const panel = document.getElementById('lis-qc-panel');
    if (!panel) {return;}
    try {
      const pos = { l: panel.offsetLeft, t: panel.offsetTop, w: panel.offsetWidth, h: panel.offsetHeight };
      localStorage.setItem(QC_POS_KEY, JSON.stringify(pos));
    } catch (e) {}
  }
  function qcRestorePos() {
    try {
      const raw = localStorage.getItem(QC_POS_KEY);
      if (!raw) {return null;}
      return JSON.parse(raw);
    } catch (e) {
      return null;
    }
  }
  let qcLastFrameUrl = '';

  let qcIFrame = null; // 质控页面所在的 iframe 元素
  const qcWin = null; // 质控页面的 window（可能是 iframe.contentWindow 或 window）
  const qcDoc = null; // 质控页面的 document

  // 尝试在当前页面的 iframe 中查找质控页面
  function qcFindIFrame() {
    const frames = document.querySelectorAll('iframe');
    for (const f of frames) {
      try {
        const href = (f.contentWindow && f.contentWindow.location && f.contentWindow.location.href) || '';
        if (href.indexOf('/qc/form/frmQCDataInputNew') > -1) {return f;}
      } catch (e) {
        /* 跨域无法访问 */
      }
    }
    // 也检查 src 属性（跨域时无法读 contentWindow.location）
    for (const f of frames) {
      const src = f.src || '';
      if (src.indexOf('/qc/form/frmQCDataInputNew') > -1) {return f;}
    }
    return null;
  }

  function isQCDataInputPage() {
    // 先检查当前页面
    if (location.href.indexOf('/qc/form/frmQCDataInputNew') > -1) {return true;}
    const hasQcGrids = document.getElementById('dgData') && document.getElementById('dgTestCode');
    const hasQcControls =
      document.getElementById('dglevelno') || document.getElementById('cmbMach') || document.getElementById('cmbMat');
    if (hasQcGrids && hasQcControls) {return true;}
    // 再检查 iframe
    const f = qcFindIFrame();
    try {
      if (f && f.contentDocument) {
        const doc = f.contentDocument;
        const grids = doc.getElementById('dgData') && doc.getElementById('dgTestCode');
        const controls =
          doc.getElementById('dglevelno') || doc.getElementById('cmbMach') || doc.getElementById('cmbMat');
        if (grids && controls) {return true;}
      }
    } catch (e) {}
    return false;
  }

  // 获取质控页面的上下文（window/document/jQuery）
  function qcGetCtx() {
    // 如果当前就是质控页
    if (
      location.href.indexOf('/qc/form/frmQCDataInputNew') > -1 ||
      (document.getElementById('dgData') && document.getElementById('dgTestCode'))
    ) {
      return { win: window, doc: document };
    }
    // 否则从 iframe 获取
    try {
      if (qcIFrame && qcIFrame.contentWindow && qcIFrame.contentDocument) {
        return { win: qcIFrame.contentWindow, doc: qcIFrame.contentDocument };
      }
    } catch (e) {}
    const f = qcFindIFrame();
    try {
      if (f && f.contentWindow && f.contentDocument) {
        qcIFrame = f;
        return { win: f.contentWindow, doc: f.contentDocument };
      }
    } catch (e) {}
    return { win: window, doc: document };
  }

  function getJQ() {
    const ctx = qcGetCtx();
    return ctx.win.jQuery || ctx.win.$ || g('jQuery') || g('$') || window.jQuery || window.$;
  }

  function qcTryEasyUI(fn, fallback) {
    try {
      return fn();
    } catch (e) {
      return fallback;
    }
  }

  function qcEasyValue(selector, plugin, method) {
    const jq = getJQ();
    if (!jq || !jq(selector)[plugin]) {return '';}
    return qcTryEasyUI(() => jq(selector)[plugin](method || 'getValue'), '');
  }

  function qcSelectedRow(selector) {
    const jq = getJQ();
    if (!jq || !jq(selector).datagrid) {return null;}
    return qcTryEasyUI(() => jq(selector).datagrid('getSelected'), null);
  }

  function qcSelectedRows(selector) {
    const jq = getJQ();
    if (!jq || !jq(selector).datagrid) {return [];}
    return qcTryEasyUI(() => jq(selector).datagrid('getSelections') || [], []);
  }

  function qcGridRows(selector) {
    const jq = getJQ();
    if (!jq || !jq(selector).datagrid) {return [];}
    return qcTryEasyUI(() => jq(selector).datagrid('getRows') || [], []);
  }

  function qcBuildContext() {
    const test = qcSelectedRow('#dgTestCode');
    const levels = qcSelectedRows('#dglevelno');
    const rows = qcGridRows('#dgData');
    const level =
      levels[0] ||
      (rows.length
        ? { LevelNo: rows[0].LevelNo, CName: 'Level' + rows[0].LevelNo, MatLotDR: rows[0].MaterialLotDR }
        : null);
    const qcf = String((test && test.QcFlag) || '').split('^');
    const machineDR =
      qcEasyValue('#cmbMach', 'combobox', 'getValue') || (rows[0] && rows[0].MachineParameterDR) || qcf[3] || '';
    const machineName =
      qcEasyValue('#cmbMach', 'combobox', 'getText') || (rows[0] && rows[0].MachineParameterName) || '';
    const startDate = qcEasyValue('#startdate', 'datebox', 'getValue') || today();
    const endDate = qcEasyValue('#enddate', 'datebox', 'getValue') || today();
    const testCodeDR = (test && test.RowID) || (rows[0] && rows[0].TestCodeDR) || qcf[4] || '';
    const matDR = (test && test.MatDR) || (rows[0] && rows[0].MaterialDR) || '';
    const matLotDR =
      (level && level.MatLotDR) || (test && test.MatLotRowID) || (rows[0] && rows[0].MaterialLotDR) || qcf[2] || '';
    const mapType = qcf[1] || '0';
    return {
      test,
      levels,
      rows,
      level,
      machineDR,
      machineName,
      startDate,
      endDate,
      testCodeDR,
      matDR,
      matLotDR,
      mapType,
      testName: (test && (test.CName || test.Synonym || test.Code)) || (rows[0] && rows[0].TCName) || '',
      materialName: (test && test.MaterialName) || (rows[0] && rows[0].MaterialLotName) || '',
      levelNo: level && level.LevelNo ? String(level.LevelNo) : ''
    };
  }

  function qcContextKey(ctx) {
    const levelPart =
      (ctx.levels || [])
        .map(l => l.LevelNo)
        .sort()
        .join(',') ||
      ctx.levelNo ||
      '';
    return [ctx.machineDR, ctx.testCodeDR, ctx.matLotDR, levelPart, ctx.startDate, ctx.endDate].join('|');
  }

  function qcNativeUrl(ctx) {
    if (!ctx.machineDR || !ctx.testCodeDR) {return '';}
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
      if (!Number.isNaN(n)) {vals.push(n);}
    }
    if (vals.length) {return vals.reduce((a, b) => a + b, 0) / vals.length;}
    const candidates = [row.DayAve, row.Result, row.TextRes, row.TestResultPosNeg];
    for (const v of candidates) {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) {return n;}
    }
    return null;
  }

  function qcParseDate(s) {
    const d = String(s || '').trim();
    if (!d) {return NaN;}
    if (/^\d{4}-\d{2}-\d{2}/.test(d)) {return new Date(d.slice(0, 10) + 'T00:00:00').getTime();}
    if (/^\d{8}$/.test(d))
    {return new Date(d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8) + 'T00:00:00').getTime();}
    const parsed = Date.parse(d);
    return Number.isNaN(parsed) ? NaN : parsed;
  }

  function qcFormatXLabel(dateStr, fewPoints) {
    const d = String(dateStr || '');
    if (fewPoints && d.length >= 10) {return d.slice(5, 10).replace('-', '/');}
    if (d.length >= 10) {return d.slice(8, 10);}
    return d.slice(-2);
  }

  // 横轴定位：少量点靠左固定间距，避免 2～3 个点拉满整图
  function qcXPositions(points, left, plotW) {
    const n = points.length;
    const leftPad = 10;
    if (n === 1) {return [left + leftPad];}

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
      if (maxT - minT < minSpan) {maxT = minT + minSpan;}
      else {maxT += edgePad;}
      const span = maxT - minT || dayMs;
      return dates.map(t => left + ((t - minT) / span) * plotW);
    }

    const slot = Math.min(40, plotW / Math.max(n, 8));
    const x0 = left + leftPad;
    return points.map((_, i) => x0 + i * slot);
  }

  // 绘制单个浓度的质控图 SVG
  function qcBuildSVG(points, levelLabel) {
    if (!points.length) {return '';}
    const xbarPoint = points.find(p => !Number.isNaN(p.xbar) && !Number.isNaN(p.sd));
    const xbar = xbarPoint ? xbarPoint.xbar : points.reduce((a, p) => a + p.value, 0) / points.length;
    const sdRaw = xbarPoint ? xbarPoint.sd : 0;
    const xbarStr = (xbarPoint && xbarPoint.xbarStr) || String(xbar);
    const sdStr = (xbarPoint && xbarPoint.sdStr) || String(sdRaw);
    const spread =
      sdRaw > 0
        ? sdRaw
        : Math.max(0.0001, (Math.max(...points.map(p => p.value)) - Math.min(...points.map(p => p.value))) / 6);
    const values = points.map(p => p.value).concat([xbar - 3 * spread, xbar + 3 * spread]);
    let minY = Math.min(...values),
      maxY = Math.max(...values);
    if (minY === maxY) {
      minY -= 1;
      maxY += 1;
    }
    const padY = (maxY - minY) * 0.08;
    minY -= padY;
    maxY += padY;
    const w = 480,
      h = 140,
      left = 40,
      right = 10,
      top = 10,
      bottom = 18;
    const plotW = w - left - right,
      plotH = h - top - bottom;
    const xs = qcXPositions(points, left, plotW);
    const fewPoints = points.length <= 4;
    const x = i => xs[i];
    const y = v => top + ((maxY - v) * plotH) / (maxY - minY);
    const fmt = v => {
      const abs = Math.abs(v);
      return abs >= 100 ? v.toFixed(0) : abs >= 10 ? v.toFixed(1) : v.toFixed(2);
    };
    const lineFor = (v, cls, label) => {
      if (v < minY || v > maxY) {return '';}
      const yy = y(v);
      return `<line class="${cls}" x1="${left}" y1="${yy}" x2="${w - right}" y2="${yy}"></line><text class="qc-sd" x="3" y="${yy + 3}">${esc(label)}</text>`;
    };
    const path = points.map((p, i) => (i ? 'L' : 'M') + x(i).toFixed(1) + ' ' + y(p.value).toFixed(1)).join(' ');
    const dots = points
      .map((p, i) => {
        const diff = p.value - xbar;
        const z = Math.abs(diff) / spread;
        // 颜色优先级：outlier > 偏离方向
        let cls;
        if (z >= 3) {cls = 'loss';}
        else if (z >= 2) {cls = 'warn';}
        else if (diff === 0) {cls = 'eq';}
        else if (diff > 0) {cls = 'above';}
        else {cls = 'below';}
        return `<circle class="qc-dot ${cls}" cx="${x(i).toFixed(1)}" cy="${y(p.value).toFixed(1)}" r="3.2" data-date="${esc(p.date || '')}" data-val="${esc(fmt(p.value))}"></circle>`;
      })
      .join('');
    const last = points[points.length - 1];
    const xLabels = points
      .map((p, i) => {
        const label = qcFormatXLabel(p.date, fewPoints);
        return `<text class="qc-label" x="${x(i).toFixed(1)}" y="${h - 3}" text-anchor="middle">${esc(label)}</text>`;
      })
      .join('');
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
                <line class="qc-axis" x1="${left}" y1="${top}" x2="${left}" y2="${h - bottom}"></line>
                <line class="qc-axis" x1="${left}" y1="${h - bottom}" x2="${w - right}" y2="${h - bottom}"></line>
                <path class="qc-line" d="${path}"></path>
                ${dots}
                ${xLabels}
                <text class="qc-info" x="${w - right}" y="${top + 8}" text-anchor="end">靶值 ${esc(xbarStr)}  SD ${esc(sdStr)}</text>
            </svg>`;
  }

  function qcDrawLocal(ctx) {
    const host = document.getElementById('lis-qc-local');
    if (!host) {return;}
    const rows = ctx.rows || [];
    // 找出所有浓度
    const levelMap = {};
    rows.forEach(r => {
      const ln = String(r.LevelNo || '1');
      if (!levelMap[ln]) {levelMap[ln] = [];}
      const v = qcAverageValue(r);
      if (v !== null && !Number.isNaN(v)) {
        levelMap[ln].push({
          date: r.TestDate || r.AddDate || '',
          value: v,
          xbar: parseFloat(r.SetUpX),
          sd: parseFloat(r.SetUpSD),
          xbarStr: String(r.SetUpX ?? ''),
          sdStr: String(r.SetUpSD ?? '')
        });
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
    if (!drawLevels.length) {
      html = '<div id="lis-qc-empty">暂无可绘制数据。</div>';
    } else {
      drawLevels.forEach(ln => {
        const pts = levelMap[ln].slice(-45).sort((a, b) => {
          const ta = qcParseDate(a.date);
          const tb = qcParseDate(b.date);
          if (!Number.isNaN(ta) && !Number.isNaN(tb)) {return ta - tb;}
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
      const td = document.createElement('span');
      td.className = 'qc-tip-date';
      const tv = document.createElement('span');
      tv.className = 'qc-tip-val';
      tip.appendChild(td);
      tip.appendChild(document.createTextNode(' '));
      tip.appendChild(tv);
      document.body.appendChild(tip);
    }
    const tipDate = tip.querySelector('.qc-tip-date');
    const tipVal = tip.querySelector('.qc-tip-val');
    if (!host._lisQcTipBound) {
      host._lisQcTipBound = true;
      host.addEventListener('mousemove', e => {
        const dot = e.target.closest('.qc-dot');
        if (!dot) {
          tip.style.display = 'none';
          return;
        }
        const date = dot.getAttribute('data-date') || '';
        const val = dot.getAttribute('data-val') || '';
        tipDate.textContent = (date.length >= 10 ? date.slice(8, 10) : date) + '日';
        tipVal.textContent = val;
        tip.style.display = 'block';
        tip.style.transform = `translate(${e.clientX + 10}px,${e.clientY - 26}px)`;
      });
      host.addEventListener('mouseleave', () => {
        tip.style.display = 'none';
      });
    }
  }

  function qcUpdatePanel(forceFrame) {
    const panel = document.getElementById('lis-qc-panel');
    if (!panel) {return;}
    const ctx = qcBuildContext();
    const title = document.getElementById('lis-qc-title');
    const meta = panel.querySelector('.lis-qc-meta');
    const tip = panel.querySelector('.lis-qc-tip');
    const frame = document.getElementById('lis-qc-frame');
    if (!ctx.testCodeDR || !ctx.machineDR) {
      if (title) {title.textContent = '质控图';}
      if (meta) {meta.textContent = '请选择仪器和项目';}
      if (tip) {tip.textContent = '等待右侧项目列表选择完成';}
      if (frame) {frame.removeAttribute('src');}
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
    if (title) {title.textContent = ctx.testName || '质控图';}
    if (meta) {meta.textContent = `${levelText} | ${ctx.startDate} 至 ${ctx.endDate}`;}
    if (tip) {tip.textContent = `${ctx.machineName || ctx.machineDR} / ${ctx.materialName || ctx.matLotDR || '质控物'}`;}
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
    if (url) {window.open(url, '_blank');}
  }

  function qcVisibleRect(el) {
    if (!el) {return null;}
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) {return null;}
    return r;
  }

  // 获取 iframe 内元素在主框架视口中的坐标
  function qcVisibleRectInMain(el, ctx) {
    if (!el) {return null;}
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) {return null;}
    // 如果元素就在当前页面，直接返回
    if (ctx.win === window) {return r;}
    // 否则加上 iframe 的偏移
    try {
      const iframeEl = qcIFrame || qcFindIFrame();
      if (!iframeEl) {return r;}
      const iframeRect = iframeEl.getBoundingClientRect();
      return {
        left: r.left + iframeRect.left,
        top: r.top + iframeRect.top,
        right: r.right + iframeRect.left,
        bottom: r.bottom + iframeRect.top,
        width: r.width,
        height: r.height
      };
    } catch (e) {
      return r;
    }
  }

  let _qcLastPosKey = '';
  function qcPlacePanel() {
    const panel = document.getElementById('lis-qc-panel');
    if (!panel || qcPanelCollapsed) {return;}
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
    if (panel.dataset.userMoved) {return;}
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
    if (posKey === _qcLastPosKey) {return;}
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
    if (document.getElementById('lis-qc-panel')) {return;}
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
      if (!qcPanelCollapsed) {setTimeout(qcPlacePanel, 0);}
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
          fab.style.left = fp.l + 'px';
          fab.style.top = fp.t + 'px';
          fab.style.right = 'auto';
          fab.style.bottom = 'auto';
        }
      } catch (e) {}
      document.body.appendChild(fab);
    }
    function showQCFab() {
      fab.style.display = 'flex';
    }
    function hideQCFab() {
      fab.style.display = 'none';
    }
    // 拖动 QC FAB
    let qfDrag = false,
      qfMoved = false,
      qfSX,
      qfSY,
      qfOL,
      qfOT;
    fab.addEventListener('pointerdown', e => {
      qfDrag = true;
      qfMoved = false;
      qfSX = e.clientX;
      qfSY = e.clientY;
      qfOL = fab.offsetLeft;
      qfOT = fab.offsetTop;
      fab.setPointerCapture(e.pointerId);
      fab.style.transition = 'none';
      e.preventDefault();
    });
    fab.addEventListener('pointermove', e => {
      if (!qfDrag) {return;}
      const dx = e.clientX - qfSX,
        dy = e.clientY - qfSY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {qfMoved = true;}
      if (qfMoved) {
        fab.style.left = Math.max(0, qfOL + dx) + 'px';
        fab.style.top = Math.max(0, qfOT + dy) + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
      }
    });
    fab.addEventListener('pointerup', () => {
      qfDrag = false;
      fab.style.transition = '';
      if (qfMoved) {
        try {
          localStorage.setItem('lis-qc-fab-pos', JSON.stringify({ l: fab.offsetLeft, t: fab.offsetTop }));
        } catch (e) {}
      }
    });
    fab.addEventListener('click', () => {
      if (qfMoved) {return;}
      panel.style.display = '';
      qcPanelClosed = false;
      hideQCFab();
      qcScheduleRefresh(true, 0);
    });
    // 面板可见时隐藏悬浮按钮
    const fabObs = new MutationObserver(() => {
      if (panel.style.display === 'none') {showQCFab();}
      else {hideQCFab();}
    });
    fabObs.observe(panel, { attributes: true, attributeFilter: ['style'] });
    if (!_qcObservers) {_qcObservers = [];}
    _qcObservers.push(fabObs);
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
      if (e.target.tagName === 'BUTTON') {return;}
      beginQCInteract();
      const startX = e.clientX;
      const startY = e.clientY;
      const startLeft = panel.offsetLeft;
      const startTop = panel.offsetTop;
      const width = panel.offsetWidth;
      const height = panel.offsetHeight;
      head.setPointerCapture(e.pointerId);
      const move = ev => {
        const vw = window.innerWidth,
          vh = window.innerHeight;
        const nl = startLeft + (ev.clientX - startX);
        const nt = startTop + (ev.clientY - startY);
        panel.style.left = Math.max(0, Math.min(nl, vw - width)) + 'px';
        panel.style.top = Math.max(0, Math.min(nt, vh - height)) + 'px';
      };
      const up = ev => {
        try {
          head.releasePointerCapture(ev.pointerId);
        } catch (x) {}
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
        const vw = window.innerWidth,
          vh = window.innerHeight;
        const minW = 360,
          minH = 340;
        const maxW = vw - left - 8;
        const maxH = vh - top - 8;
        const nw = Math.max(minW, Math.min(startW + (ev.clientX - startX), maxW));
        const nh = Math.max(minH, Math.min(startH + (ev.clientY - startY), maxH));
        panel.style.width = nw + 'px';
        panel.style.height = nh + 'px';
      };
      const up = ev => {
        try {
          resize.releasePointerCapture(ev.pointerId);
        } catch (x) {}
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
    if (!jq || !jq(selector)[plugin]) {return;}
    qcTryEasyUI(() => {
      const opts = jq(selector)[plugin]('options');
      if (!opts || opts['_lisQc_' + name]) {return;}
      const old = opts[name];
      opts['_lisQc_' + name] = true;
      opts[name] = function () {
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
    targetDoc.addEventListener(
      'keyup',
      e => {
        if (e.target && /^(INPUT|TEXTAREA)$/i.test(e.target.tagName)) {qcScheduleRefresh(false, 260);}
      },
      true
    );
    ['click', 'change'].forEach(ev =>
      targetDoc.addEventListener(
        ev,
        () => {
          qcScheduleRefresh(false, 320);
        },
        true
      )
    );
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
      // 保存引用以便后续清理
      if (!_qcObservers) {_qcObservers = [];}
      _qcObservers.push(ob);
    }
  }

  function initQCInputEnhance() {
    if (qcInputInited) {return;}
    if (!isQCDataInputPage()) {return;}
    const wait = left => {
      const jq = getJQ();
      const ctx = qcGetCtx();
      const ready = jq && jq('#dgTestCode').length && jq('#dgTestCode').datagrid && ctx.doc.getElementById('dgData');
      if (!ready) {
        if (left > 0) {setTimeout(() => wait(left - 1), 300);}
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
    if (qcProbeTimer) {return;}
    const probe = () => {
      const isQC = isQCDataInputPage();
      const panel = document.getElementById('lis-qc-panel');
      if (isQC && !qcInputInited && !qcPanelClosed) {initQCInputEnhance();}
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
  let prAbortCtrl = null; // 当前查询的 AbortController
  let prQuerySeq = 0; // 查询序号，防止旧查询回写新结果
  let prPage = 1; // 当前页码（从 1 开始）
  let prDatePickerCleanup = null;
  let prLastDetailFailures = 0;
  const prPageSize = 100; // 每页行数
  const _prDetailCache = new Map(); // 详情结果 LRU 缓存
  const _prDetailInflight = new Map(); // 正在读取的明细请求，防止重复点击重复请求
  const _prWorkListCache = new Map(); // 标本列表短缓存，切换筛选条件时复用
  const _PR_DETAIL_MAX = 12000; // PR 模块缓存上限（结果查询一次性查询量大）
  const _PR_WORKLIST_MAX = 20;
  const _PR_WORKLIST_TTL = 120000; // 2 分钟内同日期/工作组/仪器/状态复用标本列表
  const PR_WORKLIST_PAGE_SIZE = 1000;
  const PR_WORKLIST_MAX_PAGES = 500;

  function prTodayOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + (days || 0));
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  }

  function prStatusText(status) {
    const map = { 0: '待排样', 1: '登记', 2: '初审', 3: '审核', 4: '复审', 5: '取消' };
    return map[String(status || '')] || String(status || '');
  }

  function prSetStatus(text, type) {
    const el = document.getElementById('lis-pr-status');
    if (!el) {return;}
    el.textContent = text || '';
    el.classList.remove('ok', 'error', 'info');
    if (type === 'error') {el.classList.add('error');}
    else if (type === 'ok') {el.classList.add('ok');}
    else if (type === 'info') {el.classList.add('info');}
  }

  function prSetBusy(on) {
    prBusy = !!on;
    ['lis-pr-query', 'lis-pr-export', 'lis-pr-cancel'].forEach(id => {
      const btn = document.getElementById(id);
      if (!btn) {return;}
      if (id === 'lis-pr-cancel') {btn.style.display = on ? '' : 'none';}
      else {btn.disabled = prBusy;}
    });
  }

  function prCancel() {
    prQuerySeq++;
    if (prAbortCtrl) {
      prAbortCtrl.abort();
      prAbortCtrl = null;
    }
    prSetStatus('已取消查询。', 'info');
    prSetBusy(false);
  }

  /* ---------- LRU 缓存（复用工作台 _detailLRU 模式） ---------- */
  function prCacheGet(key) {
    if (!_prDetailCache.has(key)) {return null;}
    const v = _prDetailCache.get(key);
    _prDetailCache.delete(key);
    _prDetailCache.set(key, v); // 移到最新
    return v;
  }
  function prCacheSet(key, val) {
    if (_prDetailCache.has(key)) {_prDetailCache.delete(key);}
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
    return (
      (specimen.ReportDR || specimen.TodoReportDR || '') +
      '|' +
      prMachineParameterDR(specimen) +
      '|' +
      prWorkGroupMachineDR(specimen) +
      '|' +
      (specimen.Status || specimen.ReportStatus || '')
    );
  }

  function prWorkListCacheKey(filters) {
    return [
      filters.start,
      filters.end,
      (filters.wgs || []).join(','),
      (filters.machines || []).join(','),
      filters.status || ''
    ].join('|');
  }

  function prWorkListCacheGet(key) {
    const hit = _prWorkListCache.get(key);
    if (!hit) {return null;}
    if (Date.now() - hit.ts > _PR_WORKLIST_TTL) {
      _prWorkListCache.delete(key);
      return null;
    }
    _prWorkListCache.delete(key);
    _prWorkListCache.set(key, hit);
    return hit.rows;
  }

  function prWorkListCacheSet(key, rows) {
    if (_prWorkListCache.has(key)) {_prWorkListCache.delete(key);}
    while (_prWorkListCache.size >= _PR_WORKLIST_MAX) {
      _prWorkListCache.delete(_prWorkListCache.keys().next().value);
    }
    _prWorkListCache.set(key, { ts: Date.now(), rows });
  }

  function prCleanFilterText(value) {
    const text = String(value || '').trim();
    if (!text) {return '';}
    const lower = text.toLowerCase();
    if (/^(如|例如|示例)\s*/.test(text)) {return '';}
    if (lower === '姓名 / 检验号 / 住院号' || lower === '姓名 / 检验号 / 登记号 / 病案号') {return '';}
    if (text === '门诊 / 住院' || text === '诊断关键字') {return '';}
    if (text === '如 传染病八项' || text === '如 梅毒（仅单项名）') {return '';}
    return text;
  }

  function prSplitTerms(value) {
    const text = prCleanFilterText(value);
    if (!text) {return [];}
    return text
      .split(/[\s,，、|；;]+/)
      .map(s => s.trim().toLowerCase())
      .filter(Boolean);
  }

  function prTextMatchAny(value, queryOrTerms) {
    const terms = Array.isArray(queryOrTerms) ? queryOrTerms : prSplitTerms(queryOrTerms);
    if (!terms.length) {return true;}
    const text = String(value || '').toLowerCase();
    return terms.some(term => text.includes(term));
  }

  function prSelectedValues(id) {
    const el = document.getElementById(id);
    if (!el) {return [];}
    if (el.multiple)
    {return Array.from(el.selectedOptions || [])
      .map(o => o.value)
      .filter(Boolean);}
    return el.value ? [el.value] : [];
  }

  function prCheckedValues(selector) {
    return Array.from(document.querySelectorAll(selector + ':checked'))
      .map(el => el.value)
      .filter(Boolean);
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
    filters.testSet = prCleanFilterText(filters.testSet).toLowerCase();
    filters.item = prCleanFilterText(filters.item).toLowerCase();
    filters.resultText = prCleanFilterText(filters.resultText).toLowerCase();
    filters.qTerms = prSplitTerms(filters.q);
    filters.patientTypeTerms = prSplitTerms(filters.patientType);
    filters.deptTerms = prSplitTerms(filters.dept);
    filters.wardTerms = prSplitTerms(filters.ward);
    filters.doctorTerms = prSplitTerms(filters.doctor);
    filters.diagnosisTerms = prSplitTerms(filters.diagnosis);
    filters.specimenTerms = prSplitTerms(filters.specimen);
    filters.testSetTerms = prSplitTerms(filters.testSet);
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
    const wgNames = (filters.wgs || []).map(
      dr => (WG_MAP[dr] || WG_EXPORT.find(w => String(w.dr) === String(dr)) || {}).name || dr
    );
    parts.push(`工作组=${wgNames.length ? wgNames.join('/') : '全部'}`);
    if ((filters.machines || []).length) {
      const names = Array.from(document.querySelectorAll('.lis-pr-machine-check:checked')).map(o => {
        const label = o.closest('label');
        const wg = (WG_MAP[o.dataset.wg] || {}).name || o.dataset.wg || '';
        return (wg ? wg + '-' : '') + ((label && label.textContent) || o.value || '').trim();
      });
      parts.push(`仪器=${names.join('/')}`);
    }
    if (filters.status) {parts.push(`状态=${prStatusText(filters.status)}`);}
    if (filters.q) {parts.push(`综合=${filters.q}`);}
    if (filters.patientType) {parts.push(`病人类型=${filters.patientType}`);}
    if (filters.dept) {parts.push(`科室=${filters.dept}`);}
    if (filters.ward) {parts.push(`病区=${filters.ward}`);}
    if (filters.doctor) {parts.push(`医生=${filters.doctor}`);}
    if (filters.diagnosis) {parts.push(`诊断=${filters.diagnosis}`);}
    if (filters.sex) {parts.push(`性别=${filters.sex}`);}
    if (!Number.isNaN(filters.ageMin)) {parts.push(`年龄>=${filters.ageMin}`);}
    if (!Number.isNaN(filters.ageMax)) {parts.push(`年龄<=${filters.ageMax}`);}
    if (filters.specimen) {parts.push(`标本=${filters.specimen}`);}
    if (filters.testSet) {parts.push(`组合=${filters.testSet}`);}
    if (filters.item) {parts.push(`项目=${filters.item}`);}
    if (filters.judge) {parts.push(`判断=${classifyStatusText(filters.judge)}`);}
    if (filters.resultText) {parts.push(`结果文本=${filters.resultText}`);}
    if (filters.resultOp && !Number.isNaN(filters.resultValue))
    {parts.push(`数值${filters.resultOp}${filters.resultValue}`);}
    if (!Number.isNaN(filters.resultMin)) {parts.push(`数值>=${filters.resultMin}`);}
    if (!Number.isNaN(filters.resultMax)) {parts.push(`数值<=${filters.resultMax}`);}
    if (filters.abnormal) {parts.push('仅异常结果');}
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
      testSet: val('lis-pr-testset').toLowerCase(),
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
    if (!box) {return;}
    const oldSelected = new Set(prCheckedValues('.lis-pr-machine-check'));
    const oldWGs = new Set(prCheckedValues('.lis-pr-wg-check'));
    box.innerHTML = '<span style="font-size:11px;color:#7b8b96;padding:4px 6px">仪器加载中...</span>';
    // 结果导出含外送；审核/质控仍只用 WG
    const targetWGs = WG_EXPORT;
    try {
      const groups = await Promise.all(
        targetWGs.map(async w => {
          const machines = await loadMachines(w.dr).catch(() => []);
          return {
            wg: w,
            machines: sortWSMachines(
              (Array.isArray(machines) ? machines : []).map(m => ({ ...m, _wg: w.dr, _wgn: w.name }))
            )
          };
        })
      );
      box.innerHTML = groups
        .map(g => {
          const wgChecked = oldWGs.has(g.wg.dr) ? ' checked' : '';
          const items = g.machines.length
            ? g.machines
              .map(m => {
                const value = (m._wg || '') + '|' + (m.RowID || '');
                const checked = oldSelected.has(value) ? ' checked' : '';
                const name = esc(m.CName || m.Name || m.RowID || '');
                return `<label class="pr-mach-option" title="${name}"><input type="checkbox" class="lis-pr-machine-check" data-wg="${esc(g.wg.dr)}" value="${esc(value)}"${checked}>${name}</label>`;
              })
              .join('')
            : '<div style="font-size:11px;color:#9aa5b1;padding:2px 0">未加载到仪器</div>';
          return `<div class="pr-wg-box" data-wg="${esc(g.wg.dr)}">
                    <div class="pr-wg-head"><span class="pr-fold">▾</span><input type="checkbox" class="lis-pr-wg-check" value="${esc(g.wg.dr)}"${wgChecked}><span>${esc(g.wg.name)}</span></div>
                    <div class="pr-wg-body">${items}</div>
                </div>`;
        })
        .join('');
      box.querySelectorAll('.pr-wg-head').forEach(head => {
        head.addEventListener('click', e => {
          if (e.target && e.target.classList && e.target.classList.contains('lis-pr-wg-check')) {return;}
          const group = head.closest('.pr-wg-box');
          if (!group) {return;}
          group.classList.toggle('collapsed');
          const f = head.querySelector('.pr-fold');
          if (f) {f.textContent = group.classList.contains('collapsed') ? '▸' : '▾';}
        });
      });
    } catch (e) {
      prSetStatus('仪器列表加载失败: ' + e.message, 'error');
    }
  }

  function prNormalizeWorkRow(r, wg, machine, machineMap) {
    const rowMdr = prWorkGroupMachineDR(r) || machine.RowID || '';
    const known = rowMdr && machineMap ? machineMap.get(String(rowMdr)) : null;
    const rowMachineName = prFirstText(
      r.WorkGroupMachineName,
      r.WorkGroupMachineDesc,
      r.MachineName,
      r.MachName,
      r.Machine,
      known && (known.CName || known.Name || known.RowID),
      machine.CName,
      machine.Name,
      machine.RowID
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

  let prLastWorkListHadFailures = false; // 最近一次工作列表查询是否有工作组/仪器失败

  /* 并行加载所有工作组的标本列表 */
  async function prLoadRows(filters, signal) {
    prLastWorkListHadFailures = false;
    const cacheKey = prWorkListCacheKey(filters);
    const cachedRows = prWorkListCacheGet(cacheKey);
    if (cachedRows) {
      prSetStatus(`复用标本列表缓存：${cachedRows.length} 个标本。`, 'info');
      return cachedRows;
    }
    const machinePairs = (filters.machines || [])
      .map(v => {
        const parts = String(v).split('|');
        return { wg: parts[0] || '', mdr: parts.slice(1).join('|') || '' };
      })
      .filter(x => x.wg && x.mdr);
    const selectedWGs = filters.wgs || [];
    const effectiveWGSet = new Set(selectedWGs);
    machinePairs.forEach(x => effectiveWGSet.add(x.wg));
    const effectiveWGs = Array.from(effectiveWGSet).filter(Boolean);
    const targetWGs = effectiveWGs.length
      ? WG_EXPORT.filter(w => effectiveWGs.includes(w.dr) || effectiveWGs.includes(String(w.dr)))
      : WG_EXPORT;
    const wgTotal = targetWGs.length;
    dbg(
      'prLoadRows 有效查询范围:',
      '工作组=' + (targetWGs.map(w => w.name).join('/') || '全部'),
      '仪器=' + (machinePairs.map(x => x.wg + '|' + x.mdr).join(',') || '全部')
    );

    /* 所有工作组并行加载 */
    let requestFailed = false;
    const wgPromises = targetWGs.map(async (w, wgIdx) => {
      if (signal && signal.aborted) {return [];}
      let machines;
      try {
        machines = await loadMachines(w.dr);
      } catch (e) {
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
        if (signal && signal.aborted) {return [];}
        const mname = m.CName || m.Name || m.RowID || '';
        prSetStatus(
          `正在查询 [${w.name}] ${mname}（工作组 ${wgIdx + 1}/${wgTotal}，仪器 ${mIdx + 1}/${total}）...`,
          'info'
        );
        const p = new URLSearchParams();
        p.set('ClassName', 'LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
        p.set('QueryName', 'QryWorkList');
        p.set('FunModul', 'MTHD');
        p.set('P0', filters.status || '');
        p.set('P1', filters.start);
        p.set('P2', filters.end);
        p.set('P10', m.RowID || '');
        p.set('P11', 'N^^^^');
        p.set('P14', ss);
        try {
          const list = await prFetchWorkListRange(p, filters.start, filters.end, signal);
          return list.map(r => prNormalizeWorkRow(r, w, m, machineMap));
        } catch (e) {
          if (e.name === 'AbortError') {return [];}
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
          dbg(
            '病人结果：整组查询缺少部分仪器DR，自动退回逐台仪器查询:',
            w.name,
            '标本数=' + groupRows.length,
            '带仪器DR=' + taggedWgm
          );
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
      dbg(
        'prLoadRows 工作组:',
        w.name,
        '仪器数=' + queryTargets.length,
        '标本数=' + wgCount,
        'fallback=' + useGroupFallback
      );
      return results.flat();
    });

    const wgResults = await Promise.all(wgPromises);
    const rows = wgResults.flat();
    prLastWorkListHadFailures = !!requestFailed;
    dbg('prLoadRows 完成:', '总标本数=' + rows.length, '工作组数=' + wgTotal, 'requestFailed=' + requestFailed);
    // 只在有结果且无失败时缓存，避免缓存空结果
    if (!(signal && signal.aborted) && !requestFailed && rows.length > 0) {prWorkListCacheSet(cacheKey, rows);}
    return rows;
  }

  function prFilterRows(rows, filters) {
    let data = rows;
    if (filters.q) {
      data = data.filter(r =>
        [r.PatName, r.Labno, r.EpisodeNo, r.RegNo, r.AdmNo, r.RecordNo].some(v => prTextMatchAny(v, filters.qTerms))
      );
    }
    if (filters.testSet) {
      data = data.filter(r => prTextMatchAny(r.TestSetDesc, filters.testSetTerms));
    }
    if (filters.sex)
    {data = data.filter(r => {
      const sex = String(r.Sex || r.Species || '');
      return !sex || sex.includes(filters.sex);
    });}
    /* 患者类型、科室、病区、诊断、标本等字段在工作列表中经常不完整。
           这些条件统一放到明细读取后严格筛选，避免全年查询时提前漏标本。 */
    return data;
  }

  function prIsExportOnlyWG(wg) {
    return String(wg || '') === '5' || String((WG_MAP[wg] || {}).name || '') === '外送';
  }

  function prMayHaveResult(row) {
    // 外送：第三方回传结果时，工作列表 ResultFlag/IsComplete 经常仍是 N/0，不能据此跳过
    if (prIsExportOnlyWG(row && row._wg)) {return true;}
    // 已初审/审核/复审：通常有结果，即使标志位滞后也读明细
    const st = String((row && (row.Status || row.ReportStatus)) || '');
    if (st === '2' || st === '3' || st === '4') {return true;}
    const resultFlag = String((row && row.ResultFlag) || '').toUpperCase();
    const complete = String((row && row.IsComplete) || '');
    if (resultFlag === 'N' && complete === '0') {return false;}
    return true;
  }

  function prNeedsDetailEvenWithoutResult(filters) {
    // 仅查外送（勾工作组或仪器）时强制读明细，避免 ResultFlag 误杀
    const onlyExportWG = (filters.wgs || []).length > 0 && (filters.wgs || []).every(prIsExportOnlyWG);
    const onlyExportMachine =
      (filters.machines || []).length > 0 && (filters.machines || []).every(v => String(v).split('|')[0] === '5');
    if (onlyExportWG || onlyExportMachine) {return true;}
    // 病人类型/科室等工作列表常缺字段，必须读明细才能筛
    return !!(
      filters.patientType ||
      filters.dept ||
      filters.doctor ||
      filters.diagnosis ||
      filters.ward ||
      !Number.isNaN(filters.ageMin) ||
      !Number.isNaN(filters.ageMax) ||
      filters.item ||
      filters.resultText ||
      filters.judge ||
      filters.abnormal ||
      filters.resultOp ||
      !Number.isNaN(filters.resultMin) ||
      !Number.isNaN(filters.resultMax)
    );
  }

  function prTextMatch(value, q) {
    return (
      !q ||
      String(value || '')
        .toLowerCase()
        .includes(q)
    );
  }

  function prDateRanges(startText, endText) {
    const start = prParseDateText(startText);
    const end = prParseDateText(endText);
    if (!start || !end || start > end) {return [{ start: startText, end: endText }];}
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
    if (parts.some(Boolean)) {return parts.join('|');}
    try {
      dbg('prWorkRowDedupeKey: 所有组合键字段为空，回退到 JSON 序列化', r);
      return JSON.stringify(r);
    } catch (e) {
      dbg('prWorkRowDedupeKey: JSON 序列化失败，数据质量异常', e.message);
      return String(Math.random());
    }
  }

  function prDedupeWorkRows(rows) {
    const seen = new Set();
    const out = [];
    rows.forEach(r => {
      const key = prWorkRowDedupeKey(r);
      if (seen.has(key)) {return;}
      seen.add(key);
      out.push(r);
    });
    return out;
  }

  function prRowsFromResponse(data) {
    return data && data.rows ? data.rows : Array.isArray(data) ? data : [];
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
      if (signal && signal.aborted) {return out;}
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
      if (rows.length < pageSize) {break;}
      /* LIS 有时 total 不准：满页时主动多探一页；如果下一页全重复则停止，避免死循环。 */
      if (page > 1 && rows.length > 0 && fresh === 0) {break;}
      if (total > 0 && out.length >= total && rows.length < pageSize) {break;}
    }
    return out;
  }

  async function prFetchWorkListRange(baseParams, start, end, signal) {
    const ranges = prDateRanges(start, end);
    if (ranges.length <= 1) {return prFetchWorkListPages(baseParams, signal);}
    const out = [];
    for (let i = 0; i < ranges.length; i += 1) {
      if (signal && signal.aborted) {break;}
      const seg = ranges[i];
      const p = new URLSearchParams(baseParams.toString());
      p.set('P1', seg.start);
      p.set('P2', seg.end);
      prSetStatus(`正在分段查询 ${seg.start} 至 ${seg.end}（${i + 1}/${ranges.length}）...`, 'info');
      out.push(...(await prFetchWorkListPages(p, signal)));
    }
    return prDedupeWorkRows(out);
  }

  function prFirstText() {
    for (let i = 0; i < arguments.length; i += 1) {
      const v = arguments[i];
      if (v == null) {continue;}
      const text = String(v).trim();
      if (text) {return text;}
    }
    return '';
  }

  function prPatientTypeText(specimen, labInfo) {
    specimen = specimen || {};
    labInfo = labInfo || {};
    const direct = prFirstText(
      specimen.AdmType,
      specimen.AdmTypeName,
      specimen.AdmissionType,
      specimen.AdmissionTypeName,
      specimen.PatientTypeName,
      specimen.PatientType,
      specimen.PatientClassName,
      specimen.PatientClass,
      specimen.PatTypeName,
      specimen.PatType,
      specimen.PatTypeDesc,
      specimen.VisitTypeName,
      specimen.VisitType,
      labInfo.AdmType,
      labInfo.AdmTypeName,
      labInfo.AdmissionType,
      labInfo.AdmissionTypeName,
      labInfo.PatientTypeName,
      labInfo.PatientType,
      labInfo.PatientClassName,
      labInfo.PatientClass,
      labInfo.PatTypeName,
      labInfo.PatType,
      labInfo.PatTypeDesc,
      labInfo.VisitTypeName,
      labInfo.VisitType
    );
    if (direct) {return direct;}
    const inpatientHint = prFirstText(
      specimen.AdmNo,
      specimen.InHospNo,
      specimen.InpatientNo,
      specimen.InPatientNo,
      specimen.HospitalNo,
      labInfo.AdmNo,
      labInfo.InHospNo,
      labInfo.InpatientNo,
      labInfo.InPatientNo,
      labInfo.HospitalNo,
      specimen.BedNo,
      specimen.Bed,
      labInfo.BedNo,
      labInfo.Bed
    );
    const wardHint = prFirstText(specimen.Ward, specimen.WardName, labInfo.Ward, labInfo.WardName);
    if (inpatientHint || wardHint) {return '住院';}
    const outpatientHint = prFirstText(
      specimen.ClinicNo,
      specimen.OutpatientNo,
      specimen.OutPatientNo,
      specimen.OPNo,
      labInfo.ClinicNo,
      labInfo.OutpatientNo,
      labInfo.OutPatientNo,
      labInfo.OPNo
    );
    if (outpatientHint) {return '门诊';}
    return '';
  }

  function prAsArray(value) {
    if (!value) {return [];}
    if (Array.isArray(value)) {return value;}
    if (Array.isArray(value.rows)) {return value.rows;}
    return [value];
  }

  function prNumberPass(value, filters) {
    if (filters.resultOp && Number.isNaN(filters.resultValue)) {return true;}
    const parsed = parseComparableNumber(value);
    if (!parsed || Number.isNaN(parsed.value)) {
      return (
        !filters.resultOp &&
        Number.isNaN(filters.resultValue) &&
        Number.isNaN(filters.resultMin) &&
        Number.isNaN(filters.resultMax)
      );
    }
    const n = parsed.value;
    const op = parsed.op || ''; // '' 精确 | '<' | '<=' | '>' | '>='
    // 带操作符的结果（如 <0.5、>1000）不能当作精确值参与比较：
    // 只在操作符方向能确定判定时通过，无法确定的保守剔除（与 compareResultToRange 口径一致）
    if (filters.resultOp && !Number.isNaN(filters.resultValue)) {
      const v = filters.resultValue;
      let certain = false;
      if (op === '') {
        if (filters.resultOp === 'gt') {certain = n > v;}
        else if (filters.resultOp === 'gte') {certain = n >= v;}
        else if (filters.resultOp === 'lt') {certain = n < v;}
        else if (filters.resultOp === 'lte') {certain = n <= v;}
        else if (filters.resultOp === 'eq') {certain = Math.abs(n - v) < 1e-9;}
      } else if (op === '<' || op === '<=') {
        // 实际值 ≤/ < n：只能确定「上界」类比较
        if (filters.resultOp === 'lt') {certain = op === '<' ? n <= v : n < v;}
        else if (filters.resultOp === 'lte') {certain = n <= v;}
      } else if (op === '>' || op === '>=') {
        // 实际值 ≥/ > n：只能确定「下界」类比较
        if (filters.resultOp === 'gt') {certain = op === '>' ? n >= v : n > v;}
        else if (filters.resultOp === 'gte') {certain = n >= v;}
      }
      if (!certain) {return false;}
    }
    if (!Number.isNaN(filters.resultMin)) {
      // 需要 实际值 ≥ min
      let ok = false;
      if (op === '') {ok = n >= filters.resultMin;}
      else if (op === '>' || op === '>=') {ok = n >= filters.resultMin;} // 实际值 ≥ n ≥ min
      // '<'/'<=' 是上界，无法确认 ≥ min → 剔除
      if (!ok) {return false;}
    }
    if (!Number.isNaN(filters.resultMax)) {
      // 需要 实际值 ≤ max
      let ok = false;
      if (op === '') {ok = n <= filters.resultMax;}
      else if (op === '<' || op === '<=') {ok = n <= filters.resultMax;} // 实际值 ≤ n ≤ max
      // '>'/'>=' 是下界，无法确认 ≤ max → 剔除
      if (!ok) {return false;}
    }
    return true;
  }

  function prResultPass(row, filters) {
    if (filters.patientType && !prTextMatchAny(row.patientType, filters.patientTypeTerms)) {return false;}
    if (filters.sex && !String(row.sex || '').includes(filters.sex)) {return false;}
    if (filters.dept && !prTextMatchAny([row.location, row.ward].filter(Boolean).join(' '), filters.deptTerms))
    {return false;}
    if (filters.ward && !prTextMatchAny(row.ward, filters.wardTerms)) {return false;}
    if (filters.doctor && !prTextMatchAny(row.doctor, filters.doctorTerms)) {return false;}
    if (filters.specimen && !prTextMatchAny(row.specimen, filters.specimenTerms)) {return false;}
    if (filters.testSet && !prTextMatchAny(row.testSet, filters.testSetTerms)) {return false;}
    if (filters.item && !prTextMatchAny([row.itemName, row.itemSynonym].filter(Boolean).join(' '), filters.itemTerms))
    {return false;}
    if (
      filters.resultText &&
      !prTextMatchAny(
        [row.result, row.abFlag, classifyStatusText(row.status)].filter(Boolean).join(' '),
        filters.resultTextTerms
      )
    )
    {return false;}
    if (filters.diagnosis && !prTextMatchAny(row.diagnosis, filters.diagnosisTerms)) {return false;}
    if (filters.judge && row.status !== filters.judge) {return false;}
    if (filters.abnormal && row.status === 'NORMAL') {return false;}
    /* 年龄筛选 */
    if (!Number.isNaN(filters.ageMin) || !Number.isNaN(filters.ageMax)) {
      const age = parseFloat(row.age);
      if (Number.isNaN(age)) {return false;}
      if (!Number.isNaN(filters.ageMin) && age < filters.ageMin) {return false;}
      if (!Number.isNaN(filters.ageMax) && age > filters.ageMax) {return false;}
    }
    if (
      (filters.resultOp && !Number.isNaN(filters.resultValue)) ||
      !Number.isNaN(filters.resultMin) ||
      !Number.isNaN(filters.resultMax)
    ) {
      if (!prNumberPass(row.result, filters)) {return false;}
    }
    return true;
  }

  /* 清理参考范围中的日期格式 */
  function cleanRefRange(ref) {
    if (!ref) {return '';}
    ref = ref
      .replace(/\d{4}-\d{2}-\d{2}/g, '')
      // 注意：不能加 \d{2}-\d{2} 规则——会误删合法参考区间（如 110-160 → 10、100-200 → 10）
      .replace(/\d{4}\/\d{2}\/\d{2}/g, '');
    ref = ref
      .replace(/\s+/g, ' ')
      .replace(/,\s*,/g, ',')
      .replace(/^[\s,]+|[\s,]+$/g, '');
    return ref.trim();
  }

  // 规范化金额展示（去掉 ￥/逗号，保留数字字符串）
  function prNormalizePrice(value) {
    if (value == null || value === '') {return '';}
    let s = String(value).trim();
    if (!s) {return '';}
    s = s.replace(/[￥¥,\s]/g, '');
    return s === '-' ? '' : s;
  }

  // 按 VisitNumber 缓存医嘱组合费用（FindVisitNumberTSList → TestSetFee）
  const _PR_FEE_CACHE_MAX = 5000;
  const _prTestSetFeeCache = new Map();
  const _prTestSetFeeInflight = new Map();
  async function prFetchTestSetFees(visitNumberDR, signal) {
    const key = String(visitNumberDR || '');
    if (!key) {return [];}
    if (_prTestSetFeeCache.has(key)) {
      // LRU：命中后移到最新位置
      const val = _prTestSetFeeCache.get(key);
      _prTestSetFeeCache.delete(key);
      _prTestSetFeeCache.set(key, val);
      return val;
    }
    if (_prTestSetFeeInflight.has(key)) {return _prTestSetFeeInflight.get(key);}
    const promise = (async () => {
      try {
        const url =
          BASE + '/lis/ashx/ashVisitNumber.ashx?method=FindVisitNumberTSList&VisitNumberDR=' + encodeURIComponent(key);
        const data = await fetchJRetry(url, 15000, signal, 1, 200);
        const rows = data && data.rows ? data.rows : Array.isArray(data) ? data : [];
        const list = rows
          .map(r => ({
            dr: String(r.TestSetDR || ''),
            desc: String(r.TestSetDesc || r.TestSetName || '').trim(),
            fee: prNormalizePrice(r.TestSetFee != null ? r.TestSetFee : r.Price)
          }))
          .filter(x => x.desc || x.fee);
        _prTestSetFeeCache.set(key, list);
        // LRU 淘汰
        while (_prTestSetFeeCache.size > _PR_FEE_CACHE_MAX) {
          _prTestSetFeeCache.delete(_prTestSetFeeCache.keys().next().value);
        }
        return list;
      } catch (e) {
        if (e && e.name === 'AbortError') {throw e;}
        // 失败不写入空缓存，避免瞬时故障后整会话费用全空
        return [];
      } finally {
        _prTestSetFeeInflight.delete(key);
      }
    })();
    _prTestSetFeeInflight.set(key, promise);
    return promise;
  }

  function prMatchTestSetFee(feeList, testSetName) {
    if (!feeList || !feeList.length) {return { fee: '', detail: '' };}
    const detail = feeList.map(x => (x.desc || '医嘱') + (x.fee !== '' ? ':' + x.fee : '')).join('; ');
    if (!testSetName) {return { fee: feeList.length === 1 ? feeList[0].fee || '' : '', detail };}
    const name = String(testSetName).trim();
    const hit = feeList.find(x => x.desc && (x.desc === name || name.includes(x.desc) || x.desc.includes(name)));
    if (hit) {return { fee: hit.fee || '', detail };}
    if (feeList.length === 1) {return { fee: feeList[0].fee || '', detail };}
    return { fee: '', detail };
  }

  function prRowsFromDetailData(specimen, data, feeList) {
    const itemInfo = prAsArray(data && data.ItemInfo);
    const labInfo = prAsArray(data && data.LabInfo)[0] || {};
    // 报告头费用：与原生界面「费用」字段一致（LabInfo.Price）
    const reportPrice = prNormalizePrice(labInfo.Price != null ? labInfo.Price : specimen.Price);
    const visitNumberDR = labInfo.VisitNumberDR || specimen.VisitNumberDR || specimen.VisitNumber || '';
    const labTestSet = labInfo.TestSetDesc || specimen.TestSetDesc || '';
    const feeDetailFromList =
      feeList && feeList.length
        ? feeList.map(x => (x.desc || '医嘱') + (x.fee !== '' ? ':' + x.fee : '')).join('; ')
        : '';
    return itemInfo.map(item => {
      const result = (item.TextRes && String(item.TextRes).trim() ? item.TextRes : item.Result || '').trim();
      const status = classifyResultItem(item);
      const itemTestSet = item.TestSetName || item.TestSetDesc || labTestSet;
      const itemPrice = prNormalizePrice(item.Price);
      const matched = prMatchTestSetFee(feeList, itemTestSet || labTestSet);
      return {
        workGroup: specimen._wgn || '',
        machine: specimen._mn || '',
        patient: specimen.PatName || labInfo.PatName || '',
        patientType: prPatientTypeText(specimen, labInfo),
        sex: specimen.Sex || labInfo.Sex || labInfo.Species || '',
        age: specimen.Age || labInfo.Age || '',
        labno: specimen.Labno || labInfo.Labno || '',
        episodeNo: specimen.EpisodeNo || labInfo.EpisodeNo || '',
        regNo: specimen.RegNo || labInfo.RegNo || '',
        recordNo: specimen.RecordNo || labInfo.RecordNo || '',
        location: specimen.Location || specimen.LocationName || labInfo.Location || labInfo.LocationName || '',
        ward: specimen.Ward || specimen.WardName || labInfo.Ward || labInfo.WardName || '',
        doctor:
          specimen.Doctor ||
          specimen.DoctorName ||
          specimen.ReqDoctorName ||
          specimen.ApplyDoctorName ||
          labInfo.Doctor ||
          labInfo.DoctorName ||
          labInfo.ReqDoctorName ||
          '',
        diagnosis: specimen.Diagnose || specimen.Diagnosis || labInfo.Diagnose || labInfo.Diagnosis || '',
        specimen: specimen.Specimen || specimen.SpecimenDesc || labInfo.Specimen || labInfo.SpecimenDesc || '',
        testSet: itemTestSet || labTestSet,
        acceptDT: specimen.AcceptDT || labInfo.AcceptDT || labInfo.AcceptDate || '',
        reportStatus: prStatusText(specimen.Status || specimen.ReportStatus || labInfo.Status),
        itemName: item.CName || item.Name || '',
        itemSynonym: item.Synonym || item.Code || '',
        result,
        unit: item.Unit || item.Units || '',
        refRange: cleanRefRange(item.RefRanges || item.RefRange || item.ReferenceRange || ''),
        abFlag: item.AbFlag || '',
        status,
        // 收费：报告总费用 / 单项价（常空）/ 医嘱组合价 / 医嘱费用明细
        reportPrice,
        itemPrice,
        testSetFee: matched.fee,
        feeDetail: matched.detail || feeDetailFromList,
        visitNumberDR
      };
    });
  }

  async function prFetchResultRows(specimen, filters, signal) {
    if (signal && signal.aborted) {return [];}
    const reportDR = specimen.ReportDR || specimen.TodoReportDR || '';
    if (!reportDR) {return [];}

    /* 检查 LRU 缓存 */
    const ck = prCacheKey(specimen);
    const cached = prCacheGet(ck);
    if (cached) {
      return cached.filter(row => prResultPass(row, filters));
    }

    const rawCache = typeof _classifyRawCache !== 'undefined' ? _classifyRawCache[reportDR] : null;
    if (rawCache && rawCache.data) {
      const lab0 = prAsArray(rawCache.data.LabInfo)[0] || {};
      const vn = lab0.VisitNumberDR || specimen.VisitNumberDR || specimen.VisitNumber || '';
      let feeList = [];
      if (vn) {
        try {
          feeList = await prFetchTestSetFees(vn, signal);
        } catch (e) {
          if (e && e.name === 'AbortError') {throw e;}
        }
      }
      const rows = prRowsFromDetailData(specimen, rawCache.data, feeList);
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
      const itemInfo = prAsArray(data && data.ItemInfo);
      if (itemInfo.length === 0 && (specimen.Status || specimen.ReportStatus)) {
        p.set('P3', '');
        data = await fetchJRetry(CSP + '?' + p.toString(), 20000, signal, 2, 250);
      }
      // 医嘱组合费用：有 VisitNumberDR 时并行拉取（按 VN 缓存，多报告共享）
      const labInfo0 = prAsArray(data && data.LabInfo)[0] || {};
      const visitNumberDR = labInfo0.VisitNumberDR || specimen.VisitNumberDR || specimen.VisitNumber || '';
      let feeList = [];
      if (visitNumberDR) {
        try {
          feeList = await prFetchTestSetFees(visitNumberDR, signal);
        } catch (e) {
          if (e && e.name === 'AbortError') {throw e;}
          feeList = [];
        }
      }
      const rows = prRowsFromDetailData(specimen, data, feeList);
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
    if (!body) {return;}
    if (!rows.length) {
      body.innerHTML = '<div class="pr-empty">暂无结果。<br>请调整筛选条件后点击查询。</div>';
      return;
    }

    const totalRows = rows.length;
    const totalPages = Math.max(1, Math.ceil(totalRows / prPageSize));
    if (prPage > totalPages) {prPage = totalPages;}
    if (prPage < 1) {prPage = 1;}
    const startIdx = (prPage - 1) * prPageSize;
    const endIdx = Math.min(startIdx + prPageSize, totalRows);
    const pageRows = rows.slice(startIdx, endIdx);

    let h =
      '<table><thead><tr><th>姓名</th><th>性别</th><th>年龄</th><th>类型</th><th>科室</th><th>诊断</th><th>检验号</th><th>流水号</th><th>仪器</th><th>标本</th><th>组合</th><th>项目</th><th>结果</th><th>参考范围</th><th>报告费用</th><th>医嘱费用</th><th>状态</th><th>核收时间</th></tr></thead><tbody>';
    pageRows.forEach(r => {
      const cls =
        r.status === 'CRITICAL'
          ? 'pr-critical'
          : r.status === 'HIGH'
            ? 'pr-high'
            : r.status === 'LOW'
              ? 'pr-low'
              : r.status === 'ABNORMAL'
                ? 'pr-abn'
                : '';
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
                <td>${esc(r.reportPrice || '')}</td>
                <td title="${esc(r.feeDetail || '')}">${esc(r.testSetFee || r.feeDetail || '')}</td>
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
    if (prevBtn)
    {prevBtn.addEventListener('click', () => {
      prPage--;
      prRenderTable(prData);
    });}
    if (nextBtn)
    {nextBtn.addEventListener('click', () => {
      prPage++;
      prRenderTable(prData);
    });}
    if (jumpInput)
    {jumpInput.addEventListener('keydown', e => {
      if (e.key === 'Enter') {
        const v = parseInt(jumpInput.value, 10);
        if (!isNaN(v) && v >= 1 && v <= totalPages) {
          prPage = v;
          prRenderTable(prData);
        }
      }
    });}
  }

  function prCsvCell(value) {
    return '"' + String(value == null ? '' : value).replace(/"/g, '""') + '"';
  }

  function prExportCSV() {
    if (!prData.length) {
      showToast('没有可导出的结果', 'warning');
      return;
    }
    if (prLastDetailFailures > 0) {
      const ok = window.confirm(
        `本次查询有 ${prLastDetailFailures} 个标本明细读取失败，导出的结果可能不完整。仍然导出吗？`
      );
      if (!ok) {return;}
    }
    // 金额：报告费用=报告头总价（按标本去重汇总）；医嘱费用=组合价；项目费用=单项价（本院常为空）
    const headers = [
      '工作组',
      '仪器',
      '姓名',
      '病人类型',
      '性别',
      '年龄',
      '检验号',
      '流水号',
      '登记号',
      '病案号',
      '科室',
      '病区',
      '医生',
      '诊断',
      '标本',
      '组合',
      '核收时间',
      '报告状态',
      '项目',
      '结果',
      '单位',
      '参考范围',
      '异常标志',
      '判断',
      '报告费用',
      '医嘱费用',
      '项目费用',
      '医嘱费用明细'
    ];
    const rows = prData.map(r => [
      r.workGroup,
      r.machine,
      r.patient,
      r.patientType,
      r.sex,
      r.age,
      r.labno,
      r.episodeNo,
      r.regNo,
      r.recordNo,
      r.location,
      r.ward,
      r.doctor,
      r.diagnosis,
      r.specimen,
      r.testSet,
      r.acceptDT,
      r.reportStatus,
      r.itemName,
      r.result,
      r.unit,
      r.refRange,
      r.abFlag,
      classifyStatusText(r.status),
      r.reportPrice || '',
      r.testSetFee || '',
      r.itemPrice || '',
      r.feeDetail || ''
    ]);
    const csv =
      '\uFEFF' + headers.map(prCsvCell).join(',') + '\r\n' + rows.map(row => row.map(prCsvCell).join(',')).join('\r\n');
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
    showToast('病人结果已导出（含费用列；报告费用请按检验号去重汇总）', 'success');
  }

  function prClearFilters() {
    [
      'lis-pr-q',
      'lis-pr-patient-type',
      'lis-pr-dept',
      'lis-pr-ward',
      'lis-pr-doctor',
      'lis-pr-diagnosis',
      'lis-pr-age-min',
      'lis-pr-age-max',
      'lis-pr-specimen',
      'lis-pr-testset',
      'lis-pr-item',
      'lis-pr-result-text',
      'lis-pr-result-value',
      'lis-pr-result-min',
      'lis-pr-result-max'
    ].forEach(id => {
      const el = document.getElementById(id);
      if (el) {el.value = '';}
    });
    ['lis-pr-status-filter', 'lis-pr-sex', 'lis-pr-judge', 'lis-pr-result-op'].forEach(id => {
      const el = document.getElementById(id);
      if (el) {el.value = '';}
    });
    document.querySelectorAll('.lis-pr-wg-check,.lis-pr-machine-check').forEach(el => {
      el.checked = false;
    });
    const abnormal = document.getElementById('lis-pr-abnormal');
    if (abnormal) {abnormal.checked = false;}
    prSetStatus('筛选条件已清空。', 'info');
  }

  function prSetDateRange(kind) {
    const start = document.getElementById('lis-pr-start');
    const end = document.getElementById('lis-pr-end');
    if (!start || !end) {return;}
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
    if (!m) {return null;}
    const y = Number(m[1]);
    const mo = Number(m[2]);
    const d = Number(m[3]);
    const dt = new Date(y, mo - 1, d);
    if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) {return null;}
    return dt;
  }

  function prFormatDateObj(d) {
    return (
      d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    );
  }

  function prDaysInMonth(year, month) {
    return new Date(year, month, 0).getDate();
  }

  function prCloseDatePicker() {
    const old = document.getElementById('lis-pr-date-picker');
    if (old) {old.remove();}
    if (prDatePickerCleanup) {
      prDatePickerCleanup();
      prDatePickerCleanup = null;
    }
  }

  function prOpenDatePicker(input) {
    if (!input) {return;}
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
      for (let i = 0; i < firstDay; i += 1) {days.push('<button type="button" class="blank" tabindex="-1"></button>');}
      for (let d = 1; d <= count; d += 1) {
        const value = viewYear + '-' + String(viewMonth).padStart(2, '0') + '-' + String(d).padStart(2, '0');
        days.push(
          `<button type="button" data-date="${value}" class="${value === input.value ? 'on' : ''}">${d}</button>`
        );
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
      if (e.target === input || picker.contains(e.target)) {return;}
      prCloseDatePicker();
    };
    const closeOnEsc = e => {
      if (e.key === 'Escape') {prCloseDatePicker();}
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
    const isTextInput = el =>
      el && /^(INPUT|TEXTAREA)$/i.test(el.tagName) && el.type !== 'checkbox' && el.type !== 'radio';
    panel.addEventListener(
      'compositionstart',
      e => {
        if (isTextInput(e.target)) {prComposing = true;}
        e.stopPropagation();
      },
      true
    );
    panel.addEventListener(
      'compositionend',
      e => {
        if (isTextInput(e.target)) {
          setTimeout(() => {
            prComposing = false;
          }, 0);
        }
        e.stopPropagation();
      },
      true
    );
    panel.addEventListener(
      'beforeinput',
      e => {
        if (isTextInput(e.target)) {e.stopPropagation();}
      },
      true
    );
    panel.addEventListener(
      'input',
      e => {
        if (isTextInput(e.target)) {e.stopPropagation();}
      },
      true
    );
    panel.addEventListener(
      'keydown',
      e => {
        if (!isTextInput(e.target) && !(e.target && e.target.tagName === 'SELECT')) {return;}
        if (e.isComposing || prComposing || e.keyCode === 229) {
          e.stopPropagation();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Escape') {return;}
        e.stopPropagation();
      },
      true
    );
    panel.addEventListener(
      'keyup',
      e => {
        if (isTextInput(e.target)) {e.stopPropagation();}
      },
      true
    );
  }

  /* 修复：筛选滚动区可滚轮；查询按钮条固定在下方不跟着滚走 */
  function prBindWheelScroll(panel) {
    panel.addEventListener(
      'wheel',
      e => {
        const scroll = document.getElementById('lis-pr-tools-scroll');
        const tools = document.getElementById('lis-pr-tools');
        if (scroll && e.target && e.target.closest && e.target.closest('#lis-pr-tools-scroll')) {
          if (scroll.scrollHeight > scroll.clientHeight) {
            scroll.scrollTop += e.deltaY;
            e.preventDefault();
          }
          e.stopPropagation();
          return;
        }
        // 操作条区域不抢 body 滚动
        if (tools && e.target && e.target.closest && e.target.closest('#lis-pr-tools .pr-actions')) {
          e.stopPropagation();
        }
      },
      { passive: false, capture: true }
    );
  }

  /* 批次节流延迟（ms） */
  const PR_THROTTLE_MS = 50;

  /* 主查询函数（重构版：并行加载 + 取消 + 缓存 + 进度） */
  async function prQuery() {
    if (prBusy) {return;}
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
      if (signal.aborted || querySeq !== prQuerySeq) {return;}
      if (prLastWorkListHadFailures) {
        prSetStatus(
          `部分工作组/仪器查询失败，结果可能不完整（已查到 ${allRows.length} 条）。当前生效：${activeSummary}`,
          'error'
        );
        showToast('部分工作组查询失败，结果可能不全', 'warning');
      }
      const rows = prFilterRows(allRows, filters);
      if (!rows.length) {
        if (querySeq !== prQuerySeq) {return;}
        prSetStatus(
          `未找到符合条件的标本（共查询 ${allRows.length} 条记录）${prLastWorkListHadFailures ? '；且有查询失败' : ''}。当前生效：${activeSummary}`,
          prLastWorkListHadFailures ? 'error' : 'info'
        );
        return;
      }
      const mustReadDetail = prNeedsDetailEvenWithoutResult(filters);
      let detailRows = mustReadDetail ? rows : rows.filter(prMayHaveResult);
      // 兜底：若按标志位全部被跳过，仍尝试读明细（外送/标志滞后常见）
      if (!detailRows.length && rows.length) {
        dbg('病人结果：工作列表标志均为暂无结果，仍尝试读取明细', rows.length);
        detailRows = rows;
      }
      const skippedNoResult = rows.length - detailRows.length;
      if (!detailRows.length) {
        prSetStatus(`找到 ${rows.length} 个标本，但工作列表显示暂无结果。当前生效：${activeSummary}`, 'info');
        return;
      }
      /* 智能判断是否需要结果明细 */
      /* 阶段2：批次读取明细（带节流 + 进度 + 缓存复用） */
      prSetStatus(
        `找到 ${rows.length} 个标本，${skippedNoResult ? '跳过 ' + skippedNoResult + ' 个暂无结果标本，' : ''}正在读取结果明细...`,
        'info'
      );
      const resultRows = [];
      const batchSize = detailRows.length > 3000 ? 24 : detailRows.length > 800 ? 20 : 15;
      let lastRenderAt = 0;
      let detailFailures = 0;
      for (let i = 0; i < detailRows.length; i += batchSize) {
        if (signal.aborted || querySeq !== prQuerySeq) {return;}
        const batch = detailRows.slice(i, i + batchSize);
        const lists = await Promise.all(
          batch.map(r =>
            prFetchResultRows(r, filters, signal).catch(e => {
              if (e.name === 'AbortError') {return [];}
              dbg('病人结果明细失败:', r.Labno || r.ReportDR, e.message);
              detailFailures += 1;
              return [];
            })
          )
        );
        if (signal.aborted || querySeq !== prQuerySeq) {return;}
        lists.forEach(list => resultRows.push(...list));
        const done = Math.min(i + batch.length, detailRows.length);
        if (resultRows.length && (resultRows.length - lastRenderAt >= 500 || done === detailRows.length)) {
          prData = resultRows;
          prRenderTable(prData);
          lastRenderAt = resultRows.length;
        }
        prSetStatus(
          `正在读取结果明细 ${done} / ${detailRows.length}，已得到 ${resultRows.length} 条结果${detailFailures ? '，失败 ' + detailFailures + ' 个标本' : ''}${skippedNoResult ? '，已跳过 ' + skippedNoResult + ' 个暂无结果标本' : ''}...`,
          detailFailures ? 'error' : 'info'
        );

        /* 批次间节流（避免服务端限流） */
        if (i + batchSize < detailRows.length) {
          await new Promise(r => setTimeout(r, PR_THROTTLE_MS));
        }
      }

      if (signal.aborted || querySeq !== prQuerySeq) {return;}
      prData = resultRows;
      prLastDetailFailures = detailFailures;
      prPage = 1;
      prRenderTable(prData);
      const cacheHits = _prDetailCache.size;
      const zeroHint = prData.length ? '' : ` 当前生效：${activeSummary}`;
      const failHint = detailFailures ? `，${detailFailures} 个标本明细读取失败，请重查后再作为完整结果导出` : '';
      const wlFailHint = prLastWorkListHadFailures ? '；部分工作组列表查询曾失败' : '';
      prSetStatus(
        `完成：${rows.length} 个标本，${prData.length} 条结果${skippedNoResult ? '，跳过 ' + skippedNoResult + ' 个暂无结果标本' : ''}${failHint}${wlFailHint}。明细缓存 ${cacheHits} 个标本。${zeroHint}`,
        detailFailures || prLastWorkListHadFailures ? 'error' : prData.length ? 'ok' : 'info'
      );
      if (detailFailures || prLastWorkListHadFailures) {
        showToast(
          detailFailures ? `有 ${detailFailures} 个标本明细失败，导出可能不全` : '部分工作组列表查询失败',
          'warning'
        );
      }
    } catch (e) {
      if (querySeq !== prQuerySeq) {return;}
      if (e.name === 'AbortError') {
        prSetStatus('查询已取消。', 'info');
        return;
      }
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
    if (document.getElementById('lis-pr-fab')) {return;}
    const fab = document.createElement('button');
    fab.id = 'lis-pr-fab';
    fab.textContent = '结果';
    fab.title = '病人结果筛选导出';
    document.body.appendChild(fab);

    const panel = document.createElement('div');
    panel.id = 'lis-pr-panel';
    panel.innerHTML = `
            <div id="lis-pr-hd">
                <h3>病人结果筛选导出</h3>
                <span class="pr-spacer"></span>
                <button id="lis-pr-mini" title="隐藏">_</button>
                <button class="pr-close" id="lis-pr-close" title="关闭">×</button>
            </div>
            <div id="lis-pr-tools">
                <div id="lis-pr-tools-scroll">
                <div class="pr-section">标本范围</div>
                <label class="pr-date">开始日期<input type="text" id="lis-pr-start" readonly placeholder="选择日期"></label>
                <label class="pr-date">结束日期<input type="text" id="lis-pr-end" readonly placeholder="选择日期"></label>
                <div class="pr-date-shortcuts">
                    <button type="button" data-range="today">今天</button>
                    <button type="button" data-range="month">近一月</button>
                    <button type="button" data-range="year">近一年</button>
                </div>
                <label class="pr-mach-tree-wrap">工作组 / 仪器（不勾=全部；勾工作组=整组；展开后可只勾仪器）<div id="lis-pr-machine-tree"></div></label>
                <label class="pr-sm">状态<select id="lis-pr-status-filter">
                    <option value="">全部</option><option value="1">登记</option><option value="2">初审</option><option value="3">审核</option><option value="4">复审</option>
                </select></label>
                <label class="pr-xl">综合搜索<input type="text" id="lis-pr-q" placeholder="姓名 / 检验号 / 登记号 / 病案号"></label>
                <div class="pr-section">患者信息</div>
                <label class="pr-sm">病人类型<input type="text" id="lis-pr-patient-type" placeholder="体检 职工体检"></label>
                <label class="pr-md">科室<input type="text" id="lis-pr-dept" placeholder="科室"></label>
                <label class="pr-sm">病区<input type="text" id="lis-pr-ward" placeholder="病区"></label>
                <label class="pr-sm">医生<input type="text" id="lis-pr-doctor" placeholder="医生"></label>
                <label class="pr-wide">诊断<input type="text" id="lis-pr-diagnosis" placeholder="诊断关键字"></label>
                <label class="pr-xs">性别<select id="lis-pr-sex"><option value="">全部</option><option value="男">男</option><option value="女">女</option></select></label>
                <label class="pr-xs">年龄≥<input type="number" id="lis-pr-age-min" placeholder="岁"></label>
                <label class="pr-xs">年龄≤<input type="number" id="lis-pr-age-max" placeholder="岁"></label>
                <label class="pr-sm">标本<input type="text" id="lis-pr-specimen" placeholder="血清"></label>
                <div class="pr-section">项目结果</div>
                <label class="pr-md">医嘱组合<input type="text" id="lis-pr-testset" placeholder="如 传染病八项"></label>
                <label class="pr-lg">项目名称<input type="text" id="lis-pr-item" placeholder="如 梅毒（仅单项名）"></label>
                <label class="pr-md">判断<select id="lis-pr-judge">
                    <option value="">全部</option><option value="NORMAL">正常</option><option value="HIGH">偏高</option><option value="LOW">偏低</option><option value="ABNORMAL">异常</option><option value="CRITICAL">危急</option><option value="UNCERTAIN">待定</option>
                </select></label>
                <label class="pr-md">结果文本<input type="text" id="lis-pr-result-text" placeholder="含 阳性 / +"></label>
                <label class="pr-xs">关系<select id="lis-pr-result-op">
                    <option value="">不筛</option><option value="gt">&gt;</option><option value="gte">&gt;=</option><option value="lt">&lt;</option><option value="lte">&lt;=</option><option value="eq">=</option>
                </select></label>
                <label class="pr-xs">比较值<input type="number" step="any" id="lis-pr-result-value" placeholder="值"></label>
                <label class="pr-xs">数值≥<input type="number" step="any" id="lis-pr-result-min"></label>
                <label class="pr-xs">数值≤<input type="number" step="any" id="lis-pr-result-max"></label>
                <label class="pr-toggle"><input type="checkbox" id="lis-pr-abnormal"><span>仅异常结果</span></label>
                </div>
                <div class="pr-actions">
                    <button id="lis-pr-query">查询</button>
                    <button id="lis-pr-cancel" style="display:none;background:#fff3e0;color:#e65100;border-color:#ff9800">停止</button>
                    <button id="lis-pr-clear">清空条件</button>
                    <button id="lis-pr-export">导出CSV</button>
                </div>
            </div>
            <div id="lis-pr-status">请选择条件后查询。数据仅在本机浏览器内处理。</div>
            <div id="lis-pr-body"><div class="pr-empty">点击"查询"后显示病人结果明细。<br>含临检/生化/免疫/外送；导出附带报告费用与医嘱费用（对账用）。<br>这里导出的是结果数据，不是正式报告单。</div></div>`;
    document.body.appendChild(panel);

    const start = document.getElementById('lis-pr-start');
    const end = document.getElementById('lis-pr-end');
    if (start) {start.value = today();}
    if (end) {end.value = today();}
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
      if (!el) {return;}
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
    } catch (e) {}
    // 拖动 + 点击
    let fabDx = 0,
      fabDy = 0,
      fabDownX = 0,
      fabDownY = 0;
    fab.addEventListener('mousedown', e => {
      fabDx = e.clientX - fab.offsetLeft;
      fabDy = e.clientY - fab.offsetTop;
      fabDownX = e.clientX;
      fabDownY = e.clientY;
      const onMove = ev => {
        fab.style.left = ev.clientX - fabDx + 'px';
        fab.style.top = ev.clientY - fabDy + 'px';
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
          try {
            localStorage.setItem(FAB_POS_KEY, JSON.stringify({ l: fab.offsetLeft, t: fab.offsetTop }));
          } catch (e) {}
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
    prProtectChineseInput(panel);
    prBindWheelScroll(panel);
    panel.addEventListener('keydown', e => {
      if (e.isComposing || prComposing || e.keyCode === 229) {return;}
      if (e.key === 'Enter' && !e.shiftKey && e.target && /INPUT|SELECT/.test(e.target.tagName)) {
        e.preventDefault();
        prQuery();
      }
      if (e.key === 'Escape') {panel.classList.remove('show');}
    });
  }
  // ============================================================
  //  模块 QE：质控数据导出
  // ============================================================
  let qeInited = false;
  let qeExporting = false;
  let qeAbortFlag = false;
  // 最近一次导出成功的文件列表：[{ name, blob, rows }]，供 ZIP 一键打包
  let qeLastExportFiles = [];

  // --- 9 组项目配置 ---
  const QE_GROUPS = [
    {
      id: 'blood',
      name: '血常规',
      file: '血常规转换_直接上传.xlsx',
      machineMatch: /血细胞|血球|血常规|bc-|xn|sysmex|mindray|迈瑞/i,
      concentrations: 2,
      lotMode: 'suffix',
      baseLot: 'E5245',
      defaultOperator: '',
      projects: [
        { code: '1001', name: 'WBC' },
        { code: '1002', name: 'RBC' },
        { code: '1004', name: 'Hct' },
        { code: '1006', name: 'MCV' },
        { code: '1007', name: 'MCH' },
        { code: '1008', name: 'MCHC' },
        { code: '1003', name: 'Hgb' },
        { code: '1005', name: 'Plt' }
      ]
    },
    {
      id: 'biochem',
      name: '生化',
      file: '生化转换_直接上传.xlsx',
      machineMatch: /生化/i,
      concentrations: 2,
      lotMode: 'dual',
      defaultLots: ['45981', '46022'],
      defaultOperator: '',
      projects: [
        { code: 'P', name: '丙氨酸氨基转移酶' },
        { code: 'Q', name: '天门冬氨酸氨基转移酶' },
        { code: 'AD', name: 'γ-谷氨酰基转移酶' },
        { code: 'R', name: '碱性磷酸酶' },
        { code: 'U', name: '乳酸脱氢酶' },
        { code: 'T', name: '肌酸激酶' },
        { code: 'F', name: '葡萄糖' },
        { code: 'E', name: '磷' },
        { code: 'M', name: '甘油三酯' },
        { code: 'G', name: '尿素' },
        { code: 'I', name: '肌酐' },
        { code: 'A', name: '钾' },
        { code: 'B', name: '钠' },
        { code: 'C', name: '氯' },
        { code: 'D', name: '钙' },
        { code: 'J', name: '总蛋白' },
        { code: 'K', name: '白蛋白' },
        { code: 'O', name: '总胆红素' },
        { code: 'V', name: '直接胆红素' },
        { code: 'L', name: '总胆固醇' },
        { code: 'H', name: '尿酸' },
        { code: 'S', name: 'α-淀粉酶' },
        { code: 'N', name: '高密度脂蛋白胆固醇' }
      ]
    },
    {
      id: 'coag',
      name: '凝血',
      file: '凝血转换_直接上传.xlsx',
      machineMatch: /CS.?5100|凝血|血凝|coag|stago/i,
      concentrations: 1,
      lotMode: 'coag',
      defaultLot: '84772',
      dDimLot: '74442',
      defaultOperator: '',
      projects: [
        { code: '1102', name: 'INR' },
        { code: '1103', name: 'APTT' },
        { code: '1101', name: 'PT' },
        { code: '1104', name: 'FIB' },
        { code: '1107', name: 'D-二聚体（FEU)', isDDimer: true }
      ]
    },
    {
      id: 'lipid',
      name: '血脂',
      file: '血脂转换_直接上传.xlsx',
      machineMatch: /生化|脂类/i,
      concentrations: 1,
      lotMode: 'single',
      defaultLot: '57651',
      defaultOperator: '',
      projects: [
        { code: '2404', name: '低密度脂蛋白胆固醇' },
        { code: '2406', name: '载脂蛋白A1' },
        { code: '2407', name: '载脂蛋白B' },
        { code: '2408', name: '脂蛋白a' }
      ]
    },
    {
      id: 'urine',
      name: '尿常规',
      file: '尿常规转换_直接上传.xlsx',
      machineMatch: /尿液|尿常规|尿沉渣|uf-|uc-|urisys/i,
      concentrations: 1,
      lotMode: 'single',
      defaultLot: '26030302',
      defaultOperator: '',
      projects: [
        { code: '1210', name: '白细胞酯酶' },
        { code: '1200', name: '比重' },
        { code: '1205', name: '胆红素' },
        { code: '1203', name: '蛋白' },
        { code: '1209', name: '尿胆原' },
        { code: '1204', name: '葡萄糖' },
        { code: '1202', name: 'PH' },
        { code: '1206', name: '酮体' },
        { code: '1208', name: '亚硝酸盐' },
        { code: '1207', name: '隐血' }
      ]
    },
    {
      id: 'endocrine',
      name: '内分泌',
      file: '内分泌转换_直接上传.xlsx',
      machineMatch: /化学发光|DXi|DXI|发光仪|dxi\s*800/i,
      materialHint: /内分泌/i,
      concentrations: 1,
      lotMode: 'single',
      defaultLot: '40472',
      defaultOperator: '',
      projects: [
        { code: '0402', name: 'TT3' },
        { code: '0404', name: 'TT4' },
        { code: '0401', name: 'FT3' },
        { code: '0403', name: 'FT4' },
        { code: '0405', name: 'TSH' },
        { code: '0408', name: 'FSH' },
        { code: '0409', name: 'LH' },
        { code: '0411', name: 'PRL泌乳素' },
        { code: '0418', name: 'E2' },
        { code: '0410', name: 'P孕酮' },
        { code: '0412', name: 'T睾酮' }
      ]
    },
    {
      id: 'tumor',
      name: '肿瘤标志物',
      file: '肿瘤标志物转换_直接上传.xlsx',
      machineMatch: /化学发光|DXi|DXI|发光仪|dxi\s*800/i,
      materialHint: /肿瘤/i,
      concentrations: 1,
      lotMode: 'single',
      defaultLot: '74662',
      defaultOperator: '',
      projects: [
        { code: '0501', name: 'AFP' },
        { code: '0502', name: 'CEA' },
        { code: '0504', name: '总PSA' },
        { code: '0505', name: 'CA125' },
        { code: '0506', name: 'CA153' },
        { code: '0507', name: 'CA199' },
        { code: '0513', name: 'F-PSA' },
        { code: '0511', name: '铁蛋白' }
      ]
    },
    {
      id: 'cardiac',
      name: '心肌标志物',
      file: '心肌损伤标志物转换_直接上传.xlsx',
      machineMatch: /化学发光|DXi|DXI|发光仪|dxi\s*800/i,
      materialHint: /心肌/i,
      concentrations: 1,
      lotMode: 'single',
      defaultLot: '1003112',
      defaultOperator: '',
      projects: [
        { code: '2501', name: 'CK-MB' },
        { code: '2502', name: 'MYO' },
        { code: '2503', name: '肌钙蛋白' }
      ]
    },
    {
      id: 'infection',
      name: '传染病',
      file: '传染病转换_直接上传.xlsx',
      machineMatch: /maglumi|x\s*-?\s*8\b/i,
      concentrations: 1,
      lotMode: 'immune',
      defaultOperator: '',
      projects: [
        { code: '21011', name: 'HbsAg', lisName: '乙型肝炎病毒表面抗原测定', defaultLot: '202509002HBsAg' },
        { code: '21021', name: 'HbsAb', lisName: '乙型肝炎病毒表面抗体测定', defaultLot: '202410006HBsAb' },
        { code: '21031', name: 'HbeAg', lisName: '乙型肝炎病毒e抗原测定', defaultLot: '202404002' },
        { code: '21041', name: 'HbeAb', lisName: '乙型肝炎病毒e抗体测定', defaultLot: '202405001eAb' },
        { code: '21131', name: 'HbcAb', lisName: '乙型肝炎病毒核心抗体测定', defaultLot: '202412005HBCAB' },
        { code: '21071', name: '抗-HCV', lisName: '丙型肝炎病毒抗体测定', defaultLot: '202407002HCV' },
        { code: '21101', name: 'TP', lisName: '梅毒螺旋体抗体测定', defaultLot: '202403004' },
        { code: '21121', name: 'HIV', lisName: '人类免疫缺陷病毒抗体测定', defaultLot: '202409002HIV' }
      ]
    }
  ];

  // --- 持久化配置 ---
  const QE_CONFIG_KEY = 'lis-qe-config';
  function qeLoadConfig() {
    try {
      return JSON.parse(localStorage.getItem(QE_CONFIG_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }
  function qeSaveConfig(cfg) {
    try {
      localStorage.setItem(QE_CONFIG_KEY, JSON.stringify(cfg));
    } catch (e) {}
  }

  // 获取某个组的批号配置
  function qeGetLot(cfg, group) {
    const gc = cfg.lots && cfg.lots[group.id];
    if (group.lotMode === 'suffix') {return (gc && gc.baseLot) || group.baseLot;}
    if (group.lotMode === 'dual') {return (gc && gc.lots) || group.defaultLots || ['', ''];}
    if (group.lotMode === 'single') {return (gc && gc.lot) || group.defaultLot || '';}
    if (group.lotMode === 'perProject') {
      const result = {};
      group.projects.forEach(p => {
        result[p.code] = (gc && gc[p.code]) || p.defaultLot || '';
      });
      return result;
    }
    if (group.lotMode === 'coag') {
      // 凝血模式: 主项目共用一个批号，D-二聚体单独一个
      return {
        _main: (gc && gc._main) || group.defaultLot || '',
        _dimer: (gc && gc._dimer) || group.dDimLot || ''
      };
    }
    if (group.lotMode === 'immune') {
      const result = {};
      group.projects.forEach(p => {
        result[p.code] = (gc && gc[p.code]) || p.defaultLot || group.defaultLot || '';
      });
      return result;
    }
    return '';
  }
  function qeGetOperator(cfg, group) {
    return (cfg.operators && cfg.operators[group.id]) || group.defaultOperator || '';
  }

  // LIS 缩写(Code) → 模板项目编码（按组，来自质控录入页实测）
  const QE_LIS_ABBR = {
    blood: {
      WBC: '1001',
      RBC: '1002',
      HGB: '1003',
      Hgb: '1003',
      HCT: '1004',
      Hct: '1004',
      PLT: '1005',
      Plt: '1005',
      MCV: '1006',
      MCH: '1007',
      MCHC: '1008'
    },
    biochem: {
      ALT: 'P',
      AST: 'Q',
      GGT: 'AD',
      ALP: 'R',
      LDH: 'U',
      CK: 'T',
      GLU: 'F',
      BUN: 'G',
      CREA: 'I',
      UA: 'H',
      TG: 'M',
      CHO: 'L',
      HDL: 'N',
      TBIL: 'O',
      DBIL: 'V',
      K: 'A',
      Na: 'B',
      Cl: 'C',
      Ca: 'D',
      PHOS: 'E',
      AMY: 'S',
      TP: 'J',
      ALB: 'K'
    },
    urine: {
      SG: '1200',
      PH: '1202',
      PRO: '1203',
      GLU: '1204',
      LEU: '1210',
      KET: '1206',
      BIL: '1205',
      URO: '1209',
      BLD: '1207',
      NIT: '1208'
    },
    lipid: { LDL: '2404', APOA1: '2406', APOB: '2407', LPa: '2408' },
    coag: { INR: '1102', APTT: '1103', PT: '1101', FIB: '1104', DD: '1107' },
    endocrine: {
      TT3: '0402',
      TT4: '0404',
      FT3: '0401',
      FT4: '0403',
      TSH: '0405',
      FSH: '0408',
      hFSH: '0408',
      LH: '0409',
      PRL: '0411',
      E2: '0418',
      PROG: '0410',
      TESTO: '0412'
    },
    tumor: {
      AFP: '0501',
      CEA: '0502',
      FER: '0511',
      PSA: '0504',
      FPSA: '0513',
      CA199: '0507',
      CA125: '0505',
      CA153: '0506'
    },
    cardiac: { 'CK-MB': '2501', MYO: '2502', cTnI: '2503', cTnl: '2503' }
  };

  function qeMachineMatchesGroup(group, machineName) {
    if (!group.machineMatch) {return true;}
    return group.machineMatch.test(String(machineName || ''));
  }

  function qeNormName(s) {
    return String(s || '')
      .replace(/\*+$/, '')
      .trim();
  }

  // LIS 常返回 Code=AA001、Synonym=WBC，需同时检查
  function qeTcKeys(tc) {
    return [tc.Code, tc.Synonym, tc.LName].map(qeNormName).filter(Boolean);
  }

  function qeAbbrHit(group, proj, tc) {
    const groupAbbr = QE_LIS_ABBR[group.id] || {};
    return qeTcKeys(tc).some(k => groupAbbr[k] === proj.code);
  }

  // 质控物名称关键词 → 限制匹配范围（仪器+缩写命中时可跳过）
  function qeMaterialMatchesGroup(group, tc, proj, machineName) {
    const mat = String(tc.MaterialName || tc.MatName || '');
    const cname = qeNormName(tc.CName);
    const text = mat + ' ' + cname;
    const machineOk = qeMachineMatchesGroup(group, machineName);

    if (machineOk && qeAbbrHit(group, proj, tc)) {return true;}
    if (group.materialHint && machineOk && !group.materialHint.test(text)) {return false;}

    if (group.id === 'coag') {
      if (proj && proj.isDDimer) {
        // 与别名表一致：D-二聚体 / D二聚体 / D-Dimer / DD 均算命中（大小写不敏感），
        // 旧逻辑只认连字符写法，D二聚体 / D-Dimer 会静默匹配失败
        return qeTcKeys(tc).some(k => k === 'DD') || /D\s*[-－]?\s*(?:二聚体|Dimer)/i.test(text);
      }
      if (machineOk && qeAbbrHit(group, proj, tc)) {return true;}
      return /凝血/i.test(text) && !/D\s*[-－]?\s*(?:二聚体|Dimer)/i.test(text);
    }
    if (group.id === 'infection' && proj && proj.lisName) {
      return cname === proj.lisName || cname.includes(proj.lisName) || proj.lisName.includes(cname);
    }
    const hints = {
      blood: /血常|血球|血细胞|白细胞|红细胞|血红蛋白|血小板|HCT|MCV|MCH/i,
      endocrine: /内分泌|激素|甲状腺|性激素/i,
      tumor: /肿瘤|标志物|甲胎|癌胚|抗原/i,
      cardiac: /心肌/i,
      infection: /传染|乙肝|乙型肝炎|丙型肝炎|艾滋|免疫缺陷|梅毒|丙肝|HIV/i,
      urine: /尿液|尿标|尿质/i,
      biochem: /生化/i,
      lipid: /脂类|血脂/i
    };
    const re = group.materialHint || hints[group.id];
    return !re || re.test(text);
  }

  // 子串匹配辅助：要求短串长度 >= 长串的 60%，防止"白细胞"匹配到"白细胞酯酶"
  function qeLooseMatch(a, b) {
    if (!a || !b) {return false;}
    if (a === b) {return true;}
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    if (short.length < long.length * 0.6) {return false;}
    return long.includes(short);
  }

  function qeMatchProject(group, proj, tc, machineName) {
    return qeMatchScore(group, proj, tc, machineName) >= 0;
  }

  // 匹配评分：返回 -1（不匹配）或 ≥0 的分数（越大越优先）。
  // 关键设计：精确匹配（相等）远优先于子串模糊匹配；模糊匹配时按匹配串长度
  // 细分——越长（越具体）分越高。这样"游离三碘甲状原氨酸"(FT3,精确别名) 会赢过
  // "三碘甲状原氨酸"(TT3别名,子串命中)，修复 FT3/TT3、FT4/TT4、F-PSA/PSA 成对项目
  // 被同一数据抢占导致导出结果相同的问题。
  function qeMatchScore(group, proj, tc, machineName) {
    if (!qeMachineMatchesGroup(group, machineName)) {return -1;}
    const code = qeNormName(tc.Code);
    const synonym = qeNormName(tc.Synonym);
    const cname = qeNormName(tc.CName);
    if (proj.lisName) {
      if (cname === proj.lisName) {return 1000;}
      if (qeLooseMatch(cname, proj.lisName)) {return 100 + Math.max(cname.length, proj.lisName.length);}
      return -1;
    }
    if (!qeMaterialMatchesGroup(group, tc, proj, machineName)) {return -1;}
    const matName = qeNormName(tc.MaterialName);
    const cnL = cname.toLowerCase();
    const mnL = matName.toLowerCase();
    const cdL = code.toLowerCase();
    const syL = synonym.toLowerCase();
    const pnL = proj.name ? proj.name.toLowerCase() : '';
    // 精确类（高分，远优先于模糊）
    if (qeAbbrHit(group, proj, tc)) {return 900;}
    if (code && proj.name && cdL === pnL) {return 890;}
    if (synonym && proj.name && syL === pnL) {return 880;}
    if (code === proj.code) {return 870;}
    if (cname === proj.name) {return 860;}
    if (matName === proj.name) {return 850;}
    const aliases = QE_ALIASES[proj.name] || [];
    let bestAliasExact = 0;
    for (const alias of aliases) {
      const aL = alias.toLowerCase();
      if (cnL === aL || mnL === aL || cdL === aL || syL === aL) {
        if (alias.length > bestAliasExact) {bestAliasExact = alias.length;}
      }
    }
    if (bestAliasExact) {return 800 + bestAliasExact;}
    // 模糊类（低分）：按匹配串长度细分，越长（越具体）分越高
    let bestLoose = 0;
    if (proj.name && qeLooseMatch(cnL, pnL) && proj.name.length > bestLoose) {bestLoose = proj.name.length;}
    if (proj.name && qeLooseMatch(mnL, pnL) && proj.name.length > bestLoose) {bestLoose = proj.name.length;}
    for (const alias of aliases) {
      const aL = alias.toLowerCase();
      if (qeLooseMatch(cnL, aL) && alias.length > bestLoose) {bestLoose = alias.length;}
      if (qeLooseMatch(mnL, aL) && alias.length > bestLoose) {bestLoose = alias.length;}
    }
    if (bestLoose) {return 100 + bestLoose;}
    // abbrMatch 兜底（大小写不敏感精确，理论上已被上面精确类覆盖，保留以防遗漏）
    const abbrMatch =
      (matName && proj.name && mnL === pnL) ||
      (cname && proj.name && cnL === pnL) ||
      (synonym && proj.name && syL === pnL);
    if (abbrMatch) {return 840;}
    return -1;
  }

  // 项目名称别名映射（模板名 → LIS CName）
  const QE_ALIASES = {
    // 血常规
    WBC: ['白细胞计数', '白细胞', 'WBC'],
    RBC: ['红细胞计数', '红细胞', 'RBC'],
    Hgb: ['血红蛋白', '血红蛋白浓度', 'Hgb', 'HGB'],
    Plt: ['血小板计数', '血小板', 'PLT', 'Plt'],
    Hct: ['红细胞压积', '红细胞比容', 'HCT', 'Hct'],
    MCV: ['平均红细胞体积', 'MCV'],
    MCH: ['平均红细胞血红蛋白含量', 'MCH', '平均血红蛋白含量'],
    MCHC: ['平均红细胞血红蛋白浓度', 'MCHC'],
    // 凝血
    INR: ['国际标准化比值', 'INR'],
    APTT: ['活化部分凝血活酶时间', 'APTT', '活化部份凝血活酶时间'],
    PT: ['凝血酶原时间', 'PT'],
    FIB: ['纤维蛋白原', 'FIB', '纤维蛋白原定量'],
    'D-二聚体（FEU)': ['D-二聚体', 'D-二聚体测定', 'D-Dimer', 'D二聚体', 'DD'],
    // 尿常规
    比重: ['比重', 'SG'],
    蛋白: ['蛋白', '蛋白质', 'PRO'],
    葡萄糖: ['葡萄糖', 'GLU'],
    白细胞酯酶: ['白细胞酯酶', '白细胞脂酶', 'LEU'],
    酮体: ['酮体', 'KET'],
    胆红素: ['胆红素', 'BIL'],
    尿胆原: ['尿胆原', 'URO'],
    隐血: ['隐血', 'BLD'],
    亚硝酸盐: ['亚硝酸盐', 'NIT'],
    PH: ['酸碱度', 'PH', 'pH'],
    // 内分泌
    TT3: ['三碘甲状原氨酸', '总T3', 'TT3'],
    TT4: ['甲状腺素', '总T4', 'TT4'],
    FT3: ['游离三碘甲状原氨酸', '游离T3', 'FT3'],
    FT4: ['游离甲状腺素', '游离T4', 'FT4'],
    TSH: ['促甲状腺激素', 'TSH', '促甲状腺素'],
    FSH: ['卵泡刺激素', '促卵泡激素', 'FSH', '卵泡刺激素(FSH)', '促卵泡生成素', '卵泡生成素', 'hFSH'],
    LH: ['黄体生成素', '促黄体生成素', 'LH'],
    PRL泌乳素: ['泌乳素', '催乳素', 'PRL'],
    E2: ['雌二醇', 'E2'],
    P孕酮: ['孕酮', '孕激素', 'PROG'],
    T睾酮: ['睾酮', 'TESTO'],
    // 肿瘤
    AFP: ['甲胎蛋白', 'AFP'],
    CEA: ['癌胚抗原', 'CEA'],
    总PSA: ['前列腺特异性抗原', '总前列腺特异性抗原', 'PSA', 'T-PSA'],
    铁蛋白: ['铁蛋白', 'FER', 'Ferritin'],
    CA125: ['糖类抗原125', 'CA125'],
    CA153: ['糖类抗原153', 'CA153'],
    CA199: ['糖类抗原199', 'CA199'],
    'F-PSA': ['游离前列腺特异性抗原', '游离PSA', 'F-PSA', 'FPSA'],
    // 心肌
    'CK-MB': ['肌酸激酶同工酶', 'CK-MB', 'CKMB'],
    MYO: ['肌红蛋白', 'MYO', 'Mb', '肌红蛋'],
    肌钙蛋白: ['肌钙蛋白', '肌钙蛋白I', '肌钙蛋白T', 'cTnI', 'cTnl', 'cTnT', 'TnI', '肌钙蛋白I测定'],
    // 生化（LIS 缩写补充）
    丙氨酸氨基转移酶: ['ALT'],
    天门冬氨酸氨基转移酶: ['AST'],
    'γ-谷氨酰基转移酶': ['GGT'],
    碱性磷酸酶: ['ALP'],
    乳酸脱氢酶: ['LDH'],
    肌酸激酶: ['CK'],
    尿素: ['BUN'],
    肌酐: ['CREA'],
    尿酸: ['UA'],
    甘油三酯: ['TG'],
    总胆固醇: ['CHO'],
    高密度脂蛋白胆固醇: ['HDL'],
    总胆红素: ['TBIL'],
    直接胆红素: ['DBIL'],
    钾: ['K'],
    钠: ['Na'],
    氯: ['Cl', 'CL'],
    钙: ['Ca', 'CA'],
    磷: ['PHOS'],
    'α-淀粉酶': ['AMY'],
    总蛋白: ['TP'],
    白蛋白: ['ALB'],
    // 血脂
    低密度脂蛋白胆固醇: ['LDL'],
    载脂蛋白A1: ['APOA1'],
    载脂蛋白B: ['APOB'],
    脂蛋白a: ['LPa', 'LP(a)'],
    // 传染病（X8：LIS 仅中文名）
    HbsAg: ['乙型肝炎病毒表面抗原测定', '乙肝表面抗原', 'HBsAg', 'HbsAg'],
    HbsAb: ['乙型肝炎病毒表面抗体测定', '乙肝表面抗体', 'HBsAb', 'HbsAb', '抗-HBs'],
    HbeAg: ['乙型肝炎病毒e抗原测定', '乙肝e抗原', 'HBeAg', 'HbeAg'],
    HbeAb: ['乙型肝炎病毒e抗体测定', '乙肝e抗体', 'HBeAb', 'HbeAb', '抗-HBe'],
    HbcAb: ['乙型肝炎病毒核心抗体测定', '乙肝核心抗体', 'HBcAb', 'HbcAb', '抗-HBc'],
    '抗-HCV': ['丙型肝炎病毒抗体测定', '丙肝抗体', '抗-HCV', 'HCV'],
    TP: ['梅毒螺旋体抗体测定', '梅毒抗体', 'TP', '梅毒'],
    HIV: ['人类免疫缺陷病毒抗体测定', '人免疫缺陷病毒抗体测定', 'HIV抗体', 'HIV', '艾滋']
  };

  // --- 从质控页面读取数据 ---
  function qeGetJQ() {
    const ctx = qcGetCtx();
    return ctx.win.jQuery || ctx.win.$ || g('jQuery') || g('$') || window.jQuery || window.$;
  }

  function qeIsQCPage() {
    return isQCDataInputPage();
  }

  // 质控 API：仪器/项目列表用 DataView，结果数据用 DataInputNew（与录入页一致）
  function qeQCApiUrl() {
    return BASE + '/qc/ashx/ashQCDataView.ashx';
  }
  function qeQCDataApiUrl() {
    return BASE + '/qc/ashx/ashQCDataInputNew.ashx';
  }

  function qeMonthEndDate(year, month) {
    const last = new Date(year, month, 0).getDate();
    return year + '-' + String(month).padStart(2, '0') + '-' + String(last).padStart(2, '0');
  }

  // 通过 API 查询某台仪器的测试项目列表（与录入页一致用 DataInputNew）
  async function qeApiTestCodes(machineDR, startDate, endDate, matDR) {
    const api = qeQCDataApiUrl();
    const sd = startDate || '2024-01-01';
    const ed = endDate || today();
    const url =
      api +
      '?Method=QryMachineTestCode&MachineParameterDR=' +
      encodeURIComponent(machineDR) +
      '&MatDR=' +
      encodeURIComponent(matDR || '') +
      '&MatLotDR=&StartDate=' +
      encodeURIComponent(sd) +
      '&EndDate=' +
      encodeURIComponent(ed);
    try {
      const data = await fetchJ(url, 15000);
      return data && data.rows ? data.rows : Array.isArray(data) ? data : [];
    } catch (e) {
      dbg('[LIS-QE] qeApiTestCodes error:', e);
      return [];
    }
  }

  // 通过 API 查询某项目各浓度的质控结果（对齐 DataInputNew.QueryData）
  async function qeApiQCData(machineDR, testCodeDR, matDR, startDate, endDate) {
    const api = qeQCDataApiUrl();
    const levels = [];
    try {
      const leaveUrl =
        api +
        '?Method=QueryQCLeaveData&MachineParameterDR=' +
        encodeURIComponent(machineDR) +
        '&TestCodeDR=' +
        encodeURIComponent(testCodeDR) +
        '&StartDate=' +
        encodeURIComponent(startDate) +
        '&EndDate=' +
        encodeURIComponent(endDate) +
        '&MaterialCode=' +
        encodeURIComponent(matDR || '') +
        '&BatchCode=';
      const leaveData = await fetchJ(leaveUrl, 15000);
      const leaveRows = Array.isArray(leaveData) ? leaveData : (leaveData && leaveData.rows) || [];
      leaveRows.forEach(r => {
        if (r.LevelNo != null && r.LevelNo !== '') {
          levels.push({ levelNo: String(r.LevelNo), matLotDR: r.MatLotDR || '' });
        }
      });
    } catch (e) {
      dbg('[LIS-QE] QueryQCLeaveData failed:', e.message);
    }
    if (!levels.length) {levels.push({ levelNo: '1', matLotDR: '' }, { levelNo: '2', matLotDR: '' });}

    const allRows = [];
    const seen = new Set();
    for (const lv of levels) {
      try {
        const url =
          api +
          '?Method=QueryTestResultData&StartDate=' +
          encodeURIComponent(startDate) +
          '&EndDate=' +
          encodeURIComponent(endDate) +
          '&InstrumentCode=' +
          encodeURIComponent(machineDR) +
          '&Leavel=' +
          encodeURIComponent(lv.levelNo) +
          '&TCCode=' +
          encodeURIComponent(testCodeDR) +
          '&QcRule=&MatDR=' +
          encodeURIComponent(matDR || '') +
          '&BatchCode=';
        const data = await fetchJ(url, 25000);
        const rows = Array.isArray(data) ? data : (data && data.rows) || [];
        rows.forEach(r => {
          const levelNo = r.LevelNo || lv.levelNo;
          const date = r.TestDate || r.AddDate || r.QCDate || '';
          // 去重 key 包含运行序号/时间戳，避免同日多次检测结果被丢弃
          const seq = r.SeqNo || r.RunSeq || r.AddTime || '';
          const key = date + '|' + levelNo + '|' + (r.TestCodeDR || testCodeDR) + '|' + seq;
          if (seen.has(key)) {return;}
          seen.add(key);
          // 不修改原 API 响应对象，避免副作用；LevelNo 无条件补全：
          // 若 API 行带 SeqNo 但缺 LevelNo，旧逻辑不补全，下游会把所有水平归到 Level 1
          const row = r.LevelNo != null ? r : { ...r, LevelNo: levelNo };
          if (date || row.Result1 != null || row.DayAve != null || row.Result != null) {allRows.push(row);}
        });
      } catch (e) {
        dbg('[LIS-QE] QueryTestResultData L' + lv.levelNo + ' failed:', e.message);
      }
    }
    return allRows;
  }

  // 获取所有可用仪器列表
  function qeGetMachines() {
    const jq = qeGetJQ();
    if (!jq || !jq('#cmbMach').combobox) {return [];}
    try {
      const data = jq('#cmbMach').combobox('getData') || [];
      return data.map(d => ({
        id: String(d.RowID || d.value || d.id || d.MachineDR || ''),
        text: String(d.CName || d.text || d.Name || d.LName || ''),
        raw: d
      }));
    } catch (e) {
      dbg('[LIS-QE] qeGetMachines error:', e);
      return [];
    }
  }

  // 通过 QC API 查询工作组的仪器参数列表
  async function qeApiMachineParameters(wgDR) {
    const url = qeQCApiUrl() + '?Method=QryMachineParameter&WorkGroupDR=' + wgDR;
    try {
      const data = await fetchJ(url, 15000);
      return data && data.rows ? data.rows : Array.isArray(data) ? data : [];
    } catch (e) {
      dbg('[LIS-QE] qeApiMachineParameters error:', e);
      return [];
    }
  }

  // 遍历所有工作组获取全部仪器（使用 QC API 查询 MachineParameter）
  async function qeGetAllMachines() {
    const allMachines = [];
    const wgs = [
      { dr: '1', name: '临检' },
      { dr: '3', name: '生化' },
      { dr: '4', name: '免疫' }
    ];
    for (const w of wgs) {
      try {
        const rows = await qeApiMachineParameters(w.dr);
        dbg(`[LIS-QE] 工作组 ${w.name}(${w.dr}): ${rows.length} 台仪器`);
        rows.forEach(m => {
          allMachines.push({
            id: String(m.RowID || ''),
            text: String(m.CName || m.Name || m.RowID || ''),
            wgDR: w.dr,
            wgName: w.name,
            raw: m
          });
        });
      } catch (e) {
        dbg(`[LIS-QE] 加载工作组 ${w.name} 失败:`, e);
      }
    }
    dbg(`[LIS-QE] 共找到 ${allMachines.length} 台仪器`);
    return allMachines;
  }

  // 设置仪器选择（通过 loadData 注入数据再 setValue）
  function qeSelectMachine(machineObj) {
    return new Promise(resolve => {
      const jq = qeGetJQ();
      if (!jq) {
        resolve();
        return;
      }
      try {
        // 将目标仪器注入 combobox 数据源
        const item = {
          RowID: machineObj.id,
          Code: (machineObj.raw && machineObj.raw.Code) || '',
          CName: machineObj.text,
          value: machineObj.id,
          text: machineObj.text
        };
        jq('#cmbMach').combobox('loadData', [item]);
        jq('#cmbMach').combobox('setValue', machineObj.id);
        // 手动触发 onSelect
        const opts = jq('#cmbMach').combobox('options');
        if (opts && opts.onSelect) {
          opts.onSelect.call(jq('#cmbMach')[0], item);
        }
      } catch (e) {
        dbg('[LIS-QE] qeSelectMachine error:', e);
      }
      // 等待测试项目列表加载
      setTimeout(resolve, 1200);
    });
  }

  // 获取当前仪器下的测试项目列表
  function qeGetTestCodes() {
    const jq = qeGetJQ();
    if (!jq || !jq('#dgTestCode').datagrid) {return [];}
    try {
      return jq('#dgTestCode').datagrid('getRows') || [];
    } catch (e) {
      return [];
    }
  }

  // 选中一个测试项目并等待数据加载
  function qeSelectTestCode(rowIndex) {
    return new Promise(resolve => {
      const jq = qeGetJQ();
      if (!jq) {
        resolve();
        return;
      }
      try {
        jq('#dgTestCode').datagrid('selectRow', rowIndex);
      } catch (e) {}
      setTimeout(resolve, 1200); // 等待 dgData 加载
    });
  }

  // 读取 dgData 中的数据
  function qeReadData() {
    const jq = qeGetJQ();
    if (!jq || !jq('#dgData').datagrid) {return [];}
    try {
      return jq('#dgData').datagrid('getRows') || [];
    } catch (e) {
      return [];
    }
  }

  // 计算质控结果值（复用 qcAverageValue 逻辑）
  function qeCalcValue(row) {
    const vals = [];
    for (let i = 1; i <= 7; i++) {
      const n = parseFloat(row['Result' + i]);
      if (!Number.isNaN(n)) {vals.push(n);}
    }
    if (vals.length) {return vals.reduce((a, b) => a + b, 0) / vals.length;}
    const candidates = [row.DayAve, row.Result, row.TextRes, row.TestResultPosNeg];
    for (const v of candidates) {
      const n = parseFloat(v);
      if (!Number.isNaN(n)) {return n;}
    }
    return null;
  }

  // 从日期字符串提取日
  function qeExtractDay(dateStr) {
    const s = String(dateStr || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {return parseInt(s.slice(8, 10), 10);}
    if (/^\d{8}$/.test(s)) {return parseInt(s.slice(6, 8), 10);}
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? 0 : d.getDate();
  }

  // 从日期字符串提取月
  function qeExtractMonth(dateStr) {
    const s = String(dateStr || '').trim();
    if (/^\d{4}-\d{2}-\d{2}/.test(s)) {return parseInt(s.slice(5, 7), 10);}
    if (/^\d{8}$/.test(s)) {return parseInt(s.slice(4, 6), 10);}
    const d = new Date(s);
    return Number.isNaN(d.getTime()) ? 0 : d.getMonth() + 1;
  }

  function qeCountMonthQCRows(dataRows, month, year) {
    let n = 0;
    (dataRows || []).forEach(r => {
      const val = qeCalcValue(r);
      if (val === null || Number.isNaN(val)) {return;}
      const date = r.TestDate || r.AddDate || r.QCDate || '';
      const m = qeExtractMonth(date);
      const d = qeExtractDay(date);
      const inMonth =
        (m === month && d > 0) || (String(date).indexOf(year + '-' + String(month).padStart(2, '0')) === 0 && d > 0);
      if (inMonth) {n++;}
    });
    return n;
  }

  // 同月多质控物时（如血常规 202602/202604），自动选有数据的 MatDR
  async function qeFetchProjectQCData(group, proj, map, cfg) {
    const month = cfg._month || new Date().getMonth() + 1;
    const year = cfg._year || new Date().getFullYear();
    const startDate = year + '-' + String(month).padStart(2, '0') + '-01';
    const endDate = qeMonthEndDate(year, month);
    const matCandidates = [];
    const addMat = (md, name) => {
      const id = String(md || '');
      if (matCandidates.some(c => c.matDR === id)) {return;}
      matCandidates.push({ matDR: id, materialName: name || '' });
    };
    addMat(map.matDR, map.materialName);

    if (group.id === 'blood' || group.id === 'urine') {
      const testCodes = await qeApiTestCodes(map.machineDR, startDate, endDate);
      testCodes.forEach(tc => {
        if (!qeMatchProject(group, proj, tc, map.machineName)) {return;}
        addMat(tc.MatDR, tc.MaterialName);
      });
    }

    let bestRows = [],
      bestMat = map.matDR || '',
      bestName = map.materialName || '',
      bestCount = 0;
    for (const c of matCandidates) {
      const rows = await qeApiQCData(map.machineDR, map.testCodeDR, c.matDR, startDate, endDate);
      const cnt = qeCountMonthQCRows(rows, month, year);
      if (cnt > bestCount) {
        bestCount = cnt;
        bestRows = rows;
        bestMat = c.matDR;
        bestName = c.materialName || bestName;
      }
    }
    if (bestCount > 0 && bestMat !== map.matDR) {
      dbg('[LIS-QE] ' + proj.name + ' 质控物切换: ' + (map.materialName || map.matDR) + ' -> ' + (bestName || bestMat));
      map.matDR = bestMat;
      map.materialName = bestName;
    }
    return bestRows;
  }

  function qeMappingCount(mappings) {
    return Object.keys(mappings || {}).filter(k => !k.startsWith('_')).length;
  }

  // CS5100 仪器列表常为空，用质控物 MatDR 补查 + 院内稳定 DR 兜底
  async function qeCoagFallbackMappings(mappings, machines, startDate, endDate, statusCb) {
    const coagGroup = QE_GROUPS.find(g => g.id === 'coag');
    if (!coagGroup) {return;}
    const missing = coagGroup.projects.filter(p => !mappings[p.code]);
    if (!missing.length) {return;}
    const coagMach = machines.find(m => /CS.?5100|凝血|血凝/i.test(m.text));
    if (!coagMach) {return;}
    if (statusCb) {statusCb('凝血组：尝试质控物补查...', 'info');}

    const matDRs = ['167', '169', '151', '98'];
    for (const matDR of matDRs) {
      const testCodes = await qeApiTestCodes(coagMach.id, startDate, endDate, matDR);
      for (const tc of testCodes) {
        const rowID = String(tc.RowID || '');
        const mat = String(tc.MatDR || matDR || '');
        const cname = qeNormName(tc.CName);
        // 与主循环一致：每个 tc 只分配给匹配分最高的 proj
        let bestProj = null, bestScore = -1;
        for (const proj of coagGroup.projects) {
          if (mappings[proj.code]) {continue;}
          const score = qeMatchScore(coagGroup, proj, tc, coagMach.text);
          if (score < 0) {continue;}
          if (score > bestScore) {bestScore = score; bestProj = proj;}
        }
        if (bestProj) {
          mappings[bestProj.code] = {
            machineDR: coagMach.id,
            machineName: coagMach.text,
            testCodeDR: rowID,
            testName: cname || bestProj.name,
            matDR: mat,
            matLotDR: String(tc.MatLotRowID || ''),
            wgDR: coagMach.wgDR,
            wgName: coagMach.wgName,
            groupId: coagGroup.id
          };
        }
      }
    }

    const stillMissing = coagGroup.projects.filter(p => !mappings[p.code]);
    if (!stillMissing.length) {return;}
    const hardcoded = [
      { code: '1101', testCodeDR: '29', matDR: '167', names: ['凝血酶原时间', 'PT'] },
      { code: '1102', testCodeDR: '282', matDR: '167', names: ['国际标准化比值', 'INR'] },
      { code: '1103', testCodeDR: '27', matDR: '167', names: ['活化部分凝血活酶时间', 'APTT'] },
      { code: '1104', testCodeDR: '30', matDR: '167', names: ['纤维蛋白原', 'FIB'] }
    ];
    hardcoded.forEach(h => {
      if (mappings[h.code]) {return;}
      const proj = coagGroup.projects.find(p => p.code === h.code);
      if (!proj) {return;}
      mappings[h.code] = {
        machineDR: coagMach.id,
        machineName: coagMach.text,
        testCodeDR: h.testCodeDR,
        testName: h.names[0],
        matDR: h.matDR,
        matLotDR: '',
        wgDR: coagMach.wgDR,
        wgName: coagMach.wgName,
        groupId: coagGroup.id
      };
    });
    const coagFound = coagGroup.projects.filter(p => mappings[p.code]).length;
    if (statusCb && coagFound) {statusCb(`凝血组：${coagFound}/${coagGroup.projects.length} 已映射`, 'info');}
  }

  // --- 自动检测项目映射 ---
  // 遍历所有工作组的仪器，通过 API 查询测试项目并匹配
  async function qeDetectMappings(statusCb) {
    const mappings = {}; // { projectCode: { machineDR, testCodeDR, testName, machineName, matDR, matLotDR, wgDR, wgName } }
    const machines = await qeGetAllMachines();
    const now = today();
    // 计算当月日期范围
    const cfg = qeCollectConfig();
    const year = cfg._year || new Date().getFullYear();
    const month = cfg._month || new Date().getMonth() + 1;
    const startDate = year + '-' + String(month).padStart(2, '0') + '-01';
    const endDate = qeMonthEndDate(year, month);

    if (statusCb) {statusCb(`正在检测项目映射... 共 ${machines.length} 台仪器`, 'info');}

    for (let mi = 0; mi < machines.length; mi++) {
      if (qeAbortFlag) {break;}
      const mach = machines[mi];
      if (statusCb) {statusCb(`检测 ${mi + 1}/${machines.length}: ${mach.text}（${mach.wgName}）`, 'info');}

      // 通过 API 直接查询测试项目
      const testCodes = await qeApiTestCodes(mach.id, startDate, endDate);
      dbg(`[LIS-QE] ${mach.text}: ${testCodes.length} 个测试项目`);
      if (testCodes.length > 0) {
        dbg(
          '[LIS-QE] 示例:',
          testCodes
            .slice(0, 3)
            .map(
              tc => `Code=${tc.Code} CName=${tc.CName} MatName=${tc.MaterialName} RowID=${tc.RowID} MatDR=${tc.MatDR}`
            )
            .join(' | ')
        );
      }
      for (let ti = 0; ti < testCodes.length; ti++) {
        const tc = testCodes[ti];
        const rowID = String(tc.RowID || '');
        const matDR = String(tc.MatDR || '');
        const matLotDR = String(tc.MatLotRowID || '');
        const cname = qeNormName(tc.CName);
        // 每个 tc 只分配给匹配分最高的 proj，避免成对项目(FT3/TT3 等)
        // 因子串别名被同一数据抢占、导致导出结果相同
        let bestProj = null, bestGroup = null, bestScore = -1;
        for (const group of QE_GROUPS) {
          for (const proj of group.projects) {
            if (mappings[proj.code]) {continue;}
            const score = qeMatchScore(group, proj, tc, mach.text);
            if (score < 0) {continue;}
            if (score > bestScore) {
              bestScore = score; bestProj = proj; bestGroup = group;
            }
          }
        }
        if (bestProj) {
          mappings[bestProj.code] = {
            machineDR: mach.id,
            machineName: mach.text,
            testCodeDR: rowID,
            testName: cname || bestProj.name,
            matDR: matDR,
            matLotDR: matLotDR,
            materialName: String(tc.MaterialName || ''),
            wgDR: mach.wgDR,
            wgName: mach.wgName,
            groupId: bestGroup.id
          };
        }
      }
    }

    await qeCoagFallbackMappings(mappings, machines, startDate, endDate, statusCb);

    mappings._meta = { year: year, month: month, at: Date.now(), logicVersion: QE_MAP_LOGIC_VERSION };
    const found = qeMappingCount(mappings);
    const total = QE_GROUPS.reduce((s, g) => s + g.projects.length, 0);
    if (statusCb)
    {statusCb(
      `映射检测完成: ${found}/${total} 个项目已匹配（${year}-${String(month).padStart(2, '0')}）`,
      found === total ? 'ok' : 'info'
    );}
    return mappings;
  }

  // ============================================================
  // ⚠️ 映射缓存版本（8.4.7 事故教训：改匹配逻辑忘 bump，旧缓存让修复不生效）
  // 改以下任意匹配逻辑，必须同步：QE_MAP_KEY 的 v9 升 v10，且 QE_MAP_LOGIC_VERSION +1：
  //   - QE_ALIASES 别名表 / QE_LIS_ABBR 缩写表
  //   - qeMatchScore / qeAbbrHit / qeDetectMappings / qeCoagFallbackMappings
  //   - QE_GROUPS 的机器正则 / materialHint / lisName / 硬编码 DR
  // 导出前会校验 logicVersion，不符自动重新检测并保存；key 升版是双保险（旧缓存物理不可达）。
  // 只改数据获取 / Excel 生成等非匹配逻辑时无需 bump，但建议顺手 bump。
  // ============================================================
  const QE_MAP_KEY = 'lis-qe-mappings-v9';
  // 映射逻辑版本：qeMatchScore 最佳匹配 = 2。版本不符时导出前自动重新检测，
  // 防止旧缓存(如 v8 子串抢占导致的错误 testCodeDR)被复用、使脚本修复不生效
  const QE_MAP_LOGIC_VERSION = 2;
  function qeLoadMappings() {
    try {
      return JSON.parse(localStorage.getItem(QE_MAP_KEY) || '{}');
    } catch (e) {
      return {};
    }
  }
  function qeSaveMappings(m) {
    try {
      localStorage.setItem(QE_MAP_KEY, JSON.stringify(m));
    } catch (e) {}
  }

  // --- 核心：获取某组的质控数据 ---
  async function qeFetchGroupData(group, cfg, mappings, statusCb) {
    const rows = []; // 最终输出行
    const month = cfg._month || new Date().getMonth() + 1;
    const year = cfg._year || new Date().getFullYear();
    const operator = qeGetOperator(cfg, group);
    const startDate = year + '-' + String(month).padStart(2, '0') + '-01';
    const endDate = qeMonthEndDate(year, month);

    for (let pi = 0; pi < group.projects.length; pi++) {
      if (qeAbortFlag) {break;}
      const proj = group.projects[pi];
      const map = mappings[proj.code];
      if (!map) {
        if (statusCb) {statusCb(`  跳过 ${proj.name}（未找到映射）`, 'error');}
        continue;
      }

      if (statusCb) {statusCb(`  加载 ${proj.name} (${pi + 1}/${group.projects.length})...`, 'info');}

      // 通过 API 查询质控数据（血常规/尿常规等同月多质控物时自动选有数据的）
      const dataRows = await qeFetchProjectQCData(group, proj, map, cfg);
      if (!dataRows.length) {
        const matHint = map.materialName ? '（质控物 ' + map.materialName + '）' : '';
        if (statusCb) {statusCb(`  ${proj.name}: 无数据${matHint}`, 'info');}
        continue;
      }

      // 按浓度分组
      const levels = {};
      dataRows.forEach(r => {
        const lv = String(r.LevelNo || '1');
        if (!levels[lv]) {levels[lv] = [];}
        const val = qeCalcValue(r);
        if (val !== null && !Number.isNaN(val)) {
          const date = r.TestDate || r.AddDate || r.QCDate || '';
          const m = qeExtractMonth(date);
          const d = qeExtractDay(date);
          const inMonth =
            (m === month && d > 0) ||
            (String(date).indexOf(year + '-' + String(month).padStart(2, '0')) === 0 && d > 0);
          if (inMonth) {levels[lv].push({ day: d, value: val });}
        }
      });

      // 生成输出行
      const conc = group.concentrations || 1;
      for (let li = 0; li < conc; li++) {
        const lvNo = String(li + 1);
        const lvData = levels[lvNo] || [];
        let lot = '';
        if (group.lotMode === 'suffix') {
          const base = qeGetLot(cfg, group);
          lot = base + (li === 0 ? 'N' : 'H');
        } else if (group.lotMode === 'dual') {
          const lots = qeGetLot(cfg, group);
          lot = Array.isArray(lots) ? lots[li] || '' : '';
        } else if (group.lotMode === 'single') {
          lot = qeGetLot(cfg, group);
        } else if (group.lotMode === 'perProject' || group.lotMode === 'immune') {
          const lots = qeGetLot(cfg, group);
          lot = lots[proj.code] || '';
        } else if (group.lotMode === 'coag') {
          const lots = qeGetLot(cfg, group);
          lot = proj.isDDimer ? lots._dimer : lots._main;
        }
        lvData.sort((a, b) => a.day - b.day);
        const daySeq = {};
        lvData.forEach(pt => {
          const seq = (daySeq[pt.day] = (daySeq[pt.day] || 0) + 1);
          rows.push([proj.code, month, pt.day, seq, lot, pt.value, proj.name, operator]);
        });
      }
    }
    return rows;
  }

  // 油猴沙箱里 vendor 库可能挂在 window/unsafeWindow，不一定是自由变量
  function qeGetGlobal(name) {
    try {
      if (typeof globalThis !== 'undefined' && globalThis[name]) {return globalThis[name];}
    } catch (e) {}
    try {
      if (typeof window !== 'undefined' && window[name]) {return window[name];}
    } catch (e) {}
    try {
      if (typeof unsafeWindow !== 'undefined' && unsafeWindow[name]) {return unsafeWindow[name];}
    } catch (e) {}
    try {
      // 自由变量（@require 进沙箱时常在此）
      // eslint-disable-next-line no-eval
      const v = (0, eval)('typeof ' + name + '!=="undefined"?' + name + ':null');
      if (v) {return v;}
    } catch (e) {}
    return null;
  }

  // 从本机 serve 拉取 vendor 脚本并 eval（@require 失败时的兜底）
  async function qeLoadVendorScript(fileName, globalName) {
    if (qeGetGlobal(globalName)) {return true;}
    const urls = [VENDOR_BASE + '/' + fileName, 'http://127.0.0.1:8765/vendor/' + fileName];
    for (const url of urls) {
      try {
        const r = await fetch(url, { cache: 'no-cache', mode: 'cors' });
        if (!r.ok) {continue;}
        const code = await r.text();
        if (!code || code.length < 100) {continue;}
        // 绑定到本脚本可访问的对象（JSZip UMD 写 window.JSZip；须屏蔽 node 的 module）
        const root = typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : {};
        // module/exports/define 显式 undefined，避免 UMD 走 module.exports 而不挂全局
        const runner = new Function(
          'root',
          'window',
          'globalThis',
          'self',
          'module',
          'exports',
          'define',
          code +
            '\n;return (typeof ' +
            globalName +
            '!=="undefined"?' +
            globalName +
            ':null)||window.' +
            globalName +
            '||root.' +
            globalName +
            '||globalThis.' +
            globalName +
            ';'
        );
        let got = null;
        try {
          got = runner(root, root, root, root, undefined, undefined, undefined);
        } catch (e1) {
          dbg('[LIS-QE] Function 执行失败', fileName, e1.message);
          try {
            (0, eval)(code);
          } catch (e2) {}
          got = qeGetGlobal(globalName);
        }
        if (!got) {got = qeGetGlobal(globalName) || root[globalName];}
        if (got) {
          try {
            root[globalName] = got;
          } catch (e) {}
          if (globalName === 'XLSX') {qeXlsxLib = got;}
          if (globalName === 'JSZip') {qeJSZipLib = got;}
          dbg('[LIS-QE] 已从本机加载', fileName);
          return true;
        }
      } catch (e) {
        dbg('[LIS-QE] 加载失败', url, e.message);
      }
    }
    return !!qeGetGlobal(globalName);
  }

  let qeXlsxLib = null;
  let qeJSZipLib = null;

  async function qeEnsureXlsx() {
    if (qeXlsxLib && qeXlsxLib.utils) {return true;}
    const g = qeGetGlobal('XLSX');
    if (g && g.utils) {
      qeXlsxLib = g;
      return true;
    }
    const ok = await qeLoadVendorScript('xlsx.full.min.js', 'XLSX');
    qeXlsxLib = qeGetGlobal('XLSX') || qeXlsxLib;
    return !!(qeXlsxLib && qeXlsxLib.utils);
  }

  async function qeEnsureJSZip() {
    if (qeJSZipLib) {return true;}
    const g = qeGetGlobal('JSZip');
    if (g) {
      qeJSZipLib = g;
      return true;
    }
    const ok = await qeLoadVendorScript('jszip.min.js', 'JSZip');
    qeJSZipLib = qeGetGlobal('JSZip') || qeJSZipLib;
    return !!qeJSZipLib;
  }

  // --- Excel 生成 ---
  function qeBuildXlsx(groupName, rows) {
    const X = qeXlsxLib || qeGetGlobal('XLSX');
    if (!X || !X.utils) {
      throw new Error('SheetJS 未加载：请先运行 python3 ~/脚本/serve.py，再刷新页面后重试');
    }
    const wb = X.utils.book_new();
    const header = ['项目编码', '月', '日', '次', '批号', '数值', '备注', '操作者'];
    const data = [header, ...rows];
    const ws = X.utils.aoa_to_sheet(data);
    // 设置列宽
    ws['!cols'] = [{ wch: 10 }, { wch: 5 }, { wch: 5 }, { wch: 4 }, { wch: 18 }, { wch: 10 }, { wch: 20 }, { wch: 10 }];
    X.utils.book_append_sheet(wb, ws, 'Sheet1');
    return X.write(wb, { bookType: 'xlsx', type: 'array' });
  }

  function qeDownloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 5000);
  }

  // 从内存或结果列表 DOM 收集可打包文件（单独下载按钮上挂着 _blob）
  function qeCollectPackableFiles() {
    let files = (qeLastExportFiles || []).filter(f => f && f.blob && f.name);
    if (files.length) {return files;}
    const list = document.getElementById('lis-qe-results');
    if (!list) {return [];}
    files = [];
    list.querySelectorAll('button[data-fn]').forEach(btn => {
      if (btn._blob) {files.push({ name: btn.getAttribute('data-fn') || 'export.xlsx', blob: btn._blob });}
    });
    return files;
  }

  function qeUpdateZipButton() {
    const btn = document.getElementById('lis-qe-zip');
    if (!btn) {return;}
    const n = qeCollectPackableFiles().length;
    // 始终可点：无文件时点一下给提示，避免「灰色没反应」
    btn.disabled = false;
    btn.style.opacity = n > 0 ? '1' : '0.65';
    btn.style.cursor = 'pointer';
    btn.textContent = n > 0 ? `📦 打包下载 ZIP (${n})` : '📦 打包下载 ZIP';
  }

  // CRC32 表（ZIP 本地实现用，不依赖 JSZip，避免油猴沙箱卡住）
  let _qeCrcTable = null;
  function qeCrc32(u8) {
    if (!_qeCrcTable) {
      _qeCrcTable = new Uint32Array(256);
      for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) {c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;}
        _qeCrcTable[n] = c >>> 0;
      }
    }
    let crc = 0xffffffff;
    for (let i = 0; i < u8.length; i++) {crc = _qeCrcTable[(crc ^ u8[i]) & 0xff] ^ (crc >>> 8);}
    return (crc ^ 0xffffffff) >>> 0;
  }

  function qeU16(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff]);
  }
  function qeU32(n) {
    return new Uint8Array([n & 0xff, (n >>> 8) & 0xff, (n >>> 16) & 0xff, (n >>> 24) & 0xff]);
  }
  function qeConcatBytes(parts) {
    let len = 0;
    parts.forEach(p => {
      len += p.length;
    });
    const out = new Uint8Array(len);
    let off = 0;
    parts.forEach(p => {
      out.set(p, off);
      off += p.length;
    });
    return out;
  }

  // 纯 JS 生成 ZIP（仅 STORE 存储，xlsx 本身已压缩，体积几乎无差）
  function qeBuildZipBlobSync(entries) {
    // entries: [{ name: string, data: Uint8Array }]
    const enc = typeof TextEncoder !== 'undefined' ? new TextEncoder() : null;
    const localParts = [];
    const centralParts = [];
    let offset = 0;
    entries.forEach(ent => {
      const nameBytes = enc
        ? enc.encode(ent.name)
        : (() => {
          const a = new Uint8Array(ent.name.length);
          for (let i = 0; i < ent.name.length; i++) {a[i] = ent.name.charCodeAt(i) & 0xff;}
          return a;
        })();
      const data = ent.data;
      const crc = qeCrc32(data);
      const size = data.length >>> 0;
      // Local file header（flags bit11 = UTF-8 文件名，避免中文乱码）
      const flags = 0x0800;
      const local = qeConcatBytes([
        qeU32(0x04034b50),
        qeU16(20), // version needed
        qeU16(flags),
        qeU16(0), // method STORE
        qeU16(0),
        qeU16(0), // time/date
        qeU32(crc),
        qeU32(size),
        qeU32(size),
        qeU16(nameBytes.length),
        qeU16(0), // extra len
        nameBytes,
        data
      ]);
      localParts.push(local);
      // Central directory header
      const central = qeConcatBytes([
        qeU32(0x02014b50),
        qeU16(20),
        qeU16(20),
        qeU16(flags),
        qeU16(0),
        qeU16(0),
        qeU16(0),
        qeU32(crc),
        qeU32(size),
        qeU32(size),
        qeU16(nameBytes.length),
        qeU16(0),
        qeU16(0), // extra, comment
        qeU16(0),
        qeU16(0), // disk, int attr
        qeU32(0), // ext attr
        qeU32(offset),
        nameBytes
      ]);
      centralParts.push(central);
      offset += local.length;
    });
    const centralDir = qeConcatBytes(centralParts);
    const end = qeConcatBytes([
      qeU32(0x06054b50),
      qeU16(0),
      qeU16(0),
      qeU16(entries.length),
      qeU16(entries.length),
      qeU32(centralDir.length),
      qeU32(offset),
      qeU16(0)
    ]);
    const all = qeConcatBytes(localParts.concat([centralDir, end]));
    return new Blob([all], { type: 'application/zip' });
  }

  async function qeBlobToU8(blob) {
    if (!blob) {return new Uint8Array(0);}
    if (blob.arrayBuffer) {
      const ab = await blob.arrayBuffer();
      return new Uint8Array(ab);
    }
    // 极旧环境
    return new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(new Uint8Array(fr.result));
      fr.onerror = () => reject(fr.error || new Error('FileReader failed'));
      fr.readAsArrayBuffer(blob);
    });
  }

  // 一键 ZIP：纯本地实现，不依赖 JSZip（避免「打包中…」卡住）
  async function qeDownloadAllZip() {
    const files = qeCollectPackableFiles();
    if (!files.length) {
      qeSetStatus('没有可打包的文件：请先点「开始导出」生成表格。', 'error');
      return;
    }
    const zipBtn = document.getElementById('lis-qe-zip');
    if (zipBtn) {
      zipBtn.disabled = true;
      zipBtn.textContent = '打包中…';
    }
    try {
      qeSetStatus(`正在打包 ${files.length} 个 Excel…`, 'info');
      const entries = [];
      for (let i = 0; i < files.length; i++) {
        qeSetStatus(`读取文件 ${i + 1}/${files.length}：${files[i].name}`, 'info');
        // 让出主线程，刷新 UI
        await sleep(0);
        const u8 = await qeBlobToU8(files[i].blob);
        entries.push({ name: files[i].name, data: u8 });
      }
      qeSetStatus('正在生成 ZIP…', 'info');
      await sleep(0);
      const zipBlob = qeBuildZipBlobSync(entries);
      const cfg = qeCollectConfig();
      const ym =
        cfg._year && cfg._month
          ? `${cfg._year}${String(cfg._month).padStart(2, '0')}`
          : today().replace(/-/g, '').slice(0, 6);
      qeDownloadBlob(zipBlob, `质控数据_${ym}.zip`);
      qeSetStatus(`✅ ZIP 已下载（${files.length} 个表格，约 ${Math.round(zipBlob.size / 1024)} KB）。`, 'ok');
    } catch (e) {
      dbg('[LIS-QE] ZIP 失败:', e && e.message);
      qeSetStatus('ZIP 失败: ' + (e && e.message ? e.message : e) + '，改为逐个下载…', 'error');
      try {
        for (let i = 0; i < files.length; i++) {
          qeDownloadBlob(files[i].blob, files[i].name);
          await sleep(350);
        }
        qeSetStatus(`已触发 ${files.length} 个文件逐个下载。`, 'ok');
      } catch (e2) {
        qeSetStatus('逐个下载也失败: ' + (e2 && e2.message ? e2.message : e2), 'error');
      }
    } finally {
      qeUpdateZipButton();
    }
  }

  // --- UI 创建 ---
  function qeCreateFab() {
    if (document.getElementById('lis-qe-fab')) {return;}
    const fab = document.createElement('button');
    fab.id = 'lis-qe-fab';
    fab.textContent = 'QC导';
    fab.title = '质控数据导出\n拖动移动 | 点击打开';
    document.body.appendChild(fab);

    // 恢复位置
    const FAB_POS_KEY = 'lis-qe-fab-pos';
    try {
      const fp = JSON.parse(localStorage.getItem(FAB_POS_KEY) || 'null');
      if (fp && typeof fp.l === 'number') {
        fab.style.left = fp.l + 'px';
        fab.style.top = fp.t + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        fab.style.position = 'fixed';
      }
    } catch (e) {}

    // 拖动 + 点击
    let fabDx = 0,
      fabDy = 0,
      fabDownX = 0,
      fabDownY = 0;
    fab.addEventListener('mousedown', e => {
      fabDx = e.clientX - fab.offsetLeft;
      fabDy = e.clientY - fab.offsetTop;
      fabDownX = e.clientX;
      fabDownY = e.clientY;
      const onMove = ev => {
        fab.style.left = ev.clientX - fabDx + 'px';
        fab.style.top = ev.clientY - fabDy + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
        fab.style.position = 'fixed';
      };
      const onUp = ev => {
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        const dist = Math.abs(ev.clientX - fabDownX) + Math.abs(ev.clientY - fabDownY);
        if (dist < 5) {
          const panel = document.getElementById('lis-qe-panel');
          if (panel) {panel.classList.toggle('show');}
        } else {
          try {
            localStorage.setItem(FAB_POS_KEY, JSON.stringify({ l: fab.offsetLeft, t: fab.offsetTop }));
          } catch (e) {}
        }
      };
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
      e.preventDefault();
    });
  }

  function qeCreatePanel() {
    if (document.getElementById('lis-qe-panel')) {return;}
    const panel = document.createElement('div');
    panel.id = 'lis-qe-panel';

    const cfg = qeLoadConfig();
    const now = new Date();
    const defaultMonth = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');

    // --- 项目勾选 HTML ---
    let groupsHtml = '';
    QE_GROUPS.forEach(g => {
      groupsHtml += `<label><input type="checkbox" class="qe-gcheck" value="${g.id}" checked>${g.name} (${g.projects.length}项)</label>`;
    });

    // --- 批号设置 HTML ---
    let lotsHtml = '';
    QE_GROUPS.forEach(g => {
      const gc = (cfg.lots && cfg.lots[g.id]) || {};
      if (g.lotMode === 'suffix') {
        const base = gc.baseLot || g.baseLot;
        lotsHtml += `<div class="qe-lot-item"><span>${g.name} 基础批号</span><input type="text" class="qe-lot-input" data-group="${g.id}" data-type="baseLot" value="${esc(base)}" placeholder="自动+N/H后缀"></div>`;
      } else if (g.lotMode === 'dual') {
        const l1 = (gc.lots && gc.lots[0]) || (g.defaultLots && g.defaultLots[0]) || '';
        const l2 = (gc.lots && gc.lots[1]) || (g.defaultLots && g.defaultLots[1]) || '';
        lotsHtml += `<div class="qe-lot-item"><span>${g.name} Level1</span><input type="text" class="qe-lot-input" data-group="${g.id}" data-type="lot0" value="${esc(l1)}"></div>`;
        lotsHtml += `<div class="qe-lot-item"><span>${g.name} Level2</span><input type="text" class="qe-lot-input" data-group="${g.id}" data-type="lot1" value="${esc(l2)}"></div>`;
      } else if (g.lotMode === 'single') {
        const lot = gc.lot || g.defaultLot || '';
        lotsHtml += `<div class="qe-lot-item"><span>${g.name}</span><input type="text" class="qe-lot-input" data-group="${g.id}" data-type="lot" value="${esc(lot)}"></div>`;
      } else if (g.lotMode === 'perProject') {
        g.projects.forEach(p => {
          const lot = gc[p.code] || p.defaultLot || '';
          lotsHtml += `<div class="qe-lot-item"><span>${p.name}</span><input type="text" class="qe-lot-input" data-group="${g.id}" data-type="proj" data-code="${p.code}" value="${esc(lot)}"></div>`;
        });
      } else if (g.lotMode === 'coag') {
        const mainLot = gc._main || g.defaultLot || '';
        const dimerLot = gc._dimer || g.dDimLot || '';
        lotsHtml += `<div class="qe-lot-item"><span>凝血四项(INR/APTT/PT/FIB)</span><input type="text" class="qe-lot-input" data-group="${g.id}" data-type="coag_main" value="${esc(mainLot)}"></div>`;
        lotsHtml += `<div class="qe-lot-item"><span>D-二聚体</span><input type="text" class="qe-lot-input" data-group="${g.id}" data-type="coag_dimer" value="${esc(dimerLot)}"></div>`;
      } else if (g.lotMode === 'immune') {
        let projLotsHtml = '';
        g.projects.forEach(p => {
          const lot = gc[p.code] || p.defaultLot || g.defaultLot || '';
          projLotsHtml += `<div class="qe-lot-item"><span>${p.name}</span><input type="text" class="qe-lot-input" data-group="${g.id}" data-type="proj" data-code="${p.code}" value="${esc(lot)}"></div>`;
        });
        lotsHtml += `<div class="qe-lot-item" style="flex:1 0 100%"><span style="min-width:auto">${g.name}</span><span class="qe-immune-toggle" data-target="qe-imm-${g.id}">展开设置 ▾</span></div>`;
        lotsHtml += `<div id="qe-imm-${g.id}" class="qe-immune-lots" style="flex:1 0 100%"><div class="qe-lot-grid">${projLotsHtml}</div></div>`;
      }
    });

    // --- 操作者设置 HTML ---
    const operatorGroups = [
      { ids: ['blood', 'coag', 'urine'], label: '临检（血常规/凝血/尿常规）', def: '' },
      { ids: ['biochem', 'lipid'], label: '生化（含血脂）', def: '' },
      { ids: ['endocrine', 'tumor', 'cardiac', 'infection'], label: '免疫组', def: '' }
    ];
    let operatorHtml = '';
    operatorGroups.forEach(og => {
      const val = (cfg.operators && cfg.operators[og.ids[0]]) || og.def;
      operatorHtml += `<div class="qe-lot-item"><span>${og.label}</span><input type="text" class="qe-op-input" data-ids="${og.ids.join(',')}" value="${esc(val)}" style="flex:1;min-width:0"></div>`;
    });

    panel.innerHTML = `
            <div id="lis-qe-hd">
                <h3>📊 质控数据导出</h3>
                <span class="qe-spacer"></span>
                <button id="lis-qe-mini" title="隐藏">_</button>
                <button class="qe-close" id="lis-qe-close" title="关闭">×</button>
            </div>
            <div id="lis-qe-body">
                <!-- Step 1: 选择月份和项目 -->
                <div class="qe-step">
                    <div class="qe-step-hd">
                        <span class="qe-step-num">1</span>
                        <span class="qe-step-title">选择月份和导出项目</span>
                        <button id="lis-qe-toggle-all" style="height:22px;font-size:10px;border:1px solid #b8ddd3;background:#f0faf7;color:#0d6655;border-radius:3px;padding:0 8px;cursor:pointer;font-weight:700">全选/反选</button>
                    </div>
                    <div class="qe-step-body">
                        <div class="qe-date-row" style="margin-bottom:6px">
                            <input type="month" id="lis-qe-month" value="${defaultMonth}">
                        </div>
                        <div class="qe-row">${groupsHtml}</div>
                    </div>
                </div>

                <!-- Step 2: 批号和操作者设置 -->
                <div class="qe-step">
                    <div class="qe-step-hd">
                        <span class="qe-step-num">2</span>
                        <span class="qe-step-title">批号和操作者设置</span>
                        <span class="qe-step-desc">修改后点击右侧保存</span>
                        <button class="qe-save-btn" id="lis-qe-save">💾 保存设置</button>
                    </div>
                    <div class="qe-step-body">
                        <div class="qe-lot-grid">${lotsHtml}</div>
                        <div style="margin-top:8px;border-top:1px solid #edf1f5;padding-top:8px">
                            <div style="font-size:11px;font-weight:700;color:#526575;margin-bottom:4px">操作者</div>
                            <div class="qe-lot-grid">${operatorHtml}</div>
                        </div>
                    </div>
                </div>

                <!-- Step 3: 检测和导出 -->
                <div class="qe-step">
                    <div class="qe-step-hd">
                        <span class="qe-step-num">3</span>
                        <span class="qe-step-title">检测映射 → 导出</span>
                    </div>
                    <div class="qe-step-body">
                        <div class="qe-actions">
                            <button id="lis-qe-detect" title="自动检测质控系统中的项目映射">🔍 检测映射</button>
                            <button id="lis-qe-export" class="primary" title="开始导出">▶ 开始导出</button>
                            <button id="lis-qe-cancel" style="display:none;background:#fff3e0;color:#e65100;border-color:#ff9800">⏹ 停止</button>
                        </div>
                        <div id="lis-qe-status" style="margin-top:6px">选择月份和项目后，点击"检测映射"。</div>
                        <div class="qe-progress" id="lis-qe-progress"><div class="qe-progress-bar" id="lis-qe-pbar"></div><div class="qe-progress-text" id="lis-qe-ptext"></div></div>
                        <div class="qe-mapping-info" id="lis-qe-mapinfo"></div>
                    </div>
                </div>

                <!-- 导出结果 -->
                <div class="qe-step" id="lis-qe-result-section" style="display:none">
                    <div class="qe-step-hd">
                        <span class="qe-step-num">✓</span>
                        <span class="qe-step-title">导出结果</span>
                        <button id="lis-qe-zip" type="button" title="将本次导出的全部表格打成一个 ZIP">📦 打包下载 ZIP</button>
                    </div>
                    <div class="qe-step-body">
                        <div class="qe-result-list" id="lis-qe-results"></div>
                    </div>
                </div>
            </div>`;
    document.body.appendChild(panel);

    // --- 事件绑定 ---
    document.getElementById('lis-qe-mini').addEventListener('click', () => panel.classList.remove('show'));
    document.getElementById('lis-qe-close').addEventListener('click', () => panel.classList.remove('show'));
    const zipBtn0 = document.getElementById('lis-qe-zip');
    if (zipBtn0) {
      zipBtn0.addEventListener('click', e => {
        e.preventDefault();
        e.stopPropagation();
        qeSetStatus('正在处理打包…', 'info');
        qeDownloadAllZip().catch(err => {
          qeSetStatus('ZIP 异常: ' + (err && err.message ? err.message : err), 'error');
          qeUpdateZipButton();
        });
      });
    }

    // 全选/反选
    document.getElementById('lis-qe-toggle-all').addEventListener('click', () => {
      const checks = panel.querySelectorAll('.qe-gcheck');
      const allChecked = Array.from(checks).every(c => c.checked);
      checks.forEach(c => (c.checked = !allChecked));
    });

    // 免疫组展开/折叠
    panel.querySelectorAll('.qe-immune-toggle').forEach(el => {
      el.addEventListener('click', () => {
        const target = document.getElementById(el.dataset.target);
        if (target) {
          target.classList.toggle('show');
          el.textContent = target.classList.contains('show') ? '收起 ▴' : '展开设置 ▾';
        }
      });
    });

    // 保存设置
    document.getElementById('lis-qe-save').addEventListener('click', () => {
      const cfg = qeCollectConfig();
      qeSaveConfig(cfg);
      const btn = document.getElementById('lis-qe-save');
      btn.textContent = '✅ 已保存';
      btn.classList.add('saved');
      setTimeout(() => {
        btn.textContent = '💾 保存设置';
        btn.classList.remove('saved');
      }, 2000);
    });

    // 检测映射
    document.getElementById('lis-qe-detect').addEventListener('click', async () => {
      qeSetStatus('正在检测项目映射...', 'info');
      document.getElementById('lis-qe-detect').disabled = true;
      try {
        const mappings = await qeDetectMappings(qeSetStatus);
        qeSaveMappings(mappings);
        qeShowMappingInfo(mappings);
      } catch (e) {
        qeSetStatus('检测失败: ' + e.message, 'error');
      }
      document.getElementById('lis-qe-detect').disabled = false;
    });

    // 开始导出
    document.getElementById('lis-qe-export').addEventListener('click', () => qeStartExport());
    document.getElementById('lis-qe-cancel').addEventListener('click', () => {
      qeAbortFlag = true;
      qeSetStatus('正在停止...', 'info');
    });

    // ESC 关闭
    panel.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.stopImmediatePropagation();
        panel.classList.remove('show');
      }
    });

    // 加载已有映射信息
    const savedMap = qeLoadMappings();
    if (Object.keys(savedMap).length > 1) {qeShowMappingInfo(savedMap);}
  }

  function qeSetStatus(text, type) {
    const el = document.getElementById('lis-qe-status');
    if (!el) {return;}
    el.textContent = text || '';
    el.classList.remove('ok', 'error', 'info');
    if (type) {el.classList.add(type);}
  }

  function qeShowMappingInfo(mappings) {
    const el = document.getElementById('lis-qe-mapinfo');
    if (!el) {return;}
    const total = QE_GROUPS.reduce((s, g) => s + g.projects.length, 0);
    const found = qeMappingCount(mappings);
    const meta = mappings._meta;
    const groupStats = QE_GROUPS.map(g => {
      const n = g.projects.filter(p => mappings[p.code]).length;
      return `${g.name} ${n}/${g.projects.length}`;
    }).join('　');
    const missing = [];
    QE_GROUPS.forEach(g => {
      g.projects.forEach(p => {
        if (!mappings[p.code]) {missing.push(g.name + '/' + p.name);}
      });
    });
    const metaHint =
      meta && meta.year && meta.month
        ? `<br><span style="font-size:10px;color:#607d8b">映射月份: ${meta.year}-${String(meta.month).padStart(2, '0')}</span>`
        : '';
    el.innerHTML =
      `已匹配 <b>${found}/${total}</b> 个项目${metaHint}<br><span style="font-size:10px;color:#607d8b">${groupStats}</span>` +
      (missing.length ? `<br>未匹配: ${missing.join('、')}` : '<br>✅ 全部匹配');
  }

  // 从 UI 收集配置
  function qeCollectConfig() {
    const panel = document.getElementById('lis-qe-panel');
    if (!panel) {return {};}
    const cfg = {};

    // 月份
    const monthInput = document.getElementById('lis-qe-month');
    if (monthInput && monthInput.value) {
      const parts = monthInput.value.split('-');
      cfg._year = parseInt(parts[0], 10);
      cfg._month = parseInt(parts[1], 10);
      if (isNaN(cfg._year) || isNaN(cfg._month) || cfg._month < 1 || cfg._month > 12) {
        cfg._year = 0;
        cfg._month = 0;
      }
    }

    // 选中的组
    cfg.selectedGroups = Array.from(panel.querySelectorAll('.qe-gcheck:checked')).map(c => c.value);

    // 批号
    cfg.lots = {};
    panel.querySelectorAll('.qe-lot-input').forEach(input => {
      const gid = input.dataset.group;
      const type = input.dataset.type;
      const code = input.dataset.code;
      const val = input.value.trim();
      if (!cfg.lots[gid]) {cfg.lots[gid] = {};}
      if (type === 'baseLot') {cfg.lots[gid].baseLot = val;}
      else if (type === 'lot0') {
        if (!cfg.lots[gid].lots) {cfg.lots[gid].lots = [];}
        cfg.lots[gid].lots[0] = val;
      } else if (type === 'lot1') {
        if (!cfg.lots[gid].lots) {cfg.lots[gid].lots = [];}
        cfg.lots[gid].lots[1] = val;
      } else if (type === 'lot') {cfg.lots[gid].lot = val;}
      else if (type === 'coag_main') {cfg.lots[gid]._main = val;}
      else if (type === 'coag_dimer') {cfg.lots[gid]._dimer = val;}
      else if (type === 'proj' && code) {cfg.lots[gid][code] = val;}
    });

    // 操作者
    cfg.operators = {};
    panel.querySelectorAll('.qe-op-input').forEach(input => {
      const ids = (input.dataset.ids || '').split(',');
      ids.forEach(id => {
        if (id) {cfg.operators[id] = input.value.trim();}
      });
    });

    return cfg;
  }

  // 显示进度
  function qeShowProgress(current, total, text) {
    const prog = document.getElementById('lis-qe-progress');
    const bar = document.getElementById('lis-qe-pbar');
    const ptxt = document.getElementById('lis-qe-ptext');
    if (prog) {prog.classList.add('show');}
    if (bar) {bar.style.width = (total > 0 ? (current / total) * 100 : 0) + '%';}
    if (ptxt) {ptxt.textContent = text || `${current}/${total}`;}
  }
  function qeHideProgress() {
    const prog = document.getElementById('lis-qe-progress');
    if (prog) {prog.classList.remove('show');}
  }

  // 主导出流程
  async function qeStartExport() {
    if (qeExporting) {return;}

    const cfg = qeCollectConfig();
    if (!cfg._year || !cfg._month) {
      qeSetStatus('请选择有效的导出月份。', 'error');
      return;
    }
    if (!cfg.selectedGroups || !cfg.selectedGroups.length) {
      qeSetStatus('请至少选择一个导出项目。', 'error');
      return;
    }

    // 保存配置
    qeSaveConfig(cfg);

    let mappings = qeLoadMappings();
    // 映射逻辑版本不符(或缓存为空)时自动重新检测，确保用最新的 qeMatchScore 匹配，
    // 避免旧缓存里错误的 testCodeDR(如 FT3/TT3 指向同一条)被复用导致导出数据错乱
    if (!qeMappingCount(mappings) || !mappings._meta || mappings._meta.logicVersion !== QE_MAP_LOGIC_VERSION) {
      qeSetStatus('质控项目映射已更新，正在重新检测（仅需一次）...', 'info');
      try {
        mappings = await qeDetectMappings(qeSetStatus);
        qeSaveMappings(mappings);
        qeShowMappingInfo(mappings);
      } catch (e) {
        qeSetStatus('重新检测映射失败: ' + e.message + '（可手动点"检测映射"）', 'error');
        return;
      }
      if (!qeMappingCount(mappings)) {
        qeSetStatus('未检测到任何质控项目映射，请检查仪器配置后点"检测映射"。', 'error');
        return;
      }
    }
    const mapMeta = mappings._meta;
    if (mapMeta && cfg._year && cfg._month && (mapMeta.year !== cfg._year || mapMeta.month !== cfg._month)) {
      qeSetStatus(
        `映射为 ${mapMeta.year}-${String(mapMeta.month).padStart(2, '0')} 月检测，导出 ${cfg._year}-${String(cfg._month).padStart(2, '0')} 月；血常规将自动切换有数据的质控物`,
        'info'
      );
    }

    qeExporting = true;
    qeAbortFlag = false;
    qeLastExportFiles = [];
    qeUpdateZipButton();
    const exportBtn = document.getElementById('lis-qe-export');
    const cancelBtn = document.getElementById('lis-qe-cancel');
    const detectBtn = document.getElementById('lis-qe-detect');
    if (exportBtn) {exportBtn.disabled = true;}
    if (cancelBtn) {cancelBtn.style.display = '';}
    if (detectBtn) {detectBtn.disabled = true;}

    try {
      // SheetJS：@require 可能因 serve 未启动而失败，导出前再从本机补拉
      qeSetStatus('正在加载 Excel 组件（本机 serve）…', 'info');
      if (!(await qeEnsureXlsx())) {
        qeSetStatus(
          'SheetJS 未加载：请先运行  python3 ~/脚本/serve.py  ，保持窗口不关，再刷新本页后重试导出。',
          'error'
        );
        return;
      }

      const resultSection = document.getElementById('lis-qe-result-section');
      const resultList = document.getElementById('lis-qe-results');
      if (resultSection) {resultSection.style.display = '';}
      if (resultList) {resultList.innerHTML = '';}

      const groupsToExport = QE_GROUPS.filter(g => cfg.selectedGroups.includes(g.id));
      const totalGroups = groupsToExport.length;
      const results = [];

      for (let gi = 0; gi < totalGroups; gi++) {
        if (qeAbortFlag) {break;}
        const group = groupsToExport[gi];
        qeSetStatus(`正在导出 ${group.name} (${gi + 1}/${totalGroups})...`, 'info');
        qeShowProgress(gi, totalGroups, `${group.name} (${gi + 1}/${totalGroups})`);

        try {
          const rows = await qeFetchGroupData(group, cfg, mappings, qeSetStatus);
          if (rows.length > 0) {
            const xlsxData = qeBuildXlsx(group.name, rows);
            const blob = new Blob([xlsxData], {
              type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
            });
            results.push({ name: group.file, blob, rows: rows.length });
            qeAddResultItem(group.file, rows.length, blob);
            qeSetStatus(`${group.name}: 导出完成，${rows.length} 行数据`, 'ok');
          } else {
            qeSetStatus(`${group.name}: 无数据`, 'info');
            qeAddResultItem(group.file, 0, null);
          }
        } catch (e) {
          qeSetStatus(`${group.name}: 导出失败 - ${e.message}`, 'error');
          qeAddResultItem(group.file, 0, null, e.message);
        }
      }

      qeLastExportFiles = results.slice();
      qeUpdateZipButton();
      qeShowProgress(totalGroups, totalGroups, '完成');

      if (!qeAbortFlag) {
        const zipHint = results.length ? ' 可点右上角「打包下载 ZIP」。' : '';
        qeSetStatus(`导出完成！共 ${results.length}/${totalGroups} 个文件。${zipHint}`, 'ok');
      } else {
        qeSetStatus('导出已停止。', 'info');
      }
    } finally {
      qeExporting = false;
      qeAbortFlag = false;
      try {
        qeHideProgress();
      } catch (e) {}
      if (exportBtn) {exportBtn.disabled = false;}
      if (cancelBtn) {cancelBtn.style.display = 'none';}
      if (detectBtn) {detectBtn.disabled = false;}
    }
  }

  function qeAddResultItem(filename, rowCount, blob, error) {
    const list = document.getElementById('lis-qe-results');
    if (!list) {return;}
    const div = document.createElement('div');
    div.className = 'qe-result-item';
    let statusHtml = '';
    let btnHtml = '';
    if (error) {
      statusHtml = `<span class="qe-ri-status err">❌ ${esc(error)}</span>`;
    } else if (rowCount > 0) {
      statusHtml = `<span class="qe-ri-status ok">✅ ${rowCount} 行</span>`;
      if (blob) {
        btnHtml = `<button data-fn="${esc(filename)}">下载</button>`;
      }
    } else {
      statusHtml = '<span class="qe-ri-status" style="color:#9e9e9e">无数据</span>';
    }
    div.innerHTML = `<span class="qe-ri-name">${esc(filename)}</span>${statusHtml}${btnHtml}`;
    if (btnHtml) {
      const dlBtn = div.querySelector('button');
      dlBtn._blob = blob;
      dlBtn.addEventListener('click', () => {
        qeDownloadBlob(blob, filename);
      });
    }
    list.appendChild(div);
  }

  // --- 初始化 ---
  function initQEExport() {
    if (qeInited) {return;}
    qeInited = true;
    qeCreateFab();
    qeCreatePanel();
    dbg('[LIS-QE] 质控数据导出模块已加载');
  }

  let qeProbeTimer = null;
  function startQEProbe() {
    if (qeProbeTimer) {return;}
    const probe = () => {
      const fab = document.getElementById('lis-qe-fab');
      if (!qeInited) {initQEExport();}
      if (fab) {fab.style.display = 'flex';}
    };
    probe();
    qeProbeTimer = setInterval(probe, 2000);
  }

  // ============================================================
  //  模块 C：一体化工作台（核心）
  // ============================================================
  let wsData = []; // 加载的标本数据
  let wsMachines = []; // 当前加载的仪器列表
  let wsActiveMachine = ''; // 当前选中的仪器 DR, ''=全部
  let wsActiveWG = ''; // 当前选中的工作组 DR, ''=全部工作组
  let wsSelectedMachinesByWG = {}; // {工作组DR: [仪器DR]}，空数组/无记录=该工作组全部仪器
  let wsCategory = 'audit'; // 当前分类: 'audit'(待审,融合正常+异常)/'incomplete'/'pending'/'all'
  let wsClassifiedCache = {}; // 分类缓存 {[reportDR]: {status, items, row, reportDR}}
  const _CLASSIFIED_CACHE_MAX = 1000;
  let wsClassifying = false; // 分类进行中标记
  let wsAbnormalIndex = -1; // 异常视图当前焦点索引
  const wsChecked = new Set(); // 选中的 ReportDR 集合
  const wsSort = { field: 'AcceptDT', asc: false };
  let wsTimer = null;
  let _authTimer = null;
  let _batchScanTimer = null;
  let wsSearchQuery = '';
  let wsLoading = false;
  let wsMachineCounts = {}; // { machineDR: {total, normalReady, abnormalReady, incomplete} }

  // --- 性能优化：缓存 ---
  const _detailLRU = new Map(); // 详情结果 LRU 缓存，最多 50 条
  const _DETAIL_LRU_MAX = 50;
  let _filteredCache = null; // filteredData() 结果缓存
  let _filteredCacheKey = ''; // 缓存键
  let _countsCache = null; // 统一计数缓存
  let _countsCacheKey = ''; // 计数缓存键
  let _classifyRawCache = {}; // 分类时的原始 API 响应缓存，供详情面板复用
  let _classifyVersion = 0; // 分类结果版本，驱动过滤缓存失效
  let _wsLoadSeq = 0; // 工作台加载序号，防止旧请求覆盖新刷新
  let _classifyRunSeq = 0; // 分类运行序号，防止旧分类任务影响新刷新
  let _classifyPendingRerun = false; // 分类进行中又有新数据时，结束后再跑一轮
  let _lastWSNonEmptyAt = 0; // 最近一次成功加载到标本的时间，用于强制刷新兜底
  let _normalKeyHandler = null; // 普通视图键盘监听
  let _abnormalFocusDR = '';
  let _wsSearchTimer = null;
  const _tabId = 'tab_' + Date.now() + '_' + Math.random().toString(36).slice(2, 10);

  function specimenFingerprint(row) {
    if (!row) {return '';}
    return [
      row.ReportDR,
      row.Status || row.ReportStatus,
      row.IsComplete,
      row.AcceptDT,
      row.TransmitDate,
      row._mdr,
      row._pending ? '1' : '0'
    ]
      .map(v => String(v || ''))
      .join('|');
  }

  function isClassificationStale(row) {
    if (!row || !row.ReportDR) {return true;}
    const cached = wsClassifiedCache[row.ReportDR];
    if (!cached) {return true;}
    const fp = specimenFingerprint(row);
    if (cached.fingerprint !== fp) {return true;}
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
    if (changed) {_classifyVersion++;}
    return changed;
  }

  function attachClassificationMeta(result, row) {
    if (!result || !row) {return result;}
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
    if (options.detail) {_detailLRU.clear();}
    if (options.raw) {_classifyRawCache = {};}
  }

  function normalizeWSMachineFilterState(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object') {return out;}
    Object.keys(raw).forEach(wg => {
      const arr = Array.isArray(raw[wg]) ? raw[wg] : [];
      const selected = [...new Set(arr.map(v => String(v || '')).filter(Boolean))];
      if (selected.length) {out[String(wg)] = selected;}
    });
    return out;
  }

  function getWSSelectedMachineSet(wg) {
    const key = String(wg || '');
    if (!key) {return new Set();}
    return new Set((wsSelectedMachinesByWG[key] || []).map(String).filter(Boolean));
  }

  function setWSSelectedMachineSet(wg, set) {
    const key = String(wg || '');
    if (!key) {return;}
    const arr = [...set].map(String).filter(Boolean);
    if (arr.length) {wsSelectedMachinesByWG[key] = arr;}
    else {delete wsSelectedMachinesByWG[key];}
  }

  function wsMachineFilterSetForActiveWG() {
    return wsActiveWG ? getWSSelectedMachineSet(wsActiveWG) : new Set();
  }

  function rowPassWSMachineFilter(row) {
    if (!row) {return false;}
    if (wsActiveWG && row._wg !== wsActiveWG) {return false;}
    if (wsActiveWG) {
      // 单工作组模式：检查该组的多选仪器
      const selected = getWSSelectedMachineSet(wsActiveWG);
      if (selected.size > 0) {return selected.has(String(row._mdr || prWorkGroupMachineDR(row) || ''));}
    } else {
      // 全部工作组模式：只要有任何组勾选了仪器，就只显示被勾选的
      const anySelected = WG.some(w => getWSSelectedMachineSet(w.dr).size > 0);
      if (anySelected) {
        const wgSelected = getWSSelectedMachineSet(row._wg || '');
        return wgSelected.size > 0 && wgSelected.has(String(row._mdr || prWorkGroupMachineDR(row) || ''));
      }
      // 所有组都没勾选 = 全部仪器通过
    }
    if (wsActiveMachine) {return String(row._mdr || prWorkGroupMachineDR(row) || '') === String(wsActiveMachine);}
    return true;
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
    if (_detailLRU.has(key)) {_detailLRU.delete(key);}
    if (_detailLRU.size >= _DETAIL_LRU_MAX) {
      const first = _detailLRU.keys().next().value;
      _detailLRU.delete(first);
    }
    _detailLRU.set(key, val);
  }

  const WS_CATEGORIES = ['audit', 'incomplete', 'pending', 'all'];

  function saveWSState() {
    try {
      localStorage.setItem(
        K.wsState,
        JSON.stringify({
          wg: wsActiveWG,
          cat: wsCategory,
          mdr: wsActiveMachine,
          multiMdr: wsSelectedMachinesByWG
        })
      );
    } catch (e) { dbg('saveWSState 失败:', e.message); }
  }

  function loadWSState() {
    const fallback = { wg: wgDR() || '', cat: 'audit', mdr: '' };
    try {
      const saved = JSON.parse(localStorage.getItem(K.wsState) || '{}');
      const wg = Object.prototype.hasOwnProperty.call(saved, 'wg') ? String(saved.wg) : fallback.wg;
      // 旧版 normal/abnormal 分类已合并为 audit（待审），老状态自动归一
      const cat = WS_CATEGORIES.includes(saved.cat)
        ? saved.cat
        : saved.cat === 'normal' || saved.cat === 'abnormal'
          ? 'audit'
          : fallback.cat;
      const mdr = Object.prototype.hasOwnProperty.call(saved, 'mdr') ? String(saved.mdr) : fallback.mdr;
      const multiMdr = saved.multiMdr && typeof saved.multiMdr === 'object' ? saved.multiMdr : {};
      return { wg, cat, mdr, multiMdr };
    } catch (e) {
      return fallback;
    }
  }

  function applyWSState(state) {
    wsActiveWG = state.wg;
    wsCategory = state.cat;
    wsActiveMachine = state.mdr;
    wsSelectedMachinesByWG = normalizeWSMachineFilterState(state.multiMdr || {});
    if (wsActiveWG && wsActiveMachine && !getWSSelectedMachineSet(wsActiveWG).size) {
      setWSSelectedMachineSet(wsActiveWG, new Set([String(wsActiveMachine)]));
      wsActiveMachine = '';
    }
  }

  function normalizeWSMachineSelection(loadedWGs) {
    const byWG = {};
    Object.keys(wsSelectedMachinesByWG || {}).forEach(wg => {
      // 该组机器列表没成功加载（网络瞬断返回空）时不清理，保留原勾选等下一轮再验
      if (loadedWGs && loadedWGs.size && !loadedWGs.has(String(wg))) {
        byWG[wg] = wsSelectedMachinesByWG[wg];
        return;
      }
      const valid = new Set(wsMachines.filter(m => String(m._wg || '') === String(wg)).map(m => String(m.RowID || '')));
      const selected = (wsSelectedMachinesByWG[wg] || []).map(String).filter(mdr => valid.has(mdr));
      if (selected.length) {byWG[wg] = [...new Set(selected)];}
    });
    wsSelectedMachinesByWG = byWG;
    if (wsActiveMachine) {
      const ok = wsMachines.some(
        m => String(m.RowID) === String(wsActiveMachine) && (!wsActiveWG || m._wg === wsActiveWG)
      );
      if (!ok) {wsActiveMachine = '';}
    }
  }

  // 打开工作台
  function openWS() {
    // 防重入：如果已打开，不做任何操作
    const wsEl = $('#lis-ws');
    if (!wsEl) {return;}
    if (wsEl.classList.contains('show')) {
      dbg('[WS] openWS 被调用但已打开，跳过');
      return;
    }
    dbg('[WS] openWS 被调用');
    if (DEBUG) {console.trace('[WS] openWS 调用栈');}

    applyWSState(loadWSState());
    _abnormalPrewarmDR = '';
    _abnormalNativeReadyDR = '';
    wsClassifiedCache = {};
    _classifyVersion++;
    wsClassifying = false;
    wsLoading = false; // 重置加载状态，防止上次 closeWS 时 loadWSData 还在运行
    _wsLoadSeq++; // 作废关闭前可能仍在飞行的 loadWSData
    wsAbnormalIndex = -1;
    wsChecked.clear();
    wsData = [];
    wsMachines = [];
    wsMachineCounts = {};
    _tabsBuilt = false;
    _catBarBuilt = false;
    invalidateCaches({ detail: true, raw: true });
    wsEl.classList.add('show');
    // 强制 flex 布局（LIS 系统 CSS 会覆盖）
    wsEl.style.cssText =
      'display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important;position:fixed!important;inset:0!important;z-index:100000!important';
    document.body.style.overflow = 'hidden';
    renderWSHeader();
    renderWSTabs();
    renderWSCategoryBar();
    renderWSTable();
    updateWSFooter();
    _installF4Bridge(); // 常驻 F4 桥，独立于异常视图处理器生命周期
    loadWSData().then(() => {
      if (wsCategory === 'audit') {prefetchAbnormalAuditContext();}
    });
    startWSRefresh();
    if (wsCategory === 'audit') {prefetchReportPageForWS();}
  }

  function closeWS() {
    const wsEl = $('#lis-ws');
    if (!wsEl) {return;}
    if (!wsEl.classList.contains('show')) {
      dbg('[WS] closeWS 被调用但未打开，跳过');
      return;
    }
    saveWSState();
    dbg('[WS] closeWS 被调用');
    if (DEBUG) {console.trace('[WS] closeWS 调用栈');}
    wsEl.classList.remove('show');
    wsEl.style.cssText = 'display:none!important';
    document.body.style.overflow = '';
    stopWSRefresh();
    closeDetailPanel(true); // 关闭详情面板，避免工作台关闭后详情面板残留
    updateAbnormalEnterBridge();
    // 清理键盘监听器
    _removeAbnormalKeyHandler();
    _removeF4BridgeHandler(); // 清理 F4 桥，防止事件监听器泄漏
    if (_normalKeyHandler) {
      document.removeEventListener('keydown', _normalKeyHandler);
      _normalKeyHandler = null;
    }
    _removeDetailKeyHandler();
    clearTimeout(_abnormalPrewarmTimer);
    _abnormalPrewarmTimer = null;
    clearMachineCache(); // 关闭工作台时清理仪器缓存，避免内存只增不减
    wsLoading = false; // 重置加载状态，防止下次 openWS 被阻塞
    _wsLoadSeq++; // 作废关闭时仍在飞行的 loadWSData
  }

  function findWSSpecimenByReportDR(reportDR) {
    const target = String(reportDR || '');
    if (!target) {return null;}
    const fromFiltered = filteredData().find(r => String(r.ReportDR || '') === target);
    if (fromFiltered) {return fromFiltered;}
    return wsData.find(r => String(r.ReportDR || '') === target) || null;
  }

  function resolveQueueItemRow(item) {
    if (!item) {return null;}
    return wsData.find(r => String(r.ReportDR) === String(item.reportDR)) || null;
  }

  function acquireQueueLock() {
    try {
      const raw = localStorage.getItem(K.auditQueueLock);
      if (raw) {
        const lock = JSON.parse(raw);
        if (lock.owner !== _tabId && Date.now() - (lock.ts || 0) < AUDIT_QUEUE_LOCK_TTL) {return false;}
      }
      localStorage.setItem(K.auditQueueLock, JSON.stringify({ owner: _tabId, ts: Date.now() }));
      return true;
    } catch (e) {
      return true;
    }
  }

  function refreshQueueLock() {
    try {
      localStorage.setItem(K.auditQueueLock, JSON.stringify({ owner: _tabId, ts: Date.now() }));
    } catch (e) {}
  }

  function releaseQueueLock() {
    try {
      const raw = localStorage.getItem(K.auditQueueLock);
      if (!raw) {return;}
      const lock = JSON.parse(raw);
      if (lock.owner === _tabId) {localStorage.removeItem(K.auditQueueLock);}
    } catch (e) {}
  }

  function isWSVisible() {
    const wsEl = document.getElementById('lis-ws');
    return !!(wsEl && wsEl.classList.contains('show'));
  }

  function keepWorkbenchOnTop(reason) {
    const wsEl = document.getElementById('lis-ws');
    if (!wsEl) {return;}
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
      if (!wsData.length) {loadWSData();}
    }
    wsEl.style.cssText =
      'display:flex!important;flex-direction:column!important;height:100vh!important;overflow:hidden!important;position:fixed!important;inset:0!important;z-index:100000!important';
    document.body.style.overflow = 'hidden';
    dbg('[WS] 批审保持工作台置顶: ' + (reason || ''));
  }

  function startWSRefresh() {
    stopWSRefresh();
    wsTimer = setInterval(() => loadWSData(), REFRESH);
  }
  function stopWSRefresh() {
    if (wsTimer) {
      clearInterval(wsTimer);
      wsTimer = null;
    }
  }

  // --- 加载数据 ---
  async function loadWSData(options = {}) {
    const force = !!(options && options.force);
    if (wsLoading && !force) {return { skipped: true };}
    // 分类进行中时跳过自动刷新（force 仍可强制），避免 30s 刷新打断分类、
    // 整组重分类永远追不上刷新拖死批审（6456 行注释已意识的同类问题）
    if (wsClassifying && !force) {
      dbg('分类进行中，跳过自动刷新');
      return { skipped: true };
    }
    const seq = ++_wsLoadSeq;
    if (force) {
      wsLoading = false;
      wsClassifying = false;
      _classifyPendingRerun = false;
      _classifyRunSeq++; // 作废进行中的分类写回，避免强制刷新后被旧结果污染
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
      if (qi) {qi.textContent = force ? '强制刷新中...' : '加载中...';}

      const curDR = wgDR();
      // 优先加载当前登录的工作组，其他组后台延迟加载
      const priorityWG = WG.find(w => w.dr === curDR);
      const otherWGs = WG.filter(w => w.dr !== curDR);
      const hasPriority = !!priorityWG;

      async function loadOneWG(w) {
        let machines;
        try {
          machines = await loadMachines(w.dr);
        } catch (e) {
          machines = [];
        }
        const ss = buildSS(w.dr);
        const wgData = [];
        const wgMachines = [];
        const machineResults = await Promise.all(
          machines
            .filter(m => m.RowID)
            .map(async m => {
              const result = { rows: [], pending: [], machine: m };
              try {
                result.rows = await loadWL(m.RowID, ss);
                try {
                  result.pending = await loadPendingForMachine(m.RowID, ss);
                } catch (e) {}
              } catch (e) {}
              return result;
            })
        );
        for (const mr of machineResults) {
          const m = mr.machine;
          mr.rows.forEach(r => {
            r._wg = w.dr;
            r._wgn = w.name;
            r._wgc = w.color;
            r._wgi = w.icon;
            r._mn = m.CName || m.Name || m.RowID;
            r._mdr = m.RowID;
          });
          mr.pending.forEach(r => {
            r._wg = w.dr;
            r._wgn = w.name;
            r._wgc = w.color;
            r._wgi = w.icon;
            r._mn = m.CName || m.Name || m.RowID;
            r._mdr = m.RowID;
          });
          wgData.push(...mr.rows, ...mr.pending);
          wgMachines.push({ ...m, _wg: w.dr, _wgn: w.name, _wgc: w.color, _wgi: w.icon });
        }
        // machinesOk：机器列表是否成功加载（瞬断返回空时不清理该组勾选，等下一轮再验）
        return { data: wgData, machines: wgMachines, wg: w.dr, machinesOk: machines.length > 0 };
      }

      function applyResults(results, partial) {
        const allData = [];
        const allMachines = [];
        const loadedWGs = new Set();
        for (const r of results) {
          allData.push(...r.data);
          allMachines.push(...r.machines);
          if (r.machinesOk && r.wg) {loadedWGs.add(String(r.wg));}
        }
        if (allData.length === 0 && wsData.length > 0 && !partial) {
          dbg('刷新返回空数据，保留原有', wsData.length, '条');
          if (qi) {qi.textContent = `刷新失败，保留 ${wsData.length} 条 | ${new Date().toLocaleTimeString()}`;}
          if (force) {showToast('工作台强制刷新仍返回空数据，可能需要重新登录或刷新浏览器页面', 'warning');}
          return false;
        }
        wsData = allData;
        wsMachines = allMachines;
        if (wsData.length > 0) {_lastWSNonEmptyAt = Date.now();}
        // 阶段1（partial）只加载了当前工作组，机器列表不全：此时清理勾选会把其他工作组的
        // 多选仪器删掉（全部仪器跨组勾选在自动刷新后只剩一台的 bug）。等全部工作组加载完再清理。
        // 同理 pruneStaleClassificationCache 也不能在 partial 阶段跑：会把其他工作组的分类缓存
        // 当「已消失」删掉，每 30s 刷新就整组重分类，数据量大时分类永远追不上刷新（拖死批审）。
        if (!partial) {
          normalizeWSMachineSelection(loadedWGs);
          pruneStaleClassificationCache(wsData);
        }
        calcMachineCounts();
        const label = partial ? '优先' : '';
        if (qi) {qi.textContent = `${wsData.length} 条${label} | ${new Date().toLocaleTimeString()}`;}
        invalidateCaches({ raw: true, detail: true });
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
        updateWSFooter();
        return true;
      }

      if (hasPriority) {
        // 阶段1：优先加载当前工作组，立即渲染
        const priorityResult = await loadOneWG(priorityWG);
        if (seq !== _wsLoadSeq) {return;}
        if (!isWSVisible()) {return;}
        applyResults([priorityResult], true);
        classifyAllSpecimens(seq).catch(e => dbg('分类启动异常:', e));

        // 阶段2：后台加载其余工作组，完成后追加渲染
        if (otherWGs.length > 0) {
          const otherResults = await Promise.all(otherWGs.map(w => loadOneWG(w)));
          if (seq !== _wsLoadSeq) {return;}
          if (!isWSVisible()) {return;}
          applyResults([priorityResult, ...otherResults], false);
          // 阶段1 分类可能仍在跑：classifyAllSpecimens 会排队重跑，覆盖其余工作组
          classifyAllSpecimens(seq).catch(e => dbg('分类启动异常:', e));
        }
      } else {
        // 无法识别当前工作组，退回全量并行加载
        const wgResults = await Promise.all(WG.map(w => loadOneWG(w)));
        if (seq !== _wsLoadSeq) {return;}
        if (!isWSVisible()) {return;}
        if (!applyResults(wgResults, false)) {
          return { ok: false, empty: true, preserved: wsData.length > 0 };
        }
        classifyAllSpecimens(seq).catch(e => dbg('分类启动异常:', e));
      }

      if (wsCategory === 'audit') {prefetchAbnormalAuditContext();}
      return { ok: true, count: wsData.length, empty: wsData.length === 0 };
    } catch (e) {
      dbg('loadWSData 异常:', e);
      if (qi) {qi.textContent = '加载失败';}
      return { ok: false, error: e, empty: true };
    } finally {
      if (seq === _wsLoadSeq) {wsLoading = false;}
    }
  }

  // 整页刷新并在加载后自动重新打开工作台（锁屏会话失效时等同浏览器强刷）
  function hardReloadPageForWS(reason) {
    try {
      sessionStorage.setItem(WS_REOPEN_KEY, '1');
      // 记住工作台状态，刷新后恢复
      saveWSState();
    } catch (e) {}
    showToast(reason || '正在刷新页面以恢复会话…', 'warning');
    setTimeout(() => {
      try {
        // 优先强制从服务器重载，避免磁盘缓存的过期页面
        if (typeof location.reload === 'function') {location.reload();}
        else {location.href = location.href;}
      } catch (e) {
        try {
          location.href = location.href;
        } catch (e2) {}
      }
    }, 350);
  }

  function maybeReopenWSAfterReload() {
    try {
      if (sessionStorage.getItem(WS_REOPEN_KEY) !== '1') {return;}
      sessionStorage.removeItem(WS_REOPEN_KEY);
    } catch (e) {
      return;
    }
    // 等页面/会话就绪再开工作台
    const tryOpen = n => {
      if (n <= 0) {return;}
      try {
        if (!document.getElementById('lis-ws')) {
          setTimeout(() => tryOpen(n - 1), 400);
          return;
        }
        if (!isWSVisible()) {openWS();}
        else {loadWSData({ force: true }).catch(() => {});}
      } catch (e) {
        setTimeout(() => tryOpen(n - 1), 400);
      }
    };
    setTimeout(() => tryOpen(15), 600);
  }

  async function forceRefreshWS() {
    dbg('[WS] 强制刷新工作台状态');
    stopWSRefresh();
    clearMachineCache();
    const hadData = wsData.length > 0 || _lastWSNonEmptyAt > 0;
    const alreadyEmpty = wsData.length === 0;
    wsLoading = false;
    wsClassifying = false;
    _classifyRunSeq++; // 先递增序号，确保正在运行的分类任务感知到并中止
    wsClassifiedCache = {};
    _classifyVersion++;
    wsChecked.clear();
    wsAbnormalIndex = -1;
    invalidateCaches({ detail: true, raw: true });
    // 界面立即反馈
    const qi = document.getElementById('lis-qi');
    if (qi) {qi.textContent = '强制刷新中...';}
    renderWSTabs();
    renderWSCategoryBar();
    renderWSTable();
    updateWSFooter();
    try {
      const result = await loadWSData({ force: true });
      const err = result && result.error;
      const empty = !result || result.empty || result.count === 0 || wsData.length === 0;
      const errMsg = (err && (err.message || String(err))) || '';
      const sessionDead = /会话|过期|非JSON|HTTP 401|HTTP 403|登录/i.test(errMsg);

      // 软刷新成功拿到数据 → 正常继续
      if (result && result.ok && !empty && !err) {
        dbg('[WS] 强制刷新成功，条数=', wsData.length);
        showToast('工作台已刷新（' + wsData.length + ' 条）', 'success');
        return;
      }

      // 锁屏/会话失效常见：一直 0 或接口失败 → 整页刷新（与浏览器强刷同效果）
      // 条件：曾经有过数据、或当前已是全 0、或明确会话错误
      if (sessionDead || hadData || alreadyEmpty || empty) {
        hardReloadPageForWS(
          sessionDead ? '会话可能已失效，正在刷新页面…' : '工作台数据异常（全 0 或加载失败），正在刷新页面…'
        );
        return;
      }
    } catch (e) {
      dbg('[WS] forceRefreshWS 异常:', e);
      hardReloadPageForWS('刷新异常，正在刷新页面…');
      return;
    } finally {
      // 若即将整页刷新则不必再开定时器
      try {
        if (sessionStorage.getItem(WS_REOPEN_KEY) === '1') {return;}
      } catch (e) {}
      if (isWSVisible()) {startWSRefresh();}
    }
  }

  const _mcCache = {};
  function clearMachineCache() {
    for (const k in _mcCache) {delete _mcCache[k];}
  }
  async function loadMachines(dr) {
    if (dr in _mcCache) {return _mcCache[dr];}
    const data = await fetchJ(WGM + '?Method=FindWGMbyWorkGroup&WorkGroupDR=' + dr);
    const rows = data && data.rows ? data.rows : Array.isArray(data) ? data : [];
    // 不缓存空结果，避免网络异常后永久返回空
    if (rows.length > 0) {_mcCache[dr] = rows;}
    return rows;
  }

  async function loadWL(mdr, ss) {
    const p = new URLSearchParams();
    p.set('ClassName', 'LIS.WS.BLL.DHCRPVisitNumberReportForCSP');
    p.set('QueryName', 'QryWorkList');
    p.set('FunModul', 'MTHD');
    // P0: ReportStatus (空=全部)
    // P1: SttAccDate (开始日期)
    // P2: EndAccDate (结束日期)
    // P10: WorkGroupMachineDR (仪器DR，空=全部)
    // P11: ReportType (N^^^^)
    // P14: SessionStr
    p.set('P0', ''); // 空=全部状态
    p.set('P1', today());
    p.set('P2', today());
    p.set('P10', mdr || '');
    p.set('P11', 'N^^^^');
    p.set('P14', ss);
    const data = await fetchJ(CSP + '?' + p.toString());
    return data && data.rows ? data.rows : Array.isArray(data) ? data : [];
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
    const rows = data && data.rows ? data.rows : Array.isArray(data) ? data : [];
    return rows.map(r => ({
      ...r,
      ReportDR: 'pending:' + String(wgmDR || '') + ':' + String(r.Labno || '') + ':' + String(r.RegNo || ''),
      Status: '0',
      ReportStatus: '0',
      IsComplete: '0',
      EpisodeNo: r.RegNo || '',
      AcceptDT: ((r.AcceptDate || '') + ' ' + (r.AcceptTime || '')).trim(),
      _pending: true
    }));
  }
  function calcMachineCounts() {
    wsMachineCounts = {};
    wsMachineCounts['_all'] = { total: 0, normalReady: 0, abnormalReady: 0, incomplete: 0 };
    wsData.forEach(r => {
      const mdr = r._mdr || '_unknown';
      if (!wsMachineCounts[mdr]) {wsMachineCounts[mdr] = { total: 0, normalReady: 0, abnormalReady: 0, incomplete: 0 };}
      wsMachineCounts[mdr].total++;
      wsMachineCounts['_all'].total++;

      const bucket = getWSAuditBucket(r);
      if (bucket === 'audited' || bucket === 'pending') {return;}
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

  // 跨工作组切换：
  // LIS 原生切换流程：父框架 <select id="sl_changeworkgroup"> → changeLogin(this) → ChangeLogin API → 重载页面。
  // 本函数直接调用父框架的 changeLogin 完成切组。
  async function safeSwitchWG(dr) {
    const wgName = (WG_MAP[dr] || {}).name || dr;
    try {
      const topWin = window.top;
      const topDoc = topWin.document;
      const sel = topDoc.getElementById('sl_changeworkgroup');
      if (!sel) {
        showToast(`未找到工作组切换控件，请手动切到${wgName}`, 'warning');
        return false;
      }
      if (String(sel.value) === String(dr)) {return true;} // 已在目标组
      sel.value = String(dr);
      // 调用父框架原生 changeLogin，与用户手动选工作组完全一致
      if (typeof topWin.changeLogin === 'function') {
        topWin.changeLogin(sel);
        return true;
      }
      // 降级：派发 change 事件
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    } catch (e) {
      dbg('safeSwitchWG 异常: ' + e);
      showToast(`切组失败，请手动切到${wgName}`, 'warning');
      return false;
    }
  }

  // --- 异常审核跨组跳转：保存/恢复目标标本 ---
  const K_ABN_TGT = 'LIS_AbnormalAuditTarget';
  function saveAbnormalTarget(specimen) {
    try {
      // 读取已有 cycle 计数，累加防循环
      let cycle = 0;
      try {
        const old = JSON.parse(localStorage.getItem(K_ABN_TGT) || '{}');
        cycle = (old.cycle || 0) + 1;
      } catch (_) {}
      localStorage.setItem(
        K_ABN_TGT,
        JSON.stringify({
          reportDR: String(specimen.ReportDR || ''),
          wg: specimen._wg || '',
          name: specimen.PatName || '',
          labno: specimen.Labno || '',
          ts: Date.now(),
          cycle
        })
      );
    } catch (e) {}
  }
  function loadAbnormalTarget() {
    try {
      const raw = localStorage.getItem(K_ABN_TGT);
      if (!raw) {return null;}
      const t = JSON.parse(raw);
      if (!t || !t.reportDR || Date.now() - (t.ts || 0) > 5 * 60 * 1000) {
        localStorage.removeItem(K_ABN_TGT);
        return null;
      }
      // 防止无限循环：最多尝试 3 次切组
      if ((t.cycle || 0) > 3) {
        localStorage.removeItem(K_ABN_TGT);
        return null;
      }
      return t;
    } catch (e) {
      return null;
    }
  }
  function clearAbnormalTarget() {
    try {
      localStorage.removeItem(K_ABN_TGT);
    } catch (e) {}
  }
  function checkAbnormalTarget() {
    const tgt = loadAbnormalTarget();
    if (!tgt) {return;}
    // 不立即清空，找到标本后再清（防止页面重载导致丢失）
    // 跨组切组后页面已重载、工作台处于关闭状态：
    // 1) 先打开工作台（openWS 会从 localStorage 恢复上次的工作组 + 跨组仪器多选），
    //    并触发 loadWSData，否则 wsData 永远为空、找不到目标标本、工作台也不会自动打开；
    // 2) 恢复后再 saveWSState()，避免把空的多选状态覆盖回 localStorage 丢掉跨组勾选。
    if (!isWSVisible()) {openWS();}
    if (wsCategory !== 'audit') {
      wsCategory = 'audit';
      saveWSState();
      renderWSCategoryBar();
      renderWSTable();
    }
    let classifiedOnce = false; // 只主动补分类一次，避免每条轮询都发请求
    const tryFind = attempts => {
      const found = wsData.find(r => String(r.ReportDR) === tgt.reportDR);
      if (found) {
        // 直接按桶判断（不依赖分类队列整体进度），否则大工作组的分类批次可能跑不完，
        // 轮询窗口内目标标本一直进不了待审视图 → 误报「未找到标本」
        // 合并视图：正常/异常均可审，两个分支都恢复定位+审核（否则跨组审 normal 会漏审）
        const _bucket = getWSAuditBucket(found);
        const isAuditable = _bucket === 'normal' || _bucket === 'abnormal';
        if (!isAuditable && !classifiedOnce) {
          classifiedOnce = true;
          fetchAndClassifySpecimen(found)
            .then(live => {
              if (live && live.reportDR) {
                attachClassificationMeta(live, found);
                wsClassifiedCache[live.reportDR] = live;
                _classifyVersion++;
                invalidateCaches();
              }
            })
            .catch(() => {});
          // 本轮先不成功，等下一次轮询（已提交主动分类）
        } else if (isAuditable) {
          const data = filteredData();
          let idx = data.indexOf(found);
          if (idx < 0) {idx = data.length ? 0 : -1;} // 同桶必在列表，兜底取首条
          if (idx >= 0) {
            clearAbnormalTarget();
            wsAbnormalIndex = idx;
            showToast(`继续审核: ${tgt.name || tgt.labno}`, 'warning');
            setTimeout(() => auditAbnormalSpecimen(found), 500);
            return;
          }
        }
      }
      if (attempts > 0) {
        // init 阶段会话可能未就绪、首次加载失败时，主动补一次强制加载
        if (attempts === 10 && !wsData.length) {loadWSData({ force: true }).catch(() => {});}
        setTimeout(() => tryFind(attempts - 1), 1000);
      }
      else {
        clearAbnormalTarget();
        showToast(`未找到标本 ${tgt.name || tgt.labno}，可能已审核`, 'warning');
      }
    };
    setTimeout(() => tryFind(10), 1500);
  }

  function getWSAuditBucket(r) {
    const status = String(r.Status || r.ReportStatus || '');
    if (status === '3' || status === '4') {return 'audited';}
    if (status === '0') {return 'pending';}
    const complete = String(r.IsComplete || '');
    if (complete !== '1') {return 'incomplete';}
    const cached = wsClassifiedCache[r.ReportDR];
    if (!cached) {return 'incomplete';} // 分类未完成时不进入正常可审，避免误批审
    if (isClassificationStale(r)) {return 'incomplete';}
    if (cached.status === 'NORMAL') {return 'normal';}
    if (cached.status === 'ABNORMAL' || cached.status === 'CRITICAL') {return 'abnormal';}
    return 'incomplete';
  }

  function getMachineSortRank(machine) {
    const name = ((machine && (machine.CName || machine.Name || machine.RowID)) || '').toLowerCase();
    const wg = String((machine && machine._wg) || '');
    const rules =
      wg === '1'
        ? [
          ['血细胞', /血细胞|血球|血常规|bc-|xn|xs|sysmex|mindray|迈瑞/],
          ['血凝', /血凝|凝血|coag|cs-|ca-|stago|acl/],
          ['尿液', /尿液|尿沉渣|尿干化|尿常规|uf|uc|urisys|ave/],
          ['粪便', /粪便|大便|便|fec|ob/],
          ['血流变', /血流变|流变|hemorheology/],
          ['手工杂项', /手工|杂项|manual/]
        ]
        : wg === '4'
          ? [
            ['800', /dxi\s*800|dxi800|化学发光仪800|800/],
            ['x8', /maglumi\s*x?8|maglumix8|x8/],
            ['1600', /1600|getein/],
            ['wan200', /wan\s*200|wan200/],
            ['手工杂项', /手工|杂项|manual/]
          ]
          : [];
    for (let i = 0; i < rules.length; i++) {
      if (rules[i][1].test(name)) {return i;}
    }
    return 100;
  }

  function sortWSMachines(machines) {
    return [...machines].sort((a, b) => {
      const ra = getMachineSortRank(a);
      const rb = getMachineSortRank(b);
      if (ra !== rb) {return ra - rb;}
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
    if (wgCmp) {return wgCmp;}

    const rankA = specimenMachineRank(a);
    const rankB = specimenMachineRank(b);
    if (rankA !== rankB) {return rankA - rankB;}

    const mdrA = prWorkGroupMachineDR(a);
    const mdrB = prWorkGroupMachineDR(b);
    const mdrCmp = String(mdrA).localeCompare(String(mdrB), 'zh');
    if (mdrCmp) {return mdrCmp;}

    return String(a._mn || '').localeCompare(String(b._mn || ''), 'zh');
  }

  function compareSpecimensForAudit(a, b) {
    const g = compareSpecimensByMachineGroup(a, b);
    if (g) {return g;}
    const va = String(a.AcceptDT || '');
    const vb = String(b.AcceptDT || '');
    const dtCmp = vb.localeCompare(va, 'zh');
    if (dtCmp) {return dtCmp;}
    return String(a.Labno || '').localeCompare(String(b.Labno || ''), 'zh');
  }

  // 确定用户实际登录工作组（多层回退）
  function resolveCurrentWG() {
    // 注意：跨组判定必须以「实际登录工作组」为准，不能用工作台视图过滤器 wsActiveWG——
    // 用户可能看的是临检 tab 而实际登录在生化；且切组重载后 wsActiveWG 是从 localStorage 恢复的
    // 旧视图组，若优先返回它会导致批审死循环 / F4 跨组静默不审。
    // 1. 父框架工作组下拉框（切组后页面重载，全局变量可能尚未就绪，但下拉框已更新）
    try {
      const sel = window.top.document.getElementById('sl_changeworkgroup');
      if (sel && sel.value) {return String(sel.value);}
    } catch (e) {}
    // 2. LIS 页面全局变量
    const dr = wgDR();
    if (dr) {return dr;}
    // 3. 工作台选中的工作组（仅视图过滤，不代表登录组；无登录组信息时才退回）
    if (wsActiveWG) {return wsActiveWG;}
    // 4. 从 wsData 推断：有标本的工作组中最常见的
    const counts = {};
    wsData.forEach(r => {
      const w = r._wg;
      if (w) {counts[w] = (counts[w] || 0) + 1;}
    });
    let best = '',
      bestN = 0;
    for (const [w, n] of Object.entries(counts)) {
      if (n > bestN) {
        best = w;
        bestN = n;
      }
    }
    return best;
  }

  function compareAuditQueueItems(a, b) {
    const rowA = resolveQueueItemRow(a) || { _wg: a.wg, _mdr: a.mdr, AcceptDT: '', Labno: a.labno };
    const rowB = resolveQueueItemRow(b) || { _wg: b.wg, _mdr: b.mdr, AcceptDT: '', Labno: b.labno };
    // 当前工作组优先，减少切组次数
    const curWg = resolveCurrentWG();
    const aIsCur = String(rowA._wg || a.wg) === curWg ? 0 : 1;
    const bIsCur = String(rowB._wg || b.wg) === curWg ? 0 : 1;
    if (aIsCur !== bIsCur) {return aIsCur - bIsCur;}
    const g = compareSpecimensByMachineGroup(rowA, rowB);
    if (g) {return g;}
    const va = String(rowA.AcceptDT || '');
    const vb = String(rowB.AcceptDT || '');
    const dtCmp = vb.localeCompare(va, 'zh');
    if (dtCmp) {return dtCmp;}
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
    let machineFilterKey;
    if (wsActiveWG) {
      machineFilterKey = [...wsMachineFilterSetForActiveWG()].sort().join(',');
    } else {
      // 全部工作组：汇总所有组的选中仪器
      const allSel = [];
      WG.forEach(w => {
        const s = getWSSelectedMachineSet(w.dr);
        if (s.size) {allSel.push(w.dr + ':' + [...s].sort().join(','));}
      });
      machineFilterKey = allSel.length ? allSel.sort().join('|') : wsActiveMachine;
    }
    const ck =
      wsActiveWG +
      '|' +
      machineFilterKey +
      '|' +
      wsCategory +
      '|' +
      _q +
      '|' +
      (wsSort.field + wsSort.asc) +
      '|' +
      _classifyVersion;
    if (_filteredCache && _filteredCacheKey === ck) {return _filteredCache;}
    let d = [...wsData];
    // 工作组 + 仪器过滤
    if (wsActiveWG || wsActiveMachine || WG.some(w => getWSSelectedMachineSet(w.dr).size > 0))
    {d = d.filter(rowPassWSMachineFilter);}
    // 分类过滤
    if (wsCategory === 'audit') {
      d = d.filter(r => {
        const b = getWSAuditBucket(r);
        return b === 'normal' || b === 'abnormal';
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
      d = d.filter(
        r =>
          (r.PatName || '').toLowerCase().includes(ql) ||
          (r.Labno || '').toLowerCase().includes(ql) ||
          (r.EpisodeNo || '').toLowerCase().includes(ql) ||
          (r.RegNo || '').toLowerCase().includes(ql) ||
          (r.TestSetDesc || '').toLowerCase().includes(ql)
      );
    }
    wsSearchQuery = _q; // 保存搜索词用于高亮
    // 排序：批审/异常待审按仪器分组，同仪器内再按原排序字段
    const { field, asc } = wsSort;
    if (wsCategory === 'audit') {
      // 待审视图：按仪器分组，组内 危急→异常→正常（正常放后面，供 F4 一键批审）
      d.sort((a, b) => {
        const g = compareSpecimensByMachineGroup(a, b);
        if (g) {return g;}
        const rank = r => {
          const b = getWSAuditBucket(r);
          if (b === 'normal') {return 2;}
          const cached = wsClassifiedCache[r.ReportDR];
          return cached && cached.status === 'CRITICAL' ? 0 : 1;
        };
        const ra = rank(a);
        const rb = rank(b);
        if (ra !== rb) {return ra - rb;}
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
    let machineFilterKey;
    if (wsActiveWG) {
      machineFilterKey = [...wsMachineFilterSetForActiveWG()].sort().join(',');
    } else {
      const allSel = [];
      WG.forEach(w => {
        const s = getWSSelectedMachineSet(w.dr);
        if (s.size) {allSel.push(w.dr + ':' + [...s].sort().join(','));}
      });
      machineFilterKey = allSel.length ? allSel.sort().join('|') : wsActiveMachine;
    }
    const ck = wsData.length + '|' + wsActiveWG + '|' + machineFilterKey;
    if (_countsCache && _countsCacheKey === ck) {return _countsCache;}

    // 工作组计数
    const wgCounts = {};
    WG.forEach(w => {
      wgCounts[w.dr] = { total: 0, normalReady: 0, abnormalReady: 0, incomplete: 0 };
    });
    // 分类计数（基于当前过滤）
    let normalCount = 0,
      abnormalCount = 0,
      incompleteCount = 0,
      pendingCount = 0;
    // 全部仪器汇总
    const machCounts = {};
    machCounts['_all'] = { total: 0, normalReady: 0, abnormalReady: 0, incomplete: 0 };

    wsData.forEach(r => {
      // 工作组计数
      const wg = r._wg;
      if (wgCounts[wg]) {
        wgCounts[wg].total++;
      }
      // 仪器计数
      const mdr = r._mdr || '_unknown';
      if (!machCounts[mdr]) {machCounts[mdr] = { total: 0, normalReady: 0, abnormalReady: 0, incomplete: 0 };}
      machCounts[mdr].total++;
      machCounts['_all'].total++;

      const bucket = getWSAuditBucket(r);
      if (bucket === 'pending') {
        pendingCount++;
        return;
      }
      if (bucket === 'audited') {return;}

      if (bucket === 'incomplete') {
        if (wgCounts[wg]) {wgCounts[wg].incomplete++;}
        machCounts[mdr].incomplete++;
        machCounts['_all'].incomplete++;
        incompleteCount++;
        return;
      }
      if (bucket === 'abnormal') {
        if (wgCounts[wg]) {wgCounts[wg].abnormalReady++;}
        machCounts[mdr].abnormalReady++;
        machCounts['_all'].abnormalReady++;
        abnormalCount++;
      } else if (bucket === 'normal') {
        if (wgCounts[wg]) {wgCounts[wg].normalReady++;}
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
    let wgHTML = '';
    WG.forEach(w => {
      wgHTML += `<button class="ws-wg-tab" data-wg="${w.dr}"><span class="ws-tab-name">${w.name}</span><span class="mach-cnt ws-cnt-total"></span></button>`;
    });
    wgHTML += `<button class="ws-wg-tab" data-wg=""><span class="ws-tab-name">全部</span><span class="mach-cnt ws-cnt-total"></span></button>`;
    hd.innerHTML = `
            <div class="ws-title"><span class="ws-title-dot"></span><h3>审核工作台</h3></div>
            <div class="ws-search-wrap">
                <input type="text" class="ws-search" id="lis-ws-search" placeholder="姓名 / 检验号 / 流水号" />
            </div>
            <div class="ws-wg-inline">${wgHTML}</div>
            <div class="ws-right-group"><div class="ws-cat-hd-inline" data-ws-cat-tabs></div><div class="ws-acts">
                <button class="ws-icon-btn" id="lis-ws-refresh" title="强制刷新（全0/会话失效时等同浏览器刷新，并自动重开工作台）">↻</button>
                <button class="ws-icon-btn" id="lis-ws-pwd" title="CA密码">钥</button>
                <button class="ws-icon-btn danger" id="lis-ws-close" title="关闭">×</button>
            </div></div>`;

    document.getElementById('lis-ws-refresh').addEventListener('click', () => {
      dbg('刷新按钮被点击');
      const btn = document.getElementById('lis-ws-refresh');
      if (btn) {
        btn.classList.add('spinning');
        btn.title = '刷新中…';
      }
      forceRefreshWS().finally(() => {
        // 若已触发整页刷新，按钮会随页面销毁
        if (btn && document.body.contains(btn)) {
          btn.classList.remove('spinning');
          btn.title = '强制刷新（全0/会话失效时等同浏览器刷新，并自动重开工作台）';
        }
      });
    });
    document.getElementById('lis-ws-close').addEventListener('click', closeWS);
    document.getElementById('lis-ws-pwd').addEventListener('click', openPwdDlg);
    document.getElementById('lis-ws-search').addEventListener('input', () => {
      invalidateCaches();
      clearTimeout(_wsSearchTimer);
      _wsSearchTimer = setTimeout(() => { renderWSTable(); updateWSFooter(); }, 200);
    });
    // Header workgroup tab events
    hd.querySelectorAll('.ws-wg-tab').forEach(b =>
      b.addEventListener('click', () => {
        invalidateCaches();
        wsActiveWG = b.dataset.wg;
        wsActiveMachine = '';
        wsAbnormalIndex = -1;
        wsChecked.clear();
        saveWSState();
        renderWSHeaderWGTabs();
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
      })
    );
  }

  function renderWSHeaderWGTabs() {
    const hd = $('#lis-ws-hd');
    if (!hd) {return;}
    const wgCounts = calcWSTabCounts();
    hd.querySelectorAll('.ws-wg-tab').forEach(b => {
      const wg = b.dataset.wg;
      const isOn = wg ? wsActiveWG === wg : !wsActiveWG;
      b.classList.toggle('on', isOn);
      const tEl = b.querySelector('.ws-cnt-total');
      if (wg) {
        const c = wgCounts[wg] || { total: 0 };
        if (tEl) {tEl.textContent = c.total;}
      } else {
        const totalAll = WG.reduce((s, w) => s + (wgCounts[w.dr]?.total || 0), 0);
        if (tEl) {tEl.textContent = totalAll;}
      }
    });
  }

  // --- 渲染：仪器标签栏（两级：工作组 + 仪器）---
  function calcWSTabCounts() {
    const wgCounts = {};
    WG.forEach(w => {
      wgCounts[w.dr] = { total: 0, normalReady: 0, abnormalReady: 0 };
    });
    wsData.forEach(r => {
      const wg = r._wg;
      if (!wgCounts[wg]) {return;}
      wgCounts[wg].total++;
      const bucket = getWSAuditBucket(r);
      if (bucket === 'normal') {wgCounts[wg].normalReady++;}
      else if (bucket === 'abnormal') {wgCounts[wg].abnormalReady++;}
    });
    return wgCounts;
  }

  let _tabsBuilt = false;
  let _tabsLastActiveWG = undefined;
  let _tabsLastMachineCount = 0; // 上次构建时的仪器数量

  function renderWSTabs() {
    const tabs = $('#lis-ws-tabs');
    if (!tabs) {return;}
    tabs.style.flexShrink = '0';
    const mc = wsMachineCounts;
    const wgCounts = calcWSTabCounts();
    // 首次 / 切换工作组 / 仪器数量变化时重建 DOM，其余只更新状态
    const needRebuild = !_tabsBuilt || _tabsLastActiveWG !== wsActiveWG || _tabsLastMachineCount !== wsMachines.length;
    if (needRebuild) {
      _tabsBuilt = true;
      _tabsLastActiveWG = wsActiveWG;
      _tabsLastMachineCount = wsMachines.length;
      buildWSTabsDOM(tabs, wgCounts, mc);
    } else {
      updateWSTabsState(tabs, wgCounts, mc);
    }
  }

  function buildWSTabsDOM(tabs, wgCounts, mc) {
    // One row: instruments left + category tabs right
    let h = '';

    h += `<div class="ws-mach-row${wsActiveWG ? '' : ' all-wg'}"><span class="ws-mach-filter-label">仪器</span>`;
    if (wsActiveWG) {
      h += `<button class="ws-mach-tab ws-mach-all" data-action="all">
                <span class="ws-tab-name">全部仪器</span>
                <span class="mach-cnt ws-cnt-mach"></span>
            </button>`;
      sortWSMachines(wsMachines.filter(m => m._wg === wsActiveWG)).forEach(m => {
        const mdr = String(m.RowID || '');
        h += `<button class="ws-mach-tab ws-mach-multi" data-multi-m="${escAttr(mdr)}" data-wg="${escAttr(wsActiveWG)}">
                    <span class="ws-mach-check"></span>
                    <span class="ws-tab-name">${esc(m.CName || m.Name)}</span>
                    <span class="mach-cnt ws-cnt-mach"></span>
                </button>`;
      });
    } else {
      h += `<button class="ws-mach-tab ws-mach-all" data-action="all-global">
                <span class="ws-tab-name">全部仪器</span>
                <span class="mach-cnt ws-cnt-mach"></span>
            </button>`;
      WG.forEach(w => {
        const wgMachines = sortWSMachines(wsMachines.filter(m => m._wg === w.dr));
        if (!wgMachines.length) {return;}
        h += '<div class="ws-mach-group">';
        h += `<span class="ws-mach-group-label" style="color:${w.color || '#666'}">${esc(w.name)}</span>`;
        wgMachines.forEach(m => {
          const mdr = String(m.RowID || '');
          h += `<button class="ws-mach-tab ws-mach-multi" data-multi-m="${escAttr(mdr)}" data-wg="${escAttr(w.dr)}">
                        <span class="ws-mach-check"></span>
                        <span class="ws-tab-name">${esc(m.CName || m.Name)}</span>
                        <span class="mach-cnt ws-cnt-mach"></span>
                    </button>`;
        });
        h += '</div>';
      });
    }
    h += '</div>';
    tabs.innerHTML = h;

    // 事件绑定（只绑一次）
    tabs.querySelectorAll('.ws-wg-tab').forEach(b =>
      b.addEventListener('click', () => {
        invalidateCaches();
        wsActiveWG = b.dataset.wg;
        wsActiveMachine = '';
        wsAbnormalIndex = -1;
        wsChecked.clear();
        saveWSState();
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
      })
    );
    tabs.querySelectorAll('.ws-mach-all').forEach(b =>
      b.addEventListener('click', () => {
        invalidateCaches();
        if (wsActiveWG) {setWSSelectedMachineSet(wsActiveWG, new Set());}
        else {WG.forEach(w => setWSSelectedMachineSet(w.dr, new Set()));}
        wsActiveMachine = '';
        wsAbnormalIndex = -1;
        wsChecked.clear();
        saveWSState();
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
      })
    );
    tabs.querySelectorAll('.ws-mach-multi').forEach(b =>
      b.addEventListener('click', () => {
        invalidateCaches();
        const mdr = String(b.dataset.multiM || '');
        const wg = b.dataset.wg || wsActiveWG || '';
        if (!wg) {return;}
        const selected = getWSSelectedMachineSet(wg);
        if (selected.has(mdr)) {selected.delete(mdr);}
        else if (mdr) {selected.add(mdr);}
        setWSSelectedMachineSet(wg, selected);
        wsActiveMachine = '';
        wsAbnormalIndex = -1;
        wsChecked.clear();
        saveWSState();
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
      })
    );
    updateWSTabsState(tabs, wgCounts, mc);
  }

  // 仅更新数字和选中态（不重建 DOM，不闪烁）
  function updateWSTabsState(tabs, wgCounts, mc) {
    // Workgroup tabs are in header — update via renderWSHeaderWGTabs
    renderWSHeaderWGTabs();
    tabs.querySelectorAll('.ws-mach-tab').forEach(b => {
      if (b.classList.contains('ws-mach-all')) {
        const isOn = wsActiveWG
          ? getWSSelectedMachineSet(wsActiveWG).size === 0
          : !WG.some(w => getWSSelectedMachineSet(w.dr).size > 0);
        b.classList.toggle('on', isOn);
        const el = b.querySelector('.ws-cnt-mach');
        if (el) {el.textContent = (mc['_all'] || { total: 0 }).total;}
      } else if (b.classList.contains('ws-mach-multi')) {
        const mdr = b.dataset.multiM;
        const wg = b.dataset.wg || wsActiveWG || '';
        const checked = wg ? getWSSelectedMachineSet(wg).has(mdr) : false;
        b.classList.toggle('on', checked);
        const chk = b.querySelector('.ws-mach-check');
        if (chk) {chk.textContent = checked ? '✓' : '';}
        const el = b.querySelector('.ws-cnt-mach');
        if (el) {el.textContent = (mc[mdr] || { total: 0 }).total;}
      }
    });
  }

  // 切换工作台分类（与点击分类标签行为一致：保留勾选、刷新渲染）
  function switchWSCategory(cat) {
    if (!cat) {return;}
    // 旧版 normal/abnormal 已合并为 audit（待审）
    if (cat === 'normal' || cat === 'abnormal') {cat = 'audit';}
    invalidateCaches();
    wsCategory = cat;
    wsAbnormalIndex = -1;
    saveWSState();
    renderWSCategoryBar();
    renderWSTable();
    updateAbnormalEnterBridge();
    if (wsCategory === 'audit') {prefetchAbnormalAuditContext();}
  }

  // 菜单栏跳转：工作台关闭时先打开，再显示目标分类。
  function gotoWSCategoryFromMenubar(cat) {
    if (!cat) {return;}
    if (cat === 'normal' || cat === 'abnormal') {cat = 'audit';} // 旧入口统一归入待审
    if (!isWSVisible()) {
      // 必须先 openWS()：它会 applyWSState(loadWSState()) 恢复跨组仪器多选。
      // 若先 set+saveWSState()（此时内存 multiMdr 还是空 {}），会把 localStorage
      // 里的跨组勾选覆盖清空（与 checkAbnormalTarget 同类 bug）。
      openWS();
      wsCategory = cat;
      wsAbnormalIndex = -1;
      saveWSState();
      renderWSCategoryBar();
      renderWSTable();
      updateAbnormalEnterBridge();
      if (wsCategory === 'audit') {prefetchAbnormalAuditContext();}
      return;
    }
    switchWSCategory(cat);
  }

  // 菜单栏指令轮询：SwiftBar 下拉点击 → 由本地桥原子认领，避免多标签重复执行。
  let _menubarCmdTimer = null;
  let _menubarCmdLastId = 0;
  function startMenubarCmdPoller() {
    if (_menubarCmdTimer) {return;}
    _menubarCmdTimer = setInterval(() => {
      try {
        fetch('http://127.0.0.1:8765/cmd', { cache: 'no-store' })
          .then(r => (r.ok ? r.json() : null))
          .then(cmd => {
            if (!cmd || cmd.consumed) {return;}
            if (cmd.id === _menubarCmdLastId) {return;}
            if (cmd.action === 'goto' && cmd.cat) {
              fetch('http://127.0.0.1:8765/cmd/claim', {
                method: 'POST',
                headers: { 'Content-Type': 'text/plain' },
                body: JSON.stringify({ id: cmd.id })
              })
                .then(r => (r.ok ? r.json() : null))
                .then(result => {
                  if (!result) {return;}
                  _menubarCmdLastId = cmd.id;
                  if (result.claimed) {gotoWSCategoryFromMenubar(cmd.cat);}
                })
                .catch(() => {});
            } else {
              _menubarCmdLastId = cmd.id;
            }
          })
          .catch(() => {});
      } catch (e) {}
    }, 1500);
  }

  // 把「当前筛选范围」计数推给本地菜单栏桥（localhost:8765）。失败静默，绝不影响审核。
  let _menubarPushTimer = null;
  let _menubarLastStats = null; // 最后一次推送的 stats，用于 keep-alive
  function pushMenubarStats(counts) {
    clearTimeout(_menubarPushTimer);
    _menubarLastStats = counts;
    _menubarPushTimer = setTimeout(() => {
      try {
        fetch('http://127.0.0.1:8765/stats', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' }, // text/plain 免 CORS 预检
          body: JSON.stringify(counts),
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    }, 300); // 去抖，避免频繁渲染刷爆
  }
  // keep-alive：每 30 秒重推最后已知 stats，防止菜单栏显示「已过期」
  let _menubarKeepAliveTimer = null;
  function startMenubarKeepAlive() {
    if (_menubarKeepAliveTimer) {return;}
    _menubarKeepAliveTimer = setInterval(() => {
      if (!_menubarLastStats) {return;}
      try {
        fetch('http://127.0.0.1:8765/stats', {
          method: 'POST',
          headers: { 'Content-Type': 'text/plain' },
          body: JSON.stringify(_menubarLastStats),
          keepalive: true
        }).catch(() => {});
      } catch (e) {}
    }, 30000);
  }

  // 推导「当前筛选范围」的可读名称：全部 / 某工作组全部 / 某工作组选N台 / 具体仪器名
  function describeWSScope() {
    if (!wsActiveWG && !wsActiveMachine) {
      const anyMulti = Object.values(wsSelectedMachinesByWG || {}).some(s => s && s.length);
      return anyMulti ? '多工作组(自定义)' : '全部仪器';
    }
    const wgName = wsActiveWG ? (WG.find(w => String(w.dr) === String(wsActiveWG)) || {}).name || wsActiveWG : '';
    const sel = wsActiveWG ? [...wsMachineFilterSetForActiveWG()] : wsActiveMachine ? [wsActiveMachine] : [];
    if (!sel.length) {return wgName ? `${wgName}(全部仪器)` : '全部仪器';}
    if (sel.length === 1) {
      const m = wsMachines.find(x => String(x.RowID) === String(sel[0]));
      const mn = (m && (m.CName || m.Name)) || sel[0];
      return wgName ? `${wgName} · ${mn}` : mn;
    }
    return wgName ? `${wgName}(${sel.length}台)` : `${sel.length}台仪器`;
  }

  let _catBarBuilt = false; // 分类标签栏是否已构建 DOM

  // --- 渲染：分类标签栏 ---
  function renderWSCategoryBar() {
    const bar = $('.ws-cat-hd-inline') || $('.ws-cat-row-inline') || $('#lis-ws-bar');
    if (!bar) {return;}
    bar.style.flexShrink = '0';

    // 统计各分类数量（基于当前工作组+仪器过滤）
    let filtered = wsData;
    if (wsActiveWG || wsActiveMachine || WG.some(w => getWSSelectedMachineSet(w.dr).size > 0))
    {filtered = filtered.filter(rowPassWSMachineFilter);}

    let normalCount = 0,
      abnormalCount = 0,
      incompleteCount = 0,
      pendingCount = 0;
    filtered.forEach(r => {
      const bucket = getWSAuditBucket(r);
      if (bucket === 'normal') {normalCount++;}
      else if (bucket === 'abnormal') {abnormalCount++;}
      else if (bucket === 'incomplete') {incompleteCount++;}
      else if (bucket === 'pending') {pendingCount++;}
    });
    const totalCount = filtered.length;
    const fd = filteredData();

    // 首次或切换分类时重建 DOM，其余只更新计数和状态
    if (!_catBarBuilt) {
      _catBarBuilt = true;
      _buildCategoryBarDOM(bar);
    }
    _updateCategoryBarState(bar, normalCount, abnormalCount, incompleteCount, pendingCount, totalCount, fd);

    updateWSFooter({
      visible: fd.length,
      total: totalCount,
      normal: normalCount,
      abnormal: abnormalCount,
      incomplete: incompleteCount,
      pending: pendingCount
    });

    // 推菜单栏（当前筛选范围合计）
    pushMenubarStats({
      scope: describeWSScope(),
      url: location.href,
      normalReady: normalCount,
      abnormalReady: abnormalCount,
      auditReady: normalCount + abnormalCount,
      pending: pendingCount,
      incomplete: incompleteCount,
      total: totalCount
    });
  }

  function _buildCategoryBarDOM(bar) {
    let h = '';

    // 左侧：一键批审按钮
    h += '<button class="nb-btn" id="lis-ws-batch" style="padding:4px 12px;font-size:11px;margin-right:6px;display:none" title="F4 打开确认 · 再按 F4 确认批审"></button>';

    h += '<button class="cat-tab cat-audit" data-cat="audit">\n            🔍待审 <span class="cat-cnt">0</span>\n        </button>';
    h += '<button class="cat-tab cat-incomplete" data-cat="incomplete">\n            📋不完整 <span class="cat-cnt">0</span>\n        </button>';
    h += '<button class="cat-tab cat-pending" data-cat="pending">\n            📝待排 <span class="cat-cnt">0</span>\n        </button>';
    h += '<button class="cat-tab" data-cat="all">\n            📃全部 <span class="cat-cnt">0</span>\n        </button>';

    // 右侧：统计信息
    h += '<div class="cat-right"><span class="cat-stats cat-hint"></span><span class="cat-stats cat-counts"></span></div>';

    bar.innerHTML = h;

    // 分类标签事件
    bar.querySelectorAll('.cat-tab').forEach(b =>
      b.addEventListener('click', () => {
        switchWSCategory(b.dataset.cat);
      })
    );

    // 一键批审按钮事件
    const batchBtn = document.getElementById('lis-ws-batch');
    if (batchBtn) {
      batchBtn.onclick = ev => {
        ev.stopPropagation();
        dbg('一键批审按钮被点击');
        openWorkbenchBatchAudit();
      };
    }
  }

  function _updateCategoryBarState(bar, normalCount, abnormalCount, incompleteCount, pendingCount, totalCount, fd) {
    // 更新计数（不重建 DOM）
    const cntMap = { audit: normalCount + abnormalCount, incomplete: incompleteCount, pending: pendingCount, all: totalCount };
    bar.querySelectorAll('.cat-tab').forEach(b => {
      const cat = b.dataset.cat;
      b.classList.toggle('on', cat === wsCategory);
      const cnt = b.querySelector('.cat-cnt');
      if (cnt) {cnt.textContent = cntMap[cat] || 0;}
    });

    // 更新一键批审按钮显隐
    const batchBtn = document.getElementById('lis-ws-batch');
    if (batchBtn) {
      if (wsCategory === 'audit' && normalCount > 0) {
        batchBtn.style.display = '';
        batchBtn.textContent = `⚡ 批审正常 ${normalCount} · F4`;
      } else {
        batchBtn.style.display = 'none';
      }
    }

    // 更新右侧提示文字
    const hint = bar.querySelector('.cat-hint');
    if (hint) {
      if (wsCategory === 'audit') {
        if (normalCount > 0 && abnormalCount > 0) {
          hint.innerHTML = '<kbd>Enter</kbd> 逐条审核 · <kbd>F4</kbd> 批审正常 · <kbd>↑↓</kbd> 移动';
        } else if (normalCount > 0) {
          hint.innerHTML = '<kbd>F4</kbd> 一键批审 · 再按确认';
        } else if (abnormalCount > 0) {
          hint.innerHTML = '<kbd>Enter</kbd> 审核 <kbd>↑↓</kbd> 移动';
        } else {
          hint.textContent = '';
        }
      } else {
        hint.textContent = '';
      }
    }
    const counts = bar.querySelector('.cat-counts');
    if (counts) {counts.textContent = `${fd.length} / ${totalCount} 条`;}
  }

  // 工作台「正常可审」一键批审入口（按钮 / F4 共用）
  // 有勾选则只审勾选中的正常标本，否则审当前筛选下全部正常可审
  function openWorkbenchBatchAudit() {
    try {
      if (_auditInProgress || _abnormalAuditInProgress || _detailAuditInProgress) {
        showToast('正在审核中，请稍候', 'warning');
        return false;
      }
      // 批审确认框已打开时不重复弹出（由 F4 走确认）
      const existing = document.getElementById('lis-audit-confirm');
      if (existing && existing.classList.contains('show')) {return false;}

      let currentFiltered = wsData;
      if (wsActiveWG || wsActiveMachine || WG.some(w => getWSSelectedMachineSet(w.dr).size > 0))
      {currentFiltered = currentFiltered.filter(rowPassWSMachineFilter);}

      let sourceData;
      if (wsChecked.size > 0) {
        sourceData = currentFiltered.filter(r => wsChecked.has(r.ReportDR));
      } else {
        sourceData = currentFiltered;
      }
      const normalData = sourceData
        .filter(r => {
          const status = String(r.Status || r.ReportStatus || '');
          if (status === '3' || status === '4') {return false;}
          const complete = String(r.IsComplete || '');
          if (complete !== '1') {return false;}
          const cached = wsClassifiedCache[r.ReportDR];
          return cached && cached.status === 'NORMAL' && !isClassificationStale(r);
        })
        .map(r => {
          const cached = wsClassifiedCache[r.ReportDR];
          return {
            status: 'NORMAL',
            items: (cached && cached.items) || [],
            row: r,
            reportDR: r.ReportDR
          };
        });
      if (normalData.length === 0) {
        if (wsClassifying) {
          showToast('标本正在分类中，请稍候再试', 'warning');
        } else if (wsChecked.size > 0) {
          showToast('勾选中没有可审核的正常标本', 'warning');
        } else {
          showToast('没有可审核的正常标本', 'warning');
        }
        return false;
      }
      // 分类未完成时只含已识别 NORMAL，避免用户以为是「全部正常」
      if (wsClassifying) {
        showToast(`分类仍在进行，本次仅批审已识别的 ${normalData.length} 个正常标本`, 'warning');
      }
      dbg('一键批审:', normalData.length, '个标本');
      confirmAndBatchAudit(normalData);
      return true;
    } catch (e) {
      dbg('一键批审错误:', e);
      showToast('批审出错: ' + e.message, 'error');
      return false;
    }
  }

  // --- 渲染：数据表 ---
  // --- 渲染：数据表（分发到各分类视图）---
  let _abnormalKeyHandler = null; // 异常视图键盘监听器
  let _abnormalKeyTargets = [];
  let _abnormalGridHijackHandler = null;
  let _abnormalEnterLastAt = 0;

  function isDetailPanelVisible() {
    return !!(detailPanel && detailPanel.classList.contains('show'));
  }

  function updateAbnormalEnterBridge() {
    const active = wsCategory === 'audit' && isWSVisible() && !isDetailPanelVisible();
    try {
      window.__lisAbnormalEnterActive = active;
      window.__lisAbnormalEnterToken = active
        ? Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 12)
        : '';
    } catch (e) {}
  }

  function isTrustedAbnormalEnterMessage(e) {
    if (!e || !e.data || e.data.type !== 'lis-enhancer-abnormal-enter') {return false;}
    const reportWin = getReportIframeWin();
    if (!reportWin || e.source !== reportWin) {return false;}
    if (e.origin !== window.location.origin) {return false;}
    const token = window.__lisAbnormalEnterToken;
    return !!(token && e.data.token === token);
  }

  function releaseNativeReportFocus(iframeWin) {
    iframeWin = iframeWin || getReportIframeWin();
    if (!iframeWin) {return;}
    try {
      if (typeof iframeWin.__lisEnhancerReleaseReportFocus === 'function') {
        iframeWin.__lisEnhancerReleaseReportFocus();
        return;
      }
    } catch (e) {}
    const jq = iframeWin.jQuery || iframeWin.$;
    if (!jq) {return;}
    try {
      jq('.datagrid-editable-input').blur();
      jq('#dgLeftReportItem, #dgRightReportItem').each(function () {
        const grid = jq(this);
        if (!grid.length || !grid.datagrid) {return;}
        try {
          grid.datagrid('endEdit');
        } catch (e) {}
        try {
          grid.datagrid('clearSelections');
        } catch (e) {}
        try {
          const panel = grid.datagrid('getPanel').panel('panel');
          if (panel && panel[0] && panel[0].blur) {panel[0].blur();}
        } catch (e) {}
      });
    } catch (e) {}
    try {
      if (iframeWin.editIndex !== undefined) {iframeWin.editIndex = undefined;}
      if (iframeWin.editDatagrid !== undefined) {iframeWin.editDatagrid = undefined;}
    } catch (e) {}
    try {
      const ae = iframeWin.document.activeElement;
      if (ae && ae !== iframeWin.document.body && typeof ae.blur === 'function') {ae.blur();}
    } catch (e) {}
  }

  function triggerAbnormalEnterAudit() {
    updateAbnormalEnterBridge();
    if (wsCategory !== 'audit' || !isWSVisible() || isDetailPanelVisible()) {return false;}
    const now = Date.now();
    if (now - _abnormalEnterLastAt < 250) {return true;}
    _abnormalEnterLastAt = now;
    if (_abnormalAuditInProgress) {
      if (!_abnormalAuditQueued) {
        _abnormalAuditQueued = true;
        const ft = document.getElementById('lis-ws-ft-stat');
        if (ft) {ft.textContent = '⏳ 当前条审完后自动审下一条（已排队）';}
        showToast('下一条已排队，当前条完成后自动继续', 'info');
      }
      return true;
    }
    const curData = filteredData();
    if (!curData.length) {return false;}
    if (wsAbnormalIndex < 0 || wsAbnormalIndex >= curData.length) {wsAbnormalIndex = 0;}
    const sp = getAbnormalFocusSpecimen(curData);
    if (!sp) {return false;}
    markAbnormalAuditUI(sp, 'start');
    void auditAbnormalSpecimen(sp);
    return true;
  }

  function handleAbnormalEnterAudit(e) {
    if (wsCategory !== 'audit' || isDetailPanelVisible()) {return false;}
    if (!e || e.key !== 'Enter' || e.shiftKey) {return false;}
    if (shouldIgnoreAbnormalKeyEvent(e)) {return false;}
    e.preventDefault();
    e.stopImmediatePropagation();
    return triggerAbnormalEnterAudit() || true;
  }

  function installPageContextAbnormalEnterHijack(iframeWin) {
    iframeWin = iframeWin || getReportIframeWin();
    if (!iframeWin) {return;}
    try {
      if (iframeWin.__lisPageEnterHijack) {return;}
      const doc = iframeWin.document;
      const s = doc.createElement('script');
      s.setAttribute('data-lis-enhancer', 'abnormal-enter');
      s.textContent = `(function(){
var KEY='__lisEnhancerAbnormalEnter';
if(window[KEY])return;
window[KEY]=true;
window.__lisEnhancerReleaseReportFocus=function(){
  try{
    var jq=window.jQuery||window.$;
    if(jq){
      jq('.datagrid-editable-input').blur();
      jq('#dgLeftReportItem,#dgRightReportItem').each(function(){
        try{jq(this).datagrid('endEdit');jq(this).datagrid('clearSelections');}catch(e){}
      });
    }
    if(typeof editIndex!=='undefined')editIndex=undefined;
    if(typeof editDatagrid!=='undefined')editDatagrid=undefined;
    var ae=document.activeElement;
    if(ae&&ae!==document.body&&ae.blur)ae.blur();
  }catch(e){}
};
window.addEventListener('keydown',function(e){
  if(e.key!=='Enter'||e.shiftKey)return;
  var active=false;
  var active=false,token='',origin='';
  try{
    active=!!(window.parent&&window.parent.__lisAbnormalEnterActive);
    token=String(window.parent.__lisAbnormalEnterToken||'');
    origin=window.parent.location.origin;
  }catch(err){}
  if(!active||!token)return;
  try{window.parent.postMessage({type:'lis-enhancer-abnormal-enter',token:token},origin);}catch(err){}
  e.preventDefault();
  e.stopImmediatePropagation();
},true);
})();`;
      (doc.head || doc.documentElement).appendChild(s);
      s.remove();
      iframeWin.__lisPageEnterHijack = true;
      dbg('报告页页面上下文 Enter 劫持已注入');
    } catch (e) {
      dbg('注入报告页 Enter 劫持失败:', e.message);
    }
  }

  function installAbnormalResultGridEnterHijack(iframeWin) {
    installPageContextAbnormalEnterHijack(iframeWin);
    iframeWin = iframeWin || getReportIframeWin();
    if (!iframeWin) {return;}
    const jq = iframeWin.jQuery || iframeWin.$;
    if (!jq) {return;}
    if (!_abnormalGridHijackHandler) {
      _abnormalGridHijackHandler = e => {
        handleAbnormalEnterAudit(e);
      };
    }
    ['#dgLeftReportItem', '#dgRightReportItem'].forEach(sel => {
      try {
        const grid = jq(sel);
        if (!grid.length || !grid.datagrid) {return;}
        const panel = grid.datagrid('getPanel').panel('panel')[0];
        if (!panel) {return;}
        if (panel.__lisAbnormalEnterHandler) {
          panel.removeEventListener('keydown', panel.__lisAbnormalEnterHandler, true);
        }
        panel.__lisAbnormalEnterHandler = _abnormalGridHijackHandler;
        panel.addEventListener('keydown', _abnormalGridHijackHandler, true);
      } catch (e) {}
    });
  }

  // 批审确认框打开时：F4 / Enter = 点「确认审核」（单条正常时省鼠标）
  function tryConfirmBatchDialogByHotkey(e) {
    const dialog = document.getElementById('lis-audit-confirm');
    if (!dialog || !dialog.classList.contains('show')) {return false;}
    if (!e || (e.key !== 'F4' && !(e.key === 'Enter' && !e.shiftKey))) {return false;}
    // 确认框内勾选「我确认…」时 Enter 留给勾选框，F4 仍触发确认
    if (e.key === 'Enter') {
      const t = e.target;
      if (t && (t.id === 'lis-ab-check' || (t.tagName === 'INPUT' && t.type === 'checkbox'))) {return false;}
    }
    const btn = document.getElementById('lis-ab-confirm');
    if (!btn) {return false;}
    // F4：自动勾选「我确认…」（若有）后确认
    if (e.key === 'F4') {
      const checkBtn = document.getElementById('lis-ab-check');
      if (checkBtn && !checkBtn.checked) {
        checkBtn.checked = true;
        btn.disabled = false;
      }
    }
    if (btn.disabled) {return false;}
    e.preventDefault();
    e.stopImmediatePropagation();
    btn.click();
    return true;
  }

  // F4 统一入口优先级：
  // 1) 批审确认框 → 确认批审
  // 2) 详情面板 → 审当前条
  // 3) 异常待审列表 → 审焦点条
  // 4) 正常可审列表 → 弹出一键批审确认（再按一次 F4 确认）
  function triggerF4Audit() {
    // 批审确认对话框（含一键批审详细信息页）
    const dialog = document.getElementById('lis-audit-confirm');
    if (dialog && dialog.classList.contains('show')) {
      const btn = document.getElementById('lis-ab-confirm');
      const checkBtn = document.getElementById('lis-ab-check');
      // 需勾选的确认框：F4 自动勾选并确认
      if (checkBtn && !checkBtn.checked) {
        checkBtn.checked = true;
        if (btn) {btn.disabled = false;}
      }
      if (btn && !btn.disabled) {
        btn.click();
        return;
      }
      // 确认框已打开则不再落到其它 F4 语义
      return;
    }
    if (isWSVisible() && wsCategory === 'audit') {
      openWorkbenchBatchAudit();
      return;
    }
    return;
  }

  // 常驻 Enter 桥：挂到报告页 iframe，不被 openDetailPanel 的 _removeAbnormalKeyHandler 影响。
  // 详情面板打开时异常视图处理器会被移除，故 Enter 在面板内（焦点常在原生 iframe）必须由本桥捕获。
  let _f4BridgeHandler = null;
  const _f4BridgeTargets = [];
  let _f4BridgeTimer = null;
  function _installF4Bridge() {
    if (_f4BridgeHandler) {
      _attachF4BridgeToIframe();
      return;
    }
    _f4BridgeHandler = e => {
      // 批审确认框：任意分类下 F4/Enter 均可确认
      if (tryConfirmBatchDialogByHotkey(e)) {return;}
      if (shouldIgnoreAbnormalKeyEvent(e)) {return;}
      // 详情面板打开时：Enter 审当前详情（焦点常在原生 iframe，Enter 必须靠桥捕获）；
      // F4 在详情面板内已取消（8.5.1），只保留 Enter + 面板「审核」按钮
      if (isDetailPanelVisible() && currentDetailSpecimen) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.stopImmediatePropagation();
          void _auditFromDetailPanel();
        }
        return;
      }
      if (e.key !== 'F4') {return;}
      // 待审列表：F4 打开一键批审确认（再按 F4 确认）
      if (isWSVisible() && wsCategory === 'audit') {
        e.preventDefault();
        e.stopImmediatePropagation();
        triggerF4Audit();
        return;
      }
      return;
    };
    document.addEventListener('keydown', _f4BridgeHandler, true);
    _f4BridgeTargets.push(document);
    _attachF4BridgeToIframe();
    // 定时巡检：报告 iframe 重载/重开后 document 会换新，桥必须跟上，否则 F4 静默失效；
    // 同时清掉已 detached 的旧目标，避免 _f4BridgeTargets 只增不减挂住旧 document
    if (!_f4BridgeTimer) {
      _f4BridgeTimer = setInterval(() => {
        try {
          _pruneF4BridgeTargets();
          _attachF4BridgeToIframe();
        } catch (e) {}
      }, 2000);
    }
  }
  function _pruneF4BridgeTargets() {
    for (let i = _f4BridgeTargets.length - 1; i >= 0; i--) {
      const t = _f4BridgeTargets[i];
      if (t === document || t === window) {continue;} // 主页面常驻，不清理
      try {
        const d = t.nodeType === 9 ? t : t.document; // document 或 iframe window
        if (!d || !d.documentElement || !d.defaultView) {
          try {t.removeEventListener('keydown', _f4BridgeHandler, true);} catch (e) {}
          _f4BridgeTargets.splice(i, 1);
        }
      } catch (e) {
        _f4BridgeTargets.splice(i, 1);
      }
    }
  }
  function _attachF4BridgeToIframe() {
    if (!_f4BridgeHandler) {return;}
    const iframeWin = getReportIframeWin();
    if (!iframeWin || !iframeWin.document || iframeWin.document === document) {return;}
    if (!_f4BridgeTargets.includes(iframeWin.document)) {
      try {
        iframeWin.document.addEventListener('keydown', _f4BridgeHandler, true);
        _f4BridgeTargets.push(iframeWin.document);
      } catch (e) {}
    }
    if (!_f4BridgeTargets.includes(iframeWin)) {
      try {
        iframeWin.addEventListener('keydown', _f4BridgeHandler, true);
        _f4BridgeTargets.push(iframeWin);
      } catch (e) {}
    }
  }
  function _removeF4BridgeHandler() {
    if (!_f4BridgeHandler) {return;}
    if (_f4BridgeTimer) {
      clearInterval(_f4BridgeTimer);
      _f4BridgeTimer = null;
    }
    for (const target of _f4BridgeTargets) {
      try {
        target.removeEventListener('keydown', _f4BridgeHandler, true);
      } catch (e) {}
    }
    _f4BridgeTargets.length = 0;
    _f4BridgeHandler = null;
  }

  function _attachAbnormalKeyToIframe() {
    if (!_abnormalKeyHandler) {return;}
    const iframeWin = getReportIframeWin();
    if (!iframeWin || !iframeWin.document || iframeWin.document === document) {return;}
    if (_abnormalKeyTargets.includes(iframeWin.document)) {return;}
    try {
      iframeWin.document.addEventListener('keydown', _abnormalKeyHandler, true);
      _abnormalKeyTargets.push(iframeWin.document);
    } catch (e) {}
    try {
      if (!_abnormalKeyTargets.includes(iframeWin)) {
        iframeWin.addEventListener('keydown', _abnormalKeyHandler, true);
        _abnormalKeyTargets.push(iframeWin);
      }
    } catch (e) {}
    installAbnormalResultGridEnterHijack(iframeWin);
    _attachF4BridgeToIframe();
  }

  function syncAbnormalFocusFromDOM() {
    const card = getUIDoc().querySelector('.ws-abnormal-card.focused');
    if (!card) {return;}
    _abnormalFocusDR = String(card.dataset.rdr || '');
    const data = filteredData();
    const idx = data.findIndex(r => String(r.ReportDR) === _abnormalFocusDR);
    if (idx >= 0) {wsAbnormalIndex = idx;}
  }

  function refocusAbnormalWorkbench() {
    releaseNativeReportFocus();
    try {
      getUIWindow().focus();
    } catch (e) {}
    const uiDoc = getUIDoc();
    const card = uiDoc.querySelector('.ws-abnormal-card.focused');
    if (card) {
      if (!card.hasAttribute('tabindex')) {card.setAttribute('tabindex', '-1');}
      try {
        card.focus({ preventScroll: true });
      } catch (e) {
        try {
          card.focus();
        } catch (e2) {}
      }
      syncAbnormalFocusFromDOM();
      return;
    }
    const wsEl = uiDoc.getElementById('lis-ws');
    if (wsEl) {
      if (!wsEl.hasAttribute('tabindex')) {wsEl.setAttribute('tabindex', '-1');}
      try {
        wsEl.focus({ preventScroll: true });
      } catch (e) {
        try {
          wsEl.focus();
        } catch (e2) {}
      }
    }
    syncAbnormalFocusFromDOM();
  }

  function scheduleAbnormalFocusRecovery() {
    updateAbnormalEnterBridge();
    releaseNativeReportFocus();
    refocusAbnormalWorkbench();
    installAbnormalResultGridEnterHijack();
    [80, 200, 450, 900, 1800].forEach(ms => {
      setTimeout(() => {
        if (wsCategory !== 'audit' || _abnormalAuditInProgress) {return;}
        updateAbnormalEnterBridge();
        releaseNativeReportFocus();
        refocusAbnormalWorkbench();
        installAbnormalResultGridEnterHijack();
      }, ms);
    });
  }

  function _rebindAbnormalKeyHandler() {
    if (_abnormalKeyHandler) {
      _attachAbnormalKeyToIframe();
      return;
    }
    _abnormalKeyHandler = e => {
      if (shouldIgnoreAbnormalKeyEvent(e)) {return;}
      if (wsCategory !== 'audit') {return;}
      // F4：无论面板是否打开都处理（待审视图处理器已挂到 iframe，可捕获原生页焦点下的按键）
      // 面板打开时用 currentDetailSpecimen 调面板同款审核；面板未开时用列表焦点标本。
      if (e.key === 'F4') {
        e.preventDefault();
        e.stopImmediatePropagation();
        if (isDetailPanelVisible()) {return;} // 详情面板内 F4 已取消（8.5.1），防重装后误触发
        triggerF4Audit();
        return;
      }
      if (isDetailPanelVisible()) {return;}
      if (_abnormalAuditInProgress && e.key === 'Enter') {
        handleAbnormalEnterAudit(e);
        return;
      }
      if (e.defaultPrevented) {return;}
      const curData = filteredData();
      if (!curData.length) {return;}
      if (wsAbnormalIndex < 0 || wsAbnormalIndex >= curData.length) {wsAbnormalIndex = 0;}
      if (e.key === 'ArrowDown' || e.key === 'j') {
        e.preventDefault();
        moveAbnormalFocus(1, curData);
      } else if (e.key === 'ArrowUp' || e.key === 'k') {
        e.preventDefault();
        moveAbnormalFocus(-1, curData);
      } else if (e.key === 'Enter' && !e.shiftKey) {
        handleAbnormalEnterAudit(e);
      } else if (e.key === 'Enter' && e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        const sp = getAbnormalFocusSpecimen(curData);
        if (sp) {openDetailPanel(sp, 'abnormal', wsAbnormalIndex);}
      } else if (e.key === 'Escape') {
        // 待审视图 Esc = 关闭工作台（与其它查看视图一致）
        e.preventDefault();
        closeWS();
      }
    };
    _abnormalKeyTargets = [document];
    try {
      document.addEventListener('keydown', _abnormalKeyHandler, true);
    } catch (e) {}
    try {
      window.addEventListener('keydown', _abnormalKeyHandler, true);
      _abnormalKeyTargets.push(window);
    } catch (e) {}
    _attachAbnormalKeyToIframe();
  }

  function _removeAbnormalKeyHandler() {
    if (!_abnormalKeyHandler) {return;}
    (_abnormalKeyTargets.length ? _abnormalKeyTargets : [document]).forEach(doc => {
      try {
        doc.removeEventListener('keydown', _abnormalKeyHandler, true);
      } catch (e) {}
    });
    _abnormalKeyTargets = [];
    _abnormalKeyHandler = null;
  }

  function renderWSTable() {
    const body = $('#lis-ws-body');
    if (!body) {return;}
    // 强制 flex 和滚动（LIS 系统 CSS 会覆盖）
    body.style.cssText = 'flex:1!important;overflow:auto!important;min-height:0!important;position:relative';
    // 移除旧的异常视图键盘监听
    _removeAbnormalKeyHandler();
    if (_normalKeyHandler) {
      document.removeEventListener('keydown', _normalKeyHandler);
      _normalKeyHandler = null;
    }
    // 移除旧视图的 click/change/delegate handler，防止切换分类时累积
    if (body._delegatedHandler) {
      body.removeEventListener('click', body._delegatedHandler.click);
      body.removeEventListener('change', body._delegatedHandler.change);
      body.removeEventListener('dblclick', body._delegatedHandler.dblclick);
      body._delegatedHandler = null;
    }
    if (body._abnormalClickHandler) {
      body.removeEventListener('click', body._abnormalClickHandler);
      body._abnormalClickHandler = null;
    }
    if (body._incompleteClickHandler) {
      body.removeEventListener('click', body._incompleteClickHandler);
      body._incompleteClickHandler = null;
    }

    const data = filteredData();
    if (data.length === 0) {
      body.innerHTML = '<div class="ws-empty"><div class="ico">📭</div>暂无标本数据</div>';
      return;
    }

    switch (wsCategory) {
    case 'audit':
      renderAuditView(data, body);
      break;
    case 'incomplete':
      renderIncompleteView(data, body);
      break;
    default:
      renderAllView(data, body);
      break;
    }

    // 安全网：待审视图下确保键盘 handler 存在
    // 详情面板打开时不要重绑列表 handler，避免与详情 F4/Enter 双重触发
    if (wsCategory === 'audit' && !isDetailPanelVisible()) {
      if (!_abnormalKeyHandler) {_rebindAbnormalKeyHandler();}
    }
    // 其余查看视图：Escape 关闭工作台（详情打开时 Esc 由详情 handler 负责）
    if (wsCategory !== 'audit' && !isDetailPanelVisible()) {
      _normalKeyHandler = e => {
        if (isPatientResultPanelEvent(e)) {return;}
        if (e.key === 'Escape') {
          e.preventDefault();
          closeWS();
        }
      };
      document.addEventListener('keydown', _normalKeyHandler);
    }
  }

  function updateWSFooter(counts) {
    const ft = document.getElementById('lis-ws-ft-stat');
    if (!ft) {return;}
    if (!counts) {
      counts = { visible: filteredData().length, total: wsData.length };
    }
    const groupName = wsActiveWG ? (WG_MAP[wsActiveWG] || {}).name || wsActiveWG : '全部工作组';
    let machineName = '全部仪器';
    if (wsActiveWG) {
      const selectedMachines = getWSSelectedMachineSet(wsActiveWG);
      if (selectedMachines.size > 0) {
        const names = wsMachines
          .filter(m => m._wg === wsActiveWG && selectedMachines.has(String(m.RowID)))
          .map(m => m.CName || m.Name || m.RowID)
          .filter(Boolean);
        machineName = names.length <= 2 ? names.join('、') : `已选${selectedMachines.size}台仪器`;
      }
    } else {
      // 全部工作组：汇总各组选中的仪器
      const allSel = [];
      WG.forEach(w => {
        const s = getWSSelectedMachineSet(w.dr);
        if (s.size) {allSel.push({ wg: w.name, n: s.size });}
      });
      if (allSel.length) {
        machineName = allSel.map(s => `${s.wg}${s.n}台`).join('、');
      } else if (wsActiveMachine) {
        machineName = (wsMachines.find(m => String(m.RowID) === String(wsActiveMachine)) || {}).CName || '当前仪器';
      }
    }
    const parts = [`${groupName}`, `${machineName}`, `${counts.visible}/${counts.total || 0}条`];
    if (typeof counts.normal === 'number') {parts.push(`正常${counts.normal}`);}
    if (typeof counts.abnormal === 'number') {parts.push(`异常${counts.abnormal}`);}
    if (wsLoading) {parts.push('刷新中');}
    ft.textContent = parts.join(' · ');
  }

  // --- 正常可审视图已并入 renderAuditView（待审）---
  function getAbnormalFocusSpecimen(data) {
    data = data || filteredData();
    if (!data.length) {return null;}
    const focused = document.querySelector('.ws-abnormal-card.focused');
    const focusDR = (focused && focused.dataset.rdr) || _abnormalFocusDR;
    if (focusDR) {
      const sp = findWSSpecimenByReportDR(focusDR);
      if (sp) {
        const idx = data.findIndex(r => String(r.ReportDR) === String(sp.ReportDR));
        if (idx >= 0) {wsAbnormalIndex = idx;}
        return sp;
      }
    }
    if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) {wsAbnormalIndex = 0;}
    return data[wsAbnormalIndex] || null;
  }

  // --- 待审视图（融合正常 + 异常，单队列审核）---
  function renderAuditView(data, body) {
    if (_abnormalFocusDR) {
      const idx = data.findIndex(r => String(r.ReportDR) === String(_abnormalFocusDR));
      wsAbnormalIndex = idx >= 0 ? idx : data.length ? 0 : -1;
    } else if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) {
      wsAbnormalIndex = data.length ? 0 : -1;
    }

    // 分类汇总（基于当前视图数据）
    let nNormal = 0,
      nAbnormal = 0,
      nCritical = 0;
    data.forEach(r => {
      const b = getWSAuditBucket(r);
      if (b === 'normal') {nNormal++;}
      else {
        const cached = wsClassifiedCache[r.ReportDR];
        if (cached && cached.status === 'CRITICAL') {nCritical++;}
        else {nAbnormal++;}
      }
    });

    let h = `<div class="ws-audit-banner">
            <span class="ws-audit-summary">
                ✅ 正常 <b>${nNormal}</b>
                <span class="ws-audit-sep">·</span>
                ⚠️ 异常 <b>${nAbnormal}</b>
                ${nCritical ? `<span class="ws-audit-sep">·</span><span class="ws-audit-critical">🚨 危急 <b>${nCritical}</b></span>` : ''}
            </span>
            ${nNormal > 0 ? `<button class="nb-btn" id="lis-audit-batch" title="F4 打开确认 · 再按 F4 确认批审">⚡ 一键批审正常 ${nNormal} · F4</button>` : ''}
        </div>`;

    h += `<div class="ws-abnormal-hint">
            <kbd>Enter</kbd> 审核当前条 <kbd>F4</kbd> 批审正常 <kbd>↑↓</kbd> 切换 <kbd>点击</kbd> 详情 · 按仪器分组，审完一台再换下一台
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
      const bucket = getWSAuditBucket(r);
      if (bucket === 'normal') {
        // --- 正常行：信任分类结果，Enter 直接单条审核；F4 整批 ---
        const focused = i === wsAbnormalIndex ? ' focused' : '';
        h += `<div class="ws-abnormal-card is-normal${focused}" data-i="${i}" data-rdr="${escAttr(r.ReportDR || '')}">`;
        h += '<span class="ab-card-badge ok">✅</span>';
        h += `<span class="ab-card-name">${highlightText(r.PatName || '', wsSearchQuery)}</span>`;
        h += `<span class="ab-card-no">${highlightText(r.Labno || '', wsSearchQuery)}</span>`;
        h += `<span class="ab-card-test">${highlightText(r.TestSetDesc || '', wsSearchQuery)}</span>`;
        h += `<span class="ab-card-time">${esc(r.AcceptDT || '')}</span>`;
        h += '<span class="ab-card-hint">Enter=审核</span>';
        h += '</div>';
        return;
      }

      const items = cached ? cached.items : [];
      const abnormalItems = items.filter(it => it.status !== 'NORMAL');
      const hasCritical =
        (cached && cached.status === 'CRITICAL') || items.some(it => it.status === 'CRITICAL' || it.critical);
      const hasInfectionWarning = cached && cached.infectionWarning;
      const focused = i === wsAbnormalIndex ? ' focused' : '';

      h += `<div class="ws-abnormal-card${focused}${hasCritical ? ' has-critical' : ''}${hasInfectionWarning ? ' has-infection-warning' : ''}" data-i="${i}" data-rdr="${escAttr(r.ReportDR || '')}">`;
      h += hasCritical ? '<span class="ab-card-badge critical">🚨</span>' : '<span class="ab-card-badge warn">⚠️</span>';
      h += `<span class="ab-card-name">${highlightText(r.PatName || '', wsSearchQuery)}</span>`;
      h += `<span class="ab-card-no">${highlightText(r.Labno || '', wsSearchQuery)}</span>`;
      h += `<span class="ab-card-test">${highlightText(r._mn || '', wsSearchQuery)}</span>`;
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
                const name = (tds[0].textContent || '').trim();
                const result = (tds[1].textContent || '').trim();
                const status = (tds[3].textContent || '').trim();
                if (name && name !== '项目')
                {displayItems.push({
                  name,
                  result,
                  status: status.includes('高') ? 'HIGH' : status.includes('低') ? 'LOW' : 'ABNORMAL'
                });}
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
        if (st === 'CRITICAL') {cls = 'critical';}
        else if (st === 'HIGH') {cls = 'high';}
        else if (st === 'LOW') {cls = 'low';}
        else if (st === 'ABNORMAL') {cls = 'abnormal';}
        // x8 传染病面板：梅毒/丙肝/HIV 阳性统一高亮（区别于乙肝两对半）
        if (
          st === 'ABNORMAL' &&
          isX8InfectionPanel(r) &&
          isInfectionSpecialItem(it.name) &&
          isPositiveResult(it.result, it.preResult || it)
        ) {
          cls = 'inf-special';
        }
        const prefix = st === 'CRITICAL' ? '危急 ' : '';
        h += `<span class="ab-card-item ${cls}">${esc(prefix + it.name + ' ' + it.result + (it.unit || ''))}</span>`;
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
        h += '<span class="ab-card-hint" style="color:#c62828;font-weight:600">🚨 危急值</span>';
      } else if (hasInfectionWarning) {
        h += '<span class="ab-card-hint" style="color:#e65100;font-weight:600">⚠ 历史不一致</span>';
      } else {
        h += '<span class="ab-card-hint">Enter=审核</span>';
      }
      h += '</div>';
    });
    h += '</div>';
    body.innerHTML = h;

    // 横幅一键批审按钮（与顶栏 / F4 共用 openWorkbenchBatchAudit）
    const auditBatchBtn = document.getElementById('lis-audit-batch');
    if (auditBatchBtn) {
      auditBatchBtn.addEventListener('click', () => {
        openWorkbenchBatchAudit();
      });
    }

    // 卡片点击 → 更新聚焦 + 打开详情；空白处点击 → 收回详情
    // 移除旧委托，防止刷新累积多个处理器
    if (body._abnormalClickHandler) {
      body.removeEventListener('click', body._abnormalClickHandler);
    }
    body._abnormalClickHandler = e => {
      const card = e.target.closest('.ws-abnormal-card');
      if (!card) {
        // 点击空白处，收回详情面板
        if (isDetailPanelVisible()) {closeDetailPanel();}
        return;
      }
      const specimen = findWSSpecimenByReportDR(card.dataset.rdr);
      if (!specimen) {return;}
      _abnormalFocusDR = String(specimen.ReportDR || '');
      const cards = document.querySelectorAll('.ws-abnormal-card');
      cards.forEach(c => c.classList.remove('focused'));
      card.classList.add('focused');
      wsAbnormalIndex = Math.max(
        0,
        filteredData().findIndex(r => String(r.ReportDR) === String(specimen.ReportDR))
      );
      openDetailPanel(specimen, getWSAuditBucket(specimen) === 'normal' ? 'normal' : 'abnormal', wsAbnormalIndex);
    };
    body.addEventListener('click', body._abnormalClickHandler);

    // 键盘导航
    _rebindAbnormalKeyHandler();

    // 滚动到聚焦卡片
    _scrollAbnormalFocus();
    updateAbnormalEnterBridge();
    scheduleAbnormalAuditPrewarm();
    installAbnormalResultGridEnterHijack();
  }

  function moveAbnormalFocus(dir, data) {
    data = data || filteredData();
    if (!data.length) {return;}
    const cur = getAbnormalFocusSpecimen(data);
    let idx = cur ? data.findIndex(r => String(r.ReportDR) === String(cur.ReportDR)) : wsAbnormalIndex;
    if (idx < 0) {idx = 0;}
    idx = Math.max(0, Math.min(data.length - 1, idx + dir));
    wsAbnormalIndex = idx;
    _abnormalFocusDR = String(data[idx].ReportDR || '');
    document.querySelectorAll('.ws-abnormal-card').forEach(c => c.classList.remove('focused'));
    const card = [...document.querySelectorAll('.ws-abnormal-card')].find(
      c => String(c.dataset.rdr) === _abnormalFocusDR
    );
    if (card) {card.classList.add('focused');}
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
    if (!data.length || !cards.length) {return;}
    if (cards[wsAbnormalIndex]) {cards[wsAbnormalIndex].classList.remove('focused');}
    if (data.length === 1) {
      wsAbnormalIndex = 0;
    } else {
      wsAbnormalIndex = Math.min(Math.max(startIndex, 0), data.length - 1);
      wsAbnormalIndex = (wsAbnormalIndex + 1) % data.length;
    }
    if (cards[wsAbnormalIndex]) {cards[wsAbnormalIndex].classList.add('focused');}
    if (data[wsAbnormalIndex]) {_abnormalFocusDR = String(data[wsAbnormalIndex].ReportDR || '');}
    _scrollAbnormalFocus();
  }

  function nextPaint() {
    return new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }

  function clearAbnormalAuditingCard(reportDR) {
    const card = [...document.querySelectorAll('.ws-abnormal-card[data-rdr]')].find(
      c => String(c.dataset.rdr || '') === String(reportDR || '')
    );
    if (!card) {return;}
    card.classList.remove('auditing');
    card.removeAttribute('aria-busy');
    const hint = card.querySelector('.ab-card-hint');
    if (hint && hint.textContent === '正在审核...') {hint.textContent = 'Enter=审核';}
  }

  function auditTargetContext(iframeWin, reportDR) {
    if (!iframeWin || !reportDR) {
      return { rowPresent: false, detailReady: false, allowMissingSuccess: false };
    }
    const rowPresent = !!findNativeRowByReportDR(iframeWin, reportDR);
    const detailReady = isReportDetailLoaded(iframeWin, reportDR);
    // 详情已就绪即可认定「行消失=审核成功」；全部仪器列表里行可能找不到但详情仍有效
    return { rowPresent, detailReady, allowMissingSuccess: detailReady };
  }

  function verifyAuditSucceededByReportDR(iframeWin, reportDR) {
    if (!reportDR) {return false;}
    const latestWin = getReportIframeWin() || iframeWin;
    if (latestWin) {
      const found = findNativeRowByReportDR(latestWin, reportDR);
      if (found && isExpectedNativeStatus(found.row, ['3', '4'])) {return true;}
      try {
        const me = latestWin.me;
        if (me && String(me.curReportDR || '') === String(reportDR)) {
          const sel = me.selectedGrid ? me.selectedGrid.datagrid('getSelected') : null;
          if (sel && isExpectedNativeStatus(sel, ['3', '4'])) {return true;}
        }
      } catch (e) {}
    }
    const liveRow = wsData.find(r => String(r.ReportDR) === String(reportDR));
    if (liveRow && ['3', '4'].includes(String(liveRow.Status || liveRow.ReportStatus || ''))) {return true;}
    return false;
  }

  // CA 回调 ReportSave 后：状态回写前也能较快认成功的启发式
  function softAuditSuccessHint(iframeWin, reportDR) {
    if (!iframeWin || !reportDR) {return false;}
    if (verifyAuditSucceededByReportDR(iframeWin, reportDR)) {return true;}
    try {
      const me = iframeWin.me;
      if (!me) {return false;}
      // 已审核标志 + 焦点已离开本条（原生审后常自动下一条）
      if (me.IsAuthed === true && String(me.curReportDR || '') !== String(reportDR)) {
        const found = findNativeRowByReportDR(iframeWin, reportDR);
        if (!found) {return true;}
        if (isExpectedNativeStatus(found.row, ['3', '4'])) {return true;}
      }
      if (me.IsSaveSuccess === true && String(me.curReportDR || '') === String(reportDR)) {return true;}
    } catch (e) {}
    return false;
  }

  async function confirmAuditEventually(iframeWin, reportDR, patientName, options = {}) {
    const batchMode = !!options.batchMode;
    const ft = document.getElementById('lis-ws-ft-stat');
    const label = patientName || reportDR;
    const tick = msg => {
      if (typeof options.onTick === 'function') {options.onTick(msg);}
      else if (ft) {ft.textContent = msg;}
    };
    tick(`确认中：${label}`);
    // 先做几次快速校验，避免「其实已成功却干等满超时」
    for (let i = 0; i < (batchMode ? 6 : 2); i++) {
      if (options.abortCheck && options.abortCheck()) {return false;}
      if (verifyAuditSucceededByReportDR(iframeWin, reportDR) || softAuditSuccessHint(iframeWin, reportDR)) {return true;}
      await sleep(batchMode ? 80 : 200);
    }
    const ctx = auditTargetContext(iframeWin, reportDR);
    const targetWasPresent =
      options.targetWasPresent !== undefined ? !!options.targetWasPresent : ctx.rowPresent || ctx.detailReady;
    const detailWasReady = options.detailWasReady !== undefined ? !!options.detailWasReady : ctx.detailReady;
    const allowMissing = detailWasReady || !!options.afterCA;
    // 批审 afterCA 确认必须短：首条 CA 后 FuncStr 往往已审完，长等只会卡在姓名上
    const confirmTimeout = batchMode ? (options.afterCA ? BATCH_CONFIRM_MS.afterCA : BATCH_CONFIRM_MS.normal) : 10000;
    const confirmed = await waitNativeActionResult(iframeWin, reportDR, ['3'], confirmTimeout, allowMissing, {
      targetWasPresent: targetWasPresent,
      missingStableMs: batchMode ? (options.afterCA ? 200 : 280) : 900,
      turbo: true,
      abortCheck: options.abortCheck,
      quickVerify: () =>
        verifyAuditSucceededByReportDR(iframeWin, reportDR) || softAuditSuccessHint(iframeWin, reportDR),
      onTick: elapsed => {
        if (batchMode && elapsed > 1200) {tick(`确认中：${label}`);}
        else if (!batchMode) {tick(`确认结果中：${label}（${Math.round(elapsed / 1000)}s）`);}
      }
    });
    if (confirmed && confirmed !== 'incomplete') {return true;}
    await sleep(batchMode ? 80 : 800);
    if (verifyAuditSucceededByReportDR(iframeWin, reportDR) || softAuditSuccessHint(iframeWin, reportDR)) {return true;}
    const latestWin = getReportIframeWin() || iframeWin;
    const found = findNativeRowByReportDR(latestWin, reportDR);
    if (!found) {return allowMissing;}
    return isExpectedNativeStatus(found.row, ['3', '4']);
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
    if (!specimen) {return;}
    const targetDR = String(specimen.ReportDR || '');
    const ft = document.getElementById('lis-ws-ft-stat');
    const name = specimen.PatName || specimen.Labno || targetDR;
    const card = [...document.querySelectorAll('.ws-abnormal-card[data-rdr]')].find(c => c.dataset.rdr === targetDR);
    if (phase === 'start' && ft) {ft.textContent = `审核：准备 ${name}`;}
    if (card && phase === 'start') {
      card.classList.add('auditing');
      card.setAttribute('aria-busy', 'true');
      const hint = card.querySelector('.ab-card-hint');
      if (hint) {hint.textContent = '正在审核...';}
    }
  }

  function prefetchReportPageForWS() {
    const existing = getReportIframeWin();
    if (existing) {
      installNativeDetailGuard(existing);
      installAbnormalResultGridEnterHijack(existing);
      return Promise.resolve(existing);
    }
    if (!_reportPageLoadPromise) {
      _reportPageLoadPromise = ensureReportPageLoaded({ keepWS: true, fast: true })
        .then(w => {
          if (w) {
            installNativeDetailGuard(w);
            installAbnormalResultGridEnterHijack(w);
          }
          scheduleNativeDetailGuardInstall();
          return w;
        })
        .finally(() => {
          _reportPageLoadPromise = null;
        });
    }
    return _reportPageLoadPromise;
  }

  function prefetchAbnormalAuditContext() {
    if (wsCategory !== 'audit' || _abnormalAuditInProgress) {return;}
    scheduleAbnormalAuditPrewarm(0);
  }

  function scheduleAbnormalAuditPrewarm(delayMs) {
    if (wsCategory !== 'audit' || _abnormalAuditInProgress || !isWSVisible()) {return;}
    clearTimeout(_abnormalPrewarmTimer);
    const delay = typeof delayMs === 'number' ? delayMs : 0;
    _abnormalPrewarmTimer = setTimeout(() => {
      const data = filteredData();
      if (!data.length) {return;}
      if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) {wsAbnormalIndex = 0;}
      const sp = data[wsAbnormalIndex];
      prewarmAbnormalAuditNative(sp).catch(() => {});
    }, delay);
  }

  function isAbnormalSpecimenReady(reportDR) {
    const iframeWin = getReportIframeWin();
    return !!(iframeWin && reportDR && isReportDetailLoaded(iframeWin, reportDR));
  }

  async function prewarmAbnormalAuditNative(specimen) {
    if (!specimen || _abnormalAuditInProgress || _auditInProgress || !isWSVisible()) {return;}
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
      if (!iframeWin) {iframeWin = getReportIframeWin();}
      if (!iframeWin) {return;}
      installNativeDetailGuard(iframeWin);
      if (!canScriptSelectNativeRow(iframeWin, reportDR)) {
        dbg('预热跳过：用户正在原生列表查看其他标本');
        return;
      }
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
      if (!canScriptSelectNativeRow(iframeWin, reportDR)) {
        dbg('预热中止：刷新列表后用户已接管原生选择');
        return;
      }
      if (item.labno && typeof iframeWin.FindFast === 'function' && canScriptSelectNativeRow(iframeWin, reportDR)) {
        try {
          iframeWin.FindFast(item.labno);
          await sleep(60);
        } catch (e) {}
        iframeWin = getReportIframeWin() || iframeWin;
      }
      if (!selectNativeRowByReportDR(iframeWin, reportDR, { force: true })) {
        await waitAndSelectNativeRow(iframeWin, item, {
          timeoutMs: 2800,
          pollMs: 30,
          skipListRefresh: !!mdrKey,
          force: true
        });
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
      if (_abnormalPrewarmDR === reportDR) {_abnormalPrewarmPromise = null;}
    });
    return _abnormalPrewarmPromise;
  }

  async function awaitAbnormalPrewarm(specimen) {
    try {
      await prewarmAbnormalAuditNative(specimen);
    } catch (e) {}
  }

  function specimenToAuditItem(specimen) {
    return {
      reportDR: specimen.ReportDR,
      mdr: prWorkGroupMachineDR(specimen) || '',
      labno: specimen.Labno || ''
    };
  }

  function nativeMachineMatches(iframeWin, mdrKey) {
    if (!mdrKey || !iframeWin || !iframeWin.me) {return false;}
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
    const selOpts = ctx.forceSelect ? { force: true } : {};
    if (!mdrChanged && !nativeMismatch && selectNativeRowByReportDR(iframeWin, reportDR, selOpts)) {
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
      selected = selectNativeRowByReportDR(iframeWin, reportDR, selOpts);
    }
    if (!selected && !selectNativeRowByReportDR(iframeWin, reportDR, selOpts)) {
      const selResult = await waitAndSelectNativeRow(iframeWin, item, {
        timeoutMs: fast ? (listFresh ? 2200 : 3000) : listFresh ? 3500 : 5000,
        pollMs: fast ? 30 : 40,
        skipListRefresh: listFresh,
        force: !!ctx.forceSelect
      });
      if (!selResult.ok) {return { ok: false, reason: 'select', iframeWin: selResult.iframeWin || iframeWin };}
      iframeWin = selResult.iframeWin || iframeWin;
    }
    if (!isReportDetailLoaded(iframeWin, reportDR)) {
      const t1 = fast ? 3000 : 5000;
      const t2 = fast ? 1500 : 2500;
      let ready = await waitReportDetailReady(iframeWin, reportDR, t1, { fastBatch: true });
      if (!ready) {
        selectNativeRowByReportDR(iframeWin, reportDR, selOpts);
        ready = await waitReportDetailReady(iframeWin, reportDR, t2, { fastBatch: true });
      }
      if (!ready) {return { ok: false, reason: 'detail', iframeWin };}
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
    const escDR =
      typeof CSS !== 'undefined' && CSS.escape
        ? CSS.escape(String(reportDR || ''))
        : String(reportDR || '').replace(/"/g, '\\"');
    const card = document.querySelector(`.ws-abnormal-card[data-rdr="${escDR}"]`);
    const list = card && card.parentElement;
    if (card) {
      const prev = card.previousElementSibling;
      const next = card.nextElementSibling;
      card.remove();
      if (prev && prev.classList && prev.classList.contains('ws-abnormal-machine')) {
        const nextIsCard = next && next.classList && next.classList.contains('ws-abnormal-card');
        if (!nextIsCard) {prev.remove();}
      }
    }

    const newData = filteredData();
    if (newData.length === 0) {
      // 待审队列审空：保持待审视图，显示空态（不再自动切回正常分类）
      wsAbnormalIndex = -1;
      _abnormalFocusDR = '';
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
      _abnormalFocusDR = String(cards[wsAbnormalIndex].dataset.rdr || '');
      _scrollAbnormalFocus();
    } else {
      renderWSTable();
      return;
    }
    renderWSCategoryBar();
    updateWSFooter();
    scheduleAbnormalFocusRecovery();
  }

  function noteAbnormalNativeReadyAfterAudit(iframeWin, removedDR) {
    _abnormalNativeReadyDR = '';
    clearNativeUserSelectLock();
    const data = filteredData();
    if (wsAbnormalIndex < 0 || wsAbnormalIndex >= data.length) {return;}
    const next = data[wsAbnormalIndex];
    if (!next || String(next.ReportDR) === String(removedDR)) {return;}
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
    const auditCtx = auditTargetContext(iframeWin, reportDR);
    const caReady = isCASessionReady(iframeWin);
    const deadline = options.deadline || Date.now() + (fast ? (caReady ? 14000 : 40000) : 60000);
    const abortCheck = () => {
      if (typeof options.abortCheck === 'function' && options.abortCheck()) {return true;}
      return Date.now() > deadline;
    };
    const name = specimen.PatName || specimen.Labno || reportDR;
    const ft = document.getElementById('lis-ws-ft-stat');
    let result = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth', {
      action: 'audit',
      expectedStatuses: ['3'],
      batchMode: fast,
      timeoutMs: fast ? (caReady ? 4500 : 7000) : 12000,
      keepWS: !!options.keepWS,
      caSessionReady: caReady,
      missingAsSuccess: auditCtx.allowMissingSuccess,
      targetReportDR: reportDR,
      abortCheck,
      onTick: (elapsed, phase) => {
        if (ft)
        {ft.textContent = `${phase || '审核中'}：${name}${elapsed ? ' ' + Math.round(elapsed / 1000) + 's' : ''}`;}
      }
    });
    if (!result && !abortCheck()) {
      iframeWin = getReportIframeWin() || iframeWin;
      if (verifyAuditSucceededByReportDR(iframeWin, reportDR)) {return true;}
      result = await confirmAuditEventually(iframeWin, reportDR, name, {
        batchMode: fast,
        targetWasPresent: auditCtx.rowPresent,
        detailWasReady: auditCtx.detailReady,
        afterCA: !caReady,
        abortCheck
      });
    }
    if (!result && verifyAuditSucceededByReportDR(iframeWin, reportDR)) {return true;}
    // 延迟二次校验：原生状态回写可能有 1~2s 延迟，避免「已成功但脚本误判失败」
    if (!result && !abortCheck()) {
      await sleep(1500);
      iframeWin = getReportIframeWin() || iframeWin;
      if (verifyAuditSucceededByReportDR(iframeWin, reportDR) ||
          softAuditSuccessHint(iframeWin, reportDR)) {
        dbg('延迟二次校验：标本已审核成功（原生状态）');
        closeNativeAuditSuccessMessage(iframeWin);
        return true;
      }
      // 刷新 wsData 后再检查状态（审核期间轮询可能已停止）
      try {
        const loadResult = await loadWSData({ force: false });
        if (loadResult && !loadResult.skipped) {dbg('延迟校验前已刷新 wsData');}
      } catch (e) {}
      const liveRow = wsData.find(r => String(r.ReportDR) === String(reportDR));
      const liveStatus = liveRow ? String(liveRow.Status || liveRow.ReportStatus || '') : '';
      if (liveStatus === '3' || liveStatus === '4') {
        dbg('延迟二次校验：标本已审核成功（wsData 状态）');
        closeNativeAuditSuccessMessage(iframeWin);
        return true;
      }
    }
    // 最终返回前也关闭可能残留的原生弹窗
    if (result) {closeNativeAuditSuccessMessage(iframeWin);}
    return result;
  }

  // 关闭原生 LIS 审核成功后的弹窗（避免用户切回时看到多个弹窗）
  function closeNativeAuditSuccessMessage(iframeWin) {
    try {
      const win = iframeWin || getReportIframeWin();
      if (!win) {return;}
      const doc = win.document;
      const jq = win.jQuery || win.$;
      if (!doc || !jq) {return;}
      const allWins = doc.querySelectorAll('.messager-window:not([style*="display: none"]), .window:not([style*="display: none"])');
      for (const w of allWins) {
        if (w.offsetParent === null) {continue;}
        const body = w.querySelector('.messager-body, .panel-body');
        if (!body) {continue;}
        const text = (body.textContent || '').trim();
        if (text.indexOf('成功') !== -1 || text.indexOf('审核') !== -1) {
          const btns = w.querySelectorAll('a.l-btn, button');
          for (const b of btns) {
            const bText = (b.textContent || b.value || '').trim();
            if (bText === '确定' || bText === 'OK' || bText === '关闭') {
              try { jq(b).click(); } catch (e) { try { b.click(); } catch (e2) {} }
              dbg('已关闭原生审核成功弹窗');
              break;
            }
          }
        }
      }
    } catch (e) {}
  }

  async function auditAbnormalSpecimen(specimen) {
    if (_abnormalAuditInProgress) {
      _abnormalAuditQueued = true;
      const ft = document.getElementById('lis-ws-ft-stat');
      if (ft) {ft.textContent = '审核进行中，下一条已排队...';}
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
      showToast('没有可审核的待审标本', 'warning');
      return;
    }

    // 预校验：在标记 UI/设锁之前检查，避免"正在审核..."瞬间变"已审/不完整"的两个弹窗
    // 待审视图：正常行走 normal 上下文（NORMAL 才放行），异常/危急行走 abnormal 上下文（危急仍拦截）
    const _bucket = getWSAuditBucket(specimen);
    const _preClassCheck = validateAuditClassification(specimen.ReportDR, _bucket === 'normal' ? 'normal' : 'abnormal');
    if (!_preClassCheck.ok) {
      showToast(_preClassCheck.msg, _preClassCheck.msg.indexOf('危急') !== -1 ? 'error' : 'warning');
      advanceAbnormalFocusAfterSkip(Math.max(0, wsAbnormalIndex));
      return;
    }
    const _preComplete = String(specimen.IsComplete || '');
    if (_preComplete !== '1') {
      showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
      advanceAbnormalFocusAfterSkip(Math.max(0, wsAbnormalIndex));
      return;
    }
    const _preStatus = String(specimen.Status || specimen.ReportStatus || '');
    if (_preStatus === '3' || _preStatus === '4') {
      showToast(`跳过: ${specimen.PatName} 已审核`, 'warning');
      advanceAbnormalFocusAfterSkip(Math.max(0, wsAbnormalIndex));
      return;
    }

    let _auditSafetyTimer = null;
    const resumeWSRefresh = !!wsTimer;

    try {
      _abnormalAuditInProgress = true;
      _abnormalAuditQueued = false;
      clearNativeUserSelectLock();
      updateAbnormalEnterBridge();
      keepWorkbenchOnTop('审核');
      markAbnormalAuditUI(specimen, 'start');
      // 安全超时：60 秒后显示警告，但不释放锁（finally 块负责释放）
      _auditSafetyTimer = setTimeout(() => {
        if (_abnormalAuditInProgress) {
          dbg('异常审核安全超时：操作耗时超过 60 秒');
          showToast('审核操作耗时较长，请耐心等待', 'warning');
        }
      }, 60000);
      dbg('异常列表审核开始:', specimen.PatName);
      stopWSRefresh();
      const startIndex = Math.max(0, wsAbnormalIndex);
      const targetDR = String(specimen.ReportDR || '');
      const ft = document.getElementById('lis-ws-ft-stat');
      if (ft) {ft.textContent = `审核：${specimen.PatName || specimen.Labno || targetDR}`;}

      const curDR = resolveCurrentWG();
      const spDR = specimen._wg || '';
      if (spDR && curDR && spDR !== curDR) {
        const wgName = (WG_MAP[spDR] || {}).name || spDR;
        showToast(`切换到${wgName}继续审核`, 'warning');
        saveAbnormalTarget(specimen);
        _abnormalAuditQueued = false; // 切组续跑由 saveAbnormalTarget 机制处理，不用旧索引
        safeSwitchWG(spDR);
        return;
      }

      if (ft) {ft.textContent = `审核：准备原生页面 ${specimen.PatName || specimen.Labno || targetDR}`;}
      releaseNativeReportFocus(); // 先 blur 原生编辑焦点，避免审核按钮/回车被结果格吃掉
      await awaitAbnormalPrewarm(specimen);

      let iframeWin = getReportIframeWin();
      if (!iframeWin) {
        if (ft) {ft.textContent = '审核：加载报告页...';}
        iframeWin = await ensureReportPageLoaded({ keepWS: true, fast: true });
      }
      if (!iframeWin) {
        await sleep(80);
        iframeWin = getReportIframeWin() || (await ensureReportPageLoaded({ keepWS: true, fast: true }));
      }
      if (!iframeWin) {
        showToast('报告页面加载失败', 'error');
        advanceAbnormalFocusAfterSkip(startIndex);
        return;
      }

      const detailReady = isReportDetailLoaded(iframeWin, targetDR);
      if (ft)
      {ft.textContent = detailReady
        ? `审核：审核中 ${specimen.PatName || specimen.Labno || targetDR}`
        : `审核：选中 ${specimen.PatName || specimen.Labno || targetDR}`;}
      const skipSelect = _abnormalNativeReadyDR === targetDR;
      let prep = { ok: false, iframeWin, lastMdr: _abnormalLastMdr };
      if (detailReady && skipSelect) {
        prep.ok = true;
      } else {
        prep = await ensureSpecimenReadyForAudit(iframeWin, specimen, {
          lastMdr: _abnormalLastMdr,
          skipSelect: detailReady || skipSelect,
          abnormalFast: true,
          forceSelect: true
        });
      }
      _abnormalNativeReadyDR = '';
      iframeWin = prep.iframeWin || iframeWin;
      if (prep.lastMdr) {_abnormalLastMdr = prep.lastMdr;}
      if (!prep.ok) {
        const msg = prep.reason === 'detail' ? '报告详情未加载完成' : '未在原生列表中找到该标本';
        showToast(msg, prep.reason === 'detail' ? 'warning' : 'error');
        advanceAbnormalFocusAfterSkip(startIndex);
        return;
      }

      if (ft) {ft.textContent = `审核：审核中 ${specimen.PatName || specimen.Labno || targetDR}`;}
      releaseNativeReportFocus();
      let auditResult = await executeNativeAudit(iframeWin, specimen, { keepWS: true, fast: true });
      if (auditResult === 'incomplete') {
        showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
        advanceAbnormalFocusAfterSkip(startIndex);
        return;
      }
      // 最终兜底：executeNativeAudit 可能因竞态误判失败，再等 2s 多重校验
      if (!auditResult) {
        if (ft) {ft.textContent = `确认审核结果: ${specimen.PatName || specimen.Labno || targetDR}`;}
        await sleep(2000);
        iframeWin = getReportIframeWin() || iframeWin;
        if (verifyAuditSucceededByReportDR(iframeWin, targetDR) ||
            softAuditSuccessHint(iframeWin, targetDR)) {
          dbg('异常审核延迟确认成功（原生状态）:', specimen.PatName);
          auditResult = true;
        } else {
          if (ft) {ft.textContent = `刷新数据: ${specimen.PatName || specimen.Labno || targetDR}`;}
          // 刷新 wsData 后再检查状态（审核期间轮询已停止）
          try {
            const loadResult = await loadWSData({ force: false });
            if (loadResult && !loadResult.skipped) {dbg('延迟校验前已刷新 wsData');}
          } catch (e) {}
          const liveRow = wsData.find(r => String(r.ReportDR) === String(targetDR));
          const liveStatus = liveRow ? String(liveRow.Status || liveRow.ReportStatus || '') : '';
          if (liveStatus === '3' || liveStatus === '4') {
            dbg('异常审核延迟确认成功（wsData 状态）:', specimen.PatName);
            auditResult = true;
          }
        }
      }
      if (!auditResult) {
        showToast('未确认审核成功，已跳到下一条', 'warning');
        advanceAbnormalFocusAfterSkip(startIndex);
        return;
      }
      if (ft) {ft.textContent = `已审核: ${specimen.PatName || specimen.Labno || targetDR}`;}
      showToast(`已审核: ${specimen.PatName || specimen.Labno || ''}`, 'success');
      closeNativeAuditSuccessMessage(iframeWin);

      delete wsClassifiedCache[specimen.ReportDR];
      wsData = wsData.filter(r => r.ReportDR !== specimen.ReportDR);
      invalidateCaches();
      calcMachineCounts();
      noteAbnormalNativeReadyAfterAudit(iframeWin, targetDR);
      removeAuditedAbnormalCard(targetDR, startIndex);
    } catch (e) {
      dbg('审核失败:', e);
      showToast('审核失败: ' + e.message, 'error');
    } finally {
      clearTimeout(_auditSafetyTimer);
      clearAbnormalAuditingCard(specimen && specimen.ReportDR);
      _abnormalAuditInProgress = false;
      if (resumeWSRefresh && isWSVisible()) {startWSRefresh();}
      updateWSFooter();
      dbg('异常列表审核结束');
      if (wsCategory === 'audit') {scheduleAbnormalFocusRecovery();}
      if (_abnormalAuditQueued) {
        _abnormalAuditQueued = false;
        // 用户在审核完成前切走了待审分类：不再续审（filteredData 已是别的分类）
        if (wsCategory !== 'audit') {
          dbg('F4 排队续审取消: 已离开待审分类');
        } else {
          const data = filteredData();
          if (data.length) {
            const idx = Math.max(0, Math.min(wsAbnormalIndex, data.length - 1));
            setTimeout(() => auditAbnormalSpecimen(data[idx]), 30);
          }
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
      if (ic === '2') {icHTML = `<span class="complete-partial">⚠️ 缺 ${r.NoResRows || '?'} 项</span>`;}
      else if (ic === '0') {icHTML = '<span class="complete-empty">❌ 无结果</span>';}
      else {icHTML = '<span style="color:#999">-</span>';}

      h += `<tr data-i="${i}" data-rdr="${escAttr(r.ReportDR || '')}">`;
      h += `<td>${highlightText(r._mn || '', wsSearchQuery)}</td>`;
      h += `<td>${highlightText(r.PatName || '', wsSearchQuery)}</td>`;
      h += `<td><b>${highlightText(r.Labno || '', wsSearchQuery)}</b></td>`;
      h += `<td>${highlightText(r.TestSetDesc || '', wsSearchQuery)}</td>`;
      h += `<td>${icHTML}</td>`;
      h += `<td>${esc(r.AcceptDT || '')}</td>`;
      h += '</tr>';
    });
    h += '</tbody></table>';
    body.innerHTML = h;

    // 行点击 → 详情；空白处点击 → 收回详情
    // 移除旧委托，防止刷新累积多个处理器
    if (body._incompleteClickHandler) {
      body.removeEventListener('click', body._incompleteClickHandler);
    }
    body._incompleteClickHandler = e => {
      const tr = e.target.closest('tr[data-rdr]');
      if (!tr) {
        if (isDetailPanelVisible()) {closeDetailPanel();}
        return;
      }
      const specimen = findWSSpecimenByReportDR(tr.dataset.rdr);
      if (specimen) {openDetailPanel(specimen);}
    };
    body.addEventListener('click', body._incompleteClickHandler);
  }

  // --- 全部标本视图 ---
  function renderAllView(data, body) {
    const stMap = {
      0: { t: '待排样', cls: 'st-0t' },
      1: { t: '登记', cls: 'st-1t' },
      2: { t: '初审', cls: 'st-2t' },
      3: { t: '审核', cls: 'st-3t' },
      4: { t: '复审', cls: '' },
      5: { t: '取消', cls: 'st-5t' }
    };

    let h = '<table><thead><tr>';
    h += '<th style="width:30px"><input type="checkbox" id="lis-ws-chka" /></th>';
    h +=
      '<th>仪器</th><th>状态</th><th>完整度</th><th>流水号</th><th>姓名</th><th>检验号</th><th>医嘱</th><th>核收时间</th>';
    h += '</tr></thead><tbody>';

    data.forEach((r, i) => {
      const statusVal = r.Status || r.ReportStatus || '';
      const st = stMap[statusVal] || { t: r.StatusDesc || '?', cls: '' };
      const ck = wsChecked.has(r.ReportDR) ? 'checked' : '';
      h += `<tr class="st-${statusVal} ${wsChecked.has(r.ReportDR) ? 'sel' : ''}" data-i="${i}" data-rdr="${escAttr(r.ReportDR || '')}">`;
      h += `<td><input type="checkbox" class="lis-ws-ck" data-rdr="${escAttr(r.ReportDR || '')}" ${ck} /></td>`;
      h += `<td>${highlightText(r._mn || '', wsSearchQuery)}</td>`;
      h += `<td><span class="st-tag ${st.cls}">${esc(st.t)}</span></td>`;
      const ic = r.IsComplete;
      let icHTML = '';
      if (ic === '1') {icHTML = '<span class="complete-star">⭐</span>';}
      else if (ic === '2') {icHTML = `<span class="complete-partial">⚠️ -${r.NoResRows || '?'}</span>`;}
      else if (ic === '0') {icHTML = '<span class="complete-empty">❌</span>';}
      else {icHTML = '<span style="color:#999">-</span>';}
      h += `<td>${icHTML}</td>`;
      h += `<td><b>${highlightText(r.EpisodeNo || '', wsSearchQuery)}</b></td>`;
      h += `<td>${highlightText(r.PatName || '', wsSearchQuery)}</td>`;
      h += `<td>${highlightText(r.Labno || '', wsSearchQuery)}</td>`;
      h += `<td>${highlightText(r.TestSetDesc || '', wsSearchQuery)}</td>`;
      h += `<td>${esc(r.AcceptDT || '')}</td>`;
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

    // click 委托：行点击 → 详情；空白处点击 → 收回详情
    handlers.click = e => {
      const tr = e.target.closest('tr[data-rdr]');
      if (!tr) {
        // 点击空白处，收回详情面板
        if (isDetailPanelVisible()) {closeDetailPanel();}
        return;
      }
      if (e.target.closest('input[type="checkbox"]')) {return;}
      body.querySelectorAll('tr.active-row').forEach(r => r.classList.remove('active-row'));
      tr.classList.add('active-row');
      const specimen = findWSSpecimenByReportDR(tr.dataset.rdr);
      if (!specimen) {return;}
      const idx = filteredData().findIndex(r => String(r.ReportDR) === String(specimen.ReportDR));
      openDetailPanel(specimen, source || 'all', idx >= 0 ? idx : parseInt(tr.dataset.i));
    };

    // change 委托：checkbox 选中
    handlers.change = e => {
      if (e.target.id === 'lis-ws-chka') {
        body.querySelectorAll('.lis-ws-ck').forEach(c => {
          if (e.target.checked) {wsChecked.add(c.dataset.rdr);}
          else {wsChecked.delete(c.dataset.rdr);}
          c.checked = e.target.checked;
          c.closest('tr').classList.toggle('sel', e.target.checked);
        });
        return;
      }
      if (e.target.classList.contains('lis-ws-ck')) {
        if (e.target.checked) {wsChecked.add(e.target.dataset.rdr);}
        else {wsChecked.delete(e.target.dataset.rdr);}
        e.target.closest('tr').classList.toggle('sel', e.target.checked);
      }
    };

    // dblclick 委托：双击 → 原生界面
    handlers.dblclick = e => {
      const tr = e.target.closest('tr[data-rdr]');
      if (!tr) {return;}
      if (e.target.closest('input[type="checkbox"]')) {return;}
      const specimen = findWSSpecimenByReportDR(tr.dataset.rdr);
      if (specimen) {navigateToSpecimen(specimen);}
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
    if (normalData.length === 0) {
      showToast('没有可审核的标本', 'warning');
      return;
    }
    const existing = document.getElementById('lis-audit-confirm');
    if (existing) {existing.remove();}

    const wgNames = [
      ...new Set(
        normalData.map(r => {
          const wg = r.row._wg;
          return (WG_MAP[wg] || {}).name || wg || '当前组';
        })
      )
    ];
    const flowHint =
      wgNames.length > 1
        ? `<p style="margin:8px 0 0;font-size:12px;color:#5c6b7a;line-height:1.55">含 <b>${wgNames.length}</b> 个工作组（${esc(wgNames.join('、'))}），将自动切换；<b>每组首条</b>自动 CA 认证，同组后续秒审，无需手动预审。</p>`
        : '<p style="margin:8px 0 0;font-size:12px;color:#5c6b7a;line-height:1.55"><b>首条</b>将自动触发 CA 认证（capping 登录），同组后续秒审，<b>无需</b>手动先审一条。</p>';
    const hotkeyHint = '<p style="margin:10px 0 0;font-size:12px;color:#0d6655;line-height:1.5"><kbd style="background:#e8f5e9;padding:1px 6px;border-radius:3px">F4</kbd> 或 <kbd style="background:#e8f5e9;padding:1px 6px;border-radius:3px">Enter</kbd> 确认审核 · Esc 取消</p>';

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
                        ${flowHint}
                        ${hotkeyHint}
                        <div class="ab-list" style="max-height:300px;overflow-y:auto">
                            ${normalData
    .map(
      r => `<div class="ab-item">
                                <span class="ab-name">${esc(r.row.PatName || '未知')}</span>
                                <span class="ab-detail">${esc(r.row.Labno || '')} | ${esc(r.row.TestSetDesc || '')}</span>
                                <span class="ab-tag" style="background:#e8f5e9;color:#2e7d32">✓ 正常</span>
                            </div>`
    )
    .join('')}
                        </div>
                    </div>
                </div>
                <div class="ab-ft">
                    <button class="ab-cancel" id="lis-ab-cancel">取消</button>
                    <button class="ab-confirm ok" id="lis-ab-confirm">确认审核 (${normalData.length}) · F4</button>
                </div>
            </div>`;
    document.body.appendChild(dialog);
    dialog.classList.add('show');

    const confirmBtn = document.getElementById('lis-ab-confirm');
    let closed = false;
    const closeDialog = () => {
      if (closed) {return;}
      closed = true;
      document.removeEventListener('keydown', keyHandler, true);
      dialog.remove();
    };
    const doConfirm = () => {
      if (closed || !confirmBtn || confirmBtn.disabled) {return;}
      closeDialog();
      executeBatchAudit(normalData).catch(e => {
        console.error('[LIS] 批审异常:', e);
      });
    };
    const keyHandler = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeDialog();
        return;
      }
      if (e.key === 'F4' || (e.key === 'Enter' && !e.shiftKey)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        doConfirm();
      }
    };
    document.addEventListener('keydown', keyHandler, true);
    document.getElementById('lis-ab-close').addEventListener('click', closeDialog);
    document.getElementById('lis-ab-cancel').addEventListener('click', closeDialog);
    dialog.addEventListener('click', e => {
      if (e.target === dialog) {closeDialog();}
    });
    confirmBtn.addEventListener('click', doConfirm);
    // 焦点便于直接按键
    try {
      confirmBtn.focus();
    } catch (e) {}
  }

  // --- 批审操作条 ---
  function updateBatchBar() {
    let bb = document.getElementById('lis-batch');
    if (!bb) {
      bb = document.createElement('div');
      bb.id = 'lis-batch';
      document.body.appendChild(bb);
    }
    if (wsChecked.size === 0) {
      bb.classList.remove('show');
      return;
    }
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
      if (first) {navigateToSpecimen(first);}
    });
    document.getElementById('lis-bb-sel').addEventListener('click', () => {
      filteredData().forEach(r => {
        if (r.ReportDR) {wsChecked.add(r.ReportDR);}
      });
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
    try {
      localStorage.setItem(
        K.tgt,
        JSON.stringify({
          wgDR: targetDR,
          machineDR: mdr,
          labno: labno,
          reportDR: reportDR,
          time: Date.now()
        })
      );
    } catch (e) {}

    if (targetDR !== curDR) {
      // 需要切换工作组
      toast('正在切换到 ' + (WG_MAP[targetDR] || {}).name + '...', 'w');
      safeSwitchWG(targetDR);
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
          try {
            w.$('#cmb_WorkGroupMachine').combogrid('setValue', mdr);
          } catch (e) {}
          // 设置快速搜索
          try {
            w.$('#txt_FindFast').val(labno);
          } catch (e) {}
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
          if (!iframeWin) {return;}
          const jq = iframeWin.jQuery || iframeWin.$;
          if (!jq) {return;}
          const dg = jq('#dgWorkList');
          if (!dg.length) {return;}
          const rows = dg.datagrid('getRows');
          if (!rows || rows.length === 0) {return;}
          // 根据 ReportDR 或 Labno 选中对应行
          for (let i = 0; i < rows.length; i++) {
            if (String(rows[i].ReportDR) === String(reportDR) || String(rows[i].Labno) === String(labno)) {
              dg.datagrid('selectRow', i);
              dbg('导航: 已选中行', i, 'ReportDR:', reportDR);
              break;
            }
          }
        } catch (e) {
          dbg('导航选行失败:', e);
        }
      }, 1500);
    } catch (e) {
      dbg('导航失败:', e);
    }
  }

  let _saveQueueTimer = null;
  // 批量写入节流：批审标本多时，避免每条都全量序列化整队写 localStorage（O(N²) 卡顿）
  const QUEUE_SAVE_THROTTLE = 10; // 每 N 条才全量落盘一次
  let _queueSaveMod = 0;
  function _writeFullQueue(queue) {
    try {
      localStorage.setItem(K.auditQueue, JSON.stringify({ ...queue, time: Date.now() }));
    } catch (e) {
      dbg('_writeFullQueue 失败:', e.message);
    }
  }
  function _writeQueueProgress(queue) {
    // 轻量写入：只保留 current 进度，断点续跑仍能继续（在下次全量写时补全其余字段）
    try {
      const raw = localStorage.getItem(K.auditQueue);
      let base = raw ? JSON.parse(raw) : null;
      // items 代际不一致（重试塞队尾导致变长）时合并写会让 current 指向错误位置，直接全量写
      if (!base || !base.items || !Array.isArray(base.items) || base.items.length !== queue.items.length) {
        _writeFullQueue(queue);
        return;
      }
      base.current = queue.current;
      base.time = Date.now();
      localStorage.setItem(K.auditQueue, JSON.stringify(base));
    } catch (e) {
      try {
        _writeFullQueue(queue);
      } catch (_) {}
    }
  }
  function saveAuditQueue(queue) {
    clearTimeout(_saveQueueTimer);
    _saveQueueTimer = setTimeout(() => {
      try {
        _writeFullQueue(queue);
      } catch (e) {}
    }, 200);
  }
  function saveAuditQueueNow(queue) {
    clearTimeout(_saveQueueTimer);
    // 全量写入（切换组/中止/结束前必须调用，保证 items 完整）
    try {
      _writeFullQueue(queue);
    } catch (e) {}
  }
  // 批审循环内每条调用：节流全量写入，其余只更新进度
  function saveAuditQueueTick(queue) {
    _queueSaveMod = (_queueSaveMod + 1) % QUEUE_SAVE_THROTTLE;
    if (_queueSaveMod === 0) {
      try {
        _writeFullQueue(queue);
      } catch (e) {}
    } else {
      try {
        _writeQueueProgress(queue);
      } catch (e) {
        try {
          _writeFullQueue(queue);
        } catch (_) {}
      }
    }
  }

  function loadAuditQueue() {
    try {
      const raw = localStorage.getItem(K.auditQueue);
      if (!raw) {return null;}
      const q = JSON.parse(raw);
      if (!q || !q.items || !q.time || Date.now() - q.time > 10 * 60 * 1000) {
        localStorage.removeItem(K.auditQueue);
        return null;
      }
      return q;
    } catch (e) {
      return null;
    }
  }

  function clearAuditQueue() {
    try {
      localStorage.removeItem(K.auditQueue);
    } catch (e) {}
  }

  function makeAuditQueue(specimens, mode) {
    const items = [];
    specimens.forEach(sp => {
      const row = sp.row || sp;
      const reportDR = sp.reportDR || row.ReportDR;
      if (!reportDR || !row) {return;}
      if (!isAutoAuditableClassified(sp)) {return;}
      items.push({
        reportDR: String(reportDR),
        wg: row._wg || resolveCurrentWG(),
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
    if (!queue || !queue.items) {return null;}
    while (queue.current < queue.items.length) {
      const it = queue.items[queue.current];
      if (it && !it.done) {return it;}
      queue.current++;
    }
    return null;
  }

  async function ensureAuditQueueWorkGroup(queue) {
    const item = currentQueueItem(queue);
    if (!item) {return true;}
    const curDR = String(resolveCurrentWG());
    const itemWg = String(item.wg || '');
    if (!itemWg || itemWg === curDR) {return true;}
    // curDR 为空时（页面刚重载，全局变量和下拉框都还没就绪），不盲目切组
    // 让 runAuditQueueResume 延迟重试，等页面完全加载后再判断
    if (!curDR) {
      queue.pausedForSwitch = true;
      saveAuditQueueNow(queue);
      runAuditQueueResume(2500);
      return false;
    }
    queue.pausedForSwitch = true;
    saveAuditQueueNow(queue);
    const wgName = (WG_MAP[itemWg] || {}).name || itemWg;
    showToast('切换到' + wgName + '继续审核...', 'warning');
    const switched = safeSwitchWG(item.wg);
    // safeSwitchWG 返回 true 且未触发重载（已在目标组）→ 直接继续，不用等
    if (switched && String(resolveCurrentWG()) === itemWg) {
      delete queue.pausedForSwitch;
      saveAuditQueueNow(queue);
      return true;
    }
    runAuditQueueResume(2500);
    return false;
  }

  function runAuditQueueResume(delayMs) {
    setTimeout(() => {
      // 审核进行中：延迟重试，不弹误导 toast
      if (_auditInProgress || _abnormalAuditInProgress || _detailAuditInProgress) {
        // 队列已过期/完成就不再每 3s 空转（防止标志卡死时无限重调度）
        const q = loadAuditQueue();
        if (!q || !q.items || q.items.length - (q.current || 0) <= 0) {
          dbg('续跑批审: 队列已过期或完成，停止重试');
          clearAuditQueue();
          return;
        }
        dbg('续跑批审: 审核进行中，延迟 3s 重试');
        runAuditQueueResume(3000);
        return;
      }
      const freshQueue = loadAuditQueue();
      if (!freshQueue || !freshQueue.items || freshQueue.items.length - (freshQueue.current || 0) <= 0) {
        const prog = document.getElementById('lis-audit-progress');
        if (prog && prog.classList.contains('show')) {
          const text = document.getElementById('lis-prog-text');
          if (text) {text.textContent = '批审队列已过期或已完成，已自动清理';}
          showToast('批审队列已过期或已完成', 'info');
          setTimeout(() => prog.remove(), 2000);
        }
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

  function checkAuditQueueResume() {
    const queue = loadAuditQueue();
    if (!queue || !queue.items || queue.items.length === 0) {return;}
    const remaining = queue.items.length - (queue.current || 0);
    if (remaining <= 0) {
      clearAuditQueue();
      return;
    }
    // 仅在切组后自动续跑，不弹确认框
    if (queue.pausedForSwitch) {
      showToast(`切换工作组后继续批审（${remaining} 个标本）...`, 'warning');
      runAuditQueueResume(1500);
      return;
    }
    // 非切组场景（如页面刷新），静默清理过期队列，不弹窗打扰
    clearAuditQueue();
  }

  // --- F5 快捷键审核选中标本 ---
  function auditSelectedSpecimens() {
    if (wsChecked.size === 0) {
      toast('请先选择要审核的标本', 'w');
      return;
    }

    // 获取选中的标本
    const selectedSpecimens = filteredData().filter(r => wsChecked.has(r.ReportDR));
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
      if (cached) {cached._accessTs = Date.now();}
      return cached && !isClassificationStale(r)
        ? { status: cached.status, items: cached.items || [], row: r, reportDR: r.ReportDR }
        : { status: 'UNCERTAIN', items: [], row: r, reportDR: r.ReportDR };
    });
    const normalOnly = formatted.filter(isAutoAuditableClassified);
    const blocked = formatted.filter(r => !isAutoAuditableClassified(r));
    if (blocked.length > 0) {
      showToast(`已排除 ${blocked.length} 个异常/危急/待定标本`, 'warning');
    }
    if (normalOnly.length === 0) {
      showToast(
        blocked.length ? getAutoAuditBlockReason(blocked[0], blocked[0].row) : '没有可审核的正常标本',
        'warning'
      );
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
  let detailSource = null; // 'abnormal' | 'normal' | null
  let detailSourceIndex = -1;
  let _detailKeyHandler = null; // 详情面板键盘监听器
  let _detailLoadSeq = 0; // 详情加载序号，防止旧请求覆盖当前标本

  function createDetailPanel() {
    if (detailPanel) {return detailPanel;}
    detailPanel = document.createElement('div');
    detailPanel.id = 'lis-detail-panel';
    detailPanel.innerHTML = `
            <div id="lis-detail-hd">
                <div style="flex:1;min-width:0;padding-right:10px">
                    <h4 id="lis-detail-title" style="margin:0;font-size:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">📋 标本详情</h4>
                    <div id="lis-detail-subtitle" style="font-size:11px;color:var(--lis-text-secondary);margin-top:3px"></div>
                    <div id="lis-detail-extra" style="font-size:11px;color:var(--lis-text-muted);margin-top:2px"></div>
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
                <button class="btn-audit" id="lis-detail-audit" title="Enter 或点击：审核当前详情标本，成功后自动跳下一条">✅ 审核</button>
                <button class="btn-close" id="lis-detail-close-btn">关闭</button>
            </div>
        `;
    document.body.appendChild(detailPanel);

    // 透明层只保留占位，不拦截工作台列表点击；关闭请用按钮或 Esc。
    const overlay = document.createElement('div');
    overlay.id = 'lis-detail-overlay';
    overlay.style.cssText =
      'position:fixed;top:0;left:0;width:35vw;height:100vh;z-index:100004;display:none;pointer-events:none';
    document.body.appendChild(overlay);

    // 事件绑定（审核钮与 Enter 共用 _auditFromDetailPanel，非互斥）
    document.getElementById('lis-detail-close').addEventListener('click', closeDetailPanel);
    document.getElementById('lis-detail-close-btn').addEventListener('click', closeDetailPanel);
    _bindDetailAuditButton();

    return detailPanel;
  }

  // 详情「审核」按钮：每次打开/切换时重绑，避免监听丢失；与 Enter 同一入口
  function _bindDetailAuditButton() {
    const btn = document.getElementById('lis-detail-audit');
    if (!btn) {return;}
    btn.onclick = e => {
      if (e) {
        e.preventDefault();
        e.stopPropagation();
      }
      dbg(
        '详情面板审核按钮点击, specimen=',
        !!(currentDetailSpecimen && currentDetailSpecimen.PatName),
        currentDetailSpecimen && currentDetailSpecimen.PatName
      );
      if (!currentDetailSpecimen) {
        showToast('当前没有打开的标本详情', 'warning');
        return;
      }
      void _auditFromDetailPanel();
    };
  }

  function _setDetailAuditBusy(busy, text) {
    const btn = document.getElementById('lis-detail-audit');
    if (!btn) {return;}
    btn.disabled = !!busy;
    btn.classList.toggle('busy', !!busy);
    btn.textContent = text || (busy ? '⏳ 审核中…' : '✅ 审核');
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
    // 按标本实时分类桶校准 source：异常从「全部/不完整」视图打开详情也能审（原为 null→normal 会被拦）
    detailSource = specimen && getWSAuditBucket(specimen) === 'normal' ? 'normal' : 'abnormal';
    detailSourceIndex = sourceIndex !== undefined ? sourceIndex : -1;

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
    if (detailExtra) {detailExtra.textContent = buildDetailExtraText(_cr, specimen) || '加载中...';}

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
    if (overlay) {overlay.style.display = 'none';}

    // 加载详细结果
    loadDetailResults(specimen);

    // 更新底部按钮
    const footer = document.getElementById('lis-detail-footer');
    if (footer) {
      // 移除旧的"原生界面"按钮
      const oldNative = document.getElementById('lis-detail-native');
      if (oldNative) {oldNative.remove();}
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
    _bindDetailAuditButton();
    _setDetailAuditBusy(false);

    // 注册详情面板键盘监听（Enter 与审核钮同一路径）
    _removeDetailKeyHandler();
    _detailKeyHandler = e => {
      if (isPatientResultPanelEvent(e)) {return;}
      if (!detailPanel || !detailPanel.classList.contains('show')) {return;}
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeDetailPanel();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        dbg('Enter 键捕获 (详情面板), inProgress=', _detailAuditInProgress);
        void _auditFromDetailPanel();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (_detailAuditInProgress) {return;} // 审核中禁止切换标本
        e.preventDefault();
        e.stopImmediatePropagation();
        // 方向键切换：原地更新内容，不关闭面板
        const data = filteredData();
        if (data.length === 0) {return;}
        const curIdx = data.findIndex(r => r.ReportDR === (currentDetailSpecimen && currentDetailSpecimen.ReportDR));
        let newIdx = curIdx + (e.key === 'ArrowDown' ? 1 : -1);
        if (newIdx < 0) {newIdx = data.length - 1;}
        if (newIdx >= data.length) {newIdx = 0;}
        _switchDetailInPlace(data[newIdx], detailSource, newIdx);
      }
    };
    document.addEventListener('keydown', _detailKeyHandler, true);
    dbg('详情面板键盘监听已注册, specimen:', specimen.PatName);
    // 确保 F4 桥在原生 iframe 上挂着（面板打开时异常处理器已被移除，Enter 靠桥捕获）
    _attachF4BridgeToIframe();
    refocusDetailPanel();
    scheduleDetailPrewarm(specimen, 120);
  }

  function _removeDetailKeyHandler() {
    if (_detailKeyHandler) {
      document.removeEventListener('keydown', _detailKeyHandler, true);
      _detailKeyHandler = null;
    }
  }

  function formatDetailTimeText(value) {
    const raw = String(value || '').trim();
    if (!raw) {return '';}
    const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}):(\d{2})(?::\d{2})?/);
    if (m) {return m[2] + '-' + m[3] + ' ' + m[4] + ':' + m[5];}
    const mt = raw.match(/^(\d{2}):(\d{2})(?::\d{2})?/);
    if (mt) {return mt[1] + ':' + mt[2];}
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
    if (!bed) {return '';}
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

    if (sex) {parts.push(sex);}
    if (age) {parts.push(age + ageUnit);}
    if (location) {parts.push(location);}
    if (ward) {parts.push(ward);}
    if (admNo) {parts.push('住院号 ' + admNo);}
    else if (recordNo) {parts.push('病案号 ' + recordNo);}
    else if (regNo) {parts.push('登记号 ' + regNo);}
    if (bed) {parts.push(bed);}
    if (specimen) {parts.push(specimen);}
    if (doctor) {parts.push(doctor);}
    if (collectTime) {parts.push('采集 ' + collectTime);}
    if (receiveTime) {parts.push('接收 ' + receiveTime);}
    if (acceptTime) {parts.push('核收 ' + acceptTime);}
    if (authTime) {parts.push('审核 ' + authTime);}
    if (diagnose) {parts.push('🏥 ' + diagnose);}
    return parts.join(' · ');
  }

  function buildDetailSubtitle(specimen) {
    return `<span>${getStatusText(specimen.Status || specimen.ReportStatus)}</span> · 检验号: ${esc(specimen.Labno || '-')} · 流水号: ${esc(specimen.EpisodeNo || '-')} · ${esc(specimen.TestSetDesc || '')} · 仪器: ${esc(specimen._mn || '-')}`;
  }

  // 原地切换详情面板内容（不关闭面板，避免闪烁）
  // options.force：审核成功后切下一条时绕过「审核中」锁
  function _switchDetailInPlace(specimen, source, sourceIndex, options) {
    if (!detailPanel || !specimen) {return;}
    if (_detailAuditInProgress && !(options && options.force)) {
      dbg('审核进行中，忽略详情切换');
      return;
    }
    currentDetailSpecimen = specimen;
    // 始终按标本实时分类桶校准 source，避免详情内自动跳转/方向键切换后沿用旧桶
    // （8.5.1 误拦正常标本的根因：跳转后 detailSource 仍是异常的）
    detailSource = getWSAuditBucket(specimen) === 'normal' ? 'normal' : 'abnormal';
    detailSourceIndex = sourceIndex !== undefined ? sourceIndex : -1;
    // 切换时清危急标记，避免沿用上一条 dataset 误拦/误放
    try {
      detailPanel.dataset.rdr = String(specimen.ReportDR || '');
      detailPanel.dataset.hasCritical = '';
    } catch (e) {}

    // 更新标题
    const titleEl = document.getElementById('lis-detail-title');
    if (titleEl) {titleEl.textContent = `📋 ${specimen.PatName || '未知'}`;}
    const subtitleEl = document.getElementById('lis-detail-subtitle');
    if (subtitleEl) {subtitleEl.innerHTML = buildDetailSubtitle(specimen);}
    const detailExtra = document.getElementById('lis-detail-extra');
    const _cr = (wsClassifiedCache[specimen.ReportDR] || {}).row || specimen;
    if (detailExtra) {detailExtra.textContent = buildDetailExtraText(_cr, specimen) || '加载中...';}

    // 信息栏
    const info = document.getElementById('lis-detail-info');
    if (info) {info.innerHTML = '<div style="height:1px"></div>';}

    // 显示加载中
    const body = document.getElementById('lis-detail-body');
    if (body) {
      body.innerHTML = '<div id="lis-detail-loading"><div class="spinner"></div><p>正在加载结果...</p></div>';
    }

    // 更新底部按钮
    const footer = document.getElementById('lis-detail-footer');
    if (footer) {
      const oldNative = document.getElementById('lis-detail-native');
      if (oldNative) {oldNative.remove();}
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
    _bindDetailAuditButton();
    _setDetailAuditBusy(false);

    // 加载详情（LRU 缓存命中时极快）
    loadDetailResults(specimen);

    // 重新注册键盘监听
    _removeDetailKeyHandler();
    _detailKeyHandler = e => {
      if (isPatientResultPanelEvent(e)) {return;}
      if (!detailPanel || !detailPanel.classList.contains('show')) {return;}
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        closeDetailPanel();
      } else if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        e.stopImmediatePropagation();
        void _auditFromDetailPanel();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        if (_detailAuditInProgress) {return;}
        e.preventDefault();
        e.stopImmediatePropagation();
        const data = filteredData();
        if (data.length === 0) {return;}
        const curIdx = data.findIndex(r => r.ReportDR === (currentDetailSpecimen && currentDetailSpecimen.ReportDR));
        let newIdx = curIdx + (e.key === 'ArrowDown' ? 1 : -1);
        if (newIdx < 0) {newIdx = data.length - 1;}
        if (newIdx >= data.length) {newIdx = 0;}
        _switchDetailInPlace(data[newIdx], detailSource, newIdx);
      }
    };
    document.addEventListener('keydown', _detailKeyHandler, true);
    _attachF4BridgeToIframe();
    refocusDetailPanel();
    scheduleDetailPrewarm(specimen, 120);
  }

  // 焦点放回详情面板自身：确保 Enter 由 _detailKeyHandler 直接捕获（不依赖 iframe 桥），
  // 避免焦点滞留在原生 iframe 内导致 Enter 被原生 datagrid 吃掉（用户历史痛点）
  function refocusDetailPanel() {
    try {
      const dEl = document.getElementById('lis-detail-panel');
      if (dEl) {
        if (!dEl.hasAttribute('tabindex')) {dEl.setAttribute('tabindex', '-1');}
        dEl.focus({ preventScroll: true });
      }
    } catch (e) {}
  }

  // 详情面板当前标本后台预热：定位原生页并加载详情，保证 Enter 审核秒审（needPrep=false 跳过定位）
  // 审核成功跳下一条后也会触发，连续 Enter 全程不卡
  let _detailPrewarmTimer = null;
  function scheduleDetailPrewarm(specimen, delayMs) {
    if (!specimen || !isWSVisible()) {return;}
    clearTimeout(_detailPrewarmTimer);
    const delay = typeof delayMs === 'number' ? delayMs : 250;
    _detailPrewarmTimer = setTimeout(() => {
      // 审核进行中不抢原生页（详情审完由 finally 里的 scheduleDetailPrewarm 补触发）；
      // 标本已切走则放弃本次预热
      if (_detailAuditInProgress || _auditInProgress) {return;}
      if (!isDetailPanelVisible() || !currentDetailSpecimen) {return;}
      if (String(currentDetailSpecimen.ReportDR) !== String(specimen.ReportDR)) {return;}
      prewarmAbnormalAuditNative(specimen).catch(() => {});
    }, delay);
  }

  let _detailAuditInProgress = false;

  // 从详情面板审核当前标本并自动跳转下一个
  // 入口：详情「审核」按钮 / Enter —— 同一函数，可同时保留（F4 在详情内已取消，8.5.1）
  async function _auditFromDetailPanel() {
    if (!currentDetailSpecimen) {
      dbg('详情审核跳过: 无当前标本');
      showToast('当前没有打开的标本详情', 'warning');
      return;
    }
    if (_detailAuditInProgress) {
      dbg('详情审核跳过: 进行中');
      showToast('正在审核当前详情，请稍候', 'info');
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
    let _detailSafetyTimer = null;
    const resumeWSRefresh = !!wsTimer;

    try {
      _detailAuditInProgress = true;
      _setDetailAuditBusy(true, '⏳ 审核中…');
      // 安全超时：60 秒后显示警告，但不释放锁（finally 块负责释放）
      _detailSafetyTimer = setTimeout(() => {
        if (_detailAuditInProgress) {
          dbg('详情审核安全超时：操作耗时超过 60 秒');
          showToast('详情审核操作耗时较长，请耐心等待', 'warning');
        }
      }, 60000);
      dbg('详情审核开始:', currentDetailSpecimen.PatName, 'source=', detailSource);
      // 不弹「正在审核」toast：按钮已显示 ⏳ 审核中…，结束后只弹 审核成功/审核失败 一个窗，避免双窗叠加
      stopWSRefresh();
      const specimen = currentDetailSpecimen;
      const source = detailSource;
      const idx = detailSourceIndex;

      let nextReportDR = null;
      if (source && idx >= 0) {
        const data = filteredData();
        if (idx + 1 < data.length) {nextReportDR = data[idx + 1].ReportDR;}
      }

      let iframeWin = getReportIframeWin();
      if (!iframeWin) {iframeWin = await ensureReportPageLoaded({ keepWS: true });}
      if (!iframeWin) {
        showToast('报告页面未加载', 'error');
        return;
      }

      const reportDR = specimen.ReportDR;
      // 详情里人工点审：按当前标本实时分类桶选上下文（不能依赖 detailSource——
      // 详情内自动跳转后 source 仍是旧标本的，会误拦正常标本为「已分类为正常」）
      const classCtx = specimen && getWSAuditBucket(specimen) === 'normal' ? 'normal' : 'abnormal';
      const classCheck = validateAuditClassification(reportDR, classCtx);
      if (!classCheck.ok) {
        showToast(classCheck.msg || '当前标本不可审核', classCtx === 'abnormal' ? 'warning' : 'error');
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

      const curDR = resolveCurrentWG();
      const spDR = specimen._wg || '';
      if (spDR && curDR && spDR !== curDR) {
        const wgName = (WG_MAP[spDR] || {}).name || spDR;
        showToast(`切换到${wgName}继续审核`, 'warning');
        saveAbnormalTarget(specimen);
        safeSwitchWG(spDR);
        return;
      }

      // 若后台预热正针对本标本进行，等它完成再现场判定（避免双线程同时驱动原生页竞态）
      if (_abnormalPrewarmPromise && String(_abnormalPrewarmDR || '') === String(reportDR)) {
        try { await _abnormalPrewarmPromise; } catch (e) {}
        iframeWin = getReportIframeWin() || iframeWin;
      }

      let needPrep = true;
      try {
        const me = iframeWin.me;
        if (me && me.selectedGrid && isReportDetailLoaded(iframeWin, reportDR)) {needPrep = false;}
      } catch (e) {}
      if (needPrep) {
        _setDetailAuditBusy(true, '⏳ 定位标本…');
        const prep = await ensureSpecimenReadyForAudit(iframeWin, specimen, { lastMdr: _abnormalLastMdr });
        iframeWin = prep.iframeWin || iframeWin;
        if (prep.lastMdr) {_abnormalLastMdr = prep.lastMdr;}
        if (!prep.ok) {
          const msg = prep.reason === 'detail' ? '报告详情未加载完成' : '未在原生列表中找到该标本';
          showToast(msg, prep.reason === 'detail' ? 'warning' : 'error');
          return;
        }
      }

      _setDetailAuditBusy(true, '⏳ 提交审核…');
      let auditResult = await executeNativeAudit(iframeWin, specimen, { keepWS: true, fast: true });
      if (auditResult === 'incomplete') {
        showToast(`跳过: ${specimen.PatName} 结果不完整`, 'warning');
        return;
      }
      // 最终兜底：再等 2s 后多重校验（原生状态 + wsData + softHint）
      if (!auditResult) {
        _setDetailAuditBusy(true, '⏳ 确认审核结果…');
        await sleep(2000);
        iframeWin = getReportIframeWin() || iframeWin;
        if (verifyAuditSucceededByReportDR(iframeWin, reportDR) ||
            softAuditSuccessHint(iframeWin, reportDR)) {
          dbg('详情审核延迟确认成功（原生状态）:', specimen.PatName);
          auditResult = true;
        } else {
          _setDetailAuditBusy(true, '⏳ 刷新数据…');
          // 刷新 wsData 后再检查状态（审核期间轮询已停止）
          try {
            const loadResult = await loadWSData({ force: false });
            if (loadResult && !loadResult.skipped) {dbg('延迟校验前已刷新 wsData');}
          } catch (e) {}
          const liveRow = wsData.find(r => String(r.ReportDR) === String(reportDR));
          const liveStatus = liveRow ? String(liveRow.Status || liveRow.ReportStatus || '') : '';
          if (liveStatus === '3' || liveStatus === '4') {
            dbg('详情审核延迟确认成功（wsData 状态）:', specimen.PatName);
            auditResult = true;
          }
        }
      }
      if (!auditResult) {
        showToast(`审核失败: ${specimen.PatName || ''}，未能确认审核结果，请核对原生列表状态`, 'error');
        return;
      }
      showToast(`审核成功: ${specimen.PatName}`, 'success');
      closeNativeAuditSuccessMessage(iframeWin);
      dbg('详情审核成功:', specimen.PatName, 'ReportDR:', reportDR);

      // 确保焦点在主页面（审核操作后焦点可能留在 iframe 中）
      try {
        window.focus();
      } catch (e) {}

      // 从数据中移除
      delete wsClassifiedCache[specimen.ReportDR];
      wsData = wsData.filter(r => r.ReportDR !== specimen.ReportDR);
      invalidateCaches();
      calcMachineCounts();

      // 自动切换到下一个标本（原地更新，不关闭面板）
      // 须 force：此时 _detailAuditInProgress 仍为 true，否则会被「审中禁切换」误拦
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
          _switchDetailInPlace(nextSpecimen, source, nextIdx, { force: true });
        } else {
          closeDetailPanel(true); // force: 审核已完成，绕过 _detailAuditInProgress 守卫
          // 待审视图详情审核完成：保持当前视图（正常/异常已合并，无需再切分类）
          renderWSCategoryBar();
          renderWSTable();
        }
      } else {
        closeDetailPanel(true); // force: 审核已完成，绕过 _detailAuditInProgress 守卫
        renderWSCategoryBar();
        renderWSTable();
      }
    } catch (e) {
      dbg('详情面板审核失败:', e);
      showToast('审核失败: ' + e.message, 'error');
    } finally {
      clearTimeout(_detailSafetyTimer);
      _detailAuditInProgress = false;
      _setDetailAuditBusy(false);
      if (resumeWSRefresh && isWSVisible()) {startWSRefresh();}
      // 详情审核结束：后台预热当前（下一条）标本，保证连续 Enter 秒审
      if (isDetailPanelVisible() && currentDetailSpecimen) {
        scheduleDetailPrewarm(currentDetailSpecimen, 50);
      }
      dbg('详情审核结束, inProgress 重置为 false');
    }
  }

  // F4 列表路径已收敛到 auditAbnormalSpecimen（见 triggerF4Audit）；保留薄封装兼容旧调用
  function auditFocusedSpecimenAsDetail() {
    triggerF4Audit();
  }

  function closeDetailPanel(force) {
    if (_detailAuditInProgress && !force) {
      dbg('审核进行中，忽略关闭详情面板');
      return;
    }
    _removeDetailKeyHandler();
    if (detailPanel) {
      detailPanel.classList.remove('show');
      currentDetailSpecimen = null;
      detailSource = null;
      detailSourceIndex = -1;
    }
    // 隐藏遮罩层
    const overlay = document.getElementById('lis-detail-overlay');
    if (overlay) {overlay.style.display = 'none';}
    // 如果当前是待审视图，恢复键盘监听
    if (wsCategory === 'audit') {
      _rebindAbnormalKeyHandler();
    }
  }

  function getStatusText(status) {
    const map = {
      0: '📦 待排样',
      1: '📋 登记',
      2: '🔍 初审',
      3: '✅ 审核',
      4: '🔄 复审',
      5: '❌ 取消'
    };
    return map[String(status)] || '未知';
  }

  // 解析并渲染单个检验项目的历次结果，返回 {cells:[], dates:[]}
  function renderHistoryItems(r) {
    const historyItems = parsePreResult(r);
    if (historyItems.length === 0) {return { cells: ['', '', ''], dates: [] };}

    // 按日期降序排列（最新的在前），无日期的排最后
    const sorted = [...historyItems].sort((a, b) => {
      if (!a.date && !b.date) {return 0;}
      if (!a.date) {return 1;}
      if (!b.date) {return -1;}
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
        if (ab === 'HH' || ab === 'LL') {cls = 'critical';}
        else if (ab === 'H') {cls = 'high';}
        else if (ab === 'L') {cls = 'low';}
        else if (ab === 'A') {cls = 'abnormal';}
        else {
          // 回退：用参考范围数值比较
          const histStatus = compareResultToRange(h.result, r.ValueLow, r.ValueHigh);
          if (histStatus === 'HIGH') {cls = 'high';}
          else if (histStatus === 'LOW') {cls = 'low';}
        }
        if (!h.date && cls === 'normal') {cls = 'nodate';}
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
      if (!src) {continue;}

      // 格式1: 已经是数组
      if (Array.isArray(src)) {
        for (const p of src) {
          const res = p.Result || p.TCResult || p.result || p.PreResult || '';
          const dt = p.AcceptDT || p.AcceptDate || p.date || p.Date || '';
          const ab = (p.AbFlag || p.abFlag || p.Flag || '').toString().toUpperCase().trim();
          if (res) {items.push({ result: String(res).trim(), date: String(dt).trim(), abFlag: ab });}
        }
        continue;
      }

      // 格式2: JSON 字符串
      if (typeof src === 'string') {
        const trimmed = src.trim();
        if (!trimmed) {continue;}

        // 尝试 JSON 解析
        if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
          try {
            const parsed = JSON.parse(trimmed);
            const arr = Array.isArray(parsed) ? parsed : [parsed];
            for (const p of arr) {
              const res = p.Result || p.TCResult || p.result || p.PreResult || '';
              const dt = p.AcceptDT || p.AcceptDate || p.date || p.Date || '';
              const ab = (p.AbFlag || p.abFlag || p.Flag || '').toString().toUpperCase().trim();
              if (res) {items.push({ result: String(res).trim(), date: String(dt).trim(), abFlag: ab });}
            }
            continue;
          } catch (e) {}
        }

        // 格式3: "值(日期), 值(日期)" 格式
        const matches = trimmed.match(/([^(),]+)\(([^)]+)\)/g);
        if (matches) {
          for (const m of matches) {
            const parts = m.match(/(.+)\((.+)\)/);
            if (parts) {items.push({ result: parts[1].trim(), date: parts[2].trim(), abFlag: '' });}
          }
          continue;
        }

        // 格式4: "值^标志^ID^日期" 格式（iMedicalLIS 历史结果格式）
        // 可能是单条 "5.57^H^10197009^20260607" 或逗号分隔多条
        if (trimmed.includes('^')) {
          // 先按逗号拆分多条记录
          const records = trimmed
            .split(',')
            .map(r => r.trim())
            .filter(Boolean);
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
                  date = d.slice(0, 4) + '-' + d.slice(4, 6) + '-' + d.slice(6, 8);
                } else {
                  date = d;
                }
              }
              if (res) {items.push({ result: res.trim(), date: date, abFlag: ab });}
            } else {
              if (rec) {items.push({ result: rec, date: '', abFlag: '' });}
            }
          }
          continue;
        }

        // 格式5: 用分隔符隔开的纯值（逗号、分号、竖线）
        if (trimmed.includes(',') || trimmed.includes(';') || trimmed.includes('|')) {
          const sep = trimmed.includes(',') ? ',' : trimmed.includes(';') ? ';' : '|';
          const vals = trimmed
            .split(sep)
            .map(v => v.trim())
            .filter(Boolean);
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
    if (!body) {return;}
    const rdr = specimen.ReportDR || '';
    const seq = ++_detailLoadSeq;
    const isCurrentDetail = () =>
      detailPanel &&
      detailPanel.classList.contains('show') &&
      currentDetailSpecimen &&
      String(currentDetailSpecimen.ReportDR || '') === String(rdr) &&
      seq === _detailLoadSeq;

    // LRU 缓存命中
    const cached = detailLRUGet(rdr);
    if (cached) {
      dbg('详情缓存命中:', rdr);
      if (!isCurrentDetail()) {return;}
      body.innerHTML = cached.html;
      return;
    }

    try {
      // 优先使用分类时缓存的原始数据（同一 API 调用）
      let data, itemInfo, labInfo;
      const ss = buildSS(specimen._wg || wgDR());
      const classifyCached = _classifyRawCache[rdr];
      if (classifyCached && Date.now() - classifyCached.ts < 60000) {
        dbg('详情命中分类缓存:', rdr);
        data = classifyCached.data;
        itemInfo = data && data.ItemInfo ? data.ItemInfo : [];
        labInfo = data && data.LabInfo ? data.LabInfo : [];
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
        itemInfo = data && data.ItemInfo ? data.ItemInfo : [];
        labInfo = data && data.LabInfo ? data.LabInfo : [];

        if (itemInfo.length === 0 && statusVal) {
          dbg('状态', statusVal, '返回空结果，用空状态重试');
          p.set('P3', '');
          data = await fetchJ(CSP + '?' + p.toString());
          itemInfo = data && data.ItemInfo ? data.ItemInfo : [];
          if (!labInfo.length) {labInfo = data && data.LabInfo ? data.LabInfo : [];}
        }
      }

      // 调试：打印所有项目的字段和 PreResult
      if (DEBUG && itemInfo.length > 0) {
        dbg('=== PreResult 诊断 ===');
        dbg('Item0 字段:', Object.keys(itemInfo[0]).join(', '));
        itemInfo.forEach((item, i) => {
          const pr = item.PreResult;
          const prType = Array.isArray(pr) ? 'array[' + pr.length + ']' : typeof pr;
          dbg(
            `  ${i + 1}. ${item.CName}: PreResult(${prType})=`,
            pr === null ? 'null' : pr === undefined ? 'undefined' : JSON.stringify(pr).slice(0, 200)
          );
          // 检查其他可能的历史字段
          ['PreResult1', 'PreResult2', 'PreResult3', 'LabResult', 'HistoryResult', 'OldResult'].forEach(k => {
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
          const itemInfo2 = data2 && data2.ItemInfo ? data2.ItemInfo : [];
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
              if (!histMap[key]) {histMap[key] = [];}
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
        if (!isCurrentDetail()) {return;}
        body.innerHTML = '<div style="text-align:center;padding:40px;color:#999">未找到结果数据</div>';
        return;
      }
      // 渲染结果
      let html = '';

      // 统计摘要栏
      const totalItems = itemInfo.length;
      const doneItems = itemInfo.filter(r => {
        const v = (r.TextRes && String(r.TextRes).trim() ? r.TextRes : r.Result || '').trim();
        return !isEmptyResultValue(r, v);
      }).length;
      const abnItems = itemInfo.filter(
        r => classifyResultItem(r) !== 'NORMAL' && classifyResultItem(r) !== 'UNCERTAIN'
      ).length;
      const critItems = itemInfo.filter(r => isCriticalResultItem(r)).length;
      const pendItems = totalItems - doneItems;

      html += '<div style="display:flex;align-items:center;gap:16px;padding:8px 0;font-size:12px;flex-wrap:wrap">';
      html += `<span style="font-weight:600">✅ 已检: ${doneItems}/${totalItems}</span>`;
      if (pendItems > 0) {html += `<span style="color:#ff9800;font-weight:600">⏳ 待检: ${pendItems}</span>`;}
      if (abnItems > 0) {html += `<span style="color:#e74c3c;font-weight:600">⚠ 异常: ${abnItems}</span>`;}
      if (critItems > 0) {html += `<span style="color:#b71c1c;font-weight:700">🚨 危急: ${critItems}</span>`;}
      html += '</div>';

      // x8 传染病面板：梅毒/丙肝/HIV 阳性高亮图例（区别于乙肝两对半）
      const isX8Inf = isX8InfectionPanel(specimen);
      const hasInfSpecialPos =
        isX8Inf &&
        itemInfo.some(r => {
          const res = r.TextRes && r.TextRes.trim() ? r.TextRes.trim() : r.Result || '';
          return isInfectionSpecialItem(r.CName) && isPositiveResult(res, r);
        });
      if (hasInfSpecialPos) {
        const c = INFECTION_SPECIAL_STYLE;
        html +=
          '<div style="display:flex;gap:12px;align-items:center;padding:4px 0 8px;font-size:11px;flex-wrap:wrap">';
        html += '<span style="color:#555;font-weight:700">⚠ 传染病阳性高亮：</span>';
        html += `<span style="display:inline-flex;align-items:center;gap:5px;font-weight:800;color:#5d3a00"><span style="width:11px;height:11px;border-radius:2px;background:${c.bg};border:1px solid ${c.border};display:inline-block"></span>${INFECTION_SPECIAL_LABEL}</span>`;
        html += '</div>';
      }

      // 结果表格（紧凑布局）
      html += '<table class="result-table" style="font-size:12px">';

      // 收集历史日期
      const allDates = [[], [], []];
      itemInfo.forEach(r => {
        const hi = parsePreResult(r);
        const sorted = [...hi].sort((a, b) => {
          if (!a.date && !b.date) {return 0;}
          if (!a.date) {return 1;}
          if (!b.date) {return -1;}
          return b.date.localeCompare(a.date);
        });
        const recent = sorted.slice(0, 3);
        for (let i = 0; i < 3; i++) {
          if (i < recent.length && recent[i].date) {
            const d = recent[i].date.split(' ')[0].replace(/^\d{2}(\d{2})/, '$1');
            if (d) {allDates[i].push(d);}
          }
        }
      });
      const hdrDates = allDates.map(arr => {
        if (arr.length === 0) {return '';}
        const freq = {};
        arr.forEach(d => {
          freq[d] = (freq[d] || 0) + 1;
        });
        return Object.keys(freq).sort((a, b) => freq[b] - freq[a])[0];
      });
      const thDates = hdrDates
        .map(d => (d ? `<th style="font-size:11px">${esc(d)}</th>` : '<th style="font-size:11px">-</th>'))
        .join('');

      html += `<thead><tr><th style='width:20px'>QC</th><th>项目</th><th>结果</th><th>参考范围</th><th>状态</th>${thDates}</tr></thead>`;
      html += '<tbody>';

      itemInfo.forEach(r => {
        const result = r.TextRes && r.TextRes.trim() ? r.TextRes.trim() : r.Result || '-';
        const unit = r.Unit || r.Units || '';
        const refRange = r.RefRanges || '-';
        const abnormalFlag = (r.AbFlag || '').toUpperCase().trim();

        const rawResult = (r.TextRes && String(r.TextRes).trim() ? r.TextRes : r.Result || '').trim();
        const isEmpty = isEmptyResultValue(r, rawResult);
        let isAbnormal = false,
          isCritical = false;
        let statusText = isEmpty ? '⏳ 待检' : '✓';
        let rowStyle = isEmpty ? 'background:#fafafa;color:#bbb' : '';

        const itemStatus = classifyResultItem(r);
        const criticalByRange = itemStatus === 'CRITICAL';
        const panicStatus = compareResultToPanicRange(result, r);

        if (criticalByRange) {
          isAbnormal = true;
          isCritical = true;
          statusText = abnormalFlag === 'LL' || panicStatus === 'LOW' ? '↓↓ 危急' : '↑↑ 危急';
          rowStyle = 'background:#fff5f5;border-left:3px solid #e74c3c';
        } else if (abnormalFlag === 'H') {
          isAbnormal = true;
          statusText = '↑ 高';
          rowStyle = 'background:#fff8e1;border-left:3px solid #ff9800';
        } else if (abnormalFlag === 'L') {
          isAbnormal = true;
          statusText = '↓ 低';
          rowStyle = 'background:#e3f2fd;border-left:3px solid #2196f3';
        } else if (abnormalFlag === 'A') {
          isAbnormal = true;
          statusText = '⚠ 异常';
          rowStyle = 'background:#fce4ec;border-left:3px solid #e91e63';
        } else if (itemStatus === 'ABNORMAL') {
          isAbnormal = true;
          statusText = '⚠ 异常';
          rowStyle = 'background:#fce4ec;border-left:3px solid #e91e63';
        } else if (itemStatus === 'HIGH') {
          isAbnormal = true;
          statusText = '↑ 高';
          rowStyle = 'background:#fff8e1;border-left:3px solid #ff9800';
        } else if (itemStatus === 'LOW') {
          isAbnormal = true;
          statusText = '↓ 低';
          rowStyle = 'background:#e3f2fd;border-left:3px solid #2196f3';
        } else if (r.ValueLow && r.ValueHigh) {
          const rangeStatus = compareResultToRange(result, r.ValueLow, r.ValueHigh);
          if (rangeStatus === 'HIGH') {
            isAbnormal = true;
            statusText = '↑ 高';
            rowStyle = 'background:#fff8e1;border-left:3px solid #ff9800';
          } else if (rangeStatus === 'LOW') {
            isAbnormal = true;
            statusText = '↓ 低';
            rowStyle = 'background:#e3f2fd;border-left:3px solid #2196f3';
          }
        }

        let statusClass = isAbnormal ? 'abnormal' : 'normal';
        if (isCritical) {statusClass = 'abnormal critical';}
        else if (statusText.includes('高')) {statusClass = 'abnormal high';}
        else if (statusText.includes('低')) {statusClass = 'abnormal low';}

        // x8 传染病面板：梅毒/丙肝/HIV 阳性统一高亮（区别于乙肝两对半）
        if (isX8Inf && !isCritical && isInfectionSpecialItem(r.CName) && isPositiveResult(result, r)) {
          statusClass = 'inf-special';
          rowStyle =
            'background:' +
            INFECTION_SPECIAL_STYLE.bg +
            ';border-left:3px solid ' +
            INFECTION_SPECIAL_STYLE.border +
            ';font-weight:700';
        }

        // 参考范围带单位
        const refWithUnit = unit ? refRange + ' ' + unit : refRange;

        // 历史结果
        const hist = renderHistoryItems(r);

        // QC 状态图标
        let qcHtml = '';
        const qcf = (r.QcFlag || '').split('^');
        const qcs = qcf[0] || '0';
        if (qcs === '0') {
          qcHtml =
            '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid #bbb;background:#f5f5f5" title="未做质控"></span>';
        } else if (qcs === '1') {
          qcHtml =
            '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#4caf50;box-shadow:0 0 4px rgba(76,175,80,.5)" title="质控正常"></span>';
        } else if (qcs === '2') {
          qcHtml =
            '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#ff9800;box-shadow:0 0 4px rgba(255,152,0,.5)" title="质控正常·警告未处理"></span>';
        } else if (qcs === '3') {
          qcHtml =
            '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#e74c3c;box-shadow:0 0 4px rgba(231,76,60,.5)" title="质控正常·失控未处理"></span>';
        } else if (qcs === '4') {
          qcHtml =
            '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#2196f3;box-shadow:0 0 4px rgba(33,150,243,.5)" title="质控正常·警告/失控已处理"></span>';
        } else if (qcs === '5') {
          qcHtml =
            '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#e74c3c;box-shadow:0 0 6px rgba(231,76,60,.7)" title="质控失控"></span>';
        } else if (qcs === '6') {
          qcHtml =
            '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;background:#9e9e9e;box-shadow:0 0 4px rgba(158,158,158,.5)" title="批次过期"></span>';
        } else {
          qcHtml =
            '<span style="display:inline-block;width:14px;height:14px;border-radius:50%;border:2px solid #bbb;background:#f5f5f5" title="未知"></span>';
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
            if (isNaN(diffMs)) {throw new Error('invalid date');}
            const diffH = Math.floor(diffMs / 3600000);
            const diffM = Math.floor((diffMs % 3600000) / 60000);
            timeDelta = diffH > 0 ? diffH + '小时' + diffM + '分' : diffM + '分钟';
          } catch (e) {}
        }

        // 更新深色头部患者详情行
        const extraEl = document.getElementById('lis-detail-extra');
        if (extraEl) {
          extraEl.textContent = buildDetailExtraText(info, specimen);
        }

        // 异常警告（内联）
        if (critItems > 0) {
          html +=
            '<div style="margin-top:6px;padding:6px 10px;background:#fff5f5;border-radius:4px;font-size:11px;border:1px solid #ffcdd2">';
          html += '<span style="color:#e74c3c;font-weight:700">🚨 危急值 ' + critItems + ' 项</span>';
          html += '<span style="margin-left:12px;color:#c62828;font-size:10px">须在原始LIS中审核</span>';
          html += '</div>';
        } else if (abnItems > 0) {
          // 列出具体异常项目名称
          const abnNames = itemInfo
            .filter(r => classifyResultItem(r) !== 'NORMAL' && classifyResultItem(r) !== 'UNCERTAIN')
            .map(r => {
              const st = classifyResultItem(r);
              const arrow =
                st === 'CRITICAL'
                  ? compareResultToPanicRange(r.TextRes && r.TextRes.trim() ? r.TextRes : r.Result, r) === 'LOW' ||
                    String(r.AbFlag || '').toUpperCase() === 'LL'
                    ? '↓↓危急'
                    : '↑↑危急'
                  : st === 'HIGH'
                    ? '↑'
                    : st === 'LOW'
                      ? '↓'
                      : '⚠';
              return esc((r.CName || '') + ' ' + (r.TextRes || r.Result || '') + ' ' + arrow);
            });
          html +=
            '<div style="margin-top:6px;padding:6px 10px;background:#fff8e1;border-radius:4px;font-size:11px;border:1px solid #ffecb3">';
          html += '<span style="color:#ff9800;font-weight:600">⚠ 异常项目 ' + abnItems + ' 项</span>';
          if (abnNames.length > 0)
          {html += '<span style="margin-left:8px;color:#e65100;font-size:10px">' + abnNames.join('、') + '</span>';}
          html += '</div>';
        }

        // 传染病历史比对
        const cached = wsClassifiedCache[specimen.ReportDR];
        if (cached && cached.infectionWarning) {
          html +=
            '<div style="margin-top:6px;padding:6px 10px;background:#fff3e0;border-radius:4px;font-size:11px;border:1px solid #ffcc80">';
          html += '<span style="color:#e65100;font-weight:700">⚠️ 与历史结果不一致</span>';
          html += '<div style="color:#bf360c;font-size:10px;margin-top:2px">' + esc(cached.infectionWarning) + '</div>';
          html += '</div>';
        }
      }

      if (!isCurrentDetail()) {return;}
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
      if (!isCurrentDetail()) {return;}
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
      if (!raw) {return;}
      const tgt = JSON.parse(raw);
      if (!tgt || Date.now() - tgt.time > 30000) {
        localStorage.removeItem(K.tgt);
        return;
      }
      localStorage.removeItem(K.tgt);

      const curDR = wgDR();
      if (tgt.wgDR !== curDR) {return;} // 工作组不匹配，可能还在切换中

      // 延迟执行，等待页面完全加载
      setTimeout(() => {
        try {
          const w = uw();
          if (tgt.machineDR && w.me) {
            w.me.WorkGroupMachineDR = tgt.machineDR;
            if (typeof w.$ !== 'undefined') {
              try {
                w.$('#cmb_WorkGroupMachine').combogrid('setValue', tgt.machineDR);
              } catch (e) {}
            }
          }
          if (tgt.labno) {
            if (typeof w.$ !== 'undefined') {
              try {
                w.$('#txt_FindFast').val(tgt.labno);
              } catch (e) {}
            }
            if (typeof w.FindFast === 'function') {
              w.FindFast(tgt.labno);
            }
          }
          // 等待搜索结果加载并选中对应行
          setTimeout(() => {
            try {
              const iframeWin = getReportIframeWin();
              if (!iframeWin) {return;}
              const jq = iframeWin.jQuery || iframeWin.$;
              if (!jq) {return;}
              const dg = jq('#dgWorkList');
              if (!dg.length) {return;}
              const rows = dg.datagrid('getRows');
              if (!rows || rows.length === 0) {return;}
              // 根据 ReportDR 或 Labno 选中对应行
              for (let i = 0; i < rows.length; i++) {
                if (String(rows[i].ReportDR) === String(tgt.reportDR) || String(rows[i].Labno) === String(tgt.labno)) {
                  dg.datagrid('selectRow', i);
                  dbg('导航: 已选中行', i, 'ReportDR:', tgt.reportDR);
                  break;
                }
              }
            } catch (e) {
              dbg('导航选行失败:', e);
            }
          }, 1500);
        } catch (e) {}
      }, 1500);
    } catch (e) {}
  }

  // --- 创建工作台 UI ---
  function createWS() {
    if (document.getElementById('lis-ws')) {return;} // 防止重复创建
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
        fab.style.left = wp.l + 'px';
        fab.style.top = wp.t + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
      }
    } catch (e) {}
    document.body.appendChild(fab);

    const tip = document.createElement('div');
    tip.id = 'lis-fab-tip';
    tip.textContent = '点击打开审核工作台';
    document.body.appendChild(tip);

    // 拖动功能（pointer events）
    let fabDragging = false,
      fabMoved = false,
      fabStartX,
      fabStartY,
      fabOrigX,
      fabOrigY;
    fab.addEventListener('pointerdown', e => {
      fabDragging = true;
      fabMoved = false;
      fabStartX = e.clientX;
      fabStartY = e.clientY;
      fabOrigX = fab.offsetLeft;
      fabOrigY = fab.offsetTop;
      fab.setPointerCapture(e.pointerId);
      fab.style.transition = 'none';
      e.preventDefault();
    });
    fab.addEventListener('pointermove', e => {
      if (!fabDragging) {return;}
      const dx = e.clientX - fabStartX,
        dy = e.clientY - fabStartY;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) {fabMoved = true;}
      if (fabMoved) {
        fab.style.left = Math.max(0, fabOrigX + dx) + 'px';
        fab.style.top = Math.max(0, fabOrigY + dy) + 'px';
        fab.style.right = 'auto';
        fab.style.bottom = 'auto';
      }
    });
    fab.addEventListener('pointerup', () => {
      fabDragging = false;
      fab.style.transition = '';
      if (fabMoved) {
        try {
          localStorage.setItem('lis-fab-pos', JSON.stringify({ l: fab.offsetLeft, t: fab.offsetTop }));
        } catch (e) {}
      }
    });
    // 点击（拖动后不触发）
    fab.addEventListener('click', e => {
      if (!fabMoved) {openWS();}
    });
    fab.addEventListener('mouseenter', () => tip.classList.add('show'));
    fab.addEventListener('mouseleave', () => tip.classList.remove('show'));

    // 键盘快捷键
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') {
        closeWS();
        closePwdDlg();
      }
    });
  }

  function toggleWS() {
    if ($('#lis-ws').classList.contains('show')) {closeWS();}
    else {openWS();}
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
        if (auditPwd) {await savePwdAsync(auditPwd);}
        if (caPwd) {await saveCAPwdAsync(caPwd);}
        document.getElementById('lis-pwds').innerHTML = '<span style="color:#27ae60">✓ 已保存</span>';
        document.getElementById('lis-cawds').innerHTML = '<span style="color:#27ae60">✓ 已保存</span>';
        toast('密码已保存');
        setTimeout(closePwdDlg, 600);
      });
      document.getElementById('lis-pwdc').addEventListener('click', () => {
        try {
          localStorage.removeItem(K.pwd);
          localStorage.removeItem(K.caPwd);
        } catch (e) {}
        document.getElementById('lis-pwdi').value = '';
        document.getElementById('lis-cawdi').value = '';
        document.getElementById('lis-pwds').innerHTML = '<span style="color:#e74c3c">✓ 已清除</span>';
        document.getElementById('lis-cawds').innerHTML = '<span style="color:#e74c3c">✓ 已清除</span>';
        toast('密码已清除', 'w');
      });
      document.getElementById('lis-pwdca').addEventListener('click', closePwdDlg);
      o.addEventListener('click', e => {
        if (e.target === o) {closePwdDlg();}
      });
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
  function closePwdDlg() {
    const o = document.getElementById('lis-pwdo');
    if (o) {o.classList.remove('show');}
  }

  // ============================================================
  //  模块 E：登录页优化
  // ============================================================
  const LOGIN_CREDS_KEY = 'LIS_LoginCreds';
  const LOGIN_WG_KEY = 'LIS_LastWorkGroup';
  let _loginSubmitTimer = null; // fillNativeAndSubmit 的定时器，页面卸载时清理

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
      if (!raw) {return null;}
      const obj = JSON.parse(decPwd(raw));
      return obj && obj.user ? obj : null;
    } catch (e) {
      return null;
    }
  }

  function saveLoginCreds(user, wg) {
    try {
      const obj = { user: user, ts: Date.now() };
      localStorage.setItem(LOGIN_CREDS_KEY, encPwd(JSON.stringify(obj)));
      if (wg) {localStorage.setItem(LOGIN_WG_KEY, wg);}
    } catch (e) {}
  }

  function clearLoginCreds() {
    try {
      localStorage.removeItem(LOGIN_CREDS_KEY);
    } catch (e) {}
  }

  function createLoginPanel(creds, lastWG) {
    const box = document.createElement('div');
    box.id = 'lis-login-box';

    const wgs = [
      { dr: '4', name: '免疫', color: '#2ecc71', icon: '🛡️' },
      { dr: '1', name: '临检', color: '#e74c3c', icon: '🩸' },
      { dr: '3', name: '生化', color: '#3498db', icon: '🧪' }
    ];

    let wgHTML = '';
    wgs.forEach(w => {
      wgHTML += `<button type="button" data-dr="${w.dr}" style="border-color:${w.dr === lastWG ? w.color : '#e0e0e0'};background:${w.dr === lastWG ? w.color : '#fff'};color:${w.dr === lastWG ? '#fff' : '#333'}">${w.icon} ${w.name}</button>`;
    });

    box.innerHTML = `
            <h4>⚡ 快速登录 — iMedicalLIS</h4>
            <div class="lis-lb-row">
                <label>用户名</label>
                <input type="text" id="lis-lu" placeholder="用户名" value="${creds ? esc(creds.user) : ''}" autocomplete="username" />
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

    // 拖拽移动（标题栏作为拖拽手柄）
    const dragHead = box.querySelector('h4');
    let boxUserMoved = false;
    dragHead.addEventListener('pointerdown', e => {
      e.preventDefault();
      // 将 right/top+transform 定位转为 left/top 绝对定位
      if (!boxUserMoved) {
        box.style.left = box.offsetLeft + 'px';
        box.style.top = box.offsetTop + 'px';
        box.style.right = 'auto';
        box.style.transform = 'none';
      }
      box.classList.add('dragging');
      document.body.style.userSelect = 'none';
      const startX = e.clientX, startY = e.clientY;
      const startLeft = box.offsetLeft, startTop = box.offsetTop;
      const w = box.offsetWidth, h = box.offsetHeight;
      dragHead.setPointerCapture(e.pointerId);
      const onMove = ev => {
        const vw = window.innerWidth, vh = window.innerHeight;
        box.style.left = Math.max(0, Math.min(startLeft + ev.clientX - startX, vw - w)) + 'px';
        box.style.top = Math.max(0, Math.min(startTop + ev.clientY - startY, vh - h)) + 'px';
      };
      const onUp = ev => {
        try { dragHead.releasePointerCapture(ev.pointerId); } catch (x) {}
        dragHead.removeEventListener('pointermove', onMove);
        dragHead.removeEventListener('pointerup', onUp);
        dragHead.removeEventListener('pointercancel', onUp);
        box.classList.remove('dragging');
        document.body.style.userSelect = '';
        boxUserMoved = true;
        // 保存位置
        try {
          localStorage.setItem('lis-login-pos', JSON.stringify({ left: box.style.left, top: box.style.top }));
        } catch (x) {}
      };
      dragHead.addEventListener('pointermove', onMove);
      dragHead.addEventListener('pointerup', onUp);
      dragHead.addEventListener('pointercancel', onUp);
    });
    // 恢复上次拖拽位置
    try {
      const saved = JSON.parse(localStorage.getItem('lis-login-pos') || 'null');
      if (saved && saved.left && saved.top) {
        box.style.left = saved.left;
        box.style.top = saved.top;
        box.style.right = 'auto';
        box.style.transform = 'none';
      }
    } catch (x) {}

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
        btn.style.background = btn.style.borderColor =
          (wgs.find(w => w.dr === btn.dataset.dr) || {}).color || '#e0e0e0';
        btn.style.color = '#fff';
        selectedWG = btn.dataset.dr;
      });
    });

    // 登录按钮
    const loginBtn = document.getElementById('lis-lbtn');
    loginBtn.addEventListener('click', () => doLogin(selectedWG));

    // Enter 快捷键
    box.addEventListener('keydown', e => {
      if (e.key === 'Enter') {doLogin(selectedWG);}
    });

    // 如果有保存的凭证，聚焦到登录按钮
    if (creds) {
      loginBtn.focus();
    }
  }

  function doLogin(wgDR) {
    const luEl = document.getElementById('lis-lu');
    const lpEl = document.getElementById('lis-lp');
    if (!luEl || !lpEl) {return;}
    const user = luEl.value.trim();
    const pwd = lpEl.value;
    if (!user || !pwd) {
      toast('请输入用户名和密码', 'w');
      return;
    }

    const btn = document.getElementById('lis-lbtn');
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ 登录中...';
    }

    // 只保存用户名
    saveLoginCreds(user, wgDR);
    try {
      localStorage.setItem(LOGIN_WG_KEY, wgDR);
    } catch (e) {}

    // 必须走原生表单流程（服务器需要先 checkUser 创建安全组会话）
    fillNativeAndSubmit(user, pwd, wgDR);
  }
  function fillNativeLoginForm(creds, lastWG) {
    try {
      const userField = document.getElementById('txtUserCode');
      const wgSelect = document.getElementById('cmbWorkGroup');

      if (creds && userField && !userField.value) {
        userField.value = creds.user;
        userField.dispatchEvent(new Event('input', { bubbles: true }));
        userField.dispatchEvent(new Event('change', { bubbles: true }));
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
    } catch (e) {}
  }

  function fillNativeAndSubmit(user, pwd, wgDR) {
    try {
      const userField = document.getElementById('txtUserCode');
      const pwdField = document.getElementById('txtPassword');

      // 1. 填充用户名
      if (userField) {
        userField.value = user;
        userField.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // 2. 填充密码
      if (pwdField) {
        pwdField.value = pwd;
        pwdField.type = 'password';
        pwdField.dispatchEvent(new Event('input', { bubbles: true }));
      }

      // 3. 触发 checkUser() —— 关键！验证用户并加载工作组/安全组列表
      if (pwdField) {
        pwdField.dispatchEvent(new Event('blur', { bubbles: true }));
      }
      if (typeof checkUser === 'function') {
        checkUser();
      }

      // 4. 等待工作组列表加载完成后自动选择并提交
      let attempts = 0;
      _loginSubmitTimer = setInterval(() => {
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
          clearInterval(_loginSubmitTimer);
          wgSelect.value = wgDR;
          wgSelect.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(() => {
            const btn = document.getElementById('btnOK');
            if (typeof login === 'function') {login(btn);}
            else if (btn) {btn.click();}
          }, 300);
        } else if (hasOptions) {
          clearInterval(_loginSubmitTimer);
          dbg('未找到工作组DR=' + wgDR + '，使用第一个');
          wgSelect.selectedIndex = 1;
          wgSelect.dispatchEvent(new Event('change', { bubbles: true }));
          setTimeout(() => {
            const btn = document.getElementById('btnOK');
            if (typeof login === 'function') {login(btn);}
            else if (btn) {btn.click();}
          }, 300);
        } else if (attempts >= 20) {
          clearInterval(_loginSubmitTimer);
          toast('工作组加载超时，请手动选择', 'w');
          const btn = document.getElementById('lis-lbtn');
          if (btn) {
            btn.disabled = false;
            btn.textContent = '🚀 登录';
          }
        }
      }, 500);
    } catch (e) {
      dbg('登录出错:', e);
      toast('自动登录出错，请手动登录', 'e');
      const btn = document.getElementById('lis-lbtn');
      if (btn) {
        btn.disabled = false;
        btn.textContent = '🚀 登录';
      }
    }
  }

  //  模块 C2：报告处理页增强工具栏（审核流程优化核心）
  // ============================================================

  // 分类结果（模块级，避免全局污染）
  let _toolbarClassifiedRows = null;
  let _toolbarClassifiedResults = null;

  // --- 样式注入 ---
  GM_addStyle(`
/* --- 增强工具栏 --- */
#lis-toolbar{position:fixed;top:0;left:50%;transform:translateX(-50%);z-index:100010;background:rgba(26,82,118,.95);backdrop-filter:blur(6px);padding:3px 12px;display:none;align-items:center;gap:6px;font-family:var(--lis-font);border-radius:0 0 8px 8px;box-shadow:0 2px 8px rgba(0,0,0,.3);transition:transform .2s,opacity .2s}
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
  const _toolbarVisible = false;
  let _auditInProgress = false;
  let _batchAbort = false;
  let _auditAbortFlag = false;
  let _auditLockTs = 0;
  let _auditLockId = 0;
  let _auditAbortedLockId = 0; // 被强制释放的锁代际：持该 id 的旧操作应在下一检查点自行退出
  const AUDIT_LOCK_TIMEOUT = 45000; // 45秒超时后强制释放，避免卡死无法恢复
  function acquireAuditLock(tag) {
    if (_auditInProgress && Date.now() - _auditLockTs > AUDIT_LOCK_TIMEOUT) {
      dbg('审核锁持有超过', AUDIT_LOCK_TIMEOUT / 1000, '秒，可能卡死，强制释放 (held by', tag, ')');
      // 记录被中止的锁代际：旧操作通过 isAuditLockAborted(自己的id) 在下一检查点退出，
      // 不再用全局 flag（全局 flag 会被本函数同步清掉，旧操作永远看不到，会并发双审）
      _auditAbortedLockId = _auditLockId;
      _auditInProgress = false;
      _auditLockTs = 0;
      showToast('上次审核操作可能已卡死，已强制释放锁，可重新开始', 'warning');
    }
    if (_auditInProgress) {return false;}
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
  // 锁心跳：长操作（整批审核可能跑数分钟）每条刷新一次，避免健康操作被误判卡死抢锁
  function refreshAuditLock(lockId) {
    if (lockId && lockId === _auditLockId) {_auditLockTs = Date.now();}
  }
  // 代际中止判定：本操作持有的锁是否已被强制释放
  function isAuditLockAborted(lockId) {
    return !!(lockId && _auditAbortedLockId === lockId) || _auditAbortFlag;
  }

  // --- 检测是否在报告处理页面 ---
  function isReportPageActive() {
    // 检查是否在主框架中
    try {
      if (window !== window.top) {return false;}
    } catch (e) {
      return false;
    }
    if (getReportIframeWin()) {return true;}
    return [...document.querySelectorAll('a')].some(a => (a.textContent || '').trim() === '报告处理');
  }

  // --- 获取原生 EasyUI datagrid 的行数据 ---
  function getNativeDatagridRows() {
    const w = uw();
    if (!w.$) {return [];}
    // 尝试多种选择器找到 datagrid
    const selectors = DATAGRID_SELECTORS_EXTENDED;
    for (const sel of selectors) {
      try {
        const el = w.$(sel);
        if (el.length) {
          // 尝试直接获取 datagrid 数据
          if (el.datagrid) {
            const rows = el.datagrid('getRows');
            if (rows && rows.length > 0) {return rows;}
          }
          // 也检查子元素
          const dgs = el.find('.datagrid-f');
          for (let i = 0; i < dgs.length; i++) {
            try {
              const rows = w.$(dgs[i]).datagrid('getRows');
              if (rows && rows.length > 0) {return rows;}
            } catch (e) {}
          }
        }
      } catch (e) {}
    }
    // 回退：搜索所有 datagrid 元素
    try {
      const dgs = w.$('.datagrid-f, .datagrid-view');
      for (let i = 0; i < dgs.length; i++) {
        try {
          const rows = w.$(dgs[i]).datagrid('getRows');
          if (rows && rows.length > 0) {return rows;}
        } catch (e) {}
      }
    } catch (e) {}
    return [];
  }

  // --- 获取当前选中的行 ---
  function getNativeSelectedRow() {
    const w = uw();
    if (!w.$) {return null;}
    const selectors = DATAGRID_SELECTORS;
    for (const sel of selectors) {
      const el = w.$(sel);
      if (el.length && el.datagrid) {
        try {
          const selected = el.datagrid('getSelected');
          if (selected) {return selected;}
        } catch (e) {}
      }
    }
    return null;
  }

  // --- 选中指定行 ---
  function selectNativeRow(index) {
    const w = uw();
    if (!w.$) {return false;}
    const selectors = DATAGRID_SELECTORS;
    for (const sel of selectors) {
      const el = w.$(sel);
      if (el.length && el.datagrid) {
        try {
          el.datagrid('selectRow', index);
          return true;
        } catch (e) {}
      }
    }
    return false;
  }

  // --- 触发行点击（加载详情）---
  function triggerNativeRowClick(index) {
    const w = uw();
    if (!w.$) {return;}
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
        } catch (e) {}
      }
    }
    return false;
  }

  // --- 获取报告处理 iframe 的 contentWindow（同步版）---
  function getReportIframeWin() {
    // 优先：当前窗口就有 ReportSave（脚本运行在 iframe 内）
    if (typeof ReportSave === 'function') {return window;}
    // 优先搜索 iframe_1172（报告处理页面）— 确保返回 iframe 窗口（含 me 对象）
    // 必须校验仍是报告页：iframe 被 LIS 复用/导航后 id 还在但内容已换，直接返回会把审核点击落到错误页面
    const iframe = document.getElementById('iframe_1172');
    if (iframe && iframe.contentWindow) {
      try {
        const cw = iframe.contentWindow;
        const cdoc = cw.document;
        if (
          cdoc &&
          (typeof cw.ReportSave === 'function' ||
            cw.me ||
            cdoc.getElementById('btn_ReportAuth') ||
            cdoc.getElementById('btn_ReportSave'))
        ) {
          return cw;
        }
        dbg('iframe_1172 已不在报告页，回退全局扫描');
      } catch (e) {}
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
      } catch (e) {}
    }
    // 回退：unsafeWindow 有 ReportSave（可能返回主页面窗口，缺少 me 对象）
    try {
      if (typeof uw().ReportSave === 'function') {return uw();}
    } catch (e) {}
    return null;
  }

  // --- 确保报告处理页面已加载（异步版）---
  function ensureReportPageLoaded(options = {}) {
    const existing = getReportIframeWin();
    if (existing) {return Promise.resolve(existing);}
    if (_reportPageLoadPromise && !options.force) {
      return _reportPageLoadPromise.then(w => w || getReportIframeWin());
    }
    const fast = !!options.fast;
    const pollMs = fast ? 60 : 150;
    const maxWait = fast ? 12000 : 15000;
    const run = () =>
      new Promise(resolve => {
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
            if (options.keepWS) {keepWorkbenchOnTop('报告处理页加载完成');}
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
      _reportPageLoadPromise = run().finally(() => {
        _reportPageLoadPromise = null;
      });
      return _reportPageLoadPromise;
    }
    return run();
  }

  // --- 确保 me.selectedGrid 有值（选中工作列表当前行）---
  function ensureSelectedGrid(iframeWin) {
    if (!iframeWin || !iframeWin.me) {return false;}
    // 已经有选中行
    if (iframeWin.me.selectedGrid) {return true;}
    // 尝试找到工作列表 datagrid 并选中第一行
    try {
      const jq = iframeWin.jQuery || iframeWin.$;
      if (!jq) {return false;}
      const wl = jq('#dgWorkList');
      if (wl.length && wl.datagrid) {
        const rows = wl.datagrid('getRows');
        if (rows && rows.length > 0) {
          wl.datagrid('selectRow', 0);
          iframeWin.me.selectedGrid = wl;
          return true;
        }
      }
    } catch (e) {
      dbg('ensureSelectedGrid error:', e);
    }
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
    } catch (e) {}
  }

  function getNativeWorkListSelectedDR(iframeWin) {
    try {
      const jq = iframeWin && (iframeWin.jQuery || iframeWin.$);
      if (!jq) {return '';}
      const wl = jq(NATIVE_WORKLIST_SEL);
      if (!wl.length || !wl.datagrid) {return '';}
      const selected = wl.datagrid('getSelected');
      return selected ? String(selected.ReportDR || '') : '';
    } catch (e) {
      return '';
    }
  }

  function isScriptOwnedNativeSelection() {
    return !!(_auditInProgress || _abnormalAuditInProgress || _detailAuditInProgress);
  }

  function clearNativeUserSelectLock() {
    _nativeUserSelectDR = '';
    _nativeUserSelectAt = 0;
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
    if (isScriptOwnedNativeSelection()) {return true;}
    // 待审工作台驱动审核时，原生自动跳下一条不算用户手动选行
    if (wsCategory === 'audit' && isWSVisible()) {return true;}
    const target = String(reportDR || '');
    if (!target) {return false;}
    const selDR = getNativeWorkListSelectedDR(iframeWin);
    if (selDR && selDR !== target) {return false;}
    if (_nativeUserSelectDR && _nativeUserSelectAt && Date.now() - _nativeUserSelectAt < 30000) {
      if (_nativeUserSelectDR !== target) {return false;}
    }
    return true;
  }

  function installNativeDetailGuard(iframeWin) {
    if (!iframeWin || iframeWin.__lisEnhancerGuard) {return !!iframeWin.__lisEnhancerGuard;}
    const jq = iframeWin.jQuery || iframeWin.$;
    if (!jq) {return false;}
    try {
      installNativeStatExceptionGuard(iframeWin);
      const wl = jq(NATIVE_WORKLIST_SEL);
      if (wl.length && wl.datagrid) {
        const opts = wl.datagrid('options') || {};
        if (!opts.__lisOnSelectWrapped) {
          const origOnSelect = opts.onSelect;
          opts.onSelect = function (rowIndex, rowData) {
            if (rowData && rowData.ReportDR) {onNativeUserRowSelect(rowData.ReportDR);}
            if (typeof origOnSelect === 'function') {return origOnSelect.apply(this, arguments);}
          };
          opts.__lisOnSelectWrapped = true;
        }
      }
      if (!jq.__lisDetailAjaxGuard) {
        jq.ajaxPrefilter(function (options) {
          const d = options && options.data;
          if (!d || d.QueryName !== 'GetReportInfoAll') {return;}
          const captured = String(d.P0 || '');
          const origSuccess = options.success;
          options.success = function (RetData, textStatus) {
            const me = iframeWin.me;
            const cur = String((me && me.curReportDR) || '');
            const sel = getNativeWorkListSelectedDR(iframeWin);
            if (captured && cur !== captured && sel !== captured) {
              dbg('丢弃过期标本详情响应:', captured, 'cur=', cur, 'sel=', sel);
              try {
                if (typeof iframeWin.ajaxLoadEnd === 'function') {iframeWin.ajaxLoadEnd();}
              } catch (e) {}
              return;
            }
            const ret = origSuccess ? origSuccess.apply(this, arguments) : undefined;
            if (wsCategory === 'audit') {
              setTimeout(() => scheduleAbnormalFocusRecovery(), 30);
            }
            return ret;
          };
        });
        jq.__lisDetailAjaxGuard = true;
      }
      iframeWin.__lisEnhancerGuard = true;
      dbg('原生详情防竞态已安装');
      return true;
    } catch (e) {
      dbg('安装原生详情防护失败:', e.message);
      return false;
    }
  }

  function scheduleNativeDetailGuardInstall() {
    if (_nativeGuardTimer) {return;}
    let attempts = 0;
    const tick = () => {
      const w = getReportIframeWin();
      if (w && installNativeDetailGuard(w)) {
        _nativeGuardTimer = null;
        return;
      }
      attempts++;
      if (attempts < 120) {_nativeGuardTimer = setTimeout(tick, 500);}
      else {_nativeGuardTimer = null;}
    };
    tick();
  }

  function findNativeRowByReportDR(iframeWin, reportDR) {
    if (!iframeWin || !reportDR) {return null;}
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
    } catch (e) {}

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
    } catch (e) {}

    if (!jq) {return null;}
    const selectors = DATAGRID_SELECTORS;
    for (const sel of selectors) {
      try {
        const el = jq(sel);
        if (!el.length || !el.datagrid) {continue;}
        const rows = el.datagrid('getRows') || [];
        for (let i = 0; i < rows.length; i++) {
          if (String(rows[i].ReportDR || '') === target) {
            return { row: rows[i], index: i, grid: el };
          }
        }
      } catch (e) {}
    }
    return null;
  }

  function classifyNativeMessage(text) {
    const t = (text || '').trim();
    if (!t) {return '';}
    if (
      t.indexOf('必填项目') !== -1 ||
      t.indexOf('未存数据') !== -1 ||
      t.indexOf('结果为空') !== -1 ||
      t.indexOf('结果不完整') !== -1 ||
      t.indexOf('无结果') !== -1 ||
      t.indexOf('没有结果') !== -1 ||
      t.indexOf('未录入') !== -1 ||
      t.indexOf('请录入') !== -1
    ) {
      return 'incomplete';
    }
    if (t.indexOf('成功') !== -1 && t.indexOf('失败') === -1 && t.indexOf('错误') === -1) {return 'success';}
    if (
      t.indexOf('密码错误') !== -1 ||
      t.indexOf('认证失败') !== -1 ||
      t.indexOf('账号锁定') !== -1 ||
      t.indexOf('失败') !== -1 ||
      t.indexOf('错误') !== -1 ||
      t.indexOf('不允许') !== -1 ||
      t.indexOf('未通过') !== -1
    ) {
      return 'failure';
    }
    return '';
  }

  function readNativeMessageResult(doc, jq) {
    try {
      const allWins = doc.querySelectorAll(
        '.messager-window:not([style*="display: none"]), .window:not([style*="display: none"])'
      );
      for (const w of allWins) {
        if (w.offsetParent === null) {continue;}
        const body = w.querySelector('.messager-body, .panel-body');
        if (!body) {continue;}
        const text = (body.textContent || '').trim();
        const kind = classifyNativeMessage(text);
        if (!kind) {continue;}

        const btns = w.querySelectorAll('a.l-btn, button');
        for (const b of btns) {
          const bText = (b.textContent || b.value || '').trim();
          if (kind === 'incomplete' && (bText === '取消' || bText === 'No' || bText === '否' || bText === '关闭')) {
            try {
              jq(b).click();
            } catch (e) {}
            break;
          }
          if (kind !== 'incomplete' && (bText === '确定' || bText === 'OK' || bText === '关闭' || bText === '是')) {
            try {
              jq(b).click();
            } catch (e) {}
            break;
          }
        }
        return kind;
      }
    } catch (e) {}
    return '';
  }

  function isIgnorableNativeStatException(text) {
    const t = String(text || '');
    if (!t) {return false;}
    const hasStatMethod = t.indexOf('DHCStatVisitNumItm') !== -1 || t.indexOf('zStatVisitStatusMTHD') !== -1;
    const hasIndexAuthDate = t.indexOf('IndexAuthDate') !== -1 || t.indexOf('RPVisitNumberReportI') !== -1;
    const hasSubscript =
      t.indexOf('SUBSCRIPT') !== -1 || t.indexOf('ZSUBSCRIPT') !== -1 || t.indexOf('系统发生异常') !== -1;
    return hasStatMethod && hasIndexAuthDate && hasSubscript;
  }

  function closeIgnorableNativeExceptionDialogs(doc, jq) {
    let closed = false;
    try {
      const allWins = doc.querySelectorAll(
        '.messager-window:not([style*="display: none"]), .window:not([style*="display: none"])'
      );
      for (const w of allWins) {
        if (w.offsetParent === null) {continue;}
        const text = (w.textContent || '').trim();
        if (!isIgnorableNativeStatException(text)) {continue;}
        const btns = w.querySelectorAll('a.l-btn, button');
        for (const b of btns) {
          const bText = (b.textContent || b.value || '').trim();
          if (bText === '确定' || bText === 'OK' || bText === '关闭' || bText === '是') {
            try {
              jq && jq(b).click ? jq(b).click() : b.click();
            } catch (e) {
              try {
                b.click();
              } catch (e2) {}
            }
            closed = true;
            break;
          }
        }
        try {
          if (!closed && jq) {
            const panel = jq(w);
            const closeBtn = panel.find('.panel-tool-close');
            if (closeBtn.length) {
              closeBtn.click();
              closed = true;
            }
          }
        } catch (e) {}
        if (closed) {dbg('已关闭原始 LIS 统计异常弹窗（不影响审核结果确认）');}
      }
    } catch (e) {}
    return closed;
  }

  function installNativeStatExceptionGuard(iframeWin) {
    if (!iframeWin) {return;}
    try {
      const doc = iframeWin.document;
      if (doc && !iframeWin.__lisStatExceptionPageGuard) {
        const s = doc.createElement('script');
        s.setAttribute('data-lis-enhancer', 'stat-exception-guard');
        s.textContent = `(function(){
  if(window.__lisStatExceptionPageGuard)return;
  window.__lisStatExceptionPageGuard=true;
  function ignorable(text){
    var t=String(text||'');
    if(!t)return false;
    var hasStat=t.indexOf('DHCStatVisitNumItm')!==-1||t.indexOf('zStatVisitStatusMTHD')!==-1;
    var hasDate=t.indexOf('IndexAuthDate')!==-1||t.indexOf('RPVisitNumberReportI')!==-1;
    var hasSub=t.indexOf('SUBSCRIPT')!==-1||t.indexOf('ZSUBSCRIPT')!==-1||t.indexOf('系统发生异常')!==-1;
    return hasStat&&hasDate&&hasSub;
  }
  var oldAlert=window.alert;
  window.alert=function(msg){
    if(ignorable(msg)){window.__lisLastIgnoredStatException=String(msg||'').slice(0,500);return;}
    return oldAlert.apply(this,arguments);
  };
  function patchMessager(){
    try{
      var jq=window.jQuery||window.$;
      if(!jq||!jq.messager||typeof jq.messager.alert!=='function'||jq.messager.__lisStatExceptionPageGuard)return;
      var old=jq.messager.alert;
      jq.messager.alert=function(title,msg){
        if(ignorable(title)||ignorable(msg)){window.__lisLastIgnoredStatException=String(msg||title||'').slice(0,500);return;}
        return old.apply(this,arguments);
      };
      jq.messager.__lisStatExceptionPageGuard=true;
    }catch(e){}
  }
  patchMessager();
  setTimeout(patchMessager,300);
  setTimeout(patchMessager,1200);
})();`;
        (doc.head || doc.documentElement).appendChild(s);
        s.remove();
        iframeWin.__lisStatExceptionPageGuard = true;
      }
    } catch (e) {}
    try {
      if (!iframeWin.__lisStatAlertGuard) {
        const origAlert = iframeWin.alert;
        iframeWin.__lisOriginalAlert = iframeWin.__lisOriginalAlert || origAlert;
        iframeWin.alert = function (msg) {
          if (isIgnorableNativeStatException(msg)) {
            try {
              iframeWin.__lisLastIgnoredStatException = String(msg || '').slice(0, 500);
            } catch (e) {}
            dbg('已拦截原始 LIS 统计异常 alert（不影响审核结果确认）');
            return;
          }
          return origAlert.apply(this, arguments);
        };
        iframeWin.__lisStatAlertGuard = true;
      }
    } catch (e) {}
    try {
      const jq = iframeWin.jQuery || iframeWin.$;
      if (jq && jq.messager && typeof jq.messager.alert === 'function' && !jq.messager.__lisStatExceptionGuard) {
        const origMessagerAlert = jq.messager.alert;
        jq.messager.alert = function (title, msg) {
          if (isIgnorableNativeStatException(title) || isIgnorableNativeStatException(msg)) {
            try {
              iframeWin.__lisLastIgnoredStatException = String(msg || title || '').slice(0, 500);
            } catch (e) {}
            dbg('已拦截原始 LIS 统计异常 messager（不影响审核结果确认）');
            return;
          }
          return origMessagerAlert.apply(this, arguments);
        };
        jq.messager.__lisStatExceptionGuard = true;
      }
    } catch (e) {}
  }

  function isNativeButtonDisabled(btn, jq) {
    if (!btn) {return true;}
    try {
      if (btn.disabled) {return true;}
      if (btn.getAttribute('disabled') !== null) {return true;}
      const cls = String(btn.className || '');
      if (/\bl-btn-disabled\b|\bdisabled\b/.test(cls)) {return true;}
      const parent = btn.closest && btn.closest('.l-btn');
      if (parent && /\bl-btn-disabled\b|\bdisabled\b/.test(String(parent.className || ''))) {return true;}
      if (jq && jq(btn).hasClass && (jq(btn).hasClass('l-btn-disabled') || jq(btn).hasClass('disabled'))) {return true;}
    } catch (e) {}
    return false;
  }

  async function waitNativeActionResult(
    iframeWin,
    targetReportDR,
    expectedStatuses,
    timeoutMs,
    missingAsSuccess = false,
    options = {}
  ) {
    const doc = iframeWin ? iframeWin.document : document;
    const jq = iframeWin ? iframeWin.jQuery || iframeWin.$ : window.jQuery;
    let me = iframeWin ? iframeWin.me : null;
    const started = Date.now();
    const end = started + timeoutMs;
    const turbo = !!options.turbo;
    const fastEnd = started + (turbo ? 2500 : 500);
    let sawTargetRow = !!options.targetWasPresent;
    let missingSince = 0;
    let failureSince = 0;
    let lastTickAt = 0;
    let sawSaveSuccess = false;
    const ignoreMessages = !!options.ignoreMessages;
    const missingStableMs = Number(options.missingStableMs || 700);
    // 批审秒审：失败提示的 grace 更短，避免「假失败横幅」拖满整条超时
    const failureGraceMs = Number(options.failureGraceMs || (turbo ? 1200 : 2500));
    if (targetReportDR && !sawTargetRow) {
      try {
        sawTargetRow = !!findNativeRowByReportDR(iframeWin, targetReportDR);
      } catch (e) {}
    }

    while (Date.now() < end) {
      if (options.abortCheck && options.abortCheck()) {
        dbg('waitNativeActionResult: 中止信号');
        return false;
      }
      const now = Date.now();
      const elapsed = now - started;
      if (typeof options.onTick === 'function' && now - lastTickAt >= 800) {
        lastTickAt = now;
        try {
          options.onTick(elapsed);
        } catch (e) {}
      }
      // 每隔约 1s 做一次跨路径快速成功校验（解决「后台已审成、UI 状态慢半拍」的假卡顿）
      if (typeof options.quickVerify === 'function' && elapsed > 400 && (elapsed % 1000 < 120 || sawSaveSuccess)) {
        try {
          if (options.quickVerify()) {
            dbg('原生操作成功（quickVerify）');
            return true;
          }
        } catch (e) {}
      }

      await sleep(now < fastEnd ? (turbo ? 30 : 50) : turbo ? 60 : 140);
      iframeWin = getReportIframeWin() || iframeWin;
      me = iframeWin ? iframeWin.me : me;
      closeIgnorableNativeExceptionDialogs(doc, jq);

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
          if (!missingSince) {missingSince = Date.now();}
          // 秒审：IsSaveSuccess 后行消失可更快认定成功
          const needMs = sawSaveSuccess && turbo ? Math.min(missingStableMs, 280) : missingStableMs;
          if (Date.now() - missingSince >= needMs) {
            dbg('原生操作成功（目标行已稳定移出列表）');
            return true;
          }
        }
      }

      if (me && me.IsSaveSuccess === true) {
        me.IsSaveSuccess = false;
        sawSaveSuccess = true;
        if (!expectedStatuses || expectedStatuses.length === 0) {return true;}
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
          // 批审：已保存成功且详情目标匹配时，给 UI 极短回写窗口后用 quickVerify
          if (turbo && missingAsSuccess) {
            await sleep(180);
            if (typeof options.quickVerify === 'function' && options.quickVerify()) {
              dbg('原生操作成功（IsSaveSuccess 后 quickVerify）');
              return true;
            }
            if (!findNativeRowByReportDR(iframeWin, targetReportDR) && sawTargetRow) {
              dbg('原生操作成功（IsSaveSuccess 后行消失）');
              return true;
            }
          }
        }
      }

      const msg = ignoreMessages ? '' : readNativeMessageResult(doc, jq);
      if (msg === 'success') {
        if (!expectedStatuses || expectedStatuses.length === 0 || !targetReportDR) {return true;}
        const found = findNativeRowByReportDR(iframeWin, targetReportDR);
        if (found && isExpectedNativeStatus(found.row, expectedStatuses)) {return true;}
        if (!found && missingAsSuccess && sawTargetRow) {return true;}
        continue;
      }
      if (msg === 'incomplete') {return 'incomplete';}
      if (msg === 'failure') {
        if (!targetReportDR || !expectedStatuses || expectedStatuses.length === 0) {return false;}
        if (!failureSince) {
          failureSince = Date.now();
          dbg('检测到原生失败提示，继续短暂确认状态回写...');
        }
        if (Date.now() - failureSince >= failureGraceMs) {return false;}
        continue;
      }
      if (failureSince && Date.now() - failureSince >= failureGraceMs) {return false;}
    }
    // 超时前最后一次 quickVerify，减少「其实已成功」的假失败
    if (typeof options.quickVerify === 'function') {
      try {
        if (options.quickVerify()) {return true;}
      } catch (e) {}
    }
    return false;
  }

  function getNativeStatusValues(row) {
    if (!row) {return [];}
    return [
      row.Status,
      row.ReportStatus,
      row.StatusDesc,
      row.ReportStatusDesc,
      row.AuthStatus,
      row.AuthFlag,
      row.State,
      row.StateDesc
    ]
      .filter(v => v !== undefined && v !== null)
      .map(v => String(v).trim())
      .filter(Boolean);
  }

  function isExpectedNativeStatus(row, expectedStatuses) {
    const expected = (expectedStatuses || []).map(String);
    if (!expected.length) {return true;}
    const values = getNativeStatusValues(row);
    if (values.some(v => expected.includes(v))) {return true;}
    if (expected.includes('3')) {
      return values.some(
        v =>
          (v === '审核' || v === '已审核' || v.indexOf('审核') !== -1) &&
          v.indexOf('未审核') === -1 &&
          v.indexOf('待审核') === -1 &&
          v.indexOf('取审') === -1 &&
          v.indexOf('取消') === -1
      );
    }
    return false;
  }

  function isReportDetailLoaded(iframeWin, reportDR) {
    if (!iframeWin || !reportDR) {return false;}
    try {
      const me = iframeWin.me;
      const target = String(reportDR);
      if (!me || String(me.curReportDR || '') !== target) {return false;}
      const jq = iframeWin.jQuery || iframeWin.$;
      if (!jq) {return false;}
      const leftRows = jq('#dgLeftReportItem').datagrid('getRows') || [];
      const rightRows = jq('#dgRightReportItem').length ? jq('#dgRightReportItem').datagrid('getRows') || [] : [];
      if (!(leftRows.length || rightRows.length)) {return false;}
      const selected = me.selectedGrid ? me.selectedGrid.datagrid('getSelected') : null;
      return !!(selected && String(selected.ReportDR || '') === target);
    } catch (e) {
      return false;
    }
  }

  async function waitReportDetailReady(iframeWin, reportDR, timeoutMs = 5000, options = {}) {
    if (!iframeWin || !reportDR) {return false;}
    const fastBatch = !!options.fastBatch;
    const pollMs = fastBatch ? 50 : 150;
    const end = Date.now() + timeoutMs;
    if (isReportDetailLoaded(iframeWin, reportDR)) {return true;}
    while (Date.now() < end) {
      await sleep(pollMs);
      if (isReportDetailLoaded(iframeWin, reportDR)) {return true;}
    }
    return false;
  }

  // CA 登录单飞锁：批审/预热/首条审核禁止并行多次 handleCALogin（会反复 ReportSave + 关不掉窗）
  let _caLoginInFlight = null;

  function forceCloseCAWindow(iframeWin) {
    try {
      iframeWin = iframeWin || getReportIframeWin();
      if (!iframeWin) {return;}
      const jq = iframeWin.jQuery || iframeWin.$;
      if (!jq) {return;}
      const $w = jq('#win_CAUserLogin');
      if (!$w.length) {return;}
      try {
        $w.window('close');
      } catch (e) {}
      try {
        $w.panel('close');
      } catch (e) {}
      try {
        $w.hide();
      } catch (e) {}
      // 清掉遮罩，避免假死
      try {
        jq('.window-mask, .window-proxy-mask').hide();
      } catch (e) {}
    } catch (e) {
      dbg('forceCloseCAWindow:', e.message);
    }
  }

  function anyCAUkeyPresent(iframeWin) {
    try {
      const arr = iframeWin && iframeWin.CAMsg && iframeWin.CAMsg.UkeyNoArray;
      if (!arr) {return false;}
      if (hasCAUkeyForUser(iframeWin, getReportCAUserDR(iframeWin))) {return true;}
      for (const k of Object.keys(arr)) {
        if (arr[k]) {return true;}
      }
      // 稀疏数组数字下标
      for (let i = 0; i < arr.length; i++) {
        if (arr[i]) {return true;}
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  function syncCAUkeyAcrossUsers(iframeWin) {
    try {
      const arr = iframeWin && iframeWin.CAMsg && iframeWin.CAMsg.UkeyNoArray;
      if (!arr) {return;}
      let srcVal = null;
      for (const k of Object.keys(arr)) {
        if (arr[k]) {
          srcVal = arr[k];
          break;
        }
      }
      if (!srcVal) {
        for (let i = 0; i < (arr.length || 0); i++) {
          if (arr[i]) {
            srcVal = arr[i];
            break;
          }
        }
      }
      if (!srcVal) {return;}
      const me = iframeWin.me;
      const targets = [
        getReportCAUserDR(iframeWin),
        me && me.AuthUserDR,
        me && me.BatchUserDR,
        me && me.SessionUserDR,
        iframeWin.LoginUserDR,
        uid()
      ]
        .map(v => String(v || ''))
        .filter(Boolean);
      targets.forEach(t => {
        if (!arr[t]) {arr[t] = srcVal;}
      });
    } catch (e) {}
  }

  // 只在二维码界面时切到 capping；已在 capping 时禁止再点（点了会切回二维码）
  function ensureCappingFormVisible(caDoc) {
    if (!caDoc) {return false;}
    try {
      const pwd = caDoc.getElementById('txt_Password');
      const divCap = caDoc.getElementById('Div_Caping');
      let capShown = false;
      if (divCap) {
        const st = (divCap.style && divCap.style.display) || '';
        if (st && st !== 'none') {capShown = true;}
        try {
          if (caDoc.defaultView && caDoc.defaultView.getComputedStyle) {
            const cs = caDoc.defaultView.getComputedStyle(divCap);
            if (cs && cs.display !== 'none' && cs.visibility !== 'hidden') {capShown = true;}
          }
        } catch (e) {}
      }
      if (pwd) {
        const r = pwd.getBoundingClientRect ? pwd.getBoundingClientRect() : null;
        if (r && r.width > 0 && r.height > 0) {return true;}
        if (pwd.offsetParent !== null) {return true;}
      }
      if (capShown) {return true;}

      const toggle = caDoc.getElementById('sp_showcapping');
      if (!toggle) {return !!pwd;}
      const t = (toggle.textContent || toggle.innerText || '').trim();
      // 文案「点击caping码登录」= 当前在二维码页，需要点一次
      // 文案「点击二维码登录」= 当前已在 capping，禁止再点
      if (/二维码/.test(t) && !/caping|capping/i.test(t.replace(/二维码/g, ''))) {
        return !!pwd;
      }
      if (/caping|capping/i.test(t)) {
        toggle.click();
        return true;
      }
      return !!pwd;
    } catch (e) {
      return false;
    }
  }

  function getCAIframeDoc(iframeWin) {
    try {
      const doc = iframeWin.document;
      const caIframe = doc.querySelector('#win_CAUserLogin iframe');
      if (
        caIframe &&
        caIframe.contentDocument &&
        caIframe.contentDocument.body &&
        caIframe.contentDocument.body.childElementCount > 0
      ) {
        return caIframe.contentDocument;
      }
    } catch (e) {}
    return null;
  }

  function markCALoginSucceeded(iframeWin) {
    syncCAUkeyAcrossUsers(iframeWin);
    saveCAAuth();
    forceCloseCAWindow(iframeWin);
    dbg('CA: 认证成功（Ukey 已写入 / 窗口已关闭）');
  }

  async function handleCALogin(iframeWin, options = {}) {
    // 单飞：并发调用共用一次结果
    if (_caLoginInFlight) {
      dbg('CA: 已有认证进行中，等待同一结果');
      try {
        return await _caLoginInFlight;
      } catch (e) {
        return false;
      }
    }
    let resolveFn, rejectFn;
    _caLoginInFlight = new Promise((res, rej) => {
      resolveFn = res;
      rejectFn = rej;
    });
    try {
      const ok = await handleCALoginImpl(iframeWin, options);
      resolveFn(ok);
      return ok;
    } catch (e) {
      dbg('CA: handleCALogin 异常', e);
      resolveFn(false);
      return false;
    } finally {
      // 微延迟后释放，避免紧挨着的二次进入
      setTimeout(() => {
        _caLoginInFlight = null;
      }, 80);
    }
  }

  async function handleCALoginImpl(iframeWin, options = {}) {
    const fast = !!options.fast;
    iframeWin = iframeWin || getReportIframeWin();
    if (!iframeWin) {return false;}
    const doc = iframeWin.document;
    const jq = iframeWin.jQuery || iframeWin.$;
    if (!jq) {return false;}

    // 已有 Ukey：直接视为成功并强制关窗（防止残留窗体挡住批审）
    if (anyCAUkeyPresent(iframeWin) || isCASessionReady(iframeWin)) {
      markCALoginSucceeded(iframeWin);
      return true;
    }

    if (!findVisibleCAWindow(iframeWin)) {
      // 窗口已关且无 Ukey：交给调用方决定是否再触发
      return anyCAUkeyPresent(iframeWin);
    }

    const caPwd = await loadCAPwdAsync();
    if (!caPwd) {
      showToast('请先设置CA密码（设置里保存 CA/capping 密码）', 'warning');
      return false;
    }

    const caUser = uname() || loadLoginCreds()?.user || '';
    dbg('CA: 开始 capping 自动登录');
    updateBatchProgress('CA 认证中（capping）...', null);
    const ft = document.getElementById('lis-ws-ft-stat');
    if (ft) {ft.textContent = 'CA 认证中...';}

    const deadline = Date.now() + (fast ? 45000 : 90000);
    // 最多 2 次提交密码；成功判定以 Ukey 为准，不再依赖 caWin.is(':visible')
    for (let attempt = 1; attempt <= 2; attempt++) {
      if (Date.now() > deadline) {break;}
      if (anyCAUkeyPresent(iframeWin)) {
        markCALoginSucceeded(iframeWin);
        return true;
      }
      if (!findVisibleCAWindow(iframeWin) && anyCAUkeyPresent(iframeWin)) {
        markCALoginSucceeded(iframeWin);
        return true;
      }

      // 等 iframe 表单就绪
      let caDoc = null;
      for (let i = 0; i < (fast ? 30 : 50); i++) {
        caDoc = getCAIframeDoc(iframeWin);
        if (caDoc) {break;}
        if (anyCAUkeyPresent(iframeWin)) {
          markCALoginSucceeded(iframeWin);
          return true;
        }
        await sleep(100);
      }
      if (!caDoc) {caDoc = doc;}

      try {
        ensureCappingFormVisible(caDoc);
        await sleep(280);
        caDoc = getCAIframeDoc(iframeWin) || caDoc;

        let userInput = caDoc.getElementById('txt_UserCode') || caDoc.querySelector('input[id*="UserCode"]');
        let pwdInput = caDoc.getElementById('txt_Password') || caDoc.querySelector('input[type="password"]');
        if (!pwdInput) {
          for (const inp of caDoc.querySelectorAll('input')) {
            if (inp.type === 'password') {pwdInput = inp;}
            if ((inp.type === 'text' || !inp.type) && !userInput) {userInput = inp;}
          }
        }
        if (!pwdInput) {
          dbg('CA: capping 密码框未找到（可能仍在二维码页） attempt=', attempt);
          // 再试一次切换
          ensureCappingFormVisible(caDoc);
          await sleep(400);
          continue;
        }

        if (userInput && caUser) {setNativeInputValue(userInput, caUser);}
        setNativeInputValue(pwdInput, caPwd);
        await sleep(200);

        let loginBtn =
          caDoc.getElementById('bt_login') || caDoc.querySelector('#bt_login, a[id*="login"], button[id*="login"]');
        if (!loginBtn) {
          for (const b of caDoc.querySelectorAll('a.l-btn, button, input[type=button]')) {
            const text = (b.textContent || b.value || '').trim();
            if (text.indexOf('登录') !== -1) {
              loginBtn = b;
              break;
            }
          }
        }
        if (!loginBtn) {
          dbg('CA: 登录按钮未找到');
          continue;
        }

        dbg('CA: 提交 capping 登录 attempt=', attempt);
        updateBatchProgress(attempt === 1 ? 'CA 提交登录...' : 'CA 再次提交...', null);
        loginBtn.click();

        // 轮询成功：Ukey 写入 / 窗口真正关闭 / 审核用户已标记
        // CapingLogin 成功后会：写 Ukey → eval(FuncStr=ReportSave) → window.close
        // ReportSave 可能较慢，故成功以 Ukey 为准，不必等窗关
        let sawPwdError = false;
        for (let i = 0; i < (fast ? 80 : 120); i++) {
          await sleep(150);
          if (anyCAUkeyPresent(iframeWin) || isCASessionReady(iframeWin)) {
            // 给原生 FuncStr(ReportSave) 一点时间跑完，再强制关残留窗
            await sleep(200);
            markCALoginSucceeded(iframeWin);
            // 再等一瞬，让可能触发的 ReportSave 落盘
            await sleep(300);
            return true;
          }
          if (!findVisibleCAWindow(iframeWin)) {
            // 窗已关：再看 Ukey
            if (anyCAUkeyPresent(iframeWin) || isCASessionReady(iframeWin)) {
              markCALoginSucceeded(iframeWin);
              return true;
            }
            // 窗关了但没 Ukey —— 可能用户手动关了
            dbg('CA: 窗口已关闭但未见 Ukey');
            return anyCAUkeyPresent(iframeWin);
          }
          try {
            const errText = (caDoc.body && caDoc.body.textContent) || '';
            if (errText.indexOf('账号锁定') !== -1 || errText.indexOf('账户锁定') !== -1) {
              showToast('CA 账号已锁定', 'error');
              return false;
            }
            if (
              errText.indexOf('密码错误') !== -1 ||
              errText.indexOf('认证失败') !== -1 ||
              errText.indexOf('用户不存在') !== -1
            ) {
              sawPwdError = true;
              dbg('CA: 密码/认证错误');
              break;
            }
          } catch (e) {}
          if (Date.now() > deadline) {break;}
        }

        if (sawPwdError) {
          showToast('CA 密码错误，请在设置中更新 CA 密码', 'error');
          return false;
        }
        // 仅进度提示，避免右上角刷屏「CA 重试」
        if (attempt < 2) {
          dbg('CA: 本轮未检测到 Ukey，准备最多再试 1 次');
          updateBatchProgress('CA 等待确认...', null);
          await sleep(600);
        }
      } catch (e) {
        dbg('CA 异常:', e.message || e);
        await sleep(400);
      }
    }

    // 末次：若其实已有 Ukey（窗关失败），仍算成功
    if (anyCAUkeyPresent(iframeWin) || isCASessionReady(iframeWin)) {
      markCALoginSucceeded(iframeWin);
      return true;
    }
    showToast('CA 认证未完成，请在弹窗内手动 capping 登录一次', 'error');
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
        if (btn) {break;}
      }
    }
    const jq = iframeWin ? iframeWin.jQuery || iframeWin.$ : window.jQuery;
    const doc = iframeWin ? iframeWin.document : document;
    const me = iframeWin ? iframeWin.me : null;

    if (!btn) {
      dbg('按钮 ' + btnId + ' 不存在');
      return false;
    }
    if (!jq) {
      dbg('原生 jQuery 不存在');
      return false;
    }
    if (iframeWin) {installNativeStatExceptionGuard(iframeWin);}

    const batchMode = !!options.batchMode;
    // 实时重测 CA，避免调用方传入过期的 caSessionReady=false 导致每条都走慢路径
    const caSessionReady = !!options.caSessionReady || isCASessionReady(iframeWin);
    const isAudit = btnId === 'btn_ReportAuth' || options.action === 'audit';
    const expectedStatuses = options.expectedStatuses || (isAudit ? ['3'] : []);
    // 秒审：单次等待收紧；已 CA 时网络回写通常 0.5–2s
    const timeoutMs = options.timeoutMs || (isAudit ? (batchMode ? (caSessionReady ? 2200 : 6500) : 12000) : 8000);
    const missingAsSuccess =
      options.missingAsSuccess !== undefined ? options.missingAsSuccess : caSessionReady && isAudit;
    const maxPoll = caSessionReady ? 2 : batchMode ? 4 : 16;
    const pollSleep = caSessionReady ? 25 : batchMode ? 40 : 180;
    const missingStableMs = batchMode ? (caSessionReady ? 180 : 350) : 900;

    let targetReportDR = options.targetReportDR ? String(options.targetReportDR) : '';
    try {
      const sel = me && me.selectedGrid ? me.selectedGrid.datagrid('getSelected') : null;
      if (!targetReportDR && sel) {targetReportDR = String(sel.ReportDR || '');}
    } catch (e) {}
    const auditCtx = auditTargetContext(iframeWin, targetReportDR);
    const targetWasPresent = auditCtx.rowPresent;
    const allowMissingSuccess = missingAsSuccess && auditCtx.allowMissingSuccess;
    const makeWaitOpts = (extra = {}) => ({
      targetWasPresent,
      missingStableMs,
      failureGraceMs: caSessionReady ? 700 : batchMode ? 1000 : 3000,
      ignoreMessages: true,
      turbo: batchMode || caSessionReady,
      abortCheck: options.abortCheck,
      quickVerify: targetReportDR ? () => verifyAuditSucceededByReportDR(iframeWin, targetReportDR) : null,
      onTick: options.onTick,
      ...extra
    });
    const waitOpts = makeWaitOpts();

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
    } catch (e) {
      dbg('ReportSave 调用失败，回退按钮点击:', e.message);
    }
    if (!auditTriggered) {
      jq(btn).click();
      dbg('已点击审核按钮, targetReportDR=' + targetReportDR);
    }

    let caDetected = false;
    let authLoginDetected = false;
    const tickAudit = phase => {
      if (typeof options.onTick === 'function') {
        try {
          options.onTick(0, phase);
        } catch (e) {}
      }
    };
    const reTriggerAudit = () => {
      try {
        if (typeof iframeWin.ReportSave === 'function') {
          iframeWin.ReportSave('A', '');
          return true;
        }
      } catch (e) {}
      try {
        jq(btn).click();
        return true;
      } catch (e2) {}
      return false;
    };
    const instant = await waitNativeActionResult(
      iframeWin,
      targetReportDR,
      expectedStatuses,
      batchMode ? (caSessionReady ? 80 : 100) : 80,
      allowMissingSuccess,
      waitOpts
    );
    if (instant !== false) {return instant;}

    for (let poll = 0; poll < maxPoll; poll++) {
      if (options.abortCheck && options.abortCheck()) {return false;}
      const early = await waitNativeActionResult(
        iframeWin,
        targetReportDR,
        expectedStatuses,
        batchMode ? (caSessionReady ? 70 : 90) : 50,
        allowMissingSuccess,
        waitOpts
      );
      if (early !== false) {return early;}

      await sleep(pollSleep);

      if (findVisibleCAWindow(iframeWin)) {
        caDetected = true;
        dbg('检测到 CA 认证窗口（严格可见）');
        break;
      }

      if (findVisibleAuthLoginWindow(iframeWin)) {
        authLoginDetected = true;
        dbg('检测到真实可见的审核登录窗口');
        break;
      }
    }

    // 审核登录窗口：自动填密 → 重新触发审核（而不是只 toast 空等）
    if (authLoginDetected && !caDetected) {
      tickAudit('审核登录中...');
      const authOK = await fillOpenAuthLoginWindow(iframeWin);
      if (authOK) {
        dbg('审核登录已自动完成，重新触发审核');
        tickAudit('重新审核...');
        reTriggerAudit();
        await sleep(80);
        // 登录后可能弹出 CA
        if (findVisibleCAWindow(iframeWin)) {
          caDetected = true;
        } else {
          const afterAuth = await waitNativeActionResult(
            iframeWin,
            targetReportDR,
            expectedStatuses,
            batchMode ? (isCASessionReady(iframeWin) ? 2500 : 6000) : 10000,
            true,
            makeWaitOpts({ missingStableMs: 180, turbo: true })
          );
          if (afterAuth !== false) {return afterAuth;}
          if (targetReportDR && verifyAuditSucceededByReportDR(iframeWin, targetReportDR)) {return true;}
        }
      } else if (!batchMode) {
        showToast('出现审核登录窗口，请输入密码后继续', 'warning');
      }
      // 批审：登录失败也继续等结果，成功后不弹误导 toast
    }

    // 如果检测到 CA 窗口，自动完成 CA 登录（单飞；成功后 FuncStr 常已触发 ReportSave，勿立刻再点审核）
    if (caDetected || findVisibleCAWindow(iframeWin)) {
      dbg('开始自动 CA 认证...');
      tickAudit('CA 认证中...');
      const caOK = await handleCALogin(iframeWin, { fast: batchMode });
      if (caOK) {
        syncCAUkeyAcrossUsers(iframeWin);
        saveCAAuth();
        forceCloseCAWindow(iframeWin);
        if (options.keepWS) {keepWorkbenchOnTop('CA认证完成');}
        dbg('CA 认证成功，快速确认首条（FuncStr 多半已 ReportSave）...');
        tickAudit('CA完成·确认首条...');
      } else {
        dbg('CA 自动登录未确认，继续等待原生异步审核...');
        tickAudit('CA 未确认，继续等待结果...');
      }

      // 突发轮询：CapingLogin 里 FuncStr 已触发审核，状态回写前 1～2s 内要抓到
      if (caOK && targetReportDR) {
        for (let i = 0; i < (batchMode ? 20 : 30); i++) {
          if (options.abortCheck && options.abortCheck()) {return false;}
          iframeWin = getReportIframeWin() || iframeWin;
          if (
            verifyAuditSucceededByReportDR(iframeWin, targetReportDR) ||
            softAuditSuccessHint(iframeWin, targetReportDR)
          ) {
            dbg('CA 后突发确认：首条已审核');
            return true;
          }
          // IsSaveSuccess 边沿
          try {
            const me2 = iframeWin && iframeWin.me;
            if (me2 && me2.IsSaveSuccess === true) {
              me2.IsSaveSuccess = false;
              await sleep(100);
              if (
                verifyAuditSucceededByReportDR(iframeWin, targetReportDR) ||
                softAuditSuccessHint(iframeWin, targetReportDR)
              ) {
                return true;
              }
              // 批审：已跳到下一条且 IsAuthed
              if (batchMode && me2.IsAuthed === true && String(me2.curReportDR || '') !== String(targetReportDR)) {
                dbg('CA 后突发确认：已跳转下一条，视作首条成功');
                return true;
              }
            }
          } catch (e) {}
          await sleep(100);
        }
      }

      const postCaCtx = auditTargetContext(iframeWin, targetReportDR);
      // 批审 CA 后最多再等约 3.5s（以前 10s+6s+确认 会卡在姓名上很久）
      let caResult = await waitNativeActionResult(
        iframeWin,
        targetReportDR,
        expectedStatuses,
        batchMode ? (caOK ? 3500 : 8000) : caOK ? 12000 : 20000,
        true,
        makeWaitOpts({
          targetWasPresent: true,
          missingStableMs: batchMode ? 180 : missingStableMs,
          failureGraceMs: batchMode ? 800 : 3000,
          turbo: true,
          quickVerify: () =>
            verifyAuditSucceededByReportDR(iframeWin, targetReportDR) ||
            softAuditSuccessHint(iframeWin, targetReportDR),
          onTick: elapsed => {
            if (typeof options.onTick === 'function') {
              options.onTick(elapsed, caOK ? '确认首条' : '等待结果');
            }
          }
        })
      );
      if (caResult) {return caResult;}

      // 补触发：仅详情仍是本条且未成功时（避免已跳到下一条还 ReportSave 审错人）
      if (
        caOK &&
        targetReportDR &&
        !verifyAuditSucceededByReportDR(iframeWin, targetReportDR) &&
        !softAuditSuccessHint(iframeWin, targetReportDR) &&
        !findVisibleCAWindow(iframeWin) &&
        isReportDetailLoaded(iframeWin, targetReportDR)
      ) {
        dbg('CA 后原生回调未确认，补触发一次审核');
        tickAudit('补触发审核...');
        reTriggerAudit();
        caResult = await waitNativeActionResult(
          iframeWin,
          targetReportDR,
          expectedStatuses,
          batchMode ? 3000 : 8000,
          true,
          makeWaitOpts({
            targetWasPresent: true,
            missingStableMs: 180,
            turbo: true,
            quickVerify: () =>
              verifyAuditSucceededByReportDR(iframeWin, targetReportDR) ||
              softAuditSuccessHint(iframeWin, targetReportDR)
          })
        );
        if (caResult) {return caResult;}
      }

      await sleep(batchMode ? 80 : 400);
      if (
        targetReportDR &&
        (verifyAuditSucceededByReportDR(iframeWin, targetReportDR) || softAuditSuccessHint(iframeWin, targetReportDR))
      ) {
        dbg('CA 后二次校验：标本已审核');
        if (caOK) {saveCAAuth();}
        return true;
      }
      // 批审：CA 已成功且焦点已离开本条 → 宁可认为首条已审，漏网由补审捞
      if (batchMode && caOK && targetReportDR) {
        try {
          const me3 = (getReportIframeWin() || iframeWin).me;
          if (me3 && me3.IsAuthed === true && String(me3.curReportDR || '') !== String(targetReportDR)) {
            dbg('CA 后批审宽松成功：已离开本条');
            return true;
          }
        } catch (e) {}
      }
      dbg('CA 审核等待超时，未确认成功');
      if (!caOK && !anyCAUkeyPresent(iframeWin)) {clearCAAuth();}
      return false;
    }

    tickAudit(caSessionReady ? '秒审确认...' : '确认审核结果...');
    const result = await waitNativeActionResult(
      iframeWin,
      targetReportDR,
      expectedStatuses,
      timeoutMs,
      allowMissingSuccess || caSessionReady,
      makeWaitOpts({
        missingStableMs,
        failureGraceMs: batchMode ? (caSessionReady ? 600 : 1500) : 3000
      })
    );
    if (result) {return result;}

    // 末次快速校验，避免调用方再叠一层长确认
    if (targetReportDR && verifyAuditSucceededByReportDR(iframeWin, targetReportDR)) {
      dbg('审核末次校验：标本已审核');
      return true;
    }

    // 仅在窗口仍真实可见且审核失败时提示，避免「每条都 toast 但最终又成功」
    if (authLoginDetected && findVisibleAuthLoginWindow(iframeWin)) {
      showToast('审核登录窗口仍打开，请完成登录后重试', 'warning');
    }
    dbg('原生按钮点击完成，但未确认成功');
    return false;
  }

  // 与原生 ReportSave 一致：决定 CA 用哪个用户 DR
  // （IsAuthLogin+AuthUserDR → 否则 BatchUserDR → 否则 LoginUserDR/当前登录用户）
  function getReportCAUserDR(iframeWin) {
    try {
      iframeWin = iframeWin || getReportIframeWin();
      const me = iframeWin && iframeWin.me;
      if (me && Number(me.IsAuthLogin) === 1 && me.AuthUserDR && String(me.AuthUserDR).length > 0) {
        return String(me.AuthUserDR);
      }
      if (me && me.BatchUserDR && String(me.BatchUserDR).length > 0) {
        return String(me.BatchUserDR);
      }
      if (typeof iframeWin !== 'undefined' && iframeWin && iframeWin.LoginUserDR) {
        return String(iframeWin.LoginUserDR);
      }
      return String(uid() || (me && me.SessionUserDR) || '');
    } catch (e) {
      return String(uid() || '');
    }
  }

  function hasCAUkeyForUser(iframeWin, userDR) {
    try {
      if (!iframeWin || !iframeWin.CAMsg || !iframeWin.CAMsg.UkeyNoArray) {return false;}
      const arr = iframeWin.CAMsg.UkeyNoArray;
      const key = String(userDR || '');
      if (key && arr[key]) {return true;}
      // 部分环境用数字下标
      if (key && arr[Number(key)]) {return true;}
      return false;
    } catch (e) {
      return false;
    }
  }

  // EasyUI 窗口严格可见判定：避免 DOM 残留节点被当成「审核登录窗口」导致误提示、空等
  function isEasyUIWindowReallyVisible(el, jq) {
    if (!el) {return false;}
    try {
      if (el.style && el.style.display === 'none') {return false;}
      if (el.getAttribute && el.getAttribute('style') && /display\s*:\s*none/i.test(el.getAttribute('style')))
      {return false;}
      const $el = jq ? jq(el) : null;
      if ($el && $el.length) {
        try {
          if ($el.window && typeof $el.window === 'function') {
            // easyui window 方法可能不存在，忽略
          }
        } catch (e) {}
        if (!$el.is(':visible')) {return false;}
      }
      const panel = el.closest ? el.closest('.window') || el.closest('.panel') || el : el;
      if (panel && panel.style && panel.style.display === 'none') {return false;}
      if (panel && panel.offsetParent === null && panel !== document.body) {
        // fixed 定位时 offsetParent 可能为 null，改看几何尺寸
        const r0 = panel.getBoundingClientRect ? panel.getBoundingClientRect() : null;
        if (!r0 || (r0.width < 40 && r0.height < 40)) {return false;}
      }
      const rect = (panel || el).getBoundingClientRect ? (panel || el).getBoundingClientRect() : null;
      if (!rect || rect.width < 80 || rect.height < 60) {return false;}
      // 完全在视口外
      if (rect.bottom < 0 || rect.right < 0 || rect.top > (window.innerHeight || 800) + 40) {return false;}
      return true;
    } catch (e) {
      return false;
    }
  }

  function findVisibleAuthLoginWindow(iframeWin) {
    try {
      const doc = iframeWin ? iframeWin.document : document;
      const jq = iframeWin ? iframeWin.jQuery || iframeWin.$ : window.jQuery;
      const sels = ['#win_AuthLogin', '#win_EntryLogin', '#win_BatchAuthUserLogin'];
      for (const sel of sels) {
        const el = doc.querySelector(sel);
        if (isEasyUIWindowReallyVisible(el, jq)) {return el;}
      }
    } catch (e) {}
    return null;
  }

  function findVisibleCAWindow(iframeWin) {
    try {
      const doc = iframeWin ? iframeWin.document : document;
      const jq = iframeWin ? iframeWin.jQuery || iframeWin.$ : window.jQuery;
      const el = doc.querySelector('#win_CAUserLogin');
      if (isEasyUIWindowReallyVisible(el, jq)) {return el;}
      // 也用 jq :visible 作为补充
      if (jq) {
        const caWin = jq('#win_CAUserLogin');
        if (caWin.length && caWin.is(':visible')) {
          const node = caWin[0];
          if (isEasyUIWindowReallyVisible(node, jq)) {return node;}
        }
      }
    } catch (e) {}
    return null;
  }

  function isCASessionReady(iframeWin) {
    try {
      iframeWin = iframeWin || getReportIframeWin();
      if (!iframeWin) {return false;}
      // 真·CA 窗仍开着时不算就绪（避免边认证边秒审）
      if (findVisibleCAWindow(iframeWin)) {return false;}

      // 与 ReportSave 相同的用户 DR
      const caUser = getReportCAUserDR(iframeWin);
      if (hasCAUkeyForUser(iframeWin, caUser)) {return true;}

      const me = iframeWin.me;
      const candidates = [
        caUser,
        me && me.AuthUserDR,
        me && me.BatchUserDR,
        me && me.SessionUserDR,
        iframeWin.LoginUserDR,
        uid()
      ]
        .map(v => String(v || ''))
        .filter(Boolean);
      for (const c of candidates) {
        if (hasCAUkeyForUser(iframeWin, c)) {
          // 对齐到 ReportSave 将使用的 key
          syncCAUkeyAcrossUsers(iframeWin);
          return true;
        }
      }

      // 任一 Ukey 已写入（capping 成功后常见）：同步到各用户 key 后视为就绪
      if (anyCAUkeyPresent(iframeWin)) {
        syncCAUkeyAcrossUsers(iframeWin);
        return true;
      }
    } catch (e) {}
    return false;
  }

  // 批审前：恢复审核登录态 + 确认 ReportSave 将用到的 CA 用户已有 Ukey
  async function ensureBatchAuthAndCAReady(iframeWin, options = {}) {
    iframeWin = iframeWin || getReportIframeWin();
    if (!iframeWin) {return { ok: false, caReady: false, reason: 'no-iframe' };}
    const ft = msg => {
      if (typeof options.onProgress === 'function') {options.onProgress(msg);}
      else {updateBatchProgress(msg, null);}
    };

    // 1) 从 session/local 恢复 AuInfo → me.IsAuthLogin / AuthUserDR
    try {
      restoreAuth();
      let au = null;
      try {
        au = sessionStorage.getItem('AuInfo') || localStorage.getItem(K.au);
      } catch (e) {}
      if (au && iframeWin.me) {
        const parts = String(au).split('^');
        if (parts[0]) {
          iframeWin.me.AuthUserDR = parts[0];
          iframeWin.me.IsAuthLogin = 1;
          dbg('批审前恢复审核登录: AuthUserDR=', parts[0]);
        }
      }
      if (typeof iframeWin.GetAuthLoginInfo === 'function') {
        try {
          iframeWin.GetAuthLoginInfo();
        } catch (e) {}
      }
    } catch (e) {
      dbg('恢复审核登录失败:', e.message);
    }

    // 2) 若审核登录窗误开着，自动填密关闭
    if (findVisibleAuthLoginWindow(iframeWin)) {
      ft('检测到审核登录窗口，自动登录...');
      const filled = await fillOpenAuthLoginWindow(iframeWin);
      if (!filled) {
        showToast('请完成审核登录后重试批审', 'warning');
        return { ok: false, caReady: false, reason: 'auth-login' };
      }
      await sleep(200);
    }

    // 3) 对齐 CA 用户
    let caUser = getReportCAUserDR(iframeWin);
    if (isCASessionReady(iframeWin)) {
      saveCAAuth();
      return { ok: true, caReady: true, caUser };
    }

    // 若 Ukey 挂在 LoginUserDR 上，但 ReportSave 会用 BatchUserDR：尽量清空 BatchUserDR 走登录用户
    try {
      const me = iframeWin.me;
      const loginDR = String(iframeWin.LoginUserDR || uid() || '');
      if (
        me &&
        loginDR &&
        hasCAUkeyForUser(iframeWin, loginDR) &&
        !hasCAUkeyForUser(iframeWin, getReportCAUserDR(iframeWin))
      ) {
        if (me.BatchUserDR && String(me.BatchUserDR) !== loginDR && Number(me.IsAuthLogin) !== 1) {
          dbg('批审：BatchUserDR 无 Ukey，改用已认证的 LoginUserDR', loginDR);
          me.BatchUserDR = loginDR;
        }
        // 若有 AuInfo 但 AuthUserDR 无 Ukey，而 LoginUserDR 有，则优先保持 IsAuthLogin 用户；否则用登录用户
        if (
          Number(me.IsAuthLogin) === 1 &&
          me.AuthUserDR &&
          !hasCAUkeyForUser(iframeWin, me.AuthUserDR) &&
          hasCAUkeyForUser(iframeWin, loginDR)
        ) {
          // 把 Ukey 也记到 AuthUserDR（部分 CA 客户端按登录用户绑定）
          try {
            if (iframeWin.CAMsg && iframeWin.CAMsg.UkeyNoArray && iframeWin.CAMsg.UkeyNoArray[loginDR]) {
              iframeWin.CAMsg.UkeyNoArray[String(me.AuthUserDR)] = iframeWin.CAMsg.UkeyNoArray[loginDR];
              dbg('批审：复制 Ukey LoginUserDR → AuthUserDR');
            }
          } catch (e) {}
        }
      }
    } catch (e) {}

    caUser = getReportCAUserDR(iframeWin);
    if (hasCAUkeyForUser(iframeWin, caUser) || anyCAUkeyPresent(iframeWin)) {
      syncCAUkeyAcrossUsers(iframeWin);
      saveCAAuth();
      forceCloseCAWindow(iframeWin);
      return { ok: true, caReady: true, caUser };
    }

    // 4) 若 CA 窗已开着（例如上次残留），只自动填一次 capping，不再 CAMsg.Login 匿名回调
    //    （匿名回调 FuncStr 会变成 "()"，eval 报错导致关不了窗）
    //    无窗时交给首条 ReportSave 原生弹出 CA（FuncStr=ReportSave("A","") 才正确）
    if (findVisibleCAWindow(iframeWin)) {
      ft('检测到 CA 窗口，自动 capping 登录（仅一次）...');
      const caOK = await handleCALogin(iframeWin, { fast: true });
      if (caOK) {
        syncCAUkeyAcrossUsers(iframeWin);
        return { ok: true, caReady: true, caUser: getReportCAUserDR(iframeWin) };
      }
    } else {
      ft('CA 未就绪：将在首条审核时弹出 CA（只认证一次）');
    }

    const ready = isCASessionReady(iframeWin) || anyCAUkeyPresent(iframeWin);
    if (ready) {
      syncCAUkeyAcrossUsers(iframeWin);
      saveCAAuth();
      forceCloseCAWindow(iframeWin);
    }
    return { ok: true, caReady: ready, caUser: getReportCAUserDR(iframeWin) };
  }

  // 审核登录窗已打开时填密提交（不再点「审核登录」按钮）
  async function fillOpenAuthLoginWindow(iframeWin) {
    try {
      const jq = iframeWin.jQuery || iframeWin.$;
      const doc = iframeWin.document;
      const loginWin = findVisibleAuthLoginWindow(iframeWin);
      if (!loginWin) {return false;}

      let loginDoc = doc;
      const dialogIframe = loginWin.querySelector('iframe');
      if (dialogIframe) {
        try {
          const iDoc = dialogIframe.contentDocument || dialogIframe.contentWindow.document;
          if (iDoc && iDoc.body && iDoc.body.childElementCount > 0) {loginDoc = iDoc;}
        } catch (e) {}
      }

      let pwdInput =
        loginDoc.querySelector('#text_AuthUserLoginPasssword') ||
        loginDoc.querySelector('#text_EntryUserPasssword') ||
        loginDoc.querySelector('input[type="password"]');
      if (!pwdInput) {
        // 深一层
        for (const ifr of loginWin.querySelectorAll('iframe')) {
          try {
            const iDoc = ifr.contentDocument || ifr.contentWindow.document;
            if (!iDoc) {continue;}
            pwdInput =
              iDoc.querySelector('#text_AuthUserLoginPasssword') ||
              iDoc.querySelector('#text_EntryUserPasssword') ||
              iDoc.querySelector('input[type="password"]');
            if (pwdInput) {
              loginDoc = iDoc;
              break;
            }
          } catch (e) {}
        }
      }
      if (!pwdInput) {return false;}

      const pwd = await loadPwdAsync();
      if (!pwd) {
        dbg('未保存审核密码，无法自动审核登录');
        return false;
      }

      const acctInput =
        loginDoc.querySelector('#text_AuthUserCode') ||
        loginDoc.querySelector('input[id*="UserCode"]') ||
        loginDoc.querySelector('input[type="text"]');
      if (acctInput && uname()) {setNativeInputValue(acctInput, uname());}
      setNativeInputValue(pwdInput, pwd);
      await sleep(150);

      let okBtn = null;
      for (const b of loginDoc.querySelectorAll('a.l-btn, button, input[type=button]')) {
        const text = (b.textContent || b.value || '').trim();
        if (text.includes('确定') || text.includes('登录') || text === 'OK') {
          okBtn = b;
          break;
        }
      }
      if (!okBtn) {
        for (const b of loginWin.querySelectorAll('a.l-btn, button')) {
          const text = (b.textContent || '').trim();
          if (text.includes('确定') || text.includes('登录')) {
            okBtn = b;
            break;
          }
        }
      }
      if (!okBtn) {return false;}
      if (jq) {jq(okBtn).click();}
      else {okBtn.click();}

      for (let w = 0; w < 25; w++) {
        await sleep(120);
        if (!isEasyUIWindowReallyVisible(loginWin, jq)) {
          try {
            const me = iframeWin.me;
            if (me) {
              me.IsAuthLogin = 1;
              const auInfo = sessionStorage.getItem('AuInfo');
              if (auInfo) {me.AuthUserDR = auInfo.split('^')[0];}
              else if (!me.AuthUserDR) {me.AuthUserDR = uid();}
            }
          } catch (e) {}
          return true;
        }
      }
      return !isEasyUIWindowReallyVisible(loginWin, jq);
    } catch (e) {
      dbg('fillOpenAuthLoginWindow 失败:', e.message);
      return false;
    }
  }

  // 实时检查CA认证状态
  async function checkRealCAStatus() {
    try {
      const iframeWin = getReportIframeWin();
      if (!iframeWin) {return { authenticated: false, reason: '页面未加载' };}

      const jq = iframeWin.jQuery || iframeWin.$;
      if (!jq) {return { authenticated: false, reason: '页面未就绪' };}

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
    } catch (e) {
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
    } catch (e) {}

    // 本地缓存检查（1小时内有效）
    const cached = loadCAAuth();
    if (cached && cached.wg === wgDR() && Date.now() - cached.time < 3600000) {
      dbg('CA: 使用本地缓存');
      return true;
    }

    dbg('CA: 需要认证，直接调用 CAMsg.Login');

    try {
      let iframeWin = getReportIframeWin();
      if (!iframeWin) {iframeWin = await ensureReportPageLoaded();}
      if (!iframeWin) {
        showToast('未找到报告页面', 'error');
        return false;
      }

      // 等待 iframe 就绪
      for (let w = 0; w < 15; w++) {
        if (iframeWin.CAMsg && iframeWin.me) {break;}
        await sleep(400);
        iframeWin = getReportIframeWin();
      }
      if (!iframeWin || !iframeWin.CAMsg) {
        showToast('报告页面未就绪', 'error');
        return false;
      }

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
        if (caOK) {
          saveCAAuth();
          showToast('✅ CA 认证成功', 'success');
          return true;
        }
        clearCAAuth();
        return false;
      }

      // 调用 CAMsg.Login 触发 CA 窗口
      CAMsg.Login(
        caUserDR,
        function () {
          dbg('CA: CAMsg.Login 回调触发');
        },
        []
      );

      // 等待 CA 窗口出现（最多 15 秒）
      let waited = 0;
      caWin = jq('#win_CAUserLogin');
      while ((!caWin.length || !caWin.is(':visible')) && waited < 15000) {
        await sleep(500);
        waited += 500;
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
    } catch (e) {
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
      if (statusBar) {return statusBar.textContent || '';}
      // 查找"审核用户未登录"文本
      const allText = doc.body ? doc.body.textContent : '';
      const idx = allText.indexOf('审核用户未登录');
      return idx !== -1 ? '审核用户未登录' : '';
    } catch (e) {
      return '';
    }
  }

  async function handleAuditLogin(iframeWin, jq) {
    try {
      // 点击"审核登录"按钮
      const authLoginBtn =
        iframeWin.document.getElementById('btn_AuthLogin') || document.getElementById('btn_AuthLogin');
      if (!authLoginBtn) {
        dbg('审核登录按钮不存在');
        return false;
      }
      jq(authLoginBtn).click();
      dbg('已点击审核登录按钮');
      await sleep(800);

      // showwin 在 dialog 里创建 iframe(#FRMdetail)，登录表单在这个 iframe 里
      const doc = iframeWin.document;
      const loginWin = doc.querySelector('#win_AuthLogin') || doc.querySelector('#win_BatchAuthUserLogin');
      if (!loginWin) {
        dbg('审核登录窗口未找到');
        return false;
      }

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
        } catch (e) {
          dbg('访问 dialog iframe 失败:', e.message);
        }
      }

      // 在正确的文档里找密码框
      pwdInput =
        loginDoc.querySelector('#text_AuthUserLoginPasssword') || loginDoc.querySelector('input[type="password"]');
      if (!pwdInput) {
        // 再试一层 iframe
        const innerIframe = loginDoc.querySelector('iframe');
        if (innerIframe) {
          try {
            const iDoc2 = innerIframe.contentDocument || innerIframe.contentWindow.document;
            if (iDoc2) {
              pwdInput =
                iDoc2.querySelector('#text_AuthUserLoginPasssword') || iDoc2.querySelector('input[type="password"]');
              if (pwdInput) {
                loginDoc = iDoc2;
                dbg('密码框在更深层 iframe');
              }
            }
          } catch (e) {}
        }
      }

      if (!pwdInput) {
        dbg('密码框未找到，尝试所有 iframe...');
        // 遍历所有 iframe 查找
        const allIframes = loginWin.querySelectorAll('iframe');
        for (const ifr of allIframes) {
          try {
            const iDoc = ifr.contentDocument || ifr.contentWindow.document;
            if (!iDoc) {continue;}
            pwdInput =
              iDoc.querySelector('#text_AuthUserLoginPasssword') || iDoc.querySelector('input[type="password"]');
            if (pwdInput) {
              loginDoc = iDoc;
              dbg('密码框在 iframe 中找到');
              break;
            }
            // 再深一层
            const deep = iDoc.querySelectorAll('iframe');
            for (const d of deep) {
              try {
                const dDoc = d.contentDocument || d.contentWindow.document;
                if (!dDoc) {continue;}
                pwdInput =
                  dDoc.querySelector('#text_AuthUserLoginPasssword') || dDoc.querySelector('input[type="password"]');
                if (pwdInput) {
                  loginDoc = dDoc;
                  dbg('密码框在深层 iframe');
                  break;
                }
              } catch (e) {}
            }
            if (pwdInput) {break;}
          } catch (e) {}
        }
      }

      if (!pwdInput) {
        dbg('❌ 审核登录密码框未找到');
        return false;
      }

      // 同时查找账户输入框（审核登录需要账户+密码）
      let acctInput =
        loginDoc.querySelector('#text_AuthUserCode') ||
        loginDoc.querySelector('input[id*="UserCode"]') ||
        loginDoc.querySelector('input[id*="Account"]') ||
        loginDoc.querySelector('input[placeholder*="账户"]');
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
      if (!pwd) {
        dbg('❌ 未保存审核密码');
        return false;
      }

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
          okBtn = b;
          break;
        }
      }
      // 也检查 dialog 按钮区域
      if (!okBtn) {
        const allBtns = loginWin.querySelectorAll('a.l-btn, button');
        for (const b of allBtns) {
          const text = (b.textContent || '').trim();
          if (text.includes('确定') || text.includes('登录')) {
            okBtn = b;
            break;
          }
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
          } catch (e) {
            dbg('设置审核状态异常:', e.message);
          }
          return true;
        }
        // 检查是否有错误提示
        try {
          const errWin = loginDoc.querySelector('.messager-window, .window');
          if (errWin && errWin.style.display !== 'none') {
            const errBody = errWin.querySelector('.messager-body, .panel-body');
            if (errBody) {
              const errText = (errBody.textContent || '').trim();
              if (
                errText &&
                (errText.includes('密码') ||
                  errText.includes('错误') ||
                  errText.includes('password') ||
                  errText.includes('fail'))
              ) {
                dbg('审核登录错误: ' + errText.substring(0, 50));
                return false;
              }
            }
          }
        } catch (e) {}
      }
      dbg('审核登录窗口超时未关闭');
      return false;
    } catch (e) {
      dbg('审核登录异常:', e);
      return false;
    }
  }

  function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
  }

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
      try {
        iframeWin.RefreshWorkList();
      } catch (e) {}
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
    if (!iframeWin) {iframeWin = await ensureReportPageLoaded();}
    if (!iframeWin) {return false;}
    if (!ensureSelectedGrid(iframeWin)) {return false;}
    return await clickNativeAuditButton(iframeWin, 'btn_ReportEnt', { action: 'entry', expectedStatuses: ['2', '3'] });
  }

  // --- 取审 ---
  function simulateNativeUndoAudit() {
    const iframeWin = getReportIframeWin();
    if (!iframeWin) {return false;}
    // 优先调用 ReportUndo 函数
    if (typeof iframeWin.ReportUndo === 'function') {
      if (!ensureSelectedGrid(iframeWin)) {return false;}
      try {
        const sel = iframeWin.me.selectedGrid.datagrid('getSelected');
        if (!sel) {return false;}
        dbg('直接调用 ReportUndo');
        iframeWin.ReportUndo(sel.ReportDR, '', '');
        return true;
      } catch (e) {
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
        if (jq) {
          jq(btn).click();
          return true;
        }
        btn.click();
        return true;
      }
    } catch (e) {}
    return false;
  }

  // --- 保存 ---
  async function simulateNativeSave() {
    const iframeWin = getReportIframeWin();
    if (!iframeWin) {return false;}
    if (!ensureSelectedGrid(iframeWin)) {return false;}
    return await clickNativeAuditButton(iframeWin, 'btn_ReportSave', { action: 'save', expectedStatuses: [] });
  }

  // --- 结果分类 ---
  function parseComparableNumber(value) {
    const raw = String(value == null ? '' : value)
      .trim()
      .replace(/[＜﹤]/g, '<')
      .replace(/[＞﹥]/g, '>')
      .replace(/[≤]/g, '<=')
      .replace(/[≥]/g, '>=')
      .replace(/,/g, '');
    if (!raw) {return null;}
    const m = raw.match(/^(<=|>=|<|>)?\s*([-+]?\d+(?:\.\d+)?)/);
    if (!m) {return null;}
    return { op: m[1] || '', value: parseFloat(m[2]), raw };
  }

  function compareResultToRange(result, lowValue, highValue) {
    const parsed = parseComparableNumber(result);
    if (!parsed || isNaN(parsed.value)) {return '';}
    const low = parseComparableNumber(lowValue);
    const high = parseComparableNumber(highValue);
    const hasLow = low && !isNaN(low.value);
    const hasHigh = high && !isNaN(high.value);

    // 带操作符的结果：只能在确定时返回 HIGH/LOW，否则返回 ''（不确定）
    if (parsed.op === '<' || parsed.op === '<=') {
      // "<X" 的实际值 < X，永远不能确定为 HIGH
      if (parsed.op === '<' && hasLow && parsed.value <= low.value) {return 'LOW';}
      if (parsed.op === '<=' && hasLow && parsed.value < low.value) {return 'LOW';}
      // 只有无边界限制时才可能是 NORMAL
      if (!hasLow && !hasHigh) {return 'NORMAL';}
      return ''; // 不确定
    }
    if (parsed.op === '>' || parsed.op === '>=') {
      // ">X" 的实际值 > X，永远不能确定为 LOW
      if (parsed.op === '>' && hasHigh && parsed.value >= high.value) {return 'HIGH';}
      if (parsed.op === '>=' && hasHigh && parsed.value > high.value) {return 'HIGH';}
      // 只有无边界限制时才可能是 NORMAL
      if (!hasLow && !hasHigh) {return 'NORMAL';}
      return ''; // 不确定
    }
    // 无操作符：标准数值比较
    if (hasHigh && parsed.value > high.value) {return 'HIGH';}
    if (hasLow && parsed.value < low.value) {return 'LOW';}
    return 'NORMAL';
  }

  function parseReferenceRange(refRange) {
    const raw = String(refRange || '')
      .trim()
      .replace(/[－–—~～至]/g, '-')
      .replace(/[＜﹤]/g, '<')
      .replace(/[＞﹥]/g, '>')
      .replace(/[≤]/g, '<=')
      .replace(/[≥]/g, '>=')
      .replace(/,/g, '');
    if (!raw) {return { low: '', high: '' };}
    let m = raw.match(/([-+]?\d+(?:\.\d+)?)\s*-\s*([-+]?\d+(?:\.\d+)?)/);
    if (m) {return { low: m[1], high: m[2] };}
    m = raw.match(/^(?:<|<=)\s*([-+]?\d+(?:\.\d+)?)/);
    if (m) {return { low: '', high: m[1] };}
    m = raw.match(/^(?:>|>=)\s*([-+]?\d+(?:\.\d+)?)/);
    if (m) {return { low: m[1], high: '' };}
    m = raw.match(/(?:正常|参考|值)?[：:\s]*([-+]?\d+(?:\.\d+)?)\s*以下/);
    if (m) {return { low: '', high: m[1] };}
    m = raw.match(/(?:正常|参考|值)?[：:\s]*([-+]?\d+(?:\.\d+)?)\s*以上/);
    if (m) {return { low: m[1], high: '' };}
    return { low: '', high: '' };
  }

  function getItemRangeValues(item) {
    const low = item.ValueLow || item.LowValue || item.RefLow || item.ReferenceLow || '';
    const high = item.ValueHigh || item.HighValue || item.RefHigh || item.ReferenceHigh || '';
    if (low || high) {return { low, high };}
    return parseReferenceRange(item.RefRanges || item.RefRange || item.ReferenceRange || '');
  }

  function getItemPanicRangeValues(item) {
    const low = item.PanicLow || item.CriticalLow || item.CrisisLow || item.DangerLow || '';
    const high = item.PanicHigh || item.CriticalHigh || item.CrisisHigh || item.DangerHigh || '';
    return { low, high };
  }

  function compareResultToPanicRange(result, item) {
    const range = getItemPanicRangeValues(item || {});
    if (!range.low && !range.high) {return '';}
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
    if (!r) {return false;}
    if (r === '+' || /^\d+\+$/.test(r) || /^\++$/.test(r)) {return true;}
    return (
      r.includes('阳性') ||
      r.includes('弱阳') ||
      r.includes('阳性(+)') ||
      r === 'POSITIVE' ||
      r === 'POS' ||
      r === 'REACTIVE' ||
      r === 'REACT'
    );
  }

  function isExplicitNegativeText(value) {
    const r = normalizeQualitativeText(value);
    if (!r) {return false;}
    if (r === '-' || r === '(-)' || r === 'NEGATIVE' || r === 'NEG' || r === 'NON-REACTIVE' || r === 'NONREACTIVE')
    {return true;}
    return r.includes('阴性') || r === '未见' || r === '未检出' || r === '未检测到';
  }

  function isNegativeReferenceText(value) {
    const r = normalizeQualitativeText(value);
    if (!r) {return false;}
    return (
      r.includes('阴性') ||
      r.includes('NEGATIVE') ||
      r.includes('NON-REACTIVE') ||
      r.includes('NONREACTIVE') ||
      r === '-' ||
      r === 'NEG'
    );
  }

  function isPositiveReferenceText(value) {
    const r = normalizeQualitativeText(value);
    if (!r || isNegativeReferenceText(r)) {return false;}
    return r.includes('阳性') || r.includes('POSITIVE') || r.includes('REACTIVE') || r === '+' || r === 'POS';
  }

  function compareQualitativeToReference(result, item) {
    const ref = item.RefRanges || item.RefRange || item.ReferenceRange || item.ValueLow || item.ValueHigh || '';
    if (!ref) {return '';}
    const positive = isExplicitPositiveText(result);
    const negative = isExplicitNegativeText(result);
    if (!positive && !negative) {return '';}
    const refNegative = isNegativeReferenceText(ref);
    const refPositive = isPositiveReferenceText(ref);
    if (refNegative && positive) {return 'ABNORMAL';}
    if (refPositive && negative) {return 'ABNORMAL';}
    if (refNegative && negative) {return 'NORMAL';}
    if (refPositive && positive) {return 'NORMAL';}
    return '';
  }

  function isDashValidNegativeResult(item, result) {
    if (normalizeQualitativeText(result) !== '-') {return false;}
    const ref = item.RefRanges || item.RefRange || item.ReferenceRange || item.ValueLow || item.ValueHigh || '';
    const format = String(item.ResultFormat || '').toUpperCase();
    const name = String(item.CName || item.Code || item.Synonym || '').toUpperCase();
    if (isNegativeReferenceText(ref)) {return true;}
    if (format === 'X' || format === 'S' || String(item.IsCheckText || '') === '1') {return true;}
    return /尿|URINE|A\/C|ACR|ALB\/CRE|白蛋白|肌酐/.test(name);
  }

  function isEmptyResultValue(item, result) {
    const v = String(result == null ? '' : result).trim();
    if (!v || v === '未检' || v === ' ') {return true;}
    if (v === '-') {return !isDashValidNegativeResult(item || {}, v);}
    return false;
  }

  function isCriticalResultItem(item) {
    const flag = (item.AbFlag || item.CriticalFlag || item.CrisisFlag || item.DangerFlag || item.PanicFlag || '')
      .toString()
      .toUpperCase()
      .trim();
    if (flag === 'HH' || flag === 'LL' || flag === 'CRITICAL' || flag === 'DANGER' || flag === 'PANIC') {return true;}
    if (String(item.IsPanic || item.Panic || '').trim() === '1') {return true;}
    const result = item.TextRes && String(item.TextRes).trim() ? item.TextRes : item.Result;
    const panicStatus = compareResultToPanicRange(result, item);
    if (panicStatus === 'HIGH' || panicStatus === 'LOW') {return true;}
    const text = [
      item.AbFlagDesc,
      item.CriticalFlagDesc,
      item.CrisisFlagDesc,
      item.DangerFlagDesc,
      item.ResultPrompt,
      item.Prompt,
      item.Alert,
      item.Tips,
      item.StatusDesc
    ]
      .map(v => String(v || ''))
      .join(' ');
    if (!text) {return false;}
    // 排除否定语境：「无危急」「非危急」不算危急值
    if (text.indexOf('无危急') !== -1 || text.indexOf('非危急') !== -1) {return false;}
    return text.indexOf('危急') !== -1;
  }

  function isCriticalSpecimenRow(row) {
    if (!row) {return false;}
    if (String(row.IsPanic || row.Panic || '').trim() === '1') {return true;}
    // PanicReportDR: 排除 '0'（LIS 中 '0' 表示无记录，但 JS 中 '0' 为 truthy）
    const prd = String(row.PanicReportDR || '').trim();
    if (prd && prd !== '0') {return true;}
    // 仅检查专用危急值字段（PanicFlag/PanicDesc/PanicText/FlagStr），
    // 不检查通用 Alert/Tips 字段——它们可能含「无危急值」「非危急」等否定语境
    const text = [row.PanicFlag, row.PanicDesc, row.PanicText, row.FlagStr]
      .map(v => String(v || ''))
      .join(' ');
    if (!text) {return false;}
    // 排除否定语境：「无危急」「非危急」不算危急值
    if (text.indexOf('无危急') !== -1 || text.indexOf('非危急') !== -1) {return false;}
    return text.indexOf('危急') !== -1;
  }

  function classifyStatusText(status) {
    if (status === 'NORMAL') {return '正常';}
    if (status === 'CRITICAL') {return '危急';}
    if (status === 'ABNORMAL') {return '异常';}
    if (status === 'UNCERTAIN') {return '待定';}
    return status || '待定';
  }

  function isAutoAuditableClassified(result) {
    return !!result && result.status === 'NORMAL';
  }

  function getLiveClassification(reportDR) {
    if (!reportDR) {return null;}
    return wsClassifiedCache[String(reportDR)] || null;
  }

  function isLiveNormalForBatch(reportDR) {
    const live = getLiveClassification(reportDR);
    if (!live || live.status !== 'NORMAL') {return false;}
    const row = live.row || findWSSpecimenByReportDR(reportDR);
    if (row && isClassificationStale(row)) {return false;}
    return true;
  }

  function validateAuditClassification(reportDR, context) {
    const live = getLiveClassification(reportDR);
    if (!live) {return { ok: false, msg: '分类未完成，请稍候刷新' };}
    const row = live.row || findWSSpecimenByReportDR(reportDR);
    if (row && isClassificationStale(row)) {return { ok: false, msg: '分类已过期，请刷新工作台后重试' };}
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
    if (!r.status) {return '未完成分类，需人工确认';}
    if (r.status === 'CRITICAL') {return `🚨 ${name} 有危急值，必须在原始LIS中审核`;}
    if (r.status === 'ABNORMAL') {return `⚠️ ${name} 有异常结果，需人工审核`;}
    if (r.status === 'UNCERTAIN') {return `⚠️ ${name} 结果待定，需人工确认`;}
    if (r.status !== 'NORMAL') {return `⚠️ ${name} 状态为${classifyStatusText(r.status)}，不可自动审核`;}
    return '';
  }

  function classifyResultItem(item) {
    // 关键：结果为空/缺失 → UNCERTAIN
    const result = (item.TextRes && String(item.TextRes).trim() ? item.TextRes : item.Result || '').trim();
    if (isEmptyResultValue(item, result)) {return 'UNCERTAIN';}

    const flag = (item.AbFlag || '').toUpperCase().trim();
    if (isCriticalResultItem(item)) {return 'CRITICAL';} // 危急值
    if (flag === 'H') {return 'HIGH';}
    if (flag === 'L') {return 'LOW';}
    if (flag === 'A') {return 'ABNORMAL';}

    const qualitativeStatus = compareQualitativeToReference(result, item);
    if (qualitativeStatus) {return qualitativeStatus;}
    if (isDashValidNegativeResult(item, result)) {return 'NORMAL';}

    // 回退：数值比较
    const range = getItemRangeValues(item);
    if (range.low || range.high) {
      const rangeStatus = compareResultToRange(result, range.low, range.high);
      if (rangeStatus) {return rangeStatus;}
    }

    // 无法判断（非数值结果等）→ UNCERTAIN
    if (!parseComparableNumber(result) && !flag) {
      return 'UNCERTAIN';
    }

    return 'NORMAL';
  }

  // --- 后台分类所有未审核的完整标本 ---
  async function classifyAllSpecimens(loadSeq = _wsLoadSeq) {
    // 正在分类时：记下需要重跑（阶段2追加其它工作组数据后必须再分类）
    if (wsClassifying) {
      _classifyPendingRerun = true;
      return;
    }
    wsClassifying = true;
    const runSeq = ++_classifyRunSeq;
    try {
      if (loadSeq !== _wsLoadSeq) {return;}
      // 筛选需要分类的标本：未审核 + 结果完整 + 未缓存
      const toClassify = wsData.filter(r => {
        const status = String(r.Status || r.ReportStatus || '');
        if (status === '3' || status === '4') {return false;}
        const complete = String(r.IsComplete || '');
        if (complete !== '1') {return false;}
        return isClassificationStale(r);
      });

      if (toClassify.length === 0) {
        calcMachineCounts();
        renderWSTabs();
        renderWSCategoryBar();
        renderWSTable();
        return;
      }

      if (wsCategory === 'audit') {
        const selectedMachineSet = wsMachineFilterSetForActiveWG();
        toClassify.sort((a, b) => {
          const score = r => {
            let s = 0;
            if (wsActiveWG && r._wg === wsActiveWG) {s -= 100;}
            if (selectedMachineSet.size && selectedMachineSet.has(String(prWorkGroupMachineDR(r) || r._mdr || '')))
            {s -= 50;}
            else if (wsActiveMachine && prWorkGroupMachineDR(r) === wsActiveMachine) {s -= 50;}
            return s;
          };
          const diff = score(a) - score(b);
          if (diff) {return diff;}
          return compareSpecimensByMachineGroup(a, b);
        });
      }

      dbg('开始分类', toClassify.length, '个标本...');

      // 批量分类（每批 8 个）
      for (let i = 0; i < toClassify.length; i += 8) {
        if (loadSeq !== _wsLoadSeq) {return;}
        if (runSeq !== _classifyRunSeq) {return;} // 强制刷新已作废本轮
        const batch = toClassify.slice(i, i + 8);
        const results = await Promise.all(batch.map(r => fetchAndClassifySpecimen(r)));
        if (loadSeq !== _wsLoadSeq) {return;}
        if (runSeq !== _classifyRunSeq) {return;}
        results.forEach(r => {
          if (r && r.reportDR) {
            r._accessTs = Date.now();
            if (!r.fingerprint && r.row) {attachClassificationMeta(r, r.row);}
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
        if (wsCategory === 'audit') {prefetchAbnormalAuditContext();}
        await new Promise(r => setTimeout(r, 0)); // 仅 yield，不加额外延迟
      }

      dbg('分类完成');
      if (loadSeq !== _wsLoadSeq) {return;}
      if (runSeq !== _classifyRunSeq) {return;}
      calcMachineCounts();
      renderWSTabs();
      renderWSCategoryBar();
      renderWSTable();
    } catch (e) {
      dbg('分类异常:', e);
    } finally {
      if (runSeq === _classifyRunSeq) {wsClassifying = false;}
      // 分类期间又追加了数据（其它工作组）：空闲后立刻再跑一轮
      if (_classifyPendingRerun && runSeq === _classifyRunSeq && loadSeq === _wsLoadSeq) {
        _classifyPendingRerun = false;
        classifyAllSpecimens(loadSeq).catch(e => dbg('分类重跑异常:', e));
      }
    }
  }

  // --- 获取标本详情并分类 ---
  async function fetchAndClassifySpecimen(row) {
    const reportDR = row.ReportDR || row.TodoReportDR || '';
    if (!reportDR) {return { status: 'UNCERTAIN', items: [], row };}

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
      let itemInfo = data && data.ItemInfo ? data.ItemInfo : [];
      const labInfo = data && data.LabInfo ? data.LabInfo : [];

      // 带状态查询返回空时，用空状态重试
      if (itemInfo.length === 0 && (row.Status || row.ReportStatus)) {
        p.set('P3', '');
        data = await fetchJ(CSP + '?' + p.toString());
        itemInfo = data && data.ItemInfo ? data.ItemInfo : [];
      }

      // 缓存原始数据供详情面板复用，避免重复请求
      if (itemInfo.length > 0) {
        _classifyRawCache[reportDR] = { data, ts: Date.now() };
        // 限制缓存大小，防止内存泄漏
        const keys = Object.keys(_classifyRawCache);
        if (keys.length > 200) {
          const sorted = keys.sort((a, b) => (_classifyRawCache[a].ts || 0) - (_classifyRawCache[b].ts || 0));
          for (let i = 0; i < sorted.length - 100; i++) {delete _classifyRawCache[sorted[i]];}
        }
      }

      const classifications = itemInfo.map(item => ({
        name: item.CName || '',
        CName: item.CName || '',
        Code: item.Code || '',
        Synonym: item.Synonym || '',
        result: item.TextRes && String(item.TextRes).trim() ? item.TextRes : item.Result || '',
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
        return attachClassificationMeta(
          {
            status: 'ABNORMAL',
            items: classifications,
            labInfo: labInfo[0] || {},
            row,
            reportDR,
            infectionWarning: isInfectionPanel
          },
          row
        );
      }

      // 关键安全检查：无结果 → UNCERTAIN，绝不自动审核
      if (itemInfo.length === 0) {
        return attachClassificationMeta(
          { status: 'UNCERTAIN', items: [], labInfo: labInfo[0] || {}, row, reportDR },
          row
        );
      }

      const hasAbnormal = classifications.some(
        c => c.status === 'HIGH' || c.status === 'LOW' || c.status === 'ABNORMAL' || c.status === 'CRITICAL'
      );
      const hasCritical =
        isCriticalSpecimenRow(row) || classifications.some(c => c.status === 'CRITICAL' || c.critical);
      const hasUncertain = classifications.some(c => c.status === 'UNCERTAIN');
      const hasComplete = row.IsComplete === '1';
      // 检查是否有结果为空的项目
      const hasEmptyResults = classifications.some(c => isEmptyResultValue(c, c.result));

      let overallStatus = 'NORMAL';
      if (hasCritical) {overallStatus = 'CRITICAL';}
      else if (hasAbnormal) {overallStatus = 'ABNORMAL';}
      else if (hasUncertain || !hasComplete || hasEmptyResults) {overallStatus = 'UNCERTAIN';}

      return attachClassificationMeta(
        {
          status: overallStatus,
          items: classifications,
          labInfo: labInfo[0] || {},
          row,
          reportDR
        },
        row
      );
    } catch (e) {
      dbg('获取标本详情失败:', row.PatName, e);
      return attachClassificationMeta({ status: 'UNCERTAIN', items: [], row, reportDR, error: e.message }, row);
    }
  }

  // --- 传染病项目历史比对 ---
  // x8 仪器的 8 个传染病项目：两对半 + 梅毒 + 丙肝 + 艾滋
  const INFECTION_ITEMS = [
    '乙肝表面抗原',
    'HBsAg',
    '乙肝表面抗体',
    'HBsAb',
    '乙肝e抗原',
    'HBeAg',
    '乙肝e抗体',
    'HBeAb',
    '乙肝核心抗体',
    'HBcAb',
    '梅毒螺旋体抗体',
    'TP',
    '梅毒',
    '丙型肝炎抗体',
    'HCV',
    '丙肝',
    '人类免疫缺陷病毒抗体',
    'HIV',
    '艾滋'
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

    if (infectionItems.length < 5) {return null;} // 不是完整的传染病面板

    // 检查是否有历史阳性现在阴性的情况
    const warnings = [];
    infectionItems.forEach(item => {
      const history = item.preResult;
      if (!history) {return;}

      // 解析历史结果
      const histItems = parsePreResult(history);
      if (histItems.length === 0) {return;}

      // 获取最近的历史结果
      const sorted = [...histItems].sort((a, b) => {
        const da = a.date ? new Date(a.date).getTime() : 0;
        const db = b.date ? new Date(b.date).getTime() : 0;
        return db - da;
      });
      const lastHist = sorted[0];
      const histResult = (lastHist.result || '').trim();

      // 判断历史是否阳性
      const isHistPositive = isPositiveResult(histResult, item);
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
  function isPositiveResult(result, item) {
    if (!result) {return false;}
    const r = result.toUpperCase().trim();
    // 阳性标记
    if (r === '+' || r === '阳性' || r === 'POSITIVE' || r === 'POS' || r === 'REACTIVE') {return true;}
    if (/^\+{1,4}$/.test(r) || r.includes('阳性') || r.includes('弱阳')) {return true;}
    // 数值结果：按参考值范围判断
    const num = parseFloat(r);
    if (!isNaN(num)) {
      if (item) {
        const range = getItemRangeValues(item);
        const high = parseComparableNumber(range.high);
        // 如果有上限参考值，按参考值判断
        if (high && !isNaN(high.value)) {
          // 结果在参考值范围内 = 阴性
          if (num <= high.value) {return false;}
          // 结果超出参考值范围 = 阳性
          return true;
        }
      }
      // 没有参考值时，使用通用的 S/CO 逻辑（>1 为阳性）
      if (num > 1) {return true;}
    }
    return false;
  }

  // 判断是否阴性结果
  function isNegativeResult(result) {
    if (!result) {return false;}
    const r = result.toUpperCase().trim();
    if (r === '-' || r === '阴性' || r === 'NEGATIVE' || r === 'NEG' || r === 'NON-REACTIVE') {return true;}
    if (r.includes('阴性') || r.includes('阴')) {return true;}
    // 数值 < 1（S/CO 值通常 <1 为阴性）
    const num = parseFloat(r);
    if (!isNaN(num) && num < 1) {return true;}
    return false;
  }

  // ==================== x8 传染病：梅毒/丙肝/HIV 阳性专用高亮 ====================
  // 与乙肝两对半阳性（粉色 abnormal）区分，三个项目统一一种醒目色，防漏发报告
  const INFECTION_SPECIAL_NAMES = [
    '梅毒螺旋体抗体',
    '梅毒抗体',
    'tp',
    '梅毒', // 梅毒
    '丙型肝炎病毒抗体测定',
    '丙型肝炎抗体',
    '丙肝抗体',
    '抗-hcv',
    'hcv',
    '丙肝', // 丙肝
    '人类免疫缺陷病毒抗体测定',
    '人免疫缺陷病毒抗体测定',
    'hiv抗体',
    'hiv',
    '艾滋' // HIV/艾滋
  ];
  const INFECTION_SPECIAL_LABEL = '梅毒/丙肝/HIV';
  const INFECTION_SPECIAL_STYLE = { bg: '#fff176', border: '#f9a825' }; // 亮黄

  // 项目名称是否命中特殊传染病项目（梅毒/丙肝/HIV）
  function isInfectionSpecialItem(name) {
    if (!name) {return false;}
    const n = String(name).toLowerCase();
    return INFECTION_SPECIAL_NAMES.some(k => n.includes(k.toLowerCase()));
  }

  // 是否 x8 仪器 / 传染病面板（仅在传染病面板内启用特殊高亮）
  function isX8InfectionPanel(row) {
    const machineName = ((row && (row._mn || row.Name || row.CName)) || '').toLowerCase();
    return machineName.includes('x8') || machineName.includes('传染病');
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

  // --- 顶部悬停审核条：已禁用（用户不需要，易误触）---
  // 批审/快捷键仍走工作台与 Alt+A/B；此处只清理历史残留 DOM
  function injectToolbar() {
    try {
      const tb = document.getElementById('lis-toolbar');
      if (tb) {tb.remove();}
      const hz = document.getElementById('lis-tb-hoverzone');
      if (hz) {hz.remove();}
    } catch (e) {}
  }

  // --- 更新工具栏统计 ---
  async function updateToolbarStats() {
    const statEl = document.getElementById('lis-tb-stat');
    if (!statEl) {return;}

    const eligible = getAuditEligibleRows();
    const total = eligible.length;

    if (total === 0) {
      statEl.innerHTML = '<span class="st-total">✅ 无待审核标本</span>';
      return;
    }

    statEl.innerHTML = `<span class="st-total">待审核: ${total}</span><span style="color:rgba(255,255,255,.5);font-size:11px">点击刷新</span>`;

    // 异步获取每个标本的分类（只取前50个避免过慢）
    const toCheck = eligible.slice(0, 50);
    let normal = 0,
      abnormal = 0,
      critical = 0,
      uncertain = 0;

    // 并发获取（每批10个）
    const allResults = [];
    for (let i = 0; i < toCheck.length; i += 10) {
      const batch = toCheck.slice(i, i + 10);
      const results = await Promise.all(batch.map(r => fetchAndClassifySpecimen(r)));
      allResults.push(...results);
      results.forEach(r => {
        if (r.status === 'NORMAL') {normal++;}
        else if (r.status === 'CRITICAL') {critical++;}
        else if (r.status === 'ABNORMAL') {abnormal++;}
        else {uncertain++;}
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
    _toolbarClassifiedRows = toCheck;
    _toolbarClassifiedResults = allResults;
  }

  // --- 快速审核当前标本 ---
  async function quickAuditCurrent() {
    const auditLockId = acquireAuditLock('quickAudit');
    if (!auditLockId) {return;}
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
    if (btn) {
      btn.disabled = true;
      btn.textContent = '⏳ 审核中...';
    }

    try {
      const cached = wsClassifiedCache[selected.ReportDR];
      const result = cached && !isClassificationStale(selected) ? cached : await fetchAndClassifySpecimen(selected);

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

      const iframeWin = getReportIframeWin() || (await ensureReportPageLoaded());
      if (!iframeWin) {
        showToast('未找到报告处理页面，请先打开"报告处理"', 'error');
        return;
      }
      const auditCtx = auditTargetContext(iframeWin, reportDR);
      const caReady = isCASessionReady(iframeWin);
      let auditOK = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth', {
        action: 'audit',
        expectedStatuses: ['3'],
        timeoutMs: caReady ? 8000 : 15000,
        caSessionReady: caReady,
        missingAsSuccess: auditCtx.allowMissingSuccess,
        targetReportDR: reportDR
      });
      if (!auditOK) {
        auditOK = await confirmAuditEventually(iframeWin, reportDR, selected.PatName || selected.Labno || '', {
          targetWasPresent: auditCtx.rowPresent,
          detailWasReady: auditCtx.detailReady
        });
      }
      if (auditOK === 'incomplete') {
        showToast(`⚠️ 跳过: ${selected.PatName || ''} — 结果不完整，不可审核`, 'warning');
      } else if (auditOK) {
        showToast(`✅ 已审核: ${selected.PatName || ''}`, 'success');
        advanceToNextSpecimen();
      } else {
        showToast('⚠️ 审核失败，请手动点击底部工具栏的"审核"按钮', 'warning');
      }
    } catch (e) {
      dbg('快速审核失败:', e);
      showToast('审核失败: ' + e.message, 'error');
    } finally {
      releaseAuditLock(auditLockId);
      if (btn) {
        btn.disabled = false;
        btn.textContent = '⚡ 审核';
      }
    }
  }

  // --- 跳转到下一个待审核标本 ---
  function advanceToNextSpecimen() {
    const rows = getNativeDatagridRows();
    const selected = getNativeSelectedRow();
    if (!selected) {return;}

    const selectedDR = selected.ReportDR || '';
    const currentIndex = rows.findIndex(r => (r.ReportDR || '') === selectedDR);
    if (currentIndex === -1) {return;}

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
    if (!selected) {return;}

    const selectedDR = selected.ReportDR || '';
    const currentIndex = rows.findIndex(r => (r.ReportDR || '') === selectedDR);
    if (currentIndex === -1) {return;}

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
    if (!auditLockId) {return;}
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
      if (specimens.length === 0) {
        toast('没有可审核的标本', 'w');
        return;
      }
      const formatted = specimens.map(s => {
        const cached = wsClassifiedCache[s.ReportDR];
        if (cached && !isClassificationStale(s)) {return { ...cached, row: s, reportDR: s.ReportDR };}
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
    if (existing) {existing.remove();}

    const dialog = document.createElement('div');
    dialog.id = 'lis-audit-confirm';

    let abnormalHTML = '';
    if (abnormal.length > 0) {
      abnormalHTML = `
                <div class="ab-section">
                    <h5><span class="ab-count" style="background:#e74c3c">${abnormal.length}</span> 异常标本（需人工审核）</h5>
                    <div class="ab-list">
                        ${abnormal
    .map(r => {
      const abnormalItems = r.items.filter(i => i.status !== 'NORMAL');
      const names = abnormalItems.map(i => `${i.name} ${i.result}${i.unit}`).join(', ');
      return `<div class="ab-item">
                                <span class="ab-name">${esc(r.row.PatName || '未知')}</span>
                                <span class="ab-detail">${esc(r.row.Labno || '')} | ${esc(r.row.TestSetDesc || '')}</span>
                                <span class="ab-tag" style="background:#fce4ec;color:#c62828">⚠ ${esc(names)}</span>
                            </div>`;
    })
    .join('')}
                    </div>
                </div>`;
    }

    let uncertainHTML = '';
    if (uncertain.length > 0) {
      uncertainHTML = `
                <div class="ab-section">
                    <h5><span class="ab-count" style="background:#f39c12">${uncertain.length}</span> 待定标本（需人工确认）</h5>
                    <div class="ab-list">
                        ${uncertain
    .map(
      r => `<div class="ab-item">
                            <span class="ab-name">${esc(r.row.PatName || '未知')}</span>
                            <span class="ab-detail">${esc(r.row.Labno || '')} | ${esc(r.row.TestSetDesc || '')}</span>
                            <span class="ab-tag" style="background:#fff3e0;color:#e65100">?</span>
                        </div>`
    )
    .join('')}
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
                            ${normal
    .map(
      r => `<div class="ab-item">
                                <span class="ab-name">${esc(r.row.PatName || '未知')}</span>
                                <span class="ab-detail">${esc(r.row.Labno || '')} | ${esc(r.row.TestSetDesc || '')}</span>
                                <span class="ab-tag" style="background:#e8f5e9;color:#2e7d32">✓ 正常</span>
                            </div>`
    )
    .join('')}
                        </div>
                    </div>
                    ${abnormalHTML}
                    ${uncertainHTML}
                    <div class="ab-check">
                        <input type="checkbox" id="lis-ab-check" />
                        <label for="lis-ab-check">我确认以上 ${normal.length} 个正常标本的检验结果均适合自动审核</label>
                    </div>
                    <p style="margin:8px 0 0;font-size:12px;color:#0d6655"><kbd style="background:#e8f5e9;padding:1px 6px;border-radius:3px">F4</kbd> 勾选并确认审核 · Esc 取消</p>
                </div>
                <div class="ab-ft">
                    <button class="ab-export" id="lis-ab-export">📥 导出审核清单</button>
                    <button class="ab-cancel" id="lis-ab-cancel">取消</button>
                    <button class="ab-confirm ok" id="lis-ab-confirm" disabled>✅ 确认审核 (${normal.length}) · F4</button>
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

    let closed = false;
    const cleanupAndRemove = () => {
      if (closed) {return;}
      closed = true;
      document.removeEventListener('keydown', keyHandler, true);
      dialog.remove();
    };
    const doConfirm = () => {
      if (closed || normal.length === 0) {return;}
      // F4：自动勾选确认，避免再点一次复选框
      if (checkBtn && !checkBtn.checked) {
        checkBtn.checked = true;
        confirmBtn.disabled = false;
      }
      if (confirmBtn.disabled) {return;}
      cleanupAndRemove();
      executeBatchAudit(normal).catch(e => {
        console.error('[LIS] 批审异常:', e);
      });
    };
    const keyHandler = e => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        cleanupAndRemove();
        return;
      }
      if (e.key === 'F4' || (e.key === 'Enter' && !e.shiftKey && e.target !== checkBtn)) {
        e.preventDefault();
        e.stopImmediatePropagation();
        doConfirm();
      }
    };
    document.addEventListener('keydown', keyHandler, true);

    document.getElementById('lis-ab-close').addEventListener('click', cleanupAndRemove);
    document.getElementById('lis-ab-cancel').addEventListener('click', cleanupAndRemove);
    dialog.addEventListener('click', e => {
      if (e.target === dialog) {cleanupAndRemove();}
    });

    confirmBtn.addEventListener('click', () => {
      if (confirmBtn.disabled) {return;}
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
    if (!jq) {
      dbg('selectNativeRow: jq 不存在');
      return false;
    }
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
          // 用 getData 获取原始数据（不受展开行影响）
          let dataRows;
          try {
            const data = el.datagrid('getData');
            dataRows = data && data.rows ? data.rows : null;
          } catch (e) {}
          if (!dataRows) {dataRows = el.datagrid('getRows');}
          if (!dataRows || dataRows.length === 0) {
            dbg('selectNativeRow:', sel, '无行行数据');
            continue;
          }

          let targetIdx = -1;
          let targetRow = null;
          for (let i = 0; i < dataRows.length; i++) {
            if (String(dataRows[i].ReportDR) === String(reportDR)) {
              targetIdx = i;
              targetRow = dataRows[i];
              break;
            }
          }
          if (targetIdx < 0) {
            dbg('selectNativeRow:', sel, '未找到 ReportDR:', reportDR, '共', dataRows.length, '行');
            continue;
          }

          const opts = el.datagrid('options') || {};

          // 清除选中
          try {
            el.datagrid('clearSelections');
          } catch (e) {}

          // 尝试用 DOM 直接点击目标行（绕过索引问题）
          let domClicked = false;
          try {
            const gridBody = el.closest('.datagrid').find('.datagrid-body');
            const rows = gridBody.find('tr.datagrid-row');
            rows.each(function () {
              const rowJq = jq(this);
              const rowIdx = rowJq.attr('datagrid-row-index');
              if (rowIdx !== undefined) {
                const rowData = el.datagrid('getRows')[parseInt(rowIdx)];
                if (rowData && String(rowData.ReportDR) === String(reportDR)) {
                  // 确认是父行（非子行）
                  if (!rowJq.hasClass('treegrid-tr-tree') && !rowJq.hasClass('datagrid-row-child')) {
                    rowJq.trigger('click');
                    domClicked = true;
                    dbg('selectNativeRow: DOM 点击行 index=' + rowIdx, 'ReportDR=' + reportDR);
                    return false; // break each
                  }
                }
              }
            });
          } catch (e) {
            dbg('selectNativeRow: DOM 点击失败', e.message);
          }

          if (!domClicked) {
            // 回退：用 selectRow
            el.datagrid('selectRow', targetIdx);
          }

          if (iframeWin.me) {
            iframeWin.me.selectedGrid = el;
            iframeWin.me.curReportDR = String(reportDR);
          }
          if (!domClicked) {
            try {
              if (typeof opts.onSelect === 'function') {opts.onSelect.call(el[0], targetIdx, targetRow);}
              else if (typeof opts.onClickRow === 'function') {opts.onClickRow.call(el[0], targetIdx, targetRow);}
            } catch (e) {
              dbg('触发行选择回调异常:', e.message);
            }
          }
          const loaded = isReportDetailLoaded(iframeWin, reportDR);
          dbg(
            '选中原生行:',
            targetIdx,
            'ReportDR:',
            reportDR,
            'PatName:',
            targetRow.PatName || '',
            'domClicked:',
            domClicked,
            'selector:',
            sel,
            'detailReady=',
            loaded
          );
          return true;
        } catch (e) {
          dbg('selectNativeRow error:', sel, e);
        }
      }
    }
    dbg('selectNativeRow: 工作列表未找到 datagrid 或目标行');
    return false;
  }

  async function refreshNativeWorkListAllMachines(iframeWin, options = {}) {
    if (!iframeWin) {return iframeWin;}
    const jq = iframeWin.jQuery || iframeWin.$;
    const me = iframeWin.me;
    if (!jq || !me) {return iframeWin;}
    try {
      if (me.WorkGroupMachineDR !== undefined) {me.WorkGroupMachineDR = '';}
      try {
        jq('#cmb_WorkGroupMachine').combogrid('setValue', '');
      } catch (e) {}
      const dateStr = jq('#dt_wlReportDate').length
        ? jq('#dt_wlReportDate').datebox('getValue') || jq('#dt_wlReportDate').datebox('getText') || today()
        : today();
      const findStr = '&WorkGroupMachineDR=&ReportStatus=&SttAccDate=' + dateStr;
      if (typeof iframeWin.ShowWorkList === 'function') {iframeWin.ShowWorkList(findStr);}
      await sleep(options.fast ? 120 : 250);
      dbg('原生工作列表已切换为全部仪器');
    } catch (e) {
      dbg('切换全部仪器列表异常:', e);
    }
    return getReportIframeWin() || iframeWin;
  }

  async function refreshNativeWorkListForItem(iframeWin, item, options = {}) {
    if (!iframeWin || !item) {return iframeWin;}
    const jq = iframeWin.jQuery || iframeWin.$;
    const me = iframeWin.me;
    if (!jq || !me) {return iframeWin;}
    const mdrKey = String(item.mdr || '');
    const machineChanged = mdrKey && String(me.WorkGroupMachineDR || '') !== mdrKey;
    if (!machineChanged && !options.force) {return iframeWin;}
    try {
      if (item.mdr) {
        if (me.WorkGroupMachineDR !== undefined) {me.WorkGroupMachineDR = item.mdr;}
        try {
          jq('#cmb_WorkGroupMachine').combogrid('setValue', item.mdr);
        } catch (e) {}
      }
      const dateStr = jq('#dt_wlReportDate').length
        ? jq('#dt_wlReportDate').datebox('getValue') || jq('#dt_wlReportDate').datebox('getText') || today()
        : today();
      const findStr = '&WorkGroupMachineDR=' + (item.mdr || '') + '&ReportStatus=&SttAccDate=' + dateStr;
      if (typeof iframeWin.ShowWorkList === 'function') {iframeWin.ShowWorkList(findStr);}
      else if (typeof iframeWin.FindFast === 'function') {iframeWin.FindFast(item.labno || findStr);}
      await sleep(options.fast ? 70 : options.force ? 120 : machineChanged ? 100 : 60);
    } catch (e) {
      dbg('刷新原生工作列表异常:', e);
    }
    return getReportIframeWin() || iframeWin;
  }

  function updateBatchProgress(text, pct) {
    const textEl = document.getElementById('lis-prog-text');
    const fillEl = document.getElementById('lis-prog-fill');
    if (textEl && text) {textEl.textContent = text;}
    if (fillEl && typeof pct === 'number') {fillEl.style.width = Math.max(0, Math.min(100, pct)) + '%';}
  }

  async function waitAndSelectNativeRow(iframeWin, item, options = {}) {
    const timeoutMs = typeof options === 'number' ? options : options.timeoutMs || 9000;
    const pollMs = (typeof options === 'object' && options.pollMs) || 60;
    const skipListRefresh = typeof options === 'object' && !!options.skipListRefresh;
    const selOpts = typeof options === 'object' && options.force ? { force: true } : {};
    const end = Date.now() + timeoutMs;
    let refreshed = skipListRefresh;
    iframeWin = getReportIframeWin() || iframeWin;
    if (iframeWin && selectNativeRowByReportDR(iframeWin, item.reportDR, selOpts)) {
      return { ok: true, iframeWin };
    }
    if (
      item.labno &&
      iframeWin &&
      typeof iframeWin.FindFast === 'function' &&
      canScriptSelectNativeRow(iframeWin, item.reportDR)
    ) {
      try {
        iframeWin.FindFast(item.labno);
        await sleep(80);
        iframeWin = getReportIframeWin() || iframeWin;
        if (iframeWin && selectNativeRowByReportDR(iframeWin, item.reportDR, selOpts)) {
          return { ok: true, iframeWin };
        }
      } catch (e) {}
    }
    while (Date.now() < end) {
      if (!refreshed) {
        refreshed = true;
        iframeWin = await refreshNativeWorkListForItem(iframeWin, item, { force: true });
      } else {
        await sleep(pollMs);
      }
      iframeWin = getReportIframeWin() || iframeWin;
      if (iframeWin && selectNativeRowByReportDR(iframeWin, item.reportDR, selOpts)) {
        return { ok: true, iframeWin };
      }
    }
    return { ok: false, iframeWin };
  }

  function peekNextBatchItem(queue) {
    if (!queue || !queue.items) {return null;}
    const idx = (queue.current || 0) + 1;
    return idx < queue.items.length ? queue.items[idx] : null;
  }

  function prepareNextBatchItemAfterAudit(iframeWin, queue, currentItem) {
    const next = peekNextBatchItem(queue);
    if (!next || !iframeWin || !iframeWin.me) {return false;}
    if (String(next.mdr || '') !== String(currentItem.mdr || '')) {return false;}
    try {
      const sel = iframeWin.me.selectedGrid ? iframeWin.me.selectedGrid.datagrid('getSelected') : null;
      return !!(sel && String(sel.ReportDR || '') === String(next.reportDR || ''));
    } catch (e) {
      return false;
    }
  }

  function requeueAuditItem(queue, item, reason) {
    item.retry = (item.retry || 0) + 1;
    // 最多队尾重试 3 次（选行失败/未确认等），提高「真漏审」补上的机会
    if (item.retry <= 3) {
      queue.items.push(item);
      dbg('批审临时跳过，放回队尾重试:', item.name || item.labno || item.reportDR, reason, 'retry=', item.retry);
      return true;
    }
    queue.skipped.push({ ...item, reason });
    return false;
  }

  // 单条补审：用于主循环漏掉的标本（只关心审掉，不关心计数文案）
  async function auditOneQueueItemOnce(iframeWin, item, options = {}) {
    iframeWin = getReportIframeWin() || iframeWin;
    if (!iframeWin || !item || !item.reportDR) {return { ok: false, iframeWin };}
    if (verifyAuditSucceededByReportDR(iframeWin, item.reportDR)) {
      return { ok: true, iframeWin, already: true };
    }
    const sel = await waitAndSelectNativeRow(iframeWin, item, {
      timeoutMs: options.timeoutMs || 4000,
      pollMs: 40,
      force: true
    });
    iframeWin = sel.iframeWin || iframeWin;
    if (!sel.ok) {
      if (item.mdr) {
        iframeWin = await refreshNativeWorkListForItem(iframeWin, item, { force: true, fast: true });
        const sel2 = await waitAndSelectNativeRow(iframeWin, item, {
          timeoutMs: 3500,
          pollMs: 40,
          skipListRefresh: true,
          force: true
        });
        iframeWin = sel2.iframeWin || iframeWin;
        if (!sel2.ok) {return { ok: false, iframeWin, reason: 'select' };}
      } else {
        return { ok: false, iframeWin, reason: 'select' };
      }
    }
    let ready = isReportDetailLoaded(iframeWin, item.reportDR);
    if (!ready) {ready = await waitReportDetailReady(iframeWin, item.reportDR, 4000, { fastBatch: true });}
    if (!ready) {
      selectNativeRowByReportDR(iframeWin, item.reportDR, { force: true });
      ready = await waitReportDetailReady(iframeWin, item.reportDR, 2500, { fastBatch: true });
    }
    if (!ready) {return { ok: false, iframeWin, reason: 'detail' };}

    const caReady = isCASessionReady(iframeWin) || anyCAUkeyPresent(iframeWin);
    let result = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth', {
      action: 'audit',
      expectedStatuses: ['3'],
      batchMode: true,
      timeoutMs: caReady ? 4000 : 8000,
      keepWS: !!options.keepWS,
      caSessionReady: caReady,
      missingAsSuccess: true,
      targetReportDR: item.reportDR
    });
    if (!result) {
      await sleep(300);
      iframeWin = getReportIframeWin() || iframeWin;
      result = verifyAuditSucceededByReportDR(iframeWin, item.reportDR) ||
              softAuditSuccessHint(iframeWin, item.reportDR);
    }
    if (!result) {
      await sleep(500);
      iframeWin = getReportIframeWin() || iframeWin;
      result = verifyAuditSucceededByReportDR(iframeWin, item.reportDR) ||
              softAuditSuccessHint(iframeWin, item.reportDR);
    }
    // 最终延迟校验
    if (!result) {
      await sleep(1000);
      iframeWin = getReportIframeWin() || iframeWin;
      result = verifyAuditSucceededByReportDR(iframeWin, item.reportDR) ||
               softAuditSuccessHint(iframeWin, item.reportDR);
    }
    if (result) {closeNativeAuditSuccessMessage(iframeWin);}
    return { ok: !!result, iframeWin };
  }

  // --- 执行批量审核（逐行审核）---
  async function executeBatchAudit(normalSpecimens) {
    if (normalSpecimens.length === 0) {return;}
    if (wsClassifying) {
      showToast('标本正在分类中，请等候分类完成后再批审', 'warning');
      return;
    }
    const queue = makeAuditQueue(normalSpecimens, 'batch');
    if (queue.items.length === 0) {
      showToast('没有可审核的标本', 'warning');
      return;
    }
    await continueAuditQueue(queue);
  }

  async function continueAuditQueue(queue) {
    if (!queue || !queue.items || queue.items.length === 0) {return;}
    if (wsClassifying) {
      queue._classifyingRetries = (queue._classifyingRetries || 0) + 1;
      // 上限 90 次×2s=3 分钟：首次打开工作台 + 大工作量时分类（8/轮 + 追加组重跑）很容易超 60s
      if (queue._classifyingRetries > 90) {
        dbg('批审等待分类超过 3 分钟，放弃并保存队列');
        showToast('分类长时间未完成，已保存批审队列，请刷新工作台后重试', 'error');
        delete queue._classifyingRetries;
        saveAuditQueueNow(queue);
        return;
      }
      if (queue._classifyingRetries === 1) {
        showToast('标本正在分类中，完成后自动继续批审...', 'warning');
      } else if (queue._classifyingRetries === 30) {
        showToast('分类仍在进行（已等待约 1 分钟），完成后自动批审...', 'info');
      } else if (queue._classifyingRetries === 60) {
        showToast('数据量较大，分类还需片刻（已等待约 2 分钟）...', 'info');
      }
      saveAuditQueueNow(queue);
      setTimeout(() => continueAuditQueue(queue).catch(e => dbg('批审等待分类失败:', e)), 2000);
      return;
    }
    queue._classifyingRetries = 0;
    const auditLockId = acquireAuditLock('batchAudit');
    if (!auditLockId) {
      showToast('正在审核中，请稍候', 'warning');
      return;
    }
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
    if (queue.keepWS) {keepWorkbenchOnTop('批审开始');}
    const resumeWSRefresh = !!wsTimer;
    stopWSRefresh();

    // 显示进度条
    let progress = document.getElementById('lis-audit-progress');
    if (progress) {progress.remove();}
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
    setTimeout(() => {
      const stopBtn = document.getElementById('lis-batch-stop');
      if (stopBtn)
      {stopBtn.onclick = () => {
        _batchAbort = true;
        stopBtn.textContent = '正在停止...';
        stopBtn.disabled = true;
      };}
    }, 50);
    document.body.appendChild(progress);
    progress.classList.add('show');

    try {
      const sameWG = await ensureAuditQueueWorkGroup(queue);
      if (!sameWG) {
        progress.remove();
        return;
      } /* ensureAuditQueueWorkGroup 内已 schedule 续跑 */

      // 跨组续跑后页面重载，wsData 可能为空——等待工作台数据加载完成
      // 否则 resolveQueueItemRow 找不到标本行，全部被跳过为「分类缓存缺失」
      if (!wsData.length) {
        updateBatchProgress('正在加载工作台数据...', 0);
        let _wsWaited = 0;
        while (!wsData.length && _wsWaited < 30) {
          await new Promise(r => setTimeout(r, 1000));
          _wsWaited++;
        }
        // keepWorkbenchOnTop 未调用或 loadWSData 失败时，主动加载
        if (!wsData.length) {
          try { await loadWSData(); } catch (e) { dbg('批审前加载工作台数据失败:', e); }
        }
        if (!wsData.length) {
          showToast('工作台数据加载失败，请刷新工作台后重试', 'error');
          progress.remove();
          return;
        }
      }

      let iframeWin = getReportIframeWin();
      if (!iframeWin) {
        showToast('正在加载报告页面...', 'warning');
        iframeWin = await ensureReportPageLoaded({ keepWS: queue.keepWS });
        if (queue.keepWS) {keepWorkbenchOnTop('报告处理页加载完成');}
      }
      if (!iframeWin) {
        showToast('❌ 未找到报告处理页面', 'error');
        progress.remove();
        return;
      }

      // 等待 iframe 就绪
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
            if (jq && me) {break;}
          }
        }
      }
      if (!jq || !me) {
        showToast('报告页面未就绪，请稍后重试', 'error');
        progress.remove();
        return;
      }

      updateBatchProgress('准备批审：恢复审核登录 / 检查 CA...', 0);

      let successCount = queue.done.length,
        failCount = queue.failed.length,
        skipCount = queue.skipped.length;
      let totalCount = queue.items.length;
      let queuePausedForSwitch = false;
      let batchLastMdr = '';
      let batchListFresh = false;
      let batchSkipSelect = false;
      queue.caReadyByWg = queue.caReadyByWg || {};
      _batchAbort = false;

      // 批审前对齐原生 ReportSave 的审核用户 + CA Ukey，避免每条重弹/空等
      const prereq = await ensureBatchAuthAndCAReady(iframeWin, {
        onProgress: msg => updateBatchProgress(msg, 0)
      });
      iframeWin = getReportIframeWin() || iframeWin;
      if (iframeWin) {
        jq = iframeWin.jQuery || iframeWin.$;
        me = iframeWin.me;
      }
      let batchCAReady = !!(queue.caReadyByWg[resolveCurrentWG()] || prereq.caReady || isCASessionReady(iframeWin));
      if (batchCAReady) {queue.caReadyByWg[resolveCurrentWG()] = true;}
      dbg('批审前置: caReady=', batchCAReady, 'caUser=', prereq.caUser, getReportCAUserDR(iframeWin));

      if (queue.current < queue.items.length - 1) {
        const remaining = queue.items.splice(queue.current);
        remaining.sort(compareAuditQueueItems);
        queue.items.push(...remaining);
      }

      const prepHint = batchCAReady ? 'CA 已就绪，秒审模式...' : '首条将自动 CA 认证，加载全部仪器列表...';
      updateBatchProgress(prepHint, 0);
      iframeWin = await refreshNativeWorkListAllMachines(iframeWin, { fast: true });
      if (iframeWin) {
        jq = iframeWin.jQuery || iframeWin.$;
        me = iframeWin.me;
      }
      // 刷新列表后 me 可能被重置，再恢复一次审核态
      if (batchCAReady) {
        try {
          restoreAuth();
          const au = sessionStorage.getItem('AuInfo') || localStorage.getItem(K.au);
          if (au && me) {
            const parts = String(au).split('^');
            if (parts[0]) {
              me.AuthUserDR = parts[0];
              me.IsAuthLogin = 1;
            }
          }
          if (typeof iframeWin.GetAuthLoginInfo === 'function') {iframeWin.GetAuthLoginInfo();}
        } catch (e) {}
        batchCAReady = isCASessionReady(iframeWin) || batchCAReady;
      }
      batchListFresh = true;

      while (queue.current < queue.items.length) {
        if (_batchAbort) {
          dbg('批审被用户中止');
          saveAuditQueueNow(queue);
          break;
        }
        if (isAuditLockAborted(auditLockId)) {
          dbg('批审因审核锁超时被中止');
          saveAuditQueueNow(queue);
          break;
        }

        const item = currentQueueItem(queue);
        if (!item) {break;}

        refreshQueueLock();
        refreshAuditLock(auditLockId); // 心跳：健康长批审不被 45s 假死判定误抢
        const liveRow = resolveQueueItemRow(item);
        if (liveRow && String(liveRow.IsComplete || '') !== '1') {
          queue.skipped.push({ ...item, reason: '结果不完整' });
          skipCount++;
          queue.current++;
          saveAuditQueueNow(queue);
          continue;
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
            } catch (e) {
              dbg('批审前重分类失败:', item.reportDR, e.message);
            }
          }
        }
        if (!liveClassified) {
          queue.skipped.push({ ...item, reason: '分类缓存缺失，需刷新后重试' });
          skipCount++;
          queue.current++;
          saveAuditQueueNow(queue);
          continue;
        }
        if (!isAutoAuditableClassified(liveClassified)) {
          queue.skipped.push({ ...item, reason: classifyStatusText(liveClassified.status) + '标本不可自动审核' });
          skipCount++;
          queue.current++;
          saveAuditQueueNow(queue);
          continue;
        }

        if (item.wg && item.wg !== resolveCurrentWG()) {
          if (batchCAReady && resolveCurrentWG()) {queue.caReadyByWg[resolveCurrentWG()] = true;}
          queue.pausedForSwitch = true;
          saveAuditQueueNow(queue);
          const wgName = (WG_MAP[item.wg] || {}).name || item.wg;
          const nextCaHint = queue.caReadyByWg[item.wg] ? '（该组已 CA，秒审）' : '（该组首条将自动 CA）';
          showToast('切换到' + wgName + '继续批审' + nextCaHint, 'warning');
          queuePausedForSwitch = true;
          safeSwitchWG(item.wg);
          runAuditQueueResume(2500);
          break;
        }

        const itemWg = item.wg || resolveCurrentWG();
        // 每条开始时以真实 Ukey 为准（不要被过期缓存拖回慢路径）
        batchCAReady = isCASessionReady(iframeWin) || !!queue.caReadyByWg[itemWg];
        if (batchCAReady) {queue.caReadyByWg[itemWg] = true;}

        batchListFresh = false;
        totalCount = queue.items.length;
        let etaStr = '';
        if (queue.current > 0) {
          const elapsed = Date.now() - _batchStartTime;
          const perItem = elapsed / queue.current;
          const remaining = perItem * (totalCount - queue.current);
          const sec = Math.ceil(remaining / 1000);
          etaStr = sec > 60 ? ` · 剩余约${Math.ceil(sec / 60)}分钟` : ` · 剩余约${sec}秒`;
        }
        const modeHint = batchCAReady ? ' · 秒审' : ' · 自动CA';
        const itemLabel = item.name || item.labno || item.reportDR;
        const itemBase = `${queue.current + 1} / ${totalCount} - ${itemLabel}${item.retry ? '（重试' + item.retry + '）' : ''}`;
        updateBatchProgress(`${itemBase}${modeHint}${etaStr}`, (queue.current / totalCount) * 100);

        // 单条硬超时：避免一条标本拖死整批（表现为卡半天最后又成功）
        const itemDeadline =
          Date.now() + (batchCAReady ? BATCH_ITEM_DEADLINE_MS.caReady : BATCH_ITEM_DEADLINE_MS.needCA);
        const itemAbort = () => _batchAbort || isAuditLockAborted(auditLockId) || Date.now() > itemDeadline;
        const progressPhase = (phase, elapsedMs) => {
          const wait = typeof elapsedMs === 'number' && elapsedMs > 0 ? ` ${Math.round(elapsedMs / 1000)}s` : '';
          updateBatchProgress(
            `${itemBase} - ${phase || '处理中'}${wait}${modeHint}`,
            ((queue.current + 0.5) / totalCount) * 100
          );
        };

        try {
          if (!jq || !me) {
            iframeWin = getReportIframeWin();
            if (iframeWin) {
              jq = iframeWin.jQuery || iframeWin.$;
              me = iframeWin.me;
            }
          }
          if (!jq || !me) {
            queue.failed.push({ ...item, reason: '页面未就绪' });
            failCount++;
            continue;
          }

          let selectedOk = batchSkipSelect;
          batchSkipSelect = false;
          if (selectedOk && !isReportDetailLoaded(iframeWin, item.reportDR)) {
            dbg('批审: 自动跳下一条校验失败，重新选行', item.reportDR);
            selectedOk = false;
          }
          if (!selectedOk) {
            progressPhase('选中标本');
            const selectedResult = await waitAndSelectNativeRow(iframeWin, item, {
              timeoutMs: batchCAReady ? 2800 : batchListFresh ? 4000 : 5000,
              pollMs: batchCAReady ? 30 : 45,
              skipListRefresh: batchListFresh
            });
            iframeWin = selectedResult.iframeWin || iframeWin;
            if (iframeWin) {
              jq = iframeWin.jQuery || iframeWin.$;
              me = iframeWin.me;
            }
            selectedOk = selectedResult.ok;
            if (!selectedOk && item.mdr) {
              dbg('全部仪器列表未找到，回退切换仪器:', item.mdr);
              iframeWin = await refreshNativeWorkListForItem(iframeWin, item, { force: true, fast: true });
              if (iframeWin) {
                jq = iframeWin.jQuery || iframeWin.$;
                me = iframeWin.me;
              }
              batchLastMdr = String(item.mdr);
              batchListFresh = true;
              const retrySel = await waitAndSelectNativeRow(iframeWin, item, {
                timeoutMs: 2800,
                pollMs: 35,
                skipListRefresh: true
              });
              iframeWin = retrySel.iframeWin || iframeWin;
              selectedOk = retrySel.ok;
            }
          }
          if (!selectedOk) {
            if (!requeueAuditItem(queue, item, '原生列表未找到')) {skipCount++;}
            continue;
          }
          if (itemAbort() && !_batchAbort) {
            // 选行阶段就超时：放回队尾，不记失败
            if (!requeueAuditItem(queue, item, '单项准备超时')) {skipCount++;}
            continue;
          }

          progressPhase('加载详情');
          let detailReady = isReportDetailLoaded(iframeWin, item.reportDR);
          const detailTimeout = batchCAReady ? 2800 : 5500;
          const detailRetry = batchCAReady ? 1500 : 3000;
          if (!detailReady) {
            detailReady = await waitReportDetailReady(iframeWin, item.reportDR, detailTimeout, { fastBatch: true });
          }
          if (!detailReady) {
            selectNativeRowByReportDR(iframeWin, item.reportDR);
            detailReady = await waitReportDetailReady(iframeWin, item.reportDR, detailRetry, { fastBatch: true });
          }
          if (!detailReady) {
            if (!requeueAuditItem(queue, item, '详情未加载完成')) {skipCount++;}
            continue;
          }

          progressPhase(batchCAReady ? '秒审' : '审核中');
          const auditCtx = auditTargetContext(iframeWin, item.reportDR);
          let sawCAPath = false;
          let auditResult = await clickNativeAuditButton(iframeWin, 'btn_ReportAuth', {
            action: 'audit',
            expectedStatuses: ['3'],
            batchMode: true,
            timeoutMs: batchCAReady ? 2200 : 6000,
            keepWS: queue.keepWS,
            caSessionReady: batchCAReady,
            missingAsSuccess: true, // 详情已就绪；行消失或状态 3 均算成功
            targetReportDR: item.reportDR,
            abortCheck: itemAbort,
            onTick: (elapsed, phase) => {
              if (phase && /CA|审核登录/.test(String(phase))) {sawCAPath = true;}
              progressPhase(phase || (batchCAReady ? '秒审' : '审核中'), elapsed);
            }
          });
          // 首次未确认：短确认即可；首条 CA 后勿再叠 8s「确认结果中」
          if (!auditResult && !itemAbort()) {
            iframeWin = getReportIframeWin() || iframeWin;
            if (
              verifyAuditSucceededByReportDR(iframeWin, item.reportDR) ||
              softAuditSuccessHint(iframeWin, item.reportDR)
            ) {
              auditResult = true;
            } else if (sawCAPath) {
              // CA 路径里已等过；这里只再扫极短一轮
              progressPhase('确认首条');
              for (let q = 0; q < 10 && !auditResult; q++) {
                await sleep(100);
                if (
                  verifyAuditSucceededByReportDR(iframeWin, item.reportDR) ||
                  softAuditSuccessHint(iframeWin, item.reportDR)
                ) {
                  auditResult = true;
                }
              }
            } else if (!batchCAReady) {
              dbg('批审单条首次未确认，短确认:', item.name || item.reportDR);
              progressPhase('确认中');
              auditResult = await confirmAuditEventually(iframeWin, item.reportDR, item.name || item.labno || '', {
                batchMode: true,
                targetWasPresent: auditCtx.rowPresent || auditCtx.detailReady,
                detailWasReady: true,
                afterCA: false,
                abortCheck: itemAbort,
                onTick: msg =>
                  updateBatchProgress(`${itemBase} - ${msg}${modeHint}`, ((queue.current + 0.7) / totalCount) * 100)
              });
            } else {
              for (let q = 0; q < 8 && !auditResult; q++) {
                await sleep(80);
                if (
                  verifyAuditSucceededByReportDR(iframeWin, item.reportDR) ||
                  softAuditSuccessHint(iframeWin, item.reportDR)
                )
                {auditResult = true;}
              }
            }
          }
          if (!auditResult && verifyAuditSucceededByReportDR(iframeWin, item.reportDR)) {
            dbg('批审最终校验：标本实际已审核', item.reportDR);
            auditResult = true;
          }
          // 超时但可能已成功：再验一次；仍无果则重试/跳过，绝不整批挂起
          if (!auditResult && Date.now() > itemDeadline) {
            iframeWin = getReportIframeWin() || iframeWin;
            if (verifyAuditSucceededByReportDR(iframeWin, item.reportDR)) {
              auditResult = true;
              dbg('批审单项超时后校验成功', item.reportDR);
            } else {
              if (!requeueAuditItem(queue, item, '单项超时未确认')) {skipCount++;}
              continue;
            }
          }
          if (auditResult === 'incomplete') {
            queue.skipped.push({ ...item, reason: '结果不完整' });
            skipCount++;
          } else if (auditResult) {
            closeNativeAuditSuccessMessage(iframeWin);
            queue.done.push(item);
            successCount++;
            batchCAReady = true;
            queue.caReadyByWg[itemWg] = true;
            if (prepareNextBatchItemAfterAudit(iframeWin, queue, item)) {
              batchSkipSelect = true;
              dbg('批审: LIS 已自动跳到下一标本，跳过下次选行');
            }
          } else {
            // 延迟校验：原生状态回写可能有 1~2s 延迟
            await sleep(1500);
            iframeWin = getReportIframeWin() || iframeWin;
            if (verifyAuditSucceededByReportDR(iframeWin, item.reportDR) ||
                softAuditSuccessHint(iframeWin, item.reportDR)) {
              dbg('批审延迟校验成功:', item.reportDR);
              auditResult = true;
              queue.done.push(item);
              successCount++;
              batchCAReady = true;
              queue.caReadyByWg[itemWg] = true;
            } else {
              // 未确认成功：优先队尾重试，不要直接放弃（真漏审多由此产生）
              if (!requeueAuditItem(queue, item, '审核未确认成功')) {
                queue.failed.push({ ...item, reason: '审核未确认成功' });
                failCount++;
              }
            }
          }
        } catch (e) {
          if (!requeueAuditItem(queue, item, e.message || '异常')) {
            queue.failed.push({ ...item, reason: e.message });
            failCount++;
          }
          dbg('逐行审核异常:', item.name, e.message);
        } finally {
          queue.current++;
          saveAuditQueueTick(queue);
          refreshQueueLock();
          refreshAuditLock(auditLockId);
          await sleep(0);
          try {
            iframeWin = getReportIframeWin();
            if (iframeWin) {
              jq = iframeWin.jQuery || iframeWin.$;
              me = iframeWin.me;
            }
          } catch (e) {}
        }
      }

      // 主循环结束后：对 failed + skipped(未确认类) 再补审一轮，目标是列表里不留未审
      if (!queuePausedForSwitch && !_batchAbort) {
        const salvage = [];
        (queue.failed || []).forEach(f => salvage.push(f));
        (queue.skipped || []).forEach(s => {
          if (s && /未确认|未找到|详情未加载|超时/.test(String(s.reason || ''))) {salvage.push(s);}
        });
        // 去重
        const seen = new Set();
        const need = [];
        salvage.forEach(it => {
          const id = String(it.reportDR || '');
          if (!id || seen.has(id)) {return;}
          if (queue.done && queue.done.some(d => String(d.reportDR) === id)) {return;}
          seen.add(id);
          need.push(it);
        });
        if (need.length) {
          updateBatchProgress(`补审 ${need.length} 条未确认标本...`, 95);
          dbg('批审补审轮次:', need.length);
          const stillFail = [];
          for (let i = 0; i < need.length; i++) {
            if (_batchAbort || isAuditLockAborted(auditLockId)) {break;}
            refreshAuditLock(auditLockId); // 补审轮也要心跳，多条补审同样可能超过 45s
            const it = need[i];
            updateBatchProgress(
              `补审 ${i + 1}/${need.length} - ${it.name || it.labno || it.reportDR}`,
              95 + (i / need.length) * 4
            );
            const r = await auditOneQueueItemOnce(iframeWin, it, { keepWS: queue.keepWS });
            iframeWin = r.iframeWin || iframeWin;
            if (r.ok) {
              successCount++;
              failCount = Math.max(0, failCount - 1);
              queue.done.push(it);
              batchCAReady = true;
              if (it.wg) {queue.caReadyByWg[it.wg] = true;}
            } else {
              stillFail.push(it);
            }
          }
          queue.failed = stillFail;
          failCount = stillFail.length;
          // 从 skipped 里去掉已补审成功的
          if (queue.skipped && queue.skipped.length) {
            const doneSet = new Set((queue.done || []).map(d => String(d.reportDR)));
            queue.skipped = queue.skipped.filter(s => !doneSet.has(String(s.reportDR)));
            skipCount = queue.skipped.length;
          }
        }
      }

      const fill = document.getElementById('lis-prog-fill');
      const text = document.getElementById('lis-prog-text');
      if (fill) {fill.style.width = '100%';}
      if (text) {text.textContent = `完成: ${successCount} 成功, ${failCount} 失败, ${skipCount} 跳过`;}

      if (queuePausedForSwitch) {
        if (text) {text.textContent = '正在切换工作组，稍后自动继续...';}
        return;
      }

      if (queue.current >= queue.items.length) {clearAuditQueue();}
      // 提示仅供参考；以列表是否消失为准
      if (successCount > 0) {
        showToast(
          `批审结束（以列表为准）成功约 ${successCount}` + (failCount ? `，仍有 ${failCount} 条请核对` : ''),
          failCount ? 'warning' : 'success'
        );
      } else {
        showToast('❌ 审核全部失败', 'error');
      }

      setTimeout(() => {
        if (queue.keepWS) {keepWorkbenchOnTop('批审完成');}
        progress.remove();
        loadWSData();
      }, 2000);
    } catch (e) {
      dbg('批量审核失败:', e);
      showToast('审核失败: ' + e.message, 'error');
    } finally {
      releaseQueueLock();
      releaseAuditLock(auditLockId);
      if (resumeWSRefresh && isWSVisible()) {startWSRefresh();}
      setTimeout(() => {
        const p = document.getElementById('lis-audit-progress');
        if (p) {p.remove();}
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
      classifyStatusText(r.status),
      r.items
        .filter(i => i.status !== 'NORMAL')
        .map(i => `${i.name}(${i.result})`)
        .join('; ')
    ]);

    const content =
      '\uFEFF' +
      headers.join(',') +
      '\n' +
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
      if (isPatientResultPanelEvent(e)) {return;}
      // 忽略输入框中的按键
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' || e.target.isContentEditable) {return;}
      // 忽略如果对话框打开
      if (document.getElementById('lis-audit-confirm')) {return;}

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
    if (!isReportPageActive()) {return;}

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
          dbg('按钮: ' + (btn.textContent || '').trim().substring(0, 20) + ' → ' + oc.substring(0, 80));
        }
      });

      // 深度搜索所有按钮（包括 iframe）
      function searchButtons(doc, prefix) {
        const btns = doc.querySelectorAll(
          'button, a, input[type="button"], input[type="submit"], span[onclick], div[onclick], td[onclick]'
        );
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
        if (depth > 5) {return;}
        doc.querySelectorAll('iframe').forEach((iframe, i) => {
          try {
            if (iframe.contentDocument) {
              searchButtons(iframe.contentDocument, 'iframe' + depth + '_' + i + ':');
              searchIframesAll(iframe.contentDocument, depth + 1);
            }
          } catch (e) {}
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

  function initAbnormalEnterBridge() {
    if (window.__lisAbnormalEnterBridge) {return;}
    window.__lisAbnormalEnterBridge = true;
    window.addEventListener('message', e => {
      if (!isTrustedAbnormalEnterMessage(e)) {return;}
      triggerAbnormalEnterAudit();
    });
    updateAbnormalEnterBridge();
  }

  // ============================================================
  //  初始化
  // ============================================================
  let _inited = false;
  function init() {
    if (_inited) {return;}
    _inited = true;
    if (!location.href.includes('iMedicalLIS')) {return;}

    dbg('========================================');
    dbg('iMedicalLIS 增强助手 v' + SCRIPT_VERSION);
    dbg('隐私模式：所有数据仅本地处理，无任何上传');
    dbg('========================================');

    let _isMain = false;
    try {
      _isMain = window === window.top || !!document.getElementById('sl_changeworkgroup');
    } catch (e) {}

    if (_isMain) {
      initAuthPersistence();
      migratePwdStorage();
    }
    initAuthFill();

    if (isAuthPage()) {return;}

    if (isLoginPage()) {
      initLoginPage();
      return;
    }

    if (!_isMain) {return;}

    // initQBar(); // 已禁用：不需要顶部快速切换条
    createWS();
    createPatientResultTool();
    initAbnormalEnterBridge();
    checkNavigateTarget();
    checkAuditQueueResume();
    checkAbnormalTarget();
    startQCInputProbe();
    startQEProbe();
    injectToolbar();
    initReportEnhance();
    // 预热仪器缓存：提前加载所有工作组的仪器列表，打开工作台时秒返
    WG.forEach(w => {
      loadMachines(w.dr).catch(() => {});
    });
    // 工作台内点刷新触发的整页重载后，自动重新打开工作台
    maybeReopenWSAfterReload();
    startMenubarCmdPoller(); // 菜单栏下拉点击 → 跨进程切分类
    startMenubarKeepAlive(); // 菜单栏 keep-alive，防止离开工作台后显示过期
    dbg('就绪 | 左键🔬=工作组 | 右键🔬=全科 | Ctrl+Shift+L/A');
  }

  // 页面卸载时清理所有定时器
  window.addEventListener('beforeunload', () => {
    if (_authTimer) {
      clearInterval(_authTimer);
      _authTimer = null;
    }
    if (_batchScanTimer) {
      clearInterval(_batchScanTimer);
      _batchScanTimer = null;
    }
    if (qcProbeTimer) {
      clearInterval(qcProbeTimer);
      qcProbeTimer = null;
    }
    if (qeProbeTimer) {
      clearInterval(qeProbeTimer);
      qeProbeTimer = null;
    }
    if (wsTimer) {
      clearInterval(wsTimer);
      wsTimer = null;
    }
    if (qcRefreshTimer) {
      clearTimeout(qcRefreshTimer);
      qcRefreshTimer = null;
    }
    if (_menubarCmdTimer) {
      clearInterval(_menubarCmdTimer);
      _menubarCmdTimer = null;
    }
    if (_menubarPushTimer) {
      clearTimeout(_menubarPushTimer);
      _menubarPushTimer = null;
    }
    if (_menubarKeepAliveTimer) {
      clearInterval(_menubarKeepAliveTimer);
      _menubarKeepAliveTimer = null;
    }
    if (_wsSearchTimer) {
      clearTimeout(_wsSearchTimer);
      _wsSearchTimer = null;
    }
    if (_nativeGuardTimer) {
      clearTimeout(_nativeGuardTimer);
      _nativeGuardTimer = null;
    }
    if (_abnormalPrewarmTimer) {
      clearTimeout(_abnormalPrewarmTimer);
      _abnormalPrewarmTimer = null;
    }
    // 清理 QC 模块 MutationObserver
    if (_qcObservers) {
      _qcObservers.forEach(ob => { try { ob.disconnect(); } catch (e) {} });
      _qcObservers = null;
    }
    if (_loginSubmitTimer) {
      clearInterval(_loginSubmitTimer);
      _loginSubmitTimer = null;
    }
  });

  if (document.readyState === 'complete') {init();}
  else {window.addEventListener('load', init);}
})();
