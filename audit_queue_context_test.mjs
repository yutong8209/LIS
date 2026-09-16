/**
 * 8.16.31 回归测试：批审队列「上下文 / 补审 / 守卫 / 锁 / 确认窗」五组缺陷
 *
 * 现场缺陷（每条都对应一处真实代码路径）：
 *   G1 队列条目只存 reportDR(小写)+精简字段 → wsData 无该行时重建不出原生查询上下文
 *      → fetchAndClassifySpecimen 恒返回 UNCERTAIN → 被当医学拦截静默留人工且补审不收 → 漏审
 *   G2 补审轮被中止时直接 break → 未尝试的尾部随 queue.failed 覆盖而消失，终态仍报成功
 *   G3 ensureAuditQueueWorkGroup 无条件 aaQueueSwitchSucceeded → 守卫计数每轮清零 → 切组死循环
 *   G4 releaseQueueLock 不清 _queueLockToken → 选行归属判定恒为「脚本拥有」，用户手动选行保护失效
 *   G5 #win_MessageConfirm 分支不看文案、不绑目标就点确定 → 危险/未知提示被代按
 *
 * 全部断言都跑**从源文件切出来的真代码**（不是重写一份逻辑），切片按内容锚点定位。
 *
 * 用法：
 *   node audit_queue_context_test.mjs
 *   LIS_SRC=/tmp/old.user.js node audit_queue_context_test.mjs     # 反向验证：旧版必须失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = process.env.LIS_SRC ? path.resolve(process.env.LIS_SRC) : path.join(HERE, 'iMedicalLIS-enhancer.user.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
console.log('源码: ' + SRC_PATH + '\n');

let pass = 0,
  fail = 0;
const failures = [];
function ok(cond, label) {
  if (cond) {
    pass++;
    console.log('  ✓ ' + label);
  } else {
    fail++;
    failures.push(label);
    console.log('  ✗ ' + label);
  }
}
function section(t) {
  console.log('\n' + t);
}

/* ---------------- 通用切片器（按内容锚点，绝不写死行号） ---------------- */
function sliceBetween(startAnchor, endAnchor) {
  const s = src.indexOf(startAnchor);
  if (s < 0) {throw new Error('找不到起始锚点: ' + startAnchor);}
  const e = src.indexOf(endAnchor, s + startAnchor.length);
  if (e < 0) {throw new Error('找不到结束锚点: ' + endAnchor);}
  return src.slice(s, e);
}
// 切一个顶层函数：从 `  [async ]function name(` 到下一个 2 空格缩进的声明/注释
function sliceFn(name) {
  const lines = src.split('\n');
  const i = lines.findIndex(l => l.startsWith('  function ' + name + '(') || l.startsWith('  async function ' + name + '('));
  if (i < 0) {throw new Error('找不到函数 ' + name);}
  let j = i + 1;
  while (j < lines.length && !/^  (function |async function |const |let |\/\* |\/\/ )/.test(lines[j])) {j++;}
  return lines.slice(i, j).join('\n');
}
// 每组独立执行：旧版缺锚点/缺函数时记为失败，而不是整个进程崩掉
const groups = [];
function group(title, fn) {
  groups.push({title, fn});
}

/* ============================================================
 * G1. 队列原生上下文：正常 / MILD 缺行
 * ============================================================ */
