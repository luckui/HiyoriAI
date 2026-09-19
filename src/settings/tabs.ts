/** 设置面板的选项卡（窄窗口时溢出的选项卡收进"更多"下拉）与平台列表切换 */

import { hasUnsavedSettings, loadAllSections, saveDirtySections } from './sections';
import { showUnsavedSettingsDialog } from './dialog';

/** Tab 溢出重排回调（由 initTabOverflow 设置） */
let reflowTabs: (() => void) | null = null;
let navGuardOpen = false;

function initTabOverflow(): void {
  const strip   = document.getElementById('s-tabs-strip') as HTMLElement | null;
  const moreBtn = document.getElementById('s-tabs-more') as HTMLButtonElement | null;
  const dropdown = document.getElementById('s-tabs-dropdown') as HTMLElement | null;
  if (!strip || !moreBtn || !dropdown) return;

  moreBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.hidden = !dropdown.hidden;
  });

  document.addEventListener('click', (e) => {
    if (!moreBtn.contains(e.target as Node) && !dropdown.contains(e.target as Node)) {
      dropdown.hidden = true;
    }
  });

  function reflow(): void {
    const allTabs = Array.from(strip!.querySelectorAll<HTMLButtonElement>('.s-tab'));

    // Reset: show all tabs, hide more button + dropdown
    allTabs.forEach((t) => { t.style.display = ''; });
    moreBtn!.hidden = true;
    dropdown!.hidden = true;
    dropdown!.innerHTML = '';

    // Force layout flush
    void strip!.scrollWidth;

    if (strip!.scrollWidth <= strip!.clientWidth + 1) return;

    // Overflow detected — show more button
    moreBtn!.hidden = false;
    void moreBtn!.offsetWidth; // flush so strip narrows

    const stripRect = strip!.getBoundingClientRect();
    const overflowing: HTMLButtonElement[] = [];
    for (const tab of allTabs) {
      if (tab.getBoundingClientRect().right > stripRect.right + 1) {
        tab.style.display = 'none';
        overflowing.push(tab);
      }
    }

    if (overflowing.length === 0) {
      moreBtn!.hidden = true;
      return;
    }

    // Mirror active state onto more button
    const hasActiveOverflow = overflowing.some((t) => t.classList.contains('s-tab-active'));
    moreBtn!.classList.toggle('s-tab-active', hasActiveOverflow);

    // Build dropdown items
    for (const tab of overflowing) {
      const item = document.createElement('button');
      item.className = 's-tab-dropdown-item';
      if (tab.classList.contains('s-tab-active')) item.classList.add('s-tab-active');
      item.dataset['tab'] = tab.dataset['tab'];
      item.textContent = tab.textContent;
      item.addEventListener('click', () => {
        tab.click();
        dropdown!.hidden = true;
      });
      dropdown!.appendChild(item);
    }
  }

  reflowTabs = reflow;
  new ResizeObserver(reflow).observe(strip);
  reflow();
}


/** 有未保存修改时先询问保存还是放弃，再执行切换 */
async function confirmPendingChange(afterConfirm: () => void): Promise<void> {
  if (!hasUnsavedSettings()) {
    afterConfirm();
    return;
  }
  if (navGuardOpen) return;
  navGuardOpen = true;
  try {
    const action = await showUnsavedSettingsDialog({ body: '切换页面前，要保存刚才的修改吗？', saveText: '保存并切换' });
    if (action === 'save') await saveDirtySections();
    else await loadAllSections();
    afterConfirm();
  } finally {
    navGuardOpen = false;
  }
}

async function switchSettingsTab(target: string | undefined, tabBtn: HTMLButtonElement): Promise<void> {
  if (!target || tabBtn.classList.contains('s-tab-active')) return;
  await confirmPendingChange(() => {
    document.querySelectorAll<HTMLButtonElement>('.s-tab').forEach((b) => b.classList.toggle('s-tab-active', b === tabBtn));
    document.querySelectorAll<HTMLElement>('.s-tab-pane').forEach((pane) => {
      pane.classList.toggle('s-tab-pane-hidden', pane.id !== `s-tab-${target}`);
    });
    reflowTabs?.();
  });
}

async function switchBridgePane(bridge: string | undefined, item: HTMLElement): Promise<void> {
  if (!bridge || item.classList.contains('s-bridge-active')) return;
  await confirmPendingChange(() => {
    document.querySelectorAll<HTMLElement>('.s-bridge-item').forEach((el) => el.classList.toggle('s-bridge-active', el === item));
    document.querySelectorAll<HTMLElement>('.s-bridge-pane').forEach((pane) => {
      pane.classList.toggle('s-bridge-pane-hidden', pane.id !== `s-bridge-${bridge}`);
    });
  });
}

export function initTabs(): void {
  document.querySelectorAll<HTMLButtonElement>('.s-tab').forEach((tabBtn) => {
    tabBtn.addEventListener('click', () => void switchSettingsTab(tabBtn.dataset['tab'], tabBtn));
  });
  initTabOverflow();
  document.querySelectorAll<HTMLElement>('.s-bridge-item').forEach((item) => {
    item.addEventListener('click', () => void switchBridgePane(item.dataset['bridge'], item));
  });
}
