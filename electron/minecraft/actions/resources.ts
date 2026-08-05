import type { MinecraftActionHandler } from './types';

export function createResourceActions(): MinecraftActionHandler[] {
  return [
    {
      name: 'collect_block',
      async run(instruction, context) {
        const block = stringArg(instruction.args.block, 'block');
        const radius = numberArg(instruction.args.radius, 16, 1, 64);
        const maxCount = numberArg(instruction.args.maxCount ?? instruction.args.quantity, 64, 1, 64);
        const result = await context.adapter.collectBlock({
          block,
          radius,
          maxCount,
          preserveRoot: false,
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
        const result = await context.adapter.collectBlock({
          block,
          radius: numberArg(instruction.args.radius, 8, 1, 32),
          maxCount: numberArg(instruction.args.maxCount ?? 1, 1, 1, 64),
          preserveRoot: false,
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
