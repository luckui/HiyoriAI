import { randomUUID } from 'node:crypto';
import { getReplyTargetForConversation } from '../../bridges/asyncDelivery';
import { getMinecraftGoalController } from '../../minecraft/goalContext';
import {
  discoverLanRooms,
  minecraftRuntime,
  type MinecraftActionInstruction,
  type MinecraftActionName,
  type MinecraftActionResult,
  type MinecraftCommandOrigin,
  type MinecraftEnvironmentSnapshot,
  type MinecraftStatus,
} from '../../minecraft';
import { ToolTerminalError, type ToolContext, type ToolDefinition, type ToolResourceClaim } from '../types';

type MinecraftCompanionAction =
  | 'connect'
  | 'disconnect'
  | 'status'
  | 'say'
  | 'snapshot'
  | 'scan_blocks'
  | 'search_block'
  | 'search_entity'
  | 'navigate_to_player'
  | 'follow_player'
  | 'equip'
  | 'drop_item'
  | 'stop';

type MinecraftTaskAction =
  | 'approach_entity'
  | 'attack_entity'
  | 'collect_item'
  | 'craft_item'
  | 'smelt_item'
  | 'place_block'
  | 'pickup_drops';

interface MinecraftCompanionParams {
  action: MinecraftCompanionAction | MinecraftTaskAction;
  owner?: string;
  host?: string;
  port?: number;
  message?: string;
  player?: string;
  block?: string;
  entity?: string;
  radius?: number;
  vertical_radius?: number;
  count?: number;
  quantity?: number;
  item?: string;
  position?: { x: number; y: number; z: number };
  face?: string;
  range?: number;
  action_id?: string;
}

const IMMEDIATE_ACTIONS = new Set<MinecraftActionName>([
  'scan_blocks',
  'search_block',
  'search_entity',
]);

const TASK_ACTIONS = new Set<MinecraftActionName>([
  'approach_entity',
  'attack_entity',
  'collect_item',
  'craft_item',
  'smelt_item',
  'place_block',
  'pickup_drops',
]);

const MINECRAFT_BODY_RESOURCE = 'minecraft:body';
const MINECRAFT_CONTROL_RESOURCE = 'minecraft:control';
const NON_BODY_ACTIONS = new Set<MinecraftCompanionAction>([
  'status',
  'snapshot',
  'scan_blocks',
  'search_block',
  'search_entity',
  'say',
]);

const MAIN_BODY_CONTROL_ACTIONS = new Set<MinecraftCompanionAction>([
  'connect',
  'disconnect',
  'navigate_to_player',
  'follow_player',
  'equip',
  'drop_item',
]);

function minecraftCompanionResources(
  params: MinecraftCompanionParams,
  context?: ToolContext,
): ToolResourceClaim[] {
  if (NON_BODY_ACTIONS.has(params.action as MinecraftCompanionAction)) return [];
  return [{
    key: context?.executor === 'child' ? MINECRAFT_BODY_RESOURCE : MINECRAFT_CONTROL_RESOURCE,
    access: 'exclusive',
  }];
}

// 主智能体与子智能体共有的轻量物品动作：切换手持物品、丢物品给玩家。
const COMMON_ACTIONS = new Set<MinecraftActionName>(['equip', 'drop_item']);

