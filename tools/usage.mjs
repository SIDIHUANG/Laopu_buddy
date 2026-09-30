/**
 * 用量 / 余额数据层。
 *
 * 设计取舍：**放在桥接进程（Node）里，不放在桌宠页面里**。
 *   - 页面是 WebView，跨域请求会被 CORS 挡（DeepSeek 的接口不返回 CORS 头）；
 *   - 桥接进程本来就在本机跑、本来就在往桌宠推事件，让它顺带做网络查询最省事；
 *   - 顺带的好处是**密钥不出本机**：只存在 runtime/usage.json，页面只拿到余额数字。
 *
 * 三个提供方：
 *   ccswitch  —— 只读 CC Switch 的 sqlite 账本，**零配置就有真实用量与花费**
 *   deepseek  —— 官方余额接口，需要用户填 api-key（可选）
 *   local     —— Codex / DSH 的本地用量，来自各自 adapter（已在事件流里）
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_CONFIG = {
  ccswitch: { enabled: true, db: '~/.cc-switch/cc-switch.db', refreshMs: 60_000 },
  // DSH 本地用量：token 数从会话投影读，**精确**。
  // 金额默认不估算 —— CC Switch 的定价表是标价，而用户多在半价时段使用，
  // 套系数会把估算伪装成真实。真要金额就用官方余额 + 余额差额（见 queryDeepSeek）。
  dsh: {
    enabled: true,
    projectionDir: '~/.dsh/storages/session_projcache/sessions',
    /** 打开后会按标价估算金额，并标注"未考虑谷价折扣" */
    estimateCost: false,
    displayCurrency: 'CNY',
    usdToCny: 7.15,
  },
  deepseek: {
    enabled: false,
    apiKey: '',
    baseUrl: 'https://api.deepseek.com',
    refreshMs: 5 * 60_000,
  },
};

export function expandHome(p) {
  if (!p) return p;
  return p.startsWith('~') ? path.join(os.homedir(), p.slice(1)) : p;
}

export function loadConfig(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return {
      ccswitch: { ...DEFAULT_CONFIG.ccswitch, ...(raw.ccswitch || {}) },
      dsh: { ...DEFAULT_CONFIG.dsh, ...(raw.dsh || {}) },
      deepseek: { ...DEFAULT_CONFIG.deepseek, ...(raw.deepseek || {}) },
    };
  } catch {
    return structuredClone(DEFAULT_CONFIG);
  }
}

export function saveConfig(file, cfg) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2), 'utf8');
}

/** 给页面看的配置：**密钥只回传"是否已设置"，不回传内容** */
export function publicConfig(cfg) {
  return {
    ccswitch: { enabled: cfg.ccswitch.enabled, db: cfg.ccswitch.db },
    dsh: {
      enabled: cfg.dsh?.enabled !== false,
      projectionDir: cfg.dsh?.projectionDir,
      estimateCost: cfg.dsh?.estimateCost === true,
      displayCurrency: cfg.dsh?.displayCurrency === 'CNY' ? 'CNY' : 'USD',
      usdToCny: Number(cfg.dsh?.usdToCny) > 0 ? Number(cfg.dsh.usdToCny) : 7.15,
    },
    deepseek: {
      enabled: cfg.deepseek.enabled,
      baseUrl: cfg.deepseek.baseUrl,
      hasApiKey: Boolean(cfg.deepseek.apiKey),
      keyHint: cfg.deepseek.apiKey ? `${cfg.deepseek.apiKey.slice(0, 6)}…` : '',
    },
  };
}

const dayStartSec = (d = new Date()) =>
  Math.floor(new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() / 1000);
const daysAgoSec = (n) => dayStartSec() - n * 86400;

/**
 * 读 CC Switch 账本。只读打开，绝不写入别人的库。
 * 用 node:sqlite（Node 22+ 内置），省掉一个依赖。
 */
