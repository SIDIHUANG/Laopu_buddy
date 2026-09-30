/**
 * 普瑞塞斯桌宠 · DSH 桥接插件
 *
 * 为什么需要它：DSH 的会话日志是 `session.v4.jsonl.zstd`（zstd 压缩），tail 不划算；
 * 而 DSH 有一等的扩展点。本插件挂在那些点上，把状态**主动**写成明文 JSONL，
 * 桌宠只读这个文件即可 —— 比事后猜日志可靠一个数量级，尤其是「等待审批」这类关键状态。
 *
 * 设计原则：
 *   - **绝不干扰 agent**：每个回调都 try/catch，写文件失败只计数不抛错，
 *     任何情况下 agent 都必须能正常跑完。
 *   - **可选增强**：没装这个插件，桌宠只是看不到 DSH 状态（Codex 部分照常），不会报错。
 *   - seq 由本插件分配（每 agent 单调递增），不沿用 DSH 内部编号。
 *
 * @module dsh-presage-bridge
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import z from '@deepseek-ai/schemastery';

const name = 'presage-bridge';
// sessionProjections 用来读 turnBoundary（与 dsh-hooks-codex 同一套取 turn 的方法）
const inject = ['sessionProjections'];

const Config = z.object({
  outDir: z.string().default(''),
  heartbeatMs: z.number().default(10000),
  summaryMaxChars: z.number().default(160),
});

function defaultOutDir() {
  const appdata = process.env.APPDATA;
  if (appdata) return join(appdata, 'presage-pet', 'events');
  return join(homedir(), '.presage-pet', 'events');
}

function blocksToText(content) {
  if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
  return content
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('');
}

/** 从工具输出判断成功与否（与 Codex adapter 同一套启发式） */
function outputOk(text) {
  if (typeof text !== 'string') return true;
  const m = /(?:Exit code|exited with code|Process exited with code)\D*(\d+)/i.exec(text);
  if (m) return Number(m[1]) === 0;
  if (/^\s*(error|failed|Traceback)/im.test(text)) return false;
  return true;
}

function commandOf(args) {
  if (args && typeof args === 'object') {
    for (const k of ['command', 'cmd', 'query', 'path', 'file_path']) {
      if (typeof args[k] === 'string' && args[k].trim()) return args[k].trim();
    }
  }
  return '';
}

