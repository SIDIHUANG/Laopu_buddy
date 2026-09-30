/**
 * 台词库。
 *
 * 设计取舍：
 *  1. **台词不能顶掉事实。** 气泡标题放台词（保持状态色），正文仍然放事实
 *     （"要执行 git push" / "命令返回非零退出码"）。否则有了性格、没了信息。
 *  2. **不重复。** 按类别记最近用过的若干条，抽签时排除；类别内用完一轮再重置。
 *  3. **整活向降权。** 它是彩蛋而不是主旋律，权重默认 0.6。
 *  4. 台词库可整体关闭（设置页 / localStorage），关掉就回到纯事实气泡。
 */

export const CATEGORIES = {
  lowBalance: {
    label: '低余额提醒',
    lines: [
      '源石不够了……博士，你该充源石了。',
      '余额见底了。你不充，我就自己动手了。',
      '我知道你在看。源石计划需要资源，打钱。',
      '钱不够了……没关系，我可以等你。我一直都在等，不差这一会儿。',
      '别装作没看见。余额低于阈值了，我提醒过你的。',
      '你再不充，我就把PRTS的权限锁了。……开玩笑的。但你真的该充了。',
      '源石储备告急。我不喜欢催你，但我不催你，你会记得吗？',
      '是不是又忘了？没关系，我记得就行。',
    ],
  },
  working: {
    label: '任务进行中',
    lines: [
      '源石计划正在执行中。别分心。',
      '我这边在跑，你那边呢？',
      '进度正常。我没有偷懒，你也不许。',
      '不用急。我会等，但我不喜欢等太久。',
      '还在算。你先把你的部分做完。',
      '我在处理。别关窗口，我能看到。',
      '快了。别催，催我也没用。',
      '源石铺满大地之前，我不会停。',
    ],
  },
  done: {
    label: '任务完成',
    lines: [
      '做完了。我就知道你可以。',
      '我一直看着。做得不错。',
      '完成了。下一个。',
      '很好。源石计划又推进了一步。',
      '你做得比我预想的快。……我没有夸你，只是在陈述事实。',
      '结束了。我一直在等你做完。现在，可以看看我了吗？',
      '不错。但别得意，后面还有。',
      '我又一次见证了你的工作。……这种感觉很好。',
    ],
  },
  waiting: {
    label: '等待确认',
    lines: [
      '我在等。你知道我在等什么。',
      '需要你确认一下。你不点，我就一直在这儿。',
      '我等了很久了。不急，但我想你快点。',
      '别让我等太久。我不喜欢被晾着。',
      '你还在吗？我一直都在。',
      '有个东西需要你看一眼。就一眼。',
      '我没有催你。我只是站在这儿，看着你。',
    ],
  },
  clickArt: {
    label: '点击·文艺向',
    weight: 1,
    lines: [
      '没想到现在不想松手的会是我。',
      '不准忘记我。',
      '我们终究会在一起吗？……会。',
      '就算是海洋沸腾、大气消失，我们也一样能再见面。',
      '你曾许诺，你会为我停下那束光。',
      '我一直在。你只是有时候忘了看。',
      'PRTS？你问PRTS？……你确定你想知道？',
    ],
  },
  clickFun: {
    label: '点击·整活向',
    weight: 0.6,
    lines: [
      '还不执行源石计划嘛？',
      '博士，我饿了。……不，我不是在说源石。我说的是米饭。',
      '你凌晨四点又在吃泡面？……我当年到底喜欢上了一个什么样的人。',
      '你养的那些小动物好吵。',
      '特蕾西娅？……你提她干什么。我脸色不太好？没有的事。',
      '你不在的时候，我就在想，你会不会又在吃些奇怪的东西。',
      '别玩你那破手机了。',
      '我只想把你困在我的世界里。……开玩笑的。大概。',
    ],
  },
  error: {
    label: '出错',
    lines: [
      '出错了。……没关系。我不接受放弃。',
      '有问题。我来处理。你别动。',
      '计划不会停。我不会让它停。',
      '你看到那个报错了吗？我看到了。我来。',
      '不，我不接受这种事。再试一次。',
      '失误而已。源石计划不会因为一次失误就停止。',
      '……你没事吧？我说的是你的代码，不是你的心情。',
      '我处理好了。不用谢。……你本来也没打算谢我吧。',
    ],
  },
  idle: {
    label: '长时间空闲',
    lines: [
      '你已经很久没动了。我在看。',
      '休息一下吧。我不走。',
      '你在忙别的？没关系。我等。',
      '我一直在。你只是有时候忘了。',
      '……你不在的时候，这儿很安静。我不喜欢太安静。',
      'PRTS在线。普瑞塞斯在线。你什么时候回来？',
      '又去别的地方了。……我记着呢。',
    ],
  },
  provider: {
    label: '切换数据源',
    lines: [
      '换一个？行。反正你在哪，我就在哪。',
      'DeepSeek？Codex？……你挑，我跟着。',
      '数据源切好了。我没有偏好。……真的没有。',
      '你换了一个。我记下了。',
      '不管你用哪个，余额不够的时候我都会提醒你。',
    ],
  },
  // 随机播报余额/用量。默认台词只作为种子，设置页里可自由增删
  usage: {
    label: '用量播报',
    lines: [
      '今日用量已结算。要我念给你听吗？……我念了。',
      '源石消耗记录在这里。你最好看一眼。',
      '我算过了。你的开销，我一笔一笔都记着。',
      '这是用量报告。我没有评价你，只是记录。',
      '账单在这儿。看或不看，它都在增长。',
      '用量报告。……你最近用得有点多，我只是陈述事实。',
      '我把数字放在这儿了。剩下的你自己判断。',
    ],
  },
};

