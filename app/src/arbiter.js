/**
 * 仲裁器：把一堆原始事件收敛成「普瑞塞斯此刻该演什么」。
 *
 * 三条规则（对应评估文档 Q8）：
 *   1. 面向工具而非面向卖萌的优先级：等审批 > 出错 > 忙 > 完成 > 空闲
 *   2. 新鲜度衰减是保险丝：任何"活跃"态超时无事件必须回落，防止 Agent 崩了永远转圈
 *   3. 等待态不可被覆盖：多个 Agent 同时等你时，动画只演最高优先级，但气泡全部保留
 */

import { KIND } from './protocol.js';

export const ACTIVITY = {
  IDLE: 'idle',
  THINKING: 'thinking', // 回合已开始、还没出工具调用 → 摇头
  WORKING: 'working',   // 有工具在跑 → 埋头敲键盘
  WAITING: 'waiting',
  ERROR: 'error',
};

const PRIORITY = {
  [ACTIVITY.WAITING]: 100,
  [ACTIVITY.ERROR]: 80,
  [ACTIVITY.WORKING]: 65,
  [ACTIVITY.THINKING]: 55,
  [ACTIVITY.IDLE]: 0,
};

// 活跃态多久没新事件就强制回落（保险丝）
const DECAY_MS = 45_000;
// 完全没有事件多久进入「打瞌睡 → 熟睡」
const LONG_IDLE_MS = 5 * 60_000;
// 趴下入睡这段过渡动画播多久，之后才切到熟睡循环
const DOZE_HOLD_MS = 6000;
// 完成后庆祝播放时长
const CELEBRATE_MS = 3000;
// 心跳多久没来算作降级
const HEARTBEAT_STALE_MS = 30_000;
// 「忙碌组」内互切需要持续这么久才提交，否则 thinking/working 会随短工具调用高频抖动。
// 从 800ms 提到 2200ms：working 是 once_loop（先"拿出电脑"再进打字循环），
// 每次进入都从头播。抖动一次就重播一次开头，用户**永远看不到打字那一段**（实测症状）。
// 工具之间模型思考一两秒是常态，不该因此把工作表情打断。
const BUSY_DWELL_MS = 2200;
const BUSY_GROUP = new Set(['thinking', 'working']);

export class Arbiter {
  constructor({ lock = 'auto' } = {}) {
    this.lock = lock; // 'auto' | 'dsh' | 'codex'
    this.sessions = new Map();
    this.agents = new Map(); // agent -> {lastTs, lastHeartbeat, seq}
    this.lastAnyTs = Date.now();
    this.celebrateUntil = 0;
    this.sleeping = false;
    this.dozing = false;
    this.dozeStartedAt = 0;
    this._epoch = 0;
    this._lastKey = '';
    this._committedAnim = null;
    this._pendingAnim = null;
    this._pendingSince = 0;
    this.listeners = new Set();
  }

