/**
 * 纯逻辑单测：protocol / arbiter / bubbles 都不依赖浏览器 API，可以直接在 node 里跑。
 * 运行：node app/test/logic.test.mjs
 */
import assert from 'node:assert/strict';
import { KIND, parseLine, makeEvent } from '../src/protocol.js';
import { Arbiter } from '../src/arbiter.js';
import { BubbleQueue, BUBBLE } from '../src/bubbles.js';
import { SpriteLibrary } from '../src/assets.js';
import { PetRenderer } from '../src/renderer.js';

let passed = 0;
const cases = [];
function test(name, fn) {
  cases.push([name, fn]);
}
function ev(kind, payload = {}, { agent = 'codex', sessionId = 's1', ts = 1000, seq = null } = {}) {
  return { v: 1, seq, ts, agent, sessionId, kind, known: true, payload, actions: [] };
}

// ---------------------------------------------------------------- protocol
test('parseLine 接受合法行', () => {
  const e = parseLine('{"v":1,"seq":3,"ts":5,"agent":"dsh","kind":"turn/start","payload":{}}');
  assert.equal(e.kind, 'turn/start');
  assert.equal(e.agent, 'dsh');
  assert.equal(e.known, true);
});

test('parseLine 丢弃坏行与半行', () => {
  assert.equal(parseLine(''), null);
  assert.equal(parseLine('{ not json'), null);
  assert.equal(parseLine('{"v":1}'), null); // 缺 kind
  assert.equal(parseLine('{"kind":"turn/start"'), null); // 半行
});

test('parseLine 保留未知 kind（前向兼容）', () => {
  const e = parseLine('{"agent":"x","kind":"future/thing","payload":{"a":1}}');
  assert.equal(e.known, false);
  assert.equal(e.payload.a, 1);
});

test('parseLine 容忍缺字段', () => {
  const e = parseLine('{"kind":"notice"}');
  assert.equal(e.seq, null);
  assert.equal(e.sessionId, null);
  assert.deepEqual(e.actions, []);
});

// ---------------------------------------------------------------- arbiter
test('turn/start → thinking', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }));
  assert.equal(a.resolve().anim, 'thinking');
});

test('tool/call → working（埋头敲键盘），忙碌组切换有 2.2s 防抖', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }, { ts: 1000 }));
  assert.equal(a.resolve(1000).anim, 'thinking');
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1', tool: 'pwsh' }, { ts: 2000 }));
  assert.equal(a.resolve(2000).anim, 'thinking', '切换在防抖窗口内，不应立刻闪成 working');
  assert.equal(a.resolve(2900).anim, 'thinking', '2.2s 防抖窗口内仍不应提交');
  assert.equal(a.resolve(4300).anim, 'working', '持续超过 2.2s 后提交');
});

test('短工具调用不会让动画抖动', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }, { ts: 1000 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1' }, { ts: 2000 }));
  a.ingest(ev(KIND.TOOL_RESULT, { callId: 'c1', ok: true }, { ts: 2100 })); // 100ms 就返回了
  assert.equal(a.resolve(2100).anim, 'thinking', '短工具调用全程保持 thinking，不闪 keyboard');
});

test('工具返回后回到 thinking（回合还开着）', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }, { ts: 1000 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1' }, { ts: 2000 }));
  assert.equal(a.resolve(4300).anim, 'working', '超过防抖窗口后提交 working');
  // 注意时间要单调递增：先 resolve(4300) 再塞 ts=3000 的事件会让防抖窗口算错
  a.ingest(ev(KIND.TOOL_RESULT, { callId: 'c1', ok: true }, { ts: 4400 }));
  // working→thinking 也是「忙碌组内切换」，同样要等满防抖窗口才提交
  assert.equal(a.resolve(5400).anim, 'working', '防抖窗口内先保持 working');
  assert.equal(a.resolve(6800).anim, 'thinking', '等满 2.2s 后提交 thinking');
});

test('并发工具未全部返回时保持 working', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }, { ts: 1000 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1' }, { ts: 2000 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c2' }, { ts: 2100 }));
  assert.equal(a.resolve(4300).anim, 'working');
  a.ingest(ev(KIND.TOOL_RESULT, { callId: 'c1', ok: true }, { ts: 4400 }));
  assert.equal(a.resolve(6800).anim, 'working', '还有一个工具没回来');
  a.ingest(ev(KIND.TOOL_RESULT, { callId: 'c2', ok: true }, { ts: 6900 }));
  assert.equal(a.resolve(9300).anim, 'thinking');
});

