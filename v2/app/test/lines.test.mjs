/**
 * 台词库单测：抽签去重、整活向降权、按事件取类别。
 */
import assert from 'node:assert/strict';
import { Lines, CATEGORIES } from '../src/lines.js';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

/** 最小 localStorage 替身 */
function fakeStorage() {
  const m = new Map();
  return {
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem: (k, v) => m.set(k, String(v)),
  };
}

test('词库完整：用户给的 9 个类别都在，且每类不少于 5 条', () => {
  const want = ['lowBalance', 'working', 'done', 'waiting', 'clickArt',
    'clickFun', 'error', 'idle', 'provider'];
  for (const k of want) {
    assert.ok(CATEGORIES[k], `缺类别 ${k}`);
    assert.ok(CATEGORIES[k].lines.length >= 5, `${k} 条数不足`);
  }
});

test('抽签命中本类别，且不越出类别', () => {
  const l = new Lines({ storage: fakeStorage() });
  for (let i = 0; i < 40; i++) {
    const s = l.pick('error');
    assert.ok(CATEGORIES.error.lines.includes(s), `抽到了非本类别的台词: ${s}`);
  }
});

test('不重复：连续抽不会立刻抽到同一条', () => {
  const l = new Lines({ storage: fakeStorage() });
  let prev = null;
  for (let i = 0; i < 50; i++) {
    const s = l.pick('done');
    assert.notEqual(s, prev, `第 ${i} 次连续抽到同一条：${s}`);
    prev = s;
  }
});

test('一轮用完后会重置，不会抽空', () => {
  const l = new Lines({ storage: fakeStorage() });
  const seen = new Set();
  const n = CATEGORIES.provider.lines.length;
  for (let i = 0; i < n; i++) seen.add(l.pick('provider'));
  assert.equal(seen.size, n, '一轮内应覆盖全部台词');
  assert.ok(l.pick('provider'), '用完一轮后仍能抽出（重置）');
});

test('关闭后台词库不产出', () => {
  const l = new Lines({ storage: fakeStorage() });
  l.setEnabled(false);
  assert.equal(l.pick('done'), null);
  assert.equal(l.pickClick(), null);
  l.setEnabled(true);
  assert.ok(l.pick('done'));
});

test('开关状态会持久化', () => {
  const s = fakeStorage();
  const a = new Lines({ storage: s });
  a.setEnabled(false);
  const b = new Lines({ storage: s });
  assert.equal(b.enabled, false, '重开后应记得关闭状态');
});

test('整活向权重更低：文艺向被抽中的次数应明显更多', () => {
  const l = new Lines({ storage: fakeStorage() });
  const count = { clickArt: 0, clickFun: 0 };
  const artSet = new Set(CATEGORIES.clickArt.lines);
  for (let i = 0; i < 400; i++) {
    const s = l.pickClick();
    if (artSet.has(s)) count.clickArt++; else count.clickFun++;
  }
  assert.ok(count.clickArt > count.clickFun * 1.2,
    `文艺向应明显更多，实际 art=${count.clickArt} fun=${count.clickFun}`);
});

test('事件到类别的映射', () => {
  const l = new Lines({ storage: fakeStorage() });
  assert.equal(l.categoryFor('error'), 'error');
  assert.equal(l.categoryFor('done'), 'done');
  assert.equal(l.categoryFor('waiting'), 'waiting');
  assert.equal(l.categoryFor('idle'), 'idle');
  assert.equal(l.categoryFor('lowBalance'), 'lowBalance');
  assert.equal(l.categoryFor('provider'), 'provider');
  assert.equal(l.categoryFor('nonsense'), null);
});

test('自定义台词替换默认，而不是追加', () => {
  const l = new Lines({ storage: fakeStorage() });
  l.applyCustom({ done: ['只有这一句'] });
  for (let i = 0; i < 20; i++) assert.equal(l.pick('done'), '只有这一句');
  assert.equal(l.isCustom('done'), true);
  assert.equal(l.isCustom('error'), false, '没自定义的类别不应被标记');
});

test('其它类别不受自定义影响', () => {
  const l = new Lines({ storage: fakeStorage() });
  l.applyCustom({ done: ['只有这一句'] });
  const s = l.pick('error');
  assert.ok(CATEGORIES.error.lines.includes(s), '未自定义的类别应保持默认');
});

test('恢复默认：清空自定义后回到内置词库', () => {
  const l = new Lines({ storage: fakeStorage() });
  l.applyCustom({ done: ['只有这一句'] });
  l.applyCustom({});
  assert.equal(l.isCustom('done'), false);
  assert.ok(l.linesFor('done').length > 1, '应回到默认的多条台词');
});

test('空数组视为未自定义（避免误清空成"没台词"）', () => {
  const l = new Lines({ storage: fakeStorage() });
  l.applyCustom({ done: [] });
  assert.equal(l.isCustom('done'), false);
  assert.ok(l.linesFor('done').length > 1);
});

test('自定义后去重记录作废，能立刻抽到新台词', () => {
  const l = new Lines({ storage: fakeStorage() });
  for (let i = 0; i < 5; i++) l.pick('done');
  l.applyCustom({ done: ['新句子A', '新句子B'] });
  const got = new Set();
  for (let i = 0; i < 10; i++) got.add(l.pick('done'));
  assert.ok([...got].every((x) => x.startsWith('新句子')), '应该只抽新台词');
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
