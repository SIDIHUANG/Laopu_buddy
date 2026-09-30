/**
 * 设置页：用量 / 余额面板。
 *
 * 数据来自桥接进程（`GET /usage`），保存走 `POST /usage/config`。
 * **api-key 不落在页面里**：页面只提交、只拿回 "是否已设置" 与掩码提示，
 * 真正的密钥写在 runtime/usage.json（本机文件）。
 */

const fmtTokens = (n) => {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
};

const fmtMoney = (v, currency = 'USD') => {
  if (!Number.isFinite(v)) return '—';
  const symbol = currency === 'CNY' ? '¥' : '$';
  return `${symbol}${v.toFixed(v < 1 ? 4 : 2)}`;
};

const STATUS_TEXT = {
  ok: '正常', 'no-key': '未配置', unavailable: '不可用', error: '出错',
};

/** 用户输入的台词要进 HTML，必须转义（否则一句 `</div>` 就能把面板拆了） */
const esc = (s) => String(s).replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export class SettingsPanel {
  constructor({
    bridge = 'http://127.0.0.1:8792', onLog, onResize, lines, onProviderChanged,
    usageBroadcast, appearance, maxSize = 480,
  } = {}) {
    this.bridge = bridge.replace(/\/$/, '');
    this.onLog = onLog || (() => {});
    this.onResize = onResize || null;
    // 角色尺寸上限由屏幕可用高度决定（窗口必须装得下她 + 气泡），
    // 滑块直接用这个上限，避免用户拉到一个放不下的值还以为是自己调坏了。
    this.maxSize = Math.max(100, Math.round(maxSize));
    this.lines = lines || null;
    this.onProviderChanged = onProviderChanged || null;
    this.usageBroadcast = usageBroadcast || null; // { get(), set(on) }
    this.appearance = appearance || null;         // { get(), set(patch) }    this.dialog = document.getElementById('settings');
    this.body = document.getElementById('settings-body');
    this.status = document.getElementById('settings-status');
    this.data = null;
  }

  /**
   * 惰性查找对话框元素。
   *
   * 构造函数里查是错的：`<dialog>` 标记在 `<script type="module">` **之后**，
   * 模块执行时它还没被解析，`getElementById` 返回 null ——
   * 表现就是"右键有菜单、点设置毫无反应"，而且不报错（用户实测抓到的）。
   * 每次用之前查一次，就跟标签顺序无关了。
   */
  ensureEls() {
    if (!this.dialog) this.dialog = document.getElementById('settings');
    if (!this.body) this.body = document.getElementById('settings-body');
    if (!this.status) this.status = document.getElementById('settings-status');
    return Boolean(this.dialog);
  }

  bind() {
    this.ensureEls();
    if (!this.dialog) return;
    document.getElementById('settings-close')?.addEventListener('click', () => this.close());
    document.getElementById('settings-refresh')?.addEventListener('click', () => this.refresh());
    // 表单是动态渲染的，用事件委托
    this.body?.addEventListener('submit', (e) => {
      e.preventDefault();
      this.saveFromForm();
    });
    this.body?.addEventListener('click', (e) => {
      const t = e.target;
      if (t?.dataset?.action === 'clear-key') {
        this.save({ deepseek: { apiKey: '' } });
        return;
      }
      const op = t?.dataset?.lines;
      if (!op) return;
      const cat = t.dataset.cat;
      if (op === 'remove') {
        this.linesAction(cat, 'remove', t.dataset.text);
      } else if (op === 'reset') {
        this.linesAction(cat, 'reset');
      } else if (op === 'add') {
        const input = this.body.querySelector(`input[data-add="${cat}"]`);
        const text = input?.value?.trim();
        if (text) { this.linesAction(cat, 'add', text); input.value = ''; }
      }
    });
    // 输入框里按回车＝添加
    this.body?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !e.target?.dataset?.add) return;
      e.preventDefault();
      const cat = e.target.dataset.add;
      const text = e.target.value.trim();
      if (text) { this.linesAction(cat, 'add', text); e.target.value = ''; }
    });
    // 外观控件：拖动即时生效，带防抖（拖滑块会触发上百次 input）
    const pushAppearance = (() => {
      let timer = null;
      return (patch) => {
        clearTimeout(timer);
        timer = setTimeout(() => this.appearance?.set?.(patch), 150);
      };
    })();
    this.body?.addEventListener('input', (e) => {
      const name = e.target?.name;
      if (!name || !this.appearance) return;
      const form = this.body.querySelector('#appearance-form');
      if (!form) return;
      if (name === 'size' || name === 'opacity') {
        const v = Number(e.target.value);
        e.target.parentElement.querySelector('.val').textContent =
          name === 'size' ? `${v}px` : `${Math.round(v * 100)}%`;
        pushAppearance({ size: Number(form.elements.size.value),
          opacity: Number(form.elements.opacity.value) });
      }
    });
    this.body?.addEventListener('change', (e) => {
      const name = e.target?.name;
      if (!this.appearance) return;
      if (name === 'alwaysOnTop') pushAppearance({ alwaysOnTop: e.target.checked });
      else if (name === 'clickThrough') {
        pushAppearance({ clickThrough: e.target.checked });
        this.setStatus(e.target.checked ? '已开启点击穿透' : '已关闭点击穿透（整窗可交互）');
      }
    });
    // 台词库 / 用量播报是即时生效的本地偏好，不必等"保存"
    this.body?.addEventListener('change', (e) => {
      if (e.target?.name === 'linesEnabled' && this.lines) {
        this.lines.setEnabled(e.target.checked);
        this.setStatus(e.target.checked ? '台词库已开启' : '台词库已关闭');
      } else if (e.target?.name === 'usageBroadcast' && this.usageBroadcast) {
        this.usageBroadcast.set(e.target.checked);
        this.setStatus(e.target.checked ? '用量播报已开启' : '用量播报已关闭');
      }
    });
  }

  async open() {
    // 逐步留痕：这类"点了没反应又不报错"的问题，没有日志就只能猜
    const found = this.ensureEls();
    this.onLog(`open 被调用 dialog=${found} open=${this.dialog?.open}`);
    if (!found) return;
    try {
      // 用非模态 show() 而不是 showModal()：
      //   - showModal 会加一层压暗背景的 backdrop，把桌宠也一起压暗，
      //     用户就没法一边调"大小/透明度"一边看她变化了（实测反馈）
      //   - 非模态下 `dialog.open` 仍为 true，命中遮罩的判定不受影响
      this.dialog.show();
      this.onLog(`对话框已打开 open=${this.dialog.open}`);
    } catch (e) {
      this.onLog(`打开对话框失败：${e && (e.name || '')} ${e && (e.message || e)}`);
      return;
    }
    // 尺寸调整不阻塞、失败也无所谓：对话框是用户看得见的东西，优先
    Promise.resolve(this.onResize?.(580, 660)).catch(() => {});
    await this.refresh();
    setTimeout(() => { Promise.resolve(this.onResize?.(580, 660)).catch(() => {}); }, 80);
  }

  close() {
    this.dialog?.close();
    this.onResize?.(null);
  }

  setStatus(text, bad = false) {
    if (!this.status) return;
    this.status.textContent = text;
    this.status.classList.toggle('bad', bad);
  }

  async refresh() {
    this.setStatus('读取中…');
    try {
      const [usageRes, linesRes] = await Promise.all([
        fetch(`${this.bridge}/usage`),
        fetch(`${this.bridge}/lines`).catch(() => null),
      ]);
      if (!usageRes.ok) throw new Error(`HTTP ${usageRes.status}`);
      this.data = await usageRes.json();
      this.linesData = linesRes && linesRes.ok ? (await linesRes.json()).categories : null;
      this.render();
      const bad = (this.data.providers || []).filter((p) => p.status === 'error').length;
      this.setStatus(bad ? `${bad} 个提供方出错` : '已更新', Boolean(bad));
      this.onLog(`设置页已刷新：${(this.data.providers || []).length} 个提供方`);
    } catch (e) {
      this.setStatus(`连不上桥接进程（${e.message}）—— 请先运行 node tools/pet_bridge.mjs`, true);
      this.body.innerHTML = '';
    }
  }

  /** 台词库增删改：写回桥接的 runtime/lines.json，并立刻在本地生效 */
  async linesAction(category, action, text) {
    try {
      const res = await fetch(`${this.bridge}/lines`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ category, action, text }),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '更新失败');
      this.linesData = json.categories;
      const custom = {};
      for (const [k, v] of Object.entries(this.linesData)) if (v.custom) custom[k] = v.lines;
      this.lines?.applyCustom(custom);
      this.render();
      this.setStatus('台词库已更新');
      this.onLog(`台词库 ${action} ${category}`);
    } catch (e) {
      this.setStatus(`台词库更新失败：${e.message}`, true);
    }
  }

  async save(patch) {
    this.setStatus('保存中…');
    try {
      const res = await fetch(`${this.bridge}/usage/config`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch),
      });
      const json = await res.json();
      if (!json.ok) throw new Error(json.error || '保存失败');
      this.data = json;
      this.render();
      this.setStatus('已保存');
      this.onLog('设置页已保存用量配置');
      this.onProviderChanged?.(); // 让桌宠说一句台词（第八类）
    } catch (e) {
      this.setStatus(`保存失败：${e.message}`, true);
    }
  }

  saveFromForm() {
    // 必须按 id 取：面板里现在有两个 form（桌宠开关 + 提供方设置），
    // querySelector('form') 会拿到第一个，于是 ccswitchEnabled 是 undefined 直接抛错
    const f = this.body.querySelector('#provider-form');
    if (!f) return;
    // 台词库是本地偏好，不走桥接
    if (this.lines && f.elements.linesEnabled) {
      this.lines.setEnabled(f.elements.linesEnabled.checked);
    }
    const patch = {
      ccswitch: {
        enabled: f.elements.ccswitchEnabled.checked,
        db: f.elements.ccswitchDb.value.trim(),
      },
      dsh: {
        estimateCost: Boolean(f.elements.dshEstimate?.checked),
        displayCurrency: f.elements.dshCurrency?.value || 'CNY',
        usdToCny: Number(f.elements.dshRate?.value) || 7.15,
      },
      deepseek: {
        enabled: f.elements.deepseekEnabled.checked,
        baseUrl: f.elements.deepseekBaseUrl.value.trim(),
      },
    };
    const key = f.elements.deepseekKey.value.trim();
    if (key) patch.deepseek.apiKey = key; // 空着就不动原有密钥
    this.save(patch);
  }

  render() {
    if (!this.ensureEls()) return;
    const { config, providers } = this.data;
    // dsh 是"按定价折算的会话花费"，和账本/余额一样值得单独一张卡
    const local = providers.filter((p) => ['ccswitch', 'deepseek', 'dsh'].includes(p.provider));
    const localHtml = local.map((p) => this.card(p)).join('') || '<p class="muted">暂无</p>';

    this.body.innerHTML = `
      <section>
        <h3>账本与余额</h3>
        <div class="cards">${localHtml}</div>
      </section>
      <section>
        <h3>本地 Agent 用量（来自事件流，无需配置）</h3>
        <div class="cards">${this.localAgents()}</div>
      </section>
      <section>
        <h3>外观</h3>
        ${this.appearanceSection()}
      </section>
      <section>
        <h3>桌宠</h3>
        <form class="inline">
          <label class="chk">
            <input type="checkbox" name="linesEnabled" ${this.lines?.enabled ? 'checked' : ''}>
            启用台词库（关掉就只说事实，不说台词）
          </label>
          <label class="chk">
            <input type="checkbox" name="usageBroadcast" ${this.usageBroadcast?.get?.() ? 'checked' : ''}>
            随机播报余额/用量 <span class="muted small">（15–40 分钟随机一次，有等待中的确认时不插话）</span>
          </label>
        </form>
      </section>
      <section>
        <h3>台词库 <span class="muted small">改完立即生效，存在 runtime/lines.json</span></h3>
        <div class="cats">${this.linesSection()}</div>
      </section>
      <section>
        <h3>提供方设置</h3>
        <form id="provider-form">
          <label class="chk">
            <input type="checkbox" name="ccswitchEnabled" ${config.ccswitch.enabled ? 'checked' : ''}>
            读取 CC Switch 账本（只读，不写它的库）
          </label>
          <label class="field">
            <span>数据库路径</span>
            <input type="text" name="ccswitchDb" value="${config.ccswitch.db}">
          </label>
          <hr>
          <label class="chk">
            <input type="checkbox" name="dshEstimate" ${config.dsh?.estimateCost ? 'checked' : ''}>
            按标价表估算 DSH 金额 <span class="muted small">（不推荐：你常在半价时段用，估算会偏高）</span>
          </label>
          <label class="field"><span>显示币种</span>
            <select name="dshCurrency">
              <option value="CNY"${config.dsh?.displayCurrency === 'CNY' ? ' selected' : ''}>CNY（人民币）</option>
              <option value="USD"${config.dsh?.displayCurrency === 'USD' ? ' selected' : ''}>USD（美元）</option>
            </select>
            <span class="muted small">汇率</span>
            <input type="number" step="0.01" min="0.01" max="100" name="dshRate"
              value="${config.dsh?.usdToCny ?? 7.15}">
          </label>
          <hr>
          <label class="chk">
            <input type="checkbox" name="deepseekEnabled" ${config.deepseek.enabled ? 'checked' : ''}>
            查询 DeepSeek 官方余额（可选，需要 api-key）
          </label>
          <label class="field">
            <span>api-key</span>
            <input type="password" name="deepseekKey" autocomplete="off"
              placeholder="${config.deepseek.hasApiKey ? `已设置 ${config.deepseek.keyHint}（留空则不改）` : 'sk-…'}">
          </label>
          <label class="field">
            <span>接口地址</span>
            <input type="text" name="deepseekBaseUrl" value="${config.deepseek.baseUrl}">
          </label>
          <div class="actions">
            <button type="submit">保存并立即刷新</button>
            ${config.deepseek.hasApiKey ? '<button type="button" data-action="clear-key">清除密钥</button>' : ''}
          </div>
          <p class="muted small">密钥只保存在本机 runtime/usage.json，页面不会读到它。</p>
        </form>
      </section>`;
  }

  /** 台词库编辑区：逐类折叠，列出现有台词（可删）+ 一行添加 */
  linesSection() {
    if (!this.linesData) {
      return '<p class="muted small">连不上桥接进程，暂时只能看不能说 —— 启动 <code>node tools/pet_bridge.mjs</code> 后即可编辑。</p>';
    }
    return Object.entries(this.linesData).map(([key, cat]) => `
      <details class="cat"${cat.custom ? ' open' : ''}>
        <summary>${esc(cat.label)}
          <span class="muted small">${cat.lines.length} 条${cat.custom ? ' · 已自定义' : ''}</span>
        </summary>
        <div class="chips">
          ${cat.lines.map((t) => `<span class="chip">${esc(t)}<button type="button"
            data-lines="remove" data-cat="${key}" data-text="${esc(t)}" title="删除">×</button></span>`).join('')}
        </div>
        <div class="addline">
          <input type="text" data-add="${key}" placeholder="加一条台词，回车确认">
          <button type="button" data-lines="add" data-cat="${key}">添加</button>
          ${cat.custom ? `<button type="button" data-lines="reset" data-cat="${key}">恢复默认</button>` : ''}
        </div>
      </details>`).join('');
  }

  /** 外观控件：拖动即时生效（防抖 150ms），不用点保存 */
  appearanceSection() {
    const a = this.appearance?.get?.() || {};
    return `
      <form class="inline" id="appearance-form">
        <label class="field"><span>大小</span>
          <input type="range" name="size" min="100" max="${this.maxSize}" step="10"
                 value="${Math.min(a.size ?? 200, this.maxSize)}">
          <b class="val">${Math.min(a.size ?? 200, this.maxSize)}px</b>
        </label>
        <label class="field"><span>透明度</span>
          <input type="range" name="opacity" min="0.3" max="1" step="0.05" value="${a.opacity ?? 1}">
          <b class="val">${Math.round((a.opacity ?? 1) * 100)}%</b>
        </label>
        <label class="chk">
          <input type="checkbox" name="alwaysOnTop" ${a.alwaysOnTop !== false ? 'checked' : ''}>
          总在最前
        </label>
        <label class="chk">
          <input type="checkbox" name="clickThrough" ${a.clickThrough !== false ? 'checked' : ''}>
          空白处点击穿透 <span class="muted small">（关掉后整个窗口都会挡住桌面）</span>
        </label>
      </form>`;
  }

  localAgents() {
    const seen = new Map();
    for (const p of this.data.providers || []) {
      if (p.provider === 'ccswitch' || p.provider === 'deepseek') continue;
      seen.set(p.provider, p);
    }
    // 事件流里的 codex / dsh 用量的权威来源是页面自身，这里只作提示
    return `<p class="muted">Codex 与 DSH 的用量由桌宠自己从事件流汇总
      （Codex 读 rollout 的 token_count，DSH 读会话投影的 tokenUsage）。</p>
      ${[...seen.values()].map((p) => this.card(p)).join('')}`;
  }

  card(p) {
    const badge = `<span class="badge ${p.status}">${STATUS_TEXT[p.status] || p.status}</span>`;
    if (p.status !== 'ok') {
      return `<div class="card">
        <div class="card-h"><b>${p.label || p.provider}</b>${badge}</div>
        <div class="muted small">${p.detail || '暂无数据'}</div>
      </div>`;
    }
    if (p.provider === 'ccswitch') {
      return `<div class="card">
        <div class="card-h"><b>${p.label}</b>${badge}</div>
        <div class="big">${fmtMoney(p.cost, p.currency)}<span class="unit">今日</span></div>
        <div class="rows">
          <div><span>今日 tokens</span><b>${fmtTokens(p.used)}</b></div>
          <div><span>今日请求</span><b>${p.requests}</b></div>
          <div><span>近 7 天</span><b>${fmtMoney(p.week.cost, p.currency)} · ${fmtTokens(p.week.used)}</b></div>
          <div><span>近 30 天</span><b>${fmtMoney(p.monthCost, p.currency)}</b></div>
        </div>
        ${p.byApp?.length ? `<div class="muted small">近 7 天：
          ${p.byApp.map((a) => `${a.app} ${fmtMoney(a.cost)}（${a.requests} 次）`).join(' · ')}</div>` : ''}
      </div>`;
    }
    if (p.provider === 'dsh') {
      const hasCost = Number.isFinite(p.cost);
      return `<div class="card">
        <div class="card-h"><b>${p.label}</b>${badge}</div>
        <div class="big">${hasCost ? `≈${fmtMoney(p.cost, p.currency)}` : fmtTokens(p.used)}
          <span class="unit">${hasCost ? esc(p.model || '') : `tokens · ${esc(p.model || '')}`}</span></div>
        <div class="rows">
          <div><span>tokens（精确）</span><b>${fmtTokens(p.used)}</b></div>
          <div><span>步数</span><b>${p.requests}</b></div>
          <div><span>输入</span><b>${fmtTokens(p.input)}</b></div>
          <div><span>输出</span><b>${fmtTokens(p.output)}</b></div>
          <div><span>缓存读</span><b>${fmtTokens(p.cached)}</b></div>
        </div>
        <div class="muted small">${esc(p.estimateNote || '')}</div>
      </div>`;
    }
    if (p.provider === 'deepseek') {
      const spent = Number.isFinite(p.spent24h) && p.spent24h > 0
        ? `<div class="rows"><div><span>近 24h 消耗</span><b>${fmtMoney(p.spent24h, p.currency)}</b></div>
           <div><span>近 7 天消耗</span><b>${fmtMoney(p.spent7d, p.currency)}</b></div></div>` : '';
      return `<div class="card">
        <div class="card-h"><b>${p.label}</b>${badge}</div>
        <div class="big">${fmtMoney(p.balance, p.currency)}<span class="unit">余额（官方）</span></div>
        <div class="rows">
          <div><span>赠送</span><b>${fmtMoney(p.granted, p.currency)}</b></div>
          <div><span>充值</span><b>${fmtMoney(p.toppedUp, p.currency)}</b></div>
        </div>
        ${spent}
        <div class="muted small">消耗是用<b>余额差额</b>算的（${p.samples || 0} 次采样）：官方 API 只给余额，
          没有用量统计接口，所以差额才是真实出账——它自然包含谷价折扣。采样越多越准。</div>
      </div>`;
    }
    return `<div class="card">
      <div class="card-h"><b>${p.label}</b>${badge}</div>
      <div class="big">${fmtMoney(p.balance, p.currency)}<span class="unit">余额</span></div>
      <div class="rows">
        <div><span>赠送</span><b>${fmtMoney(p.granted, p.currency)}</b></div>
        <div><span>充值</span><b>${fmtMoney(p.toppedUp, p.currency)}</b></div>
      </div>
    </div>`;
  }
}
