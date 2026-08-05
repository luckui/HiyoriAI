import type { MinecraftActionResult } from '../contracts';
import type { MinecraftActionHandler } from './types';

export function createNavigationActions(): MinecraftActionHandler[] {
  return [
    {
      name: 'inspect',
      async run(instruction, context) {
        const started = context.now();
        const snapshot = await context.adapter.inspect({ radius: numberArg(instruction.args.radius, 16, 1, 64) });
        return {
          actionId: instruction.id,
          outcome: 'succeeded',
          summary: 'inspected visible Minecraft surroundings',
          durationMs: context.now() - started,
          inventoryDelta: {},
          worldChanges: [],
          observations: snapshot.recentEvents,
        };
      },
    },
    {
      name: 'wait',
      async run(instruction, context) {
        await delay(numberArg(instruction.args.durationMs, 1000, 0, 10_000), context.signal);
        return success(instruction.id, 'waited', 0);
      },
    },
    {
      name: 'navigate_to_player',
      async run(instruction, context) {
        const player = stringArg(instruction.args.player ?? instruction.args.playerName, 'player');
        const started = context.now();
        await context.adapter.navigateToPlayer(player, {
          range: numberArg(instruction.args.range, 2, 1, 16),
          timeoutMs: numberArg(instruction.args.timeoutMs, 30_000, 1_000, 120_000),
          dynamic: Boolean(instruction.args.dynamic ?? false),
        });
        return success(instruction.id, `navigated to ${player}`, context.now() - started);
      },
    },
    {
      name: 'follow_player',
      async run(instruction, context) {
        const player = stringArg(instruction.args.player ?? instruction.args.playerName, 'player');
        const started = context.now();
        await context.adapter.navigateToPlayer(player, {
          range: numberArg(instruction.args.range, 2, 1, 16),
          timeoutMs: numberArg(instruction.args.timeoutMs, 30_000, 1_000, 120_000),
          dynamic: true,
        });
        return success(instruction.id, `following ${player}`, context.now() - started);
      },
    },
  ];
}

function success(actionId: string, summary: string, durationMs: number): MinecraftActionResult {
  return {
    actionId,
    outcome: 'succeeded',
    summary,
    durationMs,
    inventoryDelta: {},
    worldChanges: [],
    observations: [],
  };
}

function delay(durationMs: number, signal: AbortSignal): Promise<void> {
  if (durationMs <= 0 || signal.aborted) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, durationMs);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(new Error('Minecraft action cancelled'));
    }, { once: true });
  });
}

function stringArg(value: unknown, name: string): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  throw new Error(`Missing Minecraft action argument: ${name}`);
}

function numberArg(value: unknown, fallback: number, min: number, max: number): number {
  const number = typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(max, Math.max(min, number));
}
