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
  ResearchJobSummary,
  ResearchSpecInput,
} from '../../shared/types/live';
import { researchSpecProblem } from '../../shared/types/live';

import { disablePtt, enablePtt, pttDown, pttState, pttToggle, pttUp, type PttState } from './ptt';

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
  statusNow = status;
  renderGuide();
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

// ── 开播引导 ───────────────────────────────────────────

let stageNow: LiveStageState | null = null;
let statusNow: LiveStatus | null = null;
let directorNow: LiveDirectorState | null = null;
let researchNow: ResearchJobSummary | null = null;

/** 环节默认的布局：和它不一样的写成 id@布局（歌回、游戏回） */
const DEFAULT_LAYOUT: Record<string, string> = { 'topic-cards': 'chat', 'free-chat': 'chat', 'bili-intel': 'watch' };

function choiceOf(segmentId: string, layout?: string): string {
  return layout && layout !== (DEFAULT_LAYOUT[segmentId] ?? layout) ? `${segmentId}@${layout}` : segmentId;
}

/** 根据现在的状态告诉主人下一步该做什么 */
function renderGuide(): void {
  const guide = document.getElementById('live-guide');
  if (!guide) return;
  const stage = stageNow;
  const connected = statusNow && statusNow.state !== 'idle';
  const cur = directorNow?.current;
  let html: string;
  if (!connected) {
    html = '① 先点右上角 <b>连接</b>（房间号在设置 › 直播里填）';
  } else if (!stage || stage.phase === 'off') {
    html = '② 选好下面的 <b>现在的环节</b>（开场后先做它），再点 <b>⏳ 准备中</b> 或 <b>▶ 开场</b>，AI 互动会自动打开。<br>直播间没开播也能这样排练。';
  } else if (stage.phase === 'waiting') {
    html = '准备中：画面是待机页。推流准备好了点 <b>▶ 开场</b>（放开场动画，放完自动进入直播中）。';
  } else if (stage.phase === 'opening') {
    html = '开场动画中，放完自动进入直播中，她会先打招呼。';
  } else if (stage.phase === 'ending') {
    html = '谢幕中：她在道别。结束后点 <b>✕</b> 回到桌宠，会写这一场的记录。';
  } else if (!stage.aiRunning) {
    html = '直播中，但 <b>AI 互动</b>没开：她不会说话。点 <b>🤖 AI 互动</b> 打开。';
  } else if (directorNow?.pausedFor === 'audience') {
    html = '直播中 · 现在没人在看，她先歇着（省钱），有人进来或发弹幕就开始。';
  } else {
    html = `直播中${directorNow?.rehearsal ? '（<b>排练模式</b>：直播间没开播，没人也照常演；发「/弹幕 内容」试互动）' : ''} · 现在的环节：<b>${cur?.title ?? '自由聊天'}</b>`;
  }
  guide.innerHTML = html;
}

function renderDirector(next: LiveDirectorState | null): void {
  directorNow = next;
  const select = document.getElementById('ctl-segment') as HTMLSelectElement | null;
  if (select && next) {
    const cur = next.current;
    const first = next.rundown[0];
    const value = cur ? choiceOf(cur.segmentId, cur.layout) : first ? choiceOf(first.segmentId, first.params?.layout as string | undefined) : '';
    if (value && [...select.options].some((o) => o.value === value)) select.value = value;
  }
  renderResearchContext();
  renderGuide();
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
}

/** 研究面板里填的设置 */
let researchForm: ResearchSpecInput = { kind: 'hot' };

function researchRunning(job: ResearchJobSummary | null): boolean {
  return !!job && (job.status === 'running' || job.status === 'preparing');
}

function describeSpec(spec: ResearchSpecInput): string {
  const t = spec.target?.trim();
  return { hot: 'B站热门快照', up: `UP 主「${t}」的全部投稿`, search: `关键词「${t}」`, videos: '指定的视频' }[spec.kind];
}

/** 填的设置和正在跑的任务不一样（没填的数量、转写不算不一样） */
function formDiffers(job: ResearchJobSummary): boolean {
  const f = researchForm;
  return f.kind !== job.spec.kind
    || (f.target?.trim() ?? '') !== (job.spec.target ?? '')
    || (!!f.limit && f.limit !== job.spec.limit)
    || (!!f.transcribe && f.transcribe !== job.spec.transcribe);
}

