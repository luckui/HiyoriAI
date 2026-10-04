/**
 * 弹幕姬 / 直播控制台窗口：实时显示直播间的弹幕、礼物、醒目留言、上舰、进场与在线人数，
 * 并控制直播间画面、AI 互动、节目形式和背景；主播还可以在这里打字和她说话（不会出现在画面里）。
 * 数据全部来自主进程（window.liveAPI），这里只负责显示和转发操作。
 */

import type {
  LiveDirectorState,
  LiveEvent,
  LiveRundownItem,
  LiveSegment,
  LiveSegmentInfo,
  LiveShowSummary,
  LiveStagePhase,
  LiveStageState,
  LiveStatus,
  LiveTheme,
  LiveUser,
} from '../../shared/types/live';

const MAX_ROWS = 300;
const STICK_THRESHOLD_PX = 40;

const feed = document.getElementById('live-feed') as HTMLElement;
const jump = document.getElementById('live-jump') as HTMLButtonElement;
const ambient = document.getElementById('live-ambient') as HTMLElement;
const rows = new Map<string, HTMLElement>();

type FilterKey = 'emote' | 'free-gift' | 'action';
const FILTER_STORE = 'hiyori.live.filters';

function loadFilters(): Record<FilterKey, boolean> {
  const defaults = { emote: true, 'free-gift': true, action: true };
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(FILTER_STORE) ?? '{}') };
  } catch {
    return defaults;
  }
}

const filters = loadFilters();

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

const GUARD_BADGE: Record<number, string> = { 1: '督', 2: '提', 3: '舰' };

function userParts(user: LiveUser): HTMLElement[] {
  const parts: HTMLElement[] = [];
  // 只显示本房间的粉丝牌，别家的牌子是噪音
  if (user.medal?.ofThisRoom) parts.push(el('span', 'badge own', `${user.medal.name} ${user.medal.level}`));
  if (user.guardLevel && GUARD_BADGE[user.guardLevel]) parts.push(el('span', 'badge guard', GUARD_BADGE[user.guardLevel]));
  if (user.isAdmin) parts.push(el('span', 'badge admin', '房'));
  parts.push(el('span', user.masked ? 'name masked' : 'name', user.name || '匿名'));
  return parts;
}

function yuan(value: number): string {
  return value >= 1 ? `¥${Math.round(value * 10) / 10}` : `${Math.round(value * 10)}电池`;
}

/** 生成事件对应的行；不该进列表的（进场、点赞、被过滤的）返回 null */
function renderRow(event: LiveEvent): HTMLElement | null {
  switch (event.kind) {
    case 'chat': {
      if (event.emoteOnly && !filters.emote) return null;
      const row = el('div', event.emoteOnly ? 'row emote' : 'row');
      row.append(...userParts(event.user), document.createTextNode(event.text));
      return row;
    }
    case 'gift': {
      const free = event.valueYuan === 0;
      if (free && !filters['free-gift']) return null;
      const row = el('div', free ? 'row gift free' : 'row gift');
      row.append('🎁 ', ...userParts(event.user), document.createTextNode(` 投喂 ${event.giftName} ×${event.count}`));
      if (!free) row.append(el('span', '', `（${yuan(event.valueYuan)}）`));
      return row;
    }
    case 'superchat': {
      const row = el('div', 'row paid');
      row.append(el('span', 'price', `¥${event.valueYuan}`), ...userParts(event.user), el('div', '', event.text));
      return row;
    }
    case 'membership': {
      const row = el('div', 'row paid membership');
      row.append(
        el('span', 'price', `¥${event.valueYuan}`),
        ...userParts(event.user),
        document.createTextNode(` 开通了${event.levelName}${event.count > 1 ? ` ×${event.count}个月` : ''}`),
      );
      return row;
    }
    case 'follow':
    case 'share': {
      if (!filters.action) return null;
      const row = el('div', 'row action');
      row.append(...userParts(event.user), document.createTextNode(event.kind === 'follow' ? ' 关注了直播间' : ' 分享了直播间'));
      return row;
    }
    default:
      return null;
  }
}

