#!/usr/bin/env node
/**
 * 8.16.32 回归：原生工作列表「虚拟滚动窗口」导致排在末尾的标本选不中 → 静默漏审
 *
 * 现场：三个标本（生化组正常 CRP + 免疫组异常铁蛋白/AFP），多数情况三条都能审掉，
 * 偶发只剩 CRP 未审；切回原生 LIS 发现该行**根本没被选中**。当天生化组 100+ 条，
 * CRP 排在列表最后。
 *
 * 已核实的原生事实（全部来自 cache/ 里的真实前端代码，非推断）：
 *   · jsLisReportResultInitM.js:1774  view:scrollview  （1764 的 pagination 是注释）
 *   · jsLisReportResultInitM.js:206/1765  pageSize = me.WorkListPageSize
 *   · jsLisReportResultM.js:3874-3880     未维护默认 100；维护为 "0" 则 2000
 *   · datagrid-scrollview.js:393-397      state.data.rows = [index 个 {} 占位].concat(窗口)
 *   · datagrid-scrollview.js:334          getRows 只切 firstRows.slice(index, index+pageSize)
 *   · jquery.easyui.min.js  getRows/getData 返回的正是这个被覆盖过的数组
 *   · jquery.easyui.min.js  _591(selectRow) 先清空选中，再按 finder.getRow 取行
 *   · jsLisReportResultInitM.js:1936-1943 原生自己「先 scrollTop(25*index) 再 selectRow」
 *
 * 本测试做两件事：
 *   A. **执行真实 datagrid-scrollview.js 的 getRows/populate**，证明窗口只有 pageSize 行、
 *      窗口外的索引在 state.data.rows 里是 undefined —— 不重写逻辑去测副本。
 *   B. 切出真实 userscript 的选行/等待/详情判定函数，用与 A 同形的 grid 状态驱动：
 *      · 旧版：目标在窗口外 → 恒选不中（漏审复现）
 *      · 新版：能从完整列表定位真实行号、驱动原生滚动、下一轮命中
 *      · 新版：选行没真正生效时必须返回 false（不得谎报「已选中」）
 *      · 新版：详情身份不符（text_MajorConclusion.name）不算就绪
 *      · 新版：目标已在完整列表时不得重发全量查询；skipListRefresh 必须被尊重
 *
 * 反向验证（必做）：拿旧版源码跑同一套断言必须失败
 *   cd ~/脚本 && git show HEAD:iMedicalLIS-enhancer.user.js > /tmp/old.user.js
 *   LIS_SRC=/tmp/old.user.js node native_worklist_window_test.mjs   # 应失败
 *
 * 用法：node native_worklist_window_test.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC_PATH = process.env.LIS_SRC || path.join(HERE, 'iMedicalLIS-enhancer.user.js');
const SCROLLVIEW_PATH = path.join(
  HERE,
  'cache/js/iMedicalLIS/resource/easyUI/datagrid-scrollview.js'
);
const src = fs.readFileSync(SRC_PATH, 'utf8');
const scrollSrc = fs.readFileSync(SCROLLVIEW_PATH, 'utf8');

let pass = 0;
let fail = 0;
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
function eq(actual, expected, label) {
  ok(actual === expected, label + '（实际 ' + JSON.stringify(actual) + '）');
}

console.log('源码: ' + SRC_PATH);
console.log('原生滚动视图: ' + SCROLLVIEW_PATH);

/* ================= 切片工具（按花括号配平，不写死行号） ================= */
function braceSlice(source, startIdx, label) {
  // 先跳过参数表——签名里可能有默认值对象（如 options = {}），
  // 直接找第一个 '{' 会命中它、导致切片在参数表处就提前结束（踩过）。
  const pOpen = source.indexOf('(', startIdx);
  if (pOpen < 0) {
    return null;
  }
  let pdepth = 0;
  let pEnd = -1;
  for (let i = pOpen; i < source.length; i++) {
    const c = source[i];
    if (c === '(') {
      pdepth++;
    } else if (c === ')') {
      pdepth--;
      if (pdepth === 0) {
        pEnd = i;
        break;
      }
    }
  }
  if (pEnd < 0) {
    console.log('  ! 切片失败（参数表不配平）: ' + label);
    return null;
  }
  const open = source.indexOf('{', pEnd);
  if (open < 0) {
    return null;
  }
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '{') {
      depth++;
    } else if (c === '}') {
      depth--;
      if (depth === 0) {
        return source.slice(startIdx, i + 1);
      }
    }
  }
  console.log('  ! 切片失败（花括号不配平）: ' + label);
  return null;
}
// userscript 里缩进 2 空格
function sliceFunction(source, name) {
  const m = new RegExp('^  (?:async )?function ' + name + '\\s*\\(', 'm').exec(source);
  return m ? braceSlice(source, m.index, name) : null;
}
// datagrid-scrollview.js 的方法缩进 4 空格
function sliceViewMethod(source, name) {
  const m = new RegExp('^    ' + name + ': function \\(', 'm').exec(source);
  return m ? braceSlice(source, m.index, name) : null;
}

