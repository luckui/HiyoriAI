/** 设置面板各分区共用的 DOM 小工具 */

export function input(id: string): HTMLInputElement {
  return document.getElementById(id) as HTMLInputElement;
}

export function select(id: string): HTMLSelectElement {
  return document.getElementById(id) as HTMLSelectElement;
}

export function button(id: string): HTMLButtonElement {
  return document.getElementById(id) as HTMLButtonElement;
}

/** 👁 按钮：切换密码框明文/密文 */
export function bindPasswordToggle(inputId: string, buttonId: string): void {
  const btn = document.getElementById(buttonId);
  btn?.addEventListener('click', () => {
    const field = input(inputId);
    const reveal = field.type === 'password';
    field.type = reveal ? 'text' : 'password';
    btn.textContent = reveal ? '🙈' : '👁';
  });
}

/**
 * 按钮执行异步操作期间显示进度，完成后短暂显示结果再恢复原文字。
 * 成功时返回 true；失败时记录错误并返回 false。
 */
export async function runWithButton(
  btn: HTMLButtonElement,
  labels: { busy: string; done: string; failed: string },
  action: () => Promise<void>,
  resetAfterMs = 1800,
): Promise<boolean> {
  const idle = btn.textContent ?? '';
  btn.textContent = labels.busy;
  btn.disabled = true;
  let ok = true;
  try {
    await action();
    btn.textContent = labels.done;
  } catch (error) {
    ok = false;
    btn.textContent = labels.failed;
    console.error(`[Settings] ${labels.busy}`, error);
  }
  setTimeout(() => {
    btn.textContent = idle;
    btn.disabled = false;
  }, ok ? resetAfterMs : 2000);
  return ok;
}

/** 平台桥接在线状态：同时更新详情页的状态点与左侧列表的小圆点 */
export function renderBridgeStatus(prefix: 'dc' | 'fs' | 'wc', status: 'online' | 'offline'): void {
  const cls = status === 'online' ? 's-status-on' : 's-status-off';
  const dot = document.getElementById(`${prefix}-status-dot`);
  const listDot = document.getElementById(`${prefix}-list-dot`);
  const text = document.getElementById(`${prefix}-status-text`);
  if (dot) dot.className = `s-status-dot ${cls}`;
  if (listDot) listDot.className = `s-bridge-dot ${cls}`;
  if (text) text.textContent = status === 'online' ? '已连接' : '未启动';
}