/** 研究面板：一个主按钮（开始 ↔ 停止）+ 一句话说清现在什么状态、和直播什么关系 */
function renderResearchContext(): void {
  const box = document.getElementById('rs-context');
  const toggle = document.getElementById('rs-toggle') as HTMLButtonElement | null;
  const swap = document.getElementById('rs-switch') as HTMLButtonElement | null;
  if (!box || !toggle || !swap) return;
  const job = researchNow;
  const running = researchRunning(job);
  const problem = researchSpecProblem(researchForm);
  const showing = directorNow?.current?.segmentId === 'bili-intel';

  toggle.textContent = running ? '■ 停止研究' : '▶ 开始研究';
  toggle.classList.toggle('stop', running);
  toggle.disabled = !running && !!problem;
  toggle.title = running ? '停掉正在跑的任务（已经做完的保留，可以出报告）' : problem ?? `开始研究：${describeSpec(researchForm)}`;
  swap.hidden = !(running && job && formDiffers(job));
  swap.disabled = !!problem;

  const next = problem
    ? `⚠ 上面的设置${problem}；不填的话情报站会退回做热门快照。`
    : `情报站开始时手上没任务，会自动研究 <b>${escapeHtml(describeSpec(researchForm))}</b>；也可以现在先点开始，开播前攒好素材。`;
  let html: string;
  if (running) {
    html = showing
      ? '📡 她正在情报站里讲这批视频，做完一条讲一条。'
      : '研究在后台跑，直播里还没讲。要讲：把上面的 <b>现在的环节</b> 切到 <b>📡 B站情报站</b>。';
    if (!swap.hidden) html += '<br>上面的设置改过了：点 <b>↻ 换成上面的设置</b> 才会生效（会停掉当前任务）。';
  } else if (job?.status === 'done') {
    html = `这批做完了${job.reportFile ? '，报告已写好' : '，可以点 📄 出报告'}。${showing ? '她讲完做完的就进下一个环节。' : ''}<br>${next}`;
  } else if (job?.status === 'stopped') {
    html = `任务停了（做完的 ${job.done} 条保留，可以出报告）。${showing ? '她讲完做完的就进下一个环节。' : ''}<br>${next}`;
  } else if (job?.status === 'failed') {
    html = `上个任务开不了：${escapeHtml(job.error ?? '未知错误')}<br>${next}`;
  } else {
    html = next;
  }
  box.innerHTML = html;
}

