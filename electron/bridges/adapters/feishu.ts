import * as lark from '@larksuiteoapi/node-sdk';
import type { FeishuBridgeConfig } from '../bridge.config';
import { sendChatMessage } from '../../aiService';
import { listConversations } from '../../db';
import { noteBridgeInboundMessage } from '../asyncDelivery';
import { formatFeishuCommandHelp, parseFeishuCommand } from '../feishuCommands';
import { deliverFeishuVoiceReply, getReadyBridgeVoiceProvider, type FeishuVoiceMeta } from '../voiceReplies';

const FEISHU_MAX_LEN = 3900;
const EVENT_DEDUPE_TTL_MS = 10 * 60 * 1000;
const STARTUP_REPLAY_GRACE_MS = 2 * 60 * 1000;
const seenFeishuEvents = new Map<string, number>();

interface FeishuTextJob {
  dedupeKey: string;
  chatId: string;
  userId: string;
  text: string;
  createdAtMs: number;
}

export interface FeishuVoiceReplyControl {
  getVoiceRepliesEnabled(): boolean;
  setVoiceRepliesEnabled(enabled: boolean): Promise<{ enabled: boolean; detail?: string }>;
}

let voiceReplyControl: FeishuVoiceReplyControl | null = null;

export function setFeishuVoiceReplyControl(control: FeishuVoiceReplyControl | null): void {
  voiceReplyControl = control;
}

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= FEISHU_MAX_LEN) {
      chunks.push(remaining);
      break;
    }
    let cutAt = remaining.lastIndexOf('\n', FEISHU_MAX_LEN);
    if (cutAt < FEISHU_MAX_LEN / 2) cutAt = FEISHU_MAX_LEN;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}

function extractTextContent(content: string): string {
  try {
    const parsed = JSON.parse(content) as { text?: unknown };
    return typeof parsed.text === 'string' ? parsed.text.trim() : '';
  } catch {
    return '';
  }
}

function senderOpenId(event: any): string {
  return event?.sender?.sender_id?.open_id
    ?? event?.sender?.sender_id?.user_id
    ?? event?.sender?.sender_id?.union_id
    ?? '';
}

