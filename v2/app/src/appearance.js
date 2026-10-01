/**
 * 外观类设置：大小、透明度、置顶、穿透开关。
 *
 * 这些是**纯本机表现偏好**，存 localStorage 就够（不进 runtime/usage.json，
 * 也不必让桥接进程知道）。放在单独模块里是因为：它们要同时驱动渲染器、
 * Tauri 窗口和命中遮罩三处，散在 main.js 里很容易改漏一处。
 */

const KEY = 'presage-pet.appearance';

export const DEFAULTS = {
  /** 角色显示宽度（CSS px）。基准 200 是素材归一化的目标尺寸 */
  size: 200,
  /** 整只宠物的不透明度 */
  opacity: 1,
  alwaysOnTop: true,
  /** 关掉就整窗可交互（调试、或不想让它穿透时用） */
  clickThrough: true,
};

/**
 * 角色实际占的高度 ÷ 显示宽度。
 *
 * 依据：`python tools/measure_sprites.py` 量过 12 条精灵图，各状态非透明像素高度
 * 占格子（cell=256）的比例是：
 *     working/thinking/error/peek_right/peek_left 0.875   ← 最高
 *     idle/doze 0.871、peek 0.930、celebrate 0.969（弹跳那一下）
 * 取 0.98 覆盖最高的一帧（celebrate），保证弹跳时头顶也不会被窗口裁掉。
 *
 * ⚠️ 这个数**不能**用格子高度的 1.0 或 1.34：v1 就是按格子算，白白多留了 90px
 *    空白，还把气泡挤到了窗口外面（实测：气泡 y 是负的，用户根本看不见）。
 */
export const CONTENT_SCALE = 0.98;

/**
 * 角色脚底离精灵格底边多少（占格子比例）。
 *
 * 素材管线 `build_sprites.py` 的 `place()` 把角色底边放在 `cell * (1 - margin)`，
 * `margin = 0.04`。所以角色脚底 = 格子底边再往上 4%，这个值同时用于：
 *   * 把可见精灵图对齐到命中盒（CSS `--pet-bg-y`，见 index.html）
 *   * 算窗口底边要给角色留多少空隙
 */
export const MARGIN = 0.04;

/**
 * 气泡区（窗口顶部）要留的高度（CSS px）。
 *
 * 依据：实测最长的气泡（皮肤九宫格 + 两行正文）约 92px 高，再加间距与余量。
 */
export const BUBBLE_SPACE = 116;

/** 角色尺寸下限 / 窗口尺寸下限，避免手改 localStorage 把窗口弄成 0 像素 */
export const MIN_WINDOW = { w: 160, h: 220 };

/**
 * 窗口内设置面板需要的窗口尺寸（CSS px）。
 *
 * 用途：独立设置窗口建不出来时（WebView2 拒绝第二个 WebView 之类），
 * 前端会就地打开 `#settings` 面板做兜底 —— 而那个面板本身按 460px 宽设计、
 * 加上窗口边距需要约 580px。桌宠窗口只有 340px 宽，所以**必须先把窗口放大**，
 * 否则面板会被挤成 92vw≈312px 的一条细缝（实测过：尺寸设了但没生效）。
 */
export const SETTINGS_PANEL = { w: 580, h: 660 };

export function loadAppearance(storage = globalThis.localStorage) {
  try {
    const raw = JSON.parse(storage?.getItem(KEY) || '{}');
    return { ...DEFAULTS, ...raw };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAppearance(cfg, storage = globalThis.localStorage) {
  try { storage?.setItem(KEY, JSON.stringify(cfg)); } catch { /* 忽略 */ }
}

/** 可见屏幕的可用尺寸（CSS px）。优先 avail*（已排除任务栏） */
export function screenWorkArea(scr = globalThis.screen) {
  const w = Number(scr?.availWidth) || Number(scr?.width) || 1280;
  const h = Number(scr?.availHeight) || Number(scr?.height) || 800;
  return { w, h };
}

/**
 * 在给定屏幕可用区域下，角色最大能显示到多少 px。
 *
 * 为什么需要：老代码允许 size 一直调到 480，而窗口高度按 480 算是 845px ——
 * 比 768/800 屏的可用高度还高。窗口放不下时 Tauri 会把它夹到屏幕内，
 * 底部那段（也就是角色的脚）就永远在屏幕外，用户看到的是"她没有脚/半截"。
 * 所以上限必须从屏幕来，而不是从滑块来。
 */
export function maxSizeForScreen(scr = globalThis.screen) {
  const { h } = screenWorkArea(scr);
  const room = h - BUBBLE_SPACE - 16;
  return Math.max(80, Math.min(480, Math.floor(room / CONTENT_SCALE)));
}

/**
 * 画布宽度（= 角色显示宽度）→ 窗口尺寸（逻辑 px）。
 *
 * 窗口高度 = 角色实际占高 + 气泡区，**不再**用精灵格高度（1.34 那套是错的）。
 * 顺带对齐到偶数，避免 200% 缩放下出现半像素模糊。
 */
export function windowSizeFor(canvasW, scr = globalThis.screen) {
  const size = Math.max(80, Math.min(480, Math.round(Number(canvasW) || DEFAULTS.size)));
  const { w: availW, h: availH } = screenWorkArea(scr);
  const contentH = size * CONTENT_SCALE;
  const w = Math.min(Math.round(size + 140), Math.max(MIN_WINDOW.w, availW - 16));
  const h = Math.min(
    Math.round(contentH + BUBBLE_SPACE),
    Math.max(MIN_WINDOW.h, availH - 16),
  );
  return { w: Math.max(MIN_WINDOW.w, w), h: Math.max(MIN_WINDOW.h, h) };
}

/** 夹到合法区间，防止手改 localStorage 把窗口弄成 0 像素 */
export function clampAppearance(cfg, scr = globalThis.screen) {
  const size = Number(cfg.size);
  const opacity = Number(cfg.opacity);
  const maxSize = maxSizeForScreen(scr);
  return {
    size: Number.isFinite(size)
      ? Math.max(80, Math.min(maxSize, Math.round(size)))
      : Math.min(DEFAULTS.size, maxSize),
    opacity: Number.isFinite(opacity) ? Math.max(0.2, Math.min(1, opacity)) : DEFAULTS.opacity,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    clickThrough: cfg.clickThrough !== false,
  };
}
