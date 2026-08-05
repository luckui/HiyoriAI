import { randomUUID } from 'node:crypto';
import { getReplyTargetForConversation } from '../../bridges/asyncDelivery';
import {
  discoverLanRooms,
  getMinecraftGoalCoordinator,
  minecraftRuntime,
  type MinecraftCommandOrigin,
  type MinecraftGoalOrigin,
  type MinecraftStatus,
} from '../../minecraft';
import type { ToolContext, ToolDefinition } from '../types';

type MinecraftCompanionAction =
  | 'connect'
  | 'disconnect'
  | 'status'
  | 'say'
  | 'start_goal'
  | 'stop_goal';

interface MinecraftCompanionParams {
  action: MinecraftCompanionAction;
  owner?: string;
  host?: string;
  port?: number;
  message?: string;
  task?: string;
  goal_id?: string;
}

const activeGoalByConversation = new Map<string, string>();

const minecraftCompanionTool: ToolDefinition<MinecraftCompanionParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'minecraft_companion',
      description:
        "Connect Hiyori's Minecraft companion body and start or stop natural-language Minecraft goals. Use start_goal for gameplay requests such as following the player, collecting nearby blocks, inspecting surroundings, farming, or helping with survival.",
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['connect', 'disconnect', 'status', 'say', 'start_goal', 'stop_goal'],
            description:
              'connect joins a Java LAN room; start_goal describes what Hiyori should do in Minecraft; stop_goal cancels the current goal.',
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
          message: { type: 'string', description: 'Text Hiyori should say in Minecraft chat.' },
          task: {
            type: 'string',
            description:
              'Natural-language Minecraft goal from the user, for example "follow me", "collect the nearby sugar cane", or "look around and tell me what you see".',
          },
          goal_id: {
            type: 'string',
            description: 'Goal id returned by start_goal. Omit to stop the latest goal in this conversation.',
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
    if (params.action === 'start_goal') {
      if (!params.task?.trim()) return missing('想让 Hiyori 在 Minecraft 里完成的事情');
      const coordinator = getMinecraftGoalCoordinator();
      if (!coordinator) {
        return result(
          '未就绪',
          '回复用户',
          'Minecraft 目标协调器还没有启动，请稍后再试。',
        );
      }
      const goalId = randomUUID();
      activeGoalByConversation.set(origin.conversationId, goalId);
      minecraftRuntime.rememberOrigin(origin);
      void coordinator.startGoal({
        id: goalId,
        title: 'Minecraft 目标',
        instruction: params.task.trim(),
        origin: goalOrigin(origin),
      }).catch((error) => {
        console.error('[Minecraft Companion] goal failed:', error instanceof Error ? error.message : String(error));
      });
      return result(
        '已开始',
        '回复用户',
        `已开始 Minecraft 目标。\n目标 ID：${goalId}\n完成或需要你决定时会主动告诉你。`,
      );
    }
    if (params.action === 'stop_goal') {
      const coordinator = getMinecraftGoalCoordinator();
      if (!coordinator) return result('未就绪', '回复用户', 'Minecraft 目标协调器还没有启动。');
      const goalId = params.goal_id?.trim() || activeGoalByConversation.get(origin.conversationId);
      if (!goalId) return missing('要停止的 Minecraft 目标 ID');
      await coordinator.stopGoal(goalId);
      activeGoalByConversation.delete(origin.conversationId);
      return result('已停止', '回复用户', `已请求停止 Minecraft 目标。\n目标 ID：${goalId}`);
    }
    if ((params.action as string) === 'collect' || (params.action as string) === 'follow') {
      return result(
        '无法处理',
        '回复用户',
        '请用 start_goal 描述想在 Minecraft 里完成的事情，例如“跟着我”或“帮我采附近的甘蔗”。',
      );
    }
    return result('无法处理', '回复用户', '不支持的 Minecraft 操作。请用 start_goal 描述目标。');
  },
};

function commandOrigin(context?: ToolContext): MinecraftCommandOrigin {
  const conversationId = context?.conversationId || 'default';
  return {
    conversationId,
    replyTarget: getReplyTargetForConversation(conversationId) ?? { kind: 'desktop' },
  };
}

function goalOrigin(origin: MinecraftCommandOrigin): MinecraftGoalOrigin {
  const replyKind = origin.replyTarget?.kind;
  const source =
    replyKind === 'discord' || replyKind === 'wechat' || replyKind === 'feishu' || replyKind === 'minecraft'
      ? replyKind
      : 'desktop';
  return {
    conversationId: origin.conversationId,
    replyTarget: origin.replyTarget,
    source,
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