function showAmbient(event: LiveEvent): void {
  if (event.kind !== 'enter' && event.kind !== 'like') return;
  ambient.replaceChildren(
    ...userParts(event.user).map((part) => {
      part.classList.remove('name');
      return part;
    }),
    document.createTextNode(event.kind === 'enter' ? ' 进入直播间' : ' 点了赞'),
  );
}

function nearBottom(): boolean {
  return feed.scrollHeight - feed.scrollTop - feed.clientHeight < STICK_THRESHOLD_PX;
}

function addEvents(events: LiveEvent[]): void {
  const stick = nearBottom();
  let added = false;
  for (const event of events) {
    if (event.kind === 'enter' || event.kind === 'like') {
      showAmbient(event);
      continue;
    }
    const row = renderRow(event);
    const existing = rows.get(event.id);
    if (existing) {
      // 礼物连击：原位更新累计数
      if (row) existing.replaceWith(row);
      else existing.remove();
      if (row) rows.set(event.id, row);
      else rows.delete(event.id);
      continue;
    }
    if (!row) continue;
    feed.querySelector('.empty')?.remove();
    rows.set(event.id, row);
    feed.append(row);
    added = true;
  }
  while (rows.size > MAX_ROWS) {
    const [oldest, node] = rows.entries().next().value as [string, HTMLElement];
    node.remove();
    rows.delete(oldest);
  }
  if (stick) feed.scrollTop = feed.scrollHeight;
  else if (added) jump.hidden = false;
}

function formatCount(n: number | undefined): string {
  if (n === undefined) return '–';
  return n >= 10_000 ? `${(n / 10_000).toFixed(1)}万` : String(n);
}

function renderStatus(status: LiveStatus): void {
  const dot = document.getElementById('live-dot')!;
  dot.className = `live-dot ${status.state === 'connected' ? 'on' : status.state === 'idle' ? '' : 'busy'}`;
  const anchor = document.getElementById('live-anchor')!;
  const title = document.getElementById('live-title')!;
  if (status.state === 'idle') {
    anchor.textContent = '未连接';
    title.textContent = '在设置 › 直播里填房间号后点「连接」';
  } else {
    anchor.textContent = status.room?.anchorName ?? `房间 ${status.room?.roomId ?? ''}`;
    title.textContent = [status.stats.live === false ? '未开播' : '', status.room?.title ?? ''].filter(Boolean).join(' · ');
  }
  (document.getElementById('live-connect') as HTMLButtonElement).textContent = status.state === 'idle' ? '连接' : '断开';

  const stats = document.getElementById('live-stats')!;
  if (status.state === 'idle') {
    stats.replaceChildren();
  } else {
    const item = (label: string, value: string) => {
      const span = el('span', '', `${label} `);
      span.append(el('b', '', value));
      return span;
    };
    stats.replaceChildren(
      item('在线', formatCount(status.stats.online)),
      item('看过', formatCount(status.stats.watched)),
      item('弹幕', `${status.perMinute.chat ?? 0}/分`),
      item('进场', `${status.perMinute.enter ?? 0}/分`),
    );
  }

  const notice = document.getElementById('live-notice')!;
  const message = status.state === 'reconnecting' || status.state === 'error'
    ? status.lastError ?? '连接中断，正在重连'
    : status.state === 'connected' && !status.loggedIn
      ? '未登录连接：B 站会把大部分观众名打码。到设置 › 直播 填登录 Cookie。'
      : status.state === 'connected' && status.lastError
        ? status.lastError
        : '';
  notice.hidden = !message;
  notice.textContent = message;
}

