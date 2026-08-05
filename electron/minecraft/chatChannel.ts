import { noteBridgeInboundMessage } from '../bridges/asyncDelivery';
import type { ChatRequestContext } from '../aiService';
import type { MinecraftRuntimeEvent, MinecraftStatus } from './protocol';

export interface MinecraftChatRuntime {
  onEvent(listener: (event: MinecraftRuntimeEvent) => void): () => void;
  status(): Promise<MinecraftStatus>;
  say(message: string): Promise<void>;
}

export interface MinecraftVoiceSink {
  available(): boolean;
  send(player: string, audio: Uint8Array): Promise<void>;
}

export interface MinecraftExternalTurn {
  conversationId: string;
  user: string;
  assistant: string;
  createdAt: number;
}

interface MinecraftChatChannelDependencies {
  runtime: MinecraftChatRuntime;
  getConversationId(): string | undefined;
  sendChatMessage(
    conversationId: string,
    userContent: string,
    requestContext?: ChatRequestContext,
  ): Promise<{ content: string; created_at: number }>;
  playTTS(text: string): void | Promise<void>;
  mirror?(turn: MinecraftExternalTurn): void;
  onError?(error: Error): void;
}

export class MinecraftChatChannel {
  private queue: Promise<void> = Promise.resolve();
  private unsubscribe?: () => void;

  constructor(private readonly dependencies: MinecraftChatChannelDependencies) {}

  start(): void {
    if (this.unsubscribe) return;
    this.unsubscribe = this.dependencies.runtime.onEvent((event) => {
      if (event.kind !== 'chat') return;
      this.queue = this.queue
        .then(() => this.handleChat(event.player, event.message))
        .catch((error) => {
          this.dependencies.onError?.(
            error instanceof Error ? error : new Error(String(error)),
          );
        });
    });
  }

  stop(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
  }

  whenIdle(): Promise<void> {
    return this.queue;
  }

  private async handleChat(player: string, message: string): Promise<void> {
    const status = await this.dependencies.runtime.status();
    if (!shouldAcceptChat(status, player, message)) return;
    const conversationId = this.dependencies.getConversationId();
    if (!conversationId) return;

    noteBridgeInboundMessage({
      conversationId,
      platform: 'minecraft',
      userId: player,
    });
    const reply = await this.dependencies.sendChatMessage(
      conversationId,
      message,
      { sourceContext: buildSourceContext(status, player) },
    );
    if (!reply.content.trim()) return;

    await this.dependencies.runtime.say(reply.content);
    await this.dependencies.playTTS(reply.content);
    this.dependencies.mirror?.({
      conversationId,
      user: message,
      assistant: reply.content,
      createdAt: reply.created_at,
    });
  }
}

export function shouldAcceptChat(
  status: MinecraftStatus,
  player: string,
  message: string,
): boolean {
  if (!status.connected || player === status.username) return false;
  if (status.players.length <= 1) return true;
  if (status.owner && player === status.owner) return true;
  return /\bhiyori\b/i.test(message);
}

function buildSourceContext(status: MinecraftStatus, player: string): string {
  return [
    `当前消息来自 Minecraft 玩家 ${player}。`,
    `Hiyori 已作为游戏角色 ${status.username ?? 'unknown'} 连接；直接自然回复玩家，不需要打开网页或另找发送渠道。`,
  ].join('\n');
}
