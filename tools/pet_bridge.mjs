/**
 * 桌宠桥接进程（开发期与产品期共用同一套协议）
 *
 *   rollout JSONL ──tail──▶ codex adapter ──▶ 协议事件
 *                                              ├─ 追加到 events/codex.jsonl（协议主通道）
 *                                              └─ 通过 SSE 推给浏览器预览页
 *
 * 运行：node tools/pet_bridge.mjs [--dir <监视目录>] [--out <输出目录>] [--port 8792]
 *
 * 注意 seq 的所有权：源日志的 ordinal 是**按会话分文件、各自从 0 开始**的，
 * 直接拿来做全局去重会让第二个会话的事件全部被当成重复丢掉。
 * 所以 seq 由本进程分配（每 agent 单调递增），源行号放进 payload.srcOrdinal 备查。
 */
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { normalizeCodex, newCodexContext, AGENT } from '../app/src/adapters/codex.js';
import {
  summarizeProjection, deriveFromProjection, projectionChanged, AGENT as DSH_AGENT,
} from '../app/src/adapters/dsh.js';
import {
  loadConfig, saveConfig, publicConfig, queryAll, usageChanged,
} from './usage.mjs';
import { CATEGORIES } from '../app/src/lines.js';

const args = process.argv.slice(2);
const opt = (name, dflt) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};

const WATCH_DIR = opt('dir', path.join(os.homedir(), '.codex', 'sessions'));
/**
 * Codex 的新鲜度窗口：超过这个时间没动过的会话/事件都不算"当前状态"。
 * 默认 15 分钟——足以覆盖一个正在跑的长任务，又能挡住几天的历史。
 */
const CODEX_FRESH_MS = Number(opt('codex-fresh', 15 * 60 * 1000));
// DSH 的会话投影快照目录 —— 零安装路径（不需要装桥接插件）
const DSH_DIR = opt('dsh-dir',
  path.join(os.homedir(), '.dsh', 'storages', 'session_projcache', 'sessions'));
const DSH_ENABLED = args.indexOf('--no-dsh') < 0;
/** 只跟最近这么久的会话，避免把历史会话全灌进状态机 */
const DSH_FRESH_MS = Number(opt('dsh-fresh', 6 * 60 * 60 * 1000));
const PORT = Number(opt('port', 8792));
const POLL_MS = Number(opt('poll', 500));
const BACKFILL_LINES = 200;
// 首次只从文件尾部读这么多字节，避免把几天前的历史整篇灌进状态机
const SEED_BYTES = Number(opt('seed', 65536));

function defaultOutDir() {
  const appdata = process.env.APPDATA;
  if (appdata) return path.join(appdata, 'presage-pet', 'events');
  return path.join(process.cwd(), 'runtime', 'events');
}
const OUT_DIR = opt('out', defaultOutDir());

// --------------------------------------------------------------------------- //
// 限流日志
// --------------------------------------------------------------------------- //
/**
 * 同一把 key 只在「第一次」和「之后每分钟一次」打印，并带上累计次数。
 *
 * 为什么需要：桥接里最热的两个循环（scan 每 500ms、dsh 轮询）一旦出问题，
 * 就会把同一句话重复几十万遍 —— 用户机器上 bridge.out.log 曾达到 **9MB**，
 * 全是同一行 `[跳过] undefined: …`。刷屏的代价不只是占地方：
 * 真正有用的那几行被淹掉，排查时第一眼看到的是噪音。
 */
const throttledAt = new Map();
function logThrottled(key, message) {
  const now = Date.now();
  const prev = throttledAt.get(key);
  if (!prev) {
    throttledAt.set(key, { at: now, suppressed: 0 });
    console.log(message);
    return;
  }
  if (now - prev.at >= 60_000) {
    const extra = prev.suppressed ? `（过去一分钟同类 ${prev.suppressed} 次）` : '';
    throttledAt.set(key, { at: now, suppressed: 0 });
    console.log(message + extra);
    return;
  }
  prev.suppressed += 1;
}

// --------------------------------------------------------------------------- //
// 尾部读取
// --------------------------------------------------------------------------- //
class Tailer {
  constructor(file) {
    this.file = file;
    this.offset = 0;
    this.pending = '';
    const size = fs.statSync(file).size;
    this.offset = Math.max(0, size - SEED_BYTES);
    this.seedSkipped = this.offset > 0;
  }

