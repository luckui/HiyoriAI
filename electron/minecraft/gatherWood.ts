import { goals, Movements } from 'mineflayer-pathfinder';
import { protectMovementsFromFluid } from './fluidSafety';
import { Vec3 } from 'vec3';
import { patchedGoto, type PathfindResult } from './patchedGoto';

export interface GatherWoodResult {
  requested: number;
  before: number;
  after: number;
  collected: number;
  broken: Record<string, number>;
  navigationFailures: PathfindResult[];
}

export interface GatherWoodProgress {
  phase: 'inventory' | 'search' | 'navigate' | 'tree-scan' | 'dig' | 'pickup' | 'verify' | 'retry';
  message: string;
  level?: 'info' | 'warn' | 'error';
}

export type GatherWoodReporter = (progress: GatherWoodProgress) => void;

export interface GatherWoodDependencies {
  navigate?: typeof goToPosition;
}

export async function gatherWood(
  bot: any,
  num: number,
  maxDistance = 64,
  signal?: AbortSignal,
  report: GatherWoodReporter = () => undefined,
  dependencies: GatherWoodDependencies = {},
): Promise<GatherWoodResult> {
  const before = getLogsCount(bot);
  const broken: Record<string, number> = {};
  const navigationFailures: PathfindResult[] = [];
  let logsCount = before;
  let attempt = 0;
  const failedTargets = new Set<string>();
  const navigate = dependencies.navigate ?? goToPosition;
  report({ phase: 'inventory', message: `starting with ${before} logs; target +${num}` });

  while (logsCount - before < num) {
    attempt += 1;
    throwIfAborted(signal);
    report({ phase: 'search', message: `attempt ${attempt}: searching within ${maxDistance} blocks` });
    const woodBlock = findWoodBlock(bot, maxDistance, failedTargets);

    if (!woodBlock) {
      report({ phase: 'retry', level: 'warn', message: `attempt ${attempt}: no log found; moving to a new search area` });
      await moveAway(bot, 50, signal);
      continue;
    }

    report({
      phase: 'search',
      message: `attempt ${attempt}: found ${woodBlock.name} at ${formatPosition(woodBlock.position)}, distance ${formatDistance(bot.entity.position, woodBlock.position)}`,
    });

    const directlyReachable = canDigDirectly(bot, woodBlock);
    if (directlyReachable) {
      report({ phase: 'navigate', message: `attempt ${attempt}: target is directly reachable; skipping pathfinding` });
    } else {
      report({ phase: 'navigate', message: `attempt ${attempt}: starting pathfinding to ${formatPosition(woodBlock.position)}` });
      const navigation = await navigate(
        bot,
        woodBlock.position.x,
        woodBlock.position.y,
        woodBlock.position.z,
        2,
        signal,
        (info) => report({
          phase: 'navigate',
          message: `attempt ${attempt}: ${Math.round(info.elapsedMs / 1000)}s elapsed, distance ${info.distanceToTarget.toFixed(1)}, moved ${info.distanceTraveled.toFixed(1)}, stagnant ${info.stagnantTicks}/3`,
        }),
      );
      report({
        phase: 'navigate',
        level: navigation.ok ? 'info' : 'warn',
        message: `attempt ${attempt}: ${navigation.reason} after ${navigation.elapsedMs}ms; moved ${navigation.distanceTraveled.toFixed(1)}, remaining ${navigation.distanceToTarget.toFixed(1)}; ${navigation.message}`,
      });
      if (!navigation.ok) {
        navigationFailures.push(navigation);
        failedTargets.add(positionKey(woodBlock.position));
        report({ phase: 'retry', level: 'warn', message: `attempt ${attempt}: navigation failed; excluding ${formatPosition(woodBlock.position)} and searching another log` });
        continue;
      }
    }

    const nearbyTree = getNearestBlocks(bot, woodBlock.name, 4, 4);
    const selectedBlock = bot.blockAt(woodBlock.position);
    const tree = directlyReachable && selectedBlock?.name === woodBlock.name
      ? [selectedBlock, ...nearbyTree.filter((block) => positionKey(block.position) !== positionKey(selectedBlock.position))].slice(0, 4)
      : nearbyTree;
    report({ phase: 'tree-scan', message: `attempt ${attempt}: found ${tree.length} nearby ${woodBlock.name} blocks` });
    if (tree.length === 0) {
      report({ phase: 'retry', level: 'warn', message: `attempt ${attempt}: target disappeared after arrival; moving to a new search area` });
      await moveAway(bot, 15, signal);
      continue;
    }

    for (let index = 0; index < tree.length; index += 1) {
      const log = tree[index];
      throwIfAborted(signal);
      report({ phase: 'dig', message: `attempt ${attempt}: breaking ${index + 1}/${tree.length} ${log.name} at ${formatPosition(log.position)}` });
      let didBreak = false;
      try {
        didBreak = await breakBlockAt(bot, log, signal);
      } catch (error) {
        report({ phase: 'dig', level: 'error', message: `attempt ${attempt}: dig threw ${errorMessage(error)}` });
        throw error;
      }
      if (didBreak) broken[log.name] = (broken[log.name] ?? 0) + 1;
      report({ phase: 'dig', level: didBreak ? 'info' : 'warn', message: `attempt ${attempt}: ${didBreak ? 'broke' : 'could not break'} ${log.name} at ${formatPosition(log.position)}` });
      await sleep(1_200, signal);
    }
    report({ phase: 'pickup', message: `attempt ${attempt}: collecting nearby drops` });
    await pickupNearbyItems(bot, 8, signal);
    await sleep(2_500, signal);
    logsCount = getLogsCount(bot);
    report({ phase: 'verify', message: `attempt ${attempt}: inventory now ${logsCount} logs; gained ${logsCount - before}/${num}` });
  }

  return {
    requested: num,
    before,
    after: logsCount,
    collected: Math.max(0, logsCount - before),
    broken,
    navigationFailures,
  };
}

