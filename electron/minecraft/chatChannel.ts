import { noteBridgeInboundMessage } from '../bridges/asyncDelivery';
import type { ChatRequestContext } from '../aiService';
import { traceReplyDelivery } from '../turnTrace';
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
  ): Promise<{ content: string; created_at: number; turnId?: string }>;
  playTTS(text: string): void | Promise<void>;
  onRuntimeEvent?(event: MinecraftRuntimeEvent): void;
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
      this.dependencies.onRuntimeEvent?.(event);
      if (event.kind !== 'chat' && event.kind !== 'player-gaze') return;
      this.queue = this.queue
        .then(() => event.kind === 'chat'
          ? this.handleChat(event.player, event.message)
          : this.handleGaze(event.player, event.durationMs))
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
    await this.handleTurn(status, player, message, 'message', buildSourceContext(status, player));
  }

  private async handleGaze(player: string, durationMs: number): Promise<void> {
    const status = await this.dependencies.runtime.status();
    if (!shouldAcceptGaze(status, player)) return;
    const action = `（${player} 持续注视着 Hiyori）`;
    await this.handleTurn(
      status,
      player,
      action,
      'player-gaze',
      buildGazeSourceContext(status, player, durationMs),
    );
  }

  private async handleTurn(
    _status: MinecraftStatus,
    player: string,
    userContent: string,
    event: 'message' | 'player-gaze',
    sourceContext: string,
  ): Promise<void> {
    const conversationId = this.dependencies.getConversationId();
    if (!conversationId) return;

    noteBridgeInboundMessage({
      conversationId,
      platform: 'minecraft',
      userId: player,
    });
    const reply = await this.dependencies.sendChatMessage(
      conversationId,
      userContent,
      {
        sourceContext,
        trigger: {
          actor: 'user',
          source: 'minecraft',
          event,
          sourceId: player,
        },
      },
    );
    if (!reply.content.trim()) return;

    await this.dependencies.runtime.say(reply.content);
    if (reply.turnId) {
      traceReplyDelivery(reply.turnId, conversationId, 'minecraft', {
        player,
        reply: reply.content,
      });
    }
    await this.dependencies.playTTS(reply.content);
    this.dependencies.mirror?.({
      conversationId,
      user: userContent,
      assistant: reply.content,
      createdAt: reply.created_at,
    });
  }
}

function shouldAcceptGaze(status: MinecraftStatus, player: string): boolean {
  return Boolean(
    status.connected
    && status.owner
    && status.owner.toLocaleLowerCase() === player.toLocaleLowerCase()
    && status.username?.toLocaleLowerCase() !== player.toLocaleLowerCase(),
  );
}

function buildGazeSourceContext(
  _status: MinecraftStatus,
  player: string,
  durationMs: number,
): string {
  const seconds = Math.round(durationMs / 100) / 10;
  return `当前轮次来自 Minecraft 中的非语言互动：玩家 ${player} 连续注视 Hiyori 约 ${seconds} 秒。请依据当前人格自然回应此刻的注视。`;
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

function buildSourceContext(_status: MinecraftStatus, player: string): string {
  return `当前消息来自 Minecraft 游戏内聊天，发送者：${player}。`;
}
