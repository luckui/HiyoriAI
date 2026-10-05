/**
 * 舞台面板：角落里「现在在做：××」的小卡片，下面放当前环节自己的内容。
 *
 * 数据由主进程的环节插件给（StagePanelState），这里按 kind 找渲染函数画进面板。
 * 新环节要专门的面板：写一个渲染函数，用 registerPanelRenderer 注册。
 */

import type { StagePanelState } from '../../shared/types/live';

export type PanelRenderer = (body: HTMLElement, data: unknown) => void;

const renderers = new Map<string, PanelRenderer>();

export function registerPanelRenderer(kind: string, render: PanelRenderer): void {
  renderers.set(kind, render);
}

function el(tag: string, cls?: string, text?: string): HTMLElement {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

let lastKey = '';

export function renderPanel(panel: StagePanelState | null): void {
  const root = document.getElementById('stage-panel');
  const title = document.getElementById('stage-panel-title');
  const body = document.getElementById('stage-panel-body');
  if (!root || !title || !body) return;
  if (!panel) {
    root.hidden = true;
    lastKey = '';
    return;
  }
  const key = JSON.stringify(panel);
  if (key === lastKey) return;
  // 换了环节或换了一张卡就重新弹一下（同一张卡往下走一拍不弹）
  const headline = (p: StagePanelState) => `${p.nowDoing}|${(p.data as { title?: string } | undefined)?.title ?? ''}`;
  const changed = !lastKey || headline(JSON.parse(lastKey)) !== headline(panel);
  lastKey = key;
  root.hidden = false;
  title.textContent = panel.nowDoing;
  body.replaceChildren();
  const render = panel.kind ? renderers.get(panel.kind) : undefined;
  if (render) render(body, panel.data);
  body.hidden = !body.childElementCount;
  if (changed) {
    root.classList.remove('sp-pop');
    void root.offsetWidth;
    root.classList.add('sp-pop');
  }
}

// ── 内置：话题卡 ─────────────────────────────────────────

registerPanelRenderer('topic-card', (body, data) => {
  const card = data as { title: string; step: number; steps: number };
  body.append(el('div', 'sp-card-title', card.title));
  const dots = el('div', 'sp-dots');
  for (let i = 1; i <= card.steps; i++) dots.append(el('span', i <= card.step ? 'on' : ''));
  body.append(dots);
});

// ── B站情报站：标题栏的任务名、文件树、视频详情 ────────────────────────

interface IntelPanel {
  stage: string;
  job: { title: string; done: number; total: number; status: string } | null;
  video: { title: string; up: string; duration: string; view: string; like: string; coin: string; favorite: string; danmaku: string; source: string } | null;
  tree: Array<{ title: string; by: string; state: string }>;
}

const TREE_ICON: Record<string, string> = { told: '✓', done: '✓', now: '▶', working: '⟳', queued: '·', skipped: '✗', failed: '✗' };

registerPanelRenderer('bili-intel', (body, data) => {
  const p = data as IntelPanel;
  const title = document.getElementById('ide-title');
  if (title) title.textContent = p.job ? `hiyori-intel — ${p.job.title}  (${p.job.done}/${p.job.total})` : 'hiyori-intel';
  const job = document.getElementById('ide-job');
  if (job) {
    if (p.job) {
      const bar = el('div', 'ide-progress');
      const fill = el('i');
      fill.style.width = `${p.job.total ? Math.round((p.job.done / p.job.total) * 100) : 0}%`;
      bar.append(fill);
      job.replaceChildren(
        el('div', 'ide-job-title', `📁 ${p.job.title}`),
        bar,
        el('div', 'ide-job-meta', `${p.job.done}/${p.job.total} · ${{ preparing: '准备中', running: '研究中', done: '已完成', stopped: '已停止', failed: '失败' }[p.job.status] ?? p.job.status}`),
      );
    } else {
      job.replaceChildren();
    }
  }
  const tree = document.getElementById('stage-playlist');
  tree?.replaceChildren(...p.tree.map((item) => {
    const row = el('div', `spl-row spl-${item.state}`);
    row.append(el('span', 'spl-icon', TREE_ICON[item.state] ?? '·'), el('span', 'spl-name', `${item.title}.txt`));
    if (item.by) row.append(el('span', 'spl-by', `🙋${item.by}`));
    return row;
  }));
  if (!p.video) {
    body.append(el('div', 'si-up', p.stage === 'discuss' ? '💬 在和观众聊刚才那条' : '⟳ 研究进行中…'));
    return;
  }
  const v = p.video;
  const stats = el('div', 'si-stats');
  for (const [label, value] of [['▶', v.view], ['👍', v.like], ['🪙', v.coin], ['⭐', v.favorite], ['💬', v.danmaku], ['⏱', v.duration]]) {
    const cell = el('span', '', `${label} `);
    cell.append(el('b', '', value));
    stats.append(cell);
  }
  body.append(el('div', 'si-title', v.title), el('div', 'si-up', `${v.up} · ${v.source}`), stats);
});
