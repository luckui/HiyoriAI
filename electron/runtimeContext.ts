import type { MinecraftEnvironmentSnapshot } from './minecraft/contracts';
import type { MinecraftGoalPublicState } from './minecraft/goalController';

export interface RuntimeContextScope {
  mode: string;
}

export type RuntimeContextProvider = (scope: RuntimeContextScope) => Promise<string | null>;

const providers = new Map<string, RuntimeContextProvider>();

export function registerRuntimeContextProvider(
  id: string,
  provider: RuntimeContextProvider,
): () => void {
  providers.set(id, provider);
  return () => {
    if (providers.get(id) === provider) providers.delete(id);
  };
}

export async function buildRuntimeContext(scope: RuntimeContextScope): Promise<string> {
  const parts: string[] = [];
  for (const [id, provider] of providers) {
    try {
      const text = (await provider(scope))?.trim();
      if (text) parts.push(`[${id}]\n${text}`);
    } catch (error) {
      parts.push(`[${id}]\n运行时上下文不可用：${errorMessage(error)}`);
    }
  }
  if (!parts.length) return '';
  return [
    '【游戏运行上下文｜本轮游戏事实的唯一依据】',
    parts.join('\n\n'),
  ].join('\n');
}

export function resetRuntimeContextProvidersForTest(): void {
  providers.clear();
}

export function formatMinecraftRuntimeContext(
  snapshot: MinecraftEnvironmentSnapshot | null,
  goal?: MinecraftGoalPublicState | null,
): string {
  if (!snapshot?.connection.connected) {
    return [
      '连接状态：未连接',
      ...formatGoal(goal),
      '当前动作：无（当前未进入游戏世界）',
      'Hiyori 当前不在 Minecraft 游戏世界中。',
      '玩家要求加入游戏时，调用 minecraft_companion(action="connect")。',
      '连接成功前，不能声称当前位置、生命、饥饿、背包或游戏动作。',
    ].join('\n');
  }

  const lines = [
    '连接状态：已连接',
    `连接信息：角色 ${snapshot.connection.username ?? '未知'}，地址 ${snapshot.connection.host ?? '未知'}:${snapshot.connection.port ?? '未知'}`,
    ...formatGoal(goal),
    goal?.checkpoint ? formatGoalCheckpoint(goal.checkpoint) : undefined,
    snapshot.world ? `世界：${formatDimension(snapshot.world.dimension)}${snapshot.world.biome ? `，生物群系 ${snapshot.world.biome}` : ''}` : undefined,
    snapshot.body
      ? `身体状态：位置 ${formatPosition(snapshot.body.position)}，生命 ${snapshot.body.health}，饥饿 ${snapshot.body.food}，背包 ${formatInventory(snapshot.body.inventory)}`
      : undefined,
    snapshot.owner
      ? `玩家：${snapshot.owner.name}，${snapshot.owner.visible ? `可见，距离 ${formatNumber(snapshot.owner.distance)} 格` : '当前不可见'}${snapshot.owner.relativeDirection ? `，方位 ${formatDirection(snapshot.owner.relativeDirection)}` : ''}`
      : undefined,
    `跟随状态：${formatFollow(snapshot.follow.phase)}${snapshot.follow.target ? ` ${snapshot.follow.target}` : ''}${typeof snapshot.follow.distance === 'number' ? `，距离 ${formatNumber(snapshot.follow.distance)} 格` : ''}`,
    snapshot.action
      ? `当前动作：${formatActionName(snapshot.action.name)}（${snapshot.action.name}，${formatState(snapshot.action.state)}），参数 ${JSON.stringify(snapshot.action.args)}`
      : '当前动作：无（当前没有正在执行的身体动作）',
    formatBlocks(snapshot),
    formatEntities(snapshot),
    formatEvents(snapshot),
  ];

  return lines.filter(Boolean).join('\n');
}

function formatGoal(goal?: MinecraftGoalPublicState | null): string[] {
  if (!goal?.title || goal.phase === 'idle') {
    return ['当前目标：无（当前尚未开始任何多步骤游戏目标）'];
  }
  return [
    `当前目标：${goal.title}`,
    `目标状态：${formatState(goal.phase)}`,
    `目标要求：${goal.instruction ?? goal.title}`,
  ];
}

