/**
 * 8.17.9 回归测试：漏结果审核防线（完整度闸门 fail-closed + 审核后自检）
 *
 * 现场问题（用户原话）：「一个正常的性激素标本 当时应该是 f4 批审审核掉了 但是我今天看 lis 上面的
 *   结果没全 缺了三个项目 竟然审核掉了 …… 漏结果审核标本是一个非常重大的问题」
 *
 * 排查结论（逐条读代码得到的三条链路闸门表）：
 *   | 入口 | 完整度闸门 | 问题 |
 *   | F4 / 一键批审（主循环） | `liveRow && !isSpecimenActuallyComplete(liveRow)` | **liveRow 为空时整条判定被静默跳过**（fail-open） |
 *   | F4 补审轮（auditOneQueueItemOnce） | **无** | 主循环拦下的标本会在补审轮被原样放行 |
 *   | 详情面板「审核」/ 面板内回车 | **无** | 只有 collected/pending 早退与分类校验 |
 *   | 待审列表回车（auditAbnormalSpecimen） | 有 | 用的是内存行，可能过期 |
 *   另外：**批审期间工作台 30s 刷新被停掉**，队列里的行可能是几分钟前的快照，全程没有任何一处复核。
 *
 * 本次改动：
 *   ① 完整度判定集中成 `specimenCompleteness(row, cached)` → **返回 {ok, missing, reason}**（可诊断）；
 *   ② 主循环复核改 **fail-closed**（拿不到行也绝不放行，走技术性缺数据 requeue → 补审 → 留人工）；
 *   ③ 新增「审核前最终闸门」（拿到最新分类之后、点审核之前，按最新可用行再判一次）；
 *   ④ 补审轮补上同一道闸门；⑤ 详情面板补「提示 + 留痕」（**不硬拦**，保留有意的人工通道）；
 *   ⑥ 新增**审核后自检**：批量收尾用最新工作列表复核刚审掉的标本，发现不完整立刻红色告警 + 推送。
 *
 * 8.17.10 追加：**审核留痕**（`LIS_AuditTrace`）——每次审核记下「审核那一刻的完整度快照 + 走的哪条路径」。
 *   起因：8.17.9 现场那条标本（检验号 26091800246）结果补全后就永远看不出当时状态了，只能靠回忆。
 *   有了留痕，下次同类问题能直接定性：
 *     ic='1'（LIS 说完整）+ 事后不完整 → **LIS 侧把完整度判错了**（脚本无信号可查）
 *     ic='2'/'0' 或 verdict 非空      → **闸门被绕过 / 用了过期数据**（脚本侧问题）
 *
 * 用法：node audit_completeness_guard_test.mjs
 *      LIS_SRC=/tmp/old.user.js node audit_completeness_guard_test.mjs   # 反向验证：旧版必须失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = process.env.LIS_SRC ? path.resolve(process.env.LIS_SRC) : path.join(HERE, 'iMedicalLIS-enhancer.user.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');
console.log('源码: ' + SRC_PATH);

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

/* ---------- 切片工具 ---------- */
function braceSlice(source, startIdx) {
  const pOpen = source.indexOf('(', startIdx);
  let pd = 0,
    pEnd = -1;
  for (let i = pOpen; i < source.length; i++) {
    if (source[i] === '(') {pd++;}
    else if (source[i] === ')') {pd--; if (!pd) {pEnd = i; break;}}
  }
  if (pEnd < 0) {return null;}
  const open = source.indexOf('{', pEnd);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === '{') {depth++;}
    else if (source[i] === '}' && --depth === 0) {return source.slice(startIdx, i + 1);}
  }
  return null;
}
function fnStart(name) {
  const a = src.indexOf('  function ' + name + '(');
  const b = src.indexOf('  async function ' + name + '(');
  if (a < 0) {return b;}
  if (b < 0) {return a;}
  return Math.min(a, b);
}
function sliceNamedFn(name) {
  const i = fnStart(name);
  if (i < 0) {throw new Error('切片失败：源码里找不到 function ' + name + '（锚点变了？）');}
  const s = braceSlice(src, i);
  if (!s) {throw new Error('切片失败：' + name + ' 花括号未配平');}
  return s;
}
function verAtLeast(v, min) {
  const a = String(v).split('.').map(Number);
  const b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {return (a[i] || 0) > (b[i] || 0);}
  }
  return true;
}
const countOf = re => (src.match(re) || []).length;
const idxOf = needle => src.indexOf(needle);

