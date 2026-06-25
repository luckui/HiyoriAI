// =====================================================
// 类型声明
// =====================================================

import { playTTS } from './ttsPlayer';
import { startCapture, stopCapture, onTranscription } from './hearing';
import { initLive2DController, extractEmotionTag, triggerEmotion, notifyInteraction } from './live2dController';
import { LAppDelegate } from './lappdelegate';

console.log('[Chat] module loaded ✅ (带TTS版本)');

interface Conversation {
  id: string;
  title: string;
  created_at: number;
  updated_at: number;
  preview: string;
}

interface ChatMessage {
  id: string;
  conversation_id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  created_at: number;
}

declare global {
  interface Window {
    electronAPI?: {
      dragWindow: (dx: number, dy: number) => void;
      closeWindow: () => void;
      resizeWindow: (width: number, height: number) => void;
      togglePin: () => void;
      onPinState: (cb: (pinned: boolean) => void) => void;
    };
    chatAPI?: {
      createConversation(): Promise<Conversation>;
      listConversations(): Promise<Conversation[]>;
      loadConversation(id: string): Promise<ChatMessage[]>;
      deleteConversation(id: string): Promise<void>;
      renameConversation(id: string, title: string): Promise<void>;
      send(conversationId: string, content: string): Promise<{ content: string; created_at: number }>;
      stopAI?(): Promise<void>;
      /** 监听主进程注入的 AI 主动消息（来自后台任务完成通知） */
      onAgentMessage?(cb: (payload: { conversationId: string; content: string }) => void): () => void;
      /** 监听 background/batch 任务完成后的主对话 AI 唤醒（触发新轮工作流） */
      onWakeup?(cb: (payload: { conversationId: string; text: string }) => void): () => void;
    };
    appLifecycleAPI?: {
      onQuitting(cb: () => void): void;
      onQuitReady(cb: () => void): void;
    };
    debugAPI?: {
      onToolCall(cb: (ev: {
        name: string;
        args: Record<string, unknown>;
        result: string;
        ok: boolean;
        durationMs: number;
      }) => void): void;
    };
    ttsAPI?: {
      isEnabled(): Promise<boolean>;
      speak(text: string): Promise<{ data: string } | null>;
    };
  }
}

// =====================================================
// 状态
// =====================================================

let currentConversationId: string | null = null;
let isConvPanelOpen = false;
let isSending = false;

/** 聊天面板展开状态（模块级，供打字机气泡判断） */
let _chatExpanded = false;
/** 半身模式状态（模块级，供 updateChatLayout 计算界面大小） */
let _halfBody = false;
/** 窗口缩放比例（用户拖动右下角控制） */
let _scale = 1.0;
const BASE_W           = 360;  // 基础窗口宽度
const BASE_CANVAS_FULL = 360;  // 全身模式下 canvas 局面高度
const BASE_CANVAS_HALF = 220;  // 半身模式下 canvas 局面高度
const MIN_SCALE = 0.75;
const MAX_SCALE = 2.0;

/** 听觉系统实时状态 */
let hearingTranscriptionCount = 0;

// =====================================================
// 打字机气泡
// =====================================================

let _twTimer: ReturnType<typeof setTimeout> | null = null;
let _twFade: ReturnType<typeof setTimeout> | null = null;

/** 在 Live2D 画布上显示打字机效果气泡。durationMs = 展开全部文字所需毫秒。 */
export function showTypewriterBubble(text: string, durationMs: number): void {
  const overlay = document.getElementById('typewriter-overlay');
  const textEl  = document.getElementById('typewriter-text');
  if (!overlay || !textEl) return;

  // 清除旧定时器
  if (_twTimer) { clearTimeout(_twTimer); _twTimer = null; }
  if (_twFade)  { clearTimeout(_twFade);  _twFade  = null; }

  textEl.textContent = '';
  overlay.classList.add('visible');

  const chars = [...text];  // Unicode 安全拆分
  if (chars.length === 0) return;
  const perChar = Math.max(20, durationMs / chars.length);

  let i = 0;
  const tick = (): void => {
    if (i < chars.length) {
      textEl.textContent += chars[i++];
      _twTimer = setTimeout(tick, perChar);
    } else {
      // 全文展示完毕，3s 后淡出
      _twFade = setTimeout(dismissTypewriterBubble, 3000);
    }
  };
  _twTimer = setTimeout(tick, 0);
}

function dismissTypewriterBubble(): void {
  const overlay = document.getElementById('typewriter-overlay');
  overlay?.classList.remove('visible');
  if (_twTimer) { clearTimeout(_twTimer); _twTimer = null; }
  if (_twFade)  { clearTimeout(_twFade);  _twFade  = null; }
}

// =====================================================
// 工具函数
// =====================================================

function formatTime(ts?: number): string {
  const d = ts ? new Date(ts) : new Date();
  const now = new Date();
  const isToday =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (isToday) {
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  }
  return `${d.getMonth() + 1}/${d.getDate()}`;
}

function escapeHtml(str: string): string {
  const div = document.createElement('div');
  div.appendChild(document.createTextNode(str));
  return div.innerHTML;
}

function scrollToBottom(): void {
  const container = document.getElementById('messages-container');
  if (container) {
    requestAnimationFrame(() => {
      container.scrollTop = container.scrollHeight;
    });
  }
}

// =====================================================
// 消息渲染
// =====================================================

