/**
 * 8.16.15 回归测试：批审切组守卫（防「切组死循环」）
 *
 * 现场 bug：开自动审核时，工作台在「原生 LIS ↔ 工作台」之间不停来回切，反复提示
 * 「切换工作组后继续批审」，伴随审核失败，**手动关掉自动审核也停不下来**。
 *
 * 本测试分两部分：
 *   A. 静态不变量 —— 所有切组点都必须过守卫、tick 必须尊重熔断、stopAutoAudit 必须清理续跑队列
 *   B. 逻辑仿真   —— 把守卫函数真代码抽出来跑场景（含「正常多组批审不许被误伤」）
 *
 * 用法：node aa_switch_guard_test.mjs
 *      LIS_SRC=/tmp/old.user.js node aa_switch_guard_test.mjs   # 反向验证：旧版必须失败
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 8.16.31: 支持 LIS_SRC 指向任意版本的 userscript —— 测试写完必须拿旧版反向验证一次
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

/* ============ A. 静态不变量 ============ */
section('A. 静态不变量');

// A1. 所有切组/续跑点必须过守卫（少一处就是一个逃逸口）；注释里的示例不算
// 8.16.24: 批审起始点（ensureAuditQueueWorkGroup）已不再切组 → 守卫点由 4 处收敛到 2 处：
//   · checkAuditQueueResume（跨整页重载后的续跑入口，waiting 模式，不计数）
//   · 批审 while 内「完整选行也选不到」时的兜底切组
const guardCalls = src
  .split('\n')
  .filter(l => !l.trim().startsWith('//'))
  .filter(l => /if \(!aaQueueGuardSwitch\(/.test(l)).length;
ok(guardCalls === 2, '2 处切组/续跑点全部接入守卫（实际 ' + guardCalls + ' 处）');

/* ---- 8.16.16: 跨组判定必须用「可信登录组」，不确定就不切组 ---- */

// A14. 必须存在可信判定函数（只认原生下拉框 / LIS 全局变量）
ok(/function resolveLoginWGReliable\(\)/.test(src), '存在 resolveLoginWGReliable()（可信登录组）');
const relFn = src.slice(src.indexOf('function resolveLoginWGReliable()'), src.indexOf('function compareAuditQueueItems('));
ok(/sl_changeworkgroup/.test(relFn), '可信判定优先读原生下拉框 sl_changeworkgroup');
ok(/return '';/.test(relFn), '取不到权威值时返回空串（交给调用方按「不确定」处理）');
ok(!/wsActiveWG/.test(relFn) && !/wsData\.forEach/.test(relFn), '可信判定不再把「视图过滤组」「数据推测组」当登录组');

// A15. 四条会决定「要不要切组」的路径都必须用可信判定
ok(
  /async function ensureAuditQueueWorkGroup\(queue\) \{[\s\S]*?const curDR = String\(resolveLoginWGReliable\(\)\)/.test(src),
  'ensureAuditQueueWorkGroup 的切组决策用可信判定'
);
ok(/const curWG = resolveLoginWGReliable\(\);/.test(src), '批审 while 的 _batchCrossGroup 判定用可信判定');
const crossTrySites = [...src.matchAll(/const _wsCrossGroupTry = !!\(spDR && curDR && spDR !== curDR\);/g)].length;
ok(crossTrySites === 2, '两条单条审核路径（列表 / 详情）都用可信判定（实际 ' + crossTrySites + ' 处）');
ok(!/spDR !== resolveCurrentWG\(\)/.test(src), '切组回退条件里不再出现不可信的 resolveCurrentWG()');

// A16. 核心不变量（8.16.24 定稿）：**批审起始点绝不切组**。
// 回归根因 = 8.15.27（09-14 15:34）把起始点从 `return true`（跨组先试不切组）
// 改成「不在当前原生列表就立即切组」，而判据只是**一次** selectNativeRowByReportDR——
// 批审刚启动时原生列表还停在默认日期/上一个机台，这一步几乎必然落空，
// 于是每条跨组标本都白切一趟组（整页重载 + 重新 CA + 工作台重建）。
// 现场原话：「14 号及之前的标本审报告是不切组的，就这两天出的问题」。
const eqwgSlice = src.slice(
  src.indexOf('async function ensureAuditQueueWorkGroup(queue)'),
  src.indexOf('function runAuditQueueResume(')
);
ok(!/safeSwitchWG\(/.test(eqwgSlice), '批审起始点不再切组（不得出现 safeSwitchWG）');
ok(!/pausedForSwitch/.test(eqwgSlice), '批审起始点不再设置 pausedForSwitch（不制造整页重载）');
ok(/跨组先试免切组/.test(eqwgSlice), '起始点保留「跨组先试不切组」的语义说明');

// A17. 没有机台 DR 时也必须尝试一次免切组，而不是直接切组
ok(!/\} else if \(item\.mdr\) \{/.test(src), '免切组探测不再要求 item.mdr 存在（否则等于直接切组）');

// A19. 批审主循环里「快速探测未命中」**不得立即切组**（8.15.27 的第二个退化点）。
// 那个探测用 fast:true（只等 70ms），而 ShowWorkList 是异步查询、70ms 远未返回，
// 探测几乎必然落空 → 每条跨组标本都白切一趟组。
// 现在探测只做「抢占式命中」，未命中就落回完整选行
// （waitAndSelectNativeRow：轮询等待列表返回 + FindFast 条码兜底 + 按机台/日期刷新），
// 真的选不到才由后面的 !selectedOk 分支切组。
const probeSlice = src.slice(
  src.indexOf('if (_batchCrossGroup && !selectedOk) {'),
  src.indexOf("            progressPhase('选中标本');")
);
ok(probeSlice.length > 100, '定位到「跨组快速探测」代码段');
ok(/跨组快速探测未命中[\s\S]{0,200}?转完整选行/.test(probeSlice), '探测未命中 → 转完整选行（不再立即切组）');
ok(!/safeSwitchWG\(/.test(probeSlice), '快速探测段内不得出现 safeSwitchWG（不得立即切组）');

// A20. 8.16.25: 跨组标本必须关闭「行消失 = 审核成功」。
// 免切组审核的跨组标本**不在当前登录组的原生列表里**，findNativeRowByReportDR 对它恒返回 null，
// 于是「审核后行消失」恒成立；再叠加 softAuditSuccessHint 里「CA 已认证 + 焦点已移开」，
// 就会**无条件判成功**，把其实没审掉的标本记成已完成
// （现场：批审 2 条都提示成功、刷新后总留 1 条 → 静默漏审，最危险的一类 bug）。
// 三条审核路径全部要收敛；同组标本保持原样（行消失对它是可靠信号）。
ok(/let _auditingCrossGroup = false;/.test(src), '存在跨组审核标记（默认 false，同组行为不变）');
ok(
  /missingAsSuccess: !_itemPre4 && !_batchCrossGroup,/.test(src),
  '批审主循环：跨组标本关闭 missingAsSuccess'
);
ok(
  /missingAsSuccess: auditCtx\.allowMissingSuccess && !preStatus4 && !_auditCrossGroup,/.test(src),
  '详情/异常审核：跨组标本关闭 missingAsSuccess'
);
ok(
  /missingAsSuccess: !_salvagePre4 && !_salvageCrossGroup,/.test(src),
  '补审路径：跨组标本关闭 missingAsSuccess'
);
ok(
  /if \(!_auditingCrossGroup \|\| me\.IsSaveSuccess === true\) \{return true;\}/.test(src),
  'softAuditSuccessHint：跨组时「列表里找不到该行」必须另有 IsSaveSuccess 佐证'
);

// A18. item.wg / originWG 兜底也要用可信值（否则不可信值会被固化进队列）
ok(/wg: row\._wg \|\| resolveLoginWGReliable\(\),/.test(src), '队列条目 wg 兜底用可信判定');
ok(/originWG: resolveLoginWGReliable\(\)/.test(src), 'originWG（审完切回起始组）用可信判定');

// A2. 守卫必须检查「自动审核已关闭」—— 这是「关不掉」的直接病根
const guardFn = src.slice(src.indexOf('function aaQueueGuardSwitch('), src.indexOf('// 切组确认推进'));
ok(
  /queue\._autoMode\s*&&\s*\(_autoAuditCancelRequested\s*\|\|\s*!autoAuditEnabled\(\)\)/.test(guardFn),
  '守卫检查「自动审核已关闭 / 已取消」→ 中止'
);

// A3. 必须有上限，不能无限重试
ok(/AA_QUEUE_MAX_SWITCH\s*=\s*\d+/.test(src), '有「连续切组失败」上限常量');
ok(/AA_STUCK_SWITCH_MAX\s*=\s*\d+/.test(src), '有「同一条标本跨队列」上限常量');
ok(/queue\.switchCycles\s*>\s*AA_QUEUE_MAX_SWITCH/.test(guardFn), '单队列连续失败超限即中止');
ok(/n\s*>\s*AA_STUCK_SWITCH_MAX/.test(guardFn), '同一条标本累计超限即中止');

// A4. 跨队列计数必须落盘（自动审核每轮新建队列，内存计数会被重置）
ok(/K_AA_STUCK_SWITCH/.test(src) && /localStorage\.setItem\(K_AA_STUCK_SWITCH/.test(src), '「卡住」计数落盘（跨队列/跨页面生效）');

// A5. 切组成功必须归零，否则正常的 A→B→C 多组批审会被误伤。
// ⚠️ 8.16.31 修正：旧断言用 /aaQueueSwitchSucceeded\(queue\)/ 计数并把**函数定义行**
// （`function aaQueueSwitchSucceeded(queue) {`）也算进去，于是恒为 2、永远通过——
// 是个没有牙齿的断言。改成：排除定义行后统计真实调用点，并额外钉住
// 「调用点必须被『已到目标组』条件包住」——这正是现场「守卫计数被每轮清零 → 死循环」的根因。
ok(/function aaQueueSwitchSucceeded\(/.test(src), '存在「切组成功」归零函数');
const succeedCallSites = src
  .split('\n')
  .filter(l => !l.trim().startsWith('//'))
  .filter(l => /aaQueueSwitchSucceeded\(/.test(l) && !/function aaQueueSwitchSucceeded\(/.test(l)).length;
ok(succeedCallSites === 1, '归零调用点只有 1 处（实际 ' + succeedCallSites + ' 处）');
// ensureAuditQueueWorkGroup 不再切组，因此**只有「确认已到目标组」才允许清零**
const eqwgForReset = src.slice(
  src.indexOf('async function ensureAuditQueueWorkGroup(queue)'),
  src.indexOf('function runAuditQueueResume(')
);
ok(
  /if \(curDR && itemWg && itemWg === curDR\) \{\s*\n\s*aaQueueSwitchSucceeded\(queue\);/.test(eqwgForReset),
  'ensureAuditQueueWorkGroup 只在「已到目标组」时清零守卫计数'
);
const _resetIdx = eqwgForReset.indexOf('aaQueueSwitchSucceeded(queue);');
ok(
  _resetIdx > 0 && /if \(curDR && itemWg && itemWg === curDR\) \{/.test(eqwgForReset.slice(Math.max(0, _resetIdx - 120), _resetIdx)),
  '清零调用点紧邻「已到目标组」守卫（无该守卫 = 无条件清零 = 守卫失效）'
);

// A6. 跨整页重载的续跑入口必须过守卫（此前只看 pausedForSwitch）
const resumeFn = src.slice(src.indexOf('function checkAuditQueueResume('), src.indexOf('// 8.9.0: auditSelectedSpecimens'));
ok(/aaQueueGuardSwitch\(queue,/.test(resumeFn), 'checkAuditQueueResume（跨页续跑入口）过守卫');

// A7. stopAutoAudit 必须主动清掉落盘的续跑队列
//     注意 autoAuditEnabled 定义在 stopAutoAudit **之前**，不能用它当右边界
const stopStart = src.indexOf('function stopAutoAudit(');
const stopFn = src.slice(stopStart, stopStart + 4000);
ok(/loadAuditQueue\(\)/.test(stopFn) && /clearAuditQueue\(\)/.test(stopFn), '关闭自动审核时清掉落盘的续跑队列');
ok(/_batchAbort = true;/.test(stopFn), '关闭时无条件置 _batchAbort（切组暂停期间 _autoAuditRunning 常已复位）');
ok(/_q\._autoMode/.test(stopFn), '只清理自动模式的队列（手动 F4 批审不受影响）');

// A8. 熔断：自动审核 tick 必须在熔断期内只审当前工作组
//     （否则 tick 每 30s 新建队列重来一轮，只是把死循环节奏放慢）
const tickSlice = src.slice(src.indexOf('async function autoAuditTick()'));
ok(/aaSwitchFuseActive\(\)/.test(tickSlice), '自动审核 tick 尊重切组熔断');
ok(/_dropped\.forEach\(r => autoAuditSkipOnce\(skipped, r, '跨组标本/.test(tickSlice), '熔断期跨组标本按「留人工」记账（不静默消失）');
ok(/_fuseCur/.test(tickSlice) && /String\(r\._wg \|\| ''\) !== _fuseCur/.test(tickSlice), '熔断期只审当前工作组标本');
ok(/const _fuseCur = String\(resolveLoginWGReliable\(\)\);/.test(tickSlice), '熔断期工作组使用权威可信登录组（非视图过滤组）');

// A9. 中止提示必须是 error 类型 —— showToast 在自动审核静默期只放行 error
ok(/showToast\('⛔ 批审已中止：' \+ reason \+ tail, 'error'\)/.test(src), '中止提示用 error 级（静默期也能看到）');

/* ============ B. 逻辑仿真 ============ */
section('B. 逻辑仿真（跑真代码）');

const START = '  const AA_QUEUE_MAX_SWITCH = 3;';
const END = '  async function ensureAuditQueueWorkGroup(queue) {';
const s = src.indexOf(START);
const e = src.indexOf(END);
if (s < 0 || e < 0) {
  console.log('  ✗ 无法定位守卫代码块');
  process.exit(1);
}
const guardSrc = src.slice(s, e);

function makeSandbox() {
  const store = new Map();
  const localStorage = {
    getItem: k => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: k => store.delete(k)
  };
  const state = {enabled: true, cancelRequested: false, toast: []};
  const doc = {getElementById: () => null};
  const factory = new Function(
    'localStorage',
    'autoAuditEnabled',
    '_autoAuditCancelRequested',
    'dbg',
    'saveAuditQueueNow',
    'clearAuditQueue',
    'showToast',
    'aaStateEventAdd',
    'document',
    guardSrc +
      '\nreturn {aaQueueGuardSwitch, aaQueueForceStop, aaQueueSwitchSucceeded, aaStuckSwitchRead, aaStuckSwitchClear, aaSwitchFuseActive, K_AA_STUCK_SWITCH, K_AA_SWITCH_FUSE};'
  );
  const api = factory(
    localStorage,
    () => state.enabled,
    state.cancelRequested,
    () => {},
    () => ({written: false}),
    () => {},
    (msg, type) => state.toast.push({msg, type}),
    () => {},
    doc
  );
  api._store = store;
  api._state = state;
  return api;
}

// 场景 A：自动审核已关闭 → 第一次调用即中止（这是现场「关不掉」的那条路径）
section('B1. 自动审核已关闭 → 立即中止（现场病根）');
{
  const box = makeSandbox();
  box._state.enabled = false;
  const q = {_autoMode: true, items: [{reportDR: 'D1'}, {reportDR: 'D2'}], current: 0};
  const allowed = box.aaQueueGuardSwitch(q, 'dr:D1');
  ok(allowed === false, '守卫返回 false（不允许再切组）');
  ok(q.pausedForSwitch === undefined, 'pausedForSwitch 已被清掉');
  ok(box._state.toast.some(t => /批审已中止：自动审核已关闭/.test(t.msg) && t.type === 'error'), '明确提示「自动审核已关闭」（error 级）');
  ok(box._state.toast.some(t => /剩余 2 例/.test(t.msg)), '提示里带剩余待审数量（不让标本静默消失）');
  ok(!box._store.has('LIS_AuditQueue'), '落盘队列已清（页面重载后不会复活）');
  ok(q._aborted === true, '队列对象置 _aborted = true');
}

// 场景 B：连续切组失败 → 到上限后中止 + 置熔断
section('B2. 连续切组失败 → 上限后中止并置熔断');
{
  const box = makeSandbox();
  let q = {_autoMode: true, items: [{reportDR: 'D1'}, {reportDR: 'D2'}], current: 0};
  const r1 = box.aaQueueGuardSwitch(q, 'dr:D1');
  const r2 = box.aaQueueGuardSwitch(q, 'dr:D1');
  const r3 = box.aaQueueGuardSwitch(q, 'dr:D1');
  ok(r1 === true && r2 === true && r3 === true, '前 3 次允许尝试切组');
  ok(q.switchCycles === 3, '连续失败计数累加到 3');
  const r4 = box.aaQueueGuardSwitch(q, 'dr:D1');
  ok(r4 === false, '第 4 次（超过上限）中止');
  ok(box.aaSwitchFuseActive() === true, '已置切组熔断（自动审核不再尝试跨组批审）');
  ok(box._state.toast.some(t => /已连续尝试切换工作组 4 次仍未成功/.test(t.msg)), '中止原因说明是「切不过去」而非笼统「审核失败」');
}

// 场景 C：正常的多组批审 A→B→C 不许被误伤
section('B3. 正常跨组批审 A→B→C 不被误伤（关键，防过度拦截）');
{
  const box = makeSandbox();
  const q = {_autoMode: true, items: [{reportDR: 'A1'}, {reportDR: 'B1'}, {reportDR: 'C1'}], current: 0};
  let allAllowed = true;
  for (const dr of ['B1', 'C1']) {
    // 每次切组前过守卫
    allAllowed = allAllowed && box.aaQueueGuardSwitch(q, 'dr:' + dr) === true;
    // 切组成功、续跑时到达目标组 → 归零
    box.aaQueueSwitchSucceeded(q);
  }
  ok(allAllowed, 'A→B→C 三次切组全部放行');
  ok(q.switchCycles === 0, '每次切组成功都归零，计数不会累积');
  ok(box.aaStuckSwitchRead() === null, '没有残留「卡住」记录');
  ok(box.aaSwitchFuseActive() === false, '不会被熔断');
}

// 场景 D：同一条标本跨队列反复（自动审核每轮新建队列）也要被拦住
section('B4. 同一条标本跨队列反复切组 → 拦住（单队列计数会被重置，靠落盘计数）');
{
  const box = makeSandbox();
  let blockedAt = -1;
  for (let i = 1; i <= 5; i++) {
    // 模拟自动审核每轮新建队列：switchCycles 从小重来
    const q = {_autoMode: true, items: [{reportDR: 'SAME'}], current: 0, switchCycles: i - 1};
    if (box.aaQueueGuardSwitch(q, 'dr:SAME') === false) {
      blockedAt = i;
      break;
    }
  }
  ok(blockedAt === 4, '同一标本第 4 次仍卡住 → 中止（实际第 ' + blockedAt + ' 次）');
}

// 场景 E：waiting（只是等页面就绪）不累加「连续切组失败」
section('B5. waiting 模式不累加切组次数（但仍受「同一条标本」上限约束）');
{
  const box = makeSandbox();
  const q = {_autoMode: true, items: [{reportDR: 'W1'}], current: 0, switchCycles: 3};
  const allowed = box.aaQueueGuardSwitch(q, 'dr:W1', {waiting: true});
  ok(allowed === true, 'switchCycles 已到上限，但 waiting 不算一次切组 → 仍放行');
  ok(q.switchCycles === 3, 'switchCycles 未被改动');
}

// 场景 F：手动 F4 批审不触发熔断（不影响自动审核的跨组能力）
section('B6. 手动批审不置熔断，自动审核跨组能力不受影响');
{
  const box = makeSandbox();
  const q = {_autoMode: false, items: [{reportDR: 'M1'}], current: 0, switchCycles: 3};
  const allowed = box.aaQueueGuardSwitch(q, 'dr:M1');
  ok(allowed === false, '手动批审同样有上限保护（不会死循环）');
  ok(box.aaSwitchFuseActive() === false, '但不置熔断（不动自动审核的跨组能力）');
}

/* ============ 汇总 ============ */
console.log('\n────────────────────────────');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败项：');
  failures.forEach(f => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');