export function getLogsCount(bot: any): number {
  return (bot.inventory?.items?.() ?? [])
    .filter((item: any) => String(item.name).includes('log'))
    .reduce((total: number, item: any) => total + Number(item.count ?? 1), 0);
}

export function getNearestBlocks(
  bot: any,
  blockTypes: string[] | string,
  distance = 16,
  count = 10_000,
): any[] {
  const names = new Set(Array.isArray(blockTypes) ? blockTypes : [blockTypes]);
  const positions = bot.findBlocks({
    matching: (block: any) => block && names.has(block.name),
    maxDistance: distance,
    count,
  });
  return positions
    .map((position: any) => {
      const block = bot.blockAt(position);
      return block ? { block, distance: position.distanceTo(bot.entity.position) } : null;
    })
    .filter(Boolean)
    .sort((left: any, right: any) => left.distance - right.distance)
    .map((entry: any) => entry.block);
}

async function goToPosition(
  bot: any,
  x: number,
  y: number,
  z: number,
  minDistance: number,
  signal?: AbortSignal,
  onProgress?: Parameters<typeof patchedGoto>[2]['onProgress'],
): Promise<PathfindResult> {
  const targetBlock = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y), Math.floor(z)));
  const aboveOne = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y) + 1, Math.floor(z)));
  const aboveTwo = bot.blockAt(new Vec3(Math.floor(x), Math.floor(y) + 2, Math.floor(z)));
  if (targetBlock?.name !== 'air' && aboveOne?.name === 'air' && aboveTwo?.name === 'air') y += 1;
  bot.pathfinder.setMovements(protectMovementsFromFluid(bot, new Movements(bot)));
  return patchedGoto(bot, new goals.GoalNear(x, y, z, minDistance), { signal, onProgress });
}

async function breakBlockAt(bot: any, originalBlock: any, signal?: AbortSignal): Promise<boolean> {
  throwIfAborted(signal);
  let block = bot.blockAt(originalBlock.position);
  if (!block || block.name === 'air' || block.name === 'water' || block.name === 'lava') return false;
  if (bot.entity.position.distanceTo(block.position) > 4.5) {
    const movements = protectMovementsFromFluid(bot, new Movements(bot));
    movements.allowParkour = false;
    movements.allowSprinting = false;
    bot.pathfinder.setMovements(movements);
    const navigation = await patchedGoto(
      bot,
      new goals.GoalNear(block.position.x, block.position.y, block.position.z, 4),
      { signal },
    );
    if (!navigation.ok) return false;
    block = bot.blockAt(originalBlock.position);
  }
  throwIfAborted(signal);
  await bot.tool.equipForBlock(block);
  const itemId = bot.heldItem?.type ?? null;
  if (!block.canHarvest(itemId)) return false;
  await bot.dig(block, true);
  return true;
}

async function pickupNearbyItems(bot: any, distance: number, signal?: AbortSignal): Promise<void> {
  const nearest = () => bot.nearestEntity((entity: any) =>
    entity.name === 'item'
    && entity.onGround
    && bot.entity.position.distanceTo(entity.position) < distance,
  );
  let item = nearest();
  while (item) {
    throwIfAborted(signal);
    await patchedGoto(bot, new goals.GoalFollow(item, 0.8), { signal });
    await sleep(500, signal);
    const previous = item;
    item = nearest();
    if (previous === item) break;
  }
}

async function moveAway(bot: any, distance: number, signal?: AbortSignal): Promise<boolean> {
  try {
    const position = bot.entity.position;
    let x = 0;
    let z = 0;
    let suitable = false;
    while (!suitable) {
      throwIfAborted(signal);
      x = Math.floor(position.x + distance * Math.random() * (Math.random() < 0.5 ? -1 : 1));
      z = Math.floor(position.z + distance * Math.random() * (Math.random() < 0.5 ? -1 : 1));
      const block = bot.blockAt(new Vec3(x, position.y - 1, z));
      suitable = block?.name !== 'water' && block?.name !== 'lava';
    }
    const result = await patchedGoto(bot, new goals.GoalXZ(x, z), { signal });
    await sleep(500, signal);
    return result.ok;
  } catch {
    return false;
  }
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    function finish(): void {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

function abortError(): Error {
  return Object.assign(new Error('Minecraft action cancelled'), { name: 'AbortError' });
}

function formatPosition(position: any): string {
  return `${Math.floor(Number(position.x))},${Math.floor(Number(position.y))},${Math.floor(Number(position.z))}`;
}

function formatDistance(from: any, to: any): string {
  return typeof from?.distanceTo === 'function' ? from.distanceTo(to).toFixed(1) : 'unknown';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function canDigDirectly(bot: any, block: any): boolean {
  try {
    return bot.entity.position.distanceTo(block.position) <= 4.5
      && typeof bot.canDigBlock === 'function'
      && bot.canDigBlock(block);
  } catch {
    return false;
  }
}

function positionKey(position: any): string {
  return `${Math.floor(Number(position.x))}:${Math.floor(Number(position.y))}:${Math.floor(Number(position.z))}`;
}

function findWoodBlock(bot: any, maxDistance: number, failedTargets: Set<string>): any | null {
  const positions = bot.findBlocks({
    matching: (block: any) => Boolean(block?.name?.includes('log')),
    maxDistance,
    count: 64,
  }) ?? [];
  for (const position of positions) {
    const block = bot.blockAt(position);
    if (block?.position && !failedTargets.has(positionKey(block.position))) return block;
  }
  return null;
}
