import type { MinecraftActionHandler } from './types';

export function createResourceActions(): MinecraftActionHandler[] {
  return [
    {
      name: 'collect_item',
      async run(instruction, context) {
        const radius = numberArg(instruction.args.radius, 16, 1, 64);
        const maxCount = numberArg(instruction.args.maxCount ?? instruction.args.quantity, 8, 1, 64);
        const result = await context.adapter.collectItem({
          actionId: instruction.id,
          block: typeof instruction.args.block === 'string' ? instruction.args.block : undefined,
          item: typeof instruction.args.item === 'string' ? instruction.args.item : undefined,
          radius,
          maxCount,
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'pickup_drops',
      async run(instruction, context) {
        const radius = numberArg(instruction.args.radius, 8, 1, 32);
        const result = await context.adapter.pickupDrops({ radius });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'break_block',
      async run(instruction, context) {
        const block = stringArg(instruction.args.block, 'block');
        const result = await context.adapter.collectItem({
          actionId: instruction.id,
          block,
          radius: numberArg(instruction.args.radius, 8, 1, 32),
          maxCount: numberArg(instruction.args.maxCount ?? 1, 1, 1, 64),
          signal: context.signal,
        });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'equip',
      async run(instruction, context) {
        const item = stringArg(instruction.args.item, 'item');
        const result = await context.adapter.equipItem({ item });
        return { ...result, actionId: instruction.id };
      },
    },
    {
      name: 'drop_item',
      async run(instruction, context) {
        const item = stringArg(instruction.args.item, 'item');
        const count = numberArg(instruction.args.count, 1, 1, 64);
        const player = typeof instruction.args.player === 'string' ? instruction.args.player : undefined;
        const result = await context.adapter.dropItem({ item, count, player });
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
