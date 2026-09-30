/**
 * 桥接端到端验证：健康检查 → 历史补齐 → SSE 实时推送 → 追加一行能否立即到达。
 * 运行前请先启动 tools/pet_bridge.mjs（监视 tools/_fixtures）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, '_fixtures', 'rollout-2026-01-01T00-00-00-aaaaaaaa-test.jsonl');
const BASE = process.env.BRIDGE || 'http://127.0.0.1:8792';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (ok, label, extra = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${label}${extra ? `  ${extra}` : ''}`);
  if (!ok) failures++;
};

// 等桥接起来
let health = null;
for (let i = 0; i < 20; i++) {
  try {
    health = await fetch(`${BASE}/health`).then((r) => r.json());
    break;
  } catch {
    await sleep(500);
  }
}
if (!health) {
  console.log('✗ 桥接未启动');
  process.exit(1);
}

console.log('1) 健康检查');
check(health.ok === true, 'health.ok');
check(Array.isArray(health.watched) && health.watched.length === 1,
  '监听到 1 个会话文件', JSON.stringify(health.watched));
check(health.outFile && health.outFile.length > 0, '事件文件路径已确定', health.outFile);

console.log('\n2) 历史补齐（/recent）');
const recent = await fetch(`${BASE}/recent?n=200`).then((r) => r.json());
const kinds = recent.map((e) => e.kind);
check(recent.length >= 5, `补到 ${recent.length} 条事件`);
for (const want of ['session/start', 'turn/start', 'tool/call', 'tool/result', 'usage/update', 'turn/end']) {
  check(kinds.includes(want), `含 ${want}`);
}
check(recent.every((e, i) => i === 0 || e.seq > recent[i - 1].seq),
  'seq 严格单调递增（桥接层自己分配，不沿用源行号）');

console.log('\n3) SSE 实时推送');
const ac = new AbortController();
const res = await fetch(`${BASE}/events`, { signal: ac.signal });
check(res.status === 200 && /text\/event-stream/.test(res.headers.get('content-type') || ''),
  'SSE 响应头正确', res.headers.get('content-type') || '');

const reader = res.body.getReader();
const dec = new TextDecoder();
let received = null;
const pump = (async () => {
  let buf = '';
  while (!received) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const l of lines) {
      if (l.startsWith('data: ')) {
        received = JSON.parse(l.slice(6));
        return;
      }
    }
  }
})();

await sleep(400);
const live = { timestamp: new Date().toISOString(), ordinal: 99, type: 'event_msg',
  payload: { type: 'task_started', turn_id: 'T-live-test' } };
fs.appendFileSync(FIXTURE, `${JSON.stringify(live)}\n`);
console.log('  已向 fixture 追加 1 行（task_started）');

try {
  await Promise.race([pump, sleep(8000).then(() => { throw new Error('8 秒内没收到 SSE 推送'); })]);
} catch (e) {
  console.log(`  ✗ ${e.message}`);
  failures++;
}
check(received?.kind === 'turn/start', 'SSE 收到追加的事件', received ? `${received.kind} seq=${received.seq}` : '');
check(received?.payload?.turnId === 'T-live-test', 'turnId 正确解析');
check(received?.payload?.srcOrdinal === 99, '源行号保留在 payload.srcOrdinal 备查');
ac.abort();

console.log('\n4) 协议 JSONL 落盘');
const outLines = fs.readFileSync(health.outFile, 'utf8').trim().split('\n');
check(outLines.length >= 6, `事件文件写了 ${outLines.length} 行`);
const last = JSON.parse(outLines[outLines.length - 1]);
check(last.kind === 'turn/start' && last.payload.turnId === 'T-live-test', '最后一行是新事件');

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}`);
process.exit(failures === 0 ? 0 : 1);
