/**
 * 用量播报文本的单测：优先级、单位换算、以及"没数据就别说话"。
 */
import assert from 'node:assert/strict';
import { formatUsageFact, fmtTokens, fmtMoney } from '../src/usage-view.js';

let passed = 0;
const cases = [];
const test = (name, fn) => cases.push([name, fn]);

test('单位换算：K / M / B', () => {
  assert.equal(fmtTokens(0), '0');
  assert.equal(fmtTokens(999), '999');
  assert.equal(fmtTokens(1500), '1.5K');
  assert.equal(fmtTokens(29_398_032), '29.40M');
  assert.equal(fmtTokens(2_500_000_000), '2.50B');
});

test('金额：小额多留小数位，别的两位', () => {
  assert.equal(fmtMoney(0.118, 'USD'), '$0.1180');
  assert.equal(fmtMoney(6.4274, 'USD'), '$6.43');
  assert.equal(fmtMoney(108.165, 'USD'), '$108.17');
  assert.equal(fmtMoney(12.3, 'CNY'), '¥12.30');
  assert.equal(fmtMoney(NaN), '—');
});

test('优先级：官方余额 > 本地账本 > 本地 token', () => {
  const fact = formatUsageFact({
    deepseek: { status: 'ok', balance: 42.5, currency: 'CNY' },
    ccswitch: { status: 'ok', cost: 6.43, currency: 'USD', requests: 127, week: { cost: 6.43 } },
    codex: { used: 366438 },
  });
  assert.ok(fact.startsWith('余额 ¥42.50'), `应优先报余额，实际: ${fact}`);
});

test('没有余额时报本地账本，带今日请求数与近 7 天', () => {
  const fact = formatUsageFact({
    ccswitch: { status: 'ok', cost: 0, currency: 'USD', requests: 0, week: { cost: 6.4274 } },
  });
  assert.equal(fact, '今日 $0.00 · 近 7 天 $6.43');
});

test('DSH 会话花费与账本今日花费同时报，两者不冲突', () => {
  const fact = formatUsageFact({
    ccswitch: { status: 'ok', cost: 1.5, currency: 'USD', requests: 12, week: { cost: 6.4274 } },
    dsh: { status: 'ok', cost: 2.3653, currency: 'USD', model: 'deepseek-flash', used: 1000 },
  });
  assert.equal(fact, '本次会话 $2.37 · 今日 $1.50 · 12 次（deepseek-flash） · 近 7 天 $6.43');
});

test('账本今日为 0 时只报会话花费，不报空的今日', () => {
  const fact = formatUsageFact({
    ccswitch: { status: 'ok', cost: 0, currency: 'USD', requests: 0, week: { cost: 6.4274 } },
    dsh: { status: 'ok', cost: 2.3653, currency: 'USD', model: 'deepseek-flash', used: 205_455_609 },
  });
  assert.equal(fact, '本次会话 $2.37（deepseek-flash） · 近 7 天 $6.43');
});

test('账本不可用时退回本地 Agent token', () => {
  const fact = formatUsageFact({
    ccswitch: { status: 'unavailable' },
    codex: { used: 366438 },
    dsh: { used: 146_982_713 },
  });
  assert.equal(fact, '本次会话 codex 366.4K · dsh 146.98M');
});

test('完全没有数据时返回空串（调用方应安静跳过，不弹空气泡）', () => {
  assert.equal(formatUsageFact({}), '');
  assert.equal(formatUsageFact({ ccswitch: { status: 'no-key' } }), '');
  assert.equal(formatUsageFact({ codex: { used: 0 } }), '');
});

test('computeCost：按每百万 token 单价折算', async () => {
  const { computeCost } = await import('../../tools/usage.mjs');
  const cost = computeCost(
    { input: 1_081_219, output: 674_984, cached: 202_238_080 },
    { input: 0.3, output: 1.2, cached: 0.006 },
  );
  // 手算：0.3244 + 0.8100 + 1.2134 = 2.3478
  assert.ok(Math.abs(cost - 2.3478) < 0.001, `实际 ${cost}`);
  assert.equal(computeCost(null, { input: 1 }), null);
  assert.equal(computeCost({ input: 1 }, null), null);
});

test('余额差额 = 真实消耗（官方只给余额，用量只能这么推）', async () => {
  const { spendSince } = await import('../../tools/usage.mjs');
  const now = 1_000_000_000;
  const s = [
    { ts: now - 20 * 3600e3, balance: 100, currency: 'CNY' },
    { ts: now - 10 * 3600e3, balance: 92, currency: 'CNY' },
    { ts: now - 3600e3, balance: 90.26, currency: 'CNY' },
  ];
  const day = spendSince(s, 24 * 3600e3, now);
  assert.ok(Math.abs(day.spent - 9.74) < 1e-6, `实际 ${day.spent}`);
  assert.equal(day.currency, 'CNY');
  assert.equal(day.replenished, false);
});

test('充值让余额变大时不能算成负消耗', async () => {
  const { spendSince } = await import('../../tools/usage.mjs');
  const now = 1_000_000_000;
  const r = spendSince([
    { ts: now - 3600e3, balance: 50, currency: 'CNY' },
    { ts: now, balance: 150, currency: 'CNY' },
  ], 24 * 3600e3, now);
  assert.equal(r.spent, 0);
  assert.equal(r.replenished, true);
});

test('采样不足两点时返回 null（不猜）', async () => {
  const { spendSince } = await import('../../tools/usage.mjs');
  assert.equal(spendSince([{ ts: Date.now(), balance: 50, currency: 'CNY' }], 24 * 3600e3), null);
  assert.equal(spendSince([], 24 * 3600e3), null);
});

test('窗口外的旧采样不参与差额', async () => {
  const { spendSince } = await import('../../tools/usage.mjs');
  const now = 1_000_000_000;
  const r = spendSince([
    { ts: now - 48 * 3600e3, balance: 500, currency: 'CNY' },
    { ts: now - 2 * 3600e3, balance: 100, currency: 'CNY' },
    { ts: now, balance: 91, currency: 'CNY' },
  ], 24 * 3600e3, now);
  assert.ok(Math.abs(r.spent - 9) < 1e-6, `应只算窗口内，实际 ${r.spent}`);
});

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
