/**
 * 对话管理与发送消息。同时记录当前打开的对话（记忆总结、空闲调度、Minecraft 回退对话都依赖它）。
 */

import { ipcMain } from 'electron';
import { createConversation, deleteConversation, getMessages, listConversations, renameConversation } from '../db';
import { sendChatMessage, stopCurrentAI, type ChatRequestContext } from '../aiService';
import { triggerConversationLeave } from '../memory/index';
import { traceReplyDelivery } from '../turnTrace';
import { deliverReplyTarget } from '../agentWakeup';
import type { ReplyTarget } from '../bridges/asyncDelivery';

let activeConversationId: string | null = null;

/** 用户当前在桌面端打开的对话 */
export function getActiveConversationId(): string | null {
  return activeConversationId;
}

/** 最近的对话；一个都没有时新建一个（桥接和 Minecraft 需要一个默认绑定的对话） */
export function defaultConversationId(): string {
  const [latest] = listConversations();
  return latest ? latest.id : createConversation().id;
}

export function registerChatIpc(): void {
  ipcMain.handle('chat:create-conversation', () => createConversation());
  ipcMain.handle('chat:list-conversations', () => listConversations());
  ipcMain.handle('chat:load-conversation', (_e, id: string) => {
    // 切换到不同对话时，触发旧对话的离开流水线（补齐总结 + 全局精炼）
    if (activeConversationId && activeConversationId !== id) {
      triggerConversationLeave(activeConversationId);
    }
    activeConversationId = id;
    return getMessages(id);
  });
  ipcMain.handle('chat:delete-conversation', (_e, id: string) => deleteConversation(id));
  ipcMain.handle('chat:rename-conversation', (_e, id: string, title: string) => renameConversation(id, title));

  ipcMain.handle('chat:send', async (
    _e,
    conversationId: string,
    content: string,
    replyTarget?: ReplyTarget,
    requestContext?: ChatRequestContext,
  ) => {
    const result = await sendChatMessage(conversationId, content, requestContext);
    await deliverReplyTarget(replyTarget, result.content);
    traceReplyDelivery(result.turnId, conversationId, replyTarget?.kind ?? 'desktop', { replyTarget, reply: result.content });
    return result;
  });

  ipcMain.handle('chat:stop', () => stopCurrentAI());
}
