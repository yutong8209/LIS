/**
 * 8.17.1 回归测试：自动审核「记录 / 徽章」的口径收敛
 *
 * 用户反馈（原话）：「我今天自动审核失败的标本 我后来手工审核掉了 但是还在自动审核记录里面有显示
 * 而且全部的标签里面 该标本依然有一个自动审核的徽章 这个不太合理」
 *
 * 两个症状，两条修复：
 *   (a) 记录查看器 —— 未通过（留人工）的条目一旦被人工补审，默认折叠不显示（不再是待办）
 *   (b) 全部视图 🤖 徽章 —— 以「该标本在今日日志里的最后一条结论」为准，且人工审核过的一律不标
 *
 * 本测试分两部分：
 *   A. 静态不变量 —— 两条规则各自落在哪一行、有没有漏掉一条链路（这类改动「少掐一处不报错，
 *                    只会静默重复显示」，只有静态断言拦得住）
 *   B. 逻辑仿真   —— 把真实的 rebuildAutoAuditedTodaySet / humanAuditMark / isAAHandledByHuman
 *                    切片出来跑日志场景矩阵
 *
 * 用法：node auto_audit_log_hygiene_test.mjs
 *      LIS_SRC=/tmp/old.user.js node auto_audit_log_hygiene_test.mjs   # 反向验证：旧版必须失败
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

/* ---------- 切片工具：按内容锚点，不写死行号（每次编辑都会移位） ---------- */
// 按花括号配平切。⚠️ 必须先跳过参数表——否则 `function f(a, o = {}) {` 会命中默认参数对象
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
// ⚠️ 函数可能是 `async function`，两种前缀都要认
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
const countOf = re => (src.match(re) || []).length;
// ⚠️ 箭头函数可能没有参数括号（`dr => {`）——braceSlice 会误命中函数体里的第一个 `(`，
// 于是从函数体内部的 `{` 开始配平、切出半截。箭头函数必须显式从 `=>` 后面的 `{` 开始配平。
function braceFrom(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') {depth++;}
    else if (source[i] === '}' && --depth === 0) {return source.slice(openIdx, i + 1);}
  }
  return null;
}
function sliceArrow(srcText, anchor) {
  const i = srcText.indexOf(anchor);
  if (i < 0) {throw new Error('切片失败：找不到箭头函数锚点 ' + anchor);}
  const arrow = srcText.indexOf('=>', i);
  const open = srcText.indexOf('{', arrow);
  const body = braceFrom(srcText, open);
  if (!body) {throw new Error('切片失败：' + anchor + ' 花括号未配平');}
  return anchor + ' ' + body + ';'; // anchor 不带结尾 `{`，否则会拼出 `{{`
}

/* ============ A. 静态不变量 ============ */
section('A. 静态不变量');

// A1. 常量：人工审核留痕必须有自己的键（和自动审核日志分开，别污染机器人自己的记录）
ok(/humanAuditLog: 'LIS_HumanAuditLog'/.test(src), "K.humanAuditLog = 'LIS_HumanAuditLog'（独立留痕键）");

// A2. 徽章口径：rebuildAutoAuditedTodaySet 必须以「最后一条结论」为准，不能「出现即入集合」
const rebuildSrc = sliceNamedFn('rebuildAutoAuditedTodaySet');
ok(/lastVerdict/.test(rebuildSrc), 'rebuildAutoAuditedTodaySet 用 lastVerdict 记录同一标本的最后一条结论');
ok(/\(e\.skipped \|\| \[\]\)\.forEach/.test(rebuildSrc), '重建时也扫 skipped（否则「先成功后留人工」收敛不掉）');
ok(/lastVerdict\.set\(d, false\)/.test(rebuildSrc), 'skipped 命中 → 该标本最后结论记为「非成功」');
ok(/lastVerdict\.set\(d, true\)/.test(rebuildSrc), 'audited 命中 → 该标本最后结论记为「成功」');
ok(!/if \(a && a\.d\) \{s\.add\(String\(a\.d\)\);\}/.test(rebuildSrc), '旧的「出现即入集合」写法已删除（否则新逻辑形同虚设）');
ok(/okAudited && !humanAuditedToday\(d\)/.test(rebuildSrc), '入集合前再减掉「人工审核过」的标本');

