/**
 * 指针交互桥：点击穿透遮罩 / 拖拽 / 右键菜单 / 位置记忆。
 *
 * 为什么遮罩要前端算：只有前端知道精灵图的 alpha（角色是不规则形状，不能用矩形近似）
 * 以及气泡的 DOM 布局。算完压成 64×64 的归一化格子推给 Rust，与 DPI 无关。
 *
 * 在浏览器里（没有 Tauri 全局）自动降级为 no-op，这样其余部分仍能在浏览器调试。
 */

const TAURI = typeof window !== 'undefined' ? window.__TAURI__ : null;
export const isTauri = Boolean(TAURI && TAURI.core && TAURI.core.invoke);

/** Tauri 2 把 PhysicalPosition 放在 dpi 命名空间下；窗口命名空间不一定再导出它 */
function physicalPosition(x, y) {
  const Pos = (TAURI && TAURI.dpi && TAURI.dpi.PhysicalPosition)
    || (TAURI && TAURI.window && TAURI.window.PhysicalPosition)
    || null;
  return Pos ? new Pos(x, y) : { x, y };
}

/** 给别的模块用：不要在 main.js 里直接摸 TAURI，它不是全局变量（踩过 TDZ/未定义的坑） */
export function tauriWindow() {
  return isTauri ? TAURI.window.getCurrentWindow() : null;
}

/** 调 native 命令。**必须走这里**：main.js 里写 TAURI 会抛 "TAURI is not defined"，
 *  而那个错被 catch 吞掉后表现为"静默回落到演示数据"——极难发现（实测被用户抓到）。 */
export async function tauriInvoke(cmd, args) {
  if (!isTauri) throw new Error('不在 Tauri 环境里');
  return TAURI.core.invoke(cmd, args);
}

export function tauriPhysicalSize(w, h) {
  const S = (TAURI && TAURI.dpi && TAURI.dpi.PhysicalSize)
    || (TAURI && TAURI.window && TAURI.window.PhysicalSize)
    || null;
  return S ? new S(w, h) : { width: w, height: h };
}

export function tauriPhysicalPosition(x, y) {
  return physicalPosition(x, y);
}

/** 界面尺寸一律用逻辑像素：本机是 200% 缩放，按物理传会得到一半大的窗口（踩过） */
export function tauriLogicalSize(w, h) {
  const S = (TAURI && TAURI.dpi && TAURI.dpi.LogicalSize)
    || (TAURI && TAURI.window && TAURI.window.LogicalSize)
    || null;
  return S ? new S(w, h) : { width: w, height: h };
}

const COLS = 64;
const ROWS = 64;
const ALPHA_THRESHOLD = 24;
/** 轮廓会随动画帧变化，低频重算即可 */
const REFRESH_MS = 500;
const POS_KEY = 'presage-pet.position';

/**
 * 算右键菜单该放哪。
 *
 * 为什么需要它：桌宠窗口只比"角色 + 一点余量"大一点（宽 = 角色显示宽度 + 140，
 * 高 = 角色实际占高 + 气泡区），而右键菜单本身约有 150px 高。v1.1 之前这里只有
 * `Math.min(e.clientX, innerWidth - 140)` 这种**写死常量**的夹取，于是：
 *   * 在最矮的窗口尺寸下，菜单底部会超出窗口 → 被窗口裁掉
 *     （用户实测："在小人不同高度右键会影响选项栏是否完全呈现"）；
 *   * 常量 140/120 和菜单真实尺寸（约 140x150）对不上，右边也会被切。
 *
 * 规则：优先放在光标右下方；下方放不下就翻到上方；两个轴最后都夹进窗口。
 * 抽成纯函数是为了能单测（见 app/test/logic.test.mjs）。
 */
export function placeMenu(cursorX, cursorY, menuW, menuH, winW, winH, margin = 4) {
  const maxX = Math.max(margin, winW - menuW - margin);
  const maxY = Math.max(margin, winH - menuH - margin);
  let x = cursorX;
  if (x + menuW + margin > winW) x = cursorX - menuW; // 右边放不下 → 翻到左边
  let y = cursorY;
  if (y + menuH + margin > winH) y = cursorY - menuH; // 下面放不下 → 翻到上面
  return {
    x: Math.min(Math.max(x, margin), maxX),
    y: Math.min(Math.max(y, margin), maxY),
  };
}

