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
      parts.push(`[${id}]\nRuntime context unavailable: ${errorMessage(error)}`);
    }
  }
  return parts.join('\n\n');
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
      'Minecraft connection: disconnected.',
      'Hiyori 当前不在 Minecraft 游戏世界中。',
      '玩家要求加入游戏时，调用 minecraft_companion(action="connect")。',
      '连接成功前，不能声称当前位置、生命、饥饿、背包或游戏动作。',
    ].join('\n');
  }

  const lines = [
    'Minecraft connection: connected.',
    `Minecraft connected as ${snapshot.connection.username ?? 'unknown'} at ${snapshot.connection.host ?? 'unknown'}:${snapshot.connection.port ?? 'unknown'}.`,
    goal?.title ? `Current Minecraft goal: ${goal.title}.` : undefined,
    goal?.title ? `Goal state: ${goal.phase}. Objective: ${goal.instruction ?? goal.title}` : undefined,
    goal?.checkpoint ? formatGoalCheckpoint(goal.checkpoint) : undefined,
    snapshot.world ? `World: ${snapshot.world.dimension}${snapshot.world.biome ? `, biome ${snapshot.world.biome}` : ''}.` : undefined,
    snapshot.body
      ? `Body: position ${formatPosition(snapshot.body.position)}, health ${snapshot.body.health}, food ${snapshot.body.food}, inventory ${formatInventory(snapshot.body.inventory)}.`
      : undefined,
    snapshot.owner
      ? `Owner: ${snapshot.owner.name} ${snapshot.owner.visible ? `visible at ${formatNumber(snapshot.owner.distance)} blocks` : 'not visible'}${snapshot.owner.relativeDirection ? `, ${snapshot.owner.relativeDirection}` : ''}.`
      : undefined,
    `Follow: ${snapshot.follow.phase}${snapshot.follow.target ? ` ${snapshot.follow.target}` : ''}${typeof snapshot.follow.distance === 'number' ? ` at ${formatNumber(snapshot.follow.distance)} blocks` : ''}.`,
    snapshot.action
      ? `Current action: ${snapshot.action.name} (${snapshot.action.state}), arguments ${JSON.stringify(snapshot.action.args)}.`
      : 'Current action: none.',
    formatBlocks(snapshot),
    formatEntities(snapshot),
    formatEvents(snapshot),
  ];

  return lines.filter(Boolean).join('\n');
}

function formatGoalCheckpoint(checkpoint: NonNullable<MinecraftGoalPublicState['checkpoint']>): string {
  const delta = Object.entries(checkpoint.inventoryDelta)
    .map(([name, count]) => `${name} ${count > 0 ? '+' : ''}${count}`)
    .join(', ');
  return `Verified goal checkpoint: health ${checkpoint.health ?? 'unknown'}, food ${checkpoint.food ?? 'unknown'}, inventory changes ${delta || 'none'}.`;
}

function formatBlocks(snapshot: MinecraftEnvironmentSnapshot): string | undefined {
  if (!snapshot.nearby.blocks.length) return undefined;
  return `Visible blocks: ${snapshot.nearby.blocks
    .slice(0, 8)
    .map((block) => `${block.name} at ${formatNumber(block.distance)} blocks`)
    .join('; ')}.`;
}

function formatEntities(snapshot: MinecraftEnvironmentSnapshot): string | undefined {
  if (!snapshot.nearby.entities.length) return undefined;
  return `Visible entities: ${snapshot.nearby.entities
    .slice(0, 8)
    .map((entity) => `${entity.name}${entity.hostile ? ' hostile' : ''} at ${formatNumber(entity.distance)} blocks`)
    .join('; ')}.`;
}

function formatEvents(snapshot: MinecraftEnvironmentSnapshot): string | undefined {
  if (!snapshot.recentEvents.length) return undefined;
  return `Recent events: ${snapshot.recentEvents
    .slice(-5)
    .map((event) => `${event.kind}: ${event.text}`)
    .join('; ')}.`;
}

function formatPosition(position: { x: number; y: number; z: number }): string {
  return `${formatNumber(position.x)}, ${formatNumber(position.y)}, ${formatNumber(position.z)}`;
}

function formatInventory(inventory: Record<string, number>): string {
  const entries = Object.entries(inventory).filter(([, count]) => count > 0);
  if (!entries.length) return 'empty';
  return entries
    .slice(0, 10)
    .map(([name, count]) => `${name} x${count}`)
    .join(', ');
}

function formatNumber(value: number | undefined): string {
  return typeof value === 'number' && Number.isFinite(value) ? value.toFixed(1) : 'unknown';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
