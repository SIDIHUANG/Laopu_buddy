/**
 * Live source：从桥接进程拉真实事件（SSE）。
 *
 * 这是「开发期用浏览器看真实状态」的通道。产品形态下，读取方改成 Tauri 侧
 * 直接 tail 协议 JSONL 文件，上层代码（arbiter / bubbles / renderer）不变。
 */

export class LiveSource {
  /**
   * @param {string} base  桥接地址，例如 http://127.0.0.1:8792
   * @param {(evt:object)=>void} onEvent
   * @param {(status:string, detail?:object)=>void} [onStatus]
   */
  constructor(base, onEvent, onStatus = () => {}) {
    this.base = base.replace(/\/$/, '');
    this.onEvent = onEvent;
    this.onStatus = onStatus;
    this.es = null;
    this.seen = 0;
  }

  async start() {
    // 先补一段历史，避免刚连上时状态是空的
    try {
      const health = await fetch(`${this.base}/health`).then((r) => r.json());
      this.onStatus('connected', health);
    } catch (e) {
      this.onStatus('unreachable', { error: e.message });
      // 桥接没起时不要死等：退避重试
      setTimeout(() => this.start(), 3000);
      return;
    }

    try {
      const backfill = await fetch(`${this.base}/recent?n=200`).then((r) => r.json());
      for (const evt of backfill) {
        this.seen++;
        this.onEvent(evt);
      }
    } catch { /* 补历史失败不影响实时流 */ }

    this.es = new EventSource(`${this.base}/events`);
    this.es.onmessage = (m) => {
      if (!m.data || m.data.startsWith(':')) return;
      try {
        this.onEvent(JSON.parse(m.data));
        this.seen++;
      } catch { /* 坏帧忽略 */ }
    };
    this.es.onerror = () => {
      this.onStatus('reconnecting');
      // EventSource 自带重连，这里只上报
    };
  }

  stop() {
    this.es?.close();
    this.es = null;
  }
}
