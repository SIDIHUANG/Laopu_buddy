/**
 * 气泡队列（对应评估文档 Q9）。
 *
 * 差异化过期：
 *   等待审批/输入  不过期，必须用户手动关（或用 approval/resolved 主动撤回）
 *   出错           常驻，直到用户点开或该会话出现新的成功事件
 *   完成           8 秒后淡出；新通知入队时旧的完成气泡降级为折叠态而不是消失
 *   折叠态         最多保留 5 条，超出淘汰最旧
 *
 * 排序：等待类整体按到达时间置顶（反正都不过期，先到的先答），其余按优先级、组内按时间。
 */

export const BUBBLE = { WAITING: 'waiting', ERROR: 'error', DONE: 'done', INFO: 'info' };

const PRIORITY = { [BUBBLE.WAITING]: 100, [BUBBLE.ERROR]: 80, [BUBBLE.DONE]: 40, [BUBBLE.INFO]: 20 };
const DONE_TTL_MS = 8000;
/** 出错不再"永久常驻"——那不叫提醒，叫堆积。60 秒后转入折叠历史 */
const ERROR_TTL_MS = 60_000;
/** 点击台词之类的提示：看一眼就够，20 秒后自动消失（否则连点会堆一片） */
const INFO_TTL_MS = 20_000;
const MAX_COLLAPSED = 5;

export class BubbleQueue {
  constructor({ onChange } = {}) {
    this.items = [];
    this.onChange = onChange || (() => {});
    this._seq = 0;
  }

  push({ kind, title, text, sessionId, agent, ref }) {
    // 去重：同一会话同一审批只保留一条
    if (ref) {
      const dup = this.items.find((i) => i.ref === ref);
      if (dup) {
        dup.ts = Date.now();
        this.onChange();
        return dup;
      }
    }
    const item = {
      id: ++this._seq, kind, title, text: text || '',
      sessionId: sessionId ?? null, agent: agent || 'unknown',
      ref: ref || null, ts: Date.now(), collapsed: false,
      expiresAt: kind === BUBBLE.DONE ? Date.now() + DONE_TTL_MS
        : kind === BUBBLE.ERROR ? Date.now() + ERROR_TTL_MS
          : kind === BUBBLE.INFO ? Date.now() + INFO_TTL_MS
            : null,
      seq: ++this._seq,
      /** 预留：v1 恒为空数组。加双向控制时填 [{id,label,target}] */
      actions: [],
    };
    // 新通知进来 → 旧的完成气泡降级为折叠态，而不是立刻消失
    if (kind !== BUBBLE.DONE) {
      for (const i of this.items) {
        if (i.kind === BUBBLE.DONE && !i.collapsed) {
          i.collapsed = true;
          i.expiresAt = null;
        }
      }
    }
    this.items.push(item);
    this._trim();
    this.onChange();
    return item;
  }

  /** 审批已被处理 / 会话结束 → 主动撤回，避免"幽灵审批" */
  retract(ref) {
    const before = this.items.length;
    this.items = this.items.filter((i) => i.ref !== ref);
    if (this.items.length !== before) this.onChange();
  }

  dismiss(id) {
    this.items = this.items.filter((i) => i.id !== id);
    this.onChange();
  }

  /**
   * 新回合开始 → 把上一轮的完成/错误通知收进折叠历史。
   * 这是治「命令提示堆积」的关键：新工作已经开始，旧通知就是过时信息，
   * 不该继续占着角色头顶的位置。等待类（需要人处理）不受影响。
   */
  retireStale() {
    let changed = false;
    for (const i of this.items) {
      if (!i.collapsed && (i.kind === BUBBLE.DONE || i.kind === BUBBLE.ERROR)) {
        i.collapsed = true;
        i.expiresAt = null;
        changed = true;
      }
    }
    this._trim();
    if (changed) this.onChange();
  }

  /** 清除全部（右键菜单用） */
  clear() {
    this.items = [];
    this.onChange();
  }

  tick(now = Date.now()) {
    const before = this.items.length;
    for (const i of this.items) {
      if (i.expiresAt && now > i.expiresAt) i.expired = true;
    }
    this.items = this.items.filter((i) => !i.expired);
    if (this.items.length !== before) this.onChange();
  }

  _trim() {
    const collapsed = this.items.filter((i) => i.collapsed);
    if (collapsed.length <= MAX_COLLAPSED) return;
    const drop = new Set(collapsed.slice(0, collapsed.length - MAX_COLLAPSED).map((i) => i.id));
    this.items = this.items.filter((i) => !drop.has(i.id));
  }

  /**
   * 决定"哪几条真的显示在头顶"。
   * 显示位是稀缺资源（窗内就那么点地方），所以：等待类保证占一位（合并后只占一条），
   * 其余按优先级补满 maxVisible，剩下的全部计入折叠计数。
   */
  visibleSummary(maxVisible = 2) {
    const ordered = this.ordered().filter((i) => !i.collapsed);
    const waiting = ordered.filter((i) => i.kind === BUBBLE.WAITING).slice(0, 1);
    const room = Math.max(0, maxVisible - waiting.length);
    const rest = ordered.filter((i) => i.kind !== BUBBLE.WAITING).slice(0, room);
    const shown = [...waiting, ...rest];
    const hiddenCount = this.items.filter((i) => !shown.includes(i)).length;
    return { shown, hiddenCount };
  }

  /**
   * 渲染顺序：等待类 FIFO 置顶（先来的先处理），其余按优先级、**同级内新的一定排前面**。
   *
   * 同级内必须是「新的优先」：之前写的是 a.ts - b.ts（最早的优先），
   * 于是点出来的台词里**最旧那条永远占着唯一的显示位**，新点击只能进 +N——
   * 表现为"点击对话卡住、新的顶不掉旧的"（用户实测抓到的）。
   */
  ordered() {
    // 用单调序号而不是时间戳定序：同一毫秒内的多次推送时间戳相同，
    // 排序会退化成插入序，"新的优先"就失效了（单测抓到过）
    const waiting = this.items.filter((i) => i.kind === BUBBLE.WAITING).sort((a, b) => a.seq - b.seq);
    const rest = this.items
      .filter((i) => i.kind !== BUBBLE.WAITING)
      .sort((a, b) => (PRIORITY[b.kind] - PRIORITY[a.kind]) || (b.seq - a.seq));
    return [...waiting, ...rest];
  }

  /** 多个 Agent 同时等你 → 合并成一条 */
  summary() {
    const waiting = this.items.filter((i) => i.kind === BUBBLE.WAITING && !i.collapsed);
    const agents = [...new Set(waiting.map((i) => i.agent))];
    if (agents.length > 1) {
      const label = { dsh: 'DSH', codex: 'Codex' };
      const names = agents.map((a) => label[a] || a);
      return {
        merged: true,
        text: `${names.join(' 和 ')} 都在等你`,
        children: waiting,
      };
    }
    return { merged: false, text: waiting[0]?.text || '', children: waiting };
  }
}