const minecraftCompanionTool: ToolDefinition<MinecraftCompanionParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'minecraft_companion',
      description:
        'Immediate Minecraft perception and control for Hiyori. Use this for connecting, observing, searching, moving to the player, following, switching the held item, dropping items for the player, speaking, or stopping. Goals that require repeated physical progress or verification belong to minecraft_goal. Ordinary replies never move the game character.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'connect',
              'disconnect',
              'status',
              'say',
              'snapshot',
              'scan_blocks',
              'search_block',
              'search_entity',
              'navigate_to_player',
              'follow_player',
              'equip',
              'drop_item',
              'stop',
            ],
            description:
              'Use snapshot for body/player/entity context; scan_blocks when a nearby block name is unknown; search actions for named targets; navigate_to_player for one movement; follow_player for persistent following; equip to hold an item in hand or automatically wear armor (helmet/chestplate/leggings/boots); drop_item to drop inventory items so the player can pick them up; stop to cancel movement and disable following.',
          },
          owner: { type: 'string', description: 'Player Hiyori belongs with when connecting.' },
          host: { type: 'string', description: 'Minecraft LAN host. Omit with port to discover rooms.' },
          port: { type: 'integer', description: 'Minecraft LAN port.' },
          message: { type: 'string', description: 'Minecraft chat text for say.' },
          player: { type: 'string', description: 'Player name for navigation or following.' },
          block: { type: 'string', description: 'Minecraft block ID returned by scan_blocks or search_block.' },
          item: { type: 'string', description: 'Item name to hold or wear (equip) or drop (drop_item), e.g. wooden_pickaxe, iron_chestplate or cobblestone.' },
          radius: { type: 'integer', description: 'Search or action radius in blocks.' },
          vertical_radius: { type: 'integer', description: 'Vertical scan radius for scan_blocks.' },
          count: { type: 'integer', description: 'Maximum search results; for drop_item, how many items to drop.' },
          range: { type: 'number', description: 'Desired distance from a player or entity.' },
        },
        required: ['action'],
      },
    },
  },

  execution: { resources: minecraftCompanionResources },

  async execute(params, context?: ToolContext) {
    if (
      context?.executor === 'child'
      && (params.action === 'connect' || params.action === 'disconnect')
    ) {
      return toolResult(
        'unavailable',
        'Minecraft room connection lifecycle belongs to the main Hiyori runtime.',
      );
    }
    const origin = commandOrigin(context);
    // Child-task actions must not overwrite the main conversation origin used for
    // in-game chat routing; otherwise later chat turns get routed into a dead task.
    if (context?.executor !== 'child') minecraftRuntime.rememberOrigin(origin);

    if (
      context?.executor !== 'child'
      && MAIN_BODY_CONTROL_ACTIONS.has(params.action as MinecraftCompanionAction)
    ) {
      await getMinecraftGoalController().cancel(`body_control:${params.action}`);
    }

    if (params.action === 'connect') return connectToMinecraftRoom(params);
    if (params.action === 'disconnect') {
      await minecraftRuntime.command('disconnect', {});
      return toolResult('disconnected', 'Hiyori left the Minecraft room.');
    }
    if (params.action === 'status') {
      const status = await minecraftRuntime.command<MinecraftStatus>('status', {});
      return toolResult('completed', formatStatus(status));
    }
    if (params.action === 'say') {
      const message = requiredText(params.message, 'message');
      await minecraftRuntime.command('say', { message });
      return toolResult('completed', 'Minecraft chat message sent.');
    }
    if (params.action === 'snapshot') {
      const snapshot = await minecraftRuntime.command<MinecraftEnvironmentSnapshot>('snapshot', {});
      return toolResult('completed', formatSnapshot(snapshot));
    }
    if (params.action === 'follow_player') {
      const player = requiredText(params.player, 'player');
      await minecraftRuntime.command('follow', { player });
      return toolResult('persistent', `Following ${player}. This state remains active until stopped or replaced.`);
    }
    if (params.action === 'stop') {
      const cancelledGoal = context?.executor === 'child'
        ? false
        : await getMinecraftGoalController().cancel('minecraft_stop');
      await minecraftRuntime.command('stop', {});
      return toolResult(
        'stopped',
        cancelledGoal
          ? 'Current Minecraft goal and body behavior stopped.'
          : 'Current Minecraft movement or behavior stopped.',
      );
    }

    const instruction = createInstruction(params, context?.executor === 'child');
    if (
      IMMEDIATE_ACTIONS.has(instruction.name)
      || COMMON_ACTIONS.has(instruction.name)
      || instruction.name === 'navigate_to_player'
    ) {
      const actionResult = await minecraftRuntime.command<MinecraftActionResult>(
        'execute-action',
        instruction,
        instruction.name === 'navigate_to_player'
          ? 0
          : instruction.name === 'drop_item'
            ? 30_000
            : 20_000,
      );
      return toolResult(actionResult.outcome, formatActionResult(actionResult));
    }
    if (TASK_ACTIONS.has(instruction.name)) {
      return toolResult('delegate_required', [
        `Minecraft 动作 ${instruction.name} 属于需要连续验证的游戏目标。`,
        '请使用 minecraft_goal(action="set", title="...", instruction="...") 设置或替换当前目标。',
        '目标会持续使用真实游戏动作，直到完成或明确无法继续。',
      ].join('\n'));
    }
    return toolResult('unsupported', `Unsupported Minecraft action: ${params.action}`);
  },
};