function addMessage(
  type: 'ai' | 'user',
  content: string,
  animate = true,
  ts?: number
): void {
  const messagesDiv = document.getElementById('messages');
  if (!messagesDiv) return;

  const msgDiv = document.createElement('div');
  msgDiv.className = `message ${type === 'ai' ? 'ai-message' : 'user-message'}`;

  if (type === 'ai') {
    msgDiv.innerHTML = `
      <div class="message-avatar">🌸</div>
      <div class="message-bubble">
        <p>${escapeHtml(content)}</p>
        <span class="message-time">${formatTime(ts)}</span>
      </div>`;
  } else {
    msgDiv.innerHTML = `
      <div class="message-bubble">
        <p>${escapeHtml(content)}</p>
        <span class="message-time">${formatTime(ts)}</span>
      </div>`;
  }

  messagesDiv.appendChild(msgDiv);

  if (animate) {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        msgDiv.classList.add('visible');
      });
    });
  } else {
    msgDiv.classList.add('visible');
  }

  scrollToBottom();
}

function addTypingIndicator(): HTMLElement | null {
  const messagesDiv = document.getElementById('messages');
  if (!messagesDiv) return null;

  const typing = document.createElement('div');
  typing.className = 'message ai-message typing-indicator';
  typing.innerHTML = `
    <div class="message-avatar">🌸</div>
    <div class="message-bubble">
      <span class="dot"></span>
      <span class="dot"></span>
      <span class="dot"></span>
    </div>`;
  messagesDiv.appendChild(typing);

  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      typing.classList.add('visible');
    });
  });

  scrollToBottom();
  return typing;
}

// =====================================================
// Todo 清单管理
// =====================================================

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

let currentTodoList: TodoItem[] = [];
let isTodoCollapsed = false;

/** 从 todo 工具的文本结果中解析任务列表（读取模式时使用） */
function parseTodoFromResult(resultText: string): TodoItem[] {
  const items: TodoItem[] = [];
  const lines = resultText.split('\n');
  for (const line of lines) {
    // 匹配格式：[>] id. content 或 [x] id. content 等
    const m = line.match(/\[([ x>~?])\]\s+(\S+)\.\s+(.+)/);
    if (!m) continue;
    const marker = m[1];
    const id = m[2];
    const content = m[3].trim();
    let status: TodoItem['status'] = 'pending';
    if (marker === '>') status = 'in_progress';
    else if (marker === 'x') status = 'completed';
    else if (marker === '~') status = 'cancelled';
    items.push({ id, content, status });
  }
  return items;
}

function updateTodoPanel(todoList: TodoItem[]): void {
  currentTodoList = todoList;
  const panel = document.getElementById('todo-panel');
  const listDiv = document.getElementById('todo-list');
  if (!panel || !listDiv) return;

  // 如果任务列表为空，隐藏面板
  if (todoList.length === 0) {
    panel.style.display = 'none';
    return;
  }

  // 显示面板并渲染任务列表
  panel.style.display = 'block';
  listDiv.innerHTML = '';

  for (const item of todoList) {
    const itemDiv = document.createElement('div');
    // CSS class 用连字符（in-progress），数据用下划线（in_progress）
    const statusClass = item.status.replace(/_/g, '-');
    itemDiv.className = `todo-item ${statusClass}`;
    
    let icon = '⭕';
    if (item.status === 'completed') icon = '✅';
    else if (item.status === 'in_progress') icon = '🔄';
    else if (item.status === 'cancelled') icon = '❌';
    
    itemDiv.innerHTML = `
      <span class="todo-icon">${icon}</span>
      <span class="todo-text">${escapeHtml(item.content)}</span>
    `;
    
    listDiv.appendChild(itemDiv);
  }

  // 自动关闭：所有任务都完成或取消时，3秒后自动关闭
  const allDone = todoList.every(item => item.status === 'completed' || item.status === 'cancelled');
  if (allDone) {
    setTimeout(() => {
      if (panel.style.display !== 'none') {
        panel.style.display = 'none';
      }
    }, 3000);
  }
}

// =====================================================
// 工具调用调试气泡
// =====================================================

function addToolCallBubble(ev: {
  name: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
  durationMs: number;
  conversationId?: string;  // 🆕 工具调用来源对话ID
}): void {
  const messagesDiv = document.getElementById('messages');
  if (!messagesDiv) return;

  // 🆕 如果工具调用来自其他对话，显示警告标签
  const isOtherConv = ev.conversationId && ev.conversationId !== currentConversationId;
  const convTag = isOtherConv ? `<span style="color:#ff6b6b; font-size:10px;">[其他对话]</span> ` : '';

  const icon   = ev.ok ? '✅' : ev.result.startsWith('⏸️') ? '⏸️' : '❌';
  const status = ev.ok ? 'ok' : ev.result.startsWith('⏸️') ? 'pause' : 'err';

  // 精简参数展示：只展示值，不要键名嵌套
  let argsText = '';
  try {
    const vals = Object.values(ev.args);
    argsText = vals.length ? vals.map(v => JSON.stringify(v)).join(', ') : '（无参数）';
  } catch {
    argsText = JSON.stringify(ev.args);
  }

  const bubble = document.createElement('div');
  bubble.className = 'tool-call-bubble';
  bubble.innerHTML = `
    <details>
      <summary>
        <span class="tc-icon">${icon}</span>
        <span class="tc-name">${convTag}${escapeHtml(ev.name)}</span>
        <span class="tc-args">${escapeHtml(argsText.slice(0, 60))}${argsText.length > 60 ? '…' : ''}</span>
        <span class="tc-duration tc-${status}">${ev.durationMs}ms</span>
      </summary>
      <div class="tc-detail">
        <div class="tc-row"><span class="tc-label">参数</span><span class="tc-val">${escapeHtml(JSON.stringify(ev.args, null, 2))}</span></div>
        <div class="tc-row"><span class="tc-label">结果</span><span class="tc-val">${escapeHtml(ev.result)}</span></div>
      </div>
    </details>`;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => bubble.classList.add('visible'));
  });

  messagesDiv.appendChild(bubble);
  scrollToBottom();
}

