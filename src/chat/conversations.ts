/** 对话管理：当前对话、切换/新建/删除，以及对话列表面板 */

import { addMessage, clearMessages, escapeHtml, formatTime, scrollToBottom } from './messages';

let currentConversationId: string | null = null;
let convPanelOpen = false;

export function getCurrentConversationId(): string | null {
  return currentConversationId;
}

/** header 标题：未命名的新对话显示"在线" */
export async function refreshConvTitle(conversationId: string): Promise<void> {
  const conv = (await window.chatAPI!.listConversations()).find((c) => c.id === conversationId);
  const titleEl = document.getElementById('chat-conv-title');
  if (conv && titleEl) titleEl.textContent = conv.title === '新对话' ? '在线' : conv.title;
}

export async function switchConversation(id: string): Promise<void> {
  currentConversationId = id;
  clearMessages();
  const msgs = await window.chatAPI!.loadConversation(id);
  for (const msg of msgs) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      addMessage(msg.role === 'user' ? 'user' : 'ai', msg.content, false, msg.created_at);
    }
  }
  if (msgs.length === 0) addMessage('ai', '你好~！我是 Hiyori，很高兴认识你！✨', true);
  scrollToBottom();
  await refreshConvTitle(id);
  closeConvPanel();
}

export async function createNewConversation(): Promise<void> {
  const conv = await window.chatAPI!.createConversation();
  await switchConversation(conv.id);
}

async function deleteConversationById(id: string): Promise<void> {
  await window.chatAPI!.deleteConversation(id);
  if (id !== currentConversationId) {
    await renderConvList();
    return;
  }
  const [next] = await window.chatAPI!.listConversations();
  if (next) await switchConversation(next.id);
  else await createNewConversation();
}

/** 启动时打开的对话：优先有消息的，避免显示空白对话；一个都没有就新建 */
export async function openInitialConversation(): Promise<void> {
  const convs = await window.chatAPI!.listConversations();
  if (convs.length === 0) {
    await createNewConversation();
    return;
  }
  const withMessages = convs.find((c) => c.preview && c.preview.trim() !== '');
  await switchConversation((withMessages ?? convs[0]).id);
}

async function renderConvList(): Promise<void> {
  const listEl = document.getElementById('conv-list');
  if (!listEl) return;
  const convs = await window.chatAPI!.listConversations();
  if (convs.length === 0) {
    listEl.innerHTML = '<div class="conv-empty">暂无历史对话</div>';
    return;
  }

  listEl.innerHTML = '';
  for (const conv of convs) {
    const item = document.createElement('div');
    item.className = `conv-item${conv.id === currentConversationId ? ' active' : ''}`;
    item.dataset['id'] = conv.id;
    const preview = !conv.preview ? '（空对话）' : conv.preview.length > 32 ? conv.preview.slice(0, 32) + '…' : conv.preview;
    item.innerHTML = `
      <div class="conv-item-main">
        <span class="conv-item-title">${escapeHtml(conv.title)}</span>
        <span class="conv-item-time">${formatTime(conv.updated_at)}</span>
      </div>
      <div class="conv-item-preview">${escapeHtml(preview)}</div>
      <button class="conv-item-delete no-drag" title="删除" data-id="${conv.id}">×</button>
    `;
    item.addEventListener('click', (e) => {
      if ((e.target as HTMLElement).classList.contains('conv-item-delete')) return;
      void switchConversation(conv.id);
    });
    item.querySelector('.conv-item-delete')?.addEventListener('click', (e) => {
      e.stopPropagation();
      void deleteConversationById(conv.id);
    });
    listEl.appendChild(item);
  }
}

export function closeConvPanel(): void {
  convPanelOpen = false;
  document.getElementById('conv-panel')?.classList.remove('visible');
  document.getElementById('sessions-btn')?.classList.remove('active');
}

function toggleConvPanel(): void {
  if (convPanelOpen) {
    closeConvPanel();
    return;
  }
  convPanelOpen = true;
  document.getElementById('conv-panel')?.classList.add('visible');
  document.getElementById('sessions-btn')?.classList.add('active');
  void renderConvList();
}

export function initConversationControls(): void {
  document.getElementById('sessions-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleConvPanel();
  });
  document.getElementById('conv-new-btn')?.addEventListener('click', () => void createNewConversation());
}