function bindControls(): void {
  for (const key of Object.keys(filters) as FilterKey[]) {
    const box = document.getElementById(`f-${key}`) as HTMLInputElement;
    box.checked = filters[key];
    box.addEventListener('change', () => {
      filters[key] = box.checked;
      try {
        localStorage.setItem(FILTER_STORE, JSON.stringify(filters));
      } catch {
        // 存不了就只在本次窗口生效
      }
      void reload();
    });
  }
  feed.addEventListener('scroll', () => {
    if (nearBottom()) jump.hidden = true;
  });
  jump.addEventListener('click', () => {
    feed.scrollTop = feed.scrollHeight;
    jump.hidden = true;
  });
  document.getElementById('live-connect')?.addEventListener('click', async () => {
    const status = await window.liveAPI.getStatus();
    if (status.state !== 'idle') {
      renderStatus(await window.liveAPI.disconnect());
      return;
    }
    const result = await window.liveAPI.connect();
    renderStatus(result.status);
    if (!result.ok && result.detail) {
      const notice = document.getElementById('live-notice')!;
      notice.hidden = false;
      notice.textContent = result.detail;
    }
  });
  const pin = document.getElementById('live-pin')!;
  pin.addEventListener('click', async () => {
    pin.classList.toggle('live-btn-on', await window.liveAPI.togglePin());
  });
}

// ── 控制台 ─────────────────────────────────────────────

function renderStage(stage: LiveStageState): void {
  document.querySelectorAll<HTMLButtonElement>('.live-phases button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.phase === stage.phase && stage.phase !== 'off');
  });
  document.getElementById('ctl-ai')!.classList.toggle('on', stage.aiRunning);
  (document.getElementById('ctl-segment') as HTMLSelectElement).value = stage.segment;
  (document.getElementById('ctl-theme') as HTMLSelectElement).value = stage.theme;
  const capture = document.getElementById('ctl-capture')!;
  capture.hidden = stage.segment !== 'game';
  capture.textContent = stage.capture ? `🎮 ${stage.capture.name.slice(0, 10)}` : '🎮 游戏窗口';
  document.getElementById('ctl-bg-clear')!.hidden = !stage.background;
  document.getElementById('ctl-bg')!.title = stage.background ? `当前背景：${stage.background}` : '自定义背景：选一个视频或图片（会盖住主题场景）';
}

/** 游戏回：列出可采集的窗口，点一个就显示到直播间的游戏框里 */
async function toggleCapturePicker(): Promise<void> {
  const picker = document.getElementById('capture-picker')!;
  if (!picker.hidden) {
    picker.hidden = true;
    return;
  }
  picker.replaceChildren(el('div', 'live-title', '读取窗口列表…'));
  picker.hidden = false;
  const sources = await window.liveAPI.listCaptureSources();
  const none = el('button');
  none.append(el('span', '', '✕ 不显示游戏画面'));
  none.addEventListener('click', async () => {
    renderStage(await window.liveAPI.setCapture(null));
    picker.hidden = true;
  });
  picker.replaceChildren(none, ...sources.map((source) => {
    const btn = el('button');
    const img = document.createElement('img');
    if (source.thumbnail) img.src = source.thumbnail;
    btn.append(img, el('span', '', source.name));
    btn.title = source.name;
    btn.addEventListener('click', async () => {
      renderStage(await window.liveAPI.setCapture({ id: source.id, name: source.name }));
      picker.hidden = true;
    });
    return btn;
  }));
}

function showNotice(text: string): void {
  const notice = document.getElementById('live-notice')!;
  notice.hidden = false;
  notice.textContent = text;
}

function ownerRow(who: string, text: string, reply = false): void {
  const row = el('div', reply ? 'row owner reply' : 'row owner');
  row.append(el('span', 'who', who), document.createTextNode(text));
  feed.querySelector('.empty')?.remove();
  feed.append(row);
  feed.scrollTop = feed.scrollHeight;
}