  subscribe(fn) {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  setLock(lock) {
    this.lock = lock;
    this._emit();
  }

  _keyOf(evt) {
    return `${evt.agent}:${evt.sessionId ?? '-'}`;
  }

  _session(evt) {
    const key = this._keyOf(evt);
    let s = this.sessions.get(key);
    if (!s) {
      s = {
        key, agent: evt.agent, sessionId: evt.sessionId,
        activity: ACTIVITY.IDLE, lastTs: evt.ts, turnId: null,
        approvals: new Set(), startedAt: evt.ts,
        turnOpen: false, pendingCalls: new Set(),
      };
      this.sessions.set(key, s);
    }
    return s;
  }

  ingest(evt) {
    const agentState = this.agents.get(evt.agent) || { lastTs: 0, lastHeartbeat: 0, seq: null };
    if (evt.seq != null) {
      if (agentState.seq != null && evt.seq <= agentState.seq) return; // 重复，丢弃
      agentState.seq = evt.seq;
    }
    agentState.lastTs = evt.ts;
    if (evt.kind === KIND.AGENT_HEARTBEAT || evt.kind === KIND.AGENT_HELLO) {
      agentState.lastHeartbeat = evt.ts;
    }
    this.agents.set(evt.agent, agentState);
    // 心跳只说明「通道还活着」，不算「有活动」——否则桌宠永远不会进入打瞌睡/熟睡。
    if (evt.kind !== KIND.AGENT_HEARTBEAT) {
      this.lastAnyTs = evt.ts;
      this.sleeping = false;
      this.dozing = false;
    }
    this.dozeStartedAt = 0;

    switch (evt.kind) {
      case KIND.TURN_START: {
        const s = this._session(evt);
        s.activity = ACTIVITY.THINKING;
        s.lastTs = evt.ts;
        s.turnOpen = true;
        s.pendingCalls.clear();
        s.turnId = evt.payload.turnId ?? s.turnId;
        break;
      }
      case KIND.TOOL_CALL: {
        const s = this._session(evt);
        s.activity = ACTIVITY.WORKING;
        s.lastTs = evt.ts;
        s.turnOpen = true;
        if (evt.payload.callId) s.pendingCalls.add(evt.payload.callId);
        break;
      }
      case KIND.TOOL_RESULT: {
        const s = this._session(evt);
        s.lastTs = evt.ts;
        if (evt.payload.callId) s.pendingCalls.delete(evt.payload.callId);
        // 所有工具都回来了 → 回到「思考」（等模型继续出下一句）
        if (s.pendingCalls.size === 0 && s.activity !== ACTIVITY.WAITING
            && s.activity !== ACTIVITY.ERROR) {
          s.activity = s.turnOpen ? ACTIVITY.THINKING : ACTIVITY.IDLE;
        }
        break;
      }
      case KIND.MESSAGE: {
        const s = this._session(evt);
        s.lastTs = evt.ts;
        if (s.activity === ACTIVITY.IDLE) {
          s.activity = s.turnOpen ? ACTIVITY.THINKING : ACTIVITY.IDLE;
        }
        break;
      }
      case KIND.APPROVAL_REQUEST: {
        const s = this._session(evt);
        s.activity = ACTIVITY.WAITING;
        s.lastTs = evt.ts;
        if (evt.payload.approvalId) s.approvals.add(evt.payload.approvalId);
        break;
      }
      case KIND.APPROVAL_RESOLVED: {
        const s = this._session(evt);
        s.lastTs = evt.ts;
        if (evt.payload.approvalId) s.approvals.delete(evt.payload.approvalId);
        if (s.approvals.size === 0 && s.activity === ACTIVITY.WAITING) {
          s.activity = s.pendingCalls.size > 0 ? ACTIVITY.WORKING : ACTIVITY.THINKING;
        }
        break;
      }
      case KIND.ERROR: {
        const s = this._session(evt);
        s.activity = ACTIVITY.ERROR;
        s.lastTs = evt.ts;
        break;
      }
      case KIND.TURN_END: {
        const s = this._session(evt);
        s.lastTs = evt.ts;
        s.approvals.clear();
        s.turnOpen = false;
        s.pendingCalls.clear();
        if (evt.payload.status === 'error') {
          s.activity = ACTIVITY.ERROR;
        } else if (evt.payload.status === 'aborted') {
          s.activity = ACTIVITY.IDLE;
        } else {
          s.activity = ACTIVITY.IDLE;
          this.celebrateUntil = evt.ts + CELEBRATE_MS;
        }
        break;
      }
      case KIND.SESSION_END: {
        const s = this.sessions.get(this._keyOf(evt));
        if (s) {
          s.activity = ACTIVITY.IDLE;
          s.approvals.clear();
          s.turnOpen = false;
          s.pendingCalls.clear();
          s.lastTs = evt.ts;
        }
        break;
      }
      case KIND.AGENT_GONE: {
        for (const s of this.sessions.values()) {
          if (s.agent === evt.agent) {
            s.activity = ACTIVITY.IDLE;
            s.approvals.clear();
            s.turnOpen = false;
            s.pendingCalls.clear();
          }
        }
        break;
      }
      default:
        break;
    }
    // 用事件自己的时间戳推进判断，而不是 Date.now()：
    // 回放历史日志、或系统时钟与日志时间有偏差时，两者混用会出现状态抖动。
    this._emit(evt.ts);
  }

  /** 每个 tick 调用：做新鲜度衰减与长空闲判定 */
  tick(now = Date.now()) {
    let changed = false;
    for (const s of this.sessions.values()) {
      // 这条 45 秒保险丝本意是防「Agent 崩了、宠物永久转圈」，
      // 但**心跳还在**时不该生效：长任务期间本来就没有新事件
      // （DSH 投影的 seq 不变 → 桥接不发事件），而工具还在跑。
      // 实测症状：一个跑几分钟的命令会把 working 打回 idle，用户直接看见"敲键盘变回站着"。
      const ag = this.agents.get(s.agent);
      const alive = ag && now - (ag.lastHeartbeat || 0) < HEARTBEAT_STALE_MS;
      if (!alive && s.activity !== ACTIVITY.IDLE && now - s.lastTs > DECAY_MS) {
        s.activity = ACTIVITY.IDLE;
        s.approvals.clear();
        s.turnOpen = false;
        s.pendingCalls.clear();
        changed = true;
      }
    }
    // 有工具在跑 = 明确的工作中，更不该打瞌睡（否则长任务跑到 5 分钟她就睡了）
    const busy = [...this.sessions.values()].some((s) => s.pendingCalls.size > 0);
    // 用「进入打瞌睡的时刻」计时，而不是拿 now 直接比阈值——
    // 否则 tick 粒度一大（窗口被挂起、定时器被节流）就会把 doze 过渡整段跳过去。
    if (!busy && !this.sleeping && !this.dozing && now - this.lastAnyTs > LONG_IDLE_MS) {
      this.dozing = true;
      this.dozeStartedAt = now;
      changed = true;
    }
    if (this.dozing && now - this.dozeStartedAt > DOZE_HOLD_MS) {
      this.sleeping = true;
      this.dozing = false;
      changed = true;
    }
    if (changed) this._emit();
    else this._emitIfKeyChanged(now);
  }

  stats(now = Date.now()) {
    const active = [];
    for (const s of this.sessions.values()) {
      if (this.lock !== 'auto' && s.agent !== this.lock) continue;
      if (s.activity !== ACTIVITY.IDLE) active.push(s);
    }
    active.sort((a, b) => PRIORITY[b.activity] - PRIORITY[a.activity]);
    const health = {};
    for (const [agent, st] of this.agents) {
      health[agent] = {
        lastTs: st.lastTs,
        heartbeatStale: now - (st.lastHeartbeat || st.lastTs) > HEARTBEAT_STALE_MS,
      };
    }
    return {
      active,
      waiting: active.filter((s) => s.activity === ACTIVITY.WAITING),
      errors: active.filter((s) => s.activity === ACTIVITY.ERROR),
      working: active.filter((s) => s.activity === ACTIVITY.WORKING),
      thinking: active.filter((s) => s.activity === ACTIVITY.THINKING),
      health,
      lock: this.lock,
    };
  }

  resolve(now = Date.now()) {
    const st = this.stats(now);
    let anim;
    if (st.waiting.length > 0) {
      anim = 'waiting';
    } else if (st.errors.length > 0) {
      anim = 'error';
    } else if (st.active.length > 0) {
      // active 已按优先级降序排好；取最高的那个，它的 activity 名就是动画名
      // （working > thinking，所以「有工具在跑」时演敲键盘而不是摇头）
      anim = st.active[0].activity;
    } else if (this.celebrateUntil > now) {
      anim = 'celebrate';
    } else if (this.sleeping) {
      anim = 'sleep';
    } else if (this.dozing) {
      anim = 'doze';
    } else {
      anim = 'idle';
    }

    // 忙碌组内互切做防抖：一个 200ms 的工具调用不该让宠物闪一下键盘又闪回去。
    // 高优先级切换（等待/出错）不受限制，永远立即生效。
    if (this._committedAnim && anim !== this._committedAnim
        && BUSY_GROUP.has(anim) && BUSY_GROUP.has(this._committedAnim)) {
      if (this._pendingAnim !== anim) {
        this._pendingAnim = anim;
        this._pendingSince = now;
      }
      if (now - this._pendingSince < BUSY_DWELL_MS) {
        anim = this._committedAnim;
      } else {
        this._pendingAnim = null;
      }
    } else {
      this._pendingAnim = null;
    }
    this._committedAnim = anim;
    const oneShot = anim === 'celebrate' || anim === 'doze';
    return {
      anim,
      oneShot,
      waiting: st.waiting.length,
      errors: st.errors.length,
      working: st.working.length,
      thinking: st.thinking.length,
      busy: st.active.length,
      agents: Object.keys(this.agents).length,
      health: st.health,
      lock: st.lock,
    };
  }

  _emit(now = Date.now()) {
    const snap = this.resolve(now);
    this._lastKey = '';
    this._emitIfKeyChanged(now, snap);
  }

  _emitIfKeyChanged(now, precomputed) {
    let snap = precomputed || this.resolve(now);
    // 关键：状态切换时递增 epoch，渲染端据此重置帧计数（one-shot 要重新播）
    const key = `${snap.anim}|${snap.waiting}|${snap.errors}|${snap.busy}`;
    if (key !== this._lastKey) {
      if (snap.anim !== (this._lastAnim || '')) this._epoch += 1;
      this._lastAnim = snap.anim;
      this._lastKey = key;
      snap = { ...snap, epoch: this._epoch };
      for (const fn of this.listeners) fn(snap);
    }
  }
}