export const minecraftActionTool: ToolDefinition<MinecraftCompanionParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'minecraft_action',
      description:
        'Observe the connected Minecraft world or perform one finite body action and wait for its factual terminal result. The main Hiyori runtime owns connecting and disconnecting; this child-task tool cannot change the room lifecycle.',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'snapshot',
              'scan_blocks',
              'search_block',
              'search_entity',
              'approach_entity',
              'attack_entity',
              'collect_item',
              'craft_item',
              'smelt_item',
              'place_block',
              'pickup_drops',
              'equip',
              'drop_item',
            ],
            description:
              'One finite Minecraft action. attack_entity auto-guides to the nearest matching entity, attacks, and picks up drops; collect_item auto-locates source blocks, expands its loaded-area search radius when needed, and keeps collecting until the requested NEW item quantity is reached or no source blocks remain（无需调用 search_block）; craft_item auto-plans and crafts the item (including intermediate materials, a crafting table and furnace smelting when needed); smelt_item smelts furnace products (e.g. iron_ore -> iron_ingot) in a furnace with fuel; place_block places an inventory block on the ground nearby or at an explicit position. Every action returns one factual terminal result.',
          },
          block: {
            type: 'string',
            description:
              'Source block/item name (e.g. tallgrass, iron_ore or porkchop). For collect_item: with block, collect that block\u2019s drops; with item, the runtime resolves which blocks drop it. For smelt_item: with block, process that furnace input; with item, the runtime resolves the furnace input.',
          },
          item: {
            type: 'string',
            description:
              'Target item name: for collect_item, the drop item (e.g. wheat_seeds) whose source blocks the runtime resolves; for smelt_item, the furnace output (e.g. iron_ingot or cooked_porkchop). Either block or item is required for collect_item/smelt_item.',
          },
          entity: { type: 'string', description: 'Exact entity name observed through Minecraft perception.' },
          position: {
            type: 'object',
            properties: {
              x: { type: 'integer' },
              y: { type: 'integer' },
              z: { type: 'integer' },
            },
            description: 'place_block 可选精确落点；不填时自动找附近合适空地。',
          },
          face: {
            type: 'string',
            enum: ['auto', 'top', 'bottom', 'north', 'south', 'east', 'west'],
            description: 'place_block 放置面：auto 自动（优先地面，其次墙面）；也可指定上下/四面。',
          },
          radius: { type: 'integer', description: 'Action radius in blocks.' },
          quantity: {
            type: 'integer',
            description:
              'collect_item: how many NEW items to gain, regardless of the inventory total. attack_entity: how many targets to kill in one call (e.g. 3 sheep); the bot auto-approaches each nearest target, kills it, picks up the drops, and repeats until the count is reached. craft_item: how many copies to craft. smelt_item: how many furnace outputs to produce. Defaults to 1.',
          },
          range: { type: 'number', description: 'Desired distance from an entity.' },
          vertical_radius: { type: 'integer', description: 'Vertical scan radius for scan_blocks.' },
          count: { type: 'integer', description: 'Maximum search results; for drop_item, how many items to drop.' },
          player: { type: 'string', description: 'Player name for drop_item delivery.' },
        },
        required: ['action'],
      },
    },
  },

  execution: {
    resources: () => [{ key: MINECRAFT_BODY_RESOURCE, access: 'exclusive' }],
  },

  async execute(params, context?: ToolContext) {
    if (context?.executor !== 'child') {
      return toolResult('unavailable', 'Finite Minecraft goal actions require a Minecraft child task.');
    }
    if (params.action === 'snapshot') {
      const snapshot = await minecraftRuntime.command<MinecraftEnvironmentSnapshot>('snapshot', {});
      return toolResult('completed', formatSnapshot(snapshot));
    }
    const instruction = createInstruction(params, true);
    if (
      !TASK_ACTIONS.has(instruction.name)
      && !IMMEDIATE_ACTIONS.has(instruction.name)
      && !COMMON_ACTIONS.has(instruction.name)
    ) {
      return toolResult('unsupported', `Unsupported Minecraft task action: ${params.action}`);
    }
    if (IMMEDIATE_ACTIONS.has(instruction.name) || COMMON_ACTIONS.has(instruction.name)) {
      const actionResult = await minecraftRuntime.command<MinecraftActionResult>(
        'execute-action',
        instruction,
        instruction.name === 'drop_item' ? 30_000 : 20_000,
      );
      return toolResult(actionResult.outcome, formatActionResult(actionResult));
    }
    const actionResult = await executeTaskAction(instruction, context.signal);
    if (actionResult.error?.code === 'died') {
      throw new ToolTerminalError(formatActionResult(actionResult));
    }
    return toolResult(actionResult.outcome, formatActionResult(actionResult));
  },
};