test('working 优先于 thinking（跨会话）', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, {}, { sessionId: 'sA', ts: 1000 }));
  a.ingest(ev(KIND.TURN_START, {}, { sessionId: 'sB', ts: 1100 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1' }, { sessionId: 'sB', ts: 2000 }));
  const snap = a.resolve(4300);
  assert.equal(snap.anim, 'working');
  assert.equal(snap.working, 1);
  assert.equal(snap.thinking, 1);
});

test('审批解决后回到 working（若还有工具在跑）', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }, { ts: 1000 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1' }, { ts: 2000 }));
  a.ingest(ev(KIND.APPROVAL_REQUEST, { approvalId: 'ap1' }, { ts: 3000 }));
  assert.equal(a.resolve(3000).anim, 'waiting');
  a.ingest(ev(KIND.APPROVAL_RESOLVED, { approvalId: 'ap1', decision: 'allow' }, { ts: 3100 }));
  // waiting → working 不属于「忙碌组内互切」，立即生效
  assert.equal(a.resolve(3100).anim, 'working');
});

test('approval/request 优先级最高', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START));
  a.ingest(ev(KIND.APPROVAL_REQUEST, { approvalId: 'ap1' }));
  assert.equal(a.resolve().anim, 'waiting');
  assert.equal(a.resolve().waiting, 1);
});

test('approval/resolved 回到 busy，不是等待', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START));
  a.ingest(ev(KIND.APPROVAL_REQUEST, { approvalId: 'ap1' }));
  a.ingest(ev(KIND.APPROVAL_RESOLVED, { approvalId: 'ap1', decision: 'allow' }));
  assert.equal(a.resolve().anim, 'thinking');
});

test('error 压过 busy，但被 waiting 压过', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.ERROR, { message: 'boom' }));
  assert.equal(a.resolve().anim, 'error');
  a.ingest(ev(KIND.APPROVAL_REQUEST, { approvalId: 'ap1', sessionId: 's2' }));
  assert.equal(a.resolve().anim, 'waiting');
});

test('turn/end ok → celebrate，超时后回落', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, {}, { ts: 1000 }));
  a.ingest(ev(KIND.TURN_END, { status: 'ok' }, { ts: 2000 }));
  assert.equal(a.resolve(2500).anim, 'celebrate'); // 庆祝窗口内
  assert.equal(a.resolve(6000).anim, 'idle');      // 窗口过后回落
});

test('忙 优先于 庆祝：新工作开始时不演庆祝', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_END, { status: 'ok' }, { ts: 1000 }));
  assert.equal(a.resolve(1100).anim, 'celebrate');
  a.ingest(ev(KIND.TURN_START, {}, { sessionId: 's2', ts: 1200 }));
  assert.equal(a.resolve(1200).anim, 'thinking');
});

test('心跳不重置空闲计时（否则宠物永远不会睡着）', () => {
  const a = new Arbiter();
  const t0 = 1_000_000;
  a.ingest(ev(KIND.TURN_END, { status: 'ok' }, { ts: t0 }));
  // 之后只来心跳，而且一直来
  for (let i = 1; i <= 7; i++) {
    a.ingest(ev(KIND.AGENT_HEARTBEAT, {}, { ts: t0 + i * 60_000 }));
    a.tick(t0 + i * 60_000);
  }
  const later = t0 + 7 * 60_000;
  assert.equal(a.resolve(later).anim, 'sleep', '只有心跳时也应该照常进入熟睡');
});

test('新鲜度衰减：活跃态 45s 无事件回落 idle（保险丝）', () => {
  const a = new Arbiter();
  const t0 = 1_000_000;
  a.ingest(ev(KIND.TURN_START, {}, { ts: t0 }));
  assert.equal(a.resolve(t0).anim, 'thinking');
  a.tick(t0 + 46_000);
  assert.equal(a.resolve(t0 + 46_000).anim, 'idle');
});

