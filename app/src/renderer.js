/**
 * Canvas 精灵图渲染器。
 *
 * 只做三件事：
 *   1. 画当前状态（播放语义在 SpriteLibrary.frameIndex 里，这里不关心）
 *   2. 状态切换时做交叉淡化 —— 否则不同姿势/比例之间硬切会很突兀
 *   3. 被拎起来时做提拉形变 —— 拖拽时给一点「悬空」的反馈
 */

/** 状态切换的交叉淡化时长。太短没用，太长会糊成一团 */
const FADE_MS = 180;

/**
 * 提拉形变参数。第一版太含蓄（stretch 6% / 倾 3.5°），实际几乎看不出被拎起来，
 * 所以这里放大到一眼可见，并加了「拎在手里会晃」的摆动。
 */
const LIFT = {
  stretchY: 0.15,  // 纵向拉长 15%
  squashX: 0.08,   // 横向收窄 8%（体积守恒的挂坠感）
  tiltDeg: -8,     // 基础倾斜
  liftY: 0.11,     // 整体升高（占精灵格比例）
  swayDeg: 4.5,    // 拎着时的摆动幅度
  swayHz: 0.75,    // 摆动频率
};

/**
 * 画布上方预留的空白比例。提拉最狠时角色顶部会上移约
 * (stretchY + liftY) × size ≈ 26% × 200px，留 34% 才不会被裁到头顶。
 */
const HEADROOM = 0.34;

export class PetRenderer {
  constructor(canvas, lib, { size = 200 } = {}) {
    this.canvas = canvas;
    // willReadFrequently：指针遮罩要不断 getImageData 读 alpha，
    // 不开这个每次都会从 GPU 回读，白白浪费。
    this.ctx = canvas.getContext('2d', { willReadFrequently: true });
    this.lib = lib;
    this.size = size;
    this.state = null;
    this.epoch = -1;
    this.tick = 0;
    this.acc = 0;
    this.last = 0;
    this.running = false;

    // 交叉淡化：保存上一状态的画面快照
    this.prev = document.createElement('canvas');
    this.prevCtx = this.prev.getContext('2d');
    this.fade = 1; // 1 = 淡化已完成
    // 提拉：0 = 站在地上，1 = 被完全拎起
    this.lift = 0;
    this.liftTarget = 0;

    this.resize();
    window.addEventListener('resize', () => this.resize());
  }

  /**
   * 运行时改角色尺寸（设置页的"大小"）。画布、缓存画布、命中遮罩都会跟着走，
   * 所以改完要重新算一次遮罩。
   */
  setSize(px) {
    const next = Math.max(80, Math.min(480, Math.round(px)));
    if (next === this.size) return false;
    this.size = next;
    this.resize();
    this.prev.width = this.canvas.width;
    this.prev.height = this.canvas.height;
    return true;
  }

  resize() {
    const dpr = window.devicePixelRatio || 1;
    this.dpr = dpr;
    // 画布比精灵格高一截：提拉时角色要向上窜 50 多 px，
    // 没有这块留白就会被画布顶边**把头裁掉**（实测踩过）。
    this.height = Math.round(this.size * (1 + HEADROOM));
    this.canvas.width = Math.round(this.size * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.size}px`;
    this.canvas.style.height = `${this.height}px`;
    this.prev.width = this.canvas.width;
    this.prev.height = this.canvas.height;
    this.applyBaseTransform();
  }

  applyBaseTransform() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.ctx.imageSmoothingEnabled = true;
    this.ctx.imageSmoothingQuality = 'high';
  }

  setState(snap) {
    const changed = snap.anim !== this.state || snap.epoch !== this.epoch;
    if (!changed) return;
    // 先抓当前画面，作为淡出的底图
    this.snapshotPrevious();
    this.state = snap.anim;
    this.epoch = snap.epoch;
    this.tick = 0; // 状态切换 → 重新从第 0 帧播（one-shot 必须重播）
    this.acc = 0;
    this.fade = 0;
    this.lib.load(this.state).catch((e) => console.warn('[renderer]', e.message));
    // 兜底：被告知要显示某个状态，就必须真的开始渲染。
    // 曾经因为主流程漏调 start() 导致「气泡在动、角色全白」——这个 if 让它不会再发生。
    if (!this.running) this.start();
  }

  snapshotPrevious() {
    // 还没画过任何东西就不用抓（否则会把空画布淡出来）
    if (this.epoch < 0 || !this.state) return;
    this.prevCtx.setTransform(1, 0, 0, 1, 0, 0);
    this.prevCtx.clearRect(0, 0, this.prev.width, this.prev.height);
    this.prevCtx.drawImage(this.canvas, 0, 0);
  }

  /** 拖拽时调用：进入/退出「被拎起来」的形变 */
  setLifted(on) {
    this.liftTarget = on ? 1 : 0;
  }

  start() {
    if (this.running) return;
    this.running = true;
    const loop = (ts) => {
      const dt = this.last ? Math.min(100, ts - this.last) : 16;
      this.last = ts;
      this.draw(dt);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }

  draw(dt) {
    const { ctx } = this;
    this.elapsed = (this.elapsed || 0) + dt; // 供摆动等周期动画使用
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.size, this.height);
    if (!this.state) return;

    // 时间推进
    this.fade = Math.min(1, this.fade + dt / FADE_MS);
    // 弹簧跟随（带一点过冲），比线性缓动更像"被拎起来"
    const springStep = Math.min(3, dt / 16.7);
    this.liftVel = (this.liftVel || 0) + (this.liftTarget - this.lift) * 0.22 * springStep;
    this.liftVel *= Math.pow(0.78, springStep);
    this.lift += this.liftVel * springStep;

    const info = this.lib.info(this.state);
    const fps = info?.fps ?? 12;
    const step = 1000 / fps;
    this.acc += dt;
    while (this.acc >= step) {
      this.acc -= step;
      this.tick += 1;
    }

    const idx = this.lib.frameIndex(this.state, this.tick);
    const src = this.lib.sourceRect(this.state, idx);

    if (src) {
      const l = Math.max(0, this.lift);
      // 拎起来：整体升高 + 明显拉长 + 倾斜；被拎着时还会左右摆，像挂在手上
      const sway = Math.sin((this.elapsed || 0) / 1000 * LIFT.swayHz * Math.PI * 2)
        * LIFT.swayDeg * l;
      const sy = 1 + LIFT.stretchY * l;
      const sx = 1 - LIFT.squashX * l;
      const rot = (LIFT.tiltDeg + sway) * l * (Math.PI / 180);
      const dy = -this.size * LIFT.liftY * l;
      ctx.save();
      // 支点放在**画布底部**（不是精灵格底部），这样上方留白真正变成可用的提拉空间
      ctx.translate(this.size / 2, this.height);
      ctx.rotate(rot);
      ctx.scale(sx, sy);
      ctx.translate(0, dy);
      ctx.drawImage(src.img, src.sx, src.sy, src.sw, src.sh,
        -this.size / 2, -this.size, this.size, this.size);
      ctx.restore();
    }

    // 上一状态淡出（叠在新画面上，形成交叉淡化）
    if (this.fade < 1) {
      ctx.save();
      ctx.globalAlpha = 1 - this.fade;
      ctx.setTransform(1, 0, 0, 1, 0, 0); // prev 是设备像素，1:1 对齐
      ctx.drawImage(this.prev, 0, 0);
      ctx.restore();
      ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    }
  }
}