export async function queryCcSwitch(cfg) {
  const dbPath = expandHome(cfg.db);
  if (!fs.existsSync(dbPath)) {
    return {
      provider: 'ccswitch', label: 'CC Switch 账本', status: 'unavailable',
      detail: `找不到 ${dbPath}`, updatedAt: Date.now(),
    };
  }
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(dbPath, { readOnly: true });

    const today = db.prepare(`
      select count(*) n,
             coalesce(sum(input_tokens),0) inp,
             coalesce(sum(output_tokens),0) outp,
             coalesce(sum(cache_read_tokens),0) cr,
             coalesce(sum(total_cost_usd),0) cost
      from proxy_request_logs where created_at >= ?`).get(dayStartSec());

    const week = db.prepare(`
      select count(*) n,
             coalesce(sum(input_tokens),0) inp,
             coalesce(sum(output_tokens),0) outp,
             coalesce(sum(cache_read_tokens),0) cr,
             coalesce(sum(total_cost_usd),0) cost
      from proxy_request_logs where created_at >= ?`).get(daysAgoSec(7));

    const byApp = db.prepare(`
      select app_type, count(*) n, coalesce(sum(total_cost_usd),0) cost
      from proxy_request_logs where created_at >= ?
      group by app_type order by cost desc`).all(daysAgoSec(7));

    const monthly = db.prepare(`
      select coalesce(sum(total_cost_usd),0) cost from proxy_request_logs
      where created_at >= ?`).get(daysAgoSec(30));

    return {
      provider: 'ccswitch',
      label: 'CC Switch 账本',
      status: 'ok',
      unit: 'usd',
      currency: 'USD',
      // "用量"这里用 token 数表达，花费另给一个字段
      used: (today.inp || 0) + (today.outp || 0) + (today.cr || 0),
      input: today.inp || 0,
      output: today.outp || 0,
      cached: today.cr || 0,
      cost: Number(today.cost) || 0,
      requests: today.n || 0,
      week: {
        used: (week.inp || 0) + (week.outp || 0) + (week.cr || 0),
        cost: Number(week.cost) || 0,
        requests: week.n || 0,
      },
      monthCost: Number(monthly.cost) || 0,
      byApp: byApp.map((r) => ({
        app: r.app_type, cost: Number(r.cost) || 0, requests: r.n,
      })),
      updatedAt: Date.now(),
    };
  } catch (e) {
    return {
      provider: 'ccswitch', label: 'CC Switch 账本', status: 'error',
      detail: e.message, updatedAt: Date.now(),
    };
  } finally {
    try { db?.close(); } catch { /* 忽略 */ }
  }
}

/**
 * 余额历史 → 真实消耗。
 *
 * 官方 API 只给余额、不给用量统计，所以"花了多少"只能靠**余额差额**推：
 * 两个时间点的余额相减，就是这段时间的真实出账（自然包含了谷价折扣）。
 * 这里只做纯计算，落盘在 recordBalance 里。
 */
export function spendSince(samples = [], windowMs, now = Date.now()) {
  const inWindow = samples
    .filter((s) => Number.isFinite(s?.balance) && now - s.ts <= windowMs)
    .sort((a, b) => a.ts - b.ts);
  if (inWindow.length < 2) return null;
  const first = inWindow[0];
  const last = inWindow[inWindow.length - 1];
  const spent = first.balance - last.balance;
  // 充值会让余额变大：这时不能用差额表示消耗
  if (spent <= 0) return { spent: 0, currency: last.currency, from: first.ts, to: last.ts, replenished: spent < 0 };
  return { spent, currency: last.currency, from: first.ts, to: last.ts, replenished: false };
}

export function loadBalanceHistory(file) {
  try {
    const a = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(a) ? a : [];
  } catch {
    return [];
  }
}

/** 追加一条余额采样；同一余额不重复记，且限制采样密度 */
export function recordBalance(file, sample, minGapMs = 10 * 60_000) {
  try {
    const list = loadBalanceHistory(file);
    const last = list[list.length - 1];
    if (last && last.balance === sample.balance && sample.ts - last.ts < minGapMs) return list;
    list.push(sample);
    const trimmed = list.slice(-1000);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(trimmed, null, 2), 'utf8');
    return trimmed;
  } catch {
    return [];
  }
}