/**
 * 当前窗口的 Tauri label（`main` / `settings`）；浏览器里返回空串。
 *
 * 为什么需要它：判断"我是不是独立设置窗口"**不能只看 URL 参数**。
 * native 侧的 `WebviewUrl::App` 不能带查询串（会被当文件路径 → 白屏），
 * 所以设置窗口拿到的是一个普通 index.html，`?view=settings` 永远不存在。
 * 按 label 判断才是可靠依据 —— 这个判据出错时的现象很隐蔽：
 * 拖设置里的"大小"滑块会**把设置窗口自己变大变小**，而小人要重启才生效
 * （用户实测报了两轮）。
 *
 * label 是同步可读的属性（Tauri 2 的 Window.label），失败就返回空串。
 */
export function windowLabel() {
  if (!isTauri) return '';
  try {
    const w = TAURI.window.getCurrentWindow();
    return String(w?.label || '');
  } catch {
    return '';
  }
}

/** 前端诊断信息 → native stdout（＝ runtime/pet.out.log）。页面没有别的可读输出通道。 */
export function frontLog(msg) {
  if (isTauri) {
    TAURI.core.invoke('front_log', { msg: String(msg) }).catch(() => {});
  }
  console.log('[front]', msg);
}

export class PointerBridge {
  constructor({ canvas, hit, onLog, onGesture, onLift, onClear, onSettings, onDragEnd } = {}) {
    this.canvas = canvas;
    /**
     * 可见的占位盒：坐标归一化与拖拽事件都基于它。
     * canvas 已移出 DOM（只用于取像素），它没有布局盒可用 ✗。
     */
    this.hit = hit || canvas;
    this.onLog = onLog || (() => {});
    this.onGesture = onGesture || (() => {});
    this.onLift = onLift || (() => {});
    this.onClear = onClear || null;
    this.onSettings = onSettings || null;
    this.onDragEnd = onDragEnd || null;
    this.win = null;
    this.pending = null;
    this.lastBits = null;
    /** 穿透是否启用（设置页可关） */
    this.enabled = true;
  }

  async init() {
    if (!isTauri) {
      this.onLog('浏览器模式：点击穿透 / 拖拽不可用（其余功能正常）');
      return;
    }
    this.win = TAURI.window.getCurrentWindow();
    await this.restorePosition();
    this.attachDrag();
    this.attachContextMenu();
    this.attachPositionMemory();
    this.invalidate();
    setInterval(() => this.invalidate(), REFRESH_MS);
  }

  /** 请求重算并推送遮罩（合并到一次，避免抖动） */
  /** 设置页里的"点击穿透"开关。关掉 = 整窗可交互（调试或不想让它穿透时用） */
  async setEnabled(on) {
    this.enabled = Boolean(on);
    if (!isTauri || !this.win) return;
    await this.setMode(this.enabled ? 'auto' : 'interactive');
    await this.push();
  }

  invalidate() {
    if (!isTauri || this.pending) return;
    this.pending = setTimeout(() => {
      this.pending = null;
      this.push().catch(() => {});
    }, 120);
  }

