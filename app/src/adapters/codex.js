/**
 * Codex adapter：把 ~/.codex/sessions 下的 rollout-*.jsonl 映射成协议事件。
 *
 * 字段名全部来自对真实 rollout 的实测（tools/inspect_rollout.py），不是猜的。
 * 顶层结构：{ timestamp, ordinal, type, payload }
 *
 * 版本漂移全部封死在这里：上层只认 AGENT_LINK_PROTOCOL 的事件。
 */

import { KIND } from '../protocol.js';

export const AGENT = 'codex';

/** 文件名 → 会话信息。rollout-2026-09-17T11-25-28-<uuid>.jsonl */
export function parseRolloutName(filename) {
  const m = /rollout-(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(.+)\.jsonl$/.exec(filename);
  if (!m) return { sessionId: null, startedAt: null };
  const [, y, mo, d, h, mi, s, uuid] = m;
  const iso = `${y}-${mo}-${d}T${h}:${mi}:${s}Z`;
  const t = Date.parse(iso);
  return { sessionId: uuid, startedAt: Number.isFinite(t) ? t : null };
}

/** 从 function_call 的 arguments（JSON 字符串）里挤出一句可读摘要 */
export function summarizeToolCall(name, argsString) {
  let args = argsString;
  if (typeof argsString === 'string') {
    try {
      args = JSON.parse(argsString);
    } catch {
      args = null;
    }
  }
  if (args && typeof args === 'object') {
    const cmd = args.cmd ?? args.command ?? args.query ?? args.path ?? args.file_path;
    if (typeof cmd === 'string' && cmd.trim()) return cmd.trim().slice(0, 120);
    const keys = Object.keys(args);
    if (keys.length) return `${name}(${keys.slice(0, 3).join(', ')})`;
  }
  return name;
}

/** 从工具输出文本判断成功与否。实测格式：'Exit code: 0' / 'Process exited with code 1' */
export function toolOutputOk(output) {
  if (typeof output !== 'string') return true;
  const m = /(?:Exit code|exited with code|Process exited with code)\D*(\d+)/i.exec(output);
  if (m) return Number(m[1]) === 0;
  if (/^\s*(error|failed|Traceback)/im.test(output)) return false;
  return true;
}

/**
 * 逐行规范化。ctx 会在多次调用间保持，用于记录当前 turn / callId→工具名 的对应关系。
 * @returns {object|object[]|null} 协议事件（可能一条原始行产生多条，或 null 表示忽略）
 */
export function normalizeCodex(raw, ctx, sessionId) {
  if (!raw || typeof raw !== 'object') return null;
  const type = raw.type;
  const p = raw.payload && typeof raw.payload === 'object' ? raw.payload : {};
  const ts = Date.parse(raw.timestamp) || Date.now();
  const seq = Number.isFinite(raw.ordinal) ? raw.ordinal : null;
  const base = { v: 1, seq, ts, agent: AGENT, sessionId, payload: {}, actions: [] };
  const mk = (kind, payload = {}) => ({ ...base, kind, payload });

  switch (type) {
    case 'session_meta':
      ctx.sessionId = p.session_id ?? p.id ?? sessionId ?? null;
      ctx.cwd = p.cwd ?? null;
      return mk(KIND.SESSION_START, { cwd: p.cwd ?? null, model: p.model_provider ?? null });

    case 'event_msg':
      switch (p.type) {
        case 'task_started':
          ctx.turnId = p.turn_id ?? null;
          return mk(KIND.TURN_START, { turnId: ctx.turnId });

        case 'task_complete': {
          ctx.turnId = p.turn_id ?? ctx.turnId;
          // 实测：失败的回合也走 task_complete，靠 error 字段区分（error 是对象，不是字符串）
          const errText = p.error
            ? (typeof p.error === 'string' ? p.error : (p.error.message ?? JSON.stringify(p.error)))
            : null;
          const status = errText ? 'error' : 'ok';
          return mk(KIND.TURN_END, {
            turnId: ctx.turnId,
            status,
            durationMs: p.duration_ms ?? null,
            summary: errText ? String(errText).slice(0, 160)
              : (p.last_agent_message ? String(p.last_agent_message).slice(0, 160) : null),
          });
        }

        case 'turn_aborted':
          return mk(KIND.TURN_END, {
            turnId: p.turn_id ?? ctx.turnId,
            status: 'aborted',
            reason: p.reason ?? null,
          });

        case 'agent_message':
          return mk(KIND.MESSAGE, {
            turnId: ctx.turnId,
            textSummary: typeof p.message === 'string' ? p.message.slice(0, 200) : null,
          });

        case 'patch_apply_end':
          return mk(KIND.TOOL_RESULT, {
            callId: p.call_id ?? null,
            ok: p.success !== false && p.status !== 'failed',
            tool: 'apply_patch',
          });

        case 'token_count': {
          const u = p.info?.total_token_usage;
          if (!u) return null;
          return mk(KIND.USAGE, {
            provider: 'codex',
            window: 'session',
            used: u.total_tokens ?? null,
            unit: 'tokens',
            input: u.input_tokens ?? null,
            output: u.output_tokens ?? null,
            cached: u.cached_input_tokens ?? null,
            limit: null,
            balance: null,
          });
        }

        case 'context_compacted':
          return mk(KIND.NOTICE, { level: 'info', text: '上下文已压缩' });

        // user_message / item_completed / agent_reasoning / thread_settings_applied /
        // web_search_end / mcp_tool_call_end 等：v1 不需要，显式忽略而不是漏掉
        default:
          return null;
      }

    case 'response_item':
      switch (p.type) {
        case 'function_call':
        case 'custom_tool_call':
        case 'tool_search_call':
        case 'web_search_call': {
          const name = p.name ?? p.type.replace('_call', '');
          if (p.call_id) ctx.calls?.set(p.call_id, name);
          return mk(KIND.TOOL_CALL, {
            turnId: ctx.turnId,
            tool: name,
            callId: p.call_id ?? null,
            summary: p.type === 'function_call'
              ? summarizeToolCall(name, p.arguments)
              : name,
          });
        }

        case 'function_call_output':
        case 'custom_tool_call_output':
        case 'tool_search_output':
          return mk(KIND.TOOL_RESULT, {
            callId: p.call_id ?? null,
            tool: ctx.calls?.get(p.call_id) ?? null,
            ok: toolOutputOk(p.output),
          });

        // reasoning / message / world_state 之类不进状态机
        default:
          return null;
      }

    case 'turn_context':
      // 实测：审批策略只出现在这里（配置），不是事件 —— 所以 Codex 没有「等待审批」信号
      ctx.approvalPolicy = p.approval_policy ?? null;
      if (p.sandbox_policy) ctx.sandbox = p.sandbox_policy;
      return null;

    default:
      return null;
  }
}

/** 给 adapter 用的上下文工厂 */
export function newCodexContext() {
  return { sessionId: null, turnId: null, cwd: null, calls: new Map(), approvalPolicy: null };
}
