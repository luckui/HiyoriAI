/** 消息流渲染：对话气泡、"正在输入"指示器，以及往消息流里追加元素的公共逻辑 */

export function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

/** 今天显示 HH:mm，更早显示 M/D */
export function formatTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  const now = new Date();
  const isToday = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  if (isToday) return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

export function scrollToBottom(): void {
  const container = document.getElementById('messages-container');
  if (container) requestAnimationFrame(() => { container.scrollTop = container.scrollHeight; });
}

export function clearMessages(): void {
  const messages = document.getElementById('messages');
  if (messages) messages.innerHTML = '';
}

/**
 * 追加到消息流并滚到底部。animate 时下一帧再加 visible 类触发入场动画
 * （两层 rAF 保证初始样式已经渲染过一次，transition 才会生效）。
 */
export function appendToFeed(el: HTMLElement, animate = true, visibleClass = 'visible'): boolean {
  const messages = document.getElementById('messages');
  if (!messages) return false;
  messages.appendChild(el);
  if (animate) requestAnimationFrame(() => requestAnimationFrame(() => el.classList.add(visibleClass)));
  else el.classList.add(visibleClass);
  scrollToBottom();
  return true;
}

export function addMessage(type: 'ai' | 'user', content: string, animate = true, ts?: number): void {
  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${type === 'ai' ? 'ai-message' : 'user-message'}`;
  msgDiv.innerHTML = `
    ${type === 'ai' ? '<div class="message-avatar">🌸</div>' : ''}
    <div class="message-bubble">
      <p>${escapeHtml(content)}</p>
      <span class="message-time">${formatTime(ts)}</span>
    </div>`;
  appendToFeed(msgDiv, animate);
}

export function addTypingIndicator(): HTMLElement | null {
  const typing = document.createElement('div');
  typing.className = 'message ai-message typing-indicator';
  typing.innerHTML = `
    <div class="message-avatar">🌸</div>
    <div class="message-bubble">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>`;
  return appendToFeed(typing) ? typing : null;
}