test('长时间无事件 → doze → sleep', () => {
  const a = new Arbiter();
  const t0 = 1_000_000;
  a.ingest(ev(KIND.TURN_START, {}, { ts: t0 }));
  a.ingest(ev(KIND.TURN_END, { status: 'ok' }, { ts: t0 + 1 }));
  a.tick(t0 + 6 * 60_000);
  assert.equal(a.resolve(t0 + 6 * 60_000).anim, 'doze');
  a.tick(t0 + 6 * 60_000 + 7000);
  assert.equal(a.resolve(t0 + 6 * 60_000 + 7000).anim, 'sleep');
});

test('锁定模式忽略另一侧 Agent 的状态', () => {
  const a = new Arbiter({ lock: 'dsh' });
  a.ingest(ev(KIND.TURN_START, {}, { agent: 'codex' }));
  assert.equal(a.resolve().anim, 'idle');
  a.ingest(ev(KIND.TURN_START, {}, { agent: 'dsh' }));
  assert.equal(a.resolve().anim, 'thinking');
});

test('seq 重复被丢弃', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, {}, { seq: 5 }));
  a.ingest(ev(KIND.ERROR, { message: 'x' }, { seq: 5 })); // 同 seq，应被丢
  assert.equal(a.resolve().anim, 'thinking');
});

test('状态切换递增 epoch（渲染端据此重播 one-shot）', () => {
  const a = new Arbiter();
  const snaps = [];
  a.subscribe((s) => snaps.push(s));
  a.ingest(ev(KIND.TURN_START));
  a.ingest(ev(KIND.TURN_END, { status: 'ok' }));
  const epochs = snaps.map((s) => s.epoch);
  assert.ok(epochs[0] < epochs[epochs.length - 1], `epoch 应递增: ${epochs}`);
});

// ---------------------------------------------------------------- bubbles
test('气泡：等待类永不过期，完成类 8 秒过期', () => {
  const q = new BubbleQueue();
  const t0 = Date.now();
  q.push({ kind: BUBBLE.WAITING, title: 'W', text: 'w' });
  q.push({ kind: BUBBLE.DONE, title: 'D', text: 'd' });
  q.tick(t0 + 9000);
  const kinds = q.items.map((i) => i.kind);
  assert.deepEqual(kinds, [BUBBLE.WAITING]);
});

test('气泡：新通知令旧的完成气泡降级为折叠，而不是消失', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.DONE, title: 'D1', text: 'd' });
  q.push({ kind: BUBBLE.ERROR, title: 'E', text: 'e' });
  const done = q.items.find((i) => i.kind === BUBBLE.DONE);
  assert.equal(done.collapsed, true);
  assert.equal(done.expiresAt, null);
  assert.equal(q.items.length, 2); // 没有消失
});

test('气泡：同一审批去重 + 主动撤回（防幽灵审批）', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.WAITING, title: 'W', ref: 'codex:ap1' });
  q.push({ kind: BUBBLE.WAITING, title: 'W', ref: 'codex:ap1' });
  assert.equal(q.items.length, 1);
  q.retract('codex:ap1');
  assert.equal(q.items.length, 0);
});

test('气泡：折叠态上限 5 条', () => {
  const q = new BubbleQueue();
  for (let i = 0; i < 8; i++) {
    q.push({ kind: BUBBLE.DONE, title: `D${i}` });
    q.push({ kind: BUBBLE.ERROR, title: `E${i}` });
  }
  const collapsed = q.items.filter((i) => i.collapsed);
  assert.ok(collapsed.length <= 5, `折叠态 ${collapsed.length} 条应 <= 5`);
});

test('气泡：等待类整体置顶且按到达时间排序', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.ERROR, title: 'E' });
  q.push({ kind: BUBBLE.WAITING, title: 'W1' });
  q.push({ kind: BUBBLE.WAITING, title: 'W2' });
  const order = q.ordered().map((i) => i.title);
  assert.deepEqual(order, ['W1', 'W2', 'E']);
});

test('气泡：两个 Agent 同时等 → 合并文案', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.WAITING, title: 'W', agent: 'dsh', ref: 'dsh:1' });
  q.push({ kind: BUBBLE.WAITING, title: 'W', agent: 'codex', ref: 'codex:1' });
  const s = q.summary();
  assert.equal(s.merged, true);
  assert.match(s.text, /DSH 和 Codex 都在等你/);
});