/* ================= A. 执行真实 scrollview：证明「窗口」语义 ================= */
section('A. 真实 datagrid-scrollview.js：getRows/populate 只保留渲染窗口');

const getRowsSrc = sliceViewMethod(scrollSrc, 'getRows');
const populateSrc = sliceViewMethod(scrollSrc, 'populate');
ok(!!getRowsSrc, '切出真实 getRows');
ok(!!populateSrc, '切出真实 populate');
ok(
  /state\.data\.firstRows\.slice\(index, index \+ opts\.pageSize\)/.test(getRowsSrc || ''),
  '真实 getRows 只从 firstRows 切「一页」'
);
ok(
  /state\.data\.rows = r\.concat\(this\.rows\)/.test(populateSrc || ''),
  '真实 populate 会用窗口覆盖 state.data.rows'
);

const ROW_H = 25;

// 用真实 getRows/populate 构造一个 view（只补最小桩，逻辑不重写）
function makeRealScrollviewView(total, pageSize, viewportH) {
  const firstRows = [];
  for (let i = 0; i < total; i++) {
    firstRows.push({ ReportDR: 'DR' + i, Labno: 'LAB' + i, PatName: 'P' + i });
  }
  const chain = {add: () => chain, children: () => chain, css: () => chain};
  const state = {
    data: {total: total, firstRows: firstRows, rows: []},
    options: {
      pageSize: pageSize,
      onBeforeFetch: () => true,
      onFetch: () => {},
      onLoadSuccess: () => {},
      loader: () => false
    },
    dc: {body1: chain, body2: chain, view2: chain}
  };
  const view = {
    index: 0,
    rows: [],
    r1: [],
    r2: [],
    render: () => {},
    // 真实实现（从原生文件切出，非重写）
    getRows: null,
    populate: null
  };
  const target = {};
  const sandbox = {
    $: {
      data: (t, k) => (k === 'datagrid' ? state : undefined),
      extend: Object.assign,
      fn: {datagrid: {defaults: {view: {}}}}
    }
  };
  vm.createContext(sandbox);
  vm.runInContext('var __view = {};', sandbox);
  vm.runInContext('__view.getRows = ' + getRowsSrc.replace(/^    getRows: /, '') + ';', sandbox);
  vm.runInContext('__view.populate = ' + populateSrc.replace(/^    populate: /, '') + ';', sandbox);
  view.getRows = sandbox.__view.getRows;
  view.populate = sandbox.__view.populate;
  // 真实 populate 会调用 opts.view.render.call(opts.view, ...)：把 view 挂回去
  state.options.view = view;
  // 让真实 getRows 里的 opts.onLoadSuccess/onFetch 可用
  return {view, state, target, firstRows};
}

// 模拟一次「loadData → onBeforeRender → 首页渲染」：firstRows 已就绪，渲染第 1 页
function renderFirstPage(env) {
  const {view, state, target} = env;
  view.getRows.call(view, target, 1, function (rows) {
    view.index = 0;
    view.rows = rows;
    view.r1 = rows;
    view.r2 = [];
    view.populate.call(view, target);
  });
}

{
  const TOTAL = 107; // 现场：生化 100+ 条
  const PAGE = 100; // WorkListPageSize 未维护时的默认值
  const env = makeRealScrollviewView(TOTAL, PAGE, 400);
  renderFirstPage(env);
  const rows = env.state.data.rows;
  eq(rows.length, PAGE, '真实 populate 后 state.data.rows 只有一页（100 行）');
  eq(rows[106], undefined, '索引 106（末尾那条 CRP）在窗口外 → undefined');
  eq(rows[99] && rows[99].ReportDR, 'DR99', '窗口内最后一行仍是真实行');
  eq(env.state.data.firstRows.length, TOTAL, '完整数据仍在 firstRows（107 行）');
}

