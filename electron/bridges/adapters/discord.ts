/**
 * Discord 桥接 Adapter
 *
 * 代理方案（官方文档：https://discordjs.guide/legacy/additional-info/proxy）：
 *   REST            undici ProxyAgent（传入 client 构造选项 rest.agent）
 *   WebSocket GW    global-agent bootstrap()（拦截 Node.js 原生 http/https）
 */

import {
  Client,
  GatewayIntentBits,
  Partials,
  Message,
} from 'discord.js';
import { ProxyAgent } from 'undici';
import type { DiscordBridgeConfig } from '../bridge.config';
import { sendChatMessage } from '../../aiService';
import { traceReplyDelivery } from '../../turnTrace';
import { listConversations } from '../../db';  // 🆕 导入对话列表，用于自动获取最新对话
import { noteBridgeInboundMessage } from '../asyncDelivery';

const DISCORD_MAX_LEN = 1900;

function splitMessage(text: string): string[] {
  const chunks: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= DISCORD_MAX_LEN) { chunks.push(remaining); break; }
    let cutAt = remaining.lastIndexOf('\n', DISCORD_MAX_LEN);
    if (cutAt < DISCORD_MAX_LEN / 2) cutAt = DISCORD_MAX_LEN;
    chunks.push(remaining.slice(0, cutAt));
    remaining = remaining.slice(cutAt).trimStart();
  }
  return chunks;
}

export class DiscordAdapter {
  /** 当 Discord Bot 在线时指向 Client 实例；停止后置 null */
  static activeClient: Client | null = null;

  private client: Client;
  private cfg: DiscordBridgeConfig;

  constructor(cfg: DiscordBridgeConfig) {
    this.cfg = cfg;
    const restOptions = cfg.proxyUrl ? { agent: new ProxyAgent(cfg.proxyUrl) } : {};
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
      ],
      partials: [Partials.Channel],
      rest: restOptions,
    });
  }

  async start(): Promise<void> {
    const { token, allowedChannels } = this.cfg;

    // WebSocket 代理：官方推荐 global-agent
    if (this.cfg.proxyUrl) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { bootstrap } = require('global-agent') as { bootstrap: () => void };
      bootstrap();
      (global as any).GLOBAL_AGENT.HTTP_PROXY  = this.cfg.proxyUrl;
      (global as any).GLOBAL_AGENT.HTTPS_PROXY = this.cfg.proxyUrl;

      // global-agent 修复：ws 调用 https.request() 时不设 secureEndpoint:true，
      // 导致 global-agent 跳过 servername 构建，tls.connect({ socket }) 无 servername，
      // TLS 证书校验失败（连接建立后立刻 1006 闪断）。
      // 补丁：在 createConnection 里补齐 servername。
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { globalAgent } = require('https') as typeof import('https');
      const ga = globalAgent as any;
      if (typeof ga.createConnection === 'function' && !ga.__servernamePatchApplied) {
        const _origCC = ga.createConnection.bind(ga);
        ga.createConnection = function (cfg: any, cb: any) {
          if (cfg.host && (!cfg.tls || !cfg.tls.servername)) {
            // eslint-disable-next-line @typescript-eslint/no-require-imports
            const { isIP } = require('net') as typeof import('net');
            cfg = { ...cfg, tls: { ...(cfg.tls ?? {}), servername: isIP(cfg.host) ? undefined : cfg.host } };
          }
          return _origCC(cfg, cb);
        };
        ga.__servernamePatchApplied = true;
      }

      console.log(`[Discord] WebSocket 代理已设置（global-agent）：${this.cfg.proxyUrl}`);
    }

    this.client.on('error',  (e)    => console.error('[Discord] 错误:', e.message));
    this.client.on('warn',   (info) => console.warn('[Discord] 警告:', info));
    this.client.on('debug',  (info) => {
      if (/gateway|websocket|identify|hello|ready|session|heartbeat|shard/i.test(info))
        console.log('[Discord Debug]', info.slice(0, 500));
    });

    this.client.once('ready', () => {
      console.log(`[Discord] Bot 已上线：${this.client.user?.tag}`);
    });

    this.client.on('messageCreate', async (msg: Message) => {
      if (msg.author.bot) return;
      if (allowedChannels.length > 0 && !allowedChannels.includes(msg.channelId)) return;
      const content = msg.content.trim();
      if (!content) return;

      // 🆕 自动获取对话 ID：若配置为空，使用最新对话
      let conversationId = this.cfg.conversationId;
      if (!conversationId) {
        const convs = listConversations();
        if (convs.length === 0) {
          await msg.reply('⚠️ 系统中没有任何对话，请先在桌面创建一个对话。');
          return;
        }
        conversationId = convs[0].id;  // 使用最新对话（按 updated_at DESC 排序）
        console.log(`[Discord] 未配置对话 ID，自动使用最新对话：${conversationId}`);
      }

      if ('sendTyping' in msg.channel && typeof msg.channel.sendTyping === 'function')
        (msg.channel.sendTyping as () => Promise<void>)().catch(() => {});

      try {
        const platformTag = `[来源：Discord | 频道：${msg.channelId} | 用户：${msg.author.username}]`;
        noteBridgeInboundMessage({
          conversationId,
          platform: 'discord',
          channelId: msg.channelId,
          userId: msg.author.id,
        });
        const taggedContent = `${platformTag}\n${content}`;
        const result = await sendChatMessage(conversationId, taggedContent, {
          trigger: {
            actor: 'user',
            source: 'discord',
            event: 'message',
            sourceId: msg.id,
          },
        });
        for (const chunk of splitMessage(result.content)) await msg.reply(chunk);
        traceReplyDelivery(result.turnId, conversationId, 'discord', {
          channelId: msg.channelId,
          messageId: msg.id,
          reply: result.content,
        });
      } catch (e) {
        const errMsg = (e as Error).message ?? String(e);
        console.error('[Discord] 消息处理失败:', errMsg);
        await msg.reply(`❌ AI 响应出错：${errMsg.slice(0, 200)}`).catch(() => {});
      }
    });

    DiscordAdapter.activeClient = this.client;
    console.log('[Discord] 正在调用 login()...');
    await this.client.login(token);
  }

  async stop(): Promise<void> {
    this.client.destroy();
    DiscordAdapter.activeClient = null;
    console.log('[Discord] Bot 已下线');
  }
}