/* ============ A. 静态不变量 ============ */
section('A. 静态不变量');

const ver = (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';
ok(verAtLeast(ver, '8.17.9'), '版本号 ≥ 8.17.9（本次防线落地版本；实际 ' + ver + '）');

// A1. 统一判定函数
let cmpFn = '';
try {
  cmpFn = sliceNamedFn('specimenCompleteness');
  ok(/return \{ok: false, missing: 0, reason:/.test(cmpFn), 'specimenCompleteness 返回带 reason 的结构（拦下之后能说清为什么）');
  ok(/return \{ok: true, missing: 0, reason: ''\}/.test(cmpFn), '通过时 reason 为空串（便于「等于空串」判定）');
  ok(/isSpecimenActuallyComplete\(row, cached\)/.test(cmpFn), '复用 isSpecimenActuallyComplete（单一事实来源，不会两套口径分叉）');
  ok(/NoResRows/.test(cmpFn), '原因文案里带 NoResRows（缺几项 / 应做几项）');
  ok(/'结果不完整（缺 '/.test(cmpFn), "IsComplete='2' → 文案「结果不完整（缺 N 项）」");
  ok(/'无结果（应做 '/.test(cmpFn), "IsComplete='0' → 文案「无结果（应做 N 项）」");
  ok(/完整度未知/.test(cmpFn), "IsComplete 非 1/2/0（空或异常值）→ 文案「完整度未知」，不静默当完整");
} catch (e) {
  ok(false, '切片失败：specimenCompleteness 不存在（旧版无此实现）：' + e.message);
}

// A2. 主循环复核：fail-closed（不能再有 `liveRow &&` 静默跳过）
const earlyGuard = (() => {
  const i = idxOf('const _cmpEarly = specimenCompleteness(liveRow,');
  return i < 0 ? '' : src.slice(i, i + 700);
})();
ok(!!earlyGuard, '主循环里有完整度复核（_cmpEarly）');
ok(/if \(!_cmpEarly\.ok && liveRow\)/.test(earlyGuard), '主循环复核：行在且不完整 → 拦下（带原因）');
// ⚠️ 我的新注释里引用了旧代码原文，所以要先剥掉行注释再断言
const srcNoComment = src.replace(/^\s*\/\/.*$/gm, '');
ok(!/if \(liveRow && !isSpecimenActuallyComplete\(liveRow\)\)/.test(srcNoComment), '旧的「liveRow 为空就静默跳过」写法已从**代码**里删除（fail-open 洞已堵）');

// A3. 审核前最终闸门：必须在真正点审核之前
const finalGate = idxOf('审核前最终闸门');
const crossGroupMark = idxOf('// 8.5.10: 跨组标本判定与快速切组优化');
const mainLoopClick = (() => {
  // ⚠️ 必须从 continueAuditQueue 内部找——文件里另有一处同名 while（不是主循环），
  // 直接 indexOf 会命中它，导致顺序断言假通过/假失败
  const fnStartIdx = idxOf('async function continueAuditQueue');
  const i = src.indexOf('while (queue.current < queue.items.length)', fnStartIdx);
  return src.indexOf('clickNativeAuditButton(iframeWin', i);
})();
ok(finalGate > 0, '存在「审核前最终闸门」');
ok(finalGate < crossGroupMark, '最终闸门排在跨组/切组逻辑之前');
ok(finalGate < mainLoopClick, '最终闸门排在主循环里真正点审核之前（顺序反了等于没拦）');
ok(/const _rowNow = liveRow \|\| findWSSpecimenByReportDR\(item\.reportDR\) \|\| queueItemNativeRow\(item\)/.test(src),
  '最终闸门用「最新可用行」：活体行 → 工作台行 → 队列固化的原生上下文');
ok(/if \(requeueAuditItem\(queue, item, _reason, \{tech: true\}\)\)/.test(src), '拿不到行 → 按技术性缺数据 requeue（可重试，不直接丢弃也不放行）');

// A4. 补审轮闸门
const salvageGate = (() => {
  const i = idxOf('补审轮完整度闸门拦下');
  return i < 0 ? '' : src.slice(i - 700, i + 300);
})();
ok(!!salvageGate, '补审轮有完整度闸门');
const salvageClick = (() => {
  const i = idxOf('async function auditOneQueueItemOnce');
  return src.indexOf('clickNativeAuditButton(iframeWin', i);
})();
ok(idxOf('补审轮完整度闸门拦下') < salvageClick, '补审轮闸门排在补审真正点审核之前');
ok(/reason: '完整度复核：' \+ _cmpS\.reason/.test(src), '补审轮拦下时把原因带回去（由调用方记录，不再只写「补审仍未确认」）');
ok(/\(r && r\.reason\) \|\| '补审仍未确认'/.test(src), '补审失败原因透传（留人工日志能看出到底为什么没审掉）');

// A5. 详情面板：提示而不硬拦（有意保留人工通道）
const detailHint = (() => {
  const i = idxOf('详情面板审核：完整度提示');
  return i < 0 ? '' : src.slice(i - 900, i + 300);
})();
ok(!!detailHint, '详情面板补了完整度提示');
ok(/仍按人工判断审核/.test(detailHint), '详情面板是**提示**文案（说明仍会按人工判断继续）');
ok(!/if \(!_cmpD\.ok\) \{[\s\S]{0,200}?\n\s*return;/.test(detailHint), '详情面板**没有** return 硬拦（HANDTEST §22 的有意人工通道要留着）');

// A6. 审核后自检
ok(/async function verifyAuditedCompleteness\(/.test(src), 'verifyAuditedCompleteness 存在');
const vfy = (() => { try { return sliceNamedFn('verifyAuditedCompleteness'); } catch (e) { return ''; } })();
ok(/queue\.done/.test(vfy), '自检对象 = 本批成功审掉的标本（queue.done）');
ok(/loadWL\(/.test(vfy), '自检用最新工作列表读（loadWL = 服务端最新数据，不是内存快照）');
ok(/if \(!r\) \{return;\}/.test(vfy), '标本已不在列表 → 不下结论（不误报）');
ok(/catch \(e\) \{\s*\n\s*dbg\('审核后自检：工作列表读取失败/.test(vfy), '读不到列表 → 跳过该仪器（不误报）');
ok(/showToast\(\s*\n?\s*'🚨 审核后自检/.test(vfy), '发现不完整 → 红色告警 toast');
ok(/pushAutoAuditNotify\(/.test(vfy), '发现不完整 → 手机推送（critical 档）');
ok(/aaStateEventAdd\('pause'/.test(vfy), '发现不完整 → 记入状态时间线（可回溯）');
const vfyCall = idxOf('await verifyAuditedCompleteness(queue)');
const progMark = idxOf("const fill = document.getElementById('lis-prog-fill')");
ok(vfyCall > 0 && progMark > 0 && vfyCall < progMark, '自检在批量收尾、终态汇总之前执行');

// A7. 三条自动路径都要有闸门（漏一条就是漏一类标本）
ok(countOf(/specimenCompleteness\(/g) >= 5, 'specimenCompleteness 至少 5 处调用（定义 + 主循环复核 + 最终闸门 + 补审轮 + 详情提示 + 自检；实际 ' + countOf(/specimenCompleteness\(/g) + '）');
ok(countOf(/isSpecimenActuallyComplete\(/g) >= 8, 'isSpecimenActuallyComplete 调用点没被减少（实际 ' + countOf(/isSpecimenActuallyComplete\(/g) + '）');

// A8. 审核留痕（8.17.10）
ok(/auditTrace: 'LIS_AuditTrace'/.test(src), "K.auditTrace = 'LIS_AuditTrace'（独立键，不污染自动审核日志）");
const traceAddSites = countOf(/auditTraceAdd\(\{/g);
ok(traceAddSites === 3, '三条自动路径都留痕：人工批审(F4) / 补审轮 / 详情面板·回车（实际 ' + traceAddSites + ' 处）');
ok(/path: queue\._autoMode \? '机器人批审' : '人工批审\(F4\)'/.test(src), '留痕区分机器人批审与人工 F4（否则分不清谁审的）');
ok(/const _snapA = auditTraceSnapshot\(liveRow \|\| findWSSpecimenByReportDR\(item\.reportDR\)\)/.test(src),
  '批审留痕用的是「审核那一刻」的最新可用行（不是队列构建时的快照）');
ok(/item\._preAuditIc = _snapA\.ic/.test(src) && /item\._preAuditVerdict = _snapA\.verdict/.test(src),
  '快照同时挂到队列条目上（供审核后自检直接定性）');
let snapFn = '';
try {
  snapFn = sliceNamedFn('auditTraceSnapshot');
  ok(/specimenCompleteness\(row,/.test(snapFn), 'auditTraceSnapshot 复用 specimenCompleteness（单一事实来源，快照口径与闸门一致）');
  ok(/String\(row\.IsComplete/.test(snapFn) && /String\(row\.NoResRows/.test(snapFn), '快照同时记 IsComplete 与 NoResRows（缺项数也要留）');
} catch (e) {
  ok(false, '切片失败：auditTraceSnapshot 不存在（旧版无此实现）：' + e.message);
}
ok(/preIc: it\._preAuditIc/.test(src) && /preVerdict: String\(it\._preAuditVerdict/.test(src), '审核后自检把审核时快照带进告警数据');
ok(/审核时 LIS 记录 IsComplete=/.test(src), '告警文案直接给出定性依据（审核时 LIS 说完整 or 脚本当时就不完整）');
ok(/unsafeWindow\.lisAuditTrace = auditTraceRead/.test(src), '留痕有现场诊断入口（控制台 lisAuditTrace()）');
ok(/AUDIT_TRACE_MAX = \d+/.test(src) && /log\.length > AUDIT_TRACE_MAX/.test(src), '留痕是环形缓冲（有上限，不会撑爆 localStorage）');

// A9. 「应有项数」观察模式（8.17.11）——**只记不拦**
ok(/expectedItems: 'LIS_ExpectedItems'/.test(src), "K.expectedItems = 'LIS_ExpectedItems'（独立键）");
ok(/expectedItemsLearn\(allData\)/.test(src), '入库（applyResults）时顺手学习「组合项目 → 应有项数」');
ok(/const _snapA = auditTraceSnapshot/.test(src) && /exp: Number\(e\.exp\) \|\| 0/.test(src), '留痕里带 exp/act/short/seen（审核那一刻的项数对不上与否）');
ok(/unsafeWindow\.lisExpectedItems = /.test(src), '有现场查看入口（控制台 lisExpectedItems()）');
// ⚠️ 关键：观察模式**不许**影响闸门——否则「减项开单」的组合项目会被误拦
ok(!/expectedItem/.test(cmpFn), '完整度闸门 specimenCompleteness **不依赖**应有项数启发式（观察模式不参与判定）');
ok(!/short/.test(earlyGuard), '主循环逐条复核的拦下条件里没有 short（不拿启发式拦人）');
const finalGateSrc = (() => {
  const i = idxOf('审核前最终闸门');
  return i < 0 ? '' : src.slice(i, i + 1600);
})();
ok(!!finalGateSrc && !/short|expectedItem/.test(finalGateSrc), '审核前最终闸门的拦下条件里也没有 short/expectedItem');

/* ============ B. 逻辑仿真：真实 specimenCompleteness ============ */
section('B. 逻辑仿真（真实切片）');

try {
  const stub = `
let wsClassifiedCache = {};
function __setCache(c) {wsClassifiedCache = c || {};}
function isManualEntrySpecimen(row) {
  const n = String((row && (row._mn || row.MachineName)) || '');
  return /H900|手工/.test(n);
}
`;
  const modSrc =
    stub + '\n' +
    sliceNamedFn('isSpecimenActuallyComplete') + '\n' +
    sliceNamedFn('specimenCompleteness') + '\n' +
    'export { specimenCompleteness, __setCache };\n';
  const tmpPath = path.join(HERE, '.cache', 'audit_completeness_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), {recursive: true});
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const M = await import('file://' + tmpPath);
  M.__setCache({});

  // B1. IsComplete='1' → 放行（且不带原因）
  let v = M.specimenCompleteness({ReportDR: 'A', IsComplete: '1', NoResRows: ''});
  ok(v.ok === true && v.reason === '', "B1 IsComplete='1' → 放行、reason 为空");

  // B2. 用户现场那种：缺 3 项
  v = M.specimenCompleteness({ReportDR: 'B', IsComplete: '2', NoResRows: '3'});
  ok(v.ok === false, "B2 IsComplete='2' → 拦下（这正是现场「缺了三个项目」那一类）");
  ok(v.missing === 3 && /缺 3 项/.test(v.reason), 'B2 原因里写明「缺 3 项」（可诊断，不再只说「结果不完整」）');

  // B3. 无结果：NoResRows = 该组合项目总项数
  v = M.specimenCompleteness({ReportDR: 'C', IsComplete: '0', NoResRows: '6'});
  ok(v.ok === false && v.missing === 6 && /无结果/.test(v.reason) && /6/.test(v.reason), "B3 IsComplete='0' → 「无结果（应做 6 项）」");

  // B4. 完整度未知（空 / 异常值）不能当完整
  for (const ic of ['', ' ', '9', 'null', undefined]) {
    v = M.specimenCompleteness({ReportDR: 'D', IsComplete: ic});
    ok(v.ok === false, 'B4 IsComplete=' + JSON.stringify(ic) + ' → 不放行（宁可留人工）');
  }

  // B5. 行缺失 → 拦下且原因说明「不在工作台数据中」（fail-closed）
  v = M.specimenCompleteness(null);
  ok(v.ok === false && /不在工作台数据中/.test(v.reason), 'B5 拿不到行 → 拦下并说明原因（不再静默跳过）');
  v = M.specimenCompleteness(undefined);
  ok(v.ok === false, 'B5 undefined 行同样拦下');

  // B6. NoResRows 缺失/异常时仍拦下，文案不出现 NaN
  v = M.specimenCompleteness({ReportDR: 'E', IsComplete: '2', NoResRows: ''});
  ok(v.ok === false && !/NaN/.test(v.reason) && /若干/.test(v.reason), "B6 IsComplete='2' 但 NoResRows 缺失 → 「缺 若干 项」（不出现 NaN）");
  v = M.specimenCompleteness({ReportDR: 'E2', IsComplete: '2', NoResRows: 'abc'});
  ok(v.ok === false && !/NaN/.test(v.reason), 'B6 NoResRows 非数字同样不产生 NaN');

  // B7. 手工录入仪器：LIS 不置 IsComplete=1，靠项级判定兜底
  M.__setCache({M1: {isManualComplete: true}});
  v = M.specimenCompleteness({ReportDR: 'M1', IsComplete: '0', _mn: 'H900'});
  ok(v.ok === true, 'B7 手工仪器 + 项级已录全 → 放行（8.10.23 口径保持）');
  v = M.specimenCompleteness({ReportDR: 'M2', IsComplete: '0', _mn: 'H900'});
  ok(v.ok === false && /手工录入/.test(v.reason), 'B7 手工仪器未录全 → 拦下，文案说明是「手工录入项目未录全」');

  // B8. 自动化仪器即使 cached 说完整也不放行（IsComplete 是硬门槛）
  M.__setCache({A2: {isManualComplete: true}});
  v = M.specimenCompleteness({ReportDR: 'A2', IsComplete: '2', NoResRows: '1', _mn: 'DXI800'});
  ok(v.ok === false, 'B8 自动化仪器 IsComplete≠1 → 即使 cached 标完整也拦下（硬门槛没被绕过）');

  // B9. 数值 0 的 NoResRows 不误判成缺失
  v = M.specimenCompleteness({ReportDR: 'Z', IsComplete: '1', NoResRows: '0'});
  ok(v.ok === true, 'B9 IsComplete=1 且 NoResRows=0 → 放行（0 值不当成缺项）');
} catch (e) {
  ok(false, '逻辑仿真切片/执行失败（锚点变了或旧版无此实现）：' + e.message);
}

/* ============ C. 逻辑仿真：真实 auditTraceAdd / auditTraceRead ============ */
section('C. 逻辑仿真（审核留痕）');

try {
  const stub = `
const __store = {};
const localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : null),
  setItem: (k, v) => {__store[k] = String(v);},
  removeItem: k => {delete __store[k];}
};
const K = { auditTrace: 'LIS_AuditTrace' };
let wsClassifiedCache = {};
const __tabled = [];
const console = {table: rows => __tabled.push(rows), log: () => {}};
function isManualEntrySpecimen(row) {return /H900|手工/.test(String((row && (row._mn || row.MachineName)) || ''));}
`;
  const modSrc =
    stub + '\n' +
    sliceNamedFn('isSpecimenActuallyComplete') + '\n' +
    sliceNamedFn('specimenCompleteness') + '\n' +
    (src.match(/^\s*const AUDIT_TRACE_MAX = \d+;$/m) || [''])[0] + '\n' +
    sliceNamedFn('auditTraceAdd') + '\n' +
    sliceNamedFn('auditTraceSnapshot') + '\n' +
    sliceNamedFn('auditTraceRead') + '\n' +
    'export { auditTraceAdd, auditTraceSnapshot, auditTraceRead, __tabled };\n';
  const tmpPath = path.join(HERE, '.cache', 'audit_trace_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), {recursive: true});
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const T = await import('file://' + tmpPath);

  // C1. 写入与读回
  T.auditTraceAdd({dr: 'DR1', labno: '26091800246', pat: '张三', mn: 'DXI800', path: '人工批审(F4)', ic: '1', nrr: '', verdict: ''});
  let rows = T.auditTraceRead('26091800246');
  ok(rows.length === 1, 'C1 写入后能按检验号查到（现场诊断入口可用）');
  ok(rows[0].labno === '26091800246' && rows[0].ic === '1' && rows[0].path === '人工批审(F4)', 'C1 快照字段完整（检验号 / 审核时 IsComplete / 走的路径）');
  ok(!!rows[0].day && !!rows[0].t, 'C1 带日期与时间（能对到具体哪一次审核）');

  // C2. 无 dr 不写（避免脏数据）
  T.auditTraceAdd({labno: 'X'});
  ok(T.auditTraceRead('X').length === 0, 'C2 没有 ReportDR 的调用不写入（不留脏记录）');

  // C3. 按 DR / 姓名也能查
  ok(T.auditTraceRead('DR1').length === 1, 'C3 可按 ReportDR 查');
  ok(T.auditTraceRead('张三').length === 1, 'C3 可按姓名查');
  ok(T.auditTraceRead().length >= 1, 'C3 不传筛选 = 返回全部（控制台 lisAuditTrace() 的用法）');

  // C4. 环形上限：写 900 条后只留最近 800
  for (let i = 0; i < 900; i++) {
    T.auditTraceAdd({dr: 'BULK' + i, labno: 'L' + i, path: '人工批审(F4)', ic: '1'});
  }
  const all = T.auditTraceRead();
  ok(all.length === 800, 'C4 环形上限 800（写 900 条后剩 800，实际 ' + all.length + '）');
  ok(all[all.length - 1].labno === 'L899', 'C4 保留的是**最近**的（末尾是最新一条）');
  ok(T.auditTraceRead('26091800246').length === 0, 'C4 最老的记录被正确淘汰');

  // C5. 快照：完整行 → ic=1 且 verdict 为空
  let snap = T.auditTraceSnapshot({ReportDR: 'S1', IsComplete: '1', NoResRows: ''});
  ok(snap.ic === '1' && snap.verdict === '', 'C5 完整标本的快照：ic=1、verdict 空（=脚本当时认为完整）');

  // C6. 快照：缺 3 项的行 → verdict 说明缺几项（这就是「定性证据」）
  snap = T.auditTraceSnapshot({ReportDR: 'S2', IsComplete: '2', NoResRows: '3'});
  ok(snap.ic === '2' && snap.nrr === '3' && /缺 3 项/.test(snap.verdict),
    'C6 不完整标本的快照带缺项数（事后据此判定「闸门被绕过」而不是「LIS 判错」）');

  // C7. 快照对 null 行不炸（跨整页刷新续跑时行可能取不到）
  snap = T.auditTraceSnapshot(null);
  ok(snap.ic === '' && typeof snap.verdict === 'string' && snap.verdict.length > 0, 'C7 拿不到行时快照不炸且 verdict 说明原因');
} catch (e) {
  ok(false, '留痕仿真切片/执行失败（锚点变了或旧版无此实现）：' + e.message);
}

/* ============ D. 逻辑仿真：真实 expectedItemsLearn / expectedItemsCheck ============ */
section('D. 逻辑仿真（应有项数 · 观察模式）');

try {
  const stub = `
const __store = {};
const localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : null),
  setItem: (k, v) => {__store[k] = String(v);},
  removeItem: k => {delete __store[k];}
};
const K = { expectedItems: 'LIS_ExpectedItems' };
let wsClassifiedCache = {};
function __setCache(c) {wsClassifiedCache = c || {};}
function __setRaw(k, v) {__store[k] = v;}
`;
  const modSrc =
    stub + '\n' +
    sliceNamedFn('expectedItemsLoad') + '\n' +
    sliceNamedFn('expectedItemsLearn') + '\n' +
    sliceNamedFn('expectedItemsCheck') + '\n' +
    'export { expectedItemsLoad, expectedItemsLearn, expectedItemsCheck, __setCache, __setRaw };\n';
  const tmpPath = path.join(HERE, '.cache', 'expected_items_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), {recursive: true});
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const E = await import('file://' + tmpPath);

  // D1. 学习来源：IsComplete='0' 时 NoResRows = 该组合项目总项数
  E.expectedItemsLearn([
    {TestSetDesc: '血常规', IsComplete: '0', NoResRows: '24'},
    {TestSetDesc: '短疗巡诊肿标一体检', IsComplete: '0', NoResRows: '3'}
  ]);
  let map = E.expectedItemsLoad();
  ok(map['血常规'] && map['血常规'].n === 24, "D1 从 IsComplete='0' 学到「血常规 = 24 项」（这正是 LIS 自己给的数）");
  ok(map['短疗巡诊肿标一体检'].n === 3, 'D1 另一个组合项目也学到');
  ok(map['血常规'].k === 1, 'D1 记观测次数（用于判断这条学习结果可不可信）');

  // D2. 只认「无结果」行；完整行 / 缺 NoResRows / 非正整数 都不学
  E.expectedItemsLearn([
    {TestSetDesc: '血常规', IsComplete: '1', NoResRows: ''},
    {TestSetDesc: '血常规', IsComplete: '2', NoResRows: '4'},
    {TestSetDesc: 'X', IsComplete: '0', NoResRows: ''},
    {TestSetDesc: 'Y', IsComplete: '0', NoResRows: 'abc'},
    {TestSetDesc: 'Z', IsComplete: '0', NoResRows: '0'},
    {TestSetDesc: '', IsComplete: '0', NoResRows: '9'}
  ]);
  map = E.expectedItemsLoad();
  ok(map['血常规'].n === 24 && map['血常规'].k === 1, "D2 IsComplete≠'0' 的行不参与学习（k 仍是 1）");
  ok(!map['X'] && !map['Y'] && !map['Z'], 'D2 缺 NoResRows / 非数字 / 0 → 不学（不产生垃圾条目）');
  ok(Object.keys(map).every(k => k !== ''), 'D2 组合项目为空 → 不学');

  // D3. 取历史最大值 + 累计观测次数
  E.expectedItemsLearn([{TestSetDesc: '血常规', IsComplete: '0', NoResRows: '26'}]);
  E.expectedItemsLearn([{TestSetDesc: '血常规', IsComplete: '0', NoResRows: '20'}]);
  map = E.expectedItemsLoad();
  ok(map['血常规'].n === 26, 'D3 取历史最大值（26 > 24，20 不覆盖）');
  ok(map['血常规'].k === 3, 'D3 观测次数累计（实际 ' + map['血常规'].k + '）');

  // D4. 检查：应有 24、实测 21 → 差 3（正是「缺了三个项目」的形态）
  E.__setCache({DRX: {items: new Array(21).fill({})}});
  let c = E.expectedItemsCheck({ReportDR: 'DRX', TestSetDesc: '血常规', IsComplete: '1'});
  ok(c.exp === 26 && c.act === 21 && c.short === 5, 'D4 应有/实测/差几项 都算出来（exp=' + c.exp + ' act=' + c.act + ' short=' + c.short + '）');

  // D5. 实测 >= 应有 → 不算差项（不误报）
  E.__setCache({DRY: {items: new Array(26).fill({})}});
  c = E.expectedItemsCheck({ReportDR: 'DRY', TestSetDesc: '血常规'});
  ok(c.short === 0, 'D5 项数对得上 → short=0（不误报）');
  E.__setCache({DRZ: {items: new Array(30).fill({})}});
  c = E.expectedItemsCheck({ReportDR: 'DRZ', TestSetDesc: '血常规'});
  ok(c.short === 0, 'D5 项数多于应有（如加项开单）→ 也不报');

  // D6. 没学到过的组合项目 / 没分类缓存 / 空行 → 一律全 0（宁可漏报不误报）
  E.__setCache({DR1: {items: new Array(2).fill({})}});
  ok(E.expectedItemsCheck({ReportDR: 'DR1', TestSetDesc: '没见过的项目'}).short === 0, 'D6 没学到过的组合项目 → 不判（全 0）');
  ok(E.expectedItemsCheck({ReportDR: 'NOCACHE', TestSetDesc: '血常规'}).short === 0, 'D6 没有分类缓存（拿不到实测项数）→ 不判');
  ok(E.expectedItemsCheck(null).short === 0, 'D6 空行 → 不判');
  ok(E.expectedItemsCheck({ReportDR: 'DR1', TestSetDesc: ''}).short === 0, 'D6 组合项目为空 → 不判');

  // D7. 损坏的存储不炸
  E.__setRaw('LIS_ExpectedItems', 'not-json');
  ok(Object.keys(E.expectedItemsLoad()).length === 0, 'D7 存储损坏 → 当空处理，不抛异常');
  E.__setRaw('LIS_ExpectedItems', '[1,2,3]');
  ok(Object.keys(E.expectedItemsLoad()).length === 0, 'D7 存储是数组（异常形态）→ 也当空处理');
  E.__setRaw('LIS_ExpectedItems', 'null');
  ok(Object.keys(E.expectedItemsLoad()).length === 0, 'D7 存储是 null → 也当空处理');
} catch (e) {
  ok(false, '应有项数仿真切片/执行失败（锚点变了或旧版无此实现）：' + e.message);
}

/* ============ 汇总 ============ */
console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');
