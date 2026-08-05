import type { ChatRequestContext } from '../aiService';
import type { ReplyTarget } from '../bridges/asyncDelivery';
import { formatMinecraftRuntimeContext, registerRuntimeContextProvider } from '../runtimeContext';
import { MinecraftChatChannel, type MinecraftExternalTurn } from './chatChannel';
import type { MinecraftGoalRequest } from './cognitionCoordinator';
import type {
  MinecraftAction,
  MinecraftEnvironmentSnapshot,
  MinecraftRuntimeEvent,
  MinecraftStatus,
} from './protocol';
import type {
  MinecraftCommandOrigin,
  MinecraftNotifier,
} from './runtimeManager';

interface MinecraftMainRuntime {
  onEvent(listener: (event: MinecraftRuntimeEvent) => void): () => void;
  command<T = unknown>(action: MinecraftAction, payload: unknown): Promise<T>;
  hasActiveWorker?(): boolean;
  setNotifier(notifier: MinecraftNotifier): void;
  currentOrigin(): MinecraftCommandOrigin | undefined;
  shutdown(): Promise<void>;
}

interface MinecraftMainIntegrationDependencies {
  runtime: MinecraftMainRuntime;
  sendChatMessage(
    conversationId: string,
    userContent: string,
    requestContext?: ChatRequestContext,
  ): Promise<{ content: string; created_at: number }>;
  playTTS(text: string): void | Promise<void>;
  sendWakeup(conversationId: string, text: string, replyTarget?: ReplyTarget): void;
  getFallbackConversationId(): string | undefined;
  mirror?(turn: MinecraftExternalTurn): void;
  onError?(error: Error): void;
  coordinator?: {
    startGoal(request: MinecraftGoalRequest): Promise<void>;
    stopGoal(goalId: string): Promise<boolean>;
  };
}

export function configureMinecraftMainIntegration(
  dependencies: MinecraftMainIntegrationDependencies,
) {
  const channel = new MinecraftChatChannel({
    runtime: {
      onEvent: (listener) => dependencies.runtime.onEvent(listener),
      status: () => dependencies.runtime.command<MinecraftStatus>('status', {}),
      say: (message) => dependencies.runtime.command('say', { message }),
    },
    getConversationId: () =>
      dependencies.runtime.currentOrigin()?.conversationId ??
      dependencies.getFallbackConversationId(),
    sendChatMessage: dependencies.sendChatMessage,
    playTTS: dependencies.playTTS,
    mirror: dependencies.mirror,
    onError: dependencies.onError,
  });
  channel.start();

  const unregisterRuntimeContext = registerRuntimeContextProvider('minecraft', async () => {
    if (dependencies.runtime.hasActiveWorker?.() === false) return null;
    const snapshot = await dependencies.runtime.command<MinecraftEnvironmentSnapshot>('snapshot', {});
    return formatMinecraftRuntimeContext(snapshot);
  });

  dependencies.runtime.setNotifier((origin, event) => {
    dependencies.sendWakeup(
      origin.conversationId,
      wakeupText(event),
      origin.replyTarget,
    );
  });

  return {
    whenIdle: () => channel.whenIdle(),
    async startGoal(request: MinecraftGoalRequest): Promise<void> {
      if (!dependencies.coordinator) {
        throw new Error('Minecraft cognition coordinator is not configured');
      }
      await dependencies.coordinator.startGoal(request);
    },
    async stopGoal(goalId: string): Promise<boolean> {
      return dependencies.coordinator?.stopGoal(goalId) ?? false;
    },
    async shutdown(): Promise<void> {
      unregisterRuntimeContext();
      channel.stop();
      await dependencies.runtime.shutdown();
    },
  };
}

function wakeupText(event: MinecraftRuntimeEvent): string {
  if (event.kind === 'collection-terminal') {
    return [
      '【Minecraft 任务结果】',
      `方块：${event.block}`,
      `结果：${event.outcome}`,
      `数量：${event.collected}/${event.requested}`,
      event.message ? `说明：${event.message}` : undefined,
      '',
      '请把结果自然地告诉用户。任务已经结束，不需要查询状态或再次发起采集。',
    ]
      .filter((line) => line !== undefined)
      .join('\n');
  }
  if (event.kind === 'food-shortage') {
    return [
      '【Minecraft 生存提醒】',
      `Hiyori 的饥饿值是 ${event.food}，背包里没有可食用物品。`,
      '请告诉用户当前情况，并询问用户是否愿意给 Hiyori 食物。当前版本不要自行狩猎、收割或翻找容器。',
    ].join('\n');
  }
  if (event.kind === 'disconnected') {
    return [
      '【Minecraft 连接提醒】',
      `Hiyori 已离开 Minecraft：${event.reason}`,
      '请如实告诉用户连接已经中断。',
    ].join('\n');
  }
  return '【Minecraft 状态提醒】请根据当前事件自然地告诉用户。';
}