function parseFeishuTimestampMs(value: unknown): number {
  if (typeof value !== 'string' && typeof value !== 'number') return 0;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

export class FeishuAdapter {
  static activeAdapter: FeishuAdapter | null = null;

  private cfg: FeishuBridgeConfig;
  private client: lark.Client;
  private wsClient: lark.WSClient;
  private startedAtMs = Date.now();

  constructor(cfg: FeishuBridgeConfig) {
    this.cfg = cfg;
    const baseConfig = {
      appId: cfg.appId,
      appSecret: cfg.appSecret,
      appType: lark.AppType.SelfBuild,
      domain: lark.Domain.Feishu,
    };
    this.client = new lark.Client(baseConfig);
    this.wsClient = new lark.WSClient({
      ...baseConfig,
      loggerLevel: lark.LoggerLevel.info,
    });
  }

  async start(): Promise<void> {
    if (!this.cfg.appId || !this.cfg.appSecret) {
      throw new Error('Feishu appId/appSecret is missing.');
    }

    const eventDispatcher = new lark.EventDispatcher({}).register({
      'im.message.receive_v1': async (data: any) => this.handleMessageEvent(data),
    });

    await this.wsClient.start({ eventDispatcher });
    this.startedAtMs = Date.now();
    FeishuAdapter.activeAdapter = this;
    console.log(`[Feishu] Bot connected: appId=${this.cfg.appId.slice(0, 8)}***`);
  }

  async stop(): Promise<void> {
    this.wsClient.close({ force: true });
    FeishuAdapter.activeAdapter = null;
    console.log('[Feishu] Bot disconnected');
  }

  async sendText(chatId: string, text: string): Promise<void> {
    for (const chunk of splitMessage(text)) {
      await this.client.im.v1.message.create({
        params: {
          receive_id_type: 'chat_id',
        },
        data: {
          receive_id: chatId,
          content: JSON.stringify({ text: chunk }),
          msg_type: 'text',
        },
      });
    }
  }

  async sendAudio(chatId: string, opus: Buffer, fileName: string, meta?: FeishuVoiceMeta): Promise<void> {
    const uploadData: { file_type: string; file_name: string; file: Buffer; duration?: number } = {
      file_type: 'opus',
      file_name: fileName,
      file: opus,
    };
    if (meta?.durationMs && Number.isFinite(meta.durationMs)) {
      uploadData.duration = Math.max(1, Math.round(meta.durationMs));
    }

    const uploaded = await this.client.im.v1.file.create({
      data: uploadData,
    } as any);
    const fileKey = (uploaded as any)?.file_key ?? (uploaded as any)?.data?.file_key;
    if (!fileKey) {
      throw new Error('Feishu audio upload did not return file_key');
    }

    await this.client.im.v1.message.create({
      params: {
        receive_id_type: 'chat_id',
      },
      data: {
        receive_id: chatId,
        content: JSON.stringify({ file_key: fileKey }),
        msg_type: 'audio',
      },
    });
  }

  private async handleMessageEvent(data: any): Promise<void> {
    const job = this.parseTextJob(data);
    if (!job) return;
    if (job.createdAtMs > 0 && job.createdAtMs < this.startedAtMs - STARTUP_REPLAY_GRACE_MS) {
      console.log(`[Feishu] stale message ignored: ${job.dedupeKey}`);
      return;
    }

    this.pruneSeenEvents();
    if (seenFeishuEvents.has(job.dedupeKey)) {
      console.log(`[Feishu] duplicate message ignored: ${job.dedupeKey}`);
      return;
    }
    seenFeishuEvents.set(job.dedupeKey, Date.now());

    void this.processTextJob(job).catch((error) => {
      console.error('[Feishu] async message job failed:', (error as Error).message);
    });
  }

  private parseTextJob(data: any): FeishuTextJob | null {
    const message = data?.message;
    const chatId = message?.chat_id;
    if (!chatId) return null;
    if (message?.chat_type && message.chat_type !== 'p2p') return null;
    if (message?.message_type !== 'text') return null;
    if (this.cfg.allowedChatIds.length > 0 && !this.cfg.allowedChatIds.includes(chatId)) return null;

    const text = extractTextContent(message.content ?? '');
    if (!text) return null;

    const dedupeKey = String(
      message?.message_id
        ?? `${chatId}:${message?.create_time ?? ''}:${message?.content ?? ''}`,
    );

    return {
      dedupeKey,
      chatId,
      userId: senderOpenId(data),
      text,
      createdAtMs: parseFeishuTimestampMs(message?.create_time),
    };
  }

  private async processTextJob(job: FeishuTextJob): Promise<void> {
    if (await this.handleCommand(job.chatId, job.text)) {
      return;
    }

    let conversationId = this.cfg.conversationId;
    if (!conversationId) {
      const convs = listConversations();
      if (convs.length === 0) {
        await this.sendText(job.chatId, 'Hiyori has no conversation yet. Please create one on desktop first.');
        return;
      }
      conversationId = convs[0].id;
      console.log(`[Feishu] No bound conversation; using latest conversation: ${conversationId}`);
    }

    noteBridgeInboundMessage({
      conversationId,
      platform: 'feishu',
      channelId: job.chatId,
      userId: job.userId,
    });

    try {
      const result = await sendChatMessage(
        conversationId,
        `[来源：Lark / Feishu | 聊天：${job.chatId} | 用户：${job.userId}]\n${job.text}`,
      );
      const provider = this.cfg.voiceRepliesEnabled
        ? await getReadyBridgeVoiceProvider().catch((error) => {
          console.warn('[Feishu] voice provider unavailable:', (error as Error).message);
          return null;
        })
        : null;
      await deliverFeishuVoiceReply({
        chatId: job.chatId,
        text: result.content,
        voiceEnabled: this.cfg.voiceRepliesEnabled,
        provider,
        sendAudio: (chatId, opus, fileName, meta) => this.sendAudio(chatId, opus, fileName, meta),
        sendText: (chatId, text) => this.sendText(chatId, text),
      });
    } catch (error) {
      const message = (error as Error).message ?? String(error);
      console.error('[Feishu] message handling failed:', message);
      await this.sendText(job.chatId, `AI response failed: ${message.slice(0, 200)}`).catch(() => {});
    }
  }

  private async handleCommand(chatId: string, text: string): Promise<boolean> {
    const command = parseFeishuCommand(text);
    if (!command) return false;

    if (command === 'help') {
      await this.sendText(chatId, formatFeishuCommandHelp(this.cfg.voiceRepliesEnabled));
      return true;
    }

    if (!voiceReplyControl) {
      await this.sendText(chatId, 'Voice reply control is unavailable.');
      return true;
    }

    if (command === 'stopvoice') {
      const result = await voiceReplyControl.setVoiceRepliesEnabled(false);
      this.cfg.voiceRepliesEnabled = result.enabled;
      await this.sendText(chatId, result.enabled
        ? 'Voice bubble replies are still on.'
        : 'Voice bubble replies are now off.');
      return true;
    }

    const result = await voiceReplyControl.setVoiceRepliesEnabled(true);
    this.cfg.voiceRepliesEnabled = result.enabled;
    await this.sendText(chatId, result.enabled
      ? 'Voice bubble replies are now on.'
      : `Voice bubble replies could not be enabled.${result.detail ? ` ${result.detail}` : ''}`);
    return true;
  }

  private pruneSeenEvents(): void {
    const cutoff = Date.now() - EVENT_DEDUPE_TTL_MS;
    for (const [key, seenAt] of seenFeishuEvents.entries()) {
      if (seenAt < cutoff) seenFeishuEvents.delete(key);
    }
  }
}