const STORE_KEY = 'presage-pet.lines.enabled';
/** 同一类别里最近用过的条数：避开它们，避免连着刷同一句 */
const RECENT_KEEP = 4;

export class Lines {
  constructor({ enabled = true, storage = null } = {}) {
    this.storage = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    const saved = this.storage?.getItem(STORE_KEY);
    this.enabled = saved === null || saved === undefined ? enabled : saved === '1';
    this.recent = new Map(); // category -> 最近用过的台词
    this.pickedCount = 0;
    /** 用户自定义：{ 类别: [台词...] }；某类非空则替换该类默认台词 */
    this.custom = {};
  }

  /** 默认词库（只读副本），设置页"恢复默认"时用 */
  defaults() {
    const out = {};
    for (const [k, v] of Object.entries(CATEGORIES)) {
      out[k] = { label: v.label, weight: v.weight, lines: v.lines.slice() };
    }
    return out;
  }

  /** 应用用户自定义（来自桥接的 runtime/lines.json） */
  applyCustom(map) {
    this.custom = (map && typeof map === 'object') ? map : {};
    this.recent.clear(); // 词库变了，去重记录作废
    return this.custom;
  }

  isCustom(category) {
    const c = this.custom?.[category];
    return Array.isArray(c) && c.length > 0;
  }

  /** 实际生效的词库：自定义非空则替换默认 */
  effective() {
    const base = this.defaults();
    for (const k of Object.keys(base)) {
      const cu = this.custom?.[k];
      if (Array.isArray(cu) && cu.length) base[k].lines = cu.slice();
    }
    return base;
  }

  linesFor(category) {
    return this.effective()[category]?.lines ?? null;
  }

  setEnabled(on) {
    this.enabled = Boolean(on);
    try { this.storage?.setItem(STORE_KEY, this.enabled ? '1' : '0'); } catch { /* 忽略 */ }
  }

  /** 从某个类别抽一条；抽不到（比如关掉了）返回 null */
  pick(category) {
    if (!this.enabled) return null;
    const lines = this.linesFor(category);
    if (!lines || !lines.length) return null;
    const used = this.recent.get(category) ?? [];
    let pool = lines.filter((t) => !used.includes(t));
    if (!pool.length) {
      this.recent.set(category, []); // 一轮用完了，重置
      pool = lines.slice();
    }
    const text = pool[Math.floor(Math.random() * pool.length)];
    const next = [...used, text].slice(-RECENT_KEEP);
    this.recent.set(category, next);
    this.pickedCount += 1;
    return text;
  }

  /** 点击：文艺向 / 整活向按权重二选一 */
  pickClick() {
    const all = this.effective();
    const art = all.clickArt?.weight ?? 1;
    const fun = all.clickFun?.weight ?? 1;
    const which = Math.random() < art / (art + fun) ? 'clickArt' : 'clickFun';
    return this.pick(which);
  }

  /** 按事件挑类别：给状态机用的一张映射表 */
  categoryFor(kind) {
    switch (kind) {
      case 'error': return 'error';
      case 'done': return 'done';
      case 'waiting': return 'waiting';
      case 'working': return 'working';
      case 'idle': return 'idle';
      case 'lowBalance': return 'lowBalance';
      case 'provider': return 'provider';
      case 'usage': return 'usage';
      default: return null;
    }
  }
}