  /**
   * 把「精灵图不透明像素 + 气泡矩形」压成 cols×rows 的格子。
   * 角色是圆润大块头，64×64 的粒度足够（比多边形命中便宜得多，收益几乎一样）。
   */
  buildMask() {
    const bits = new Uint8Array(COLS * ROWS);
    const winW = Math.max(1, window.innerWidth);
    const winH = Math.max(1, window.innerHeight);

    // 用户在设置里关掉了穿透 → 整窗可交互（遮罩全填 + 强制交互模式）
    if (this.enabled === false) {
      bits.fill(1);
      return { cols: COLS, rows: ROWS, bits };
    }

    // 设置页开着时整窗都要可交互：对话框是可滚动的表单，
    // 让它的空白处穿透会让用户"点不到按钮"却查不出原因。
    const dlg = document.getElementById('settings');
    if (dlg && dlg.open) {
      bits.fill(1);
      return { cols: COLS, rows: ROWS, bits };
    }

    const markRect = (x, y, w, h) => {
      const c0 = Math.max(0, Math.floor((x / winW) * COLS));
      const c1 = Math.min(COLS - 1, Math.ceil(((x + w) / winW) * COLS) - 1);
      const r0 = Math.max(0, Math.floor((y / winH) * ROWS));
      const r1 = Math.min(ROWS - 1, Math.ceil(((y + h) / winH) * ROWS) - 1);
      for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) bits[r * COLS + c] = 1;
      }
    };

    // 1) 精灵图：按 alpha 采样
    const cv = this.canvas;
    if (cv && cv.width > 0 && cv.height > 0) {
      // 像素来自 canvas（已移出 DOM），但坐标要按**可见盒**归一化
      const rect = (this.hit || cv).getBoundingClientRect();
      try {
        const ctx = cv.getContext('2d');
        const data = ctx.getImageData(0, 0, cv.width, cv.height).data;
        const stepX = Math.max(1, Math.floor(cv.width / 160));
        const stepY = Math.max(1, Math.floor(cv.height / 160));
        const cellW = (rect.width / cv.width) * stepX;
        const cellH = (rect.height / cv.height) * stepY;
        for (let y = 0; y < cv.height; y += stepY) {
          for (let x = 0; x < cv.width; x += stepX) {
            if (data[(y * cv.width + x) * 4 + 3] > ALPHA_THRESHOLD) {
              markRect(
                rect.left + (x / cv.width) * rect.width,
                rect.top + (y / cv.height) * rect.height,
                cellW, cellH,
              );
            }
          }
        }
      } catch (e) {
        this.onLog('遮罩采样失败：' + e.message);
      }
    }

    // 2) 气泡：DOM 元素，整块算可点
    for (const el of document.querySelectorAll('.bubble, #ctx-menu')) {
      const r = el.getBoundingClientRect();
      if (r.width > 0 && r.height > 0) markRect(r.left, r.top, r.width, r.height);
    }

    return { cols: COLS, rows: ROWS, bits };
  }

  async push() {
    const { cols, rows, bits } = this.buildMask();
    // 内容没变就不推，省掉无意义的 IPC
    let same = this.lastBits && this.lastBits.length === bits.length;
    if (same) {
      for (let i = 0; i < bits.length; i++) {
        if (this.lastBits[i] !== bits[i]) { same = false; break; }
      }
    }
    if (same) return;
    this.lastBits = bits;
    await TAURI.core.invoke('set_hitmask', { cols, rows, bits: Array.from(bits) });
  }

  /** seconds 必须给默认值：Rust 侧是 u64 必填，传 undefined 会被 IPC 直接拒掉 */
  async setMode(mode, seconds = 0) {
    if (!isTauri) return;
    await TAURI.core.invoke('set_pointer_mode', { mode, seconds: Number(seconds) || 0 });
  }

  // ---------------- 拖拽 / 点击 / 长按 ----------------
  /**
   * 关键取舍一：按下后**移动超过阈值**才开始拖拽，位移不够就在抬起时算一次点击。
   * 如果 mousedown 直接开始拖拽，点击事件会被吞掉，气泡点击和彩蛋就全都没法用了。
   *
   * 关键取舍二：**不用 Tauri 的 startDragging()**。它在 Windows 上会进入 OS 的模态
   * 拖拽循环（SendMessage(WM_NCLBUTTONDOWN)），期间 WebView 的 requestAnimationFrame
   * 被卡住 —— 表现就是「能拖动窗口，但提拉动画完全不动」。
   * 改成自己按指针位移调用 setPosition：渲染循环照常跑，形变才看得见。
   */
  attachDrag() {
    const target = this.hit || this.canvas;
    if (!target) return;
    const THRESHOLD = 4;
    const LONG_PRESS_MS = 900;
    let press = null;
    let longPressTimer = null;
    let drag = null;
    let lifted = false;

    const stopDrag = () => {
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      if (lifted) { lifted = false; this.onLift(false); }
      drag = null;
      press = null;
    };

    target.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      press = { x: e.screenX, y: e.screenY, t: performance.now() };
      longPressTimer = setTimeout(() => {
        if (press) this.onGesture({ type: 'longPress', durationMs: LONG_PRESS_MS });
      }, LONG_PRESS_MS);
    });

    window.addEventListener('mousemove', async (e) => {
      if (drag) {
        // 自己搬窗口：screenX 是 CSS 像素，窗口位置是物理像素，要乘缩放
        const scale = window.devicePixelRatio || 1;
        const nx = drag.winX + Math.round((e.screenX - drag.pointerX) * scale);
        const ny = drag.winY + Math.round((e.screenY - drag.pointerY) * scale);
        // 失败一定要说出来：之前这里 .catch(()=>{}) 把「窗口根本没动」吞掉了
        this.win.setPosition(physicalPosition(nx, ny))
          .then(() => { if (!this._movedOnce) { this._movedOnce = true; this.onLog(`搬窗口生效 → (${nx},${ny})`); } })
          .catch((err) => this.onLog(`搬窗口失败：${err && err.message}`));
        return;
      }
      if (!press) return;
      if (Math.hypot(e.screenX - press.x, e.screenY - press.y) < THRESHOLD) return;
      if (longPressTimer) { clearTimeout(longPressTimer); longPressTimer = null; }
      const pos = await this.win.outerPosition().catch(() => null);
      if (!pos) return;
      drag = { pointerX: e.screenX, pointerY: e.screenY, winX: pos.x, winY: pos.y };
      lifted = true;
      this.onLift(true);
    });

    window.addEventListener('mouseup', (e) => {
      const wasPress = press;
      const wasDrag = Boolean(drag);
      const dt = wasPress ? performance.now() - wasPress.t : 0;
      stopDrag();
      if (wasDrag) {
        this.savePosition();
        this.onDragEnd?.();   // 交给上层做"靠边吸附 + 探头"
      }
      if (wasPress && !wasDrag && e.button === 0) {
        this.onGesture({ type: 'click', durationMs: dt });
      }
    });
  }

  // ---------------- 位置记忆 ----------------
  attachPositionMemory() {
    // 自己搬窗口时 onMoved 会高频触发，写 localStorage 要节流
    let last = 0;
    try {
      this.win.onMoved(({ payload }) => {
        const now = Date.now();
        if (now - last < 400) return;
        last = now;
        localStorage.setItem(POS_KEY, JSON.stringify({ x: payload.x, y: payload.y }));
      });
    } catch { /* 忽略 */ }
  }

  /** 拖拽结束时补记一次，免得节流把最终位置丢掉 */
  async savePosition() {
    try {
      const pos = await this.win.outerPosition();
      localStorage.setItem(POS_KEY, JSON.stringify({ x: pos.x, y: pos.y }));
    } catch { /* 忽略 */ }
  }

  async restorePosition() {
    try {
      const raw = localStorage.getItem(POS_KEY);
      if (!raw) return;
      const { x, y } = JSON.parse(raw);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      // 夹回可见区域：歪掉的记忆位置会把桌宠丢到屏幕外，用户再也找不到它（实测发生过）
      const dpr = window.devicePixelRatio || 1;
      const size = await this.win.outerSize();
      const sw = (window.screen?.availWidth || 1280) * dpr;
      const sh = (window.screen?.availHeight || 800) * dpr;
      const margin = 60 * dpr; // 至少留这么多在屏幕内
      const cx = Math.min(Math.max(x, -size.width + margin), sw - margin);
      const cy = Math.min(Math.max(y, 0), sh - margin);
      await this.win.setPosition(physicalPosition(Math.round(cx), Math.round(cy)));
    } catch { /* 忽略，用默认位置 */ }
  }

  // ---------------- 右键菜单 ----------------
  attachContextMenu() {
    const menu = document.getElementById('ctx-menu');
    if (!menu) return;
    // 菜单高度是常量（5 个按钮），量一次就够；量到 0 时不要缓存
    let menuH = 0;
    const hide = () => {
      if (menu.hidden) return;
      menu.hidden = true;
      this.invalidate();
      this.onMenuClose?.();
    };
    /**
     * 量出菜单真实尺寸后摆位。
     * 必须在 `hidden = false` 之后读：display:none 时量到的是 0。
     * 再在下一帧量一次并重摆 —— 字体/缩放/多语言都可能让它在首帧后才定下来。
     */
    const place = (clientX, clientY) => {
      const w = menu.offsetWidth || 140;
      const h = menu.offsetHeight || 150;
      if (menu.offsetHeight > 0) menuH = menu.offsetHeight;
      const { x, y } = placeMenu(clientX, clientY, w, h, window.innerWidth, window.innerHeight);
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
    };
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      menu.hidden = false;
      place(e.clientX, e.clientY);
      // 通知上层撑开窗口：菜单比窗口空档还高时，必须先把窗口做高（见 main.js）
      this.onMenu?.(menuH || menu.offsetHeight || 160);
      requestAnimationFrame(() => {
        place(e.clientX, e.clientY);
        this.invalidate();
      });
      this.invalidate();
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target)) hide();
    });
    menu.addEventListener('click', async (e) => {
      const action = e.target?.dataset?.action;
      if (!action) return;
      hide();
      if (action === 'quit') {
        try { await this.win.close(); } catch { /* 忽略 */ }
      } else if (action === 'clear') {
        this.onClear?.();
      } else if (action === 'settings') {
        this.onSettings?.();
      } else if (action === 'through') {
        // 强制穿透必须自动回退，否则用户再也点不到它
        await this.setMode('passthrough', 5);
        this.onLog('强制穿透 5 秒');
      } else if (action === 'interactive') {
        await this.setMode('interactive', 60);
        this.onLog('强制可交互 60 秒');
      }
    });
    window.addEventListener('resize', () => this.invalidate());
  }
}