group('G1. 队列条目固化「原生查询上下文」+ 无活体行时重建（正常 / MILD 缺行）', async () => {
  const makeQueueSrc = sliceFn('makeAuditQueue');
  const nativeRowSrc = sliceFn('queueItemNativeRow');
  const fetchSrc = sliceFn('fetchAndClassifySpecimen');

  // 造一个真实形状的 wsData 行（字段名取自 prNormalizeWorkRow 展开的原生行）
  const mkRow = over =>
    Object.assign(
      {
        ReportDR: 'DR1',
        Status: '1',
        ReportStatus: '1',
        IsComplete: '1',
        NoResRows: '3',
        AcceptDT: '2026-09-16 08:00:00',
        TransmitDate: '2026-09-16',
        _mdr: 'M9',
        _mn: '生化分析仪',
        _wg: 'WG1',
        MachineParameterDR: 'MP1',
        WorkGroupMachineDR: 'M9',
        EpisodeNo: '0001',
        PatName: '甲',
        Labno: 'L001',
        RegNo: 'R001',
        TestSetDesc: '肝功',
        _pending: 0
      },
      over
    );

  const captured = []; // 捕获真实 fetchAndClassifySpecimen 发出的查询参数（不读任何病人数据）
  const api = new Function(
    'isAutoAuditableClassified',
    'resolveLoginWGReliable',
    'prWorkGroupMachineDR',
    'prMachineParameterDR',
    'rowAcceptDateStr',
    'specimenFingerprint',
    'compareAuditQueueItems',
    'isWSVisible',
    'fetchJ',
    'buildSS',
    'CSP',
    'wgDR',
    '_classifyRawCache',
    'buildClassificationFromItems',
    'attachClassificationMeta',
    'dbg',
    makeQueueSrc +
      '\n' +
      nativeRowSrc +
      '\n' +
      fetchSrc +
      '\nreturn {makeAuditQueue: makeAuditQueue, queueItemNativeRow: queueItemNativeRow, fetchAndClassifySpecimen: fetchAndClassifySpecimen};'
  )(
    r => !!r && r.status === 'NORMAL',
    () => 'WG1',
    r => (r && (r.WorkGroupMachineDR || r._mdr)) || '',
    r => (r && r.MachineParameterDR) || '',
    () => '2026-09-16',
    r =>
      [r.ReportDR, r.Status || r.ReportStatus, r.IsComplete, r.NoResRows, r.AcceptDT, r.TransmitDate, r._mdr, r._pending ? '1' : '0']
        .map(v => String(v || ''))
        .join('|'),
    () => 0,
    () => true,
    url => {
      const q = new URLSearchParams(String(url).split('?')[1] || '');
      captured.push({P0: q.get('P0'), P1: q.get('P1'), P2: q.get('P2'), P3: q.get('P3'), P4: q.get('P4'), P5: q.get('P5')});
      return Promise.resolve({ItemInfo: [], LabInfo: []}); // 只验协议，不读病人数据
    },
    () => 'sess',
    'http://x/csp',
    () => 'WG1',
    {},
    (row, items, labInfo) => ({status: 'UNCERTAIN', items: [], row, reportDR: row.ReportDR, labInfo: labInfo[0] || {}}),
    (r, row) => {
      r.fingerprint = String(row.ReportDR);
      return r;
    },
    () => {}
  );

  const specs = [
    {status: 'NORMAL', row: mkRow(), reportDR: 'DR1'},
    {status: 'MILD', mild: {ok: true}, row: mkRow({ReportDR: 'DR2', _mn: 'x8'}), reportDR: 'DR2'}
  ];
  const q = api.makeAuditQueue(specs, 'batch');
  ok(q.items.length === 2, '正常与 MILD 条目都进了队列（实际 ' + q.items.length + ' 条）');

  const it1 = q.items.find(i => i.reportDR === 'DR1');
  const it2 = q.items.find(i => i.reportDR === 'DR2');
  ok(!!(it1 && it1.q), '队列条目固化原生查询上下文（旧版没有 q 字段）');
  ok(!!(it2 && it2.q), 'MILD 条目同样固化原生查询上下文');
  ok(it1.q.ReportDR === 'DR1', '固化大写 ReportDR（fetchAndClassifySpecimen 只读 ReportDR/TodoReportDR）');
  ok(it1.q.MachineParameterDR === 'MP1' && it1.q.WorkGroupMachineDR === 'M9', '固化仪器参数/工作组机台 DR（P1/P2）');
  ok(it1.q.EpisodeNo === '0001' && it1.q.TransmitDate === '2026-09-16', '固化流水号/传输日期（P4/P5）');
  ok(it1.q.ReportStatus === '1', '固化的是**原生状态** 1（待审）');
  ok(it1.q.ReportStatus !== String(it1.status), '原生状态与分类结论分离（不得把 NORMAL/MILD 当原生状态）');
  ok(it2.q.ReportStatus === '1' && it2.status === 'MILD', 'MILD 条目的原生状态仍是 1，不是 MILD');
  ok(it1.q._mn === '生化分析仪', '固化仪器名 _mn（堵孔白名单 / 传染病 x8 比对必需，缺了会静默丢红线）');
  ok(it1.q.IsComplete === '1', '固化完整性标记 IsComplete（缺了恒判 UNCERTAIN → 全留人工）');

  // 模拟「跨整页刷新 / 切组续跑后 wsData 尚空」：只能用队列条目重建行
  const rebuilt1 = api.queueItemNativeRow(it1);
  const rebuilt2 = api.queueItemNativeRow(it2);
  ok(!!(rebuilt1 && rebuilt1.ReportDR === 'DR1'), '无活体行时可由队列条目重建原生行');
  ok(!!(rebuilt2 && rebuilt2.ReportDR === 'DR2'), 'MILD 条目同样可重建（旧版无此函数）');
  ok(rebuilt1._mn === '生化分析仪' && rebuilt1.IsComplete === '1', '重建行保留安全判定必需字段');
  ok(api.queueItemNativeRow({reportDR: '', q: null}) === null, '没有 ReportDR 的条目返回 null（调用方必须 fail-closed）');

  // 用**真实的** fetchAndClassifySpecimen 发一次查询，验证协议与原生 jsLisReportResultInitM.js 一致
  const res = await api.fetchAndClassifySpecimen(rebuilt1);
  const p = captured[0] || {};
  ok(p.P0 === 'DR1', '重查时 P0=ReportDR 非空（旧版恒空 → UNCERTAIN 假拦截）');
  ok(p.P2 === 'M9', 'P2=WorkGroupMachineDR（与原生协议一致）');
  ok(p.P3 === '1', 'P3=原生 ReportStatus（不是分类结论 NORMAL/MILD）');
  ok(p.P4 === '0001' && p.P5 === '2026-09-16', 'P4/P5 按原生协议带上');
  ok(
    captured.length === 2 && captured[1].P3 === '',
    '带状态查询返回空时用空状态重试一次（原生既有兜底，未被破坏）'
  );
  ok(res.reportDR === 'DR1', '返回结果带 reportDR（可写入分类缓存）');
  ok(res.status === 'UNCERTAIN', '明细为空 → UNCERTAIN（fail-closed：技术缺数据不冒充 NORMAL）');
});

