import type { ChatRequestContext } from '../aiService';
import { MINECRAFT_MODE } from '../agentMode';
import type { ReplyTarget } from '../bridges/asyncDelivery';
import type { TurnTrigger } from '../turnTrace';
import { formatMinecraftRuntimeContext, registerRuntimeContextProvider } from '../runtimeContext';
import { MinecraftChatChannel, type MinecraftExternalTurn } from './chatChannel';
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
import type { MinecraftGoalPublicState } from './goalController';
import { formatMovementBlockedWakeup } from './movementBlockedMessage';

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
  sendWakeup(
    conversationId: string,
    text: string,
    replyTarget?: ReplyTarget,
    trigger?: Omit<TurnTrigger, 'actor' | 'parentId'>,
  ): void;
  getFallbackConversationId(): string | undefined;
  getMinecraftGoalState?(): MinecraftGoalPublicState | null;
  failMinecraftGoal?(reason: string): Promise<boolean>;
  mirror?(turn: MinecraftExternalTurn): void;
  onError?(error: Error): void;
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
    getConversationId: () => {
      const origin = dependencies.runtime.currentOrigin();
      const conversationId = origin && !origin.conversationId.startsWith('task-')
        ? origin.conversationId
        : dependencies.getFallbackConversationId();
      return conversationId;
    },
    sendChatMessage: dependencies.sendChatMessage,
    playTTS: dependencies.playTTS,
    onRuntimeEvent: (event) => {
      if (event.kind !== 'death') return;
      const location = event.position
        ? ` at ${event.position.x.toFixed(1)}, ${event.position.y.toFixed(1)}, ${event.position.z.toFixed(1)}`
        : '';
      void dependencies.failMinecraftGoal?.(`Hiyori died${location}.`);
    },
    mirror: dependencies.mirror,
    onError: dependencies.onError,
  });
  channel.start();

  const unregisterRuntimeContext = registerRuntimeContextProvider('minecraft', async (scope) => {
    if (scope.mode !== MINECRAFT_MODE) return null;
    if (dependencies.runtime.hasActiveWorker?.() === false) {
      return formatMinecraftRuntimeContext(null, dependencies.getMinecraftGoalState?.() ?? null);
    }
    const snapshot = await dependencies.runtime.command<MinecraftEnvironmentSnapshot>('snapshot', {});
    return formatMinecraftRuntimeContext(snapshot, dependencies.getMinecraftGoalState?.() ?? null);
  });

  dependencies.runtime.setNotifier((origin, event) => {
    if (event.kind === 'disconnected' && dependencies.failMinecraftGoal) {
      void dependencies.failMinecraftGoal(`Minecraft disconnected: ${event.reason}`).then((handled) => {
        if (!handled) sendRuntimeWakeup(dependencies, origin, event);
      });
      return;
    }
    sendRuntimeWakeup(dependencies, origin, event);
  });

  return {
    whenIdle: () => channel.whenIdle(),
    async shutdown(): Promise<void> {
      unregisterRuntimeContext();
      channel.stop();
      await dependencies.runtime.shutdown();
    },
  };
}

function sendRuntimeWakeup(
  dependencies: MinecraftMainIntegrationDependencies,
  origin: MinecraftCommandOrigin,
  event: MinecraftRuntimeEvent,
): void {
    dependencies.sendWakeup(
      origin.conversationId,
      wakeupText(event),
      origin.replyTarget,
      {
        source: 'minecraft',
        event: event.kind,
      },
    );
}

function wakeupText(event: MinecraftRuntimeEvent): string {
  if (event.kind === 'food-shortage') {
    return [
      '【Minecraft 生存提醒】',
      '事件：food-shortage',
      `Hiyori 的饥饿值是 ${event.food}，背包里没有可食用物品。`,
      '请告诉用户当前情况，并询问用户是否愿意给 Hiyori 食物。当前版本不要自行狩猎、收割或翻找容器。',
    ].join('\n');
  }
  if (event.kind === 'disconnected') {
    return [
      '【Minecraft 连接提醒】',
      '事件：disconnected',
      `Hiyori 已离开 Minecraft：${event.reason}`,
      '请如实告诉用户连接已经中断。',
    ].join('\n');
  }
  if (event.kind === 'movement-blocked') {
    return formatMovementBlockedWakeup(event);
  }
  if (event.kind === 'oxygen-danger') {
    return [
      '【Minecraft 氧气危险】',
      `当前位置：${event.position.x.toFixed(1)}, ${event.position.y.toFixed(1)}, ${event.position.z.toFixed(1)}`,
      event.recovered
        ? `Hiyori 已经浮出水面恢复呼吸（氧气 ${event.oxygen}），原移动状态已停止。`
        : `Hiyori 未能确认浮出水面（氧气 ${event.oxygen}），需要用户协助。`,
      '请直接向用户说明真实情况，不要声称仍在执行之前的移动。',
    ].join('\n');
  }
  return [
    '【Minecraft 状态提醒】',
    `事件：${event.kind}`,
    '请根据当前事件自然告诉用户。',
  ].join('\n');
}
