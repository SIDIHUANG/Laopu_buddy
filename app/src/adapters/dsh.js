/**
 * DSH adapter —— **零安装**路径。
 *
 * 发现：DSH 会把每个会话的「投影快照」实时写到
 *   ~/.dsh/storages/session_projcache/sessions/<session>.json
 * （实测当前会话的文件在几秒内就被刷新过）。它是**状态快照**而不是事件流，
 * 所以本 adapter 靠 diff 上一次快照来产生边沿事件。
 *
 * 相比桥接插件的取舍：
 *   - 好处：**不用装任何东西**，也不需要动 DSH 配置；这正好是设计里承诺的「轮询保底」通道。
 *   - 代价：延迟取决于文件落盘（实测亚秒级），且字段是 DSH 的内部投影，会随版本漂移
 *     —— 所以全部隔离在这个文件里。
 *   - 插件仍是主通道（更低延迟、语义更全）；两条通道可以同时开着。
 *
 * 拿到的关键信号（都实测确认过形状）：
 *   turnBoundary.openTurnStartSeq   非 null = 回合开着
 *   turnBoundary.lastStepBoundary.kind  start/end = 步骤级忙碌
 *   sessionStats.pendingCalls       正在跑的工具（键即 callId）
 *   sessionStats.openStep.firstTokenTime  为 null = 模型还没出第一个 token（在想）
 *   userQuestions.questions.active  正在等你回答 —— **Codex 侧拿不到的状态**
 *   tokenUsage.totals               用量
 */

import { KIND } from '../protocol.js';

export const AGENT = 'dsh';

/** 把投影文档压成我们关心的那几项（其余一律不进上层） */
export function summarizeProjection(doc, sessionId = null) {
  const rows = doc?.record?.rows ?? {};
  const val = (k) => rows[k]?.val ?? null;
  const tb = val('turnBoundary') ?? {};
  const ss = val('sessionStats') ?? {};
  const uq = val('userQuestions') ?? {};
  const tu = val('tokenUsage') ?? {};
  const questions = (uq.questions ?? {});
  const totals = tu.totals ?? null;
  const sel = val('modelSelection') ?? {};

  return {
    sessionId: sessionId ?? doc?.record?.identity?.sessionId ?? null,
    cwd: doc?.record?.identity?.cwd ?? null,
    /** 投影自身的序号：用来判断"有没有真的变化"，比比时间戳可靠 */
    seq: rows.turnBoundary?.seq ?? 0,
    turnOpen: tb.openTurnStartSeq != null,
    lastTurn: tb.lastTurn ?? 0,
    stepKind: tb.lastStepBoundary?.kind ?? null,
    pendingCalls: Object.keys(ss.pendingCalls ?? {}),
    /** null = 没有打开的步骤；false = 步骤开着但还没出 token（在想） */
    firstTokenSeen: ss.openStep ? ss.openStep.firstTokenTime != null : null,
    active: (questions.active ?? []).map((q) => ({
      id: String((q && (q.id ?? q.question)) || 'question'),
      summary: String((q && (q.question ?? q.header)) || '需要你确认').slice(0, 160),
    })),
    /** 模型信息：用来按定价表折算花费（不用 api-key） */
    model: sel.lastUsed?.model ?? null,
    providerName: sel.lastUsed?.provider ?? null,
    tokens: totals
      ? {
        input: totals.uncachedInputTokens ?? 0,
        output: totals.outputTokens ?? 0,
        cached: totals.cacheReadTokens ?? 0,
      }
      : null,
    usage: totals
      ? {
        provider: 'dsh',
        window: 'session',
        unit: 'tokens',
        used: (totals.uncachedInputTokens ?? 0) + (totals.outputTokens ?? 0)
          + (totals.cacheReadTokens ?? 0) + (totals.cacheWriteTokens ?? 0),
        input: totals.uncachedInputTokens ?? null,
        output: totals.outputTokens ?? null,
        cached: totals.cacheReadTokens ?? null,
        limit: null,
        balance: null,
      }
      : null,
  };
}

/**
 * 快照 diff → 协议事件。首次（prev = null）只对齐基线、不补历史，
 * 否则桌宠一启动就会被一堆陈旧事件炸出满屏气泡。
 */
export function deriveFromProjection(now, prev = null) {
  const out = [];
  const push = (kind, payload) => out.push({ kind, payload });
  if (!prev) return out;

  const turnId = now.turnOpen
    ? `turn-${now.lastTurn}`
    : (prev.turnOpen ? `turn-${prev.lastTurn}` : null);

  if (now.turnOpen && !prev.turnOpen) push(KIND.TURN_START, { turnId });
  if (!now.turnOpen && prev.turnOpen) push(KIND.TURN_END, { turnId, status: 'ok' });

  const wasCalls = new Set(prev.pendingCalls ?? []);
  const nowCalls = new Set(now.pendingCalls ?? []);
  for (const id of nowCalls) {
    if (!wasCalls.has(id)) push(KIND.TOOL_CALL, { turnId, callId: id, tool: null });
  }
  for (const id of wasCalls) {
    if (!nowCalls.has(id)) push(KIND.TOOL_RESULT, { turnId, callId: id, ok: true });
  }

  const wasQ = new Map((prev.active ?? []).map((q) => [q.id, q]));
  const nowQ = new Map((now.active ?? []).map((q) => [q.id, q]));
  for (const [id, q] of nowQ) {
    if (!wasQ.has(id)) {
      push(KIND.APPROVAL_REQUEST, {
        turnId, approvalId: id, kind: 'question', summary: q.summary,
      });
    }
  }
  for (const id of wasQ.keys()) {
    if (!nowQ.has(id)) push(KIND.APPROVAL_RESOLVED, { approvalId: id, decision: 'answered' });
  }

  if (now.usage && JSON.stringify(now.usage) !== JSON.stringify(prev.usage)) {
    push(KIND.USAGE, now.usage);
  }
  return out;
}

/** 有实质变化才返回 true（避免每 500ms 都产生事件） */
export function projectionChanged(now, prev) {
  if (!prev) return true;
  return now.seq !== prev.seq
    || now.turnOpen !== prev.turnOpen
    || now.pendingCalls.length !== (prev.pendingCalls ?? []).length
    || now.active.length !== (prev.active ?? []).length
    || JSON.stringify(now.usage) !== JSON.stringify(prev.usage);
}
