/**
 * 8.17.0 回归测试：工作台「外送」工作组（dr=5）—— 只追踪待排/采集，不做审核
 *
 * 需求：外送组（组内仅一台仪器「外送标本」）在工作台里只显示「待排 / 采集」状态的标本；
 * 标本一旦录入结果（不完整 / 待审 / 已审 / 取消）就必须从工作台所有视图与统计中消失，
 * 因为外送报告由第三方出具，本科室不审核。
 *
 * 本测试分两部分：
 *   A. 静态不变量 —— 四条链路（加载 / 入库过滤 / 分类桶 / 分类任务）都走外送规则，
 *                    且工作台里不许残留裸 `WG.`（漏一处 = 那一处把外送当自检组处理）
 *   B. 逻辑仿真   —— 把真实的 getWSAuditBucket 切片出来跑状态矩阵（含自检组不许被误伤）
 *
 * 用法：node external_wg_test.mjs
 *      LIS_SRC=/tmp/old.user.js node external_wg_test.mjs   # 反向验证：旧版必须失败
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
// 按花括号配平切函数体。⚠️ 必须先跳过参数表——否则 `function f(a, o = {}) {` 会命中默认参数对象
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
// ⚠️ 函数可能是 `async function`，两种前缀都要认（踩过：只找 '  function ' 会切不到 histLoad）
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
function endOfNamedFn(name) {
  const i = fnStart(name);
  if (i < 0) {throw new Error('切片失败：找不到 function ' + name);}
  return i + braceSlice(src, i).length;
}
const lineOf = needle => src.slice(0, src.indexOf(needle)).split('\n').length;

/* ============ A. 静态不变量 ============ */
section('A. 静态不变量');

// A1. 外送只在 WG_EXPORT_ONLY 里定义一次；WG（审核/质控口径）必须不含外送
const wgArr = src.slice(src.indexOf('  const WG = ['), src.indexOf('  // 仅「病人结果筛选导出」追加'));
ok(/dr: '1'/.test(wgArr) && /dr: '3'/.test(wgArr) && /dr: '4'/.test(wgArr), 'WG = 临检/生化/免疫 三个自检组');
ok(!/dr: '5'/.test(wgArr), 'WG（审核 + 质控口径）里没有外送——质控导出不能多出外送组');
const extLine = src.split('\n').find(l => l.includes('const WG_EXPORT_ONLY ='));
ok(!!extLine && /dr: '5'/.test(extLine) && /外送/.test(extLine), "WG_EXPORT_ONLY = 外送(dr=5)，全站唯一的 dr:'5' 定义");
ok(/const WS_WG = WG\.concat\(WG_EXPORT_ONLY\);/.test(src), 'WS_WG = 自检组 + 外送（工作台工作组全集）');