/* ================= 真实 grid 状态模型（形状与 A 完全一致） ================= */
function makeFakeGrid(opts) {
  const firstRows = opts.firstRows;
  const pageSize = opts.pageSize;
  const viewportH = opts.viewportH || 400;
  const domClickSelects = opts.domClickSelects !== false;
  const selectRowWorks = opts.selectRowWorks !== false;
  const state = {
    data: {total: firstRows.length, firstRows: firstRows.slice(), rows: []},
    selectedRows: [],
    options: {pageSize: pageSize, singleSelect: true}
  };
  const view = {index: 0, rows: [], r1: [], r2: []};
  let scrollTopVal = 0;
  const stats = {scrollTopCalls: 0, lastScrollTop: 0, domClicks: 0, selectRowCalls: 0, clearSelections: 0};
  const contentHeight = () => state.data.total * ROW_H;
  const maxScroll = () => Math.max(0, contentHeight() - viewportH);

  function populate() {
    const r = [];
    for (let i = 0; i < view.index; i++) {
      r.push({});
    }
    state.data.rows = r.concat(view.rows);
  }
  function loadPage(page) {
    const index = (page - 1) * pageSize;
    const rows = state.data.firstRows.slice(index, index + pageSize);
    if (!rows.length) {
      return false;
    }
    view.index = index;
    view.rows = rows;
    view.r1 = rows;
    view.r2 = [];
    populate();
    return true;
  }
  function reload() {
    loadPage(Math.floor(Math.floor(scrollTopVal / ROW_H) / pageSize) + 1);
  }
  // 忠实复刻 datagrid-scrollview.js:221-265 的 scrolling()
  // （headerHeight 记为 0：它只给 top/bottom 加同一个常数偏移，不影响分支走向）
  function scrolling() {
    if (!view.rows.length) {
      reload();
      return;
    }
    const firstTop = view.index * ROW_H - scrollTopVal;
    const lastTop = (view.index + view.rows.length - 1) * ROW_H - scrollTopVal;
    const top = firstTop;
    const bottom = lastTop + ROW_H;
    if (top > viewportH || bottom < 0) {
      reload();
      return;
    }
    if (top > 0) {
      return; // 上一页分支，本用例不涉及
    }
    if (bottom < viewportH) {
      let page = Math.floor(view.index / pageSize) + 2;
      if (view.r2.length) {
        page++;
      }
      const index = (page - 1) * pageSize;
      const rows = state.data.firstRows.slice(index, index + pageSize);
      if (rows.length) {
        if (!view.r2.length) {
          view.r2 = rows;
        } else {
          view.r1 = view.r2;
          view.r2 = rows;
          view.index += pageSize;
        }
        view.rows = view.r1.concat(view.r2);
        populate();
      }
    }
  }
  function selectRow(idx) {
    stats.selectRowCalls++;
    // 原生 _591：singleSelect 先清空选中，再用 finder.getRow 取行（窗口外取不到 → 选中为空）
    state.selectedRows = [];
    if (!selectRowWorks) {
      return;
    }
    const row = state.data.rows[idx];
    if (row && row.ReportDR) {
      state.selectedRows = [row];
    }
  }
  // 首次渲染第 1 页
  loadPage(1);

  const bodyEl = {
    0: {scrollHeight: contentHeight(), clientHeight: viewportH},
    length: 1,
    scrollTop: function (v) {
      if (v === undefined) {
        return scrollTopVal;
      }
      stats.scrollTopCalls++;
      scrollTopVal = Math.max(0, Math.min(v, maxScroll()));
      stats.lastScrollTop = scrollTopVal;
      scrolling();
      return bodyEl;
    }
  };
  const gridEl = {
    0: {},
    length: 1,
    datagrid: function (method, arg) {
      switch (method) {
        case 'getData':
          return state.data;
        case 'getRows':
          return state.data.rows;
        case 'options':
          return state.options;
        case 'getSelected':
          return state.selectedRows.length ? state.selectedRows[0] : null;
        case 'selectRow':
          selectRow(arg);
          return gridEl;
        case 'clearSelections':
          stats.clearSelections++;
          state.selectedRows = [];
          return gridEl;
        default:
          return undefined;
      }
    },
    closest: () => containerEl
  };
  const bodyColl = {
    length: 1,
    eq: () => bodyEl,
    find: () => ({length: 0, each: () => {}, trigger: () => {}, hasClass: () => false})
  };
  const view2El = {length: 1, find: () => bodyColl};
  const containerEl = {length: 1, find: (sel) => (sel === '.datagrid-view2' ? view2El : bodyColl)};
  // DOM 点击路径：只有**已渲染**的行才有对应 tr
  const domRows = {
    length: 0,
    each: () => {},
    trigger: () => {},
    hasClass: () => false
  };
  bodyColl.find = (sel) => {
    const m = /datagrid-row-index="(\d+)"/.exec(sel);
    if (m) {
      const idx = parseInt(m[1], 10);
      const rendered = idx >= view.index && idx < view.index + view.rows.length;
      if (!rendered) {
        return {length: 0, trigger: () => {}, hasClass: () => false, each: () => {}};
      }
      return {
        length: 1,
        hasClass: () => false,
        each: () => {},
        trigger: (ev) => {
          if (ev === 'click') {
            stats.domClicks++;
            if (domClickSelects) {
              selectRow(idx);
            }
          }
          return this;
        }
      };
    }
    return domRows;
  };
  return {state, view, gridEl, bodyEl, stats, firstRows};
}

