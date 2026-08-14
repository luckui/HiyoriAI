import { Vec3 } from 'vec3';

const LIQUID_NAMES = new Set(['water', 'flowing_water', 'lava', 'flowing_lava']);
const MAX_VERTICAL_FLOW_LOOKAHEAD = 32;
const FLUID_BREAK_GUARD = Symbol('hiyori-fluid-break-guard');

export interface ExcavationFluidRisk {
  unsafe: boolean;
  liquid?: string;
  source?: { x: number; y: number; z: number };
}

/**
 * Detects whether removing one block would open the excavated cell to a
 * liquid. A solid layer between a route and water remains safe; an open
 * vertical shaft to water does not.
 */
export function assessExcavationFluidRisk(
  bot: { blockAt(position: any): any },
  position: { x: number; y: number; z: number },
): ExcavationFluidRisk {
  const immediateSources = [
    offset(position, 0, 1, 0),
    offset(position, -1, 0, 0),
    offset(position, 1, 0, 0),
    offset(position, 0, 0, -1),
    offset(position, 0, 0, 1),
  ];
  for (const source of immediateSources) {
    const liquid = liquidName(bot.blockAt(source));
    if (liquid) return { unsafe: true, liquid, source };
  }

  // Covers the short world-update window where a water column has an open
  // shaft below it but the lower air blocks have not become flowing water yet.
  for (let dy = 1; dy <= MAX_VERTICAL_FLOW_LOOKAHEAD; dy += 1) {
    const source = offset(position, 0, dy, 0);
    const block = bot.blockAt(source);
    const liquid = liquidName(block);
    if (liquid) return { unsafe: true, liquid, source };
    if (!isFlowPassable(block)) break;
  }

  return { unsafe: false };
}

/**
 * Installs a deterministic A* break exclusion. Existing water traversal is
 * unaffected because only candidate blocks that would be excavated are
 * screened.
 */
export function protectMovementsFromFluid<T extends {
  exclusionAreasBreak?: Array<(block: any) => number>;
}>(bot: { blockAt(position: any): any }, movements: T): T {
  const tagged = movements as T & { [FLUID_BREAK_GUARD]?: boolean };
  if (tagged[FLUID_BREAK_GUARD]) return movements;
  tagged[FLUID_BREAK_GUARD] = true;
  movements.exclusionAreasBreak ??= [];
  movements.exclusionAreasBreak.push((block: any) => (
    block?.position && assessExcavationFluidRisk(bot, block.position).unsafe ? 100 : 0
  ));
  return movements;
}

function liquidName(block: any): string | undefined {
  const name = String(block?.name ?? '');
  return LIQUID_NAMES.has(name) ? name : undefined;
}

function isFlowPassable(block: any): boolean {
  if (!block) return false;
  const name = String(block.name ?? '');
  return name === 'air'
    || name === 'cave_air'
    || name === 'void_air'
    || block.boundingBox === 'empty';
}

function offset(
  position: { x: number; y: number; z: number },
  x: number,
  y: number,
  z: number,
): Vec3 {
  return new Vec3(position.x + x, position.y + y, position.z + z);
}
