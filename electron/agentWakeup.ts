/**
 * 系统唤醒主对话：后台任务、定时提醒、Coding Agent、Minecraft 目标等异步事件
 * 完成后，通知主对话 AI 开启新一轮处理，由它决定如何告知用户。
 */

import { createTurnId, traceTurnEvent, type TurnTrigger } from './turnTrace';
import { sendToRenderer } from './mainWindow';
import {
  deliverReplyToTarget,
  getReplyTargetForConversation,
  type ReplyTarget,
} from './bridges/asyncDelivery';
import { DiscordAdapter } from './bridges/adapters/discord';
import { FeishuAdapter } from './bridges/adapters/feishu';
import { minecraftRuntime } from './minecraft';
import { taskManager } from './taskManager';
import type { DBTask } from './db';
import { buildBatchCompletedWakeup, buildTaskCompletedWakeup, buildTaskFailedWakeup, taskBelongsToSlot } from './taskWakeup';
import { setScheduleReminderNotifier } from './taskScheduler';
import { setCodingAgentNotifier, setCodingAgentTerminalNotifier } from './codingAgents';
import { streamerController } from './streaming/streamerController';

export function sendAgentWakeup(
  conversationId: string,
  triggerText: string,
  replyTarget?: ReplyTarget,
  trigger?: Omit<TurnTrigger, 'actor' | 'parentId'>,
): void {
  const wakeupId = createTurnId();
  const turnTrigger: TurnTrigger = {
    actor: 'system',
    source: trigger?.source ?? 'runtime',
    event: trigger?.event ?? 'wakeup',
    sourceId: trigger?.sourceId,
    parentId: wakeupId,
  };
  traceTurnEvent({
    type: 'wakeup-issued',
    turnId: wakeupId,
    conversationId,
    trigger: turnTrigger,
    input: triggerText,
    replyTarget,
  });
  const sent = sendToRenderer('chat:agent-wakeup', {
    conversationId,
    text: triggerText,
    replyTarget,
    trigger: turnTrigger,
  });
  if (sent) console.log(`[Agent Wakeup] 唤醒对话 ${conversationId.slice(0, 8)}…: ${triggerText.slice(0, 80)}`);
}

/** 把一轮回复送回消息来源（Discord / 飞书 / Minecraft 等；桌面端无需额外投递） */
export async function deliverReplyTarget(replyTarget: ReplyTarget | undefined, text: string): Promise<void> {
  await deliverReplyToTarget({
    sendDiscord: async (channelId, content) => {
      const channel = await DiscordAdapter.activeClient?.channels.fetch(channelId);
      if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
        throw new Error(`Discord channel is not sendable: ${channelId}`);
      }
      await channel.send(content);
    },
    sendFeishu: async (chatId, content) => {
      const adapter = FeishuAdapter.activeAdapter;
      if (!adapter) throw new Error('Feishu adapter is not online.');
      await adapter.sendReply(chatId, content);
    },
    sendMinecraft: async (_player, content) => {
      await minecraftRuntime.command('say', { message: content });
    },
  }, replyTarget, text);
}

function parseReplyTargetFromMetadata(metadata: string | null): ReplyTarget | undefined {
  if (!metadata) return undefined;
  try {
    const target = (JSON.parse(metadata) as { replyTarget?: ReplyTarget }).replyTarget;
    if (!target || typeof target !== 'object') return undefined;
    if (target.kind === 'desktop') return target;
    if (target.kind === 'discord' && typeof target.channelId === 'string') return target;
    if (target.kind === 'feishu' && typeof target.chatId === 'string') return target;
    if (target.kind === 'minecraft' && typeof target.player === 'string') return target;
    if (target.kind === 'wechat' && typeof target.userId === 'string') {
      return { kind: 'wechat', userId: target.userId, delivery: 'pending' };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** 任务的回复目标：创建任务时记录的来源优先，否则沿用对话最近的来源 */
function replyTargetForTask(task: DBTask & { conversation_id: string }): ReplyTarget | undefined {
  return parseReplyTargetFromMetadata(task.metadata) ?? getReplyTargetForConversation(task.conversation_id);
}

/** 由主对话发起、需要回报的顶层任务（批量子任务等父任务完成后统一唤醒一次；Minecraft 目标有自己的通知） */
function wakesConversation(task: DBTask): task is DBTask & { conversation_id: string } {
  return Boolean(task.conversation_id) && !task.parent_task_id && !taskBelongsToSlot(task, 'minecraft');
}

/** 把任务、定时提醒、Coding Agent 的完成事件接到唤醒机制上（启动时调用一次） */
export function wireAgentNotifications(): void {
  taskManager.on('task:completed', (task: DBTask) => {
    const typeLabel = task.type === 'cron' ? '定时' : task.type === 'batch' ? '批量' : '后台';
    console.log(`[TaskManager] ✅ ${typeLabel}任务全部完成: 「${task.title}」 (${task.id.slice(0, 8)}…)`);

    // 直播中：定时任务完成后自动播报结果
    if (task.type === 'cron' && task.result?.trim() && streamerController.getStatus().running) {
      void streamerController.speak(task.result);
    }

    if (task.type === 'delegate' || !wakesConversation(task)) return;
    // 批量任务：wakeup 只带统计与失败摘要，各项结果由 AI 用 async_task result 分页读取
    const wakeupText = task.type === 'batch'
      ? buildBatchCompletedWakeup(task, taskManager.listTasks({ parentTaskId: task.id })
        .filter((child) => child.status === 'failed' || child.status === 'cancelled').length)
      : buildTaskCompletedWakeup(task);
    sendAgentWakeup(task.conversation_id, wakeupText, replyTargetForTask(task), {
      source: 'background_task',
      event: 'task-completed',
      sourceId: task.id,
    });
  });

  taskManager.on('task:failed', (task: DBTask) => {
    console.log(`[TaskManager] ❌ 任务失败: 「${task.title}」 (${task.id.slice(0, 8)}…) — ${task.error ?? '未知错误'}`);
    if ((task.type !== 'background' && task.type !== 'batch') || !wakesConversation(task)) return;
    sendAgentWakeup(task.conversation_id, buildTaskFailedWakeup(task), replyTargetForTask(task), {
      source: 'background_task',
      event: 'task-failed',
      sourceId: task.id,
    });
  });

  setScheduleReminderNotifier(({ conversationId, title, instruction, replyTarget }) => {
    const text = [
      '【定时提醒】',
      `任务：${title}`,
      `提醒指令：${instruction}`,
      '',
      '请直接向用户发出提醒或开启简短对话。除非提醒内容本身要求真实操作，否则不需要调用工具。',
    ].join('\n');
    sendAgentWakeup(
      conversationId,
      text,
      replyTarget ?? getReplyTargetForConversation(conversationId),
      { source: 'scheduler', event: 'reminder', sourceId: title },
    );
  });

  setCodingAgentNotifier((conversationId, content) => {
    sendAgentWakeup(conversationId, content, getReplyTargetForConversation(conversationId), {
      source: 'coding_agent',
      event: 'result',
    });
  });

  setCodingAgentTerminalNotifier((event) => {
    sendToRenderer('hearing:terminal-block', {
      blockId: `coding-agent:${event.blockId}`,
      title: event.title,
      line: event.line,
      status: event.status,
    });
  });
}