function makeRows(total) {
  const rows = [];
  for (let i = 0; i < total; i++) {
    rows.push({ReportDR: 'DR' + i, Labno: 'LAB' + i, PatName: 'P' + i});
  }
  return rows;
}

/* ================= 切出真实 userscript 函数 ================= */
const fnSelect = sliceFunction(src, 'selectNativeRowByReportDR');
const fnWait = sliceFunction(src, 'waitAndSelectNativeRow');
const fnFullRows = sliceFunction(src, 'nativeWorkListFullRows');
const fnScrollBody = sliceFunction(src, 'nativeWorkListScrollBody');
const fnWindowHas = sliceFunction(src, 'nativeWindowHasRow');
const fnScrollTo = sliceFunction(src, 'scrollNativeWorkListToIndex');
const fnSelectedDR = sliceFunction(src, 'nativeWorkListSelectedDR');
const fnDetailLoaded = sliceFunction(src, 'isReportDetailLoaded');

const NATIVE_SEL = '#dgWorkList';

function makeSelectSandbox(gridEnv, opts = {}) {
  const dbgLines = [];
  const iframeWin = {
    jQuery: null,
    me: {selectedGrid: null, curReportDR: ''}
  };
  const jq = (sel) => {
    if (sel === NATIVE_SEL) {
      return gridEnv.gridEl;
    }
    return {length: 0, datagrid: () => undefined, attr: () => undefined};
  };
  iframeWin.jQuery = jq;
  iframeWin.$ = jq;
  const sandbox = {
    console,
    NATIVE_WORKLIST_SEL: NATIVE_SEL,
    DATAGRID_SELECTORS: [NATIVE_SEL],
    dbg: (...a) => dbgLines.push(a.join(' ')),
    installNativeDetailGuard: () => {},
    canScriptSelectNativeRow: () => (opts.userLocked ? false : true),
    isReportDetailLoaded: () => (opts.detailLoaded === undefined ? true : opts.detailLoaded),
    getReportIframeWin: () => iframeWin
  };
  vm.createContext(sandbox);
  const parts = [fnFullRows, fnScrollBody, fnWindowHas, fnScrollTo, fnSelectedDR, fnSelect].filter(Boolean);
  if (parts.length !== 6) {
    return null; // 旧版没有这些函数 → 交给调用方报失败
  }
  vm.runInContext(parts.join('\n'), sandbox);
  sandbox.__iframeWin = iframeWin;
  sandbox.__dbg = dbgLines;
  return sandbox;
}

function runSelect(sandbox, reportDR, options) {
  sandbox.__dr = reportDR;
  sandbox.__opts = options || {};
  return vm.runInContext(
    'selectNativeRowByReportDR(__iframeWin, __dr, __opts)',
    sandbox
  );
}