  /** 返回本次读到的完整行 */
  read() {
    let st;
    try {
      st = fs.statSync(this.file);
    } catch {
      return [];
    }
    if (st.size < this.offset) this.offset = 0; // 被截断/轮转
    if (st.size === this.offset) return [];
    const len = st.size - this.offset;
    const buf = Buffer.alloc(len);
    const fd = fs.openSync(this.file, 'r');
    try {
      fs.readSync(fd, buf, 0, len, this.offset);
    } finally {
      fs.closeSync(fd);
    }
    this.offset = st.size;
    this.pending += buf.toString('utf8');
    const parts = this.pending.split('\n');
    this.pending = parts.pop() ?? ''; // 末段可能是半行，留到下次
    if (this.seedSkipped) {
      // 起始位置大概率落在半行中间，丢掉第一段
      this.seedSkipped = false;
      parts.shift();
    }
    return parts.filter((l) => l.trim());
  }
}

function findRollouts(dir, limit = 5) {
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
      else if (/^rollout-.*\.jsonl$/.test(e.name)) {
        try {
          out.push({ file: full, mtime: fs.statSync(full).mtimeMs });
        } catch { /* 忽略 */ }
      }
    }
  }
  out.sort((a, b) => b.mtime - a.mtime);
  /**
   * ⚠️ 这里必须返回 {file, mtime}，不能 map 成字符串。
   *
   * 调用方（scan()）是 `for (const { file, mtime } of findRollouts(...))`。
   * 之前这里写成 `.map((x) => x.file)`，于是 file/mtime 全是 undefined：
   *   * `now - undefined` = NaN，`NaN > CODEX_FRESH_MS` 永远 false
   *     → "文件级新鲜度过滤"**完全失效**（历史会话会被当成当前状态）；
   *   * 紧跟着 `new Tailer(undefined)` 抛异常，被 catch 打成
   *     `[跳过] undefined: The "path" argument must be of type string…`，
   *     每 500ms 一轮刷屏 —— 用户机器上那份 bridge.out.log 有 9MB 全是它。
   * v1.1 实测抓到（托盘/设置窗口之外最影响可用性的一个 bug）。
   */
  return out.slice(0, limit);
}

// --------------------------------------------------------------------------- //
// DSH：轮询会话投影快照（零安装路径）
// --------------------------------------------------------------------------- //
const dshSnapshots = new Map(); // sessionId -> summary
let dshHelloSent = false;
let dshLastBeat = 0;

function scanDsh() {
  if (!DSH_ENABLED) return;
  let files;
  try {
    files = fs.readdirSync(DSH_DIR)
      .filter((f) => f.endsWith('.json'))
      .map((f) => path.join(DSH_DIR, f));
  } catch {
    return;
  }
  const now = Date.now();
  for (const file of files) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > DSH_FRESH_MS) continue; // 太久没动过的会话不跟
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      continue; // 写入过程中的半文件，下次再读
    }
    const sessionId = path.basename(file, '.json');
    const snapshot = summarizeProjection(doc, sessionId);
    const prev = dshSnapshots.get(sessionId) ?? null;
    if (!projectionChanged(snapshot, prev)) continue;
    dshSnapshots.set(sessionId, snapshot);

    if (!dshHelloSent) {
      dshHelloSent = true;
      emit({
        v: 1, ts: now, agent: DSH_AGENT, sessionId: null,
        kind: 'agent/hello',
        payload: { source: 'session_projcache', dir: DSH_DIR, sessions: files.length },
        actions: [],
      });
      console.log(`[dsh] 发现 ${files.length} 个会话投影，开始轮询（零安装路径）`);
    }
    const events = deriveFromProjection(snapshot, prev);
    if (!events.length && !prev) {
      // 首次只对齐基线
      console.log(`[dsh] 基线 ${sessionId.slice(0, 18)} turnOpen=${snapshot.turnOpen} `
        + `calls=${snapshot.pendingCalls.length} waiting=${snapshot.active.length}`);
      continue;
    }
    for (const e of events) {
      emit({
        v: 1, ts: now, agent: DSH_AGENT, sessionId,
        kind: e.kind, payload: e.payload, actions: [],
      });
    }
    if (events.length) {
      console.log(`[dsh] ${sessionId.slice(0, 18)} → ${events.map((e) => e.kind).join(', ')}`);
    }
  }

  // 心跳：让桌宠能判断「这条通道是否还活着」
  if (dshHelloSent && now - dshLastBeat > 10000) {
    dshLastBeat = now;
    emit({
      v: 1, ts: now, agent: DSH_AGENT, sessionId: null,
      kind: 'agent/heartbeat', payload: { sessions: dshSnapshots.size }, actions: [],
    });
  }
}