/* ============================================================
 * G2. 补审轮：F1 成功 / F2 失败 / F3 未尝试
 * ============================================================ */
group('G2. 补审被中止：未尝试的尾部必须保留为「未完成」并去重', async () => {
  const salvageSrc = sliceBetween('const stillFail = [];', 'failCount = _mergedFail.length;');

  function runSalvage({need, okFor, abortAfter}) {
    let calls = 0;
    const queue = {failed: [], done: [], skipped: [], caReadyByWg: {}};
    const events = [];
    const fn = new Function(
      'queue',
      'need',
      '_batchAbort',
      'isAuditLockAborted',
      'refreshAuditLock',
      'auditOneQueueItemOnce',
      'updateBatchProgress',
      'successCount',
      'failCount',
      'batchCAReady',
      '_aaRecordQueueItem',
      'markSpecimenAuditedInMem',
      'aaStateEventAdd',
      'dbg',
      'iframeWin',
      '_salvageUnfinished',
      'auditLockId',
      'events',
      // 切片里有 await → 必须包在 async IIFE 里（new Function 体本身不能直接 await）
      'return (async () => {' +
        salvageSrc +
        '\nreturn {successCount: successCount, failCount: failCount, queue: queue, unfinished: _salvageUnfinished, events: events};' +
        '})();'
    );
    return fn(
      queue,
      need,
      // _batchAbort 在真实代码里是布尔量；这里用 isAuditLockAborted 驱动中止（它是函数调用）
      false,
      () => calls >= abortAfter,
      () => {},
      () => {
        const it = need[calls];
        calls++;
        return Promise.resolve({ok: okFor.includes(it.reportDR)});
      },
      () => {},
      0,
      need.length,
      false,
      (kind, it) => events.push({kind, dr: it.reportDR}),
      () => {},
      (k, m) => events.push({kind: k, msg: m}),
      () => {},
      {},
      0,
      'lock-1',
      events
    );
  }

  // 真实场景：F1 补审成功、F2 补审仍失败、F3 因中止**从未尝试**
  const need = [{reportDR: 'F1', name: 'f1'}, {reportDR: 'F2', name: 'f2'}, {reportDR: 'F3', name: 'f3'}];
  const r = await runSalvage({need, okFor: ['F1'], abortAfter: 2});
  const doneDRs = r.queue.done.map(d => d.reportDR);
  const failDRs = r.queue.failed.map(f => f.reportDR);
  ok(doneDRs.includes('F1'), 'F1 补审成功 → 进 done');
  ok(failDRs.includes('F2'), 'F2 补审失败 → 保留在 failed');
  ok(failDRs.includes('F3'), 'F3 未尝试 → **必须保留在 failed**（旧版随 queue.failed 覆盖被丢弃）');
  ok(!failDRs.includes('F1'), 'F1 成功后不再留在 failed');
  ok(r.unfinished === 1, '未完成计数为 1（终态汇总要能说明「1 未完成」）');
  ok(r.successCount === 1 && r.failCount === 2, '计数如实：1 成功 / 2 失败（旧版报 1 成功 / 1 失败 = 误报）');
  ok(new Set(failDRs).size === failDRs.length, 'failed 按 reportDR 去重');
  ok(r.events.some(e => /未完成/.test(String(e.msg || ''))), '补审中止记入事件时间线（可回溯未完成）');

  const r2 = await runSalvage({need: [{reportDR: 'A'}, {reportDR: 'B'}], okFor: ['A', 'B'], abortAfter: 99});
  ok(r2.queue.failed.length === 0, '全部成功时 failed 为空（不留幽灵条目）');
  ok(r2.unfinished === 0 && r2.failCount === 0, '全部成功时未完成/失败计数均为 0');

  const r3 = await runSalvage({need: [{reportDR: 'X'}, {reportDR: 'Y'}, {reportDR: 'Z'}], okFor: [], abortAfter: 0});
  ok(
    r3.queue.failed.length === 3 && r3.unfinished === 3,
    '一条都没尝试时全部保留为未完成（实际 ' + r3.queue.failed.length + ' 条）'
  );
});