function bindConsole(): void {
  const api = window.liveAPI;
  let stage: LiveStageState | null = null;
  api.onStage((s) => { stage = s; renderStage(s); });
  void api.getStage().then((s) => { stage = s; renderStage(s); });

  document.querySelectorAll<HTMLButtonElement>('.live-phases button').forEach((btn) => {
    btn.addEventListener('click', async () => {
      renderStage(await api.setPhase(btn.dataset.phase as LiveStagePhase));
    });
  });
  document.getElementById('ctl-ai')!.addEventListener('click', async () => {
    if (stage?.aiRunning) {
      renderStage(await api.stopAi());
      return;
    }
    const result = await api.startAi();
    renderStage(result.state);
    if (!result.ok && result.detail) showNotice(result.detail);
  });
  document.getElementById('ctl-segment')!.addEventListener('change', async (e) => {
    renderStage(await api.setSegment((e.target as HTMLSelectElement).value as LiveSegment));
  });
  document.getElementById('ctl-theme')!.addEventListener('change', async (e) => {
    renderStage(await api.setTheme((e.target as HTMLSelectElement).value as LiveTheme));
  });
  document.getElementById('ctl-capture')!.addEventListener('click', () => void toggleCapturePicker());
  document.getElementById('ctl-bg')!.addEventListener('click', async () => renderStage(await api.pickBackground()));
  document.getElementById('ctl-bg-clear')!.addEventListener('click', async () => renderStage(await api.clearBackground()));

  const form = document.getElementById('owner-form') as HTMLFormElement;
  const input = document.getElementById('owner-input') as HTMLInputElement;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    // 「/弹幕 内容」：以测试观众身份发一条弹幕，没开播也能试她怎么接
    const test = text.match(/^\/弹幕\s+(.+)$/);
    if (test) {
      if (!(await api.testChat('测试观众', test[1]))) showNotice('先打开 AI 互动，再发测试弹幕');
      return;
    }
    ownerRow('你：', text);
    input.disabled = true;
    try {
      const result = await api.ownerSay(text);
      if (result.ok && result.reply) ownerRow('Hiyori：', result.reply, true);
      else if (!result.ok) showNotice(`没发出去：${result.detail ?? '未知错误'}`);
    } finally {
      input.disabled = false;
      input.focus();
    }
  });
}

// ── 节目单 ─────────────────────────────────────────────

function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

function renderSummary(result: { summary: LiveShowSummary; file: string | null } | null): void {
  const box = document.getElementById('show-summary')!;
  if (!result) return;
  const s = result.summary;
  const pct = (x: number) => `${Math.round(x * 100)}%`;
  box.hidden = false;
  box.replaceChildren();
  const line = (label: string, value: string) => {
    const row = el('div', '', `${label} `);
    row.append(el('b', '', value));
    box.append(row);
  };
  line('上一场', `有人看的 ${Math.round(s.durationMs / 60_000)} 分钟里她说了 ${s.speeches} 段${s.emptyMs >= 60_000 ? `（另有 ${Math.round(s.emptyMs / 60_000)} 分钟没人在看）` : ''}`);
  line('说话占比', pct(s.talkRatio));
  line(`冷场（空隙超过 ${s.options.coldGapSec} 秒）`, pct(s.coldRate));
  line('重复', `${pct(s.repeatRate)}，套路开头 ${pct(s.openingRepeatRate)}，后半场新鲜度 ${s.novelty}`);
  if (s.stockPhrases.length) line('口头禅', s.stockPhrases.slice(0, 4).map((p) => `${p.phrase}×${p.lines}`).join('  '));
  if (s.segments.length) line('环节', s.segments.map((g) => `${g.title} ${Math.round(g.ms / 60_000)} 分 ${g.beats} 拍`).join('，'));
  if (s.highlights.length) line('高光候选', `${s.highlights.length} 处`);
  const open = el('button', 'live-btn', '打开记录文件夹');
  open.addEventListener('click', () => void window.liveAPI.openShowLogs());
  box.append(open);
}

