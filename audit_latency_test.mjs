/**
 * 8.17.6 回归测试：批审 / CA 认证的延迟压缩
 *
 * 用户提问：「现在的批审报告的速度提升了很多…是不是还有提升的空间？还有就是每次 ca 认证的过程
 *            还是有些卡顿 有时候要耽误好几秒钟 你看看整个 ca 认证的过程还能不能在压榨出一些速度提升」
 *
 * 排查结论（8.16.33~8.16.36 已把「选行/预选/秒审」做到接近原生极限，剩下的浪费在两类地方）：
 *
 * A. CA 认证 —— 主因是**密钥派生风暴**：
 *    `getCryptoKey` 原来只缓存**最后一把**密钥（单槽 `_cryptoKey`/`_cryptoKeyUid`），而
 *    `caAccountsAll()` 会按「ca:用户名」**逐个账号**派生密钥解密（PBKDF2 **10 万轮**，同步阻塞主线程，
 *    单次约 50~200ms），旧单密码兜底又用 uid() 那把 → 槽位互踢，N 个账号就要 N 次派生。
 *    更糟的是 `updateCaUserBadge()`（工作台每次重绘、含 30s 自动刷新）也会走
 *    `caDefaultAccount() → caAccountsAll()` → **每 30 秒在后台烧掉 N 次 PBKDF2**。
 *    → 改成 Map 缓存（keyId → CryptoKey），每个 keyId 每次页面会话只派生一次。
 *    另外砍掉 submitOnce 里两笔固定等待（capping 已可见时的 280ms、成功轮询首轮的 150ms）。
 *
 * B. 批审 —— 四处「先盲等再校验」：原生其实已经审成功时，原实现还要白等 120~250ms 才看第一眼。
 *    改成「先校验再等」，**总等待窗口一律保持不缩水**（窗口缩了会把已审成功的标本误判成失败 →
 *    假留人工，那是医疗安全问题）。
 *
 * 本测试分两部分：
 *   A. 静态不变量 —— 先验后等的顺序、窗口不缩水、单槽缓存已被 Map 取代
 *   B. 逻辑仿真   —— 把真实 getCryptoKey 切片出来，用计数桩证明「N 个账号只派生 N 次、重复调用不再派生」
 *
 * 用法：node audit_latency_test.mjs
 *      LIS_SRC=/tmp/old.user.js node audit_latency_test.mjs   # 反向验证：旧版必须失败
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
// 取「从 needle 开始的下一段花括号块」——用于切 for 循环体
function braceAfter(source, needle) {
  const i = source.indexOf(needle);
  if (i < 0) {return null;}
  const open = source.indexOf('{', i + needle.length - 1);
  if (open < 0) {return null;}
  let depth = 0;
  for (let k = open; k < source.length; k++) {
    if (source[k] === '{') {depth++;}
    else if (source[k] === '}' && --depth === 0) {return source.slice(open, k + 1);}
  }
  return null;
}
const countOf = re => (src.match(re) || []).length;

/* ============ A. 静态不变量 ============ */
section('A. 静态不变量');

const ver = (src.match(/^\/\/ @version\s+(\S+)/m) || [])[1] || '';
ok(verAtLeast(ver, '8.17.7'), '版本号 ≥ 8.17.7（本次 CA 认证极速优化版本；实际 ' + ver + '）');