// A2. 工作台取数必须遍历 WS_WG（只遍历 WG 的话外送压根不会被加载）
ok(
  /const wgResults = await Promise\.all\(WS_WG\.map\(w => loadOneWG\(w\)\)\);/.test(src),
  'loadWSData 按 WS_WG 并行加载（含外送：机器列表 + 工作列表 + 待排/采集）'
);
// 启动预热同样要含外送，否则首次打开工作台外送组标签是空的
ok(
  /WS_WG\.forEach\(w => \{\n      loadMachines\(w\.dr\)\.catch/.test(src),
  '启动预热仪器列表按 WS_WG（含外送）'
);

// A3. 入库过滤：applyResults 必须把「非待排/采集」的外送行丢掉（这一层挡不住，后面处处要打补丁）
const applyBody = braceSlice(src, src.indexOf('      function applyResults(results, partial) {'));
ok(!!applyBody, '切到 applyResults 函数体');
ok(/isExternalTrackableRow\(r\)/.test(applyBody || ''), 'applyResults 里用 isExternalTrackableRow 过滤外送行');
const applyBeforeAssign = (applyBody || '').slice(0, (applyBody || '').indexOf('wsData = allData;'));
ok(
  /allData = allData\.filter\(r => !isExternalWSWorkGroup\(r\._wg\) \|\| isExternalTrackableRow\(r\)\)/.test(applyBeforeAssign),
  '过滤发生在 wsData = allData 之前（否则脏数据已经进工作台了）'
);

// A4. 分类桶：外送非待排/采集一律 audited，且必须排在原有 status 判断之前
const bucketSrc = sliceNamedFn('getWSAuditBucket');
const iExt = bucketSrc.indexOf('isExternalWSWorkGroup(r._wg)');
const iSt5 = bucketSrc.indexOf("if (status === '5')");
ok(iExt > 0, 'getWSAuditBucket 有外送分支');
ok(iExt > 0 && iSt5 > 0 && iExt < iSt5, '外送分支在 status===\'5\' 判断之前（外送不参与后续任何分类判定）');
ok(/isExternalWSWorkGroup\(r\._wg\)\) \{\s*\n\s*if \(status === '0'\) \{return 'pending';\}\s*\n\s*if \(status === '9'\) \{return 'collected';\}\s*\n\s*return 'audited';/.test(bucketSrc),
  '外送：0→pending、9→collected、其余→audited');

// A5. 分类任务：外送不参与结果分类（省请求 + 不产生分类缓存）
const toClassifySrc = (() => {
  const i = src.indexOf('const toClassify = wsData.filter(');
  return braceSlice(src, i + 'const toClassify = wsData'.length);
})();
ok(!!toClassifySrc, '切到 toClassify 过滤器');
ok(/isExternalWSWorkGroup\(r\._wg\)\) \{return false;\}/.test(toClassifySrc || ''), 'classifyAllSpecimens 的 toClassify 排除外送行');

// A6. 工作台热路径不许残留裸 `WG.`——残留一处就代表那处把外送当自检组算
const histStart = src.indexOf('  function histCandidateSS(');
const histEnd = endOfNamedFn('histLoad');
const bareHits = [];
src
  .split('\n')
  .forEach((l, i) => {
    if (l.trim().startsWith('//')) {return;}
    const idx = src.indexOf(l) + 0; // 仅用于计数，位置另算
    if (/(^|[^A-Za-z_])WG\./.test(l) && !/WS_WG\.|WG_MAP|WG_EXPORT/.test(l)) {
      bareHits.push({ line: i + 1, text: l.trim() });
    }
  });
const bareInHist = bareHits.filter(h => {
  const pos = src.split('\n').slice(0, h.line).join('\n').length;
  return pos >= histStart && pos <= histEnd;
});
ok(bareHits.length === 3, '全文件只剩 3 处裸 WG.（患者历史按自检组查询用；实际 ' + bareHits.length + ' 处：' + bareHits.map(h => h.line).join(',') + '）');
ok(bareInHist.length === bareHits.length, '这 3 处全部位于患者历史模块（histCandidateSS / histLoad），工作台热路径为 0');

// A7. 「外送 + 待审/不完整」是死路 → 必须归一为「待排」（标签点击 + 状态恢复两条路径）
const normSites = [...src.matchAll(/isExternalWSWorkGroup\(wsActiveWG\) && \(wsCategory === 'audit' \|\| wsCategory === 'incomplete'\)/g)].length;
ok(normSites === 2, '标签点击 / applyWSState 恢复 两条路径都做归一（实际 ' + normSites + ' 处）');

// A8. 外送标签悬停说明（用户要知道为什么这里永远没有待审）
const tabLine = src.split('\n').find(l => l.includes('class="ws-wg-tab" data-wg="${w.dr}"'));
ok(!!tabLine && /_tip/.test(tabLine), '外送工作组标签带悬停说明（title）');

// A9. 引用点下限：将来把某个 WG 改成 WS_WG 时漏改会被这条兜住
const wsWgRefs = (src.match(/WS_WG/g) || []).length;
ok(wsWgRefs >= 20, 'WS_WG 引用点 ≥ 20（实际 ' + wsWgRefs + ' 处；数量骤降说明有人回退成 WG）');

/* ============ B. 逻辑仿真：真实 getWSAuditBucket ============ */
section('B. 逻辑仿真（真实切片）');

// 旧版（或锚点被改坏）会让切片直接抛错——这里接住并记为失败，别让整个测试崩掉看不到 A 组结论
try {
  const regionStart = src.indexOf('  const WG = [');
  const regionEnd = endOfNamedFn('isExternalTrackableRow');
  if (regionStart < 0 || regionEnd <= regionStart) {throw new Error('切片失败：WG/外送常量区锚点变了');}
  const constRegion = src.slice(regionStart, regionEnd);

  const stub = `
let wsClassifiedCache = {};
let __completeFn = () => true;
function __setCache(c) { wsClassifiedCache = c; }
function __setComplete(fn) { __completeFn = fn; }
function isSpecimenActuallyComplete(r, cached) { return __completeFn(r, cached); }
function isClassificationStale() { return false; }
function isAsteriskPlaceholderResult() { return false; }
`;
  const modSrc =
    stub +
    '\n' +
    constRegion +
    '\n' +
    bucketSrc +
    '\n' +
    'export { WG, WG_EXPORT_ONLY, WS_WG, isExternalWSWorkGroup, isExternalTrackableRow, getWSAuditBucket, __setCache, __setComplete };\n';
  const tmpPath = path.join(HERE, '.cache', 'external_wg_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), { recursive: true });
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const M = await import('file://' + tmpPath);

  // B1. 常量结构
  ok(M.WS_WG.length === 4, 'WS_WG 有 4 个组（3 自检 + 外送），实际 ' + M.WS_WG.length);
  ok(M.WS_WG.map(w => w.dr).join(',') === '1,3,4,5', '顺序 = 临检/生化/免疫/外送（外送排在最后）');
  ok(M.WG.length === 3, 'WG 仍是 3 个自检组');
  ok(M.isExternalWSWorkGroup('5') === true && M.isExternalWSWorkGroup(5) === true, "isExternalWSWorkGroup('5') 与数字 5 都判真");
  ok(M.isExternalWSWorkGroup('1') === false && M.isExternalWSWorkGroup('') === false && M.isExternalWSWorkGroup(undefined) === false,
    '自检组/空值不判为外送（未打 _wg 的行不会被误吞）');

  // B2. isExternalTrackableRow：只有 0 / 9 在追踪范围
  ok(M.isExternalTrackableRow({ Status: '0' }) === true, '待排(0) 在追踪范围');
  ok(M.isExternalTrackableRow({ ReportStatus: '9' }) === true, '采集(9) 在追踪范围（Status 缺失时读 ReportStatus）');
  ['1', '2', '3', '4', '5', ''].forEach(st =>
    ok(M.isExternalTrackableRow({ Status: st }) === false, `状态「${st || '空'}」不在追踪范围（已出结果/已审/取消）`)
  );

  // B3. 外送状态矩阵：待排/采集留着，其余一律 audited（= 各分类视图都不显示）
  const ext = st => M.getWSAuditBucket({ _wg: '5', Status: st, ReportDR: 'x' + st, IsComplete: '1' });
  ok(ext('0') === 'pending', "外送 待排(0) → pending（进「待排」视图）");
  ok(ext('9') === 'collected', "外送 采集(9) → collected（进「采集」视图）");
  ok(ext('1') === 'audited', "外送 登记(1)（第三方已回结果）→ audited（从工作台消失）");
  ok(ext('2') === 'audited', "外送 初审(2) → audited");
  ok(ext('3') === 'audited', "外送 审核(3) → audited");
  ok(ext('4') === 'audited', "外送 复审(4) → audited");
  ok(ext('5') === 'audited', "外送 取消(5) → audited（不会因取消而混进任何视图）");
  ok(ext('') === 'audited', '外送 状态为空 → audited（宁可藏，不可误审）');

  // B4. 自检组口径不许被外送分支误伤（回归红线）
  M.__setComplete(() => true);
  M.__setCache({});
  const self = (wg, st, complete = true) => {
    M.__setComplete(() => complete);
    return M.getWSAuditBucket({ _wg: wg, Status: st, ReportDR: 'r' + wg + st, IsComplete: complete ? '1' : '0' });
  };
  ok(self('1', '0') === 'pending', '自检组 待排(0) 仍是 pending');
  ok(self('3', '9') === 'collected', '自检组 采集(9) 仍是 collected');
  ok(self('4', '3') === 'audited', '自检组 已审核(3) 仍是 audited');
  ok(self('4', '5') === 'audited', '自检组 取消(5) 仍是 audited');
  ok(self('1', '2', false) === 'incomplete', '自检组 结果不完整 → incomplete（没被外送分支吃掉）');
  M.__setCache({ r12: { status: 'NORMAL', items: [] } });
  ok(self('1', '2', true) === 'normal', '自检组 结果完整 + NORMAL 缓存 → normal（正常进待审）');
  M.__setCache({ r12: { status: 'CRITICAL', items: [] } });
  ok(self('1', '2', true) === 'abnormal', '自检组 危急值 → abnormal');
  M.__setCache({});
  ok(self('4', '4', false) === 'incomplete', '自检组 复审(4) 结果不完整 → incomplete');
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