// --------------------------------------------------------------------------- //
// 用量 / 余额：轮询各提供方并推送（密钥只留本机，页面只拿数字）
// --------------------------------------------------------------------------- //
const USAGE_CONFIG = path.join(OUT_DIR, 'usage.json');
/** 余额采样历史：官方 API 不给用量统计，只能靠余额差额推真实消耗 */
const BALANCE_HISTORY = path.join(OUT_DIR, 'balance-history.json');
let usageCfg = loadConfig(USAGE_CONFIG);
const usageState = new Map();   // provider -> 上一次的结果
let usageLastPoll = 0;
const USAGE_POLL_MS = 60_000;

async function pollUsage(force = false) {
  if (!force && Date.now() - usageLastPoll < USAGE_POLL_MS) return;
  usageLastPoll = Date.now();
  let results;
  try {
    results = await queryAll(usageCfg, BALANCE_HISTORY);
  } catch (e) {
    console.log('[usage] 查询失败', e.message);
    return;
  }
  for (const r of results) {
    const prev = usageState.get(r.provider);
    usageState.set(r.provider, r);
    if (!usageChanged(r, prev)) continue;
    emit({
      v: 1, ts: Date.now(), agent: 'usage', sessionId: null,
      kind: 'usage/update', payload: r, actions: [],
    });
    if (r.status === 'ok') {
      console.log(`[usage] ${r.provider} 今日 used=${r.used} 花费=${r.cost ?? '-'} 余额=${r.balance ?? '-'}`);
    } else {
      console.log(`[usage] ${r.provider} ${r.status}: ${r.detail ?? ''}`);
    }
  }
}

// --------------------------------------------------------------------------- //
// 台词库：词库不写死在程序里，落到 runtime/lines.json（界面可改，也能手改）
// --------------------------------------------------------------------------- //
const LINES_FILE = path.join(OUT_DIR, 'lines.json');
let customLines = {};
try {
  customLines = JSON.parse(fs.readFileSync(LINES_FILE, 'utf8'));
  if (typeof customLines !== 'object' || customLines === null) customLines = {};
} catch { customLines = {}; }

function saveLines() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(LINES_FILE, JSON.stringify(customLines, null, 2), 'utf8');
}

/** 生效词库 = 默认词库被自定义覆盖（某类非空即以自定义为准） */
function effectiveLines() {
  const out = {};
  for (const [key, cat] of Object.entries(CATEGORIES)) {
    const cu = customLines[key];
    const custom = Array.isArray(cu) && cu.length > 0;
    out[key] = { label: cat.label, weight: cat.weight ?? 1, custom, lines: custom ? cu.slice() : cat.lines.slice() };
  }
  return out;
}

// --------------------------------------------------------------------------- //
// 状态
// --------------------------------------------------------------------------- //
const tailers = new Map(); // file -> { tailer, ctx }
let seq = 0;
/** 已经判定为"太旧"的会话，只提示一次 */
const staleFiles = new Set();
let staleDropped = 0;
let produced = 0;
let ignored = 0;
let parseErrors = 0;
const recent = [];
const clients = new Set();

fs.mkdirSync(OUT_DIR, { recursive: true });
// 每个 agent 一个事件文件（协议规定 <agent>.jsonl）
const streams = new Map();
function streamFor(agent) {
  let s = streams.get(agent);
  if (!s) {
    s = fs.createWriteStream(path.join(OUT_DIR, `${agent}.jsonl`), { flags: 'a' });
    streams.set(agent, s);
  }
  return s;
}
const outFile = path.join(OUT_DIR, `${AGENT}.jsonl`);

function parseRolloutSession(file) {
  const m = /rollout-(.+)\.jsonl$/.exec(path.basename(file));
  return m ? m[1] : null;
}

