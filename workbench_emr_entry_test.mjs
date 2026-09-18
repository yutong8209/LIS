/**
 * 8.17.4 / 8.17.5 回归测试：工作台直达电子病历（📄 病历 / 快捷键 M）
 *
 * 需求演进：
 *   8.17.4（用户原话）：「在待审界面的标本 能不能也直达病历系统啊 我好像没看到入口」
 *     → 把入口加到了**待审卡片**上。
 *   8.17.5（用户原话）：「打开病历的按钮可不可以加在详情页 跳过 审核此标本两个按钮的边上
 *                        不用加在样本标签里面」
 *     → 「详情页」= 待审视图的**右栏实时检视器**（底部就是「↷ 跳过 (Space)」与
 *       「✓ 审核此标本 (Enter)」）；「样本标签」= 左栏那些标本卡片。
 *       于是把按钮从卡片**挪到**检视器底部，与跳过/审核同一排；卡片恢复原样（不留死样式）。
 *
 * 不变的部分：三处入口都调同一个 `openEnhancedEMR`（取数口径 LabNo/PatName/RegNo/EpisodeNo
 * 完全一致，不会出现「一处能开、另一处开不了」），`M` 快捷键保留。
 *
 * 本测试分两部分：
 *   A. 静态不变量 —— 按钮落在**该在的那一排**、卡片上**不该**再有它、M 键只允许两处
 *                    （不与既有快捷键冲突）
 *   B. 逻辑仿真   —— 把真实的 openEMRForWSRow 切片出来跑参数与降级路径
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

/* ---------- 切片工具（与其它回归同一套） ---------- */
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
ok(verAtLeast(ver, '8.17.5'), '版本号 ≥ 8.17.5（本功能落地版本；实际 ' + ver + '）');

// A2. 取数助手在位（三处入口共用它，口径才一致）
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

// A3. 按钮落在「右栏实时检视器」底部，与「跳过 / 审核此标本」同一排
const ftActions = (() => {
  const i = src.indexOf('<div class="ws-insp-ft-actions">');
  if (i < 0) {return '';}
  const j = src.indexOf('lis-insp-btn-audit', i);
  return j < 0 ? '' : src.slice(i, src.indexOf('</div>', j));
})();
ok(!!ftActions, '切到右栏检视器底部按钮区');
ok(/class="ws-insp-btn-emr" id="lis-insp-btn-emr"/.test(ftActions), '底部按钮区里有「📄 病历」按钮');
ok(/📄 病历 \(M\)/.test(ftActions), '按钮带可见文字「📄 病历 (M)」（顺带把快捷键写在按钮上）');
const iEmrInFt = ftActions.indexOf('lis-insp-btn-emr');
const iSkipInFt = ftActions.indexOf('lis-insp-btn-skip');
const iAuditInFt = ftActions.indexOf('lis-insp-btn-audit');
ok(iEmrInFt > 0 && iSkipInFt > iEmrInFt && iAuditInFt > iSkipInFt,
  '三按钮顺序 = 病历 → 跳过 → 审核此标本（跳过与审核保持相邻，病历插在最外侧）');
ok(/Shift\+点击/.test(ftActions), 'title 里说明 Shift+点击 = 原生 IE');

// A4. 按钮已接线，且用的是当前渲染的那条标本
const inspBind = (() => {
  const i = src.indexOf("const inspEmrBtn = document.getElementById('lis-insp-btn-emr')");
  return i < 0 ? '' : src.slice(i, i + 400);
})();
ok(!!inspBind, '按钮有 getElementById 接线');
ok(/inspEmrBtn\.addEventListener\('click'/.test(inspBind), '按钮绑定了 click');
ok(/openEMRForWSRow\(specimen, e\.shiftKey\)/.test(inspBind), '点击打开**当前检视器这条**标本的病历（传 e.shiftKey 支持 Shift+点击原生 IE）');

// A5. 卡片上**不该**再有按钮（用户明确要求挪走；留着就是「说了一遍没听」）
ok(countOf(/ab-emr-btn/g) === 0, '卡片按钮的类名已彻底移除（实际 ' + countOf(/ab-emr-btn/g) + ' 处）');
ok(countOf(/ab-card-right-acts/g) === 0, '卡片右侧动作容器已移除（不留死样式/死类名）');
ok(countOf(/wsEmrBtnHTML/g) === 0, '卡片按钮助手 wsEmrBtnHTML 已移除（不留死函数）');
ok(!/\.ab-emr-btn\{/.test(src), 'CSS 里没有残留的 .ab-emr-btn 规则');

// A6. M 键：只允许两处（待审视图 + 详情面板），且不能与既有键冲突
const mKeySites = countOf(/e\.key === 'm' \|\| e\.key === 'M'/g);
ok(mKeySites === 2, 'M 键只加在待审视图与详情面板两处（实际 ' + mKeySites + ' 处）');
const occupied = new Set();
for (const m of src.matchAll(/e\.(?:key|code)\s*===?\s*'([^']+)'/g)) {occupied.add(m[1]);}
ok(occupied.has('m') && occupied.has('M'), 'M 已登记（已占用：' + [...occupied].sort().join(' ') + '）');
ok(/e\.key === 'H' \|\| e\.key === 'h'/.test(src), 'H 历史键仍原样存在（M 是新增而不是替换）');

// A7. 待审视图的 M 键走「当前聚焦标本」
const keyHandlerSrc = sliceArrowBodyAt(src, '_abnormalKeyHandler = e => {');
ok(/e\.key === 'm' \|\| e\.key === 'M'/.test(keyHandlerSrc), '待审视图键盘处理器里有 M');
ok(/openEMRForWSRow\(getAbnormalFocusSpecimen\(curData\), e\.shiftKey\)/.test(keyHandlerSrc), '待审视图 M 打开的是**当前聚焦**标本的病历');

// A8. 详情面板的 M 键走 currentDetailSpecimen，且原有按钮仍在
const detailKeySrc = sliceArrowBodyAt(src, '_detailKeyHandler = e => {');
ok(/e\.key === 'm' \|\| e\.key === 'M'/.test(detailKeySrc), '详情面板键盘处理器里有 M');
ok(/openEMRForWSRow\(currentDetailSpecimen, e\.shiftKey\)/.test(detailKeySrc), '详情面板 M 打开当前详情标本的病历');
ok(/lis-detail-emr-btn/.test(src), '详情面板原有「📄 病历」按钮仍在（本次是补充入口，不是替换）');

// A9. 三处提示都要提到 M（否则用户不知道有这个键）
ok(/<kbd>M<\/kbd> 病历/.test(src), '右栏检视器提示行补了「M 病历」');
ok(/<kbd>M<\/kbd> 病历 <kbd>1-5<\/kbd> 切分类/.test(src), '待审视图提示条也补了「M 病历」');
ok(/M 病历 \| H 历史 \| Esc 关闭/.test(src), '详情面板页脚提示补了「M 病历 | H 历史」');

// A10. CSS 在位（注释承诺的类必须有对应样式）
ok(/\.ws-insp-btn-emr\{/.test(src) && /\.ws-insp-btn-emr:hover\{/.test(src), '.ws-insp-btn-emr 有对应 CSS（含 hover）');

/* ============ B. 逻辑仿真：真实切片 ============ */
section('B. 逻辑仿真（真实切片）');

try {
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
    'export { openEMRForWSRow, __calls, __toasts };\n';
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