// =====================================================
// 终端块（Terminal Block）— 实时展示命令执行进度
// =====================================================

/** 活跃的终端块 Map（blockId → DOM 元素） */
const activeTerminalBlocks = new Map<string, {
  container: HTMLElement;
  body: HTMLElement;
  statusEl: HTMLElement;
  copyBtn: HTMLButtonElement;
}>();

async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Fall through to the legacy copy path.
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', 'true');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.select();

  try {
    return document.execCommand('copy');
  } finally {
    document.body.removeChild(textarea);
  }
}

/**
 * 创建或追加终端块内容
 */
function handleTerminalBlock(ev: {
  blockId: string;
  line?: string;
  status?: 'running' | 'idle' | 'done' | 'error';
  title?: string;
}): void {
  const messagesDiv = document.getElementById('messages');
  if (!messagesDiv) return;

  let block = activeTerminalBlocks.get(ev.blockId);

  // 首次创建
  if (!block) {
    const container = document.createElement('div');
    container.className = 'terminal-block';

    const header = document.createElement('div');
    header.className = 'terminal-block-header';

    const statusEl = document.createElement('span');
    statusEl.className = 'tb-status tb-status-running';
    statusEl.textContent = '运行中';

    const copyBtn = document.createElement('button');
    copyBtn.className = 'tb-copy-btn';
    copyBtn.type = 'button';
    copyBtn.textContent = '复制';
    copyBtn.title = '复制终端输出';

    header.innerHTML = `
      <span class="tb-icon">⚙️</span>
      <span class="tb-title">${escapeHtml(ev.title || '终端')}</span>
    `;
    header.appendChild(statusEl);
    header.appendChild(copyBtn);

    const body = document.createElement('div');
    body.className = 'terminal-block-body';

    // 点击 header 折叠/展开
    header.addEventListener('click', () => {
      body.classList.toggle('collapsed');
    });

    copyBtn.addEventListener('click', async (event) => {
      event.stopPropagation();
      const text = body.innerText.trim();
      if (!text) return;

      const ok = await copyTextToClipboard(text);
      copyBtn.textContent = ok ? '已复制' : '复制失败';
      window.setTimeout(() => {
        copyBtn.textContent = '复制';
      }, 1200);
    });

    container.appendChild(header);
    container.appendChild(body);
    messagesDiv.appendChild(container);

    requestAnimationFrame(() => {
      requestAnimationFrame(() => container.classList.add('visible'));
    });

    block = { container, body, statusEl, copyBtn };
    activeTerminalBlocks.set(ev.blockId, block);
  }

  // 追加行
  if (ev.line) {
    const lineEl = document.createElement('div');
    lineEl.className = 'terminal-block-line';

    // 智能识别行类型
    const trimmed = ev.line.trim();
    if (trimmed.startsWith('$') || trimmed.startsWith('>')) {
      lineEl.className += ' cmd';
      lineEl.textContent = trimmed.replace(/^\$\s*/, '').replace(/^>\s*/, '');
    } else if (trimmed.startsWith('✅') || trimmed.startsWith('✓')) {
      lineEl.className += ' ok';
      lineEl.textContent = trimmed;
    } else if (trimmed.startsWith('❌') || trimmed.startsWith('✗')) {
      lineEl.className += ' err';
      lineEl.textContent = trimmed;
    } else {
      lineEl.textContent = trimmed;
    }

    block.body.appendChild(lineEl);
    // 自动滚动到最新行
    block.body.scrollTop = block.body.scrollHeight;
  }

  // 更新状态
  if (ev.status) {
    block.statusEl.className = `tb-status tb-status-${ev.status}`;
    switch (ev.status) {
      case 'running':
        block.statusEl.textContent = '运行中';
        break;
      case 'idle':
        block.statusEl.textContent = '本轮完成';
        break;
      case 'done':
        block.statusEl.textContent = '完成';
        // 完成后从活跃 map 移除
        activeTerminalBlocks.delete(ev.blockId);
        break;
      case 'error':
        block.statusEl.textContent = '失败';
        activeTerminalBlocks.delete(ev.blockId);
        break;
    }
  }

  scrollToBottom();
}

// =====================================================
// 听觉系统 UI（指示器 + 转录流 + 自动发送）
// =====================================================

/**
 * 创建并显示听觉指示器条（固定在 input-area 上方）
 * 包含：脉冲点 + 正在聆听 + 最新转录预览 + 模式标签 + 计数
 */
function showHearingIndicator(mode: string, source: string): void {
  removeHearingIndicator();

  const chatView = document.getElementById('chat-view');
  if (!chatView) return;

  const modeLabels: Record<string, string> = {
    dictation: '语音输入', passive: '陪伴监听', summary: '总结',
  };
  const sourceLabels: Record<string, string> = {
    mic: '麦克风', system: '系统音频', both: '全部',
  };

  const indicator = document.createElement('div');
  indicator.id = 'hearing-indicator';
  indicator.className = 'hearing-indicator';

  indicator.innerHTML = `
    <div class="hearing-ind-left">
      <span class="hearing-pulse-dot"></span>
      <span class="hearing-ind-label">正在聆听</span>
      <span class="hearing-ind-latest" id="hearing-latest-text">${escapeHtml(sourceLabels[source] ?? source)}</span>
    </div>
    <div class="hearing-ind-right">
      <span class="hearing-mode-badge ${escapeHtml(mode)}">${escapeHtml(modeLabels[mode] ?? mode)}</span>
      <span class="hearing-ind-count" id="hearing-count">0 条</span>
    </div>`;

  chatView.appendChild(indicator);

  // 延迟添加 active 类触发入场动画
  requestAnimationFrame(() => {
    requestAnimationFrame(() => indicator.classList.add('active'));
  });
}

