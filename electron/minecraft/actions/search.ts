import type { MinecraftActionHandler } from './types';

export function createSearchActions(): MinecraftActionHandler[] {
  return [
    {
      name: 'search_entity',
      async run(instruction, context) {
        const entity = entityNameArg(instruction.args.entity ?? instruction.args.target ?? instruction.args.type, 'entity');
        const radius = numberArg(instruction.args.radius ?? instruction.args.search_range, 64, 8, 128);
        const result = await context.adapter.searchEntity({ entity, radius });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'scan_blocks',
      async run(instruction, context) {
        const radius = numberArg(instruction.args.radius, 8, 2, 16);
        const verticalRadius = numberArg(instruction.args.verticalRadius ?? instruction.args.vertical_radius, 4, 1, 8);
        const limit = numberArg(instruction.args.limit, 24, 4, 64);
        const result = await context.adapter.scanBlocks({ radius, verticalRadius, limit });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'search_block',
      async run(instruction, context) {
        const block = stringArg(instruction.args.block ?? instruction.args.type, 'block');
        const radius = numberArg(instruction.args.radius ?? instruction.args.search_range, 64, 8, 128);
        const count = numberArg(instruction.args.count, 8, 1, 32);
        const result = await context.adapter.searchBlock({ block, radius, count });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'approach_entity',
      async run(instruction, context) {
        const entity = entityNameArg(instruction.args.entity ?? instruction.args.target ?? instruction.args.type, 'entity');
        const range = numberArg(instruction.args.range, 3, 1, 8);
        const radius = numberArg(instruction.args.radius, 32, 8, 128);
        const result = await context.adapter.approachEntity({ entity, range, radius });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'attack_entity',
      async run(instruction, context) {
        const entity = entityNameArg(instruction.args.entity ?? instruction.args.target ?? instruction.args.type, 'entity');
        const radius = numberArg(instruction.args.radius, 24, 4, 64);
        const quantity = numberArg(instruction.args.quantity, 1, 1, 64);
        const kill = instruction.args.kill === undefined ? true : Boolean(instruction.args.kill);
        const result = await context.adapter.attackEntity({
          actionId: instruction.id,
          entity,
          radius,
          quantity,
          kill,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
  ];
}

function stringArg(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing Minecraft action argument: ${name}`);
}

function entityNameArg(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (isRecord(value)) {
    const candidate = value.name ?? value.mobType ?? value.type;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  throw new Error(`Missing Minecraft action argument: ${name}`);
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
