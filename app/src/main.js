/**
 * 启动装配 + 气泡 DOM 渲染 + demo 事件源。
 *
 * demo 源的作用：不接任何 Agent 也能看到全部状态，用于验证渲染与状态机。
 * 接真实数据时把 DemoSource 换成「读 events/*.jsonl 的 adapter」即可，
 * 其余部分（arbiter / bubbles / renderer）一行都不用改。
 */

import { KIND, makeEvent, parseLine } from './protocol.js';
import { SpriteLibrary } from './assets.js';
import { PetRenderer } from './renderer.js';
import { Arbiter } from './arbiter.js';
import { BubbleQueue, BUBBLE } from './bubbles.js';
import { LiveSource } from './sources/live.js';
import {
  PointerBridge, frontLog, isTauri, tauriWindow, tauriLogicalSize, tauriPhysicalPosition,
  tauriInvoke,
} from './pointer.js';
import { Interactions } from './interactions.js';
import { applyBubbleSkin } from './bubble-skin.js';
import { SettingsPanel } from './settings.js';
import { Lines } from './lines.js';
import { formatUsageFact } from './usage-view.js';
import {
  loadAppearance, saveAppearance, clampAppearance, windowSizeFor,
  CONTENT_SCALE, MARGIN, BUBBLE_SPACE, screenWorkArea, maxSizeForScreen,
} from './appearance.js';

// 全局错误必须进 native 日志：前端一崩，桌面窗口就是"什么都没有"，
// 而浏览器控制台在 Tauri 里根本看不到，只能靠这条通道定位。
window.addEventListener('error', (e) => {
  frontLog(`ERROR ${e.message} @${String(e.filename).split('/').pop()}:${e.lineno}:${e.colno}`);
});
window.addEventListener('unhandledrejection', (e) => {
  const r = e.reason;
  frontLog(`REJECT ${(r && (r.stack || r.message)) || String(r)}`);
});

const ASSET_BASE = 'assets/';
const BUBBLE_TEXT = {
  [KIND.APPROVAL_REQUEST]: (p) => ({ title: '需要你批准', text: p.summary || '有一步操作等你确认' }),
  [KIND.ERROR]: (p) => ({ title: '出错了', text: p.message || '任务失败' }),
  [KIND.TURN_END]: (p) => (p.status === 'ok'
    ? { title: '完成', text: p.summary || '这一轮做完了' }
    : null),
};