// ---------- A. CA：密钥缓存 ----------
ok(/const _cryptoKeyCache = new Map\(\)/.test(src), '密钥缓存是 Map（keyId → CryptoKey）');
ok(!/let _cryptoKey = null/.test(src) && !/let _cryptoKeyUid = null/.test(src), '旧的单槽缓存变量已删除（留着就说明还在一把把踢）');
const keyFn = sliceNamedFn('getCryptoKey');
ok(/_cryptoKeyCache\.get\(kid\)/.test(keyFn), 'getCryptoKey 先查缓存');
ok(/_cryptoKeyCache\.set\(kid, key\)/.test(keyFn), '派生后写进缓存');
ok(/iterations: 100000/.test(keyFn), 'PBKDF2 仍是 10 万轮（只缓存、不降强度）');
// 缓存键必须包含 keyId —— 否则不同账号会共用同一把密钥（安全问题）
ok(/const kid = keyId === undefined \? uid\(\) : String\(keyId\)/.test(keyFn), '缓存键仍按 keyId 区分（不会退化成同 origin 共用一把密钥）');
ok(/function warmupCAAuthInBackground\(/.test(src), '8.17.7: 存在后台空闲期预热 CA 密钥函数');
ok(/warmupCAAuthInBackground\(\)/.test(src), '8.17.7: 工作台初始化时调用了后台预热');

// ---------- A. CA：固定等待与延迟压缩 ----------
ok(/function isCappingFormVisible\(/.test(src), 'isCappingFormVisible 判定函数存在');
// ⚠️ 切片失败要记为失败项而不是让测试崩掉——跑旧版做反向验证时旧版压根没这个函数
try {
  const capFn = sliceNamedFn('isCappingFormVisible');
  ok(/getElementById\('txt_Password'\)/.test(capFn) && /Div_Caping/.test(capFn), '判定口径与 ensureCappingFormVisible 的提前返回一致（同一组元素）');
} catch (e) {
  ok(false, '切片失败：isCappingFormVisible 不存在（旧版无此实现）：' + e.message);
}
const loginImpl = sliceNamedFn('handleCALoginImpl');
ok(/if \(isCappingFormVisible\(caDoc\)\) \{/.test(loginImpl), '表单已可见时走「跳过」分支');

const capPollMatch = (loginImpl.match(/for \(let _k = 0; _k < (\d+); _k\+\+\) \{\s*\n\s*if \(isCappingFormVisible\(caDoc\)\) \{break;\}\s*\n\s*await sleep\((\d+)\);/) || []).slice(1).map(Number);
if (capPollMatch.length === 2) {
  ok(capPollMatch[0] * capPollMatch[1] >= 280, '8.17.7: 表单切换微轮询先验后等，且总窗口不缩水（' + capPollMatch[0] + '×' + capPollMatch[1] + 'ms ≥ 280ms）');
} else {
  ok(/else \{\s*\n\s*ensureCappingFormVisible\(caDoc\);\s*\n\s*await sleep\(280\);/.test(loginImpl), '280ms 只在**真的需要点切换**时才等（原来无条件等）');
}

ok(/setNativeInputValue\(pwdInput, caPwd\);[\s\S]*?await sleep\(50\);/.test(loginImpl), '8.17.7: 密码填入到点击缩短至 50ms（原 200ms）');
ok(!/await sleep\(200\);\s*\n\s*markCALoginSucceeded\(iframeWin\);\s*\n\s*await sleep\(300\);/.test(loginImpl), '8.17.7: 消除 500ms post-login 硬盲等');
ok(/if \(findVisibleCAWindow\(iframeWin\)\) \{\s*\n\s*for \(let _w = 0; _w < 4; _w\+\+\) \{\s*\n\s*if \(!findVisibleCAWindow\(iframeWin\)\) \{break;\}\s*\n\s*await sleep\(20\);/.test(loginImpl), '8.17.7: Ukey 检测到后微轮询等待原生关窗（最多 80ms，已关则 0ms）');

// 成功轮询：先校验再等待 + 总窗口不缩水
const caPoll = (() => {
  const i = loginImpl.indexOf('let sawPwdError = false;');
  return i < 0 ? '' : loginImpl.slice(i, i + 2000);
})();
ok(!!caPoll, '切到 CA 成功轮询段');
ok(caPoll.indexOf('anyCAUkeyPresent(iframeWin) || isCASessionReady(iframeWin)') < caPoll.indexOf('await sleep(100)'),
  '成功轮询：先校验再等待（原来首轮盲等 150ms）');
const caIter = (caPoll.match(/fast \? (\d+) : (\d+)/) || []).slice(1).map(Number);
ok(caIter.length === 2, '成功轮询轮数可解析（实际 ' + JSON.stringify(caIter) + '）');
// 旧窗口：80×150=12000 / 120×150=18000；新窗口必须 ≥ 旧窗口
ok(caIter[0] * 100 >= 80 * 150, '快速模式总窗口不缩水（' + caIter[0] + '×100ms ≥ 80×150ms）');
ok(caIter[1] * 100 >= 120 * 150, '常规模式总窗口不缩水（' + caIter[1] + '×100ms ≥ 120×150ms）');

// ---------- B. 批审：四处「先验后等」 + 窗口不缩水 ----------
// B1 批审主循环（continueAuditQueue 的延迟校验）
const b1 = braceAfter(src, 'for (let _dv = 0; _dv < 13; _dv++)');
ok(!!b1, '批审主循环延迟校验已改为 13 轮（6×250 → 13×120）');
ok(!!b1 && b1.indexOf('verifyAuditSucceededByReportDR') < b1.indexOf('await sleep(120)'), 'B1 先校验再等待');
ok(13 * 120 >= 6 * 250, 'B1 总窗口不缩水（13×120=1560 ≥ 6×250=1500）');

// B2 executeNativeAudit 延迟二次校验
const b2 = braceAfter(src, 'for (let _dv = 0; _dv < 5 && !abortCheck(); _dv++)');
ok(!!b2, 'executeNativeAudit 延迟二次校验已改为 5 轮（4×120 窗口）');
ok(!!b2 && b2.indexOf('verifyAuditSucceededByReportDR') < b2.indexOf('await sleep(120)'), 'B2 先校验再等待');
ok(5 * 120 >= 4 * 120, 'B2 总窗口不缩水（5×120 ≥ 4×120）');

// B3 confirmAuditEventuallyLive
const b3 = braceAfter(src, 'for (let _dv = 0; _dv < 7; _dv++)');
ok(!!b3, 'confirmAuditEventuallyLive 已改为 7 轮（6×150 窗口）');
ok(!!b3 && b3.indexOf('verifyAuditSucceededByReportDR') < b3.indexOf('await sleep(150)'), 'B3 先校验再等待');
ok(7 * 150 >= 6 * 150, 'B3 总窗口不缩水（7×150 ≥ 6×150）');

// B4 补审路径（auditOneQueueItemOnce）：退避 300/500/1000 保留，但每段之前先校验
ok(/const _verifySalvage = \(\) => \{/.test(src), '补审路径抽出 _verifySalvage 校验器');
ok(countOf(/_verifySalvage\(\)/g) === 4, '_verifySalvage 有 4 处调用（首次 + 300/500/1000 各一次；实际 ' + countOf(/_verifySalvage\(\)/g) + '）');
const b4 = (() => {
  const i = src.indexOf('const _verifySalvage = () => {');
  return i < 0 ? '' : src.slice(i, i + 900);
})();
ok(/if \(!result\) \{result = _verifySalvage\(\);\}/.test(b4), 'B4 首次校验在 300ms 盲等**之前**');
ok(/await sleep\(300\);\s*\n\s*result = _verifySalvage\(\);/.test(b4), 'B4 300ms 退避保留');
ok(/await sleep\(500\);\s*\n\s*result = _verifySalvage\(\);/.test(b4), 'B4 500ms 退避保留');
ok(/await sleep\(1000\);\s*\n\s*result = _verifySalvage\(\);/.test(b4), 'B4 1000ms 退避保留（总退避 1800ms 不变）');

// ---------- 不能为了提速把「安全窗口」砍掉 ----------
ok(/timeoutMs: caReady \? 4000 : 8000/.test(src), '补审单条超时仍是 4000/8000ms（没被顺手砍）');
ok(/timeoutMs: fast \? \(caReady \? 4500 : 7000\) : 12000/.test(src), '单条审核超时仍是 4500/7000/12000ms（没被顺手砍）');
ok(/const deadline = Date.now\(\) \+ \(fast \? 45000 : 90000\)/.test(src), 'CA 登录总截止时间仍是 45s/90s（没被顺手砍）');

/* ============ B. 逻辑仿真：真实 getCryptoKey ============ */
section('B. 逻辑仿真（真实切片）');

try {
  // 缓存声明直接从源码里取（保证测的是真实的声明，而不是测试自己补的一份）
  const cacheDecl = (src.match(/^\s*const _cryptoKeyCache = new Map\(\);$/m) || [])[0];
  if (!cacheDecl) {throw new Error('切片失败：找不到 _cryptoKeyCache 声明');}

  const stub = `
const __deriveSeeds = [];
const location = {origin: 'http://lis.test'};
const _cryptoAvailable = true;
function uid() {return 'LOGINUSER';}
const crypto = {
  subtle: {
    importKey: async (fmt, seed) => ({seed: Array.from(seed).join(',')}),
    deriveKey: async (algo, km) => {__deriveSeeds.push(km.seed); return {handle: km.seed};}
  }
};
`;
  const modSrc =
    stub + '\n' + cacheDecl + '\n' + keyFn + '\n' + 'export { getCryptoKey, __deriveSeeds };\n';
  const tmpPath = path.join(HERE, '.cache', 'audit_latency_engine.mjs');
  fs.mkdirSync(path.dirname(tmpPath), {recursive: true});
  fs.writeFileSync(tmpPath, modSrc, 'utf8');
  const M = await import('file://' + tmpPath);

  // B1. 三个不同 keyId（模拟「2 个 CA 账号 + 旧单密码兜底 uid()」）→ 只允许 3 次 PBKDF2
  const kA = await M.getCryptoKey('ca:alice');
  const kB = await M.getCryptoKey('ca:bob');
  const kU = await M.getCryptoKey();
  ok(M.__deriveSeeds.length === 3, '3 个不同 keyId → 恰好 3 次 PBKDF2 派生（实际 ' + M.__deriveSeeds.length + '）');

  // B2. 重复调用必须全部命中缓存（旧版单槽缓存这里会退化成 6 次以上）
  await M.getCryptoKey('ca:alice');
  await M.getCryptoKey('ca:bob');
  await M.getCryptoKey();
  await M.getCryptoKey('ca:alice');
  ok(M.__deriveSeeds.length === 3, '重复调用不再派生（旧版单槽缓存：每换一次 keyId 就重派一次 → 这里会变成 6 次）');

  // B3. 同一 keyId 返回同一把密钥对象（缓存真的命中了，而不是"碰巧派生次数相同"）
  ok(kA === (await M.getCryptoKey('ca:alice')), '同一 keyId 第二次调用返回同一把 key 对象');
  ok(kA !== kB && kB !== kU, '不同 keyId 得到不同密钥（没有退化成共用一把）');

  // B4. 模拟「每 30s 一次 updateCaUserBadge → caDefaultAccount → caAccountsAll」的稳态开销
  const before = M.__deriveSeeds.length;
  for (let round = 0; round < 10; round++) {
    await M.getCryptoKey('ca:alice');
    await M.getCryptoKey('ca:bob');
    await M.getCryptoKey();
  }
  ok(M.__deriveSeeds.length === before, '模拟 10 轮「30s 自动刷新」后派生次数仍为 0 新增（旧版每轮 +3 次 PBKDF2，即每 30 秒烧掉 ~150~600ms 主线程）');
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
