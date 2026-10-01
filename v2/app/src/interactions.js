/**
 * 点击互动与彩蛋注册表。
 *
 * 设计目标：**以后加彩蛋不需要改核心代码**。
 *   - 规则用 register() 声明式登记（点击次数 / 时间窗 / 长按）
 *   - 触发的表现交给外部注入的 play(state, ms)
 *   - 状态还没有素材时 play() 安静跳过并留一行日志
 *
 * 于是 v1.x 想加「连点 20 次会晕」，只需要两步：
 *   ① 把素材丢进 avatar_baseline/ 并在 tools/build_sprites.py 里加一行状态配置
 *   ② 在这里 register 一条规则
 * 渲染器、仲裁器、气泡队列一行都不用动。
 *
 * 一个关键取舍：**判定要延后聚合**。如果每来一次点击就立刻判定，
 * 「双击打招呼」会在第 2 下抢先命中并进入冷却，于是「连点 5 下」永远不可达。
 * 所以点击先入队，停止点击 MATCH_DELAY_MS 之后统一判定，取**要求次数最高**的那条。
 */

/** 停止点击多久之后开始判定 */
const MATCH_DELAY_MS = 350;

export class Interactions {
  /**
   * @param {(state: string, durationMs: number) => boolean} play 播放一个瞬时状态
   * @param {(name: string, detail?: object) => void} onEvent 事件回调（调试/上报）
   */
  constructor({ play, onEvent, matchDelayMs = MATCH_DELAY_MS } = {}) {
    this.play = play || (() => false);
    this.onEvent = onEvent || (() => {});
    this.matchDelayMs = matchDelayMs;
    this.rules = [];
    this.clicks = [];
    this.cooldownUntil = 0;
    this.matchTimer = null;
  }

  register(rule) {
    const full = { windowMs: 3000, durationMs: 2000, ...rule };
    this.rules.push(full);
    return full.id;
  }

  /**
   * v1 的默认彩蛋位。这些状态**目前都还没有素材**，play() 会安静跳过——
   * 这正是为了让「以后补素材」不必改任何逻辑。
   */
  registerDefaults() {
    // 双击 / 快速两下：打招呼
    this.register({ id: 'hello', type: 'clickCount', count: 2, windowMs: 420,
      play: 'egg_hello', durationMs: 1600 });
    // 顺手拍五下
    this.register({ id: 'pat', type: 'clickCount', count: 5, windowMs: 3000,
      play: 'egg_pat', durationMs: 2200 });
    // 戳烦了
    this.register({ id: 'annoyed', type: 'clickCount', count: 10, windowMs: 6000,
      play: 'egg_annoyed', durationMs: 2600 });
    // 连点 20 下：晕
    this.register({ id: 'dizzy', type: 'clickCount', count: 20, windowMs: 8000,
      play: 'egg_dizzy', durationMs: 3000 });
    // 长按不放：被拎住
    this.register({ id: 'hold', type: 'longPress', ms: 900,
      play: 'egg_hold', durationMs: 0 });
  }

  /** 一次点击手势（按下→抬起且位移很小） */
  feed(gesture) {
    const now = Date.now();
    if (now < this.cooldownUntil) return;

    if (gesture.type === 'click') {
      this.clicks.push(now);
      this.clicks = this.clicks.filter((t) => now - t <= 8000);
      // 延后聚合：等用户停手再判定，否则双击会抢在连点前面命中
      if (this.matchTimer) clearTimeout(this.matchTimer);
      this.matchTimer = setTimeout(() => this.flush(), this.matchDelayMs);
    } else if (gesture.type === 'longPress') {
      this.clicks = [];
      this.fire(this.rules.find((r) => r.type === 'longPress'), now, gesture);
    }
  }

  /** 立即判定（也供测试同步调用） */
  flush() {
    if (this.matchTimer) { clearTimeout(this.matchTimer); this.matchTimer = null; }
    this.matchClicks(Date.now());
  }

  matchClicks(now) {
    const candidates = this.rules
      .filter((r) => r.type === 'clickCount')
      .filter((r) => this.clicks.filter((t) => now - t <= r.windowMs).length >= r.count)
      .sort((a, b) => b.count - a.count); // 命中就取要求次数最高的那条
    if (candidates.length) this.fire(candidates[0], now, { type: 'clickCount' });
  }

  fire(rule, now, gesture) {
    if (!rule) return;
    this.onEvent('egg', { id: rule.id, trigger: gesture.type });
    const played = this.play(rule.play, rule.durationMs);
    // 无论有没有素材都进入冷却：否则连点一次会反复触发同一条规则
    this.cooldownUntil = now + Math.max(1200, rule.durationMs) + 600;
    this.clicks = [];
    if (!played) {
      console.info(`[interactions] 规则「${rule.id}」命中，但状态 ${rule.play} 还没有素材，已跳过`);
    }
  }

  /** 供设置页/调试用：当前登记的彩蛋清单 */
  list() {
    return this.rules.map(({ id, type, count, windowMs, ms, play }) =>
      ({ id, type, count, windowMs, ms, play }));
  }
}