/* ================= B. 旧版复现 / 新版修复 ================= */
section('B. 窗口外的末尾标本：旧版恒选不中，新版能滚出来并选中');

{
  ok(!!fnSelect, '切出真实 selectNativeRowByReportDR');
  const hasNewHelpers = !!(fnFullRows && fnScrollBody && fnWindowHas && fnScrollTo && fnSelectedDR);
  ok(hasNewHelpers, '新版存在「完整列表 / 渲染窗口 / 选行生效」四个辅助函数（旧版没有 → 反向验证会失败）');

  if (hasNewHelpers) {
    const TOTAL = 107;
    const PAGE = 100;
    const target = 'DR106'; // 末尾那条正常 CRP

    // —— B1：窗口只覆盖 0..99，第一轮必然选不中 ——
    const env1 = makeFakeGrid({firstRows: makeRows(TOTAL), pageSize: PAGE});
    eq(env1.state.data.rows.length, 100, '初始渲染窗口只有 100 行');
    eq(env1.state.data.rows[106], undefined, '目标索引 106 不在渲染窗口内');
    const box1 = makeSelectSandbox(env1);
    const r1 = runSelect(box1, target);
    eq(r1, false, '第一轮返回 false（未渲染时不得谎报选中）');
    ok(env1.stats.scrollTopCalls > 0, '已驱动原生滚动把该页滚出来（原生 InitM:1937 的做法）');
    ok(
      box1.__dbg.some((l) => /目标在渲染窗口外/.test(l) && /107/.test(l)),
      '诊断日志说明了「在窗口外 + 完整列表行数」'
    );
    eq(env1.state.data.rows[106] && env1.state.data.rows[106].ReportDR, target, '滚动后窗口已覆盖索引 106');
    eq(env1.state.selectedRows.length, 0, '第一轮没有产生任何选中（与现场「切回原生没选中」一致）');

    // —— B2：下一轮（滚动 populate 落地后）必须命中 ——
    const r2 = runSelect(box1, target);
    eq(r2, true, '第二轮返回 true（已真正选中）');
    eq(env1.state.selectedRows.length, 1, '原生网格确实有选中行');
    eq(env1.state.selectedRows[0].ReportDR, target, '选中的正是目标标本（不是别的行）');
  }

  // —— B3：旧版行为对照（新版逻辑下模拟「不做完整列表查找」的后果）——
  const envOld = makeFakeGrid({firstRows: makeRows(107), pageSize: 100});
  const inWindow = envOld.state.data.rows.some((r) => r && r.ReportDR === 'DR106');
  eq(inWindow, false, '旧版唯一的数据源（getRows 窗口）里根本没有目标 → 必然 continue/return false');
}

section('C. 选行没真正生效时：能补救则补救，补不救必须返回 false（不得谎报成功）');

{
  const hasNewHelpers = !!(fnFullRows && fnSelectedDR);
  if (hasNewHelpers) {
    // C1：DOM 点击没产生选中（原生点击被吞/竞态），但 selectRow 可用 → 必须靠回退真正选中
    const envC1 = makeFakeGrid({firstRows: makeRows(5), pageSize: 100, domClickSelects: false});
    const boxC1 = makeSelectSandbox(envC1);
    const rC1 = runSelect(boxC1, 'DR3');
    eq(rC1, true, 'C1 回退 selectRow 后返回 true');
    eq(
      envC1.state.selectedRows.length === 1 ? envC1.state.selectedRows[0].ReportDR : '',
      'DR3',
      'C1 网格里确实选中了目标（旧版此处只有「点击过」的假成功，实际没有任何选中）'
    );
    ok(envC1.stats.selectRowCalls > 0, 'C1 已尝试 selectRow 回退');

    // C2：DOM 点击与 selectRow 都选不上（窗口外/原生守卫）→ 必须返回 false
    const envC2 = makeFakeGrid({
      firstRows: makeRows(5),
      pageSize: 100,
      domClickSelects: false,
      selectRowWorks: false
    });
    const boxC2 = makeSelectSandbox(envC2);
    const rC2 = runSelect(boxC2, 'DR3');
    eq(rC2, false, 'C2 选行未生效 → 返回 false（旧版此处返回 true，会直接去点审核按钮）');
    ok(
      boxC2.__dbg.some((l) => /选行未生效/.test(l) && /目标未成为原生选中行/.test(l)),
      'C2 诊断日志明确指出「目标未成为原生选中行」'
    );
    eq(envC2.state.selectedRows.length, 0, 'C2 网格里没有任何选中（与现场现象一致）');
  } else {
    ok(false, '缺少选行生效校验（旧版）');
  }
}

