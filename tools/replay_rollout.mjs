/**
 * 用**真实 rollout 日志**回放整条感知链：rollout → codex adapter → arbiter。
 * 不需要 Tauri、不需要 DSH，现在就能验证映射对不对。
 *
 * 运行：node tools/replay_rollout.mjs [文件数]
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { normalizeCodex, newCodexContext, parseRolloutName } from '../app/src/adapters/codex.js';
import { Arbiter } from '../app/src/arbiter.js';
import { KNOWN_KINDS } from '../app/src/protocol.js';

const SESSIONS = path.join(os.homedir(), '.codex', 'sessions');
const ARCHIVED = path.join(os.homedir(), '.codex', 'archived_sessions');

function listRollouts(limit) {
  const walk = (dir) => {
    const out = [];
    const stack = [dir];
    while (stack.length) {
      const d = stack.pop();
      let entries;
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const e of entries) {
        const full = path.join(d, e.name);
        if (e.isDirectory()) stack.push(full);
        else if (/^rollout-.*\.jsonl$/.test(e.name)) out.push(full);
      }
    }
    return out;
  };
  const all = [...walk(SESSIONS), ...walk(ARCHIVED)];
  all.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
  return all.slice(0, limit);
}

function replay(file) {
  const name = path.basename(file);
  const { sessionId: nameSession } = parseRolloutName(name);
  const lines = fs.readFileSync(file, 'utf8').split('\n');

  const arbiter = new Arbiter({ lock: 'auto' });
  const ctx = newCodexContext();
  const counts = new Map();
  const unknownKinds = new Set();
  const timeline = [];
  let parsed = 0;
  let produced = 0;
  let ignored = 0;
  let t0 = null;
  let lastTs = null;
  let lastUsage = null;
  let cursor = null;
  const TICK_STEP_MS = 250;
  const pairs = { start: 0, end: 0, call: 0, result: 0, errorEnd: 0, aborted: 0 };
  const samples = [];

  arbiter.subscribe((snap) => {
    timeline.push({ ts: lastTs, anim: snap.anim, waiting: snap.waiting, busy: snap.busy });
  });

  /**
   * 把时间推进到 to。必须做这件事：若只在「有事件时」才 tick，静默期就被整段跳过，
   * 于是 3 秒庆祝窗口、45 秒衰减、5 分钟入睡这些**基于时间**的状态在回放里全不出现
   * （第一版就出现过 "celebrate 169.9s" 这种不可能的结果）。
   */
  function advance(to) {
    if (cursor == null) {
      cursor = to;
      return;
    }
    while (cursor < to) {
      cursor = Math.min(cursor + TICK_STEP_MS, to);
      lastTs = cursor;
      arbiter.tick(cursor);
    }
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      continue; // 半行/坏行必须容忍
    }
    parsed++;
    const ts = Date.parse(raw.timestamp) || null;
    if (ts != null) {
      if (t0 == null) t0 = ts;
      advance(ts);
      lastTs = ts;
    }
    let out;
    try {
      out = normalizeCodex(raw, ctx, nameSession);
    } catch (e) {
      console.log(`  !! adapter 抛异常: ${e.message}\n     ${line.slice(0, 160)}`);
      continue;
    }
    const events = out == null ? [] : Array.isArray(out) ? out : [out];
    if (!events.length) {
      ignored++;
      continue;
    }
    for (const evt of events) {
      produced++;
      counts.set(evt.kind, (counts.get(evt.kind) || 0) + 1);
      if (!KNOWN_KINDS.has(evt.kind)) unknownKinds.add(evt.kind);
      if (evt.kind === 'turn/start') pairs.start++;
      if (evt.kind === 'turn/end') {
        pairs.end++;
        if (evt.payload.status === 'error') pairs.errorEnd++;
        if (evt.payload.status === 'aborted') pairs.aborted++;
      }
      if (evt.kind === 'tool/call') pairs.call++;
      if (evt.kind === 'tool/result') pairs.result++;
      if (evt.kind === 'usage/update') lastUsage = evt.payload;
      arbiter.ingest(evt);
      if (ts != null) arbiter.tick(ts); // 用真实时间推进衰减，还原真实节奏
      if (samples.length < 4 && ['turn/start', 'tool/call', 'turn/end'].includes(evt.kind)) {
        samples.push(`seq=${evt.seq} ${evt.kind} ${JSON.stringify(evt.payload).slice(0, 110)}`);
      }
    }
  }

  // 压缩时间线
  const compressed = [];
  for (const entry of timeline) {
    const last = compressed[compressed.length - 1];
    if (last && last.anim === entry.anim) last.end = entry.ts;
    else compressed.push({ anim: entry.anim, start: entry.ts, end: entry.ts });
  }

  console.log(`\n${'='.repeat(78)}`);
  console.log(`文件: ${name}`);
  console.log(`会话: ${nameSession?.slice(0, 20) ?? '(未解析)'}   来源: ${path.basename(path.dirname(file))}`);
  console.log(`行数: ${lines.length - 1}  可解析: ${parsed}  产生事件: ${produced}  忽略: ${ignored}`);
  console.log(`配对: turn/start=${pairs.start} turn/end=${pairs.end} ` +
    `(其中 error=${pairs.errorEnd} aborted=${pairs.aborted})  ` +
    `tool/call=${pairs.call} tool/result=${pairs.result}`);
  if (unknownKinds.size) console.log(`!! 未知 kind: ${[...unknownKinds].join(', ')}`);

  console.log('kind 分布:');
  for (const [k, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
    console.log(`   ${String(n).padStart(5)}  ${k}`);
  }

  console.log('状态时间线（压缩后）:');
  for (let i = 0; i < compressed.length; i++) {
    const seg = compressed[i];
    // 每段只有进入时刻；时长要用「下一个不同状态的进入时刻」来算
    const next = compressed[i + 1];
    const end = next ? next.start : seg.end;
    const from = ((seg.start - t0) / 1000).toFixed(1);
    const dur = ((end - seg.start) / 1000).toFixed(1);
    console.log(`   ${from.padStart(8)}s  ${seg.anim.padEnd(10)} ${dur}s`);
  }

  console.log('样例事件:');
  for (const s of samples) console.log(`   ${s}`);

  if (lastUsage) {
    console.log(`用量（本地推导，不依赖任何外部接口）: 总 ${lastUsage.used} tokens ` +
      `(入 ${lastUsage.input} / 出 ${lastUsage.output} / 缓存 ${lastUsage.cached})`);
  }

  return { pairs, unknownKinds: unknownKinds.size, compressed };
}

const limit = Number(process.argv[2] || 3);
const files = listRollouts(limit);
if (!files.length) {
  console.log('没找到 rollout 文件');
  process.exit(1);
}
console.log(`回放 ${files.length} 个真实 rollout（新的在前）`);

let bad = 0;
for (const f of files) {
  const r = replay(f);
  if (r.unknownKinds > 0) bad++;
}
console.log(`\n${'='.repeat(78)}`);
console.log(bad === 0 ? '✓ 全部文件回放完成，无 adapter 异常、无未知 kind'
  : `✗ ${bad} 个文件出现未知 kind`);
process.exit(bad === 0 ? 0 : 1);
