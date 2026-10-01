/**
 * boot() 冒烟测试：**真的把启动流程跑一遍**。
 *
 * 为什么要这个测试（血泪史）：本项目被 TDZ（`let/const` 在声明行之前被访问）
 * 咬了三次，每次都是"启动即白屏"，而且**纯函数单测完全抓不到** ——
 * 因为那些测试只 import 模块、不执行 boot()，而 TDZ 只在运行时才炸：
 *
 *   1. appearance    → 启动即白屏（早期）
 *   2. lines         → TDZ（早期）
 *   3. usageBroadcastEnabled → **只有"独立设置窗口"那条路径会崩**，
 *      表现为设置面板一片空白 + "连不上桥接进程（Cannot access … before initialization）"。
 *      更坑的是：它被我修好另一个 bug（设置窗口按 label 识别）之后才暴露出来，
 *      因为在那之前 `viewMode` 恒为 false，压根不走那条路。
 *
 * 所以这里用一套最小的 DOM/window 桩，把 boot() 真跑一遍；任何 TDZ / 未定义访问
 * 都会当场抛出来。跑：
 *   node app/test/boot.test.mjs
 */

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

// ---------------------------------------------------------------- 最小浏览器桩
function makeEl(tag = 'div') {
  const el = {
    tagName: String(tag).toUpperCase(),
    children: [],
    style: new Proxy({}, {
      get: (t, k) => (k === 'setProperty' ? (name, v) => { t[name] = v; } : t[k]),
      set: (t, k, v) => { t[k] = v; return true; },
    }),
    dataset: {},
    classList: { add() {}, remove() {}, contains: () => false, toggle() {} },
    hidden: false,
    open: false,
    textContent: '',
    innerHTML: '',
    offsetWidth: 200,
    offsetHeight: 200,
    clientWidth: 200,
    clientHeight: 200,
    width: 200,
    height: 200,
    appendChild(c) { el.children.push(c); return c; },
    removeChild() {},
    remove() {},
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    setAttribute() {},
    getAttribute() { return null; },
    removeAttribute() {},
    querySelector() { return null; },
    querySelectorAll() { return []; },
    closest() { return null; },
    contains() { return false; },
    focus() {},
    show() { el.open = true; },
    close() { el.open = false; },
    getContext() {
      const noop = () => {};
      return {
        setTransform: noop, clearRect: noop, drawImage: noop, save: noop, restore: noop,
        translate: noop, rotate: noop, scale: noop, fillRect: noop,
        getImageData: () => ({ data: new Uint8ClampedArray(4), width: 1, height: 1 }),
        putImageData: noop, createLinearGradient: () => ({ addColorStop: noop }),
        measureText: () => ({ width: 10 }), fillText: noop,
      };
    },
    getBoundingClientRect: () => ({
      x: 0, y: 0, left: 0, top: 0, right: 200, bottom: 200, width: 200, height: 200,
    }),
  };
  return el;
}