// ---------------------------------------------------------------- 播放语义
const fakeLib = (name, info) => new SpriteLibrary('/assets/', {
  cell: 256,
  states: { [name]: { file: `states/${name}.png`, fps: 12, ...info } },
});

test('once_loop：动作播一次后进入尾部循环（working 用）', () => {
  const lib = fakeLib('working', { frames: 10, loopFrom: 4, mode: 'once_loop' });
  const play = (from, to) => Array.from({ length: to - from }, (_, i) => lib.frameIndex('working', from + i));
  assert.deepEqual(play(0, 10), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9], '第一遍完整播动作');
  assert.deepEqual(play(10, 16), [4, 5, 6, 7, 8, 9], '之后只在尾部循环，不重播拿出电脑');
  assert.deepEqual(play(16, 22), [4, 5, 6, 7, 8, 9]);
});

test('pingpong：往复播放且首尾不重复', () => {
  const lib = fakeLib('idle', { frames: 5, mode: 'pingpong' });
  const seq = Array.from({ length: 8 }, (_, i) => lib.frameIndex('idle', i));
  assert.deepEqual(seq, [0, 1, 2, 3, 4, 3, 2, 1]);
});

test('once：播完停在最后一帧', () => {
  const lib = fakeLib('celebrate', { frames: 4, mode: 'once' });
  const seq = Array.from({ length: 6 }, (_, i) => lib.frameIndex('celebrate', i));
  assert.deepEqual(seq, [0, 1, 2, 3, 3, 3]);
});

test('loop：正序环绕', () => {
  const lib = fakeLib('waiting', { frames: 3, mode: 'loop' });
  const seq = Array.from({ length: 5 }, (_, i) => lib.frameIndex('waiting', i));
  assert.deepEqual(seq, [0, 1, 2, 0, 1]);
});

test('renderer：setState 必须自动开始渲染循环', () => {
  // 真实事故：主流程漏调 start()，结果「气泡正常、角色全白」——
  // 纯逻辑单测抓不到，因为它测的是状态机而不是绘制循环。这里把循环启动锁住。
  const rafCalls = [];
  globalThis.window = { devicePixelRatio: 1, addEventListener() {} };
  globalThis.requestAnimationFrame = (fn) => { rafCalls.push(fn); return rafCalls.length; };
  // 渲染器现在会建离屏 canvas 做交叉淡化，所以需要 createElement 桩
  globalThis.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => ({ setTransform() {}, clearRect() {}, drawImage() {} }),
    }),
  };
  const ctx = { setTransform() {}, clearRect() {}, drawImage() {}, save() {}, restore() {},
    translate() {}, rotate() {}, scale() {} };
  const canvas = { width: 0, height: 0, style: {}, getContext: () => ctx };
  const lib = new SpriteLibrary('/assets/', {
    cell: 256,
    states: { idle: { file: 'states/idle.png', frames: 4, fps: 12, mode: 'loop' } },
  });
  lib.load = async () => ({ img: {}, frames: 4 }); // 不真去加载图片

  const r = new PetRenderer(canvas, lib, { size: 100 });
  assert.equal(r.running, false, '构造后不应自行运行');
  r.setState({ anim: 'idle', epoch: 0 });
  assert.equal(r.running, true, 'setState 之后必须已在运行');
  assert.ok(rafCalls.length > 0, '必须已排入 requestAnimationFrame');
  assert.equal(r.tick, 0, '状态切换应把帧计数归零');
  delete globalThis.window;
});

test('气泡：最多显示 2 条，其余折叠计数（治堆积）', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.ERROR, title: 'E1' });
  q.push({ kind: BUBBLE.ERROR, title: 'E2' });
  q.push({ kind: BUBBLE.ERROR, title: 'E3' });
  const { shown, hiddenCount } = q.visibleSummary(2);
  assert.equal(shown.length, 2, '只显示两条');
  assert.equal(hiddenCount, 1, '第三条计入折叠');
});

test('气泡：等待类优先占显示位', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.ERROR, title: 'E1' });
  q.push({ kind: BUBBLE.ERROR, title: 'E2' });
  q.push({ kind: BUBBLE.WAITING, title: 'W', agent: 'dsh' });
  const { shown } = q.visibleSummary(2);
  assert.ok(shown.some((i) => i.kind === BUBBLE.WAITING), '等待类必须在显示位里');
  assert.equal(shown.length, 2);
});

