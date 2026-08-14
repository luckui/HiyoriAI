import type { MinecraftGoalController } from './goalController';

let controller: MinecraftGoalController | undefined;

export function setMinecraftGoalController(next: MinecraftGoalController): void {
  controller = next;
}

export function getMinecraftGoalController(): MinecraftGoalController {
  if (!controller) throw new Error('Minecraft goal controller is not configured');
  return controller;
}

export function resetMinecraftGoalControllerForTest(): void {
  controller = undefined;
}