function emit(evt) {
  // seq 由桥接层分配，保证跨会话全局单调
  evt.seq = ++seq;
  const line = JSON.stringify(evt);
  streamFor(evt.agent).write(`${line}\n`);
  recent.push(evt);
  if (recent.length > 500) recent.shift();
  for (const res of clients) res.write(`data: ${line}\n\n`);
  produced++;
}

function scan() {
  const now = Date.now();
  for (const { file, mtime } of findRollouts(WATCH_DIR)) {
    // 文件级新鲜度过滤：几天没动过的会话是历史，不是"当前状态"
    if (now - mtime > CODEX_FRESH_MS) {
      if (!staleFiles.has(file)) {
        staleFiles.add(file);
        console.log(`[跳过旧会话] ${path.basename(file)}（${Math.round((now - mtime) / 3600_000)} 小时前）`);
      }
      continue;
    }
    if (!tailers.has(file)) {
      try {
        tailers.set(file, {
          tailer: new Tailer(file),
          ctx: newCodexContext(),
          sessionId: parseRolloutSession(file),
        });
        console.log(`[watch] ${path.basename(file)}`);
      } catch (e) {
        // 限流：这个 scan 每 500ms 跑一轮，监视目录一有问题就会每轮刷一条。
        // 曾经因此写出 9MB 的日志（同一句话重复几十万遍），既掩盖真问题又占磁盘。
        logThrottled(`skip:${file}`, `[跳过] ${path.basename(String(file))}: ${e.message}`);
      }
    }
  }
  for (const [file, entry] of tailers) {
    for (const line of entry.tailer.read()) {
      let raw;
      try {
        raw = JSON.parse(line);
      } catch {
        parseErrors++;
        continue;
      }
      let out;
      try {
        out = normalizeCodex(raw, entry.ctx, entry.sessionId);
      } catch (e) {
        console.log(`[adapter 异常] ${e.message}`);
        continue;
      }
      const events = out == null ? [] : Array.isArray(out) ? out : [out];
      if (!events.length) {
        ignored++;
        continue;
      }
      for (const evt of events) {
        // 事件级新鲜度过滤：Codex 的 rollout 是**历史文件**，
        // 桥接启动时会把它们从头读一遍。不过滤的话，几天前的报错/完成会被当成实时事件，
        // 而旧报错的优先级(80)高于"工作中"(65)，会把当前 DSH 的工作状态整个压住
        // ——用户看到的就是"一直在播 codex 的旧内容、也不切工作动画"（实测就是这个症状）。
        if (now - evt.ts > CODEX_FRESH_MS) {
          staleDropped++;
          continue;
        }
        if (raw.ordinal != null) evt.payload.srcOrdinal = raw.ordinal;
        emit(evt);
      }
    }
  }
}

