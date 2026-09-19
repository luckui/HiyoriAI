/**
 * Skill: wechat_send_file —— 搜索本地文件（或截图）并通过微信 Bot 发给用户。
 * 通用流程见 tools/sendFileTool.ts；微信文件通过 AES-128-ECB 加密 CDN 传输（见 WeChatAdapter.sendFile）。
 */

import { createSendFileTool } from '../sendFileTool';
import { WeChatAdapter } from '../../bridges/adapters/wechat';

export default createSendFileTool({
  name: 'wechat_send_file',
  platform: 'WeChat',
  description:
    '搜索本地文件并通过微信 Bot 发送给用户。\n' +
    '【何时调用】微信会话中（消息含 [来源：WeChat | ...] 标签），\n' +
    '用户要求发送某个文件时（"把 XX 发给我"、"发送 XX 文件" 等）。\n' +
    '【参数选择】\n' +
    '  • 已知完整路径 → 填 file_path（直接发送，不搜索）\n' +
    '  • 只知道文件名 → 填 file_name（Skill 自动在 Desktop/Downloads/Documents 搜索）\n' +
    '【user_id】从消息标签"用户："字段直接取，不要猜测。\n' +
    '【截图发送】用户要求发送桌面截图时，填 screenshot=true，无需 file_path/file_name。\n' +
    '【不要用的场景】无 WeChat 标签的桌面聊天不要调用此 Skill。',
  targetParam: 'user_id',
  targetDescription: '目标微信用户 ID，从消息标签 [来源：WeChat | 用户：xxx] 中取',
  describeTarget: (userId) => `微信用户 ${userId.slice(0, 8)}*** `,
  isOnline: () => WeChatAdapter.activeAdapter !== null,

  async send(userId, filePath, message) {
    const adapter = WeChatAdapter.activeAdapter!;
    if (message) await adapter.sendText(userId, message);
    await adapter.sendFile(userId, filePath);
  },
});
