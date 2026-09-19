/**
 * 发出一轮对话：手动发送、语音自动发送、异步任务唤醒都走 runTurn。
 *
 * 同一时间只进行一轮；进行中收到的唤醒先排队，本轮结束后依次处理。
 * 进行中发送按钮变成停止按钮，点击会中断主进程的 AI 请求。
 */

import { playTTS } from '../ttsPlayer';
import { extractEmotionTag, notifyInteraction, triggerEmotion } from '../live2dController';
import { addMessage, addTypingIndicator } from './messages';
import { getCurrentConversationId, refreshConvTitle } from './conversations';
import { showEstimatedTypewriterWhenTTSDisabled, typewriterPlayback } from './typewriter';
import type { WakeupPayload } from './types';

const SEND_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/></svg>';
const STOP_ICON = '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';

let sending = false;
const pendingWakeups: WakeupPayload[] = [];

function setSendButton(mode: 'send' | 'stop'): void {
  const btn = document.getElementById('send-btn') as HTMLButtonElement | null;
  if (!btn) return;
  btn.classList.toggle('stop-mode', mode === 'stop');
  btn.innerHTML = mode === 'stop' ? STOP_ICON : SEND_ICON;
  if (mode === 'send') btn.disabled = false;
}

interface TurnRequest {
  conversationId: string;
  /** 发给 AI 的内容 */
  text: string;
  /** 是否在消息流里显示这条用户消息（唤醒是系统消息，不显示） */
  showUserMessage: boolean;
  replyTarget?: unknown;
  trigger?: unknown;
  /** 出错时的提示前缀；中断时 announceStop 决定是否提示"已停止回答" */
  errorLabel: string;
  announceStop: boolean;
}

async function runTurn(req: TurnRequest): Promise<void> {
  sending = true;
  setSendButton('stop');
  if (req.showUserMessage) addMessage('user', req.text);
  const typing = addTypingIndicator();

  try {
    const result = await window.chatAPI!.send(
      req.conversationId,
      req.text,
      req.replyTarget,
      req.trigger === undefined ? undefined : { trigger: req.trigger },
    );
    typing?.remove();
    // 回复开头的 [emotion:xxx] 交给状态机：换表情并播放对应动作（说话中只换表情）
    const { emotion, cleaned } = extractEmotionTag(result.content);
    if (emotion) triggerEmotion(emotion);
    addMessage('ai', cleaned, true, result.created_at);
    // 折叠时显示打字机气泡（TTS 开启时由播放器按真实时长驱动，避免重播两遍）
    await showEstimatedTypewriterWhenTTSDisabled(cleaned);
    playTTS(cleaned, typewriterPlayback(cleaned)).catch((e) => console.error('[TTS] playTTS error:', e));
    // 首轮回复后主进程会自动给对话起标题
    await refreshConvTitle(req.conversationId);
  } catch (e) {
    typing?.remove();
    const errMsg = (e as Error).message;
    const stopped = errMsg.includes('aborted') || errMsg.includes('stopped');
    if (!stopped) addMessage('ai', `（${req.errorLabel}：${errMsg}）`);
    else if (req.announceStop) addMessage('ai', '（已停止回答）');
  } finally {
    sending = false;
    setSendButton('send');
    void drainWakeups();
  }
}

async function drainWakeups(): Promise<void> {
  while (!sending && pendingWakeups.length > 0) {
    const payload = pendingWakeups.shift()!;
    // 用户已切到别的对话：该唤醒不再处理
    if (payload.conversationId !== getCurrentConversationId()) continue;
    console.log('[Chat] 异步任务完成，唤醒主对话 AI:', payload.text.slice(0, 60));
    await runTurn({
      conversationId: payload.conversationId,
      text: payload.text,
      showUserMessage: false,
      replyTarget: payload.replyTarget,
      trigger: payload.trigger,
      errorLabel: '异步任务处理出错',
      announceStop: false,
    });
  }
}

/** 输入框发送；进行中再点击则停止当前回答 */
async function sendFromInput(): Promise<void> {
  const conversationId = getCurrentConversationId();
  if (!conversationId) return;

  if (sending) {
    console.log('[Chat] 用户请求停止AI回答');
    await window.chatAPI?.stopAI?.();
    sending = false;
    setSendButton('send');
    void drainWakeups();
    return;
  }

  const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
  const text = input?.value.trim();
  if (!input || !text) return;
  notifyInteraction(); // 用户发消息：让 Live2D 退出无聊状态
  input.value = '';
  await runTurn({ conversationId, text, showUserMessage: true, errorLabel: '出错了', announceStop: true });
  input.focus();
}

/** 听写 / 总结模式识别完成后自动发给 AI；正在回答时不打断 */
export async function sendFromHearing(text: string, type: 'dictation' | 'summary'): Promise<void> {
  const conversationId = getCurrentConversationId();
  if (!conversationId || sending) return;
  notifyInteraction();
  const content = type === 'summary' ? `请帮我总结以下听到的内容：\n\n${text}` : text;
  await runTurn({ conversationId, text: content, showUserMessage: true, errorLabel: '出错了', announceStop: true });
}

export function initTurns(): void {
  document.getElementById('send-btn')?.addEventListener('click', () => void sendFromInput());
  const input = document.getElementById('message-input') as HTMLTextAreaElement | null;
  input?.addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendFromInput();
    }
  });
  input?.addEventListener('mousedown', (e) => e.stopPropagation());

  // 后台任务 / 定时提醒完成 → 唤醒主对话 AI 开启新一轮；进行中则排队
  window.chatAPI?.onWakeup?.((payload) => {
    if (payload.conversationId !== getCurrentConversationId()) return;
    pendingWakeups.push(payload);
    void drainWakeups();
  });
}