function formatGoalCheckpoint(checkpoint: NonNullable<MinecraftGoalPublicState['checkpoint']>): string {
  const delta = Object.entries(checkpoint.inventoryDelta)
    .map(([name, count]) => `${name} ${count > 0 ? '+' : ''}${count}`)
    .join(', ');
  return `最近确认进度：生命 ${checkpoint.health ?? '未知'}，饥饿 ${checkpoint.food ?? '未知'}，背包变化 ${delta || '无'}`;
}

function formatBlocks(snapshot: MinecraftEnvironmentSnapshot): string | undefined {
  if (!snapshot.nearby.blocks.length) return undefined;
  return `附近方块：${snapshot.nearby.blocks
    .slice(0, 8)
    .map((block) => `${block.name}，距离 ${formatNumber(block.distance)} 格`)
    .join('；')}`;
}

function formatEntities(snapshot: MinecraftEnvironmentSnapshot): string | undefined {
  if (!snapshot.nearby.entities.length) return undefined;
  return `附近实体：${snapshot.nearby.entities
    .slice(0, 8)
    .map((entity) => `${entity.name}${entity.hostile ? '（敌对）' : ''}，距离 ${formatNumber(entity.distance)} 格`)
    .join('；')}`;
}

function formatEvents(snapshot: MinecraftEnvironmentSnapshot): string | undefined {
  if (!snapshot.recentEvents.length) return undefined;
  return `最近事件：${snapshot.recentEvents
    .slice(-5)
    .map((event) => `${event.kind}：${event.text}`)
    .join('；')}`;
}

function formatPosition(position: { x: number; y: number; z: number }): string {
  return `${formatNumber(position.x)}, ${formatNumber(position.y)}, ${formatNumber(position.z)}`;
}

function formatInventory(inventory: Record<string, number>): string {
  const entries = Object.entries(inventory).filter(([, count]) => count > 0);
  if (!entries.length) return '空';
  return entries
    .slice(0, 10)
    .map(([name, count]) => `${name} x${count}`)
    .join(', ');
}

function formatState(state: string): string {
  return ({
    idle: '无',
    starting: '启动中',
    running: '进行中',
    cancelling: '取消中',
    replacing: '切换中',
    paused: '已暂停',
    stopping: '停止中',
    cancelled: '已取消',
  } as Record<string, string>)[state] ?? state;
}

function formatFollow(phase: MinecraftEnvironmentSnapshot['follow']['phase']): string {
  return ({
    inactive: '未跟随',
    approaching: '正在接近',
    nearby: '正在跟随',
    recovering: '正在恢复跟随',
    blocked: '移动受阻',
    'target-lost': '暂时看不到目标',
  } as Record<MinecraftEnvironmentSnapshot['follow']['phase'], string>)[phase];
}

function formatActionName(action: NonNullable<MinecraftEnvironmentSnapshot['action']>['name']): string {
  return ({
    navigate_to_player: '前往玩家位置',
    follow_player: '跟随玩家',
    search_entity: '搜索实体',
    search_block: '搜索方块',
    scan_blocks: '查看附近方块',
    approach_entity: '接近实体',
    attack_entity: '攻击实体',
    wait: '等待',
    inspect: '观察环境',
    collect_item: '采集物品',
    pickup_drops: '拾取掉落物',
    craft_item: '合成物品',
    drop_item: '丢出物品',
    smelt_item: '熔炼物品',
    use_container: '使用容器',
    eat: '进食',
    equip: '装备物品',
    defend: '防御',
    retreat: '撤退',
    sleep: '睡觉',
    harvest_crop: '收获作物',
    till_soil: '耕地',
    sow_crop: '播种',
    place_block: '放置方块',
    break_block: '破坏方块',
    execute_blueprint: '建造蓝图',
  } as Record<string, string>)[action] ?? action;
}

function formatDimension(dimension: string): string {
  return ({
    overworld: '主世界',
    'minecraft:overworld': '主世界',
    the_nether: '下界',
    'minecraft:the_nether': '下界',
    the_end: '末地',
    'minecraft:the_end': '末地',
  } as Record<string, string>)[dimension] ?? dimension;
}

function formatDirection(direction: string): string {
  return ({
    north: '北',
    south: '南',
    east: '东',
    west: '西',
    'north-east': '东北',
    'north-west': '西北',
    'south-east': '东南',
    'south-west': '西南',
  } as Record<string, string>)[direction] ?? direction;
}

function formatNumber(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : '未知';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