/** 移除听觉指示器 */
function removeHearingIndicator(): void {
  const el = document.getElementById('hearing-indicator');
  if (el) {
    el.classList.remove('active');
    // 等动画结束再移除 DOM
    setTimeout(() => el.remove(), 200);
  }
  hearingTranscriptionCount = 0;
}

/** 更新指示器：最新文本 + 计数 */
function updateHearingIndicator(text: string): void {
  hearingTranscriptionCount++;
  const latestEl = document.getElementById('hearing-latest-text');
  const countEl = document.getElementById('hearing-count');
  if (latestEl) {
    const preview = text.length > 35 ? text.slice(0, 35) + '…' : text;
    latestEl.textContent = `"${preview}"`;
    latestEl.title = text;
  }
  if (countEl) {
    countEl.textContent = `${hearingTranscriptionCount} 条`;
  }
}

/** 在消息流中添加一条转录气泡 */
function addTranscriptionBubble(text: string, language: string): void {
  const messagesDiv = document.getElementById('messages');
  if (!messagesDiv) return;

  const bubble = document.createElement('div');
  bubble.className = 'transcription-bubble';

  const time = new Date();
  const timeStr = `${String(time.getHours()).padStart(2, '0')}:${String(time.getMinutes()).padStart(2, '0')}:${String(time.getSeconds()).padStart(2, '0')}`;

  bubble.innerHTML = `
    <div class="transcription-bubble-inner">
      <span class="tb-ear">👂</span>
      <span class="tb-text">${escapeHtml(text)}</span>
      <span class="tb-meta">
        <span class="tb-lang">${escapeHtml(language)}</span>
        <span class="tb-time">${timeStr}</span>
      </span>
    </div>`;

  requestAnimationFrame(() => {
    requestAnimationFrame(() => bubble.classList.add('visible'));
  });

  messagesDiv.appendChild(bubble);
  scrollToBottom();

  // 超过 50 条转写气泡时移除旧的
  const allBubbles = messagesDiv.querySelectorAll('.transcription-bubble');
  if (allBubbles.length > 50) {
    allBubbles[0].remove();
  }
}

/**
 * 自动发送消息（听写模式 / 总结模式触发）
 * 与手动 sendMessage 共享同一套显示逻辑
 */
async function autoSendMessage(text: string, type: 'dictation' | 'summary'): Promise<void> {
  if (!currentConversationId) return;
  if (isSending) return; // 不打断正在进行的对话

  // 语音输入 = 用户交互，重置 bored 计时器
  notifyInteraction();

  const content = type === 'summary'
    ? `请帮我总结以下听到的内容：\n\n${text}`
    : text;

  addMessage('user', content);
  const typing = addTypingIndicator();
  isSending = true;

  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  if (sendBtn) {
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2"/>
      </svg>`;
  }

  try {
    const result = await window.chatAPI!.send(currentConversationId, content);
    typing?.remove();

    // 自动解析 AI 回复中的情绪标签 [emotion:xxx]
    const { emotion, cleaned: displayText } = extractEmotionTag(result.content);
    if (emotion) {
      // 通过状态机触发：表情+对应情绪动作，SPEAKING 状态下仅改表情不打断动作
      triggerEmotion(emotion);
    }

    addMessage('ai', displayText, true, result.created_at);
    // 折叠时显示打字机气泡（TTS 开启时等真实时长，避免二次重播）
    if (!_chatExpanded) {
      const ttsEnabled = await window.ttsAPI?.isEnabled().catch(() => false) ?? false;
      if (!ttsEnabled) showTypewriterBubble(displayText, displayText.length * 60);
    }
    playTTS(displayText, (actualMs, sentenceText) => {
      if (!_chatExpanded) {
        if (actualMs > 0) {
          // 每句播放前调用：显示当句文本+当句音频时长
          showTypewriterBubble(sentenceText ?? displayText, Math.max(300, actualMs * 0.92));
        } else {
          // TTS 服务不可达：回退到全文估算速度
          showTypewriterBubble(displayText, displayText.length * 60);
        }
      }
    }).catch((e) => console.error('[TTS] playTTS error:', e));
    await refreshConvTitle(currentConversationId);
  } catch (e) {
    typing?.remove();
    const errMsg = (e as Error).message;
    if (errMsg.includes('aborted') || errMsg.includes('stopped')) {
      addMessage('ai', '（已停止回答）');
    } else {
      addMessage('ai', `（出错了：${errMsg}）`);
    }
  } finally {
    isSending = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>`;
    }
  }
}

// =====================================================
// 发送消息
// =====================================================

let isStopMode = false; // 是否处于可停止状态