async function boot() {
  const params = new URLSearchParams(location.search);
  const debug = params.get('debug') === '1';
  /**
   * 独立设置窗口模式（Rust 用 ?view=settings 打开第二个窗口）。
   * 这样设置面板不必挤进桌宠窗口，桌宠窗口也就完全不用改尺寸/位置
   * —— 之前"打开设置就看不到桌宠"的根本解法。
   */
  const viewMode = params.get('view') === 'settings';
  if (viewMode) document.body.classList.add('settings-window');

  // 数据源配置必须在最前面定下来：后面的设置页、指针桥、事件源都要用 bridgeUrl。
  // （之前把它写在几百行之后，设置页引用时触发 TDZ，整个前端直接不启动。）
  let sourceMode = viewMode ? 'none' : (params.get('source') || 'demo');
  let bridgeUrl = params.get('bridge') || 'http://127.0.0.1:8792';
  // 台词库：要早于 feed() 的第一次调用，否则会踩 TDZ
  const lines = new Lines();
  // 外观配置同理：applyAppearance() 在 boot 末尾就会被调用，
  // 声明放在后面会踩 TDZ（实测又犯过一次，被 BOOT-FAILED 日志当场抓到）
  const appearance = clampAppearance(loadAppearance());
  if (isTauri) {
    try {
      const cfg = await tauriInvoke('runtime_config');
      if (!params.get('source') && cfg.source) sourceMode = cfg.source;
      if (!params.get('bridge') && cfg.bridge) bridgeUrl = cfg.bridge;
    } catch (e) {
      frontLog(`runtime_config 调用失败，回落到 demo：${e && e.message}`);
    }
  }
  // 数据源要明写在日志里：否则"演示数据"和"真实数据"看起来一样（实测分辨不出来）
  frontLog(`source=${sourceMode} bridge=${bridgeUrl}`);

  const manifest = await fetch(ASSET_BASE + 'manifest.json').then((r) => r.json());
  const skin = await applyBubbleSkin(ASSET_BASE);
  const lib = new SpriteLibrary(ASSET_BASE, manifest);
  const arbiter = new Arbiter({ lock: 'auto' });

  // canvas 已移出 DOM：只用来算命中遮罩的像素（纯 CPU，不受合成器影响）。
  // 可见盒与拖拽交给同尺寸的 #pet-hit。
  const canvas = document.createElement('canvas');
  const hit = document.getElementById('pet-hit');
  const stage = document.getElementById('stage');
  const renderer = new PetRenderer(canvas, lib, {
    size: 200,
    // 可见角色由这两层 DOM 渲染（canvas 只留着算命中遮罩）
    view: {
      prev: document.getElementById('pet-prev'),
      cur: document.getElementById('pet-cur'),
    },
    // 可见占位盒：坐标、尺寸、拖拽都靠它（canvas 已移出 DOM）
    hit,
    // 尺寸写进 #stage 的 CSS 变量，元素位置全由 CSS 决定
    stage,
  });

  const list = document.getElementById('bubble-list');
  const bubbles = new BubbleQueue({ onChange: renderBubbles });

  let forced = null;
  let forcedEpoch = 0;
  let pointer = null; // 指针交互桥，稍后装配（回调里要用到，所以先声明）

  /**
   * 气泡位置微调（视觉手感，改这两个数就能调）：
   *   extraOverlapPx 尾巴再往头顶里压多少
   *   shiftRightPx   气泡整体右移多少（尾巴对准之后还想再偏一点）
   */
  const BUBBLE_TUNE = { extraOverlapPx: 24, shiftRightPx: 6 };

  /**
   * 让气泡的尾巴对准小人头顶。
   * 气泡在窗口里是水平居中的，但素材的尾巴并不在气泡正中（实测在 45.6% 处），
   * 所以整体平移一点，尾巴才会落在角色正上方；再叠加一个人工右移量。
   */
  function tailShiftPx(bubbleWidth) {
    if (!skin) return 0;
    const srcW = skin.size[0];
    const srcMid = Math.max(1, srcW - skin.slice.left - skin.slice.right);
    const tailInMid = Math.min(1, Math.max(0,
      (skin.tailRatio * srcW - skin.slice.left) / srcMid));
    const rendMid = Math.max(1, bubbleWidth - skin.border.left - skin.border.right);
    const tailX = skin.border.left + tailInMid * rendMid; // 尾巴相对气泡左缘
    return bubbleWidth / 2 - tailX + BUBBLE_TUNE.shiftRightPx;
  }

  /**
   * 气泡尾巴往头顶里压多少 —— 按角色高度取比例，不写死像素。
   *
   * ⚠️ 必须声明在所有使用它的函数**之前**：boot 一开头就会调用
   * applyBubbleOverlap()，而 `const` 在声明行之前是不可访问的（TDZ）。
   * v1 已经因为同类问题踩过一次（appearance/lines 都是这个坑），
   * 这次启动日志里 `BOOT-FAILED ... before initialization` 又抓到一次。
   */
  const BUBBLE_HEAD_OVERLAP = 0.08;

  let lastLayoutLog = 0;
  /** 把关键几何打给 native 日志：气泡底边应低于画布顶边（尾巴压住角色），尾巴应落在画布中线附近 */
  function logLayout(container) {
    const now = Date.now();
    if (now - lastLayoutLog < 2000) return;
    lastLayoutLog = now;
    const c = hit.getBoundingClientRect();
    const b = container.querySelector('.bubble')?.getBoundingClientRect();
    // 尾巴的真实位置 = 气泡左缘 + 尾巴在气泡内的偏移（不是气泡中心，之前这里标错过）
    let tailX = null;
    if (b && skin) {
      const srcW = skin.size[0];
      const srcMid = Math.max(1, srcW - skin.slice.left - skin.slice.right);
      const tailInMid = Math.min(1, Math.max(0,
        (skin.tailRatio * srcW - skin.slice.left) / srcMid));
      const rendMid = Math.max(1, b.width - skin.border.left - skin.border.right);
      tailX = b.left + skin.border.left + tailInMid * rendMid;
    }
    frontLog(`layout win=${window.innerWidth}x${window.innerHeight} `
      + `canvas=(${Math.round(c.left)},${Math.round(c.top)},`
      + `${Math.round(c.width)},${Math.round(c.height)}) `
      + (b
        ? `bubble=(${Math.round(b.left)},${Math.round(b.top)},`
          + `${Math.round(b.width)},${Math.round(b.height)}) `
          + `尾巴压住头顶=${Math.round(b.bottom - c.top)}px `
          + `尾巴x=${Math.round(tailX)} 画布中线=${Math.round(c.left + c.width / 2)} `
          + `偏右=${Math.round(tailX - (c.left + c.width / 2))}px`
        : 'bubble=none'));
  }

  function alignTails(container) {
    if (!skin) return;
    for (const el of container.querySelectorAll('.bubble')) {
      const w = el.offsetWidth;
      if (w > 0) el.style.transform = `translateX(${tailShiftPx(w).toFixed(1)}px)`;
    }
    logLayout(container);
  }

  /**
   * 几何自检：把「角色到底有没有被窗口/屏幕裁掉」写成一行日志。
   *
   * 为什么必须有：v1 的所有画面问题（她只剩半截 / 整个不见 / 气泡跑到她后面）
   * 都是**布局几何错了**，而当时的日志只打了 `boot ok` 与 `hitmask filled`，
   * 这两个数都正常 —— 于是只能靠用户截图，来回好几轮。
   * 这一行里 `裁掉=` 与 `出屏=` 一旦不为 0，就是确定性的故障，不用再猜。
   */
  let lastGeomLog = 0;
  function logGeometry(why) {
    const now = Date.now();
    if (now - lastGeomLog < 1500 && why !== 'boot' && why !== 'size') return;
    lastGeomLog = now;
    try {
      const c = hit.getBoundingClientRect();
      const b = list.querySelector('.bubble')?.getBoundingClientRect();
      const s = (stage || document.getElementById('stage')).getBoundingClientRect();
      const winW = window.innerWidth;
      const winH = window.innerHeight;
      // 角色在窗口坐标系里的位置（相对 stage，也就是相对窗口）
      const top = c.top - s.top;
      const bottom = c.bottom - s.top;
      const clippedTop = Math.max(0, Math.round(-top));
      const clippedBottom = Math.max(0, Math.round(bottom - winH));
      // 窗口在屏幕上的位置（CSS px）：窗口底部露在可用区域外的像素
      const avail = screenWorkArea();
      const offscreen = Math.max(0, Math.round(
        Math.max(0, -window.screenX) + Math.max(0, window.screenX + winW - avail.w)
        + Math.max(0, -window.screenY) + Math.max(0, window.screenY + winH - avail.h),
      ));
      const ok = clippedTop + clippedBottom === 0;
      // 气泡必须完全落在窗口内：v1.1 第一版把气泡底算成了「角色格子顶」，
      // 于是气泡被放到窗口上方（bubble.y 是负的），用户根本看不到气泡。
      // 这条日志让这种错误再也藏不住。
      const bubbleTop = b ? Math.round(b.top - s.top) : null;
      const bubbleClipped = b ? Math.max(0, Math.round(-(b.top - s.top))) : 0;
      frontLog(`[geom:${why}] ${ok && bubbleClipped === 0 ? 'OK' : 'CLIPPED'} win=${winW}x${winH} `
        + `dpr=${window.devicePixelRatio || 1} screen=${avail.w}x${avail.h} `
        + `pos=(${window.screenX},${window.screenY}) size=${renderer.size} `
        + `pet=(${Math.round(c.left)},${Math.round(top)},`
        + `${Math.round(c.width)},${Math.round(c.height)}) `
        + `petBottom=${winH - bottom}px 裁掉=${clippedTop + clippedBottom}px 出屏=${offscreen}px `
        + (b
          ? `bubble=(左${Math.round(b.left)} 上${bubbleTop} ${Math.round(b.width)}x${Math.round(b.height)}) `
            + `尾巴压住头顶=${Math.round(b.bottom - c.top)}px 气泡出框=${bubbleClipped}px`
          : 'bubble=none')
        // 角色被裁 = 窗口太小或位置不对，这条日志直接指出是哪一个
        + (ok ? '' : ` ← 角色被窗口裁掉（需要至少 ${Math.ceil(Math.abs(top) + bottom)}px）`)
        + (bubbleClipped ? ' ← 气泡跑到窗口外面了（气泡位置算错）' : ''));
    } catch (e) {
      frontLog(`[geom:${why}] 自检失败 ${e && e.message}`);
    }
  }

  function renderBubbles() {
    const merged = bubbles.summary();
    // 显示位只有一条：两条挤在一起不好看，也看不清台词
    const { shown, hiddenCount } = bubbles.visibleSummary(1);
    list.innerHTML = '';

    for (const item of shown) {
      // 多个 Agent 同时在等 → 合并成一条，点开可分别处理
      const isMergedWait = item.kind === BUBBLE.WAITING && merged.merged;
      const self = item.agent === 'presage';
      const el = document.createElement('div');
      el.className = `bubble ${item.kind}${isMergedWait ? ' merged' : ''}`;
      el.innerHTML =
        `<div class="row"><b>${isMergedWait ? merged.text : item.title}</b>`
        + '<button title="关闭">×</button></div>'
        + (item.text ? `<div class="text">${item.text}</div>` : '')
        // 小标签挪到正文行：放在标题行会把台词挤成两三行（实测），
        // 而且桌宠自己说的话没必要标 "presage"
        + (item.text && !self && !isMergedWait
          ? `<div class="meta"><span class="agent">${item.agent}</span></div>` : '');
      el.querySelector('button').onclick = (e) => {
        e.stopPropagation();
        bubbles.dismiss(item.id);
      };
      if (isMergedWait) el.onclick = () => list.classList.toggle('expanded');
      list.appendChild(el);
    }

    const counter = document.getElementById('collapsed-count');
    counter.textContent = hiddenCount ? `+${hiddenCount} 条` : '';
    alignTails(list);
    logGeometry('bubble');
    pointer?.invalidate(); // 气泡是可点区域，布局变了要重算命中遮罩
  }

  const hud = document.getElementById('hud');
  let lastLoggedAnim = null;
  let lastStateAt = 0;
  arbiter.subscribe((snap) => {
    if (!forced) renderer.setState(snap);
    pointer?.invalidate(); // 换状态＝换轮廓，命中遮罩要跟着变
    // 状态变化打一条日志：既是可观测性，也是"真的在跟着 Agent 动"的证据
    if (snap.anim !== lastLoggedAnim) {
      const prev = lastLoggedAnim;
      // 记上一状态的停留时长：判断"working 到底有没有到、到了多久"全靠它。
      // 只看"切到了 working"是不够的——一闪而过等于用户根本没看见。
      // v1 这里算成了 0.0s（上一状态的时间戳每次 resolve 都被覆盖），等于没信息；
      // 现在用仲裁器给的 heldMs（它以"提交时刻"为准，不受抖动影响）。
      const held = lastStateAt ? `${((Date.now() - lastStateAt) / 1000).toFixed(1)}s` : '-';
      const heldReal = typeof snap.heldMs === 'number' ? `${(snap.heldMs / 1000).toFixed(1)}s` : '-';
      lastLoggedAnim = snap.anim;
      lastStateAt = Date.now();
      frontLog(`state → ${snap.anim}（上一状态 ${prev ?? '-'} 持续 ${held}/${heldReal}）`
        + `（等${snap.waiting} 错${snap.errors} 干活${snap.working} 想${snap.thinking}）`
        + (snap.errors.length
          ? ` 出错agent=${snap.errors.map((x) => x.agent).join(',')}` : ''));
      // 长时间空闲进入趴下时搭一句（第七类）
      if (snap.anim === 'doze' && prev && prev !== 'doze') {
        pushLine('idle', BUBBLE.INFO, '', 'presage');
      }
      // 新回合开始时偶尔说一句（第二类），别每次都刷
      if (snap.anim === 'working' && Math.random() < 0.35) {
        pushLine('working', BUBBLE.INFO, '', 'presage');
      }
    }
    if (!debug) return;
    const health = Object.entries(snap.health)
      .map(([a, h]) => `${a}:${h.heartbeatStale ? '降级' : 'ok'}`)
      .join(' ');
    hud.textContent =
      `状态=${forced || snap.anim}${snap.oneShot ? '(once)' : ''} ` +
      `等=${snap.waiting} 错=${snap.errors} 干活=${snap.working} 想=${snap.thinking} ` +
      `锁=${snap.lock} ${health}`;
  });

  renderer.setState({ anim: 'idle', epoch: 0 });
  renderer.start(); // 必须显式启动渲染循环：只 setState 不会画任何东西

  // ---------- 瞬时表现：播一个不属于状态机的状态，到点自动归还 ----------
  // 彩蛋、互动表情都走这里；状态还没素材时返回 false，调用方安静跳过。
  let transientTimer = null;
  function playTransient(state, durationMs = 2000) {
    if (!lib.info(state)) return false; // 以后把素材补上就自动可用，无需改这里
    forced = state;
    forcedEpoch += 1;
    renderer.setState({ anim: forced, epoch: forcedEpoch });
    if (transientTimer) clearTimeout(transientTimer);
    if (durationMs > 0) {
      transientTimer = setTimeout(() => {
        forced = null;
        forcedEpoch += 1;
        // 必须显式恢复：仲裁器此时往往没有新事件，不会主动推送
        renderer.setState({ ...arbiter.resolve(), epoch: forcedEpoch });
      }, durationMs);
    }
    return true;
  }

  // ---------- 点击互动 / 彩蛋注册表 ----------
  const interactions = new Interactions({
    play: playTransient,
    onEvent: (name, detail) => {
      frontLog(`interactions ${name} ${JSON.stringify(detail)}`);
      if (debug) hud.textContent = `互动 ${detail?.id || name}`;
    },
  });
  interactions.registerDefaults();

  // ---------- 指针交互：点击穿透 / 拖拽 / 右键菜单 ----------
  const settings = new SettingsPanel({
    bridge: bridgeUrl,
    onLog: (m) => frontLog(`settings ${m}`),
    lines,
    // 角色大小上限跟着屏幕走：窗口装得下才算合法（见 appearance.js 的说明）
    maxSize: maxSizeForScreen(),
    onProviderChanged: () => pushLine('provider', BUBBLE.INFO, '', 'presage'),
    usageBroadcast: { get: () => usageBroadcastEnabled, set: setUsageBroadcast },
    appearance: { get: () => appearance, set: (patch) => applyAppearance(patch) },
    // 设置页在 340px 宽的桌宠窗口里太挤，打开时把窗口临时放大，关掉再收回
    onResize: async (w, h) => {
      const win = tauriWindow();
      if (!win) return;
      try {
        if (w) {
          // 只在第一次记录原始尺寸/位置：open() 之后还会再确认一次尺寸，
          // 每次都记的话第二次记下的就是"已经放大后"的尺寸，关掉时自然恢复不回去（实测踩到）
          if (!settings._savedSize) {
            settings._savedSize = await win.outerSize();
            settings._savedPos = await win.outerPosition();
            // 记住角色此刻在屏幕上的位置：放大窗口时要让她**原地不动**，
            // 否则窗口一变大会把她挤到别处，用户就看不清自己调的大小了
            const r = hit.getBoundingClientRect();
            const dpr0 = window.devicePixelRatio || 1;
            settings._anchor = {
              x: settings._savedPos.x + (r.left + r.width / 2) * dpr0,
              y: settings._savedPos.y + r.bottom * dpr0,
            };
          }
          await win.setSize(tauriLogicalSize(w, h));
          // 等一帧让布局按新尺寸重排，再量角色位置并反推窗口位置
          await new Promise((res) => requestAnimationFrame(res));
          const a = settings._anchor;
          if (a) {
            const dpr = window.devicePixelRatio || 1;
            const r2 = hit.getBoundingClientRect();
            const cur = await win.outerPosition();
            const wantX0 = Math.round(a.x - (r2.left + r2.width / 2) * dpr);
            const wantY0 = Math.round(a.y - r2.bottom * dpr);
            // 夹一下：窗口本身可以有一部分在屏幕外（那部分是透明的），
            // 但**设置面板不能出屏**，否则左边的控件点不到
            // （实测：锚定会把窗口推到 x=-210，而面板居中 → 左边 150px 在屏幕外）
            const sw = Math.round((window.screen?.availWidth || 1280) * dpr);
            const sh = Math.round((window.screen?.availHeight || 800) * dpr);
            const panelW = 460 * dpr;
            const panelLeftInWin = (w * dpr - panelW) / 2;
            const pad = 8 * dpr;
            const wantX = Math.min(Math.max(wantX0, Math.round(-panelLeftInWin + pad)),
              Math.round(Math.max(0, sw - panelLeftInWin - panelW - pad)));
            const wantY = Math.min(Math.max(wantY0, Math.round(pad)),
              Math.round(sh - 60 * dpr));
            if (Math.abs(cur.x - wantX) > 1 || Math.abs(cur.y - wantY) > 1) {
              await win.setPosition(tauriPhysicalPosition(wantX, wantY));
            }
            frontLog(`设置页：窗口 ${cur.x},${cur.y} → ${wantX},${wantY}`
              + `（角色锚定 ${Math.round(a.x)},${Math.round(a.y)}`
              + `${wantX !== wantX0 || wantY !== wantY0 ? '，已夹回屏幕内' : ''}）`);
          } else {
            await win.center();
          }
        } else if (settings._savedSize) {
          await win.setSize(settings._savedSize);
          if (settings._savedPos) await win.setPosition(settings._savedPos);
          settings._savedSize = null;
          settings._savedPos = null;
        }
      } catch (e) { frontLog(`settings 调整窗口失败 ${e.message}`); }
    },
  });
  settings.bind();

  // 台词库：优先用桥接侧的可编辑词库（runtime/lines.json），拿不到就用内置默认
  fetch(`${bridgeUrl}/lines`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      if (!d?.categories) return;
      const custom = {};
      for (const [k, v] of Object.entries(d.categories)) if (v.custom) custom[k] = v.lines;
      lines.applyCustom(custom);
      frontLog(`lines 已加载（自定义 ${Object.keys(custom).length} 类）`);
    })
    .catch(() => { /* 桥接没起就用内置默认 */ });

  // 用量快照：事件流里的 usage/update 只在数字变化时才推，
  // 而且可能早于桌宠启动（就被后来的事件挤出缓冲）。随机播报需要"当前值"，
  // 所以启动时直接拉一次快照，别指望事件流。
  fetch(`${bridgeUrl}/usage`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => {
      for (const p of d?.providers ?? []) usageByProvider.set(p.provider, p);
      const fact = formatUsageFact(Object.fromEntries(usageByProvider));
      frontLog(`usage 快照已加载（${usageByProvider.size} 个提供方）${fact ? ` → ${fact}` : ''}`);
      scheduleUsageBroadcast();
    })
    .catch(() => { /* 桥接没起就没有用量播报 */ });

  pointer = new PointerBridge({
    canvas,
    hit,
    onLog: (m) => { frontLog(`pointer ${m}`); if (debug) hud.textContent = m; },
    onGesture: (g) => {
      frontLog(`gesture ${g.type}${g.durationMs ? ` ${Math.round(g.durationMs)}ms` : ''}`);
      interactions.feed(g);
      if (g.type === 'click') showClickLine(); // 点一下就搭一句话
    },
    onLift: (on) => { frontLog(`lift ${on}`); renderer.setLifted(on); },
    onClear: () => { bubbles.clear(); frontLog('气泡已清空'); },
    onSettings: () => {
      // 优先用独立窗口（可拖动、不动桌宠窗口）。但 IPC 在个别情况下会挂住，
      // 所以**带超时 + 一定回退**：1.2 秒内没等到就地在桌宠窗口里弹面板，
      // 保证用户点"设置"永远有东西出来，而不是"点了没反应"。
      let settled = false;
      tauriInvoke('open_settings').then(() => { settled = true; })
        .catch((e) => {
          settled = true;
          frontLog(`独立设置窗口失败（${e && (e.message || e)}），退回窗口内面板`);
          settings.open();
        });
      setTimeout(() => {
        if (!settled) {
          frontLog('独立设置窗口无响应，退回窗口内面板');
          settings.open();
        }
      }, 1200);
    },
    onDragEnd: () => { snapToEdge(); },
  });
  pointer.init().catch((e) => console.warn('[pointer] init 失败', e));

  if (viewMode) {
    // 独立设置窗口：只要面板，绝不碰窗口尺寸/位置/穿透
    // （一旦跑 applyAppearance，它会按 localStorage 里的外观去 setSize，
    //   把这个设置窗口也一起改掉 —— 实测踩到过）
    settings.open();
    frontLog('boot ok（独立设置窗口模式）');
    return;
  }

  // 首次应用外观：尺寸 / 透明度 / 置顶 / 穿透，并顺带把气泡叠放位置算好
  const geo0 = applyBubbleOverlap();
  frontLog(`bubble overlap=${geo0.overlap}px（画布 ${geo0.canvasSize}x${geo0.canvasH}）`);
  await applyAppearance({}, { announce: true });
  logGeometry('boot');
  // 屏幕缩放/分辨率变化时几何会变：重新夹一次尺寸并自检
  window.addEventListener('resize', () => { setTimeout(() => logGeometry('resize'), 300); });
  // 贴边检测：窗口一动就查一次，另加低频兜底（比如被系统移了位置）
  tauriWindow()?.onMoved?.(() => { checkEdgePeek(); });
  setInterval(() => { checkEdgePeek(); }, 1500);

  frontLog(`boot ok  states=${lib.states.length}  eggs=${interactions.list().length}  `
    + `tauri=${isTauri}  state=${renderer.state}  `
    + `skin=${skin ? `on ${skin.size[0]}x${skin.size[1]} border=${JSON.stringify(skin.border)}` : 'off'}`);

  // ---------- 画面自检 ----------
  // 事故背景：主流程漏调 start()，结果「气泡正常、角色全白」——静默失败，肉眼要排查很久。
  // 这里在启动后检查一次 canvas 是否真的画出了像素；没画出来就显式报警并把结果写进
  // 窗口标题（便于自动化验证）。
  setTimeout(() => {
    try {
      const ctx = canvas.getContext('2d');
      const px = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let opaque = 0;
      for (let i = 3; i < px.length; i += 4) if (px[i] > 8) opaque++;
      const loaded = Object.keys(lib.resident);
      const ok = opaque > 100;
      const report = `${ok ? 'OK' : 'BLANK'} px=${opaque} state=${renderer.state || '-'} `
        + `running=${renderer.running} loaded=${loaded.join('|') || 'none'}`;
      document.title = report;
      window.__selfCheck = report;

      // 结果编码：window.__selfCheck 供自动化读取；只有在**失败**时才显示颜色条，
      // 正常时不留任何痕迹（用户不该看到一个常驻的绿条）。
      const color = ok ? null : (loaded.length ? '#ff9500' : '#e00000');
      if (color) {
        const bar = document.createElement('div');
        bar.id = 'selfcheck';
        bar.style.cssText = `position:fixed;left:0;top:0;width:140px;height:16px;`
          + `background:${color};z-index:999`;
        document.body.appendChild(bar);
        console.warn('[selfcheck]', report);
      }
    } catch (e) {
      document.title = 'ERR ' + e.message;
    }
  }, 4000);

  // ---------- 主循环：仲裁衰减 + 气泡过期 ----------
  setInterval(() => {
    arbiter.tick();
    bubbles.tick();
  }, 200);

  // ---------- 台词触发：低余额 / 点击 / 长时间空闲 / 随机用量播报 ----------
  const LOW_BALANCE = { threshold: 5, repeatMs: 30 * 60_000 };
  /** 随机用量播报的间隔区间：太频繁会烦，太稀疏就失去意义 */
  const USAGE_BROADCAST = { minMs: 15 * 60_000, maxMs: 40 * 60_000 };
  const USAGE_BROADCAST_KEY = 'presage-pet.usageBroadcast';
  let lowBalanceWarnedAt = 0;
  let lastClickLineAt = 0;
  let usageTimer = null;
  const usageByProvider = new Map();
  let usageBroadcastEnabled = localStorage.getItem(USAGE_BROADCAST_KEY) !== '0';

  function pushLine(category, kind, text, agent = 'presage') {
    const line = lines.pick(category);
    if (!line) return false;
    bubbles.push({ kind, title: line, text: text || '', agent });
    frontLog(`line ${category} ${line}`);
    return true;
  }

  /** 余额低于阈值时提醒一次；充回来了就解除，可以再次提醒 */
  function checkLowBalance(payload) {
    const bal = payload?.balance;
    if (typeof bal !== 'number' || !Number.isFinite(bal)) return;
    if (bal > LOW_BALANCE.threshold) { lowBalanceWarnedAt = 0; return; }
    if (Date.now() - lowBalanceWarnedAt < LOW_BALANCE.repeatMs) return;
    lowBalanceWarnedAt = Date.now();
    pushLine('lowBalance', BUBBLE.ERROR,
      `余额 ${bal.toFixed(2)} ${payload.currency || ''}，低于阈值 ${LOW_BALANCE.threshold}`, 'usage');
  }

  /** 随机播报一次余额/用量。间隔是随机的，免得像定时闹钟 */
  function broadcastUsage(manual = false) {
    if (!usageBroadcastEnabled && !manual) return false;
    // 有东西在等用户处理时别插话
    if (bubbles.items.some((i) => i.kind === BUBBLE.WAITING && !i.collapsed)) return false;
    const fact = formatUsageFact(Object.fromEntries(usageByProvider));
    if (!fact) return false;
    return pushLine('usage', BUBBLE.INFO, fact, 'usage');
  }

  function scheduleUsageBroadcast() {
    if (usageTimer || !usageBroadcastEnabled) return;
    const wait = USAGE_BROADCAST.minMs
      + Math.random() * (USAGE_BROADCAST.maxMs - USAGE_BROADCAST.minMs);
    usageTimer = setTimeout(() => {
      usageTimer = null;
      broadcastUsage();
      scheduleUsageBroadcast();
    }, wait);
  }

  function setUsageBroadcast(on) {
    usageBroadcastEnabled = Boolean(on);
    try { localStorage.setItem(USAGE_BROADCAST_KEY, usageBroadcastEnabled ? '1' : '0'); } catch { /* 忽略 */ }
    if (usageBroadcastEnabled) scheduleUsageBroadcast();
    else if (usageTimer) { clearTimeout(usageTimer); usageTimer = null; }
  }

  /** 点一下就说一句话；连点时别刷屏 */
  function showClickLine() {
    if (Date.now() - lastClickLineAt < 1200) return;
    const line = lines.pickClick();
    if (!line) return;
    lastClickLineAt = Date.now();
    bubbles.push({ kind: BUBBLE.INFO, title: line, text: '', agent: 'presage' });
    frontLog(`line click ${line}`);
  }

  // ---------- 外观设置：大小 / 透明度 / 置顶 / 穿透 ----------
  // （appearance 变量在 boot 开头声明，这里只放应用逻辑）

  /**
   * 气泡的纵向位置。
   *
   * v1 用的是 `#bubble-list { margin-bottom: -Npx }`（N 由 boot 时刻量到的画布尺寸算出），
   * 这条负 margin **会把角色整体往下拉**：气泡里的内容一变高、或者 N 算大了，
   * 她就被拉出窗口底边，被窗口硬裁掉（实测：窗口底边切在胸口）。
   * 现在改成绝对定位：气泡从窗口底边往上量到「头顶 + 一点重叠」，
   * 角色不再参与气泡的布局，气泡也不再影响角色的位置。
   */
  function applyBubbleOverlap() {
    const size = renderer.size;
    const canvasH = renderer.height;
    // 角色脚底离窗口底边的距离 = 精灵格底部那段素材留白（margin），
    // 因为 CSS 里 --pet-bottom = size * MARGIN（见 index.html）。
    const feetGap = size * MARGIN;
    // 角色最高像素离窗口底边多远。CONTENT_SCALE 覆盖了所有状态里最高的一帧。
    const charTopFromBottom = feetGap + size * CONTENT_SCALE;
    const overlap = Math.round(size * BUBBLE_HEAD_OVERLAP);
    const bubbleBottom = Math.max(
      feetGap + Math.round(size * 0.4), // 兜底下限：气泡至少要离开脚底一段
      Math.round(charTopFromBottom - overlap),
    );
    const stage = document.getElementById('stage');
    if (stage) {
      stage.style.setProperty('--bubble-bottom', `${bubbleBottom}px`);
    }
    return { canvasSize: size, canvasH, overlap, bubbleBottom, feetGap };
  }

  async function applyAppearance(patch = {}, { announce = false } = {}) {
    // 设置跑在独立窗口里：这里的 `win` 指的是**设置窗口自己**，
    // 所以绝不能就地应用 —— 否则"大小"滑块调的是设置页本身
    // （用户实测抓到的：设置页自己变大变小）。转发给桌宠窗口去改自己。
    if (viewMode) {
      const merged = clampAppearance({ ...appearance, ...patch });
      saveAppearance(merged);
      Object.assign(appearance, merged);
      tauriInvoke('apply_pet_appearance', { patch: merged }).catch((e) => {
        frontLog(`外观转发失败：${e && (e.message || e)}`);
      });
      return;
    }
    Object.assign(appearance, clampAppearance({ ...appearance, ...patch }));
    saveAppearance(appearance);

    // 每一步独立容错：外观是装饰性的，任何一个 Tauri 调用被拒都不该拖死启动。
    // （Tauri 的 IPC 拒绝经常不带 message，所以这里要把原始值也打出来）
    const steps = [
      ['尺寸', () => { renderer.setSize(appearance.size); }],
      ['窗口', async () => {
        const want = windowSizeFor(appearance.size);
        const win = tauriWindow();
        if (!win) return;
        await win.setSize(tauriLogicalSize(want.w, want.h));
        await win.setAlwaysOnTop(appearance.alwaysOnTop);
      }],
      ['透明度', () => { renderer.setOpacity(appearance.opacity); }],
      ['穿透', async () => { await pointer?.setEnabled(appearance.clickThrough); }],
    ];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (e) {
        frontLog(`外观[${name}]失败：${(e && (e.message || e)) || JSON.stringify(e)}`);
      }
    }

    const geo = applyBubbleOverlap();
    pointer?.invalidate();
    logGeometry('size');
    if (announce) {
      frontLog(`外观 size=${appearance.size} opacity=${appearance.opacity} `
        + `置顶=${appearance.alwaysOnTop} 穿透=${appearance.clickThrough} `
        + `画布=${geo.canvasSize}x${geo.canvasH} 气泡底=${geo.bubbleBottom}px`);
    }
    return appearance;
  }

  // ---------- 靠边吸附 + 探头 ----------
  // 语义（用户澄清）：贴到屏幕**右边**时往**左**探、**左边**往右探、**正下方**往上探。
  // 素材映射：'peek_right' 是"线在右、人从线左侧探出"→ 用于右边缘 ✓；
  //           'peek_left' 是它的镜像 → 用于左边缘 ✓；'peek' 是向上探 → 下边缘 ✓。
  // 另外：先**吸附**到边缘，再触发探头。
  const SNAP = { px: 60, edgePx: 20, cooldownMs: 8000, holdMs: 5000 };
  const PEEK_STATE = { left: 'peek_left', right: 'peek_right', bottom: 'peek' };
  let lastEdge = null;
  let lastPeekAt = 0;

  /** 屏幕可用区域（物理像素）。用 avail*（已排除任务栏），不去猜显示器 API。 */
  function screenBounds() {
    const dpr = window.devicePixelRatio || 1;
    return {
      left: 0,
      top: 0,
      right: Math.round((window.screen?.availWidth || 1280) * dpr),
      bottom: Math.round((window.screen?.availHeight || 800) * dpr),
    };
  }

  /** 到各边缘的距离（物理像素）；越小越贴边 */
  async function edgeDistances() {
    const win = tauriWindow();
    if (!win) return null;
    try {
      const pos = await win.outerPosition();
      const size = await win.outerSize();
      const b = screenBounds();
      return {
        pos,
        size,
        b,
        left: Math.abs(pos.x - b.left),
        right: Math.abs((pos.x + size.width) - b.right),
        bottom: Math.abs((pos.y + size.height) - b.bottom),
      };
    } catch {
      return null;
    }
  }

  /** 拖拽结束：靠边就吸附（用户要的"吸附感"），然后允许触发探头 */
  async function snapToEdge() {
    const win = tauriWindow();
    const d = await edgeDistances();
    if (!win || !d) return;
    const t = SNAP.px * (window.devicePixelRatio || 1);
    const table = [
      ['left', d.left, () => { d.pos.x = d.b.left; }],
      ['right', d.right, () => { d.pos.x = d.b.right - d.size.width; }],
      ['bottom', d.bottom, () => { d.pos.y = d.b.bottom - d.size.height; }],
    ].sort((a, b2) => a[1] - b2[1]);
    const [edge, dist, apply] = table[0];
    if (dist > t) return;
    apply();
    try {
      await win.setPosition(tauriPhysicalPosition(Math.round(d.pos.x), Math.round(d.pos.y)));
      frontLog(`吸附到 ${edge} 边缘（偏差 ${Math.round(dist)}px）`);
      lastEdge = null; // 允许紧接着触发探头
      setTimeout(() => { checkEdgePeek(); }, 150);
    } catch (e) {
      frontLog(`吸附失败：${(e && (e.message || e)) || JSON.stringify(e)}`);
    }
  }

  async function checkEdgePeek() {
    const d = await edgeDistances();
    if (!d) return;
    const t = SNAP.edgePx * (window.devicePixelRatio || 1);
    let edge = null;
    if (d.right <= t) edge = 'right';
    else if (d.left <= t) edge = 'left';
    else if (d.bottom <= t) edge = 'bottom';

    if (edge !== lastEdge) {
      // 只在"贴边状态变化"时留痕，免得停在边上时每 1.5 秒刷一条
      const near = Math.min(d.left, d.right, d.bottom);
      frontLog(`触边：left=${Math.round(d.left)} right=${Math.round(d.right)} `
        + `bottom=${Math.round(d.bottom)} 阈值=${Math.round(t)} → ${edge || '未贴边'}`
        + `（最近 ${Math.round(near)}px）`);
    }
    if (edge === lastEdge) return;   // 同一边缘只处理一次
    if (!edge) { lastEdge = null; return; }
    // 冷却中**不要**把 lastEdge 记下：否则这次被吞掉后，停在同一边缘就再也不触发了
    // （实测症状：启动时先判定为 bottom，随后拖到右边一直没反应）
    if (Date.now() - lastPeekAt < SNAP.cooldownMs) return;

    const state = PEEK_STATE[edge];
    if (playTransient(state, SNAP.holdMs)) {
      lastEdge = edge;
      lastPeekAt = Date.now();
      frontLog(`靠边探头：${edge} → ${state}`);
    }
  }

  // ---------- 事件入口（未来 adapter 接这里） ----------
  function feed(evt) {
    arbiter.ingest(evt);
    const maker = BUBBLE_TEXT[evt.kind];
    if (maker) {
      const content = maker(evt.payload);
      if (content) {
        const kind = evt.kind === KIND.APPROVAL_REQUEST ? BUBBLE.WAITING
          : evt.kind === KIND.ERROR ? BUBBLE.ERROR : BUBBLE.DONE;
        // 台词当标题（保留状态色），事实留在正文 —— 有性格但不能丢信息
        const line = lines.pick(lines.categoryFor(
          kind === BUBBLE.WAITING ? 'waiting' : kind === BUBBLE.ERROR ? 'error' : 'done'));
        bubbles.push({
          kind, title: line || content.title, text: content.text,
          agent: evt.agent, sessionId: evt.sessionId,
          ref: evt.payload.approvalId ? `${evt.agent}:${evt.payload.approvalId}` : null,
        });
        if (line) frontLog(`line ${kind} ${line}`);
      }
    }
    // 用量事件：记下来供随机播报用，并在余额低于阈值时提醒（第一类台词）
    if (evt.kind === KIND.USAGE) {
      usageByProvider.set(evt.payload.provider || evt.agent, evt.payload);
      checkLowBalance(evt.payload);
      scheduleUsageBroadcast();
    }
    // 出错事件要留痕：否则"谁把状态打成 error"只能靠猜（实测踩过）
    if (evt.kind === KIND.ERROR) {
      frontLog(`event error agent=${evt.agent} ${JSON.stringify(evt.payload).slice(0, 100)}`);
    }
    if (evt.kind === KIND.APPROVAL_RESOLVED && evt.payload.approvalId) {
      bubbles.retract(`${evt.agent}:${evt.payload.approvalId}`);
    }
    if (evt.kind === KIND.SESSION_END) bubbles.clear();
    // 新回合开始 → 上一轮的完成/错误通知过时了，收进折叠历史（治堆积的关键一条）
    if (evt.kind === KIND.TURN_START) bubbles.retireStale();
  }

  // ---------- 事件源：demo（默认）或 live（真实 Agent 日志） ----------
  let seq = 0;
  const demo = new DemoSource((evt) => feed({ ...evt, seq: ++seq }));
  let live = null;
  if (sourceMode === 'live') {
    live = new LiveSource(bridgeUrl, (evt) => feed(evt), (status, detail) => {
      if (!debug) return;
      hud.textContent = status === 'connected'
        ? `live 已连接  ${detail.watched?.length ?? 0} 个会话  事件累计 ${detail.produced ?? 0}`
        : `live: ${status}`;
    });
    live.start();
  } else if (params.get('demo') !== '0') {
    demo.start();
  }

  // ---------- 键盘：强制状态（QA 用）+ 模拟事件 ----------
  const FORCE_MAP = {
    '1': 'idle', '2': 'thinking', '3': 'waiting', '4': 'error',
    '5': 'celebrate', '6': 'doze', '7': 'sleep',
  };
  window.addEventListener('keydown', (e) => {
    if (e.key === '0') { forced = null; hud.textContent = ''; return; }
    if (FORCE_MAP[e.key]) {
      forced = FORCE_MAP[e.key];
      forcedEpoch += 1;
      renderer.setState({ anim: forced, epoch: forcedEpoch });
      if (debug) hud.textContent = `强制状态=${forced}`;
      return;
    }
    if (e.key === 'a') demo.emitApproval();
    if (e.key === 'e') demo.emitError();
    if (e.key === 'd') demo.emitDone();
  });

  // ---------- 预留：真实事件总线（v2 接上） ----------
  /**
   * 内置自检：往 canvas 派发真实的 DOM 鼠标事件，走完整处理链
   * （canvas mousedown → window mouseup → PointerBridge.onGesture → Interactions → play）。
   *
   * 为什么需要它：沙箱/远程环境里 OS 级输入合成（SetCursorPos / mouse_event）经常不可用，
   * 于是「点击到底能不能用」没法验证。这个入口绕开输入合成、只验证我们自己的这条链。
   * 由 native 侧读环境变量 PRESAGE_SELFTEST=1 后调起。
   */
  /** 合成一次拖拽：走的是和真实操作完全相同的处理链（含 setPosition 搬窗口） */
  function selfTestDrag() {
    const sx = 400; const sy = 400;
    frontLog('selftest 开始模拟拖拽');
    hit.dispatchEvent(new MouseEvent('mousedown',
      { bubbles: true, button: 0, screenX: sx, screenY: sy }));
    for (let i = 1; i <= 8; i++) {
      setTimeout(() => {
        window.dispatchEvent(new MouseEvent('mousemove',
          { bubbles: true, button: 0, screenX: sx + i * 6, screenY: sy + i * 3 }));
      }, i * 40);
    }
    setTimeout(() => {
      window.dispatchEvent(new MouseEvent('mouseup',
        { bubbles: true, button: 0, screenX: sx + 48, screenY: sy + 24 }));
      frontLog('selftest 拖拽结束');
    }, 9 * 40);
  }

  function selfTest(times = 5, mode = '') {
    // 目视检查用：保持提拉形变不动，方便截图确认幅度
    if (mode === 'lift') {
      renderer.setLifted(true);
      frontLog('selftest 保持提拉形变（目视检查）');
      return;
    }
    // 目视检查用：走和右键菜单完全相同的路径打开独立设置窗口
    if (mode === 'settings-window') {
      frontLog('selftest 请求独立设置窗口');
      tauriInvoke('open_settings').catch((e) => {
        frontLog(`独立设置窗口失败：${e && (e.message || e)}`);
      });
      return;
    }
    // 目视检查用：直接打开设置页（窗口内面板）
    if (mode === 'settings') {
      frontLog('selftest 打开设置页');
      settings.open();
      return;
    }
    // 一次性遍历所有状态：逐个停留 2.6 秒，便于逐个截图核对表情
    if (mode === 'states') {
      const names = Object.keys(manifest.states);
      let i = 0;
      const step = () => {
        if (i >= names.length) {
          frontLog('selftest 状态遍历结束');
          forced = null;
          forcedEpoch += 1;
          renderer.setState({ ...arbiter.resolve(), epoch: forcedEpoch });
          return;
        }
        const name = names[i++];
        forced = name;
        forcedEpoch += 1;
        renderer.setState({ anim: name, epoch: forcedEpoch });
        frontLog(`selftest 状态 ${i}/${names.length}: ${name}`);
        setTimeout(step, 2600);
      };
      step();
      return;
    }
    // 目视/自动检查用：把窗口贴到指定边缘（edge / edge:left / edge:right），验证吸附与探头
    if (mode === 'edge' || mode.startsWith('edge:')) {
      const which = mode.includes(':') ? mode.split(':')[1] : 'bottom';
      const win = tauriWindow();
      if (!win) return;
      (async () => {
        try {
          const size = await win.outerSize();
          const b = screenBounds();
          const x = which === 'left' ? b.left
            : which === 'right' ? b.right - size.width : 200;
          const y = which === 'bottom' ? b.bottom - size.height : 200;
          await win.setPosition(tauriPhysicalPosition(Math.round(x), Math.round(y)));
          frontLog(`selftest 已把窗口贴到 ${which} 边缘 (${Math.round(x)},${Math.round(y)})，`
            + `屏幕可用区 ${b.right}x${b.bottom}`);
          lastEdge = null;
          setTimeout(() => { checkEdgePeek(); }, 200);
        } catch (e) { frontLog(`selftest edge 失败 ${e.message}`); }
      })();
      return;
    }
    // 目视检查用：立刻播报一次余额/用量
    if (mode === 'usage') {
      const ok = broadcastUsage(true);
      frontLog(`selftest 用量播报 ${ok ? '已触发' : '无数据可播'}`);
      return;
    }
    // 目视/自动检查用：把窗口挪到光标底下，验证"角色区可交互"的切换真的发生
    if (mode === 'cursor') {
      const win = tauriWindow();
      if (!win) return;
      (async () => {
        try {
          const cur = await win.cursorPosition(); // 物理像素
          const size = await win.outerSize();
          const nx = 0.5; const ny = 0.66;         // 角色大致所在（画布中线偏下）
          const px = Math.round(cur.x - size.width * nx);
          const py = Math.round(cur.y - size.height * ny);
          await win.setPosition(tauriPhysicalPosition(px, py));
          frontLog(`selftest 已把窗口移到光标下 → (${px},${py}) 窗口 ${size.width}x${size.height}`);
        } catch (e) { frontLog(`selftest cursor 失败 ${e.message}`); }
      })();
      return;
    }
    const rect = hit.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height * 0.7;
    for (let i = 0; i < times; i++) {
      hit.dispatchEvent(new MouseEvent('mousedown',
        { bubbles: true, button: 0, screenX: 500 + i, screenY: 400 }));
      window.dispatchEvent(new MouseEvent('mouseup',
        { bubbles: true, button: 0, screenX: 500 + i, screenY: 400 }));
    }
    frontLog(`selftest 已派发 ${times} 次合成点击 @(${Math.round(x)},${Math.round(y)})`);
    setTimeout(() => interactions.flush(), 50);
    setTimeout(selfTestDrag, 1500); // 点击跑完再测拖拽，日志好区分
  }

  /**
   * 切进"独立设置窗口"视图。两种触发方式都支持：
   *   1) Rust 建窗口后用 eval 调用（主路径）
   *   2) 页面自己带 ?view=settings（备选）
   * 只做三件事：标记模式、隐藏桌宠相关元素、打开面板。
   */
  function openSettingsView() {
    if (document.body.classList.contains('settings-window')) {
      settings.open();
      return true;
    }
    document.body.classList.add('settings-window');
    // 这个窗口不该继承桌宠的外观设置（尺寸/置顶），否则它会变成桌宠那么大
    const win = tauriWindow();
    if (win) {
      win.setSize(tauriLogicalSize(560, 660)).catch(() => {});
      win.setAlwaysOnTop(false).catch(() => {});
    }
    settings.open();
    frontLog('已切换到独立设置视图');
    return true;
  }

  window.PresagePet = {
    arbiter, bubbles, lib, renderer, feed, parseLine, demo, live,
    interactions, playTransient, pointer, selfTest, settings,
    broadcastUsage, setUsageBroadcast, openSettingsView,
    /**
     * native 侧让页面显示一条**常驻提示**（目前只有"托盘被系统拒绝"用）。
     *
     * 为什么需要：托盘图标是 v1 里唯一的可靠入口，而它在这台机器上被
     * ACCESS_DENIED 拒掉。托盘没了，用户就只剩"右键角色"这一条路，
     * 但他并不知道 —— 所以要有人主动告诉他，而不是让他去找一个不存在的小图标。
     */
    notice: (text) => {
      if (!text) return false;
      frontLog(`notice ${text}`);
      // WAITING 类的 expiresAt 是 null（不自动过期），ref 保证只留一条。
      bubbles.push({
        kind: BUBBLE.WAITING, title: '托盘不可用', text: String(text),
        agent: 'presage', ref: 'tray-unavailable',
      });
      return true;
    },
    // 供设置窗口通过 Rust 转发调用：应用一份外观到**桌宠窗口自己**
    applyAppearanceFromSettings: (json) => {
      let patch = {};
      try { patch = typeof json === 'string' ? JSON.parse(json) : json; } catch { patch = {}; }
      frontLog(`收到设置页的外观改动 ${JSON.stringify(patch)}`);
      return applyAppearance(patch);
    },
  };
}

