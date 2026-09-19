/**
 * Skill: feishu_send_file —— 搜索本地文件（或截图）并发送到触发本轮对话的飞书会话。
 * 通用流程见 tools/sendFileTool.ts。
 */

import { createSendFileTool } from '../sendFileTool';
import { FeishuAdapter } from '../../bridges/adapters/feishu';

export default createSendFileTool({
  name: 'feishu_send_file',
  platform: 'Feishu',
  description:
    '搜索本地文件并通过 Lark / Feishu Bot 发送给用户。\n' +
    '【何时调用】飞书会话中（消息含 [来源：Lark / Feishu | ...] 标签），用户要求发送文件或桌面截图时调用。\n' +
    '【参数选择】已知完整路径填 file_path；只知道文件名填 file_name；发送当前桌面截图填 screenshot=true。\n' +
    '【chat_id】从消息标签“聊天：”字段直接取，不要猜测。\n' +
    '【不要用的场景】无 Lark / Feishu 标签的桌面聊天不要调用此工具。',
  targetParam: 'chat_id',
  targetDescription: '目标飞书 chat_id，从 [来源：Lark / Feishu | 聊天：xxx | 用户：xxx] 中取',
  describeTarget: (chatId) => `飞书会话 ${chatId} `,
  isOnline: () => FeishuAdapter.activeAdapter !== null,

  async send(chatId, filePath, message) {
    const adapter = FeishuAdapter.activeAdapter!;
    if (message) await adapter.sendText(chatId, message);
    await adapter.sendFile(chatId, filePath);
  },
});
