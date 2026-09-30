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

/** 夹到合法区间，防止手改 localStorage 把窗口弄成 0 像素 */
export function clampAppearance(cfg) {
  const size = Number(cfg.size);
  const opacity = Number(cfg.opacity);
  return {
    size: Number.isFinite(size) ? Math.max(80, Math.min(480, Math.round(size))) : DEFAULTS.size,
    opacity: Number.isFinite(opacity) ? Math.max(0.2, Math.min(1, opacity)) : DEFAULTS.opacity,
    alwaysOnTop: cfg.alwaysOnTop !== false,
    clickThrough: cfg.clickThrough !== false,
  };
}

/**
 * 画布尺寸 → 窗口尺寸。
 * 画布只包住角色（宽 = 角色宽，高 = 角色宽 × (1+留白)）；
 * 窗口再额外留出气泡与折叠计数的地方 —— 这两个数是从当前 200 宽的布局量出来的。
 */
export function windowSizeFor(canvasW) {
  const canvasH = Math.round(canvasW * 1.34); // 和 renderer 的 HEADROOM 对应
  return { w: canvasW + 140, h: canvasH + 202 };
}
