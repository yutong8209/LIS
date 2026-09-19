/**
 * 8.18.0 回归测试：门禁隔离 + 自动化绝缘 + 手工审核保留
 * 8.18.1 追加：E 组——① 补审轮三态返回值（`'incomplete'` 是字符串，truthy，绝不能用 `!!`，
 *   否则「被原生弹窗拦下」会被记成「补审成功」→ 漏审且工作台把该标本隐藏）；
 *   ② 漏结果审核实时监测（用 LIS 自己的完整度口径反查「已审核但结果空/不完整」的标本）。
 *
 * 核心设计（用户要求）：
 *   ① 门禁隔离：有必填项未存数据或空结果的标本，绝不进入「待审」标签，100% 锁在「不完整」（incomplete）！
 *   ② 自动化绝缘：F4 批审和自动审核机器人一律不碰这种标本。
 *      万一原生弹窗提示「您还有项目：...等必填项目未存数据，是否确定审核？」，
 *      自动化流程（F4 / 自动审核）一律主动点【取消】并按「留人工」处理，绝不点【确定】！
 *   ③ 保留手动审核：如果检验人员确实想审核不完整标本，可以在详情面板或原生页手动审核，
 *      此时原生弹窗绝不自动确认，留给检验人员手动决定【确定】或【取消】。
 *
 * 用法：node audit_completeness_guard_test.mjs
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
const idxOf = needle => src.indexOf(needle);

/* ============ A. 静态不变量 ============ */
section('A. 静态不变量与防线锚点');

