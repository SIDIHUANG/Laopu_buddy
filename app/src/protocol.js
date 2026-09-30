/**
 * AGENT_LINK_PROTOCOL v1 的客户端实现（与 docs/AGENT_LINK_PROTOCOL.md 一一对应）
 * 只做两件事：定义 kind 常量、把原始事件规范化成内部事件对象。
 */

export const KIND = {
  AGENT_HELLO: 'agent/hello',
  AGENT_HEARTBEAT: 'agent/heartbeat',
  AGENT_GONE: 'agent/gone',
  SESSION_START: 'session/start',
  SESSION_END: 'session/end',
  TURN_START: 'turn/start',
  TURN_END: 'turn/end',
  TOOL_CALL: 'tool/call',
  TOOL_RESULT: 'tool/result',
  APPROVAL_REQUEST: 'approval/request',
  APPROVAL_RESOLVED: 'approval/resolved',
  MESSAGE: 'message/assistant',
  USAGE: 'usage/update',
  ERROR: 'error',
  NOTICE: 'notice',
};

export const KNOWN_KINDS = new Set(Object.values(KIND));

/**
 * 一行 JSONL → 内部事件；不合法返回 null（读取方必须容忍半行/坏行）。
 * 未知 kind 不丢弃（保留但标记 unknown），便于前向兼容。
 */
export function parseLine(line) {
  const text = line.trim();
  if (!text) return null;
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || typeof raw.kind !== 'string') return null;
  return {
    v: Number(raw.v) || 1,
    seq: Number.isFinite(raw.seq) ? raw.seq : null,
    ts: Number.isFinite(raw.ts) ? raw.ts : Date.now(),
    agent: raw.agent || 'unknown',
    sessionId: raw.sessionId ?? null,
    kind: raw.kind,
    known: KNOWN_KINDS.has(raw.kind),
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : {},
    actions: Array.isArray(raw.actions) ? raw.actions : [],
  };
}

/** 生成一条符合协议的事件（用于 demo / 桥接插件参考实现） */
export function makeEvent(agent, kind, payload = {}, sessionId = null, seq = 0) {
  return {
    v: 1,
    seq,
    ts: Date.now(),
    agent,
    sessionId,
    kind,
    known: KNOWN_KINDS.has(kind),
    payload,
    actions: [],
  };
}
