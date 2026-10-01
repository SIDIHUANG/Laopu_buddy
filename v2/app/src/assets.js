/**
 * 精灵图库：按状态懒加载 + LRU。
 *
 * 为什么懒加载：8 个状态全部常驻约 54 MB（256px 格子）。
 * 应用同一时刻只显示一个状态，所以只保留最近用到的几个即可。
 */

const MAX_RESIDENT = 3;

export class SpriteLibrary {
  /**
   * @param {string} base   资源根路径，例如 '/assets/'
   * @param {object} manifest  assets/manifest.json 的内容
   */
  constructor(base, manifest) {
    this.base = base.endsWith('/') ? base : base + '/';
    this.manifest = manifest;
    this.cell = manifest.cell;
    this.resident = new Map(); // name -> {img, frames}
    this.pending = new Map();
  }

  get states() {
    return Object.keys(this.manifest.states);
  }

  info(name) {
    return this.manifest.states[name] || null;
  }

  async load(name) {
    if (this.resident.has(name)) {
      const entry = this.resident.get(name);
      this.resident.delete(name); // 触碰即刷新 LRU 顺序
      this.resident.set(name, entry);
      return entry;
    }
    if (this.pending.has(name)) return this.pending.get(name);

    const info = this.info(name);
    if (!info) throw new Error(`未知状态: ${name}`);
    const p = new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const frames = Math.max(1, Math.round(img.width / this.cell));
        const entry = { img, frames };
        this.resident.set(name, entry);
        this.pending.delete(name);
        this.evict();
        resolve(entry);
      };
      img.onerror = () => {
        this.pending.delete(name);
        reject(new Error(`加载失败: ${info.file}`));
      };
      img.src = this.base + info.file;
    });
    this.pending.set(name, p);
    return p;
  }

  evict() {
    while (this.resident.size > MAX_RESIDENT) {
      const oldest = this.resident.keys().next().value;
      this.resident.delete(oldest);
    }
  }

  /** 取得该状态第 index 帧的源矩形（超出则按播放语义环绕） */
  sourceRect(name, index) {
    const entry = this.resident.get(name);
    if (!entry) return null;
    const frames = entry.frames;
    const i = ((index % frames) + frames) % frames;
    return { img: entry.img, sx: i * this.cell, sy: 0, sw: this.cell, sh: this.cell };
  }

  /**
   * 按播放语义把「经过的帧序号」映射成实际帧号。
   * loop        0,1,2..n-1,0,1..
   * pingpong    0,1,2..n-1,n-2..1,0,1..   ← 往复运动无缝，不需要首尾帧相同
   * once        0,1,2..n-1,n-1,n-1..      ← 播完停住
   * once_loop   0,1..loopFrom-1, 然后 loopFrom..n-1 循环
   *             ← 用于「一次性动作 + 尾部循环」的素材。
   *               例：working 每次进入都要重播「拿出电脑开始打字」，
   *               播完停在打字循环里，而不是整段重复那个拿出电脑的动作。
   *               进入状态时渲染器会把 tick 归零，所以动作会自动重播。
   */
  frameIndex(name, tick) {
    const info = this.info(name);
    const entry = this.resident.get(name);
    const n = entry ? entry.frames : (info?.frames ?? 1);
    if (n <= 1) return 0;
    const mode = info?.mode || 'loop';
    if (mode === 'pingpong') {
      const period = 2 * n - 2;
      const t = ((tick % period) + period) % period;
      return t < n ? t : period - t;
    }
    if (mode === 'once') return Math.min(tick, n - 1);
    if (mode === 'once_loop') {
      const from = Math.max(0, Math.min(info?.loopFrom ?? 0, n - 1));
      if (tick < from) return tick;
      const span = n - from;
      return span <= 1 ? n - 1 : from + ((tick - from) % span);
    }
    return ((tick % n) + n) % n;
  }
}
