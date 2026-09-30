/**
 * Codex adapter 单测。
 * 所有输入都按**真实 rollout 的字段形状**构造（来自 tools/inspect_rollout.py 的实测）。
 * 这些用例的作用是：Codex 升级后字段一变，这里立刻红。
 */
import assert from 'node:assert/strict';
import {
  normalizeCodex, newCodexContext, parseRolloutName, summarizeToolCall, toolOutputOk,
} from '../src/adapters/codex.js';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

const line = (type, payload, ordinal = 0, timestamp = '2026-09-23T09:43:45.000Z') =>
  ({ timestamp, ordinal, type, payload });

function run(raw, ctx = newCodexContext()) {
  const out = normalizeCodex(raw, ctx, 'sess-1');
  return Array.isArray(out) ? out : out ? [out] : [];
}

// ---------------------------------------------------------------- 文件名解析
test('parseRolloutName 解出会话 id 与时间', () => {
  const r = parseRolloutName('rollout-2026-09-23T09-43-45-01a0cbee-e2e5-7621-8146-8622f00d565d.jsonl');
  assert.equal(r.sessionId, '01a0cbee-e2e5-7621-8146-8622f00d565d');
  assert.equal(r.startedAt, Date.parse('2026-09-23T09:43:45Z'));
});

test('parseRolloutName 对怪名字不炸', () => {
  assert.deepEqual(parseRolloutName('nope.jsonl'), { sessionId: null, startedAt: null });
});

// ---------------------------------------------------------------- 摘要与成功判定
test('summarizeToolCall 从 arguments 里取出 cmd', () => {
  const s = summarizeToolCall('exec_command', '{"cmd":"rg --files -g \\"*.ipynb\\""}');
  assert.match(s, /rg --files/);
});

test('summarizeToolCall 容忍坏 JSON', () => {
  assert.equal(summarizeToolCall('exec_command', '{oops'), 'exec_command');
});

test('toolOutputOk 按真实输出格式判断退出码', () => {
  assert.equal(toolOutputOk('Chunk ID: 1\nProcess exited with code 0\nOutput:\n'), true);
  assert.equal(toolOutputOk('Exit code: 1\nWall time: 2s\n'), false);
  assert.equal(toolOutputOk('Success. Updated the following files:\nA a.md\n'), true);
  assert.equal(toolOutputOk('Traceback (most recent call last):'), false);
});

// ---------------------------------------------------------------- 会话与回合
test('session_meta → session/start（带 cwd）', () => {
  const ctx = newCodexContext();
  const [e] = run(line('session_meta', { id: 'x', session_id: 'x', cwd: 'C:\\proj' }), ctx);
  assert.equal(e.kind, 'session/start');
  assert.equal(e.payload.cwd, 'C:\\proj');
});

test('task_started → turn/start，记住 turnId', () => {
  const ctx = newCodexContext();
  const [e] = run(line('event_msg', { type: 'task_started', turn_id: 'T1' }, 1), ctx);
  assert.equal(e.kind, 'turn/start');
  assert.equal(e.payload.turnId, 'T1');
  assert.equal(ctx.turnId, 'T1');
});

test('task_complete 无 error → turn/end ok（带 duration 与摘要）', () => {
  const [e] = run(line('event_msg',
    { type: 'task_complete', turn_id: 'T1', duration_ms: 19371, last_agent_message: '你好' }));
  assert.equal(e.kind, 'turn/end');
  assert.equal(e.payload.status, 'ok');
  assert.equal(e.payload.durationMs, 19371);
  assert.equal(e.payload.summary, '你好');
});

test('task_complete 带 error 对象 → turn/end error（实测 error 是对象）', () => {
  const [e] = run(line('event_msg',
    { type: 'task_complete', turn_id: 'T1', error: { message: 'stream disconnected' } }));
  assert.equal(e.payload.status, 'error');
  assert.equal(e.payload.summary, 'stream disconnected');
});

test('turn_aborted → turn/end aborted', () => {
  const [e] = run(line('event_msg',
    { type: 'turn_aborted', turn_id: 'T1', reason: 'interrupted' }));
  assert.equal(e.payload.status, 'aborted');
  assert.equal(e.payload.reason, 'interrupted');
});

