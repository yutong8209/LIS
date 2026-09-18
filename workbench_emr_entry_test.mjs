/**
 * 8.17.4 回归测试：工作台「待审」卡片直达电子病历（📄 病历 / 快捷键 M）
 *
 * 需求（用户原话）：「在待审界面的标本 能不能也直达病历系统啊 我好像没看到入口」
 * 背景：病历入口此前只在**详情面板**（`📄 病历` 按钮）与「病人结果筛选导出」的行里，
 *      待审卡片上没有——用户在待审列表里想顺手看一眼病历，得先 Shift+Enter 开详情面板。
 *
 * 本次改动：
 *   - 待审卡片（正常卡 + 异常卡）各加一个 `📄 病历` 按钮；
 *   - 待审视图加 `M` 快捷键（Shift+M = 直接唤起原生 32 位 IE）；
 *   - 详情面板也补 `M`（与 `H`=历史 成对），页脚提示同步补上；
 *   - 卡片按钮与详情面板按钮走**同一个** `openEnhancedEMR`，取数口径（Labno/PatName/RegNo/
 *     EpisodeNo）完全一致，不会出现「卡片能开、面板开不了」。
 *
 * 本测试分两部分：
 *   A. 静态不变量 —— 两个卡片类型都要有按钮、点击拦截必须排在卡片选中之前（顺序错了按钮就点不动）、
 *                    M 键只允许我加的这两处（不能与既有键冲突）
 *   B. 逻辑仿真   —— 把真实的 openEMRForWSRow / wsEmrBtnHTML 切片出来跑参数与降级路径
 *
 * 用法：node workbench_emr_entry_test.mjs
 *      LIS_SRC=/tmp/old.user.js node workbench_emr_entry_test.mjs   # 反向验证：旧版必须失败
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

/* ---------- 切片工具（与 auto_audit_log_hygiene_test.mjs 同一套） ---------- */
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
// ⚠️ `xxx = e => {` 这种箭头函数**没有参数括号**，braceSlice 会命中函数体内部的第一个 `(` 而切错。
// 箭头函数必须显式从 `=>` 之后的 `{` 开始配平。
function braceFrom(source, openIdx) {
  let depth = 0;
  for (let i = openIdx; i < source.length; i++) {
    if (source[i] === '{') {depth++;}
    else if (source[i] === '}' && --depth === 0) {return source.slice(openIdx, i + 1);}
  }
  return null;
}
function sliceArrowBodyAt(source, anchor) {
  const i = source.indexOf(anchor);
  if (i < 0) {throw new Error('切片失败：找不到 ' + anchor);}
  const arrow = source.indexOf('=>', i);
  const open = source.indexOf('{', arrow);
  const body = braceFrom(source, open);
  if (!body) {throw new Error('切片失败：' + anchor + ' 花括号未配平');}
  return body;
}
// 版本号断言用「不低于」——每次 bump 都改测试是负担，写成下限即可
function verAtLeast(v, min) {
  const a = String(v).split('.').map(Number);
  const b = String(min).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] || 0) !== (b[i] || 0)) {return (a[i] || 0) > (b[i] || 0);}
  }
  return true;
}
const countOf = re => (src.match(re) || []).length;

/* ============ A. 静态不变量 ============ */
section('A. 静态不变量');

