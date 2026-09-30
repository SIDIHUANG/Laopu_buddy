/**
 * DSH adapter 单测。
 * 输入按**实测到的真实投影形状**构造（来自当前会话的 session_projcache）。
 * DSH 升级后投影字段一变，这里立刻红。
 */
import assert from 'node:assert/strict';
import {
  summarizeProjection, deriveFromProjection, projectionChanged,
} from '../src/adapters/dsh.js';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 造一个投影文档；只填我们关心的行，形状与真实文件一致 */
function projection({ seq = 100, turnOpenSeq = null, lastTurn = 1,
  stepKind = 'end', pendingCalls = {}, firstTokenTime = null,
  activeQuestions = [], totals = null } = {}) {
  return {
    version: 7,
    record: {
      identity: { formatVersion: 4, cwd: 'C:\\proj' },
      rows: {
        turnBoundary: {
          seq, val: {
            openTurnStartSeq: turnOpenSeq,
            lastStepStartSeq: seq - 1,
            lastStepBoundary: stepKind ? { kind: stepKind, seq } : null,
            lastTurn,
          },
        },
        sessionStats: {
          seq, val: {
            turns: lastTurn, steps: 331,
            openStep: turnOpenSeq != null
              ? { turn: lastTurn, step: 3, startTime: 1, firstTokenTime } : null,
            pendingCalls,
          },
        },
        userQuestions: {
          seq, val: { timed: false, questions: { active: activeQuestions, settled: [] } },
        },
        tokenUsage: {
          seq, val: totals ? { totals, last: null } : {},
        },
      },
    },
  };
}

const IDLE = projection({ seq: 100, turnOpenSeq: null, stepKind: 'end' });
const THINKING = projection({
  seq: 110, turnOpenSeq: 2420, stepKind: 'start', firstTokenTime: null, lastTurn: 5,
});
const WORKING = projection({
  seq: 120, turnOpenSeq: 2420, stepKind: 'start', firstTokenTime: 111, lastTurn: 5,
  pendingCalls: { call_abc: { name: 'pwsh' } },
});
const WAITING = projection({
  seq: 130, turnOpenSeq: 2420, stepKind: 'start', lastTurn: 5,
  activeQuestions: [{ id: 'q1', question: '要按哪个方案改？', header: '确认' }],
});
const USAGE_A = projection({
  seq: 140, turnOpenSeq: 2420, lastTurn: 5,
  totals: { uncachedInputTokens: 183950, outputTokens: 469562, cacheReadTokens: 115150208, cacheWriteTokens: 0 },
});
const USAGE_B = projection({
  seq: 141, turnOpenSeq: 2420, lastTurn: 5,
  totals: { uncachedInputTokens: 184000, outputTokens: 469600, cacheReadTokens: 115150208, cacheWriteTokens: 0 },
});

const sum = (doc) => summarizeProjection(doc, 'sess-1');

test('summarizeProjection：空闲态', () => {
  const s = sum(IDLE);
  assert.equal(s.turnOpen, false);
  assert.equal(s.pendingCalls.length, 0);
  assert.equal(s.active.length, 0);
  assert.equal(s.sessionId, 'sess-1');
});

test('summarizeProjection：回合开着 + 还没出 token = 在想', () => {
  const s = sum(THINKING);
  assert.equal(s.turnOpen, true);
  assert.equal(s.lastTurn, 5);
  assert.equal(s.firstTokenSeen, false);
  assert.equal(s.pendingCalls.length, 0);
});

test('summarizeProjection：pendingCalls 的键就是 callId', () => {
  const s = sum(WORKING);
  assert.deepEqual(s.pendingCalls, ['call_abc']);
});

test('summarizeProjection：等你回答（Codex 侧拿不到的状态）', () => {
  const s = sum(WAITING);
  assert.equal(s.active.length, 1);
  assert.equal(s.active[0].id, 'q1');
  assert.match(s.active[0].summary, /方案/);
});

test('summarizeProjection：用量换算成协议字段', () => {
  const s = sum(USAGE_A);
  assert.equal(s.usage.provider, 'dsh');
  assert.equal(s.usage.output, 469562);
  assert.equal(s.usage.cached, 115150208);
  assert.equal(s.usage.used, 183950 + 469562 + 115150208);
});

test('首次只对齐基线，不补历史（否则一启动就炸一屏气泡）', () => {
  assert.deepEqual(deriveFromProjection(sum(THINKING), null), []);
});

test('回合开启 → turn/start', () => {
  const evts = deriveFromProjection(sum(THINKING), sum(IDLE));
  assert.deepEqual(evts.map((e) => e.kind), ['turn/start']);
  assert.equal(evts[0].payload.turnId, 'turn-5');
});

test('工具出现 → tool/call；消失 → tool/result', () => {
  const a = deriveFromProjection(sum(WORKING), sum(THINKING));
  assert.deepEqual(a.map((e) => e.kind), ['tool/call']);
  assert.equal(a[0].payload.callId, 'call_abc');

  const b = deriveFromProjection(sum(THINKING), sum(WORKING));
  assert.deepEqual(b.map((e) => e.kind), ['tool/result']);
  assert.equal(b[0].payload.callId, 'call_abc');
});

test('提问出现 → approval/request；消失 → approval/resolved', () => {
  const a = deriveFromProjection(sum(WAITING), sum(THINKING));
  assert.deepEqual(a.map((e) => e.kind), ['approval/request']);
  assert.equal(a[0].payload.approvalId, 'q1');
  assert.equal(a[0].payload.kind, 'question');

  const b = deriveFromProjection(sum(THINKING), sum(WAITING));
  assert.deepEqual(b.map((e) => e.kind), ['approval/resolved']);
});

test('回合关闭 → turn/end', () => {
  const evts = deriveFromProjection(sum(IDLE), sum(THINKING));
  assert.deepEqual(evts.map((e) => e.kind), ['turn/end']);
  assert.equal(evts[0].payload.status, 'ok');
});

test('用量变化 → usage/update（不变则不产生事件）', () => {
  const a = deriveFromProjection(sum(USAGE_B), sum(USAGE_A));
  assert.deepEqual(a.map((e) => e.kind), ['usage/update']);
  const b = deriveFromProjection(sum(USAGE_A), sum(USAGE_A));
  assert.deepEqual(b, []);
});

test('projectionChanged：同样的快照不重复产生事件', () => {
  assert.equal(projectionChanged(sum(USAGE_A), sum(USAGE_A)), false);
  assert.equal(projectionChanged(sum(USAGE_B), sum(USAGE_A)), true);
  assert.equal(projectionChanged(sum(THINKING), null), true);
});

test('所有产出的 kind 都是已登记的协议 kind', () => {
  const all = [
    ...deriveFromProjection(sum(THINKING), sum(IDLE)),
    ...deriveFromProjection(sum(WORKING), sum(THINKING)),
    ...deriveFromProjection(sum(WAITING), sum(THINKING)),
    ...deriveFromProjection(sum(IDLE), sum(THINKING)),
    ...deriveFromProjection(sum(USAGE_B), sum(USAGE_A)),
  ];
  const known = new Set(['turn/start', 'turn/end', 'tool/call', 'tool/result',
    'approval/request', 'approval/resolved', 'usage/update']);
  for (const e of all) assert.ok(known.has(e.kind), `未知 kind: ${e.kind}`);
});

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