async function executeTaskAction(
  instruction: MinecraftActionInstruction,
  signal?: AbortSignal,
): Promise<MinecraftActionResult> {
  if (signal?.aborted) {
    const error = new Error('Minecraft child task was cancelled before the action started.');
    error.name = 'AbortError';
    throw error;
  }
  const cancel = (): void => {
    void minecraftRuntime.command('cancel-action', { actionId: instruction.id });
  };
  signal?.addEventListener('abort', cancel, { once: true });
  try {
    return await minecraftRuntime.command<MinecraftActionResult>(
      'execute-action',
      instruction,
      0,
    );
  } finally {
    signal?.removeEventListener('abort', cancel);
  }
}

function createInstruction(params: MinecraftCompanionParams, fromTask = false): MinecraftActionInstruction {
  const id = randomUUID();
  switch (params.action) {
    case 'scan_blocks':
      return instruction(id, 'scan_blocks', compact({
        radius: params.radius,
        verticalRadius: params.vertical_radius,
        limit: params.count,
      }), fromTask);
    case 'search_block':
      return instruction(id, 'search_block', compact({
        block: requiredText(params.block, 'block'),
        radius: params.radius,
        count: params.count,
      }), fromTask);
    case 'search_entity':
      return instruction(id, 'search_entity', compact({
        entity: requiredText(params.entity, 'entity'),
        radius: params.radius,
      }), fromTask);
    case 'navigate_to_player':
      return instruction(id, 'navigate_to_player', compact({
        player: requiredText(params.player, 'player'),
        range: params.range,
      }), fromTask);
    case 'approach_entity':
      return instruction(id, 'approach_entity', compact({
        entity: requiredText(params.entity, 'entity'),
        radius: params.radius,
        range: params.range,
      }), fromTask);
    case 'attack_entity':
      return instruction(id, 'attack_entity', compact({
        entity: requiredText(params.entity, 'entity'),
        radius: params.radius,
        quantity: params.quantity ?? 1,
        kill: true,
      }), fromTask);
    case 'collect_item':
      if (!params.block?.trim() && !params.item?.trim()) {
        throw new Error('Missing Minecraft parameter: block or item');
      }
      return instruction(id, 'collect_item', compact({
        block: params.block,
        item: params.item,
        maxCount: params.quantity ?? 8,
        radius: params.radius,
      }), fromTask);
    case 'craft_item':
      return instruction(id, 'craft_item', compact({
        item: requiredText(params.item, 'item'),
        maxCount: params.quantity ?? 1,
      }), fromTask);
    case 'smelt_item':
      if (!params.block?.trim() && !params.item?.trim()) {
        throw new Error('Missing Minecraft parameter: block or item');
      }
      return instruction(id, 'smelt_item', compact({
        block: params.block,
        item: params.item,
        quantity: params.quantity ?? 1,
      }), fromTask);
    case 'place_block':
      return instruction(id, 'place_block', compact({
        block: requiredText(params.block, 'block'),
        position: params.position,
        face: params.face,
      }), fromTask);
    case 'pickup_drops':
      return instruction(id, 'pickup_drops', compact({ radius: params.radius }), fromTask);
    case 'equip':
      return instruction(id, 'equip', compact({
        item: requiredText(params.item, 'item'),
      }), fromTask);
    case 'drop_item':
      return instruction(id, 'drop_item', compact({
        item: requiredText(params.item, 'item'),
        count: params.count,
        player: params.player,
      }), fromTask);
    default:
      throw new Error(`Minecraft action does not create an instruction: ${params.action}`);
  }
}

function instruction(
  id: string,
  name: MinecraftActionName,
  args: Record<string, unknown>,
  task = false,
): MinecraftActionInstruction {
  return task ? { id, name, args, task: true } : { id, name, args };
}

function commandOrigin(context?: ToolContext): MinecraftCommandOrigin {
  const conversationId = context?.conversationId || 'default';
  return {
    conversationId,
    replyTarget: getReplyTargetForConversation(conversationId) ?? { kind: 'desktop' },
  };
}

async function connectToMinecraftRoom(params: MinecraftCompanionParams): Promise<string> {
  let host = params.host?.trim();
  let port = params.port;
  if (!host || !port) {
    const rooms = await discoverLanRooms();
    if (rooms.length === 0) {
      return toolResult(
        'room_not_found',
        'Open the Minecraft Java world to LAN, then try connecting again.',
      );
    }
    if (rooms.length > 1) {
      const choices = rooms.map(
        (room, index) => `${index + 1}. ${room.motd || 'Minecraft LAN'}\n   ${room.host}:${room.port}`,
      );
      return toolResult('user_choice_required', choices.join('\n\n'));
    }
    host = rooms[0].host;
    port = rooms[0].port;
  }

  const status = await minecraftRuntime.command<MinecraftStatus>('connect', {
    host,
    port,
    username: 'Hiyori',
    owner: params.owner?.trim() || undefined,
  }, 60_000);
  return toolResult('connected', formatStatus(status));
}

