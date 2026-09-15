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
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = path.join(HERE, 'iMedicalLIS-enhancer.user.js');
const src = fs.readFileSync(SRC_PATH, 'utf8');

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

// A1. 五处切组/续跑点必须全部过守卫（少一处就是一个逃逸口）；注释里的示例不算
const guardCalls = src
  .split('\n')
  .filter(l => !l.trim().startsWith('//'))
  .filter(l => /if \(!aaQueueGuardSwitch\(/.test(l)).length;
ok(guardCalls === 5, '5 处切组/续跑点全部接入守卫（实际 ' + guardCalls + ' 处）');

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

// A5. 切组成功必须归零，否则正常的 A→B→C 多组批审会被误伤
ok(/function aaQueueSwitchSucceeded\(/.test(src), '存在「切组成功」归零函数');
const succeedCalls = [...src.matchAll(/aaQueueSwitchSucceeded\(queue\)/g)].length;
ok(succeedCalls >= 2, '「无需切组」的两条路径都归零（实际 ' + succeedCalls + ' 处）');

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
