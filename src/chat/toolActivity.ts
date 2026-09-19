/**
 * AI 工作过程的可视化：工具调用气泡、终端块（命令执行实时输出）、Todo 清单面板。
 */

import { appendToFeed, escapeHtml, scrollToBottom } from './messages';
import { getCurrentConversationId } from './conversations';

interface ToolCallEvent {
  name: string;
  args: Record<string, unknown>;
  result: string;
  ok: boolean;
  durationMs: number;
  /** 工具调用来源对话 ID（用于标出其他对话里的调用） */
  conversationId?: string;
}

interface TerminalBlockEvent {
  blockId: string;
  line?: string;
  status?: 'running' | 'idle' | 'done' | 'error';
  title?: string;
}

// ── Todo 清单 ────────────────────────────────────────────

interface TodoItem {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | 'cancelled';
}

let todoCollapsed = false;

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

function toggleTodoCollapsed(): void {
  const listDiv = document.getElementById('todo-list');
  const toggleBtn = document.getElementById('todo-toggle-btn');
  if (!listDiv || !toggleBtn) return;
  todoCollapsed = !todoCollapsed;
  listDiv.classList.toggle('todo-list-collapsed', todoCollapsed);
  listDiv.classList.toggle('todo-list-expanded', !todoCollapsed);
  toggleBtn.classList.toggle('collapsed', todoCollapsed);
}

/** todo 工具只更新清单面板，不显示气泡：写入模式带 todos 参数，读取模式从结果文本解析 */
function showTodoFromToolCall(ev: ToolCallEvent): void {
  try {
    const todoList = ev.args.todos as TodoItem[] | undefined;
    if (Array.isArray(todoList) && todoList.length > 0) updateTodoPanel(todoList);
    if (!todoList && ev.result?.includes('[')) {
      const parsed = parseTodoFromResult(ev.result);
      if (parsed.length > 0) updateTodoPanel(parsed);
    }
  } catch (e) {
    console.error('[Todo] 解析失败:', e);
  }
}

// ── 工具调用气泡 ─────────────────────────────────────────

function addToolCallBubble(ev: ToolCallEvent): void {
  const isOtherConv = ev.conversationId && ev.conversationId !== getCurrentConversationId();
  const convTag = isOtherConv ? `<span style="color:#ff6b6b; font-size:10px;">[其他对话]</span> ` : '';
  const paused = ev.result.startsWith('⏸️');
  const icon = ev.ok ? '✅' : paused ? '⏸️' : '❌';
  const status = ev.ok ? 'ok' : paused ? 'pause' : 'err';

  // 精简参数展示：只展示值，不要键名嵌套
  let argsText = '';
  try {
    const vals = Object.values(ev.args);
    argsText = vals.length ? vals.map((v) => JSON.stringify(v)).join(', ') : '（无参数）';
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
  appendToFeed(bubble);
}

// ── 终端块 ──────────────────────────────────────────────

interface TerminalBlock {
  container: HTMLElement;
  body: HTMLElement;
  statusEl: HTMLElement;
  copyBtn: HTMLButtonElement;
}

/** 仍在接收输出的终端块（blockId → DOM 元素） */
const activeTerminalBlocks = new Map<string, TerminalBlock>();

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

const TERMINAL_STATUS_TEXT: Record<NonNullable<TerminalBlockEvent['status']>, string> = {
  running: '运行中',
  idle: '本轮完成',
  done: '完成',
  error: '失败',
};

function createTerminalBlock(title: string): TerminalBlock | null {
  const container = document.createElement('div');
  container.className = 'terminal-block';

  const header = document.createElement('div');
  header.className = 'terminal-block-header';
  header.innerHTML = `
    <span class="tb-icon">⚙️</span>
    <span class="tb-title">${escapeHtml(title)}</span>
  `;
  const statusEl = document.createElement('span');
  statusEl.className = 'tb-status tb-status-running';
  statusEl.textContent = TERMINAL_STATUS_TEXT.running;
  const copyBtn = document.createElement('button');
  copyBtn.className = 'tb-copy-btn';
  copyBtn.type = 'button';
  copyBtn.textContent = '复制';
  copyBtn.title = '复制终端输出';
  header.append(statusEl, copyBtn);

  const body = document.createElement('div');
  body.className = 'terminal-block-body';
  header.addEventListener('click', () => body.classList.toggle('collapsed')); // 点击 header 折叠/展开
  copyBtn.addEventListener('click', async (event) => {
    event.stopPropagation();
    const text = body.innerText.trim();
    if (!text) return;
    copyBtn.textContent = (await copyTextToClipboard(text)) ? '已复制' : '复制失败';
    window.setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
  });

  container.append(header, body);
  return appendToFeed(container) ? { container, body, statusEl, copyBtn } : null;
}

/** 按行首符号给终端输出着色：$ / > 是命令，✅ ✓ 成功，❌ ✗ 失败 */
function terminalLine(line: string): HTMLElement {
  const lineEl = document.createElement('div');
  lineEl.className = 'terminal-block-line';
  const trimmed = line.trim();
  if (trimmed.startsWith('$') || trimmed.startsWith('>')) {
    lineEl.classList.add('cmd');
    lineEl.textContent = trimmed.replace(/^\$\s*/, '').replace(/^>\s*/, '');
  } else {
    if (trimmed.startsWith('✅') || trimmed.startsWith('✓')) lineEl.classList.add('ok');
    else if (trimmed.startsWith('❌') || trimmed.startsWith('✗')) lineEl.classList.add('err');
    lineEl.textContent = trimmed;
  }
  return lineEl;
}

/** 创建或追加终端块：同一个 blockId 的输出持续追加，done / error 后不再接收 */
function handleTerminalBlock(ev: TerminalBlockEvent): void {
  let block = activeTerminalBlocks.get(ev.blockId);
  if (!block) {
    const created = createTerminalBlock(ev.title || '终端');
    if (!created) return;
    block = created;
    activeTerminalBlocks.set(ev.blockId, block);
  }

  if (ev.line) {
    block.body.appendChild(terminalLine(ev.line));
    block.body.scrollTop = block.body.scrollHeight;
  }
  if (ev.status) {
    block.statusEl.className = `tb-status tb-status-${ev.status}`;
    block.statusEl.textContent = TERMINAL_STATUS_TEXT[ev.status];
    if (ev.status === 'done' || ev.status === 'error') activeTerminalBlocks.delete(ev.blockId);
  }
  scrollToBottom();
}

export function initToolActivity(): void {
  window.debugAPI?.onToolCall((ev) => {
    if (ev.name === 'todo') showTodoFromToolCall(ev);
    else addToolCallBubble(ev);
  });
  window.hearingAPI?.onTerminalBlock((ev) => handleTerminalBlock(ev));

  document.getElementById('todo-close-btn')?.addEventListener('click', () => {
    const panel = document.getElementById('todo-panel');
    if (panel) panel.style.display = 'none';
  });
  document.getElementById('todo-toggle-btn')?.addEventListener('click', toggleTodoCollapsed);
}