function renderStage(stage: LiveStageState): void {
  stageNow = stage;
  renderGuide();
  document.querySelectorAll<HTMLButtonElement>('.live-phases button').forEach((btn) => {
    btn.classList.toggle('on', btn.dataset.phase === stage.phase && stage.phase !== 'off');
  });
  const ai = document.getElementById('ctl-ai')!;
  ai.classList.toggle('on', stage.aiRunning);
  // 开着时写「互动中」：开播阶段会自动打开，免得主人以为还要再点一下（一点就关了）
  ai.textContent = stage.aiRunning ? '🤖 AI 互动中' : '🤖 开启 AI 互动';
  ai.title = stage.aiRunning ? '她正在自己回应直播间；点一下暂停' : '打开后她会自己挑弹幕、礼物、进场来回应（点准备中 / 开场 / 直播中也会自动打开）';
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
  api.onNotice((text) => showNotice(text));
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
    const choice = (e.target as HTMLSelectElement).value;
    renderDirector(await api.switchSegment(choice));
    if (stage?.phase === 'live' && stage.aiRunning) showNotice('她说完手上这句，会口播一句过渡再切过去');
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
    // 测试命令：没开播也能试她怎么接。名字后面可以带 #uid（测私信要用真实 uid）
    //   /弹幕 内容　/弹幕 小明：内容　/进场 小明　/礼物 小明#123456 [礼物名]
    const who = (raw: string) => {
      const m = raw.trim().match(/^([^#\s]+)(?:#(\d+))?$/);
      return m ? { name: m[1], uid: m[2] } : { name: raw.trim() || '测试观众', uid: undefined };
    };
    const chat = text.match(/^\/弹幕\s+(?:([^：:\s]{1,30})[：:]\s*)?(.+)$/);
    const event = text.match(/^\/(进场|礼物)\s+(\S+)(?:\s+(\S+))?$/);
    if (chat || event) {
      let ok: boolean;
      if (chat) {
        const v = who(chat[1] ?? '测试观众');
        ok = await api.testChat(v.name, chat[2], v.uid);
      } else {
        const v = who(event![2]);
        ok = await api.testEvent({ kind: event![1] === '进场' ? 'enter' : 'gift', name: v.name, uid: v.uid, gift: event![3] });
      }
      if (!ok) showNotice('先打开 AI 互动，再发测试弹幕');
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

const RESEARCH_STATUS = { preparing: '⏳ 准备中', running: '🔬 研究中', done: '✅ 已完成', stopped: '⏹ 已停止', failed: '⚠ 开不了' } as const;

/** B站研究：开任务、看进度、出报告；情报站讲过的视频要不要点赞评论 */
function bindResearch(): void {
  const api = window.liveAPI;
  const like = document.getElementById('pt-like') as HTMLInputElement;
  const comment = document.getElementById('pt-comment') as HTMLInputElement;
  const giftDm = document.getElementById('pt-giftdm') as HTMLInputElement;
  void api.getPatrolSettings().then((s) => { like.checked = s.like; comment.checked = s.comment; giftDm.checked = !!s.giftDm; });
  const save = () => void api.setPatrolSettings({ like: like.checked, comment: comment.checked, giftDm: giftDm.checked });
  for (const box of [like, comment, giftDm]) box.addEventListener('change', save);

  const now = document.getElementById('research-now')!;
  const hint = document.getElementById('rs-hint')!;
  const kind = document.getElementById('rs-kind') as HTMLSelectElement;
  const target = document.getElementById('rs-target') as HTMLInputElement;
  const limit = document.getElementById('rs-limit') as HTMLInputElement;
  const transcribe = document.getElementById('rs-transcribe') as HTMLSelectElement;
  const say = (text: string) => {
    hint.hidden = !text;
    hint.textContent = text;
    if (text) hint.dataset.sticky = '1';
    else delete hint.dataset.sticky;
  };
  const render = (job: ResearchJobSummary | null) => {
    researchNow = job;
    renderResearchContext();
    now.classList.toggle('on', researchRunning(job));
    now.classList.toggle('warn', job?.status === 'failed');
    now.textContent = job
      ? `${RESEARCH_STATUS[job.status]} · ${job.title} ${job.done}/${job.total}${job.working && job.status === 'running' ? ` · ${job.working.slice(0, 16)}` : ''}`
      : '⏸ 空闲';
  };

  // 填的设置：改了就存（情报站自己开任务时照它），不用先点开始
  const readForm = (): ResearchSpecInput => ({
    kind: kind.value as ResearchSpecInput['kind'],
    target: target.value.trim() || undefined,
    limit: Number(limit.value) || undefined,
    transcribe: (transcribe.value || undefined) as ResearchSpecInput['transcribe'],
  });
  const placeholder = () => {
    target.placeholder = { hot: '（不用填）', up: 'UP 主名字或 mid', search: '关键词', videos: 'BV 号，多个用空格分开' }[kind.value] ?? '';
    target.disabled = kind.value === 'hot';
  };
  let saveTimer: number | null = null;
  const formChanged = () => {
    researchForm = readForm();
    placeholder();
    renderResearchContext();
    if (saveTimer !== null) clearTimeout(saveTimer);
    saveTimer = window.setTimeout(() => void api.setResearchSpec(researchForm), 400);
  };
  for (const input of [kind, transcribe]) input.addEventListener('change', formChanged);
  for (const input of [target, limit]) input.addEventListener('input', formChanged);
  void api.getResearchSpec().then((spec) => {
    kind.value = spec.kind;
    target.value = spec.target ?? '';
    limit.value = spec.limit ? String(spec.limit) : '';
    transcribe.value = spec.transcribe ?? '';
    researchForm = readForm();
    placeholder();
    renderResearchContext();
  });

  void api.getResearch().then(render);
  api.onResearch(render);
  api.onResearchReport((r) => {
    say(`📄 报告写好了：${r.title}`);
    void api.getResearch().then(render);
  });
  const start = async () => {
    say('');
    const result = await api.startResearch(readForm());
    if (!result.ok) say(`开不了：${result.detail ?? '未知错误'}`);
    if (result.job) render(result.job);
  };
  document.getElementById('rs-toggle')!.addEventListener('click', async () => {
    if (researchRunning(researchNow)) render(await api.stopResearch());
    else await start();
  });
  document.getElementById('rs-switch')!.addEventListener('click', () => void start());
  document.getElementById('rs-report')!.addEventListener('click', async () => {
    say('写报告中…（会请 LLM 总结流量风向）');
    const report = await api.researchReport();
    if (!report) return say('还没有研究任务');
    say('');
    void api.openResearch('file', report.file);
  });
  document.getElementById('rs-open')!.addEventListener('click', () => void api.openResearch('reports'));
  document.getElementById('rs-videos')!.addEventListener('click', () => void api.openResearch('videos'));
}

/** 公告板：改文字、显示 / 隐藏 */
function bindBoard(): void {
  const api = window.liveAPI;
  const text = document.getElementById('board-text') as HTMLTextAreaElement;
  const show = document.getElementById('board-show') as HTMLInputElement;
  const now = document.getElementById('board-now')!;
  const hint = document.getElementById('board-hint')!;
  let dirty = false;
  const render = (state: { board: { text: string; show: boolean }; lines: string[] }) => {
    now.textContent = state.board.show ? `显示中 · ${state.lines[0] ?? ''}` : '不显示';
    if (dirty) return;
    text.value = state.board.text;
    show.checked = state.board.show;
  };
  text.addEventListener('input', () => { dirty = true; hint.textContent = '改了还没保存'; });
  const save = async (value: string) => {
    dirty = false;
    render(await api.setBoard({ text: value, show: show.checked }));
    hint.textContent = '已保存';
  };
  document.getElementById('board-save')!.addEventListener('click', () => void save(text.value));
  document.getElementById('board-reset')!.addEventListener('click', () => void save(''));
  show.addEventListener('change', () => void save(text.value));
  void api.getBoard().then(render);
  api.onBoard(render);
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
    renderDirector(next);
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

// ── 主人按键说话 ───────────────────────────────────────

const PTT_LABEL: Record<PttState, string> = { off: '🎙 按住说话', ready: '🎙 按住说话', talking: '🔴 松开结束', transcribing: '… 识别中' };

function bindPtt(): void {
  const toggle = document.getElementById('ctl-mic')!;
  const btn = document.getElementById('ptt') as HTMLButtonElement;
  const render = (s: PttState) => {
    toggle.classList.toggle('on', s !== 'off');
    btn.hidden = s === 'off';
    btn.textContent = PTT_LABEL[s];
    btn.classList.toggle('talking', s === 'talking');
    btn.classList.toggle('transcribing', s === 'transcribing');
  };
  const up = async () => {
    const text = await pttUp();
    if (text) ownerRow('你（语音）：', text);
  };
  toggle.addEventListener('click', async () => {
    if (pttState() !== 'off') {
      await disablePtt();
      return;
    }
    toggle.textContent = '🎙 准备中…';
    const error = await enablePtt(render);
    toggle.textContent = '🎙 主人麦克风';
    if (error) showNotice(error);
  });
  btn.addEventListener('pointerdown', (e) => { btn.setPointerCapture(e.pointerId); pttDown(); });
  btn.addEventListener('pointerup', () => void up());
  btn.addEventListener('pointercancel', () => void up());
  // 空格：不在输入框里时按住说话
  const typing = () => document.activeElement instanceof HTMLInputElement || document.activeElement instanceof HTMLSelectElement;
  document.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat || typing() || pttState() !== 'ready') return;
    e.preventDefault();
    pttDown();
  });
  document.addEventListener('keyup', (e) => {
    if (e.code !== 'Space' || pttState() !== 'talking') return;
    e.preventDefault();
    void up();
  });
  // F8（全局）：按一下开始，再按一下说完
  window.liveAPI.onPttToggle(() => {
    if (pttState() === 'talking') void up();
    else pttToggle();
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
  bindResearch();
  bindBoard();
  bindPtt();
  window.liveAPI.onUpdate((update) => {
    addEvents(update.events);
    renderStatus(update.status);
  });
  renderStatus(await window.liveAPI.getStatus());
  await reload();
}

void init();