section('D. 详情身份校验：不得把上一条标本的残留详情当成目标已就绪');

{
  ok(!!fnDetailLoaded, '切出真实 isReportDetailLoaded');
  if (fnDetailLoaded) {
    function makeDetailSandbox({majorConclusionName, leftRows, selectedDR, curReportDR}) {
      const iframeWin = {
        me: {
          curReportDR: curReportDR,
          selectedGrid: {datagrid: () => (selectedDR ? {ReportDR: selectedDR} : null)}
        }
      };
      const jq = (sel) => {
        if (sel === '#dgLeftReportItem') {
          return {length: 1, datagrid: () => leftRows};
        }
        if (sel === '#dgRightReportItem') {
          return {length: 0, datagrid: () => []};
        }
        if (sel === '#text_MajorConclusion') {
          return {length: 1, attr: () => majorConclusionName};
        }
        return {length: 0, datagrid: () => [], attr: () => undefined};
      };
      iframeWin.jQuery = jq;
      iframeWin.$ = jq;
      const sandbox = {
        console,
        dbg: () => {},
        nativeDetailRowsHaveResults: () => true
      };
      vm.createContext(sandbox);
      vm.runInContext(fnDetailLoaded, sandbox);
      sandbox.__w = iframeWin;
      return sandbox;
    }
    const detailRow = [{CName: 'CRP', result: '3.2'}];

    const stale = makeDetailSandbox({
      majorConclusionName: 'DR-OTHER',
      leftRows: detailRow,
      selectedDR: 'DR-TARGET',
      curReportDR: 'DR-TARGET'
    });
    eq(
      vm.runInContext("isReportDetailLoaded(__w, 'DR-TARGET')", stale),
      false,
      '原生详情标记指向别的报告 → 不算就绪（fail-closed）'
    );

    const fresh = makeDetailSandbox({
      majorConclusionName: 'DR-TARGET',
      leftRows: detailRow,
      selectedDR: 'DR-TARGET',
      curReportDR: 'DR-TARGET'
    });
    eq(
      vm.runInContext("isReportDetailLoaded(__w, 'DR-TARGET')", fresh),
      true,
      '原生详情标记与目标一致 → 判定就绪'
    );

    const unknown = makeDetailSandbox({
      majorConclusionName: undefined,
      leftRows: detailRow,
      selectedDR: 'DR-TARGET',
      curReportDR: 'DR-TARGET'
    });
    eq(
      vm.runInContext("isReportDetailLoaded(__w, 'DR-TARGET')", unknown),
      true,
      '原生标记为空（本页还没加载过详情）→ 保持原有判据，不额外判否'
    );
  }
}

section('E. waitAndSelectNativeRow：目标在完整列表时不得重发全量查询；skipListRefresh 必须被尊重');

