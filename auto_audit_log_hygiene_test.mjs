/**
 * 8.17.1 / 8.17.2 回归测试：自动审核「记录 / 徽章」的口径收敛
 *
 * 用户反馈（原话 ①）：「我今天自动审核失败的标本 我后来手工审核掉了 但是还在自动审核记录里面有显示
 * 而且全部的标签里面 该标本依然有一个自动审核的徽章 这个不太合理」
 * 用户反馈（原话 ②，8.17.1 之后）：「开了自动审核情况下，刚才一个无法通过自动审核的标本我手动审掉了
 * 还是在自动审核记录的下拉窗口里面 而且也没有折叠 和自动审核的标本列在一起」
 *
 * 症状 → 修复：
 *   (a) 记录查看器 —— 未通过（留人工）的条目一旦被人工补审，默认折叠不显示（不再是待办）
 *   (b) 全部视图 🤖 徽章 —— 以「该标本在今日日志里的最后一条结论」为准，且人工审核过的一律不标
 *   (c) 8.17.1 折叠没生效的两个根因（8.17.2 修）：
 *       c1 批审主循环**直接调 clickNativeAuditButton**、压根不过 executeNativeAudit
 *          → 人工 F4 / 批审的留痕从来没打上；
 *       c2 折叠判定里加了「机器人今天审过它就不折叠」→ 恰好把「机器人先失败、后来人工补审」
 *          这条 skip 条目钉死在列表里。
 *       另外把「是不是机器人」的判定从 `_autoAuditRunning` 换成显式包裹的 isRobotAuditCtx()
 *       ——一轮自动审核可能持续几分钟，用户在这期间手动审的会被误判成机器人。
 *
 * 本测试分两部分：
 *   A. 静态不变量 —— 每条规则各自落在哪一行、有没有漏掉一条链路（这类改动「少掐一处不报错，
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
  let j = arrow + 2;
  while (/\s/.test(srcText[j])) {j++;}
  // ⚠️ 箭头函数有两种体：花括号块（`dr => {…}`）与表达式体（`dr => f(dr) === ''`）。
  // 只按花括号切的话，表达式体会一路找到文件后面某个 `{`，切出乱七八糟的一大段。
  if (srcText[j] === '{') {
    const body = braceFrom(srcText, j);
    if (!body) {throw new Error('切片失败：' + anchor + ' 花括号未配平');}
    return anchor + ' ' + body + ';'; // anchor 不带结尾 `{`，否则会拼出 `{{`
  }
  const semi = srcText.indexOf(';', j);
  if (semi < 0) {throw new Error('切片失败：' + anchor + ' 找不到语句结尾');}
  return anchor + ' ' + srcText.slice(j, semi + 1);
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
ok(/lastVerdict\.set\(String\(a\.d\), true\)/.test(rebuildSrc), 'audited 命中 → 该标本最后结论记为「成功」');
ok(!/if \(a && a\.d\) \{s\.add\(String\(a\.d\)\);\}/.test(rebuildSrc), '旧的「出现即入集合」写法已删除（否则新逻辑形同虚设）');
ok(/okAudited && !humanAuditedToday\(d\)/.test(rebuildSrc), '入集合前再减掉「人工审核过」的标本');

// A3. 「是不是机器人」的判定必须是显式包裹，不能用轮次标志
ok(!/autoAuditedRawTodayHas/.test(src), '已删除「机器人今天审过就不折叠」的原始集合（它会把该折叠的钉在列表里）');
ok(!/function humanAuditUnmark\(/.test(src), '已删除 humanAuditUnmark（改为「不是自动队列才打点」，不再需要回撤）');
const ctxSrc = src.slice(src.indexOf('  let _robotAuditDepth = 0;'), src.indexOf('  let _robotAuditDepth = 0;') + 300);
ok(/function robotAuditBegin\(/.test(ctxSrc) && /function robotAuditEnd\(/.test(ctxSrc) && /function isRobotAuditCtx\(/.test(ctxSrc),
  'robotAuditBegin / robotAuditEnd / isRobotAuditCtx 三个助手都在位');
ok(countOf(/robotAuditBegin\(\)/g) === 2, 'robotAuditBegin 调用点 = 1（定义 + 1 调用；实际 ' + countOf(/robotAuditBegin\(\)/g) + '）');
ok(countOf(/robotAuditEnd\(\)/g) === 2, 'robotAuditEnd 调用点 = 1（定义 + 1 调用；实际 ' + countOf(/robotAuditEnd\(\)/g) + '）');
const tickSrc = sliceNamedFn('autoAuditTick');
ok(/robotAuditBegin\(\);\s*\n\s*const ok = await auditAbnormalSpecimen\(r, \{ quiet: true \}\);/.test(tickSrc),
  '机器人异常逐条审核被 robotAuditBegin/End 显式包裹（这里就是「用户手动审的被误判成机器人」的来源）');
ok(/\} finally \{\s*\n\s*robotAuditEnd\(\);/.test(tickSrc), 'robotAuditEnd 在 finally 里（异常路径也要复位）');

// A4. 人工审核留痕的写入点①：走 executeNativeAudit 的入口（详情面板 / 回车 / F4 定位审核）
const execSrc = sliceNamedFn('executeNativeAudit');
ok(/if \(_ok && !isRobotAuditCtx\(\)\) \{humanAuditMark\(/.test(execSrc), 'executeNativeAudit 成功后、非机器人上下文 → humanAuditMark');
// 注释里可以提 _autoAuditRunning（说明为什么不用它），但**代码里不许出现**
ok(!/_autoAuditRunning/.test(execSrc.replace(/^\s*\/\/.*$/gm, '')), '⚠️ 代码里不能再出现 _autoAuditRunning（一轮可能持续几分钟，会误判人工为机器人）');
ok(/specimen && \(specimen\.ReportDR \|\| specimen\.reportDR\)/.test(execSrc), '取 DR 兼容大小写两套字段名');

// A5. 人工审核留痕的写入点②：批审队列三处成功点（主循环直接调 clickNativeAuditButton，不过 executeNativeAudit）
const markSites = countOf(/if \(!queue\._autoMode\) \{humanAuditMark\(/g);
ok(markSites === 3, 'continueAuditQueue 三处批审成功点都按 !queue._autoMode 打人工留痕（实际 ' + markSites + ' 处；漏一处 → 人工 F4/批审审掉的标本不会折叠）');
ok(countOf(/markSpecimenAuditedInMem\(/g) === 4, 'markSpecimenAuditedInMem 调用点仍是 4 处（1 定义 + 3 调用），说明打点没漏配');
const continueSrc = sliceNamedFn('continueAuditQueue');
const markInContinue = (continueSrc.match(/if \(!queue\._autoMode\) \{humanAuditMark\(/g) || []).length;
ok(markInContinue === 3, '这 3 处打点全部位于 continueAuditQueue 内（实际 ' + markInContinue + ' 处）');
ok(!/clickNativeAuditButton/.test(continueSrc) === false, '批审主循环确实直接调 clickNativeAuditButton（这是打点必须放在这里的理由）');

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
ok(/if \(humanAuditedToday\(d\)\) \{return '';\}/.test(viewerSrc), '判据①：人工审核留痕');
ok(/if \(st === '3' \|\| st === '4'\) \{return '';\}/.test(viewerSrc), "判据②：当前已审核(3)/复审(4) → 视为已处理（放宽到 4，覆盖复审标本）");
ok(!/autoAuditedRawTodayHas/.test(viewerSrc), '折叠判定里没有「机器人今天审过就不折叠」这条（它会挡住该折叠的条目）');
// 8.17.3: 自诊断——未折叠的「未通过」卡片必须带「为什么没折叠」的悬停提示
ok(/const aaHandledReason = dr =>/.test(viewerSrc), 'aaHandledReason 存在（返回原因文案，空串=已处理）');
ok(/const isAAHandledByHuman = dr => aaHandledReason\(dr\) === '';/.test(viewerSrc), 'isAAHandledByHuman 委托 aaHandledReason（单一事实来源，两处判据不会分叉）');
ok(/const _why = aaHandledReason\(s\.d\);/.test(viewerSrc), '未通过卡片会取「为什么没折叠」的原因文案');
ok(/title="\$\{escAttr\(_whyTip\)\}"/.test(viewerSrc), '原因文案写进 skip box 的 title（悬停可见，不占版面）');

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

// A9.5 8.17.8: 🤖 徽章集合的全量数据源——明细 audited 有 50 条上限（服务记录查看器展示），
// 超上限的「机器人审掉」标本只能靠 auditedDRs 进徽章集合，漏配任何一段都会大批量漏标
ok(/const auditedDRs = \[\];/.test(tickSrc), 'autoAuditTick 声明 auditedDRs 全量收集数组');
const drPushes = (tickSrc.match(/auditedDRs\.push\(/g) || []).length;
ok(drPushes === 2, '正常 + 异常两条成功路径都全量收集 DR（实际 ' + drPushes + ' 处）');
ok(/autoAuditLogAdd\(\{ normal: nNormal, abnormal: nAbnormal, skipped, audited, auditedDRs \}\)/.test(src), 'tick 直记路径把 auditedDRs 传给日志');
const settleSrc = sliceNamedFn('aaSettleAccum');
ok(/auditedDRs: auds\.map/.test(settleSrc), 'aaSettleAccum 结算路径也带全量 DR（补报/续跑/跨组结算不漏）');
const logAddSrc = sliceNamedFn('autoAuditLogAdd');
ok(/auditedDRs: Array\.from\(new Set\(/.test(logAddSrc), 'autoAuditLogAdd 落盘全量 DR（去重、不设上限）');
ok(/\(e\.auditedDRs \|\| \[\]\)\.forEach/.test(rebuildSrc), 'rebuildAutoAuditedTodaySet 读 auditedDRs（只看明细 audited 会漏标）');

// A10. 版本号必须已递增（pre-commit 钩子会拦，这里提前给出可读报错）
// 版本号断言用「不低于」——每次 bump 都改测试是负担，写成下限即可
function verAtLeast(v, min) {
  const a = String(v).split('.').map(Number);
  const b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {return (a[i] || 0) > (b[i] || 0);}
  }
  return true;
}
const ver = (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';
ok(verAtLeast(ver, '8.17.3'), '版本号 ≥ 8.17.3（本功能落地版本；实际 ' + ver + '）');

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

  // 查看器里的两个 const 箭头函数（无参数括号）——单独切出来接真函数跑。
  // ⚠️ 顺序不能反：isAAHandledByHuman 现在委托 aaHandledReason，两个都要切。
  const handledFn =
    sliceArrow(src, 'const aaHandledReason = dr =>') + '\n' + sliceArrow(src, 'const isAAHandledByHuman = dr =>');

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
    'export { rebuildAutoAuditedTodaySet, autoAuditedTodayHas, humanAuditMark, humanAuditedToday, isAAHandledByHuman, aaHandledReason, __setLog, __setRows, __clear };\n';
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

  // B2. 先成功后留人工（同一条标本，多轮日志）→ 以最后结论为准，徽章消失
  reset([
    {day: TODAY, time: '09:00:00', audited: [{d: 'B', t: 'normal'}], skipped: []},
    {day: TODAY, time: '09:00:30', audited: [], skipped: [{reportDR: 'B', reason: '审核未确认成功（留人工/下轮重试）'}]}
  ]);
  ok(M.autoAuditedTodayHas('B') === false, 'B2 最后一轮是「留人工」→ 不再带 🤖 徽章（旧版会误标）');

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
  ok(M.autoAuditedTodayHas('D') === false, 'B4 人工审核过 → 徽章消失（用户报的第 ① 条）');

  // B5. 跨天日志不参与
  reset([{day: YEST, time: '23:59:00', audited: [{d: 'E', t: 'normal'}], skipped: []}]);
  ok(M.autoAuditedTodayHas('E') === false, 'B5 昨天的记录不算今天（跨天口径不变）');

  // B6. 老日志里没有 reportDR 的跳过条目不能误伤别人
  reset([
    {day: TODAY, time: '09:00:00', audited: [{d: 'F', t: 'normal'}], skipped: []},
    {day: TODAY, time: '09:00:30', audited: [], skipped: [{name: '张三', labno: '001', reason: '结果不完整'}]}
  ]);
  ok(M.autoAuditedTodayHas('F') === true, 'B6 无 reportDR 的历史跳过条目不会误伤其他标本的徽章');

  // B7. isAAHandledByHuman：判据①留痕
  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'G', reason: '含负值结果，需人工审核'}]}]);
  M.__setRows({G: {ReportDR: 'G', Status: '2'}});
  ok(M.isAAHandledByHuman('G') === false, 'B7 留痕里没有、状态还是初审(2) → 不折叠（还欠着）');
  M.humanAuditMark('G');
  ok(M.isAAHandledByHuman('G') === true, 'B7 留痕命中 → 折叠（判据①：人工 F4/批审/详情面板都会打点）');

  // B8. 判据②：状态已审核(3)
  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'H', reason: '审核未确认成功（留人工/下轮重试）'}]}]);
  M.__setRows({H: {ReportDR: 'H', Status: '3'}});
  ok(M.isAAHandledByHuman('H') === true, 'B8 留痕为空但标本已审核(3) → 判定已处理，折叠');

  // B9. 判据②放宽到复审(4)
  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'H4', reason: '结果不完整'}]}]);
  M.__setRows({H4: {ReportDR: 'H4', Status: '4'}});
  ok(M.isAAHandledByHuman('H4') === true, 'B9 复审(4) 也算已处理（8.17.2 放宽，覆盖复检标本）');

  // B10. 8.17.2 关键：机器人先报成功、又留人工（最后结论=留人工）的标本，人工补审后**必须折叠**
  //      ——8.17.1 就是因为「机器人今天审过它」这条判据把它钉在列表里，现场反馈「没有折叠」。
  reset([
    {day: TODAY, time: '09:00:00', audited: [{d: 'I', t: 'normal'}], skipped: []},
    {day: TODAY, time: '09:00:30', audited: [], skipped: [{reportDR: 'I', reason: '审核未确认成功（留人工/下轮重试）'}]}
  ]);
  M.__setRows({I: {ReportDR: 'I', Status: '3'}});
  ok(M.autoAuditedTodayHas('I') === false, 'B10 徽章按最后结论已消失');
  ok(M.isAAHandledByHuman('I') === true, 'B10 skip 条目照样折叠（机器人审掉的那条是另一条 audited 条目，不受影响）');

  // B11. 查不到活体行时只看留痕（保守：宁可多留一条，也不误折叠）
  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'J', reason: '结果不完整'}]}]);
  M.__setRows({});
  ok(M.isAAHandledByHuman('J') === false, 'B11 标本已出工作台范围且无留痕 → 不折叠');
  M.humanAuditMark('J');
  ok(M.isAAHandledByHuman('J') === true, 'B11 有留痕则照样折叠');

  // B12. 空值防御
  reset([]);
  ok(M.isAAHandledByHuman('') === false && M.isAAHandledByHuman(null) === false && M.isAAHandledByHuman(undefined) === false, 'B12 空 DR 一律不折叠（不会因为日志缺字段而整片消失）');
  ok(M.autoAuditedTodayHas('') === false, 'B12 空 DR 不命中徽章集合');

  // B13. 留痕写入幂等 / 可读回
  reset([]);
  M.humanAuditMark('K1');
  M.humanAuditMark('K2');
  ok(M.humanAuditedToday('K1') === true && M.humanAuditedToday('K2') === true, 'B13 留痕可写入并可读回');
  ok(M.humanAuditMark('K1') === undefined && M.humanAuditedToday('K1') === true, 'B13 重复写入同一条不报错、不丢数据');

  // B14. 空 DR 的留痕打点不炸（humanAuditMark(undefined) 必须静默返回）
  reset([]);
  M.humanAuditMark(undefined);
  M.humanAuditMark('');
  ok(true, 'B14 humanAuditMark 收到空 DR 不抛异常（自动审核队列项字段缺失时不会打断批审）');

  // B15. 8.17.3 自诊断：原因文案（悬停在「未通过」上就能看到为什么没折叠）
  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'N1', reason: '结果不完整'}]}]);
  M.__setRows({N1: {ReportDR: 'N1', Status: '2', StatusDesc: '初审'}});
  const whyPending = M.aaHandledReason('N1');
  ok(
    typeof whyPending === 'string' && whyPending.length > 0 && whyPending.includes('2') && whyPending.includes('初审'),
    'B15 未审核的标本 → 原因文案里带当前状态与状态名（悬停一眼看出「还没审核」）'
  );
  M.humanAuditMark('N1');
  ok(M.aaHandledReason('N1') === '', 'B15 人工审核留痕命中 → 原因文案为空 = 已处理（折叠）');

  // B16. 8.17.8: 明细 50 条上限不再拖累徽章——auditedDRs 全量 DR 照样进集合，且服从「最后结论为准」
  reset([{day: TODAY, time: '09:00:00', audited: [], auditedDRs: ['X1', 'X2'], skipped: []}]);
  ok(M.autoAuditedTodayHas('X1') === true && M.autoAuditedTodayHas('X2') === true, 'B16 超出明细上限的轮次：auditedDRs 里的标本照样带 🤖 徽章');
  reset([
    {day: TODAY, time: '09:00:00', audited: [], auditedDRs: ['Y1'], skipped: []},
    {day: TODAY, time: '09:00:30', audited: [], skipped: [{reportDR: 'Y1', reason: '审核未确认成功（留人工/下轮重试）'}]}
  ]);
  ok(M.autoAuditedTodayHas('Y1') === false, 'B16 auditedDRs 也服从「最后一条结论为准」（后轮留人工 → 徽章消失）');
  reset([
    {day: TODAY, time: '09:00:00', audited: [{d: 'Z1', t: 'normal'}], skipped: []},
    {day: TODAY, time: '09:00:30', audited: [], auditedDRs: ['Z1'], skipped: []}
  ]);
  ok(M.autoAuditedTodayHas('Z1') === true, 'B16 auditedDRs 与明细 audited 混用时结论一致（成功）');
  reset([{day: TODAY, time: '09:00:00', audited: [], auditedDRs: ['Y2'], skipped: []}]);
  M.humanAuditMark('Y2');
  ok(M.autoAuditedTodayHas('Y2') === false, 'B16 auditedDRs 命中的标本被人工补审后徽章照常消失（人工留痕优先）');

  reset([{day: TODAY, time: '09:00:00', audited: [], skipped: [{reportDR: 'N2', reason: '结果不完整'}]}]);
  M.__setRows({N2: {ReportDR: 'N2', Status: '3'}});
  ok(M.aaHandledReason('N2') === '', 'B15 已审核(3) → 原因文案为空 = 已处理');
  M.__setRows({});
  ok(/找不到/.test(M.aaHandledReason('N2')), 'B15 查不到活体行 → 原因文案说明「找不到，保守保留」');
  ok(/ReportDR/.test(M.aaHandledReason('')), 'B15 空 DR → 原因文案说明「旧记录无 ReportDR」');
  ok(M.isAAHandledByHuman('N2') === false, 'B15 有原因文案 ⇔ isAAHandledByHuman 为假（两者永远一致）');
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