async function sendMessage(): Promise<void> {
  if (!currentConversationId) return;
  
  const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
  
  // 如果已经在发送中，点击表示停止
  if (isSending) {
    console.log('[Chat] 用户请求停止AI回答');
    await (window as any).chatAPI?.stopAI?.();
    // 恢复按钮状态
    isSending = false;
    isStopMode = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>`;
    }
    return;
  }

  const input = document.getElementById('message-input') as HTMLTextAreaElement;
  const text = input?.value.trim();
  if (!text) return;

  // 用户发送消息：通知状态机退出 BORED，重置无聊计时器
  notifyInteraction();

  input.value = '';
  isSending = true;
  isStopMode = true;
  
  // 切换为停止按钮
  if (sendBtn) {
    sendBtn.classList.add('stop-mode');
    sendBtn.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <rect x="6" y="6" width="12" height="12" rx="2"/>
      </svg>`;
  }

  addMessage('user', text);
  const typing = addTypingIndicator();

  try {
    const result = await window.chatAPI!.send(currentConversationId, text);
    typing?.remove();

    // 与 autoSendMessage 保持一致：通过状态机触发情绪+动作
    const { emotion: sendEmotion, cleaned: sendDisplayText } = extractEmotionTag(result.content);
    if (sendEmotion) {
      triggerEmotion(sendEmotion);
    }

    addMessage('ai', sendDisplayText, true, result.created_at);
    // 折叠时显示打字机气泡（TTS 开启时等真实时长，避免二次重播）
    if (!_chatExpanded) {
      const ttsEnabled = await window.ttsAPI?.isEnabled().catch(() => false) ?? false;
      if (!ttsEnabled) showTypewriterBubble(sendDisplayText, sendDisplayText.length * 60);
    }
    // TTS 播放（未启用时静默跳过）
    console.log('[Chat] 准备调用 playTTS, 文本长度:', sendDisplayText.length);
    playTTS(sendDisplayText, (actualMs, sentenceText) => {
      if (!_chatExpanded) {
        if (actualMs > 0) {
          showTypewriterBubble(sentenceText ?? sendDisplayText, Math.max(300, actualMs * 0.92));
        } else {
          showTypewriterBubble(sendDisplayText, sendDisplayText.length * 60);
        }
      }
    }).catch((e) => console.error('[TTS] playTTS 抛出异常:', e));
    // 首轮发送后 AI 服务会自动重命名对话，刷新 header 标题
    await refreshConvTitle(currentConversationId);
  } catch (e) {
    typing?.remove();
    const errMsg = (e as Error).message;
    if (errMsg.includes('aborted') || errMsg.includes('stopped')) {
      addMessage('ai', '（已停止回答）');
    } else {
      addMessage('ai', `（出错了：${errMsg}）`);
    }
  } finally {
    isSending = false;
    isStopMode = false;
    if (sendBtn) {
      sendBtn.disabled = false;
      sendBtn.classList.remove('stop-mode');
      sendBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
          <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
        </svg>`;
    }
    input?.focus();
  }
}

// =====================================================
// 对话管理
// =====================================================

async function refreshConvTitle(conversationId: string): Promise<void> {
  const convs = await window.chatAPI!.listConversations();
  const conv = convs.find((c) => c.id === conversationId);
  if (!conv) return;

  const statusEl = document.getElementById('chat-conv-title');
  if (statusEl) {
    statusEl.textContent = conv.title === '新对话' ? '在线' : conv.title;
  }
}

async function switchConversation(id: string): Promise<void> {
  currentConversationId = id;

  const messagesDiv = document.getElementById('messages');
  if (messagesDiv) messagesDiv.innerHTML = '';

  const msgs = await window.chatAPI!.loadConversation(id);
  for (const msg of msgs) {
    if (msg.role === 'user' || msg.role === 'assistant') {
      addMessage(msg.role === 'user' ? 'user' : 'ai', msg.content, false, msg.created_at);
    }
  }

  if (msgs.length === 0) {
    addMessage('ai', '你好~！我是 Hiyori，很高兴认识你！✨', true);
  }

  scrollToBottom();
  await refreshConvTitle(id);
  closeConvPanel();
}

async function createNewConversation(): Promise<void> {
  const conv = await window.chatAPI!.createConversation();
  await switchConversation(conv.id);
}

async function deleteConversationById(id: string): Promise<void> {
  await window.chatAPI!.deleteConversation(id);

  if (id === currentConversationId) {
    const remaining = await window.chatAPI!.listConversations();
    if (remaining.length > 0) {
      await switchConversation(remaining[0].id);
    } else {
      await createNewConversation();
    }
  } else {
    await renderConvList();
  }
}

// =====================================================
// 对话列表面板
// =====================================================

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

    const preview = conv.preview
      ? conv.preview.length > 32
        ? conv.preview.slice(0, 32) + '…'
        : conv.preview
      : '（空对话）';

    item.innerHTML = `
      <div class="conv-item-main">
        <span class="conv-item-title">${escapeHtml(conv.title)}</span>
        <span class="conv-item-time">${formatTime(conv.updated_at)}</span>
      </div>
      <div class="conv-item-preview">${escapeHtml(preview)}</div>
      <button class="conv-item-delete no-drag" title="删除" data-id="${conv.id}">×</button>
    `;

    item.addEventListener('click', async (e) => {
      if ((e.target as HTMLElement).classList.contains('conv-item-delete')) return;
      await switchConversation(conv.id);
    });

    const delBtn = item.querySelector('.conv-item-delete') as HTMLButtonElement;
    delBtn.addEventListener('click', async (e) => {
      e.stopPropagation();
      await deleteConversationById(conv.id);
    });

    listEl.appendChild(item);
  }
}

function openConvPanel(): void {
  isConvPanelOpen = true;
  document.getElementById('conv-panel')?.classList.add('visible');
  document.getElementById('sessions-btn')?.classList.add('active');
  renderConvList();
}

function closeConvPanel(): void {
  isConvPanelOpen = false;
  document.getElementById('conv-panel')?.classList.remove('visible');
  document.getElementById('sessions-btn')?.classList.remove('active');
}

function toggleConvPanel(): void {
  isConvPanelOpen ? closeConvPanel() : openConvPanel();
}

// =====================================================
// 折叠/展开
// =====================================================

// CSS transition 时长，与 style.css 中 #chat-body 的 transition 保持一致
const CHAT_BODY_H             = 280;
const CHAT_BODY_TRANSITION_MS = 350;

/** 设置 canvas-container 高度 CSS 变量（始终用全身高度，半身模式只缩放内容） */
function setCanvasHeight(): void {
  const px = Math.round(BASE_CANVAS_FULL * _scale);
  document.documentElement.style.setProperty('--canvas-h', `${px}px`);
}

/** 瞬时更新窗口大小（供缩放抓手使用） */
function updateChatLayout(isExpanded: boolean): void {
  setCanvasHeight();
  const headerH   = document.getElementById('chat-header')?.offsetHeight ?? 50;
  const inputH    = document.getElementById('input-area')?.offsetHeight ?? 54;
  const chatBodyH = isExpanded ? CHAT_BODY_H : 0;
  const w = Math.round(BASE_W * _scale);
  // canvas 按 scale 缩放，header/chatBody/input 保持原始像素
  const h = Math.round(BASE_CANVAS_FULL * _scale) + headerH + chatBodyH + inputH;
  window.electronAPI?.resizeWindow(w, h);
}

/**
 * 折叠/展开动画。
 * canvas-container 高度由 CSS var 固定，不参与动画。
 * chat-body 用 CSS transition 滑入/滑出，窗口在动画结束后调整。
 * 展开时先扩大窗口（给 chat-body 留空间），收起时等动画完成再缩小。
 */
function toggleChatPanel(expanding: boolean): void {
  const chatBody   = document.getElementById('chat-body');
  const toggleIcon = document.getElementById('toggle-icon');
  if (!chatBody || !toggleIcon) return;

  setCanvasHeight();
  const headerH    = document.getElementById('chat-header')?.offsetHeight ?? 50;
  const inputH     = document.getElementById('input-area')?.offsetHeight ?? 54;
  const w          = Math.round(BASE_W * _scale);
  const canvasPx   = Math.round(BASE_CANVAS_FULL * _scale);
  // canvas 按 scale 缩放，header/input 保持原始像素
  const collapsedH = canvasPx + headerH + inputH;
  const expandedH  = canvasPx + headerH + CHAT_BODY_H + inputH;

  if (expanding) {
    // 先扩大窗口，chat-body 有空间滑入
    window.electronAPI?.resizeWindow(w, expandedH);
    requestAnimationFrame(() => {
      chatBody.classList.remove('collapsed');
      toggleIcon.textContent = '▾';
    });
  } else {
    // 先让 CSS 动画跑完，再缩小窗口
    chatBody.classList.add('collapsed');
    toggleIcon.textContent = '▴';
    closeConvPanel();
    setTimeout(() => {
      window.electronAPI?.resizeWindow(w, collapsedH);
    }, CHAT_BODY_TRANSITION_MS);
  }
}

// =====================================================
// 窗口拖动
// =====================================================

function setupWindowDrag(): void {
  let isDragging = false;
  let lastX = 0;
  let lastY = 0;
  let startX = 0;
  let startY = 0;

  const canvasContainer = document.getElementById('canvas-container');

  canvasContainer?.addEventListener('mousedown', (e: MouseEvent) => {
    if ((e.target as HTMLElement).closest('.no-drag')) return;
    if (e.button !== 0) return;
    // 不调 preventDefault，否则会干扰 Live2D 的 pointer 事件链
    isDragging = false; // 先不设为 true，等实际移动后才设
    lastX = e.screenX;
    lastY = e.screenY;
    startX = e.screenX;
    startY = e.screenY;
  });

  document.addEventListener('mousemove', (e: MouseEvent) => {
    if (lastX === 0 && lastY === 0) return;
    const moved = Math.abs(e.screenX - startX) + Math.abs(e.screenY - startY);
    if (!isDragging && moved > 4) {
      // 移动超过 4px 才认为拖拽，不是点击
      isDragging = true;
    }
    if (!isDragging) return;
    window.electronAPI?.dragWindow(e.screenX - lastX, e.screenY - lastY);
    lastX = e.screenX;
    lastY = e.screenY;
  });

  document.addEventListener('mouseup', () => {
    isDragging = false;
    lastX = 0;
    lastY = 0;
  });
}

// =====================================================
// 窗口缩放抓柄
// =====================================================

function setupResizeGrip(): void {
  const grip = document.getElementById('resize-grip');
  if (!grip) return;

  let isResizing = false;
  let startX    = 0;
  let startScale = 1.0;

  // 用 Pointer Capture 锁定事件：鼠标离开窗口后仍能继续收到 pointermove
  // 这是缩小时光标跑到窗口外仍能工作的关键
  grip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    isResizing = true;
    startX     = e.screenX;
    startScale = _scale;
    grip.setPointerCapture(e.pointerId);

  });

  grip.addEventListener('pointermove', (e) => {
    if (!isResizing) return;
    const delta = (e.screenX - startX) / 250;
    const newScale = Math.max(MIN_SCALE, Math.min(MAX_SCALE, startScale + delta));

    _scale = newScale;
    updateChatLayout(_chatExpanded);
  });

  grip.addEventListener('pointerup', () => { isResizing = false; });
  grip.addEventListener('pointercancel', () => { isResizing = false; });
}

// =====================================================
// 初始化入口
// =====================================================
export async function initChat(): Promise<void> {
  setupWindowDrag();
  setupResizeGrip();

  // 等 DOM layout 完成后再修正窗口尺寸，确保 offsetHeight 可读
  requestAnimationFrame(() => {
    // 默认折叠：同步 DOM 初始状态
    if (!_chatExpanded) {
      document.getElementById('chat-body')?.classList.add('collapsed');
      const icon = document.getElementById('toggle-icon');
      if (icon) icon.textContent = '▴';
    }
    updateChatLayout(_chatExpanded);
  });

  // 初始化 Live2D IPC 控制器（接收主进程情绪/动作命令）
  initLive2DController();

  // 折叠/展开
  document.getElementById('toggle-chat-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _chatExpanded = !_chatExpanded;
    if (_chatExpanded) dismissTypewriterBubble();
    toggleChatPanel(_chatExpanded);
  });

  // 半身/全身切换：只改变 Live2D 渲染层，窗口/canvas 尺寸不变
  document.getElementById('view-mode-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    _halfBody = !_halfBody;
    const icon = document.getElementById('view-mode-icon');
    if (icon) icon.textContent = _halfBody ? '半' : '全';
    LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().setHalfBodyMode(_halfBody);
  });

  // 关闭窗口
  document.getElementById('close-btn')?.addEventListener('click', () => {
    window.electronAPI?.closeWindow();
  });

  // 对话列表面板
  document.getElementById('sessions-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleConvPanel();
  });

  // Agent 模式切换器
  let isAgentMode = true; // 默认 Agent 模式
  const agentModeBtn = document.getElementById('agent-mode-btn');
  const agentModeText = document.getElementById('agent-mode-text');
  
  // 更新 UI 的通用函数
  function updateAgentModeUI(mode: string) {
    const isAgent = mode === 'agent' || mode === 'agent-debug' || mode === 'developer';
    isAgentMode = isAgent;
    
    if (agentModeText) {
      if (mode === 'agent-debug') {
        agentModeText.textContent = 'Debug';
      } else if (mode === 'developer') {
        agentModeText.textContent = 'Dev';
      } else {
        agentModeText.textContent = isAgent ? 'Agent' : 'Chat';
      }
    }
    
    if (agentModeBtn) {
      if (isAgent) {
        agentModeBtn.classList.add('active');
      } else {
        agentModeBtn.classList.remove('active');
      }
    }
  }
  
  // 初始化显示为 Agent 模式
  updateAgentModeUI('agent');

  // 用户点击按钮切换
  agentModeBtn?.addEventListener('click', async (e) => {
    e.stopPropagation();
    // 循环切换：chat -> agent -> agent-debug -> developer -> chat
    let newMode = 'agent';
    if (agentModeText?.textContent === 'Chat') {
      newMode = 'agent';
    } else if (agentModeText?.textContent === 'Agent') {
      newMode = 'agent-debug';
    } else if (agentModeText?.textContent === 'Debug') {
      newMode = 'developer';
    } else if (agentModeText?.textContent === 'Dev') {
      newMode = 'chat';
    }
    
    // 发送 IPC 切换模式
    await (window as any).agentAPI?.setMode(newMode);
    console.log(`[Agent Mode] 用户切换到 ${newMode.toUpperCase()} 模式`);
    
    // 更新 UI
    updateAgentModeUI(newMode);
  });

  // 监听 AI 主动切换模式
  (window as any).agentAPI?.onModeChanged((mode: string) => {
    console.log(`[Agent Mode] AI 切换到 ${mode.toUpperCase()} 模式`);
    updateAgentModeUI(mode);
  });

  // 监听 AI 主动切换模式
  (window as any).agentAPI?.onModeChanged((mode: string) => {
    console.log(`[Agent Mode] AI 切换到 ${mode.toUpperCase()} 模式`);
    updateAgentModeUI(mode);
  });

  // 新建对话（header 按钮）
  document.getElementById('new-chat-btn')?.addEventListener('click', (e) => {
    e.stopPropagation();
    createNewConversation();
  });

  // 新建对话（conv-panel 内按钮）
  document.getElementById('conv-new-btn')?.addEventListener('click', () => {
    createNewConversation();
  });

  // 发送消息
  document.getElementById('send-btn')?.addEventListener('click', () => sendMessage());

  const input = document.getElementById('message-input') as HTMLTextAreaElement;
  input?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  input?.addEventListener('mousedown', (e) => e.stopPropagation());

  // 监听 input-area 高度变化，动态调整 Electron 窗口高度
  // 这样 textarea 多行时窗口向下扩展，不影响 canvas 位置也不破坏折叠动画
  const inputAreaEl = document.getElementById('input-area');
  if (inputAreaEl && typeof ResizeObserver !== 'undefined') {
    let _prevInputH = inputAreaEl.offsetHeight;
    const _inputRO = new ResizeObserver(() => {
      const newH = inputAreaEl.offsetHeight;
      if (newH !== _prevInputH) {
        _prevInputH = newH;
        updateChatLayout(_chatExpanded);
      }
    });
    _inputRO.observe(inputAreaEl);
  }

  // 加载或创建初始对话
  const convs = await window.chatAPI!.listConversations();
  if (convs.length > 0) {
    // 优先加载有消息的对话，避免启动时显示空白对话
    const convWithMessages = convs.find(c => c.preview && c.preview.trim() !== '');
    await switchConversation((convWithMessages || convs[0]).id);
  } else {
    const conv = await window.chatAPI!.createConversation();
    await switchConversation(conv.id);
  }

  // ── 退出保存遮罩 ──────────────────────────────────────────
  const quitOverlay = document.getElementById('quit-overlay');
  window.appLifecycleAPI?.onQuitting(() => {
    quitOverlay?.classList.add('visible');
  });
  window.appLifecycleAPI?.onQuitReady(() => {
    // 短暂显示"完成"后窗口即关闭，给用户一个积极的视觉收尾
    const title = quitOverlay?.querySelector('.quit-title');
    const hint  = quitOverlay?.querySelector('.quit-hint');
    if (title) (title as HTMLElement).textContent = '记忆已保存 ✓';
    if (hint)  (hint  as HTMLElement).textContent  = '再见，下次见到你要更厉害哦 ✨';
  });

  // ── 工具调用调试气泡：实时展示 AI 正在调用哪些工具 ──────────
  window.debugAPI?.onToolCall((ev) => {
    // 如果是 todo 工具，只更新 Todo 面板，不显示气泡
    if (ev.name === 'todo') {
      try {
        const todoList = ev.args.todos as TodoItem[] | undefined;
        if (Array.isArray(todoList) && todoList.length > 0) {
          updateTodoPanel(todoList);
        }
        // 读取模式（无 todos 参数）：从 result 文本解析任务列表
        if (!todoList && ev.result && ev.result.includes('[')) {
          const parsed = parseTodoFromResult(ev.result);
          if (parsed.length > 0) updateTodoPanel(parsed);
        }
      } catch (e) {
        console.error('[Todo] 解析失败:', e);
      }
      return; // 提前返回，不显示气泡
    }
    
    // 其他工具才显示工具调用气泡
    addToolCallBubble(ev);
  });

  // Todo 面板关闭按钮
  document.getElementById('todo-close-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('todo-panel');
    if (panel) panel.style.display = 'none';
  });

  // Todo 面板折叠/展开按钮
  document.getElementById('todo-toggle-btn')?.addEventListener('click', () => {
    const listDiv = document.getElementById('todo-list');
    const toggleBtn = document.getElementById('todo-toggle-btn');
    if (!listDiv || !toggleBtn) return;

    isTodoCollapsed = !isTodoCollapsed;
    if (isTodoCollapsed) {
      listDiv.classList.add('todo-list-collapsed');
      listDiv.classList.remove('todo-list-expanded');
      toggleBtn.classList.add('collapsed');
    } else {
      listDiv.classList.remove('todo-list-collapsed');
      listDiv.classList.add('todo-list-expanded');
      toggleBtn.classList.remove('collapsed');
    }
  });

  // ── 终端块事件（terminal-block） ──────────────────────────────
  window.hearingAPI?.onTerminalBlock((ev) => {
    handleTerminalBlock(ev);
  });

  // ── 听觉系统事件 ──────────────────────────────────────────────
  // 注册转写结果回调：更新指示器 + 添加气泡
  onTranscription((result) => {
    updateHearingIndicator(result.text);
    addTranscriptionBubble(result.text, result.language);
  });

  // 监听 main 进程通知 renderer 开始/停止音频捕获
  window.hearingAPI?.onStarted((ev) => {
    console.log('[Hearing] 收到启动通知, source:', ev.source, 'wsUrl:', ev.wsUrl, 'mode:', ev.mode);
    showHearingIndicator(ev.mode ?? 'passive', ev.source);
    startCapture(ev.wsUrl, ev.source as 'mic' | 'system' | 'both').catch((err) => {
      console.error('[Hearing] 启动音频捕获失败:', err);
      removeHearingIndicator();
      addTranscriptionBubble(`⚠ 音频捕获失败: ${(err as Error).message}`, 'error');
      // 通知 main 进程捕获失败，重置 active 状态
      window.hearingAPI?.reportCaptureFailed((err as Error).message);
    });
  });

  window.hearingAPI?.onStopped(() => {
    console.log('[Hearing] 收到停止通知');
    removeHearingIndicator();
    stopCapture();
  });

  // 听写/总结模式自动发送
  window.hearingAPI?.onAutoSend((ev) => {
    console.log(`[Hearing] 自动发送 (${ev.type}):`, ev.text.slice(0, 50));
    autoSendMessage(ev.text, ev.type);
  });

  // ── AI 主动消息注入（后台任务完成通知 / speak 工具）────────────
  window.chatAPI?.onAgentMessage?.((payload) => {
    // 仅当当前对话与通知对话一致时显示
    if (payload.conversationId !== currentConversationId) return;
    console.log('[Chat] 收到 AI 主动消息:', payload.content.slice(0, 60));
    addMessage('ai', payload.content, true, Date.now());
    // TTS 由 injectAgentMessage 在主进程侧独立触发，渲染层只负责显示气泡
    if (!_chatExpanded) {
      showTypewriterBubble(payload.content, payload.content.length * 60);
    }
  });

  // ── background/batch 异步任务完成 → 唤醒主对话 AI 继续工作流 ──────
  // （cron 定时任务不会进入此分支，它们由子智能体自己 speak 结果）
  window.chatAPI?.onWakeup?.((payload) => {
    if (payload.conversationId !== currentConversationId) return;
    if (isSending) return;
    console.log('[Chat] 异步任务完成，唤醒主对话 AI:', payload.text.slice(0, 60));

    isSending = true;
    const sendBtn = document.getElementById('send-btn') as HTMLButtonElement;
    if (sendBtn) {
      sendBtn.classList.add('stop-mode');
      sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>`;
    }
    const typing = addTypingIndicator();

    window.chatAPI!.send(payload.conversationId, payload.text)
      .then((result) => {
        typing?.remove();
        const { emotion, cleaned } = extractEmotionTag(result.content);
        if (emotion) triggerEmotion(emotion);
        addMessage('ai', cleaned, true, result.created_at);
        playTTS(cleaned, (actualMs, sentenceText) => {
          if (!_chatExpanded) {
            showTypewriterBubble(sentenceText ?? cleaned, actualMs > 0 ? Math.max(300, actualMs * 0.92) : cleaned.length * 60);
          }
        }).catch((e) => console.error('[TTS] wakeup playTTS error:', e));
        void refreshConvTitle(payload.conversationId);
      })
      .catch((e) => {
        typing?.remove();
        const errMsg = (e as Error).message;
        if (!errMsg.includes('aborted') && !errMsg.includes('stopped')) {
          addMessage('ai', `（异步任务处理出错：${errMsg}）`);
        }
      })
      .finally(() => {
        isSending = false;
        if (sendBtn) {
          sendBtn.disabled = false;
          sendBtn.classList.remove('stop-mode');
          sendBtn.innerHTML = `<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>`;
        }
      });
  });

}