/* ============================================================
 * G3. 真实 ensure → guard 多轮
 * ============================================================ */
group('G3. ensureAuditQueueWorkGroup 不得无条件清零守卫计数（多轮 ensure→guard 必须能中止）', async () => {
  const guardBlock = sliceBetween('  const AA_QUEUE_MAX_SWITCH = 3;', '  function runAuditQueueResume(');
  const store = new Map();
  const toasts = [];
  const state = {curWG: 'WG_A'};
  const api = new Function(
    'localStorage',
    'autoAuditEnabled',
    '_autoAuditCancelRequested',
    'dbg',
    'saveAuditQueueNow',
    'clearAuditQueue',
    'showToast',
    'aaStateEventAdd',
    'document',
    'currentQueueItem',
    'resolveLoginWGReliable',
    guardBlock +
      '\nreturn {aaQueueGuardSwitch: aaQueueGuardSwitch, aaQueueSwitchSucceeded: aaQueueSwitchSucceeded, ensureAuditQueueWorkGroup: ensureAuditQueueWorkGroup, aaSwitchFuseActive: aaSwitchFuseActive};'
  )(
    {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    () => true,
    false,
    () => {},
    () => {},
    () => {},
    (m, t) => toasts.push({m, t}),
    () => {},
    {getElementById: () => null},
    q => {
      if (!q || !q.items) {return null;}
      while (q.current < q.items.length) {
        const it = q.items[q.current];
        if (it && !it.done) {return it;}
        q.current++;
      }
      return null;
    },
    () => state.curWG
  );

  // 场景 A：起始点组 ≠ 标本组（本函数不切组、也不该清零）→ 多轮后必须被守卫中止
  const q = {_autoMode: true, items: [{reportDR: 'D1', wg: 'WG_B'}], current: 0};
  let rounds = 0;
  let stopped = false;
  while (rounds < 10) {
    rounds++;
    await api.ensureAuditQueueWorkGroup(q);
    if (api.aaQueueGuardSwitch(q, 'dr:D1') === false) {stopped = true; break;}
  }
  ok(stopped, '多轮 ensure→guard 最终被守卫中止（旧版每轮清零 → 永远中止不了）');
  ok(rounds <= 4, '在第 ' + rounds + ' 轮中止（上限 3 次，允许 1 次余量）');
  ok(q._aborted === true, '队列被明确置为已中止');
  ok(api.aaSwitchFuseActive() === true, '中止时置熔断（自动审核不再每轮重来）');
  ok(toasts.some(t => t.t === 'error' && /批审已中止/.test(t.m)), '有明确的 error 级中止提示');

  // 场景 B：确实已到目标组 → 仍然清零（正常跨组批审不得被误伤）
  const q2 = {_autoMode: true, items: [{reportDR: 'D2', wg: 'WG_A'}], current: 0, switchCycles: 2};
  await api.ensureAuditQueueWorkGroup(q2);
  ok(q2.switchCycles === 0, '到达目标组 → 守卫计数清零（正常批审不被误伤）');

  // 场景 C：组信息不可信（取不到）→ 保守不清零
  state.curWG = '';
  const q3 = {_autoMode: true, items: [{reportDR: 'D3', wg: 'WG_B'}], current: 0, switchCycles: 2};
  await api.ensureAuditQueueWorkGroup(q3);
  ok(q3.switchCycles === 2, '登录组不可信时不擅自清零（宁可保守，靠上限兜底）');
});

/* ============================================================
 * G4. acquire → release 的选行归属
 * ============================================================ */
group('G4. releaseQueueLock 必须作废 token（选行归属 / 代际保护）', async () => {
  const lockSrc = sliceBetween('  function acquireQueueLock() {', '  // 8.10.5: 自动审核主循环跨标签页主互斥锁');
  const ownSrc = sliceFn('isScriptOwnedNativeSelection');
  const selSrc = sliceFn('getNativeWorkListSelectedDR');
  const canSrc = sliceFn('canScriptSelectNativeRow');
  const clearSelSrc = sliceFn('clearNativeUserSelectLock');
  const onSelSrc = sliceFn('onNativeUserRowSelect');

  const store = new Map();
  const st = {auditInProgress: false, prog: false};
  const api = new Function(
    'localStorage',
    'K',
    '_tabId',
    'AUDIT_QUEUE_LOCK_TTL',
    'document',
    'NATIVE_WORKLIST_SEL',
    'wsCategory',
    'isWSVisible',
    'clearTimeout',
    '__store',
    '__st',
    'let _queueLockToken = "";' +
      'let _auditInProgress = false;' +
      'let _abnormalAuditInProgress = false;' +
      'let _detailAuditInProgress = false;' +
      'let _nativeUserSelectDR = "";' +
      'let _nativeUserSelectAt = 0;' +
      'let _abnormalPrewarmTimer = null;' +
      lockSrc +
      '\n' +
      ownSrc +
      '\n' +
      selSrc +
      '\n' +
      canSrc +
      '\n' +
      clearSelSrc +
      '\n' +
      onSelSrc +
      '\nreturn {acquireQueueLock: acquireQueueLock, refreshQueueLock: refreshQueueLock, releaseQueueLock: releaseQueueLock, isScriptOwnedNativeSelection: isScriptOwnedNativeSelection, canScriptSelectNativeRow: canScriptSelectNativeRow, onNativeUserRowSelect: onNativeUserRowSelect, _store: __store, _st: __st, _token: function(){return _queueLockToken;}};'
  )(
    {
      getItem: k => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: k => store.delete(k)
    },
    {auditQueueLock: 'LIS_AuditQueueLock'},
    'tab_test',
    45000,
    {getElementById: id => (id === 'lis-audit-progress' && st.prog ? {} : null)},
    '#dgWorkList',
    'normal',
    () => false,
    () => {},
    store,
    st
  );

  const win = {jQuery: null, document: {querySelectorAll: () => [], getElementById: () => null}};

  const t1 = api.acquireQueueLock();
  ok(!!t1 && typeof t1 === 'string', 'acquireQueueLock 成功时返回本次 token（供 release 回传）');
  ok(api.isScriptOwnedNativeSelection() === true, '持锁期间判定为「脚本拥有选行」');
  ok(api.canScriptSelectNativeRow(win, 'DR_X') === true, '持锁期间脚本可选行');

  api.releaseQueueLock(t1);
  ok(api._token() === '', '释放后本实例 token 已作废（旧版残留 → 下面两条会失败）');
  ok(api.isScriptOwnedNativeSelection() === false, '释放后不再判定为「脚本拥有选行」');
  api.onNativeUserRowSelect('DR_USER');
  ok(
    api.canScriptSelectNativeRow(win, 'DR_OTHER') === false,
    '用户手动选行受保护，脚本不得抢选其它标本（旧版恒 true = 保护失效）'
  );
  ok(api.canScriptSelectNativeRow(win, 'DR_USER') === true, '目标与用户选中一致时仍可继续');

  // 代际保护：旧循环释放不得清新循环的锁
  const tOld = api.acquireQueueLock();
  const tNew = api.acquireQueueLock();
  ok(!!tOld && !!tNew && tOld !== tNew, '同一标签页新一代获取到不同 token');
  api.releaseQueueLock(tOld);
  ok(api._store.has('LIS_AuditQueueLock') === true, '旧循环释放**不得**删掉新循环的锁（旧版会删）');
  api.releaseQueueLock(tNew);
  ok(api._store.has('LIS_AuditQueueLock') === false, '新循环自己释放才删锁');
  ok(api._token() === '', '全部释放后 token 归零');

  // 未持锁时释放：不得误清真实持有的锁与 token
  const t3 = api.acquireQueueLock();
  api.releaseQueueLock('');
  ok(api._store.has('LIS_AuditQueueLock') === true && api._token() === t3, '传入空 token 释放时不动真实持有的锁');
  api.releaseQueueLock(t3);
  ok(api._store.has('LIS_AuditQueueLock') === false, '正常释放收尾');
});

/* ============================================================
 * G5. 确认窗：危险/未知拒绝 + 允许窗目标绑定
 * ============================================================ */
group('G5. 原生确认窗只允许「已知安全文案 + 脚本审核中 + 目标匹配」', async () => {
  const require_ = createRequire(import.meta.url);
  let JSDOM;
  try {
    JSDOM = require_('jsdom').JSDOM;
  } catch (e) {
    ok(false, '缺少 jsdom 依赖（NODE_PATH 未指向 workspace/node_modules？）: ' + e.message);
    return;
  }

  const confirmSrc = sliceBetween('  function classifyNativeMessage(text) {', '  function installNativeStatExceptionGuard(iframeWin) {');

  function buildCase({text, targetDR, nativeDR, scriptOwns, ageMs = 0}) {
    const dom = new JSDOM(
      '<body><div class="window" style="display:block">' +
        '<div id="win_MessageConfirm"><div id="div_showInfo"></div>' +
        '<button id="btn_Confirm">确定</button></div></div></body>'
    );
    const win = dom.window;
    win.document.getElementById('div_showInfo').textContent = text;
    win.me = {curReportDR: nativeDR};
    let clicks = 0;
    win.document.getElementById('btn_Confirm').addEventListener('click', () => clicks++);

    const owns = !!scriptOwns;
    const api = new Function(
      'window',
      'document',
      'dbg',
      'getReportIframeWin',
      'getNativeWorkListSelectedDR',
      'isScriptOwnedNativeSelection',
      confirmSrc +
        '\nreturn {handleNativeMessageConfirm: handleNativeMessageConfirm, setAuditingTargetDR: setAuditingTargetDR, clearAuditingTargetDR: clearAuditingTargetDR, isAutoConfirmableNativeText: isAutoConfirmableNativeText};'
    )(
      win,
      {getElementById: id => (id === 'lis-audit-progress' && owns ? {} : null)},
      () => {},
      () => win,
      () => nativeDR,
      () => owns
    );
    if (targetDR !== null) {api.setAuditingTargetDR(targetDR);}
    if (ageMs) {
      const realNow = Date.now;
      Date.now = () => realNow() + ageMs;
      try {
        const fired = api.handleNativeMessageConfirm(win);
        return {fired, clicks, api};
      } finally {
        Date.now = realNow;
      }
    }
    return {fired: api.handleNativeMessageConfirm(win), clicks, api};
  }

  const OK_TEXT = '结果超出参考范围，确定要审核该报告吗？';
  const probe = buildCase({text: OK_TEXT, targetDR: 'DR1', nativeDR: 'DR1', scriptOwns: true});
  ok(probe.api.isAutoConfirmableNativeText(OK_TEXT) === true, '已知的超范围确认文案判定为「可自动确认」');

  const c1 = buildCase({text: OK_TEXT, targetDR: 'DR1', nativeDR: 'DR1', scriptOwns: true});
  ok(c1.fired === true && c1.clicks === 1, '允许窗（目标匹配 + 脚本审核中）→ 自动确认 1 次');

  const c2 = buildCase({text: '结果超出参考范围且含危急值，确定要审核该报告吗？', targetDR: 'DR1', nativeDR: 'DR1', scriptOwns: true});
  ok(c2.fired === false && c2.clicks === 0, '危急提示不自动确认（留人工）');
  ok(
    c2.api.isAutoConfirmableNativeText('结果超出参考范围且含危急值，确定要审核该报告吗？') === false,
    '危急文案被明确拒绝（只收窄，不扩大医学规则）'
  );

  const c3 = buildCase({text: '结果不完整，确定要审核该报告吗？', targetDR: 'DR1', nativeDR: 'DR1', scriptOwns: true});
  ok(c3.fired === false && c3.clicks === 0, '「结果不完整」不自动确认');

  const c4 = buildCase({text: '系统将在 10 秒后自动注销，是否继续？', targetDR: 'DR1', nativeDR: 'DR1', scriptOwns: true});
  ok(c4.fired === false && c4.clicks === 0, '未知文案不自动确认（旧版照点）');

  const c5 = buildCase({text: OK_TEXT, targetDR: 'DR1', nativeDR: 'DR2', scriptOwns: true});
  ok(c5.fired === false && c5.clicks === 0, '弹窗标本 ≠ 审核目标 → 不自动确认');

  const c6 = buildCase({text: OK_TEXT, targetDR: 'DR1', nativeDR: 'DR1', scriptOwns: false});
  ok(c6.fired === false && c6.clicks === 0, '脚本未在审核时（用户手动操作）→ 不代按确定');

  const c7 = buildCase({text: OK_TEXT, targetDR: 'DR1', nativeDR: 'DR1', scriptOwns: true, ageMs: 60000});
  ok(c7.fired === false && c7.clicks === 0, '审核目标已过期（>20s）→ 不自动确认');

  const c8 = buildCase({text: OK_TEXT, targetDR: null, nativeDR: 'DR1', scriptOwns: true});
  ok(c8.fired === false && c8.clicks === 0, '未记录审核目标 → 不自动确认');

  const c9 = buildCase({text: '结果超出参考范围（无危急值），确定要审核该报告吗？', targetDR: 'DR1', nativeDR: 'DR1', scriptOwns: true});
  ok(c9.fired === true && c9.clicks === 1, '「无危急值」属正常超范围确认 → 仍自动确认（沿用既有否定语境口径）');
});

/* ============================================================
 * G6. 静态不变量：fail-closed 与「不得放宽补审正则」
 * ============================================================ */
group('G6. 静态不变量：无最新数据不可放行 / 补审正则不得放宽', async () => {
  // ① 删除「凭旧 NORMAL 分类构造放行对象」的兜底（这是最典型的 fail-open）
  ok(
    !/liveClassified = \{ status: 'NORMAL', reportDR: item\.reportDR/.test(src),
    '不得再凭队列里的旧 NORMAL 分类构造放行对象'
  );
  // ② 无最新数据不可放行：重取失败或明细为空都走技术路径
  ok(/_freshOk\b/.test(src) && /_liveEmpty\b/.test(src), '存在「重取是否成功 / 明细是否为空」的判定');
  ok(/if \(!liveClassified \|\| !_freshOk \|\| _liveEmpty\)/.test(src), '三种「无最新数据」形态统一走技术路径（不放行）');
  ok(
    /liveClassified\.status === 'UNCERTAIN' && \(!Array\.isArray\(liveClassified\.items\)/.test(src),
    '只把「UNCERTAIN 且无项目」当技术缺数据（带项目的 UNCERTAIN 是医学判定，必须留人工）'
  );
  // ③ 补审复检必须无条件执行（不得再被 if (_salvageRow) 整体包裹）
  ok(!/if \(_salvageRow\) \{/.test(src), '补审复检不得被 if (_salvageRow) 包裹（无行时会被整段绕过 = fail-open）');
  ok(/const _svRow = _salvageRow \|\| queueItemNativeRow\(item\);/.test(src), '补审复检无活体行时用队列原生上下文重建');
  ok(
    /if \(_svRow && \(!_svClassified \|\| isClassificationStale\(_svRow\)\)\)/.test(src) ||
      /if \(_svRow && _svNeedFresh\)/.test(src),
    '补审复检按重建行判定新鲜度'
  );
  ok(/_svNeedFresh/.test(src) && /_svFreshOk/.test(src), '补审重取失败时不得沿用旧缓存（同主循环口径）');
  ok(
    /if \(!_svClassified \|\| !_svFreshOk \|\| _svEmpty \|\|/.test(src),
    '补审「无最新数据」一律不放行'
  );
  // ④ 行兜底顺序：活体行 > 工作台行 > 队列原生上下文
  ok(
    /const rowForClassify = liveRow \|\| findWSSpecimenByReportDR\(item\.reportDR\) \|\| queueItemNativeRow\(item\);/.test(src),
    '批审主循环行兜底链正确（不再落到 item.row || item）'
  );
  // ⑤ 技术失败用显式标记进补审，绝不放宽正则
  ok(/opts && opts\.tech\) \{_skip\._tech = true;\}/.test(src), '技术失败在 skipped 上打 _tech 标记');
  ok(/s\._tech === true \|\|/.test(src), '补审收录认 _tech 显式标记');
  const salvageRegex = src.match(/\/([^/\n]*未确认[^/\n]*)\/\.test\(String\(s\.reason/);
  ok(!!salvageRegex, '定位到补审原因正则');
  ok(
    !!salvageRegex && !/轻微带|结果不完整|已取消|不可自动审核/.test(salvageRegex[1]),
    '补审正则未被放宽（不得吞掉安全拦截原因）：' + (salvageRegex ? salvageRegex[1] : '')
  );
  // ⑥ 终态汇总必须说明未完成，且不得清掉未完成队列
  ok(/_salvageUnfinished \? `, \$\{_salvageUnfinished\} 未完成`/.test(src), '终态进度文案包含「N 未完成」');
  ok(
    /if \(queue\.current >= queue\.items\.length && !_salvageUnfinished\) \{clearAuditQueue\(\);\}/.test(src),
    '有未完成时不清落盘队列（未审标本不能随队列消失）'
  );
  ok(/_salvageUnfinished \? `，补审 \$\{_salvageUnfinished\} 条未完成/.test(src), '结束 toast 明确提示补审未完成');
  // ⑦ 不引入自动续跑：保留的队列不会被 checkAuditQueueResume 复活
  ok(
    /const remaining = queue\.items\.length - \(queue\.current \|\| 0\);\s*\n\s*if \(remaining <= 0\) \{\s*\n\s*clearAuditQueue\(\);/.test(src),
    '续跑入口在「已走到末尾」时仍是清理而非重跑（保留队列≠自动续跑）'
  );
  // ⑧ 确认窗：不扩大医学规则，只收窄
  ok(/function isAutoConfirmableNativeText\(text\)/.test(src), '确认窗文案判定收敛为单一函数');
  ok(
    /_confirmAllowed \|\| !isAutoConfirmableNativeText\(infoText\) \|\| !confirmTargetMatches\(win\)/.test(src),
    '#win_MessageConfirm 分支同时校验「脚本审核中 + 文案允许 + 目标匹配」'
  );
  ok(/const confirmTargetMatches = win => \{/.test(src), '确认窗绑定当前审核目标（窗口标本必须与审核目标一致）');
  ok(
    /if \(isAudit\) \{setAuditingTargetDR\(targetReportDR\);\}/.test(src),
    '审核入口记录本次目标（确认窗据此绑定）'
  );
});

/* ============ 执行 + 汇总 ============ */
for (const g of groups) {
  section(g.title);
  try {
    await g.fn();
  } catch (e) {
    ok(false, '本组无法执行（旧版缺锚点/缺函数？）: ' + e.message);
  }
}

console.log('\n────────────────────────────');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');