/** 脚本化的假事件源，让状态机自己跑一遍，肉眼验证每个动画 */
class DemoSource {
  constructor(send) {
    this.send = send;
    this.agent = 'codex';
    this.sessionId = 'demo-1';
    this.turnId = 'turn-1';
    this.timer = null;
    this.step = 0;
  }

  start() {
    this.timer = setInterval(() => this.next(), 4000);
    setTimeout(() => this.next(), 800);
  }

  stop() {
    clearInterval(this.timer);
  }

  next() {
    const t = (kind, payload = {}, agent = this.agent, sessionId = this.sessionId) =>
      this.send(makeEvent(agent, kind, payload, sessionId));

    switch (this.step++ % 7) {
      case 0:
        t(KIND.TURN_START, { turnId: this.turnId, model: 'demo' });
        break;
      case 1:
        t(KIND.TOOL_CALL, { turnId: this.turnId, tool: 'pwsh', callId: 'c1' });
        break;
      case 2:
        t(KIND.TOOL_RESULT, { callId: 'c1', ok: true });
        break;
      case 3:
        t(KIND.APPROVAL_REQUEST, { approvalId: 'a1', summary: '要执行 git push' });
        break;
      case 4:
        t(KIND.APPROVAL_RESOLVED, { approvalId: 'a1', decision: 'allow' });
        break;
      case 5:
        t(KIND.ERROR, { message: '命令返回非零退出码' });
        break;
      default:
        t(KIND.TURN_END, { turnId: this.turnId, status: 'ok', summary: '这一轮改完了' });
        break;
    }
  }

  emitApproval() {
    this.send(makeEvent('dsh', KIND.APPROVAL_REQUEST,
      { approvalId: `x${Date.now()}`, summary: '要写入工作区外文件' }, 'demo-dsh'));
  }

  emitError() {
    this.send(makeEvent(this.agent, KIND.ERROR, { message: '手动触发的错误' }, this.sessionId));
  }

  emitDone() {
    this.send(makeEvent(this.agent, KIND.TURN_END,
      { turnId: this.turnId, status: 'ok', summary: '手动触发的完成' }, this.sessionId));
  }
}

boot().catch((e) => {
  // 启动失败必须进日志 —— 之前这里只写 DOM，结果 native 日志一片空白，
  // 桌面窗口"什么都没有"却查不出原因（实测被这个坑了很久）。
  frontLog(`BOOT-FAILED ${(e && (e.stack || e.message)) || JSON.stringify(e) || String(e)}`);
  document.body.innerHTML = `<pre style="color:#c00;font:12px monospace">启动失败: ${e.message}</pre>`;
});