// ---------------------------------------------------------------- 工具
test('function_call → tool/call，seq 取 ordinal', () => {
  const ctx = newCodexContext();
  const [e] = run(line('response_item',
    { type: 'function_call', name: 'exec_command', call_id: 'call_1', arguments: '{"cmd":"ls"}' }, 42), ctx);
  assert.equal(e.kind, 'tool/call');
  assert.equal(e.payload.tool, 'exec_command');
  assert.equal(e.payload.summary, 'ls');
  assert.equal(e.seq, 42);
  assert.equal(ctx.calls.get('call_1'), 'exec_command');
});

test('function_call_output → tool/result 且能对上工具名', () => {
  const ctx = newCodexContext();
  run(line('response_item', { type: 'function_call', name: 'exec_command', call_id: 'c9' }, 1), ctx);
  const [e] = run(line('response_item',
    { type: 'function_call_output', call_id: 'c9', output: 'Exit code: 0\n' }, 2), ctx);
  assert.equal(e.kind, 'tool/result');
  assert.equal(e.payload.ok, true);
  assert.equal(e.payload.tool, 'exec_command');
});

test('custom_tool_call（apply_patch）→ tool/call', () => {
  const [e] = run(line('response_item',
    { type: 'custom_tool_call', name: 'apply_patch', call_id: 'c2', status: 'completed' }));
  assert.equal(e.kind, 'tool/call');
  assert.equal(e.payload.tool, 'apply_patch');
});

test('patch_apply_end → tool/result', () => {
  const [e] = run(line('event_msg',
    { type: 'patch_apply_end', call_id: 'c2', turn_id: 'T1', status: 'completed' }));
  assert.equal(e.kind, 'tool/result');
  assert.equal(e.payload.ok, true);
});

// ---------------------------------------------------------------- 用量与其他
test('token_count → usage/update（本地推导用量）', () => {
  const [e] = run(line('event_msg', {
    type: 'token_count',
    info: { total_token_usage: { input_tokens: 17944, output_tokens: 957, cached_input_tokens: 1408, total_tokens: 18901 } },
  }));
  assert.equal(e.kind, 'usage/update');
  assert.equal(e.payload.used, 18901);
  assert.equal(e.payload.output, 957);
});

test('agent_message → message/assistant', () => {
  const [e] = run(line('event_msg', { type: 'agent_message', message: '我先查天气' }));
  assert.equal(e.kind, 'message/assistant');
  assert.equal(e.payload.textSummary, '我先查天气');
});

test('turn_context 被忽略，但记下审批策略（说明 Codex 无审批事件）', () => {
  const ctx = newCodexContext();
  const out = run(line('turn_context', { approval_policy: 'on-request', turn_id: 'T1' }), ctx);
  assert.equal(out.length, 0);
  assert.equal(ctx.approvalPolicy, 'on-request');
});

test('无关事件返回 null（不产生噪音事件）', () => {
  assert.equal(run(line('response_item', { type: 'reasoning', content: [] })).length, 0);
  assert.equal(run(line('event_msg', { type: 'user_message', message: 'hi' })).length, 0);
  assert.equal(run(line('world_state', { full: true })).length, 0);
  assert.equal(run(line('event_msg', { type: 'item_completed' })).length, 0);
});

test('所有产出的 kind 都是已登记的协议 kind', () => {
  const ctx = newCodexContext();
  const raws = [
    line('session_meta', { session_id: 's' }),
    line('event_msg', { type: 'task_started', turn_id: 'T' }, 1),
    line('response_item', { type: 'function_call', name: 'exec', call_id: 'c', arguments: '{}' }, 2),
    line('response_item', { type: 'function_call_output', call_id: 'c', output: 'Exit code: 0' }, 3),
    line('event_msg', { type: 'agent_message', message: 'm' }, 4),
    line('event_msg', { type: 'token_count', info: { total_token_usage: { total_tokens: 1 } } }, 5),
    line('event_msg', { type: 'task_complete', turn_id: 'T' }, 6),
  ];
  const kinds = raws.flatMap((r) => run(r, ctx)).map((e) => e.kind);
  assert.deepEqual(kinds, [
    'session/start', 'turn/start', 'tool/call', 'tool/result',
    'message/assistant', 'usage/update', 'turn/end',
  ]);
});

// ---------------------------------------------------------------- run
for (const [name, fn] of cases) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${cases.length} 通过`);
