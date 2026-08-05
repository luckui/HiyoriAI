import { getReplyTargetForConversation } from '../../bridges/asyncDelivery';
import {
  discoverLanRooms,
  minecraftRuntime,
  type MinecraftCommandOrigin,
  type MinecraftStatus,
} from '../../minecraft';
import type { ToolContext, ToolDefinition } from '../types';

type MinecraftCompanionAction =
  | 'connect'
  | 'disconnect'
  | 'status'
  | 'say'
  | 'follow'
  | 'collect'
  | 'stop';

interface MinecraftCompanionParams {
  action: MinecraftCompanionAction;
  owner?: string;
  host?: string;
  port?: number;
  player?: string;
  message?: string;
  block?: string;
  quantity?: number;
  radius?: number;
}

const minecraftCompanionTool: ToolDefinition<MinecraftCompanionParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'minecraft_companion',
      description:
        "Control Hiyori's persistent Minecraft companion body. A command changes the body's state once; movement and survival continue in Minecraft. Collection reports its final outcome later. Use status only when the user asks about the current game state.",
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['connect', 'disconnect', 'status', 'say', 'follow', 'collect', 'stop'],
            description:
              'connect joins a Java LAN room; follow and collect start persistent behavior; stop returns the body to idle.',
          },
          owner: {
            type: 'string',
            description: 'Player Hiyori should treat as the owner when several humans are present.',
          },
          host: {
            type: 'string',
            description: 'LAN server host selected by the user. Omit to discover rooms automatically.',
          },
          port: { type: 'integer', description: 'LAN server port selected by the user.' },
          player: { type: 'string', description: 'Visible Minecraft player name for follow.' },
          message: { type: 'string', description: 'Text Hiyori should say in Minecraft chat.' },
          block: {
            type: 'string',
            description: 'Minecraft registry block name, for example oak_log or coal_ore.',
          },
          quantity: { type: 'integer', description: 'Number of blocks to collect, from 1 to 64.' },
          radius: {
            type: 'integer',
            description: 'Search radius in blocks, from 1 to 64. Defaults to 32.',
          },
        },
        required: ['action'],
      },
    },
  },

  async execute(params, context?: ToolContext) {
    const origin = commandOrigin(context);

    if (params.action === 'connect') {
      let host = params.host?.trim();
      let port = params.port;
      if (!host || !port) {
        const rooms = await discoverLanRooms();
        if (rooms.length === 0) {
          return result(
            '未发现房间',
            '回复用户',
            '请先在 Minecraft Java 世界中开启“对局域网开放”，然后告诉我房间已经开启。',
          );
        }
        if (rooms.length > 1) {
          const choices = rooms.map(
            (room, index) => `${index + 1}. ${room.motd || 'Minecraft LAN'}\n   ${room.host}:${room.port}`,
          );
          return result(
            '需要用户选择',
            '询问用户',
            `发现了多个 Minecraft 局域网房间，请选择一个：\n\n${choices.join('\n\n')}`,
          );
        }
        host = rooms[0].host;
        port = rooms[0].port;
      }

      minecraftRuntime.rememberOrigin(origin);
      const status = await minecraftRuntime.command<MinecraftStatus>('connect', {
        host,
        port,
        username: 'Hiyori',
        owner: params.owner?.trim() || undefined,
      });
      if (!params.owner && status.players.length > 1) {
        return result(
          '已连接，需要确认主人',
          '询问用户',
          `已加入 Minecraft 房间。当前有多位玩家：${status.players.join('、')}。请选择 Hiyori 应跟随哪位主人。`,
        );
      }
      return result(
        '已连接',
        '回复用户',
        `已加入 Minecraft 房间${status.players.length ? `，看到了 ${status.players.join('、')}` : ''}。`,
      );
    }

    minecraftRuntime.rememberOrigin(origin);
    if (params.action === 'disconnect') {
      await minecraftRuntime.command('disconnect', {});
      return result('已断开', '回复用户', 'Hiyori 已离开 Minecraft 房间。');
    }
    if (params.action === 'status') {
      const status = await minecraftRuntime.command<MinecraftStatus>('status', {});
      return result('已查询', '回复用户', formatStatus(status));
    }
    if (params.action === 'say') {
      if (!params.message?.trim()) return missing('要在 Minecraft 中发送的消息');
      await minecraftRuntime.command('say', { message: params.message.trim() });
      return result('已发送', '回复用户', '消息已发到 Minecraft 聊天。');
    }
    if (params.action === 'follow') {
      if (!params.player?.trim()) return missing('要跟随的玩家名');
      await minecraftRuntime.command('follow', { player: params.player.trim() });
      return result('正在跟随', '回复用户', `Hiyori 正在跟随 ${params.player.trim()}。`);
    }
    if (params.action === 'collect') {
      if (!params.block?.trim()) return missing('要采集的方块名称');
      if (!params.quantity) return missing('要采集的数量');
      const accepted = await minecraftRuntime.startCollection(
        { block: params.block.trim(), quantity: params.quantity, radius: params.radius },
        origin,
      );
      return result(
        '正在执行',
        '回复用户',
        `Hiyori 已开始采集 ${accepted.quantity ?? params.quantity} 个 ${accepted.block ?? params.block}，完成后会自动带回结果。`,
      );
    }
    if (params.action === 'stop') {
      await minecraftRuntime.command('stop', {});
      return result('已停止', '回复用户', 'Hiyori 已停止当前 Minecraft 动作。');
    }
    return result('无法处理', '回复用户', '不支持的 Minecraft 操作。');
  },
};

function commandOrigin(context?: ToolContext): MinecraftCommandOrigin {
  const conversationId = context?.conversationId || 'default';
  return {
    conversationId,
    replyTarget: getReplyTargetForConversation(conversationId) ?? { kind: 'desktop' },
  };
}

function result(status: string, next: string, text: string): string {
  return `【工具结果】\n状态：${status}\n下一步：${next}\n建议回复：\n${text}`;
}

function missing(field: string): string {
  return result('需要补充信息', '询问用户', `请告诉我${field}。`);
}

function formatStatus(status: MinecraftStatus): string {
  if (!status.connected) return 'Hiyori 当前没有连接 Minecraft。';
  const behavior =
    status.behavior.kind === 'idle'
      ? '空闲'
      : status.behavior.kind === 'follow'
        ? `跟随 ${status.behavior.player}`
        : `采集 ${status.behavior.block}（${status.behavior.collected}/${status.behavior.requested}）`;
  return [
    'Hiyori 已连接 Minecraft。',
    `玩家：${status.players.join('、') || '未看到其他玩家'}`,
    `当前动作：${behavior}`,
    status.health === undefined ? undefined : `生命：${status.health}`,
    status.food === undefined ? undefined : `饥饿：${status.food}`,
  ]
    .filter(Boolean)
    .join('\n');
}

export default minecraftCompanionTool;