const ver = (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';
ok(verAtLeast(ver, '8.18.0'), '版本号 ≥ 8.18.0（门禁隔离与绝缘防线落地版本；实际 ' + ver + '）');

// A1. 门禁分桶函数 getWSAuditBucket 严格隔离
const bucketFn = sliceNamedFn('getWSAuditBucket');
ok(/if \(cached\.hasMissingMandatory \|\| cached\.hasEmptyResults\) \{return 'incomplete';\}/.test(bucketFn),
  'getWSAuditBucket 核心卡口：缺失必填项或空结果 100% 返回 incomplete');
ok(/isSpecimenActuallyComplete\(r, cached\) && !cached\.hasEmptyResults && !cached\.hasMissingMandatory/.test(bucketFn),
  'getWSAuditBucket UNCERTAIN 待定放行分支严格检查无空项且无必填缺失');

// A2. 真实明细完整度 isSpecimenActuallyComplete
const actCompFn = sliceNamedFn('isSpecimenActuallyComplete');
ok(/if \(c && c\.items && c\.items\.length > 0\)/.test(actCompFn),
  'isSpecimenActuallyComplete 穿透检查明细项列表');
ok(/if \(c\.hasMissingMandatory \|\| c\.hasEmptyResults\) \{return false;\}/.test(actCompFn),
  'isSpecimenActuallyComplete 明细中只要有必填缺失或空结果一律返回 false（不被 IsComplete=1 蒙蔽）');

// A3. 分类器打标 buildClassificationFromItems
const classifyFn = sliceNamedFn('buildClassificationFromItems');
ok(/isMandatory: String\(\(item && \(item\.IsMandatory \|\| item\.IsRqed\)\) \|\| ''\) === '1'/.test(classifyFn),
  'buildClassificationFromItems 正确提取并固化每个项目的 isMandatory 必填标记');
ok(/const hasMissingMandatory = classifications\.some\(c => c\.isMandatory && isEmptyResultValue\(c, c\.result\)\)/.test(classifyFn),
  'buildClassificationFromItems 精确计算 hasMissingMandatory 必填项未存数据标记');
ok(/const hasEmptyResults = classifications\.some\(c => isEmptyResultValue\(c, c\.result\)\)/.test(classifyFn),
  'buildClassificationFromItems 计算 hasEmptyResults 结果为空标记');
ok(/hasEmptyResults \|\| hasMissingMandatory/.test(classifyFn),
  'buildClassificationFromItems 缺失时 overallStatus 置为 UNCERTAIN');

// A4. 原生缺项/未存数据弹窗主动取消与拦截
const clsMsgFn = sliceNamedFn('classifyNativeMessage');
ok(/等必填项目|必填项目|未存数据|您还有项目/.test(clsMsgFn), 'classifyNativeMessage 识别原生缺项文案（等必填项目/未存数据/您还有项目等）');
ok(/return 'incomplete'/.test(clsMsgFn), 'classifyNativeMessage 对缺项弹窗返回 incomplete');
ok(/indexOf\('是否'\) === -1 &&[\s\S]*indexOf\('确定要'\) === -1 &&[\s\S]*indexOf\('？'\) === -1/.test(clsMsgFn),
  'classifyNativeMessage 判定 success 时严格排除疑问/确认句（？/是否/确定要）');

const autoConfFn = sliceNamedFn('isAutoConfirmableNativeText');
ok(!/是否确定.*审核/.test(autoConfFn), 'isAutoConfirmableNativeText 彻底删除 (是否确定 + 审核) 模糊规则（原 bug 根源）');
ok(/classifyNativeMessage\(t\) === 'incomplete'/.test(autoConfFn), 'isAutoConfirmableNativeText 硬拦 incomplete 文本');
ok(/必填|未存数据|未存|未检|缺|项目|您还有/.test(autoConfFn), 'isAutoConfirmableNativeText 显式拒绝项目/缺项/未存关键词');

const closeSuccFn = sliceNamedFn('closeNativeAuditSuccessMessage');
ok(!/text\.indexOf\('审核'\) !== -1/.test(closeSuccFn), 'closeNativeAuditSuccessMessage 彻底删除 text.indexOf("审核") 匹配');
ok(/kind === 'incomplete'/.test(closeSuccFn), 'closeNativeAuditSuccessMessage 对 incomplete 弹窗特殊处理');
ok(/bText === '取消' \|\| bText === 'No' \|\| bText === '否'/.test(closeSuccFn), 'closeNativeAuditSuccessMessage 对 incomplete 弹窗主动按【取消】阻止审核');

const handleConfFn = sliceNamedFn('handleNativeMessageConfirm');
ok(/classifyNativeMessage\(infoText\) === 'incomplete'/.test(handleConfFn) || /classifyNativeMessage\(text\) === 'incomplete'/.test(handleConfFn),
  'handleNativeMessageConfirm 识别并拦截 incomplete');
ok(/return 'incomplete'/.test(handleConfFn), 'handleNativeMessageConfirm 拦截到 incomplete 时返回 incomplete');
ok(/cancelBtn/.test(handleConfFn), 'handleNativeMessageConfirm 识别到 incomplete 时主动点击【取消】');

// A5. 批审主循环拦截
const mainLoopIncomplete = (() => {
  const fnStartIdx = idxOf('async function continueAuditQueue');
  const i = src.indexOf("auditResult === 'incomplete'", fnStartIdx);
  return i < 0 ? '' : src.slice(i, i + 800);
})();
ok(!!mainLoopIncomplete, '批审主循环显式捕获 auditResult === "incomplete"');
ok(/_aaRecordQueueItem\('留人工'/.test(mainLoopIncomplete), '批审拦截到 incomplete 立即记为留人工');
ok(/showToast\(.*原生弹窗拦截.*error/.test(mainLoopIncomplete), '批审拦截到 incomplete 弹出红色告警 toast');
ok(/pushAutoAuditNotify\([\s\S]*LIS危急告警/.test(mainLoopIncomplete), '批审拦截到 incomplete 发送手机告警');

// A6. 详情面板手动审核保留
const detailAuditFn = sliceNamedFn('_auditFromDetailPanel');
ok(/if \(!isSpecimenActuallyComplete\(specimen\)\)/.test(detailAuditFn), '详情面板对不完整标本进行检查');
ok(!/if \(!isSpecimenActuallyComplete\(specimen\)\) \{[\s\S]{0,100}return;/.test(detailAuditFn),
  '详情面板手动审核对不完整标本**不直接 return 锁死**（保留人工确认通道）');

/* ============ B. 逻辑仿真：门禁隔离与完整度判定 ============ */
section('B. 逻辑仿真：门禁隔离与完整度判定');

try {
  const stub = `
let wsClassifiedCache = {};
function __setCache(c) {wsClassifiedCache = c || {};}
function isManualEntrySpecimen(row) {
  const n = String((row && (row._mn || row.MachineName)) || '');
  return /H900|手工/.test(n);
}
function isClassificationStale(row) { return false; }
function isAsteriskPlaceholderResult(r) { return r === '*' || r === '**'; }
function isH900ElectrolyteSpecimen(row) { return false; }
function isExternalWSWorkGroup(wg) { return false; }
`;
  const modSrc =
    stub + '\n' +
    sliceNamedFn('isSpecimenActuallyComplete') + '\n' +
    sliceNamedFn('getWSAuditBucket') + '\n' +
    'export { isSpecimenActuallyComplete, getWSAuditBucket, __setCache };\n';
  const tmpPath = path.join(HERE, '.cache', 'completeness_gate_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), {recursive: true});
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const M = await import('file://' + tmpPath);

  // B1. 正常完整标本（全项有结果）
  M.__setCache({
    DR_OK: {
      status: 'NORMAL',
      items: [{name: '项目A', result: '1.2'}],
      hasMissingMandatory: false,
      hasEmptyResults: false
    }
  });
  let bucket = M.getWSAuditBucket({ReportDR: 'DR_OK', IsComplete: '1'});
  let isComplete = M.isSpecimenActuallyComplete({ReportDR: 'DR_OK', IsComplete: '1'});
  ok(bucket === 'normal', 'B1 正常完整标本分桶为 normal（进入待审）');
  ok(isComplete === true, 'B1 正常完整标本判定为完整');

  // B2. 事故重现：LIS 误置 IsComplete='1'，但实际上必填项未存数据
  M.__setCache({
    DR_MISS_REQ: {
      status: 'UNCERTAIN',
      items: [
        {name: '肌钙蛋白I', result: '', isMandatory: true},
        {name: '肌红蛋白', result: '2.5', isMandatory: true}
      ],
      hasMissingMandatory: true,
      hasEmptyResults: true
    }
  });
  bucket = M.getWSAuditBucket({ReportDR: 'DR_MISS_REQ', IsComplete: '1'});
  isComplete = M.isSpecimenActuallyComplete({ReportDR: 'DR_MISS_REQ', IsComplete: '1'});
  ok(bucket === 'incomplete', 'B2 必填项未存数据：即使 LIS 误报 IsComplete=1 也死死锁在 incomplete（绝不进待审！）');
  ok(isComplete === false, 'B2 必填项未存数据：isSpecimenActuallyComplete 返回 false');

  // B3. 性激素缺项（缺 3 项）
  M.__setCache({
    DR_HORMONE: {
      status: 'UNCERTAIN',
      items: [
        {name: '雌二醇', result: '120'},
        {name: '孕酮', result: ''},
        {name: '睾酮', result: ''},
        {name: '催乳素', result: ''}
      ],
      hasMissingMandatory: false,
      hasEmptyResults: true
    }
  });
  bucket = M.getWSAuditBucket({ReportDR: 'DR_HORMONE', IsComplete: '1'});
  isComplete = M.isSpecimenActuallyComplete({ReportDR: 'DR_HORMONE', IsComplete: '1'});
  ok(bucket === 'incomplete', 'B3 存在空结果项：即使 IsComplete=1 也锁在 incomplete');
  ok(isComplete === false, 'B3 存在空结果项：isSpecimenActuallyComplete 返回 false');

  // B4. 异常完整标本（全项有结果，无缺失）
  M.__setCache({
    DR_ABN: {
      status: 'ABNORMAL',
      items: [{name: '血糖', result: '15.2'}],
      hasMissingMandatory: false,
      hasEmptyResults: false
    }
  });
  bucket = M.getWSAuditBucket({ReportDR: 'DR_ABN', IsComplete: '1'});
  isComplete = M.isSpecimenActuallyComplete({ReportDR: 'DR_ABN', IsComplete: '1'});
  ok(bucket === 'abnormal', 'B4 异常但结果完整的标本分桶为 abnormal（进入待审需人工确认）');
  ok(isComplete === true, 'B4 异常但结果完整的标本 isSpecimenActuallyComplete 为 true');

  // B5. 粗粒度 IsComplete='0' 或 '2'（自动化仪器）
  M.__setCache({
    DR_ROUGH_2: {
      status: 'UNCERTAIN',
      items: [{name: '项1', result: '1'}],
      hasMissingMandatory: false,
      hasEmptyResults: false
    }
  });
  bucket = M.getWSAuditBucket({ReportDR: 'DR_ROUGH_2', IsComplete: '2'});
  isComplete = M.isSpecimenActuallyComplete({ReportDR: 'DR_ROUGH_2', IsComplete: '2'});
  ok(bucket === 'incomplete', 'B5 IsComplete=2 自动化仪器分桶为 incomplete');
  ok(isComplete === false, 'B5 IsComplete=2 自动化仪器 isSpecimenActuallyComplete 为 false');
} catch (e) {
  ok(false, '逻辑仿真执行失败: ' + e.message);
}

/* ============ C. 逻辑仿真：原生缺项弹窗识别与防护 ============ */
section('C. 逻辑仿真：原生缺项弹窗识别与防护');

try {
  const stub = `
const _confirmAllowed = true;
function confirmTargetMatches(win) { return true; }
function dbg() {}
let _lastConfirmText = '';
let _lastConfirmClickAt = 0;
`;
  const modSrc =
    stub + '\n' +
    sliceNamedFn('classifyNativeMessage') + '\n' +
    sliceNamedFn('isAutoConfirmableNativeText') + '\n' +
    'export { classifyNativeMessage, isAutoConfirmableNativeText };\n';
  const tmpPath = path.join(HERE, '.cache', 'native_dialog_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), {recursive: true});
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const D = await import('file://' + tmpPath);

  // C1. 真实事故弹窗文案
  const TROPO_TEXT = '您还有项目：肌钙蛋白I/等必填项目未存数据，是否确定审核？';
  ok(D.classifyNativeMessage(TROPO_TEXT) === 'incomplete', 'C1 真实事故弹窗（肌钙蛋白I等必填项目未存数据）被判定为 incomplete');
  ok(D.isAutoConfirmableNativeText(TROPO_TEXT) === false, 'C1 真实事故弹窗绝对不被 isAutoConfirmableNativeText 自动确认（返回 false）');

  // C2. 性激素各类缺项变体
  const HORMONE_VARIANTS = [
    '您还有项目：促黄体生成素/等必填项目未存数据，是否确定审核？',
    '您还有项目：孕酮/等必填项目未存数据，是否确定审核？',
    '您还有项目：睾酮/雌二醇/等必填项目未存数据，是否确定审核？'
  ];
  for (const t of HORMONE_VARIANTS) {
    ok(D.classifyNativeMessage(t) === 'incomplete', 'C2 性激素变体识别为 incomplete: ' + t.slice(0, 20));
    ok(D.isAutoConfirmableNativeText(t) === false, 'C2 性激素变体不可自动确认: ' + t.slice(0, 20));
  }

  // C3. 各种缺项/未存数据通用文案
  const OTHER_INCOMPLETES = [
    '您还有项目未录入，是否确定审核？',
    '该标本存在未检项目，确定要保存并审核吗？',
    '有必填项未存数据，请确认是否审核',
    '项目未出全，是否审核？',
    '缺少检验结果，无法完成审核',
    '结果不完整，确定要审核该报告吗？',
    '结果为空，无法审核',
    '无结果，请录入后审核',
    '未检验完成，是否确定？'
  ];
  for (const t of OTHER_INCOMPLETES) {
    ok(D.classifyNativeMessage(t) === 'incomplete', 'C3 通用缺项识别为 incomplete: ' + t.slice(0, 16));
    ok(D.isAutoConfirmableNativeText(t) === false, 'C3 通用缺项不可自动确认: ' + t.slice(0, 16));
  }

  // C4. 假成功排除
  ok(D.classifyNativeMessage('审核成功？') !== 'success', 'C4 带问号的审核成功不当 success');
  ok(D.classifyNativeMessage('是否保存成功？') !== 'success', 'C4 疑问句不当 success');
  ok(D.classifyNativeMessage('确定要审核成功吗？') !== 'success', 'C4 确认提示不当 success');

  // C5. 真正成功识别
  ok(D.classifyNativeMessage('审核成功') === 'success', 'C5 真正的审核成功返回 success');
  ok(D.classifyNativeMessage('保存成功') === 'success', 'C5 保存成功返回 success');
  ok(D.classifyNativeMessage('报告保存并审核成功！') === 'success', 'C5 报告保存并审核成功返回 success');

  // C6. 允许自动确认的安全提示
  ok(D.isAutoConfirmableNativeText('结果超出参考范围，确定要审核该报告吗？') === true, 'C6 纯参考范围超标允许自动确认（既有规则保留）');
  ok(D.isAutoConfirmableNativeText('结果超出参考范围（无危急值），确定要审核该报告吗？') === true, 'C6 纯超范围且明确注明无危急值允许自动确认');
  ok(D.isAutoConfirmableNativeText('结果超出参考范围且含危急值，确定要审核该报告吗？') === false, 'C6 含危急值绝对不自动确认');
} catch (e) {
  ok(false, '弹窗逻辑仿真执行失败: ' + e.message);
}

/* ============ E. 8.18.1：补审轮三态返回值 + 漏结果审核实时监测 ============ */
section('E. 补审轮三态返回值 + 漏审实时监测（8.18.1）');

// E1. 补审轮必须用 `result === true`——'incomplete' 是字符串（truthy），用 !! 会把「被拦下」记成「成功」
try {
  const salvage = sliceNamedFn('auditOneQueueItemOnce');
  ok(/return \{ ok: result === true, iframeWin \}/.test(salvage), 'E1 补审轮返回 `ok: result === true`（三态判定，不用 !!）');
  ok(!/ok: !!result/.test(src), "E1 全脚本已无 `ok: !!result`（!!'incomplete' 会把被拦下误记成补审成功）");
} catch (e) {
  ok(false, 'E1 切片失败：' + e.message);
}

// E2. 监测查询用原生同款口径：P5=^<type>、P0 全部状态、走 QryWorkList
try {
  const q = sliceNamedFn('loadWLByCompleteness');
  ok(/p\.set\('P5', '\^' \+ type\)/.test(q), "E2 完整度过滤走 P5='^<type>'（与原生 SearchByResultType 同口径）");
  ok(/p\.set\('P0', ''\)/.test(q), 'E2 P0 为空 = 查全部状态（含已审核，这是能抓到漏审的关键）');
  ok(/QueryName', 'QryWorkList'/.test(q), 'E2 用 QryWorkList 接口（与原生 ShowWorkList 同一个）');
} catch (e) {
  ok(false, 'E2 切片失败：' + e.message);
}

// E3. 本地复核 + fail-silent：拿不到数据返回 null（绝不返回空数组假装「没问题」）
try {
  const scan = sliceNamedFn('scanAuditedIncompleteLeak');
  ok(/ic === '0' \|\| ic === '2'/.test(scan), "E3 只认 IsComplete '0'（结果空）/'2'（不完整）");
  ok(/&& st === '3'/.test(scan), "E3 只认 Status '3' 已审核（不认 '4' 复查——那是待复审）");
  ok(/if \(!gotData\) \{return null;\}/.test(scan), 'E3 两次查询都失败 → 返回 null（不下结论，不误报「没问题」）');
  ok(/for \(const type of \['0', '2'\]\)/.test(scan), 'E3 同时扫「结果空」与「不完整」两类');
} catch (e) {
  ok(false, 'E3 切片失败：' + e.message);
}

// E4. 只告警、绝不干预审核（不得接进任何闸门 / 放行判定）
try {
  // ⚠️ 必须先剥行注释——我的注释里会引用闸门函数名（如「见 getWSAuditBucket 的 8.5.50 口径」），
  // 不剥的话断言会命中注释造成假失败。
  const both = (sliceNamedFn('scanAuditedIncompleteLeak') + sliceNamedFn('runAuditLeakCheck')).replace(
    /^\s*\/\/.*$/gm,
    ''
  );
  ok(
    !/requeueAuditItem|isSpecimenActuallyComplete|getWSAuditBucket/.test(both),
    'E4 监测模块不触碰任何审核闸门/放行判定（纯告警，不改审核行为）'
  );
  ok(!/return 'incomplete'/.test(both), 'E4 监测模块不返回闸门用的 incomplete 值');
  ok(/pushAutoAuditNotify/.test(both), 'E4 命中时推送到手机（LIS危急告警）');
} catch (e) {
  ok(false, 'E4 切片失败：' + e.message);
}

// E5. 去重、节流与触发点
ok(/auditLeakSeen: 'LIS_AuditLeakSeen'/.test(src), 'E5 已告警去重键 LIS_AuditLeakSeen（同一标本不反复轰炸）');
ok(/unsafeWindow\.lisScanAuditLeak = /.test(src), 'E5 现场入口 lisScanAuditLeak()（控制台可手动扫）');
ok(/runAuditLeakCheck\(\{ force: true \}\)/.test(src), 'E5 批审收尾强制扫一次（force 绕过节流，延迟等落库）');
ok(/runAuditLeakCheck\(\)\.catch/.test(src), 'E5 工作台分类完成后顺带扫（带节流，失败静默）');
ok(/AUDIT_LEAK_THROTTLE_MS = 3 \* 60 \* 1000/.test(src), 'E5 节流 3 分钟（克制请求量，别拖慢 LIS）');

/* ============ 汇总 ============ */
console.log('\n────────────────────────────');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
if (fail === 0) {
  console.log('全部通过 ✅');
  process.exit(0);
} else {
  console.log('失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
