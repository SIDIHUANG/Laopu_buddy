/**
 * 把用量数据压成一句人话（气泡正文用）。
 * 抽成纯函数是为了能单测——数字格式这种东西最容易在边界上出错。
 */

export const fmtTokens = (n) => {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
};

export const fmtMoney = (v, currency = 'USD') => {
  if (!Number.isFinite(v)) return '—';
  const symbol = currency === 'CNY' ? '¥' : '$';
  return `${symbol}${v.toFixed(v > 0 && v < 1 ? 4 : 2)}`;
};

/**
 * 组成规则：
 *   1. 有官方余额就报余额（那是用户最关心的"还能用多久"）
 *   2. 有钱的花费就都报出来：DSH 本次会话 + CC Switch 今日，两者不冲突
 *   3. 一个钱都算不出来时，退回 token 数
 * 什么都拿不到就返回空串——调用方据此安静跳过，不要弹一个"暂无数据"的气泡。
 */
export function formatUsageFact(byProvider = {}) {
  const ds = byProvider.deepseek;
  if (ds && ds.status === 'ok' && Number.isFinite(ds.balance)) {
    // 消耗用余额差额推——这是真实出账（已含谷价折扣），比按标价估算可靠
    const spent = Number.isFinite(ds.spent24h) && ds.spent24h > 0
      ? ` · 近 24h 消耗 ${fmtMoney(ds.spent24h, ds.currency)}` : '';
    return `余额 ${fmtMoney(ds.balance, ds.currency)}${spent}`;
  }

  const bits = [];
  const dsh = byProvider.dsh;
  if (dsh && dsh.status === 'ok' && Number.isFinite(dsh.cost)) {
    // 估算值要带 ≈：它来自定价表，不一定等于后台账单
    bits.push(`本次会话 ${dsh.estimated ? '≈' : ''}${fmtMoney(dsh.cost, dsh.currency)}`);
  }
  const cs = byProvider.ccswitch;
  if (cs && cs.status === 'ok' && Number.isFinite(cs.cost) && cs.cost > 0) {
    const req = Number.isFinite(cs.requests) && cs.requests > 0 ? ` · ${cs.requests} 次` : '';
    bits.push(`今日 ${fmtMoney(cs.cost, cs.currency)}${req}`);
  }
  if (bits.length) {
    const week = cs && cs.status === 'ok' && cs.week && cs.week.cost > 0
      ? ` · 近 7 天 ${fmtMoney(cs.week.cost, cs.currency)}` : '';
    const model = dsh && dsh.status === 'ok' && dsh.model ? `（${dsh.model}）` : '';
    return bits.join(' · ') + model + week;
  }

  // 没有花费数据：报 token
  const parts = [];
  for (const key of ['codex', 'dsh']) {
    const p = byProvider[key];
    if (p && Number.isFinite(p.used) && p.used > 0) parts.push(`${key} ${fmtTokens(p.used)}`);
  }
  if (parts.length) return `本次会话 ${parts.join(' · ')}`;
  if (cs && cs.status === 'ok') {
    const week = cs.week && Number.isFinite(cs.week.cost) ? ` · 近 7 天 ${fmtMoney(cs.week.cost, cs.currency)}` : '';
    return `今日 ${fmtMoney(cs.cost, cs.currency)}${week}`;
  }
  return '';
}