test('气泡：新回合开始把上一轮的完成/错误收进折叠（等待类保留）', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.DONE, title: 'D' });
  q.push({ kind: BUBBLE.ERROR, title: 'E' });
  q.push({ kind: BUBBLE.WAITING, title: 'W', agent: 'dsh' });
  q.retireStale();
  const visibleKinds = q.items.filter((i) => !i.collapsed).map((i) => i.kind);
  assert.deepEqual(visibleKinds, [BUBBLE.WAITING], '旧通知应被收起，等待类保留');
});

test('气泡：出错不再永久常驻（60 秒后过期）', () => {
  const q = new BubbleQueue();
  const t0 = Date.now();
  q.push({ kind: BUBBLE.ERROR, title: 'E' });
  q.tick(t0 + 30_000);
  assert.equal(q.items.length, 1, '30 秒内还在');
  q.tick(t0 + 61_000);
  assert.equal(q.items.length, 0, '超过 60 秒应被清掉');
});

test('气泡：同级内新的排前面（否则点击台词会被最旧那条永久占位）', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.INFO, title: '第一句点击台词' });
  q.push({ kind: BUBBLE.INFO, title: '第二句点击台词' });
  q.push({ kind: BUBBLE.INFO, title: '第三句点击台词' });
  const { shown, hiddenCount } = q.visibleSummary(1);
  assert.equal(shown[0].title, '第三句点击台词', '显示位应给最新的一条');
  assert.equal(hiddenCount, 2);
});

test('气泡：等待类仍然 FIFO（先来的先处理）', () => {
  const q = new BubbleQueue();
  q.push({ kind: BUBBLE.WAITING, title: '先来的', agent: 'dsh' });
  q.push({ kind: BUBBLE.WAITING, title: '后来的', agent: 'codex' });
  assert.equal(q.ordered()[0].title, '先来的');
});

test('气泡：点击台词会自动过期（连点不会堆一片）', () => {
  const q = new BubbleQueue();
  const t0 = Date.now();
  q.push({ kind: BUBBLE.INFO, title: '一句台词' });
  q.tick(t0 + 10_000);
  assert.equal(q.items.length, 1, '10 秒内还在');
  q.tick(t0 + 21_000);
  assert.equal(q.items.length, 0, '超过 20 秒应消失');
});

test('心跳还在时不做 45 秒衰减：长任务必须一直保持 working', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }, { ts: 1000 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1' }, { ts: 2000 }));
  assert.equal(a.resolve(4300).anim, 'working');
  // 之后没有任何新事件（长命令在跑），但心跳每 10 秒来一次
  for (let t = 10_000; t <= 200_000; t += 10_000) {
    a.ingest(ev(KIND.AGENT_HEARTBEAT, {}, { ts: t }));
    a.tick(t);
  }
  assert.equal(a.resolve(200_000).anim, 'working', '心跳活着就不该把 working 衰减掉');
});

test('心跳停了才启用保险丝：无事件+无心跳 → 回落 idle（防 Agent 崩溃后永久转圈）', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }, { ts: 1000 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1' }, { ts: 2000 }));
  assert.equal(a.resolve(4300).anim, 'working');
  a.tick(80_000); // 没心跳、也没事件
  assert.equal(a.resolve(80_000).anim, 'idle', '通道死了就该落回 idle');
});

test('有工具在跑时不会打瞌睡（长任务跑到 5 分钟也不该睡）', () => {
  const a = new Arbiter();
  a.ingest(ev(KIND.TURN_START, { turnId: 't1' }, { ts: 1000 }));
  a.ingest(ev(KIND.TOOL_CALL, { callId: 'c1' }, { ts: 2000 }));
  for (let t = 10_000; t <= 400_000; t += 10_000) {
    a.ingest(ev(KIND.AGENT_HEARTBEAT, {}, { ts: t }));
    a.tick(t);
  }
  const snap = a.resolve(400_000);
  assert.equal(snap.anim, 'working', '整段时间都该是 working');
  assert.notEqual(snap.anim, 'doze');
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
