/**
 * 互动/彩蛋 与 命中遮罩 的单测。
 * 这两个模块是「以后加彩蛋不用大改」和「点击穿透对不对」的关键，
 * 所以即使是浏览器代码也在这里用桩跑一遍。
 */
import assert from 'node:assert/strict';
import { Interactions } from '../src/interactions.js';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

function makeTracker() {
  const played = [];
  const events = [];
  const it = new Interactions({
    play: (state, ms) => { played.push([state, ms]); return true; },
    onEvent: (name, detail) => events.push([name, detail]),
  });
  it.registerDefaults();
  return { it, played, events };
}

const clicks = (it, n) => { for (let i = 0; i < n; i++) it.feed({ type: 'click' }); };

test('判定要延后：还没 flush 时不触发（否则双击会抢在连点前面）', () => {
  const { it, played } = makeTracker();
  clicks(it, 2);
  assert.equal(played.length, 0, 'feed 之后不应立即触发');
  it.flush();
  assert.equal(played.length, 1);
});

test('取满足条件里次数最高的规则：2 下→打招呼，4 下仍→打招呼', () => {
  const a = makeTracker();
  clicks(a.it, 2); a.it.flush();
  assert.equal(a.played[0][0], 'egg_hello');

  const b = makeTracker();
  clicks(b.it, 4); b.it.flush();
  assert.equal(b.played[0][0], 'egg_hello', '4 下只满足「2 次」那条');
});

test('5 下 → 拍一拍；10 下 → 戳烦了', () => {
  const a = makeTracker();
  clicks(a.it, 5); a.it.flush();
  assert.deepEqual(a.played[0], ['egg_pat', 2200]);

  const b = makeTracker();
  clicks(b.it, 10); b.it.flush();
  assert.equal(b.played[0][0], 'egg_annoyed');
});

test('触发后进入冷却，继续点不重复触发', () => {
  const { it, played } = makeTracker();
  clicks(it, 10); it.flush();
  const n = played.length;
  clicks(it, 10); it.flush();
  assert.equal(played.length, n, '冷却期内不应再触发');
});

test('长按触发 hold 规则', () => {
  const { it, played } = makeTracker();
  it.feed({ type: 'longPress', durationMs: 950 });
  assert.equal(played[0][0], 'egg_hold');
});

test('状态没素材时 play 返回 false，仍然进入冷却（否则会刷屏）', () => {
  const played = [];
  const it = new Interactions({ play: (s) => { played.push(s); return false; } });
  it.register({ id: 'x', type: 'clickCount', count: 3, windowMs: 2000, play: 'egg_none', durationMs: 1000 });
  clicks(it, 3); it.flush();
  assert.equal(played.length, 1);
  clicks(it, 3); it.flush();
  assert.equal(played.length, 1, '冷却期内不应重复调用');
});

test('register 返回 id，list() 能列出彩蛋清单（供设置页用）', () => {
  const { it } = makeTracker();
  const id = it.register({ id: 'custom', type: 'clickCount', count: 3, play: 'egg_x' });
  assert.equal(id, 'custom');
  assert.ok(it.list().some((r) => r.id === 'custom'));
  assert.ok(it.list().length >= 6, '默认彩蛋 + 自定义都在清单里');
});

// ------------------------------------------------------------------ 命中遮罩
globalThis.window = { innerWidth: 240, innerHeight: 260, addEventListener() {} };
globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
const { PointerBridge } = await import('../src/pointer.js');

/** 用真实尺寸的画布（200x200），这样 1 像素 ≈ 1 CSS 像素，格子映射才有意义 */
function fakeCanvas({ opaque = [], size = 200 } = {}) {
  const data = new Uint8ClampedArray(size * size * 4);
  for (const [x, y] of opaque) data[(y * size + x) * 4 + 3] = 255;
  return {
    width: size, height: size,
    getBoundingClientRect: () => ({ left: 20, top: 60, width: 200, height: 200 }),
    getContext: () => ({ getImageData: () => ({ data }) }),
  };
}

test('遮罩：不透明像素映射到正确的格子（窗口 240x260，画布 200x200 居中）', () => {
  const b = new PointerBridge({ canvas: fakeCanvas({ opaque: [[100, 100]] }) });
  const { cols, rows, bits } = b.buildMask();
  assert.equal(cols, 64);
  assert.equal(rows, 64);
  // 画布内 (100,100)/200 → 窗口 (20+100, 60+100) = (120,160)
  // → 格子 (floor(120/240*64), floor(160/260*64)) = (32, 39)
  assert.equal(bits[39 * 64 + 32], 1, '该格应被标记为可交互');
  assert.equal(bits.reduce((a, v) => a + v, 0), 1, '只应有这一个格子被标记');
});

test('遮罩：全透明画布 → 全 0（整窗可穿透）', () => {
  const b = new PointerBridge({ canvas: fakeCanvas({ opaque: [] }) });
  const { bits } = b.buildMask();
  assert.equal(bits.reduce((a, v) => a + v, 0), 0);
});

test('遮罩：气泡矩形整块算可点击区域', () => {
  globalThis.document = {
    getElementById: () => null,
    querySelectorAll: () => [{
      getBoundingClientRect: () => ({ left: 0, top: 0, width: 120, height: 30 }),
    }],
  };
  const b = new PointerBridge({ canvas: fakeCanvas({ opaque: [] }) });
  const { bits } = b.buildMask();
  assert.ok(bits.reduce((a, v) => a + v, 0) > 0, '气泡区域应被标记');
  assert.equal(bits[0], 1, '左上角（气泡内）应被标记');
  globalThis.document = { querySelectorAll: () => [], getElementById: () => null };
});

test('遮罩：内容不变时两次结果一致（push 据此去重，省 IPC）', () => {
  const b = new PointerBridge({ canvas: fakeCanvas({ opaque: [[50, 50]] }) });
  const a1 = b.buildMask();
  const a2 = b.buildMask();
  assert.deepEqual(Array.from(a2.bits), Array.from(a1.bits));
});

// ------------------------------------------------------------------ run
for (const [name, fn] of cases) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    console.log(`  ✗ ${name}\n      ${e.message}`);
    process.exitCode = 1;
  }
}
console.log(`\n${passed}/${cases.length} 通过`);