{
  ok(!!fnWait, '切出真实 waitAndSelectNativeRow');
  if (fnWait && fnFullRows) {
    function makeWaitSandbox(gridEnv, opts = {}) {
      const iframeWin = {
        jQuery: null,
        me: {selectedGrid: null, curReportDR: ''},
        ShowWorkList: () => {
          stats.refreshCalls++;
        },
        FindFast: () => {
          stats.findFastCalls++;
        }
      };
      const stats = {refreshCalls: 0, findFastCalls: 0};
      const jq = (sel) => {
        if (sel === NATIVE_SEL) {
          return gridEnv.gridEl;
        }
        return {length: 0, datagrid: () => undefined};
      };
      iframeWin.jQuery = jq;
      iframeWin.$ = jq;
      const sandbox = {
        console,
        NATIVE_WORKLIST_SEL: NATIVE_SEL,
        DATAGRID_SELECTORS: [NATIVE_SEL],
        dbg: () => {},
        sleep: (ms) => new Promise((r) => setTimeout(r, opts.realSleep ? ms : 0)),
        installNativeDetailGuard: () => {},
        canScriptSelectNativeRow: () => true,
        isReportDetailLoaded: () => true,
        getReportIframeWin: () => iframeWin,
        refreshNativeWorkListForItem: () => {
          stats.refreshCalls++;
          return iframeWin;
        }
      };
      vm.createContext(sandbox);
      const parts = [fnFullRows, fnScrollBody, fnWindowHas, fnScrollTo, fnSelectedDR, fnSelect, fnWait].filter(
        Boolean
      );
      if (parts.length !== 7) {
        return null;
      }
      vm.runInContext(parts.join('\n'), sandbox);
      sandbox.__iframeWin = iframeWin;
      sandbox.__stats = stats;
      return sandbox;
    }

    // E1：目标在完整列表里（只是排在窗口外）→ 不得重发 ShowWorkList 全量查询
    const envE1 = makeFakeGrid({firstRows: makeRows(107), pageSize: 100});
    const boxE1 = makeWaitSandbox(envE1);
    boxE1.__item = {reportDR: 'DR106', labno: 'LAB106', mdr: 'MDR1'};
    const rE1 = await vm.runInContext(
      'waitAndSelectNativeRow(__iframeWin, __item, {timeoutMs: 500, pollMs: 10, skipListRefresh: true})',
      boxE1
    );
    eq(rE1.ok, true, '窗口外的末尾标本最终被选中');
    eq(boxE1.__stats.refreshCalls, 0, 'skipListRefresh: true 时不重发全量查询（此前该参数是死参数）');

    // E2：目标不在完整列表里 → 才需要重查一次
    const envE2 = makeFakeGrid({firstRows: makeRows(20), pageSize: 100});
    const boxE2 = makeWaitSandbox(envE2);
    boxE2.__item = {reportDR: 'NOT-IN-LIST', labno: 'NOPE', mdr: 'MDR9'};
    const rE2 = await vm.runInContext(
      'waitAndSelectNativeRow(__iframeWin, __item, {timeoutMs: 120, pollMs: 10})',
      boxE2
    );
    eq(rE2.ok, false, '列表里确实没有该标本 → 如实返回 false');
    ok(boxE2.__stats.refreshCalls >= 1, '此时才调用服务端重查（机台/日期可能不对）');
  }
}

/* ================= F. 静态不变量 ================= */
section('F. 静态不变量');

ok(
  /function nativeWorkListFullRows\(el, iframeWin\)/.test(src),
  '存在完整列表读取函数'
);
ok(
  /data\.firstRows/.test(src),
  '完整列表读取必须用 scrollview 的 firstRows（不是被窗口覆盖过的 rows）'
);
ok(
  /function nativeWorkListSelectedDR\(el\)/.test(src) && /el\.datagrid\('getSelected'\)/.test(src),
  '存在选行生效校验（读原生 getSelected）'
);
ok(
  /selDR !== String\(reportDR\)[\s\S]{0,500}?continue;/.test(src),
  '选行未生效必须 continue（返回 false），不得继续返回 true'
);
ok(
  /25 \* idx/.test(src),
  '滚动步长按原生口径 25*index（与 InitM:1937 一致）'
);
ok(
  /const nativeDetailDR = String\(jq\('#text_MajorConclusion'\)\.attr\('name'\)/.test(src),
  '详情身份校验读原生 text_MajorConclusion[name]'
);
ok(
  /if \(!refreshed && !_inFull && !options\.skipListRefresh\)/.test(src),
  '目标已在完整列表时不再重发全量查询，且尊重 skipListRefresh'
);
ok(
  !/if \(!refreshed\) \{\s*\n\s*refreshed = true;/.test(src),
  '旧的「无条件先刷新一次」已移除'
);
// 医学规则零改动（红线不动）
ok(
  /function mildAllowItem\(/.test(src) && /const MILD_ALLOW_RULES = \[/.test(src),
  '轻微放行规则表与判定函数仍在（本次只修选行链路，不动医学规则）'
);

/* ================= 汇总 ================= */
console.log('\n────────────────────────────');
console.log('通过 ' + pass + ' 项，失败 ' + fail + ' 项');
if (fail) {
  console.log('\n失败项：');
  failures.forEach((f) => console.log('  - ' + f));
  process.exit(1);
}
console.log('全部通过 ✅');