// A3. 原始集合：记录查看器要能区分「机器人干的」与「人工补的」
ok(/function autoAuditedRawTodayHas\(/.test(src), 'autoAuditedRawTodayHas 存在（只看成功记录、不做最终态收敛）');
ok(/_autoAuditedRawTodayDRs = raw;/.test(rebuildSrc), '重建时一并产出原始集合');

// A4. 人工审核留痕的写入点：executeNativeAudit 是所有人工审核入口的唯一咽喉
const execSrc = sliceNamedFn('executeNativeAudit');
ok(/if \(_ok && !_autoAuditRunning\) \{humanAuditMark\(/.test(execSrc), 'executeNativeAudit 成功后、非自动审核轮次内 → humanAuditMark');
ok(/specimen && \(specimen\.ReportDR \|\| specimen\.reportDR\)/.test(execSrc), '取 DR 兼容大小写两套字段名');

// A5. 自动审核队列不算人工：continueAuditQueue 三处成功点都要回撤
const unmarkSites = countOf(/if \(queue\._autoMode\) \{humanAuditUnmark\(/g);
ok(unmarkSites === 3, 'continueAuditQueue 三处批审成功点都做 humanAuditUnmark（实际 ' + unmarkSites + ' 处；漏一处 → 轮次外续跑时机器人审掉的标本丢徽章）');
ok(countOf(/markSpecimenAuditedInMem\(/g) === 4, 'markSpecimenAuditedInMem 调用点仍是 4 处（1 定义 + 3 调用），说明回撤点没漏配');
const continueSrc = sliceNamedFn('continueAuditQueue');
const unmarkInContinue = (continueSrc.match(/if \(queue\._autoMode\) \{humanAuditUnmark\(/g) || []).length;
ok(unmarkInContinue === 3, '这 3 处回撤全部位于 continueAuditQueue 内（实际 ' + unmarkInContinue + ' 处）');

// A6. 记录查看器：只有「未通过」条目会被折叠，机器人审掉的条目绝不受影响
const viewerSrc = sliceNamedFn('openAutoAuditLogViewer');
ok(/const isAAHandledByHuman = dr =>/.test(viewerSrc), '查看器内有 isAAHandledByHuman 判定');
ok(/if \(s\.t === 'skip' && isAAHandledByHuman\(s\.d\)\) \{/.test(viewerSrc), '折叠只作用于 t===\'skip\' 的条目（机器人审掉的 normal/abnormal 不受影响）');
ok(/s\.handled = true;\s*\n\s*handledCount\+\+;\s*\n\s*if \(!showHandled\) \{return;\}/.test(viewerSrc),
  '先计数再折叠（顺序反了会导致「已人工处理 N」永远显示 0）');
ok(/id="lis-aal-handled"/.test(viewerSrc) && /handledBtn\.addEventListener\('click'/.test(viewerSrc), '「✅ 已人工处理」开关存在且绑定了点击');
ok(/let showHandled = false;/.test(viewerSrc), '开关默认关闭 = 默认折叠');
ok(/s\.handled \? handledBadge : badge\(s\)/.test(viewerSrc), '折叠态用中性灰徽章，不再挂「未通过」');
ok(/s\.handled \? 'handled' : s\.t === 'abnormal'/.test(viewerSrc), '折叠态卡片走 .handled 灰调（不再染成橙色待办色）');
ok(/都已被人工审核处理完/.test(viewerSrc), '全被折叠时不显示「暂无记录」（否则用户以为日志丢了）');
ok(/if \(humanAuditedToday\(d\)\) \{return true;\}/.test(viewerSrc), '判据①：人工审核留痕');
ok(/if \(autoAuditedRawTodayHas\(d\)\) \{return false;\}/.test(viewerSrc), '判据②：机器人今天审过 → 不算人工处理（不会被误折叠）');

// A7. 全部视图徽章仍按原口径（本次只改集合内容，不改渲染条件）
const iBadge = src.indexOf('autoAuditedTodayHas(r.ReportDR)');
ok(iBadge > 0, '找到 🤖 徽章渲染点（autoAuditedTodayHas 调用）');
ok(/String\(statusVal\) === '3' && autoAuditedTodayHas\(r\.ReportDR\)/.test(src), '徽章条件未变（status 3 + 今日集合命中）——改的是集合内容不是渲染条件');
ok(/ws-aa-mark/.test(src.slice(iBadge, iBadge + 300)), '徽章本体仍渲染 ws-aa-mark（没被改坏）');

// A8. 跳过条目必须带 reportDR：否则累积器把它和同一标本的「正常」当成两条标本（重复计数），
//     记录查看器也无从判断它是否已被人工补审
const rawSkipPushes = [...src.matchAll(/const entry = \{ reportDR: String\(r\.ReportDR \|\| ''\), name: r\.PatName/g)].length;
ok(rawSkipPushes === 2, '自动审核异常逐条段的两处 skipped.push 都补了 reportDR（实际 ' + rawSkipPushes + ' 处）');

// A9. 留痕不能无界增长
ok(/const HUMAN_AUDIT_MAX = \d+;/.test(src), '人工审核留痕有单日上限');
ok(/if \(keys\.length >= HUMAN_AUDIT_MAX\) \{delete m\.d\[keys\[0\]\];\}/.test(src), '超上限时按最早一条淘汰');
ok(/m\.day !== today/.test(src), '跨天自动丢弃（留痕只服务当日口径）');

// A10. 版本号必须已递增（pre-commit 钩子会拦，这里提前给出可读报错）
const ver = (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';
ok(ver === '8.17.1', '版本号已 bump 到 8.17.1（实际 ' + ver + '）');

/* ============ B. 逻辑仿真：真实切片 ============ */
section('B. 逻辑仿真（真实切片）');

const fmtDay = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
const TODAY = fmtDay(new Date());
const YEST = fmtDay(new Date(Date.now() - 86400000));

try {
  const regionStart = src.indexOf('  // 8.5.66: 今日已自动审核的标本 ReportDR 集合');
  const regionEnd = src.indexOf('  // 8.5.61: autoAuditLogToday 已由 openAutoAuditLogViewer');
  if (regionStart < 0 || regionEnd <= regionStart) {throw new Error('切片失败：自动审核日志区锚点变了');}
  const region = src.slice(regionStart, regionEnd);

  // isAAHandledByHuman 是查看器里的 const 箭头函数（无参数括号）——单独切出来接真函数跑
  const handledFn = sliceArrow(src, 'const isAAHandledByHuman = dr =>');

  const stub = `
const __store = {};
const localStorage = {
  getItem: k => (Object.prototype.hasOwnProperty.call(__store, k) ? __store[k] : null),
  setItem: (k, v) => {__store[k] = String(v);},
  removeItem: k => {delete __store[k];}
};
const K = { autoAuditLog: 'LIS_AutoAuditLog', humanAuditLog: 'LIS_HumanAuditLog' };
let __rows = {};
function __setLog(arr) {localStorage.setItem(K.autoAuditLog, JSON.stringify(arr));}
function __setRows(m) {__rows = m || {};}
function __clear() {delete __store[K.autoAuditLog]; delete __store[K.humanAuditLog];}
function findWSSpecimenByReportDR(dr) {return __rows[String(dr)] || null;}
`;
  const modSrc =
    stub +
    '\n' +
    region +
    '\n' +
    handledFn +
    '\n' +
    'export { rebuildAutoAuditedTodaySet, autoAuditedTodayHas, autoAuditedRawTodayHas, humanAuditMark, humanAuditUnmark, humanAuditedToday, isAAHandledByHuman, __setLog, __setRows, __clear };\n';
  const tmpPath = path.join(HERE, '.cache', 'auto_audit_log_hygiene_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), {recursive: true});
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const M = await import('file://' + tmpPath);

  // 清空两个存储 + 按给定日志重建（同时重置跨天缓存）
  const reset = log => {
    M.__clear();
    M.__setLog(log || []);
    M.__setRows({});
    M.humanAuditedToday('__warm__');
    M.rebuildAutoAuditedTodaySet();
  };

  // B1. 只有成功记录 → 徽章
  reset([{day: TODAY, time: '09:00:00', audited: [{d: 'A', t: 'normal'}], skipped: []}]);
  ok(M.autoAuditedTodayHas('A') === true, 'B1 机器人审掉的标本 → 带 🤖 徽章');
  ok(M.autoAuditedRawTodayHas('A') === true, 'B1 原始集合也命中（记录查看器认得它是机器人干的）');

  // B2. 先成功后留人工（同一条标本，多轮日志）→ 以最后结论为准，徽章消失
  reset([
    {day: TODAY, time: '09:00:00', audited: [{d: 'B', t: 'normal'}], skipped: []},
    {day: TODAY, time: '09:00:30', audited: [], skipped: [{reportDR: 'B', reason: '审核未确认成功（留人工/下轮重试）'}]}
  ]);
  ok(M.autoAuditedTodayHas('B') === false, 'B2 最后一轮是「留人工」→ 不再带 🤖 徽章（旧版会误标）');
  ok(M.autoAuditedRawTodayHas('B') === true, 'B2 原始集合仍记得机器人报过成功（查看器据此不误折叠）');

  // B3. 先留人工、后被机器人补审成功 → 最后结论是成功，徽章在
  reset([
    {day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'C', reason: '审核未确认成功（留人工/下轮重试）'}]},
    {day: TODAY, time: '09:01:00', audited: [{d: 'C', t: 'normal'}], skipped: []}
  ]);
  ok(M.autoAuditedTodayHas('C') === true, 'B3 留人工后机器人补审成功 → 恢复 🤖 徽章（不能把救回来的也掐掉）');

  // B4. 人工审核留痕 → 徽章消失（覆盖「机器人乐观判定成功、其实没审掉」）
  reset([{day: TODAY, time: '09:00:00', audited: [{d: 'D', t: 'normal'}], skipped: []}]);
  ok(M.autoAuditedTodayHas('D') === true, 'B4 打留痕之前：带徽章');
  M.humanAuditMark('D');
  ok(M.autoAuditedTodayHas('D') === false, 'B4 人工审核过 → 徽章消失（这是用户报的那条）');
  ok(M.autoAuditedRawTodayHas('D') === true, 'B4 原始集合不变（机器人确实报过成功，不该被抹掉）');

  // B5. 回撤留痕（自动队列在轮次外续跑被误当人工）→ 徽章恢复
  M.humanAuditUnmark('D');
  ok(M.autoAuditedTodayHas('D') === true, 'B5 humanAuditUnmark 后徽章恢复（自动队列不算人工）');

  // B6. 跨天日志不参与
  reset([{day: YEST, time: '23:59:00', audited: [{d: 'E', t: 'normal'}], skipped: []}]);
  ok(M.autoAuditedTodayHas('E') === false && M.autoAuditedRawTodayHas('E') === false, 'B6 昨天的记录不算今天（跨天口径不变）');

  // B7. 老日志里没有 reportDR 的跳过条目不能误伤别人
  reset([
    {day: TODAY, time: '09:00:00', audited: [{d: 'F', t: 'normal'}], skipped: []},
    {day: TODAY, time: '09:00:30', audited: [], skipped: [{name: '张三', labno: '001', reason: '结果不完整'}]}
  ]);
  ok(M.autoAuditedTodayHas('F') === true, 'B7 无 reportDR 的历史跳过条目不会误伤其他标本的徽章');

  // B8. isAAHandledByHuman：判据①留痕
  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'G', reason: '含负值结果，需人工审核'}]}]);
  M.__setRows({G: {ReportDR: 'G', Status: '2'}});
  ok(M.isAAHandledByHuman('G') === false, 'B8 留痕里没有、状态还是初审(2) → 不折叠（还欠着）');
  M.humanAuditMark('G');
  ok(M.isAAHandledByHuman('G') === true, 'B8 留痕命中 → 折叠（判据①）');

  // B9. isAAHandledByHuman：判据②状态=3 且机器人没审过（覆盖升级前的历史数据）
  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'H', reason: '审核未确认成功（留人工/下轮重试）'}]}]);
  M.__setRows({H: {ReportDR: 'H', Status: '3'}});
  ok(M.isAAHandledByHuman('H') === true, 'B9 留痕为空但标本已审核(3) 且机器人没审过 → 判定人工补审，折叠');

  // B10. 机器人今天审过的标本，绝不因 Status=3 被误折叠
  reset([{day: TODAY, time: '09:00:00', audited: [{d: 'I', t: 'normal'}], skipped: []}]);
  M.__setRows({I: {ReportDR: 'I', Status: '3'}});
  ok(M.isAAHandledByHuman('I') === false, 'B10 机器人审掉的标本（Status=3）不会被误折叠');

  // B11. 查不到活体行时只看留痕（保守：宁可多留一条，也不误折叠）
  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'J', reason: '结果不完整'}]}]);
  M.__setRows({});
  ok(M.isAAHandledByHuman('J') === false, 'B11 标本已出工作台范围且无留痕 → 不折叠');
  M.humanAuditMark('J');
  ok(M.isAAHandledByHuman('J') === true, 'B11 有留痕则照样折叠');

  // B12. 空值防御
  reset([]);
  ok(M.isAAHandledByHuman('') === false && M.isAAHandledByHuman(null) === false && M.isAAHandledByHuman(undefined) === false, 'B12 空 DR 一律不折叠（不会因为日志缺字段而整片消失）');
  ok(M.autoAuditedTodayHas('') === false && M.autoAuditedRawTodayHas('') === false, 'B12 空 DR 不命中徽章集合');

  // B13. 留痕单日上限淘汰最早一条（防 localStorage 无界增长）
  reset([]);
  M.humanAuditMark('K1');
  M.humanAuditMark('K2');
  ok(M.humanAuditedToday('K1') === true && M.humanAuditedToday('K2') === true, 'B13 留痕可写入并可读回');
  ok(M.humanAuditMark('K1') === undefined && M.humanAuditedToday('K1') === true, 'B13 重复写入同一条不报错、不丢数据');
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
