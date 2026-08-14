import type { MinecraftActionHandler } from './types';

export function createProductionActions(): MinecraftActionHandler[] {
  return [
    {
      name: 'craft_item',
      async run(instruction, context) {
        const item = stringArg(instruction.args.item, 'item');
        const quantity = numberArg(instruction.args.maxCount ?? 1, 1, 1, 64);
        const result = await context.adapter.craftItem({
          actionId: instruction.id,
          item,
          quantity,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'place_block',
      async run(instruction, context) {
        const block = stringArg(instruction.args.block, 'block');
        const result = await context.adapter.placeBlockItem({
          actionId: instruction.id,
          block,
          position: positionArg(instruction.args.position),
          face: typeof instruction.args.face === 'string' ? instruction.args.face : undefined,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'smelt_item',
      async run(instruction, context) {
        const item = typeof instruction.args.item === 'string' ? instruction.args.item.trim() : undefined;
        const block = typeof instruction.args.block === 'string' ? instruction.args.block.trim() : undefined;
        if (!item && !block) throw new Error('Missing Minecraft action argument: block or item');
        const quantity = numberArg(instruction.args.quantity ?? instruction.args.maxCount, 1, 1, 64);
        const result = await context.adapter.smeltItem({
          actionId: instruction.id,
          item,
          block,
          quantity,
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

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}

function positionArg(value: unknown): { x: number; y: number; z: number } | undefined {
  if (!value || typeof value !== 'object') return undefined;
  const record = value as Record<string, unknown>;
  const x = Number(record.x);
  const y = Number(record.y);
  const z = Number(record.z);
  return Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(z) ? { x, y, z } : undefined;
}