export function apply(ctx, config) {
  const outDir = config.outDir || defaultOutDir();
  const outFile = join(outDir, 'dsh.jsonl');
  const maxChars = config.summaryMaxChars ?? 160;

  let seq = 0;
  let writeFailures = 0;
  let emitted = 0;
  let ready = false;

  try {
    mkdirSync(outDir, { recursive: true });
    ready = true;
  } catch (error) {
    ctx.logger?.warn?.(`presage-bridge: 无法创建输出目录 "${outDir}": ${String(error)} — 桥接停用`);
    return;
  }

  const cut = (s) => (typeof s === 'string' ? s.slice(0, maxChars) : null);

  function emit(kind, payload = {}, sessionId = null) {
    if (!ready) return;
    const evt = {
      v: 1,
      seq: ++seq,
      ts: Date.now(),
      agent: 'dsh',
      sessionId: sessionId ?? null,
      kind,
      payload,
      actions: [], // 预留：v1 恒为空
    };
    try {
      // 单行一次写完，保证读取方永远看不到半行
      appendFileSync(outFile, `${JSON.stringify(evt)}\n`, 'utf8');
      emitted++;
    } catch (error) {
      writeFailures++;
      if (writeFailures === 1) {
        ctx.logger?.warn?.(`presage-bridge: 写事件失败（后续静默计数）: ${String(error)}`);
      }
    }
  }

  const sessionIdOf = (agent) => agent?.session?.header?.id ?? null;
  const cwdOf = (agent) => agent?.session?.header?.cwd ?? null;

  function lastTurn(agent) {
    if (!agent) return 0;
    try {
      return ctx.sessionProjections.stateOf(agent.session, 'turnBoundary')?.lastTurn ?? 0;
    } catch {
      return 0;
    }
  }

  // 每个会话当前回合，用于「同一个 turn 只发一次 turn/start」
  const currentTurn = new Map();

  const on = (eventName, handler) => {
    try {
      ctx.on(eventName, handler);
    } catch (error) {
      ctx.logger?.warn?.(`presage-bridge: 注册 ${eventName} 失败: ${String(error)}`);
    }
  };

  emit('agent/hello', { pid: process.pid, version: '0.1.0', outFile });

  on('agent/session-start', ({ agent }) => {
    try {
      emit('session/start', { cwd: cwdOf(agent) }, sessionIdOf(agent));
    } catch (error) {
      ctx.logger?.warn?.(`presage-bridge: session-start 处理失败: ${String(error)}`);
    }
  });

  // 注意：这是 waterfall，必须把 next() 的结果原样返回，否则会掐断后续监听器
  on('agent/pre-step', async (payload, next) => {
    try {
      const { agent, turn } = payload;
      const sid = sessionIdOf(agent);
      const turnId = String(turn ?? lastTurn(agent));
      if (currentTurn.get(sid) !== turnId) {
        currentTurn.set(sid, turnId);
        emit('turn/start', { turnId }, sid);
      }
    } catch (error) {
      ctx.logger?.warn?.(`presage-bridge: pre-step 处理失败: ${String(error)}`);
    }
    return next();
  });

  on('tools/pre-execute', async (exec, next) => {
    try {
      const sid = sessionIdOf(exec?.agent);
      emit('tool/call', {
        turnId: String(lastTurn(exec?.agent)),
        tool: exec?.name ?? 'unknown',
        callId: exec?.callId ?? null,
        summary: cut(commandOf(exec?.arguments)) ?? exec?.name ?? null,
      }, sid);
    } catch (error) {
      ctx.logger?.warn?.(`presage-bridge: pre-execute 处理失败: ${String(error)}`);
    }
    return next();
  });

  on('tools/post-execute', async (exec, result, next) => {
    try {
      const sid = sessionIdOf(exec?.agent);
      const text = blocksToText(result?.content);
      emit('tool/result', {
        callId: exec?.callId ?? null,
        tool: exec?.name ?? null,
        ok: outputOk(text),
        summary: cut(text) ?? null,
      }, sid);
    } catch (error) {
      ctx.logger?.warn?.(`presage-bridge: post-execute 处理失败: ${String(error)}`);
    }
    return next();
  });

  on('agent/turn-stopping', async ({ agent, turn }) => {
    try {
      const sid = sessionIdOf(agent);
      emit('turn/end', {
        turnId: String(turn ?? lastTurn(agent)),
        status: 'ok',
      }, sid);
    } catch (error) {
      ctx.logger?.warn?.(`presage-bridge: turn-stopping 处理失败: ${String(error)}`);
    }
  });

  // 进程退出兜底（事件名不确定时也只是注册不上，不影响其他监听）
  on('agent/disposed', ({ agent } = {}) => {
    try {
      emit('agent/gone', { reason: 'disposed' }, sessionIdOf(agent));
    } catch { /* 忽略 */ }
  });

  const heartbeat = setInterval(() => {
    emit('agent/heartbeat', { uptimeMs: Math.round(process.uptime() * 1000) });
  }, config.heartbeatMs ?? 10000);
  heartbeat.unref?.();

  try {
    ctx.on('dispose', () => {
      clearInterval(heartbeat);
      emit('agent/gone', {
        reason: 'plugin-dispose',
        stats: { emitted, writeFailures },
      });
    });
  } catch { /* 忽略 */ }

  ctx.logger?.info?.(
    `presage-bridge: 已启动，事件写入 ${outFile}（桌宠未运行时也不影响 agent）`,
  );
}

export { Config, name, inject };