function formatStatus(status: MinecraftStatus): string {
  if (!status.connected) return 'Hiyori is not connected to Minecraft.';
  const behavior = !status.behavior || status.behavior.kind === 'idle'
    ? 'idle'
    : status.behavior.kind === 'follow'
      ? `following ${status.behavior.player}`
      : `collecting ${status.behavior.block} (${status.behavior.collected}/${status.behavior.requested})`;
  return [
    'Hiyori is connected to Minecraft.',
    `Players: ${status.players.join(', ') || 'none visible'}`,
    `Behavior: ${behavior}`,
    status.health === undefined ? undefined : `Health: ${status.health}`,
    status.food === undefined ? undefined : `Food: ${status.food}`,
  ].filter(Boolean).join('\n');
}

function formatSnapshot(snapshot: MinecraftEnvironmentSnapshot): string {
  if (!snapshot.connection.connected) return 'Hiyori is not connected to Minecraft.';
  const owner = snapshot.owner?.visible
    ? `${snapshot.owner.name} is ${number(snapshot.owner.distance)} blocks away.`
    : snapshot.owner?.name
      ? `${snapshot.owner.name} is not visible.`
      : 'No owner is selected.';
  const entities = snapshot.nearby.entities
    .slice(0, 12)
    .map((entity) => `${entity.name}@${number(entity.distance)}`)
    .join(', ') || 'none';
  const inventory = snapshot.body?.inventory;
  const inventoryLine = inventory && Object.keys(inventory).length
    ? `Inventory: ${Object.entries(inventory)
        .sort(([leftName, leftCount], [rightName, rightCount]) =>
          rightCount - leftCount || leftName.localeCompare(rightName))
        .map(([name, count]) => `${name} x${count}`)
        .join(', ')}`
    : 'Inventory: (empty)';
  const actionLine = snapshot.action
    ? `Current action: ${snapshot.action.name} (${snapshot.action.state})`
    : 'Current action: none';
  return [
    owner,
    snapshot.body ? `Position: ${snapshot.body.position.x}, ${snapshot.body.position.y}, ${snapshot.body.position.z}` : undefined,
    snapshot.body ? `Health: ${snapshot.body.health}; Food: ${snapshot.body.food}` : undefined,
    snapshot.body ? inventoryLine : undefined,
    actionLine,
    `Nearby entities: ${entities}`,
    'Use scan_blocks or search_block when block information is needed.',
  ].filter(Boolean).join('\n');
}

function formatActionResult(result: MinecraftActionResult): string {
  const observations = (result.observations ?? []).map((fact) => fact.text).filter(Boolean);
  const inventoryDelta = Object.entries(result.inventoryDelta ?? {})
    .map(([name, count]) => `${name} ${count >= 0 ? '+' : ''}${count}`)
    .join(', ');
  const worldChanges = (result.worldChanges ?? [])
    .map((change) => {
      const verb = change.kind === 'block_broken'
        ? 'broke'
        : change.kind === 'block_placed'
          ? 'placed'
          : change.kind === 'item_picked_up'
            ? 'picked up'
            : 'hit';
      return `${verb} ${change.count ?? ''} ${change.name}`.trim();
    })
    .join(', ');
  return [
    `Action ID: ${result.actionId}`,
    `Summary: ${result.summary}`,
    inventoryDelta ? `Inventory change: ${inventoryDelta}` : undefined,
    worldChanges ? `World changes: ${worldChanges}` : undefined,
    observations.length ? `Observations:\n${observations.map((text) => `- ${text}`).join('\n')}` : undefined,
    result.error ? `Error: ${result.error.code}` : undefined,
    result.error?.details.message ? `Error detail: ${String(result.error.details.message)}` : undefined,
  ].filter(Boolean).join('\n');
}

function compact(values: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(values).filter(([, value]) => value !== undefined));
}

function requiredText(value: string | undefined, name: string): string {
  const text = value?.trim();
  if (!text) throw new Error(`Missing Minecraft parameter: ${name}`);
  return text;
}

function toolResult(status: string, details: string): string {
  return `【工具结果】\n状态：${status}\n${details}`;
}

function number(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'unknown';
}

export default minecraftCompanionTool;