function bindRundown(): void {
  const api = window.liveAPI;
  const list = document.getElementById('rundown-list')!;
  const now = document.getElementById('rundown-now')!;
  const hint = document.getElementById('rundown-hint')!;
  let segments: LiveSegmentInfo[] = [];
  let state: LiveDirectorState | null = null;
  /** 正在编辑的节目单；改了没保存时不被主进程的状态覆盖 */
  let draft: LiveRundownItem[] = [];
  let dirty = false;

  const markDirty = () => {
    dirty = true;
    hint.textContent = state?.running ? '未保存（正在跑的节目单下一场才换）' : '未保存';
  };

  const renderList = () => {
    list.replaceChildren(...draft.map((item, i) => {
      const li = document.createElement('li');
      if (state?.running && !dirty) {
        li.classList.toggle('current', i === state.index);
        li.classList.toggle('done', state.index >= 0 && i < state.index);
      }
      const select = document.createElement('select');
      for (const seg of segments) {
        const opt = document.createElement('option');
        opt.value = seg.id;
        opt.textContent = seg.title;
        opt.title = seg.description;
        select.append(opt);
      }
      select.value = item.segmentId;
      select.addEventListener('change', () => { item.segmentId = select.value; markDirty(); });
      const minutes = document.createElement('input');
      minutes.type = 'number';
      minutes.min = '1';
      minutes.max = '240';
      minutes.value = String(item.minutes);
      minutes.addEventListener('change', () => { item.minutes = Number(minutes.value) || 10; markDirty(); });
      const remove = el('button', 'rd-remove', '✕');
      remove.title = '删掉这一项';
      remove.addEventListener('click', () => { draft.splice(i, 1); markDirty(); renderList(); });
      li.append(select, ' ', minutes, ' 分钟 ', remove);
      return li;
    }));
  };

  const renderState = (next: LiveDirectorState | null) => {
    state = next;
    if (!next) return;
    if (!dirty) draft = next.rundown.map((i) => ({ ...i }));
    const cur = next.current;
    now.classList.toggle('on', next.running && !!cur);
    now.textContent = !next.running
      ? '未开始'
      : !cur
        ? '节目单走完了，自由聊天'
        : `${next.paused ? '⏸ ' : '▶ '}${cur.title} ${clock(cur.elapsedMs)} / ${clock(cur.plannedMs)} · ${cur.beats} 拍${next.pausedFor === 'audience' ? '（没人在看，等人来）' : next.pausedFor === 'layout' ? '（画面切走了）' : ''}`;
    document.getElementById('rd-start')!.textContent = next.running ? '■ 停止' : '▶ 开始';
    renderList();
  };

  void api.getRundown().then(({ segments: all, state: st }) => {
    segments = all;
    renderState(st);
  });
  void api.getShowSummary().then(renderSummary);
  api.onDirector(renderState);
  api.onShowSummary(renderSummary);
  // 计时每秒刷新
  setInterval(() => {
    if (state?.running && state.current && !state.paused) void api.getRundown().then(({ state: st }) => renderState(st));
  }, 1000);

  document.getElementById('rd-start')!.addEventListener('click', async () => {
    renderState(state?.running ? await api.stopRundown() : await api.startRundown());
  });
  document.getElementById('rd-next')!.addEventListener('click', async () => renderState(await api.nextSegment()));
  document.getElementById('rd-extend')!.addEventListener('click', async () => renderState(await api.extendSegment(5)));
  document.getElementById('rd-skip')!.addEventListener('click', async () => renderState(await api.skipUpcoming()));
  document.getElementById('rd-add')!.addEventListener('click', () => {
    draft.push({ segmentId: segments[0]?.id ?? 'topic-cards', minutes: 15 });
    markDirty();
    renderList();
  });
  document.getElementById('rd-save')!.addEventListener('click', async () => {
    dirty = false;
    hint.textContent = '已保存';
    renderState(await api.saveRundown(draft));
  });
}

async function reload(): Promise<void> {
  rows.clear();
  feed.replaceChildren(el('div', 'empty', '还没有弹幕'));
  addEvents(await window.liveAPI.getRecent());
  feed.scrollTop = feed.scrollHeight;
}

async function init(): Promise<void> {
  bindControls();
  bindConsole();
  bindRundown();
  window.liveAPI.onUpdate((update) => {
    addEvents(update.events);
    renderStatus(update.status);
  });
  renderStatus(await window.liveAPI.getStatus());
  await reload();
}

void init();