function installStubs() {
  const byId = new Map();
  const document = {
    body: makeEl('body'),
    documentElement: makeEl('html'),
    title: '',
    hidden: false,
    readyState: 'complete',
    getElementById(id) {
      if (!byId.has(id)) byId.set(id, makeEl('div'));
      return byId.get(id);
    },
    createElement: (tag) => makeEl(tag),
    createTextNode: () => ({}),
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() { return true; },
    execCommand() { return true; },
  };

  const store = new Map();
  const localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => { store.set(k, String(v)); },
    removeItem: (k) => { store.delete(k); },
    clear: () => store.clear(),
  };

  const location = { search: '', href: 'http://tauri.localhost/', origin: 'http://tauri.localhost' };
  const screen = { width: 1280, height: 800, availWidth: 1280, availHeight: 752 };

  const window = {
    innerWidth: 340, innerHeight: 312, devicePixelRatio: 2,
    screenX: 100, screenY: 100,
    screen,
    location,
    document,
    localStorage,
    // 没有 __TAURI__ → isTauri=false，走"浏览器模式"分支（更少的外部依赖）
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (fn) => setTimeout(() => fn(performance.now()), 0),
    cancelAnimationFrame: () => {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: 'node-smoke' },
    PerformanceObserver: undefined,
  };

  // fetch 桩：返回"形状正确"的假数据，避免启动流程因为网络失败而走偏
  const fetchStub = async (url) => {
    const u = String(url);
    let body = {};
    if (u.includes('manifest.json')) {
      body = {
        cell: 256,
        margin: 0.04,
        states: {
          idle: { file: 'states/idle.png', frames: 4, fps: 12, mode: 'loop', on_screen_px: [212, 217] },
        },
      };
    } else if (u.includes('bubble.json')) {
      // 形状要和 assets/ui/bubble.json 一致：bubble-skin.js 会读
      // size / slice / border / tailRatio —— 少一个就会"皮肤未启用"
      body = {
        size: [1235, 1241],
        slice: { top: 11, right: 16, bottom: 21, left: 16 },
        border: { top: 11, right: 16, bottom: 21, left: 16 },
        tailRatio: 0.456,
      };
    } else if (u.includes('/lines')) {
      body = { categories: {} };
    } else if (u.includes('/usage')) {
      body = { providers: [] };
    }
    return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) };
  };

  globalThis.window = window;
  globalThis.document = document;
  globalThis.localStorage = localStorage;
  globalThis.location = location;
  globalThis.screen = screen;
  // Node 里 navigator 只有 getter（不能直接赋值）→ 用 defineProperty 覆盖
  try {
    Object.defineProperty(globalThis, 'navigator', {
      value: window.navigator, configurable: true, writable: true,
    });
  } catch { /* 覆盖不了就算了，前端不强依赖它 */ }
  globalThis.fetch = fetchStub;
  globalThis.requestAnimationFrame = window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = window.cancelAnimationFrame;
  globalThis.getComputedStyle = window.getComputedStyle;
  globalThis.matchMedia = window.matchMedia;

  // ---- 假装自己是 Tauri 的**独立设置窗口**（label=settings）----
  //
  // 这一步是整个测试的关键，别删：
  // 那个 `usageBroadcastEnabled` 的 TDZ **只在设置窗口这条路径上才会炸**
  // （因为设置窗口一打开就去读它）。第一版测试只跑默认的"桌宠窗口"路径
  // （label 拿不到 → viewMode=false），于是它**放过了这个 bug** ——
  // 我特意把 bug 放回去验证过，测试照样通过。所以必须显式模拟 label=settings。
  globalThis.window.__TAURI__ = {
    core: { invoke: async () => ({ source: 'none' }) },
    window: {
      getCurrentWindow: () => ({
        label: 'settings',
        outerSize: async () => ({ width: 580, height: 660 }),
        outerPosition: async () => ({ x: 100, y: 100 }),
        setSize: async () => {},
        setPosition: async () => {},
        setAlwaysOnTop: async () => {},
        center: async () => {},
        onMoved: () => {},
        setIgnoreCursorEvents: async () => {},
      }),
      LogicalSize: class { constructor(w, h) { this.width = w; this.height = h; } },
      PhysicalSize: class { constructor(w, h) { this.width = w; this.height = h; } },
      PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } },
    },
    dpi: {
      LogicalSize: class { constructor(w, h) { this.width = w; this.height = h; } },
      PhysicalSize: class { constructor(w, h) { this.width = w; this.height = h; } },
      PhysicalPosition: class { constructor(x, y) { this.x = x; this.y = y; } },
    },
    event: { listen: async () => () => {} },
  };
  globalThis.Image = class {
    constructor() {
      this.width = 1024; this.height = 256; this.onload = null; this.onerror = null;
      // 立刻"加载成功"：让精灵图库走完它那条 promise
      setTimeout(() => { if (this.onload) this.onload(); }, 0);
    }
    set src(_v) { /* 忽略 */ }
  };
  // 前端用 setInterval 起主循环；测试里让它变 no-op，避免进程被挂住
  const realSetInterval = globalThis.setInterval;
  globalThis.setInterval = (fn, ms) => {
    // 只保留很短的定时器（渲染循环之类由 rAF 驱动），长周期的直接丢掉
    if (Number(ms) >= 100) return { unref() {} };
    return realSetInterval(fn, ms);
  };
}

