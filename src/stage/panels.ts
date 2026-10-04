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