/** DeepSeek 官方余额。没有 key 时返回明确的 no-key，而不是报错 */
export async function queryDeepSeek(cfg, historyFile = null) {
  const base = {
    provider: 'deepseek', label: 'DeepSeek 余额', unit: 'currency',
    currency: 'CNY', updatedAt: Date.now(),
  };
  if (!cfg.apiKey) {
    return { ...base, status: 'no-key', detail: '未填 api-key（可选，填了才查余额）' };
  }
  const url = `${(cfg.baseUrl || 'https://api.deepseek.com').replace(/\/$/, '')}/user/balance`;
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 12_000);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${cfg.apiKey}`, Accept: 'application/json' },
      signal: ctl.signal,
    });
    clearTimeout(timer);
    if (!res.ok) {
      return { ...base, status: 'error', detail: `HTTP ${res.status} ${res.statusText}` };
    }
    const body = await res.json();
    const info = Array.isArray(body.balance_infos) ? body.balance_infos[0] : body.balance_infos;
    if (!info) {
      return { ...base, status: 'error', detail: '返回里没有 balance_infos' };
    }
    const balance = Number(info.total_balance);
    const currency = info.currency || 'CNY';
    // 记一笔余额采样：官方不给用量统计，"花了多少"只能靠余额差额算
    let history = [];
    if (historyFile) {
      history = recordBalance(historyFile, { ts: Date.now(), balance, currency });
    }
    const day = history.length ? spendSince(history, 24 * 3600_000) : null;
    const week = history.length ? spendSince(history, 7 * 24 * 3600_000) : null;
    return {
      ...base,
      status: 'ok',
      currency,
      balance,
      granted: Number(info.granted_balance ?? 0),
      toppedUp: Number(info.topped_up_balance ?? 0),
      available: body.is_available !== false,
      /** 由余额差额推出的真实消耗（含谷价折扣，比标价估算准） */
      spent24h: day ? day.spent : null,
      spent7d: week ? week.spent : null,
      replenished: Boolean(day?.replenished),
      samples: history.length,
    };
  } catch (e) {
    return { ...base, status: 'error', detail: e.name === 'AbortError' ? '请求超时' : e.message };
  }
}

/** 汇总所有提供方；单个失败不影响其它 */
export async function queryAll(cfg, historyFile = null) {
  const jobs = [];
  if (cfg.ccswitch.enabled) jobs.push(queryCcSwitch(cfg.ccswitch));
  if (cfg.dsh?.enabled !== false) jobs.push(queryDshLocal(cfg));
  if (cfg.deepseek.enabled || cfg.deepseek.apiKey) jobs.push(queryDeepSeek(cfg.deepseek, historyFile));
  const settled = await Promise.allSettled(jobs);
  return settled.map((s) => (s.status === 'fulfilled' ? s.value : {
    provider: 'unknown', status: 'error', detail: String(s.reason), updatedAt: Date.now(),
  }));
}

/**
 * 按定价表把 token 折算成钱。纯函数，方便单测。
 * price 单位是「每百万 token 的美元」。
 */
export function computeCost(tokens, price) {
  if (!tokens || !price) return null;
  const perM = (n, p) => (Number(n) || 0) * (Number(p) || 0) / 1e6;
  return perM(tokens.input, price.input)
    + perM(tokens.output, price.output)
    + perM(tokens.cached, price.cached);
}

/** 从 CC Switch 的定价表里查一个模型（大小写不敏感，支持前缀匹配） */
export async function lookupPrice(dbPath, model) {
  if (!model) return null;
  let db;
  try {
    const { DatabaseSync } = await import('node:sqlite');
    db = new DatabaseSync(expandHome(dbPath), { readOnly: true });
    const q = db.prepare(`select model_id, display_name, input_cost_per_million,
      output_cost_per_million, cache_read_cost_per_million
      from model_pricing where lower(model_id) = lower(?) limit 1`);
    let row = q.get(model);
    if (!row) {
      // 退化到前缀匹配（deepseek-flash → deepseek-v4-flash-0731 之类）
      row = db.prepare(`select model_id, display_name, input_cost_per_million,
        output_cost_per_million, cache_read_cost_per_million
        from model_pricing where lower(model_id) like lower(?) || '%' limit 1`).get(model);
    }
    if (!row) return null;
    return {
      modelId: row.model_id,
      display: row.display_name,
      input: Number(row.input_cost_per_million),
      output: Number(row.output_cost_per_million),
      cached: Number(row.cache_read_cost_per_million),
    };
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 忽略 */ }
  }
}

/**
 * DSH 的本地用量 + 按定价折算的花费。
 * 这条路**不需要任何 key**：模型名来自会话投影的 modelSelection，
 * 单价来自 CC Switch 的 model_pricing 表，两者都在本机。
 */
export async function queryDshLocal(cfg) {
  const base = {
    provider: 'dsh', label: 'DSH 会话', unit: 'usd', currency: 'USD',
    updatedAt: Date.now(),
  };
  const dir = expandHome(cfg.dsh?.projectionDir
    || '~/.dsh/storages/session_projcache/sessions');
  let newest = null;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      const full = path.join(dir, f);
      const st = fs.statSync(full);
      if (!newest || st.mtimeMs > newest.mtimeMs) newest = { full, mtimeMs: st.mtimeMs };
    }
  } catch {
    return { ...base, status: 'unavailable', detail: `读不到 ${dir}` };
  }
  if (!newest) return { ...base, status: 'unavailable', detail: '没有会话投影' };

  try {
    const doc = JSON.parse(fs.readFileSync(newest.full, 'utf8'));
    const rows = doc?.record?.rows ?? {};
    const totals = rows.tokenUsage?.val?.totals;
    const model = rows.modelSelection?.val?.lastUsed?.model ?? null;
    if (!totals) return { ...base, status: 'unavailable', detail: '投影里没有 tokenUsage' };
    const tokens = {
      input: totals.uncachedInputTokens ?? 0,
      output: totals.outputTokens ?? 0,
      cached: totals.cacheReadTokens ?? 0,
    };
    const price = await lookupPrice(cfg.ccswitch.db, model);
    const raw = computeCost(tokens, price);
    // 金额**默认不估算**：CC Switch 那张表是标价，而用户常在半价时段使用，
    // 套一个校准系数会把估算伪装成真实、而且峰谷比例一变就失准。
    // 想要准确金额就用官方余额 + 余额差额（见 queryDeepSeek）。
    const wantEstimate = cfg.dsh?.estimateCost === true;
    const cur = cfg.dsh?.displayCurrency === 'CNY' ? 'CNY' : 'USD';
    const rate = Number(cfg.dsh?.usdToCny) > 0 ? Number(cfg.dsh.usdToCny) : 7.15;
    const conv = cur === 'CNY' ? rate : 1;
    const cost = wantEstimate && raw !== null ? raw * conv : null;
    return {
      ...base,
      status: 'ok',
      model,
      currency: cur,
      // "今日"这个概念对会话用量不适用，这里就是整个会话的累计
      used: tokens.input + tokens.output + tokens.cached,
      input: tokens.input,
      output: tokens.output,
      cached: tokens.cached,
      cost,
      costRaw: raw === null ? null : raw * conv,
      estimated: cost !== null,
      /** 金额的根据必须照实说明，别让用户以为是账单 */
      estimateNote: wantEstimate
        ? `按 ${price ? price.display : '定价表'} 标价估算，未考虑谷价折扣`
        : '未估算金额（要准确金额请用官方余额）',
      requests: rows.sessionStats?.val?.steps ?? 0,
      pricing: price ? price.display : null,
    };
  } catch (e) {
    return { ...base, status: 'error', detail: e.message };
  }
}

/** 只有数字真的变了才推送，避免 60 秒一次的无意义事件 */
export function usageChanged(a, b) {
  if (!b) return true;
  const keys = ['status', 'used', 'cost', 'balance', 'requests', 'updatedAt'];
  return keys.some((k) => {
    if (k === 'updatedAt') return false;
    const av = a?.[k]; const bv = b?.[k];
    if (typeof av === 'number' && typeof bv === 'number') return Math.abs(av - bv) > 1e-9;
    return av !== bv;
  });
}
