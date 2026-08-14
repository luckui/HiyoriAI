import type { MinecraftGoalTerminalNotice } from './goalController';

export function buildMinecraftGoalWakeup(notice: MinecraftGoalTerminalNotice): string {
  const checkpoint = notice.checkpoint;
  const inventoryDelta = checkpoint
    ? Object.entries(checkpoint.inventoryDelta)
      .map(([name, count]) => `${name} ${count > 0 ? '+' : ''}${count}`)
      .join(', ')
    : '';
  const body = checkpoint
    ? [
        checkpoint.health === undefined ? undefined : `生命 ${checkpoint.health}`,
        checkpoint.food === undefined ? undefined : `饥饿 ${checkpoint.food}`,
        inventoryDelta ? `背包变化 ${inventoryDelta}` : undefined,
      ].filter(Boolean).join('；')
    : '';
  return [
    '【Minecraft 游戏结果】',
    `目标：${notice.goal.title}`,
    `目标要求：${notice.goal.instruction}`,
    `结果：${notice.report}`,
    body ? `当前状态：${body}` : undefined,
    '',
    '请根据这些已确认的游戏事实，用 Hiyori 自己的口吻自然回应玩家。',
  ].filter((line) => line !== undefined).join('\n');
}
