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
ok(/showToast\('🚨 审核后自检/.test(vfy), '发现不完整 → 红色告警 toast');
ok(/pushAutoAuditNotify\(/.test(vfy), '发现不完整 → 手机推送（critical 档）');
ok(/aaStateEventAdd\('pause'/.test(vfy), '发现不完整 → 记入状态时间线（可回溯）');
const vfyCall = idxOf('await verifyAuditedCompleteness(queue)');
const progMark = idxOf("const fill = document.getElementById('lis-prog-fill')");
ok(vfyCall > 0 && progMark > 0 && vfyCall < progMark, '自检在批量收尾、终态汇总之前执行');

// A7. 三条自动路径都要有闸门（漏一条就是漏一类标本）
ok(countOf(/specimenCompleteness\(/g) >= 5, 'specimenCompleteness 至少 5 处调用（定义 + 主循环复核 + 最终闸门 + 补审轮 + 详情提示 + 自检；实际 ' + countOf(/specimenCompleteness\(/g) + '）');
ok(countOf(/isSpecimenActuallyComplete\(/g) >= 8, 'isSpecimenActuallyComplete 调用点没被减少（实际 ' + countOf(/isSpecimenActuallyComplete\(/g) + '）');

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

/* ============ 汇总 ============ */
console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail) {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');