test('boot() 能跑完，不抛 TDZ / ReferenceError', async () => {
  installStubs();
  // 关掉 main.js 的自启动，由测试自己控制调用（否则会跑两遍）
  globalThis.window.__PRESAGE_NO_AUTOBOOT__ = true;
  const mod = await import('../src/main.js');
  assert.ok(typeof mod.boot === 'function', 'main.js 应该导出 boot()');

  let done = false;
  let err = null;
  mod.boot().then(() => { done = true; }, (e) => { err = e; done = true; });
  // 给它足够时间走完各段 await；没跑完也算失败（说明卡住了）
  const deadline = Date.now() + 4000;
  while (!done && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 25));
  }
  if (err) throw new Error(`boot() 抛错：${err && (err.stack || err.message)}`);
  assert.ok(done, 'boot() 在 4 秒内没有结束（可能卡在某个 await 上）');
});

test('设置窗口打开后，面板渲染不抛错（usageBroadcast 的 TDZ 就在这里）', async () => {
  // 关键事实（踩过的坑）：那个 TDZ **不是**在 boot() 里抛的。
  //   boot() → settings.open() → refresh()  ← 这里才去读 usageBroadcast.get()
  // 而 refresh() 是 await 链上的后续步骤，所以"boot() 没抛"**不能**证明它没炸；
  // 第一版测试就是这么被骗过去的（把 bug 放回去测试照样通过）。
  //
  // 所以这里：① 抓 console.error / unhandledRejection；② 跑完 boot() 之后再等一会，
  // 让 open() → refresh() 那一段真正执行完；③ 断言面板确实渲染了内容。
  const errors = [];
  const realError = console.error;
  const realLog = console.log;
  const logs = [];
  console.error = (...a) => { errors.push(a.map(String).join(' ')); realError(...a); };
  console.log = (...a) => { if (a[0] === '[front]') logs.push(String(a[1])); realLog(...a); };
  const onRejection = (r) => errors.push(`unhandledRejection: ${r && (r.message || r)}`);
  process.on('unhandledRejection', onRejection);
  try {
    const mod = await import('../src/main.js?settings=1');
    await mod.boot();
    // 让 open() → refresh() 那段异步流程真正跑完
    for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 25));
  } finally {
    console.error = realError;
    console.log = realLog;
    process.off('unhandledRejection', onRejection);
  }

  const tdz = [...errors, ...logs].filter((m) => m.includes('before initialization'));
  assert.equal(tdz.length, 0, `出现了 TDZ（声明顺序错了）：${tdz[0] || ''}`);
  // ⚠️ 真正会抓到这个 bug 的判据在这里：
  // refresh() 把任何异常都**catch 成状态文字**（见 settings.js 的 refresh catch 分支），
  // 所以 TDZ 不会以"未捕获异常"的形式出现 —— 它显示成面板顶部的
  //   「连不上桥接进程（Cannot access 'usageBroadcastEnabled' before initialization）」
  // 这正是用户截图里看到的那一行。所以必须去看 `#settings-status` 的文字。
  const statusEl = globalThis.document.getElementById('settings-status');
  const statusText = String(statusEl && statusEl.textContent || '');
  assert.ok(!/before initialization/.test(statusText),
    `设置面板状态里出现了 TDZ：${statusText}`);
  assert.ok(!/Cannot access/.test(statusText),
    `设置面板状态里出现了未定义访问：${statusText}`);
  // 面板必须真的渲染过：refresh() 会写状态文字，open() 会打日志
  assert.ok(logs.some((l) => l.includes('settings open 被调用')), 'settings.open() 没被调用');
  assert.ok(logs.some((l) => l.includes('对话框已打开')), '设置对话框没打开');
  // boot 的"设置窗口分支"必须走到收尾
  assert.ok(logs.some((l) => l.includes('boot ok（独立设置窗口模式）')),
    '设置窗口分支没走完（中途抛错了）');
});

import assert from 'node:assert/strict';

for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${cases.length} 通过`);
process.exit(process.exitCode || 0);
