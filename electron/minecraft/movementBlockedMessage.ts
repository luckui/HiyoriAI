import type { MinecraftRuntimeEvent } from './protocol';

type MovementBlockedEvent = Extract<MinecraftRuntimeEvent, { kind: 'movement-blocked' }>;

export function formatMovementBlockedWakeup(event: MovementBlockedEvent): string {
  return [
    '【Minecraft 移动受阻】',
    `Hiyori 在跟随 ${event.player} 时，寻路器未能继续当前路径。`,
    `当前位置：${event.position.x.toFixed(1)}, ${event.position.y.toFixed(1)}, ${event.position.z.toFixed(1)}`,
    `与玩家距离：${event.distance.toFixed(1)} 格`,
    '当前路径已暂停，系统仍会低频自动重试。请如实告诉用户当前位置和受阻情况，用户可以前来协助或下达新的移动指令。',
  ].join('\n');
}