// --------------------------------------------------------------------------- //
// HTTP（SSE + 回环，全部只绑 127.0.0.1）
// --------------------------------------------------------------------------- //
const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Cache-Control': 'no-store',
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);

  // 页面是 tauri:// 源，POST json 属于非简单请求，会先发预检，这里统一应答
  if (req.method === 'OPTIONS') {
    res.writeHead(204, CORS);
    res.end();
    return;
  }

  // 台词库：读 / 改（增、删、恢复默认）
  if (url.pathname === '/lines' && req.method === 'GET') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ file: LINES_FILE, categories: effectiveLines() }, null, 2));
    return;
  }
  if (url.pathname === '/lines' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 65536) req.destroy();
    });
    req.on('end', () => {
      try {
        const { category, action, text } = JSON.parse(body || '{}');
        if (!CATEGORIES[category]) throw new Error(`未知类别 ${category}`);
        if (action === 'add') {
          const t = String(text || '').trim();
          if (!t) throw new Error('台词不能为空');
          const cur = Array.isArray(customLines[category]) && customLines[category].length
            ? customLines[category].slice() : CATEGORIES[category].lines.slice();
          if (!cur.includes(t)) cur.push(t);
          customLines[category] = cur;
        } else if (action === 'remove') {
          const cur = Array.isArray(customLines[category]) && customLines[category].length
            ? customLines[category].slice() : CATEGORIES[category].lines.slice();
          customLines[category] = cur.filter((x) => x !== text);
        } else if (action === 'reset') {
          delete customLines[category];
        } else {
          throw new Error(`未知操作 ${action}`);
        }
        saveLines();
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, categories: effectiveLines() }));
        console.log(`[lines] ${action} ${category}（自定义类别数 ${Object.keys(customLines).length}）`);
      } catch (e) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  // 用量 / 余额：设置页读它，也写回配置
  if (url.pathname === '/usage' && req.method === 'GET') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      config: publicConfig(usageCfg),
      providers: [...usageState.values()],
    }, null, 2));
    return;
  }
  if (url.pathname === '/usage/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 8192) req.destroy();
    });
    req.on('end', async () => {
      try {
        const patch = JSON.parse(body || '{}');
        // 白名单更新：只认识这几个字段，避免页面误写坏配置
        if (patch.ccswitch) {
          const c = patch.ccswitch;
          if (typeof c.enabled === 'boolean') usageCfg.ccswitch.enabled = c.enabled;
          if (typeof c.db === 'string' && c.db) usageCfg.ccswitch.db = c.db;
        }
        if (patch.dsh) {
          const d = patch.dsh;
          if (typeof d.enabled === 'boolean') usageCfg.dsh.enabled = d.enabled;
          if (typeof d.projectionDir === 'string' && d.projectionDir) {
            usageCfg.dsh.projectionDir = d.projectionDir;
          }
          // 校准系数已成历史包袱：金额默认不估算，改用官方余额 + 余额差额
          if (typeof d.estimateCost === 'boolean') usageCfg.dsh.estimateCost = d.estimateCost;
          if (d.displayCurrency === 'CNY' || d.displayCurrency === 'USD') {
            usageCfg.dsh.displayCurrency = d.displayCurrency;
          }
          const rate = Number(d.usdToCny);
          if (Number.isFinite(rate) && rate > 0 && rate <= 100) usageCfg.dsh.usdToCny = rate;
        }
        if (patch.deepseek) {
          const d = patch.deepseek;
          if (typeof d.enabled === 'boolean') usageCfg.deepseek.enabled = d.enabled;
          if ('apiKey' in d && typeof d.apiKey === 'string') usageCfg.deepseek.apiKey = d.apiKey.trim();
          if (typeof d.baseUrl === 'string' && d.baseUrl) usageCfg.deepseek.baseUrl = d.baseUrl;
        }
        saveConfig(USAGE_CONFIG, usageCfg);
        await pollUsage(true);
        res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          ok: true,
          config: publicConfig(usageCfg),
          providers: [...usageState.values()],
        }));
      } catch (e) {
        res.writeHead(400, { ...CORS, 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: e.message }));
      }
    });
    return;
  }

  if (url.pathname === '/health') {
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      ok: true,
      agent: AGENT,
      watchDir: WATCH_DIR,
      outFile,
      outDir: OUT_DIR,
      watched: [...tailers.keys()].map((f) => path.basename(f)),
      dsh: DSH_ENABLED
        ? { dir: DSH_DIR, sessions: dshSnapshots.size }
        : { enabled: false },
      produced, ignored, parseErrors, seq,
      staleDropped,
      clients: clients.size,
    }, null, 2));
    return;
  }

  if (url.pathname === '/recent') {
    const n = Math.min(500, Number(url.searchParams.get('n') || BACKFILL_LINES));
    res.writeHead(200, { ...CORS, 'Content-Type': 'application/json' });
    res.end(JSON.stringify(recent.slice(-n)));
    return;
  }

  if (url.pathname === '/events') {
    res.writeHead(200, {
      ...CORS,
      'Content-Type': 'text/event-stream',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }

  res.writeHead(404, CORS);
  res.end('not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log('普瑞塞斯桥接已启动');
  console.log(`  Codex 监视: ${WATCH_DIR}`);
  if (DSH_ENABLED) console.log(`  DSH 投影轮询: ${DSH_DIR}（零安装路径）`);
  console.log(`  事件目录: ${OUT_DIR}`);
  console.log(`  SSE: http://127.0.0.1:${PORT}/events`);
  console.log(`  健康: http://127.0.0.1:${PORT}/health`);
  console.log(`  用量: http://127.0.0.1:${PORT}/usage`);
  scan();
  scanDsh();
  pollUsage(true);
});

setInterval(() => {
  scan();
  scanDsh();
  pollUsage();
}, POLL_MS);
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n');
}, 15000);

process.on('SIGINT', () => {
  console.log(`\n退出。产生事件 ${produced}，忽略 ${ignored}，坏行 ${parseErrors}`);
  process.exit(0);
});
