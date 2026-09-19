/**
 * Skill: discord_send_file —— 搜索本地文件（或截图）并通过 Discord Bot 发到用户所在频道。
 * 通用流程见 tools/sendFileTool.ts；这里只负责 Discord 的上传、网络重试与大小限制提示。
 */

import * as path from 'path';
import { AttachmentBuilder } from 'discord.js';
import { createSendFileTool } from '../sendFileTool';
import { DiscordAdapter } from '../../bridges/adapters/discord';

/** 瞬态网络错误关键词（可重试） */
const TRANSIENT_NET_ERRORS = /aborted|socket disconnected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|TLS|timeout|network/i;
const SEND_MAX_RETRIES = 3;
const SEND_RETRY_DELAY_MS = 1200;

/**
 * 对 Discord REST 调用进行重试，处理 undici/TLS 瞬态网络错误。
 * 非网络错误（如权限问题）直接抛出，不重试。
 */
async function retryNetworkOp<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < SEND_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      const msg = lastErr.message ?? '';
      if (!TRANSIENT_NET_ERRORS.test(msg)) throw e;
      if (attempt < SEND_MAX_RETRIES - 1) {
        const delay = SEND_RETRY_DELAY_MS * (attempt + 1);
        console.warn(`[discord_send_file] 网络错误（第 ${attempt + 1}/${SEND_MAX_RETRIES} 次）: ${msg.slice(0, 120)}，${delay}ms 后重试...`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

export default createSendFileTool({
  name: 'discord_send_file',
  platform: 'Discord',
  description:
    '搜索本地文件并通过 Discord Bot 发送给用户。\n' +
    '【何时调用】Discord 会话中（消息含 [来源：Discord | ...] 标签），\n' +
    '用户要求发送某个文件时（"把 XX 发给我"、"发送 XX 文件" 等）。\n' +
    '【参数选择】\n' +
    '  • 已知完整路径 → 填 file_path（直接发送，不搜索）\n' +
    '  • 只知道文件名 → 填 file_name（Skill 自动在 Desktop/Downloads/Documents 搜索）\n' +
    '【channel_id】从消息标签"频道："字段直接取，不要猜测。\n' +
    '【截图发送】用户要求发送桌面截图时，填 screenshot=true，无需 file_path/file_name。\n' +
    '【不要用的场景】无 Discord 标签的桌面聊天不要调用此 Skill。',
  targetParam: 'channel_id',
  targetDescription: '目标 Discord 频道 ID，从消息标签 [来源：Discord | 频道：xxx | ...] 中取',
  describeTarget: (channelId) => `频道 ${channelId} `,
  isOnline: () => DiscordAdapter.activeClient !== null,

  async send(channelId, filePath, message) {
    const client = DiscordAdapter.activeClient!;
    const channel = await retryNetworkOp(() => client.channels.fetch(channelId));
    if (!channel || !('send' in channel) || typeof channel.send !== 'function') {
      throw new Error(`频道 ${channelId} 不可发送消息。`);
    }
    await retryNetworkOp<unknown>(() => channel.send({
      content: message,
      // 每次重试重新构建附件，避免内部流状态问题
      files: [new AttachmentBuilder(filePath, { name: path.basename(filePath) })],
    }));
  },

  describeError(error, filePath) {
    // 常见：文件超过 Discord 免费服务器 8MB 限制
    if (/too large|payload|size/i.test(error.message)) {
      return `❌ 文件过大无法发送（Discord 免费服务器限制 8MB）：${path.basename(filePath)}`;
    }
    return undefined;
  },
});