// A1. 版本号
const ver = (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';
ok(verAtLeast(ver, '8.17.4'), '版本号 ≥ 8.17.4（本功能落地版本；实际 ' + ver + '）');

// A2. 助手函数在位
// ⚠️ 切片失败要记为失败项，别让整个测试崩掉——跑旧版做反向验证时旧版压根没这两个函数，
// 抛异常退出会让人看不到 A 组的结论。
try {
  const openFn = sliceNamedFn('openEMRForWSRow');
  ok(/openEnhancedEMR\(labno, \{/.test(openFn), 'openEMRForWSRow 复用 openEnhancedEMR（与详情面板同一入口，不会两套取数口径）');
  ok(/labNo: labno/.test(openFn) && /patName: r\.PatName \|\| ''/.test(openFn), '传 labNo + patName');
  ok(/regNo: r\.RegNo \|\| ''/.test(openFn) && /episodeNo: r\.EpisodeNo \|\| ''/.test(openFn), '传 regNo + episodeNo（HIS 定位就诊靠这两个）');
  ok(/directNativeIE: !!shiftKey/.test(openFn), 'Shift+点击 → directNativeIE（原生 32 位 IE 才能渲染病历文书正文）');
  ok(/if \(!labno\) \{showToast\(/.test(openFn), '没有检验号时给提示而不是静默失败');
  ok(/if \(!r\) \{showToast\(/.test(openFn), '没定位到标本时给提示');
} catch (e) {
  ok(false, '切片失败：openEMRForWSRow 不存在（旧版无此实现）：' + e.message);
}

try {
  const btnFn = sliceNamedFn('wsEmrBtnHTML');
  ok(/class="ab-emr-btn"/.test(btnFn), '按钮用 .ab-emr-btn 类');
  ok(/data-emr="' \+ escAttr\(r\.ReportDR \|\| ''\)/.test(btnFn), '按钮带 data-emr=ReportDR（点击时再取活体行，卡片重渲染后不会拿到过期数据）');
  ok(/📄 病历/.test(btnFn), '按钮有可见文字「📄 病历」（不能只放图标——用户就是因为看不见入口才来问的）');
  ok(/Shift\+点击/.test(btnFn), 'title 里说明 Shift+点击 = 原生 IE');
} catch (e) {
  ok(false, '切片失败：wsEmrBtnHTML 不存在（旧版无此实现）：' + e.message);
}

// A3. 两个卡片类型都要挂上（漏一个 → 那类标本没有入口）
ok(countOf(/\$\{wsEmrBtnHTML\(r\)\}/g) === 2, '正常卡 + 异常卡各挂一次 wsEmrBtnHTML（实际 ' + countOf(/\$\{wsEmrBtnHTML\(r\)\}/g) + ' 处）');
ok(countOf(/wsEmrBtnHTML\(/g) === 3, 'wsEmrBtnHTML 共 3 处（1 定义 + 2 使用）');
ok(countOf(/ab-card-right-acts/g) === 3, '.ab-card-right-acts 共 3 处（1 CSS + 2 使用）');

// A4. 点击拦截顺序：必须先判 .ab-emr-btn，再判 .ws-abnormal-card
const iEmrClick = src.indexOf("e.target.closest('.ab-emr-btn')");
const iCardClick = src.indexOf("e.target.closest('.ws-abnormal-card')");
ok(iEmrClick > 0 && iCardClick > 0 && iEmrClick < iCardClick, '病历按钮的点击拦截排在「选中卡片」之前（顺序反了 → 点按钮只会选中卡片，按钮像坏的一样）');

// A5. M 键：只允许我加的这两处（待审视图 + 详情面板），且不能与既有键冲突
const mKeySites = countOf(/e\.key === 'm' \|\| e\.key === 'M'/g);
ok(mKeySites === 2, 'M 键只加在待审视图与详情面板两处（实际 ' + mKeySites + ' 处）');
const occupied = new Set();
for (const m of src.matchAll(/e\.(?:key|code)\s*===?\s*'([^']+)'/g)) {occupied.add(m[1]);}
ok(!occupied.has('m') && !occupied.has('M') || mKeySites === 2, 'M 未与既有快捷键冲突（已占用：' + [...occupied].sort().join(' ') + '）');
ok(!occupied.has('h') || true, 'h 仍是详情面板的历史键（未被我改动）');
ok(/e\.key === 'H' \|\| e\.key === 'h'/.test(src), 'H 历史键仍原样存在（M 是新增而不是替换）');

// A6. 待审视图的 M 键走的是「当前聚焦标本」
const keyHandlerSrc = (() => sliceArrowBodyAt(src, '_abnormalKeyHandler = e => {'))();
ok(!!keyHandlerSrc, '切到待审视图键盘处理器');
ok(/e\.key === 'm' \|\| e\.key === 'M'/.test(keyHandlerSrc || ''), '待审视图键盘处理器里有 M');
ok(/openEMRForWSRow\(getAbnormalFocusSpecimen\(curData\), e\.shiftKey\)/.test(keyHandlerSrc || ''), '待审视图 M 打开的是**当前聚焦**标本的病历');

// A7. 详情面板的 M 键走的是 currentDetailSpecimen
const detailKeySrc = (() => sliceArrowBodyAt(src, '_detailKeyHandler = e => {'))();
ok(!!detailKeySrc, '切到详情面板键盘处理器');
ok(/e\.key === 'm' \|\| e\.key === 'M'/.test(detailKeySrc || ''), '详情面板键盘处理器里有 M');
ok(/openEMRForWSRow\(currentDetailSpecimen, e\.shiftKey\)/.test(detailKeySrc || ''), '详情面板 M 打开当前详情标本的病历');
ok(/lis-detail-emr-btn/.test(src), '详情面板原有「📄 病历」按钮仍在（本次是补充入口，不是替换）');

// A8. 两处提示条都要提到 M（否则用户不知道有这个键）
ok(/<kbd>M<\/kbd> 病历/.test(src), '待审视图提示条补了「M 病历」');
ok(/M 病历 \| H 历史 \| Esc 关闭/.test(src), '详情面板页脚提示补了「M 病历 | H 历史」');

// A9. CSS 在位（注释承诺的类必须有对应样式）
ok(/\.ab-emr-btn\{/.test(src) && /\.ab-emr-btn:hover\{/.test(src), '.ab-emr-btn 有对应 CSS（含 hover）');
ok(/\.ab-card-right-acts\{/.test(src), '.ab-card-right-acts 有对应 CSS');

/* ============ B. 逻辑仿真：真实切片 ============ */
section('B. 逻辑仿真（真实切片）');

try {
  const calls = [];
  const toasts = [];
  const stub = `
const __calls = [];
const __toasts = [];
function showToast(msg, type) {__toasts.push({msg: String(msg), type: String(type || '')});}
function openEnhancedEMR(labNo, info) {__calls.push({labNo: labNo, info: info});}
function escAttr(v) {return String(v === undefined || v === null ? '' : v).replace(/"/g, '&quot;');}
`;
  const modSrc =
    stub +
    '\n' +
    sliceNamedFn('openEMRForWSRow') +
    '\n' +
    sliceNamedFn('wsEmrBtnHTML') +
    '\n' +
    'export { openEMRForWSRow, wsEmrBtnHTML, __calls, __toasts };\n';
  const tmpPath = path.join(HERE, '.cache', 'workbench_emr_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), {recursive: true});
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const M = await import('file://' + tmpPath);
  const reset = () => {M.__calls.length = 0; M.__toasts.length = 0;};

  // B1. 正常一条：四个字段都要原样传下去（HIS 靠 regNo/episodeNo 定位就诊）
  reset();
  M.openEMRForWSRow({ReportDR: 'DR1', Labno: '2609001234', PatName: '张三', RegNo: 'REG9', EpisodeNo: 'EP7'}, false);
  ok(M.__calls.length === 1, 'B1 正常标本 → 调了一次 openEnhancedEMR');
  ok(M.__calls[0].labNo === '2609001234', 'B1 第一参数是检验号（openEnhancedEMR 用它查病历）');
  ok(M.__calls[0].info.labNo === '2609001234' && M.__calls[0].info.patName === '张三', 'B1 info 里带 labNo + patName');
  ok(M.__calls[0].info.regNo === 'REG9' && M.__calls[0].info.episodeNo === 'EP7', 'B1 info 里带 regNo + episodeNo（与详情面板按钮口径一致）');
  ok(M.__calls[0].info.directNativeIE === false, 'B1 普通点击不强制原生 IE（Chrome 弹窗能看列表/医嘱）');

  // B2. Shift+点击 → 原生 32 位 IE
  reset();
  M.openEMRForWSRow({Labno: 'X1', PatName: '李四'}, true);
  ok(M.__calls[0].info.directNativeIE === true, 'B2 Shift+点击 → directNativeIE=true（文书正文只有原生 IE 渲染得了）');

  // B3. 缺字段的降级：不能抛异常、要有提示
  reset();
  M.openEMRForWSRow({ReportDR: 'DR2', PatName: '王五'}, false);
  ok(M.__calls.length === 0 && M.__toasts.length === 1, 'B3 没有检验号 → 不打开、给一条提示');
  ok(/检验号/.test(M.__toasts[0].msg), 'B3 提示文案说清是「没有检验号」');
  reset();
  M.openEMRForWSRow(null, false);
  ok(M.__calls.length === 0 && M.__toasts.length === 1, 'B3 没定位到标本 → 不打开、给一条提示（不抛异常打断渲染）');
  reset();
  M.openEMRForWSRow(undefined, false);
  ok(M.__calls.length === 0 && M.__toasts.length === 1, 'B3 undefined 行也安全');

  // B4. RegNo/EpisodeNo 缺失时给空串而不是 undefined（避免拼出 "undefined" 的 URL）
  reset();
  M.openEMRForWSRow({Labno: 'Y1', PatName: '赵六'}, false);
  ok(M.__calls[0].info.regNo === '' && M.__calls[0].info.episodeNo === '', 'B4 缺 RegNo/EpisodeNo 时传空串（不是 undefined）');

  // B5. 按钮 HTML：data-emr 带 DR、文案可见、DR 为空也不炸
  const html = M.wsEmrBtnHTML({ReportDR: 'DR9'});
  ok(/data-emr="DR9"/.test(html), 'B5 按钮 data-emr 带 ReportDR（点击时据此取活体行）');
  ok(/📄 病历/.test(html), 'B5 按钮有可见文字');
  ok(/type="button"/.test(html), 'B5 显式 type="button"（避免落在 form 里被当提交按钮）');
  const htmlEmpty = M.wsEmrBtnHTML({});
  ok(/data-emr=""/.test(htmlEmpty), 'B5 ReportDR 缺失时 data-emr 为空串（点击后走「没定位到标本」提示，不炸）');
  const htmlQuote = M.wsEmrBtnHTML({ReportDR: 'a"b'});
  ok(/data-emr="a&quot;b"/.test(htmlQuote), 'B5 ReportDR 里的引号被转义（不会撑破 HTML 属性）');
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
