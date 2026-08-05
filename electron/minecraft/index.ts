import { MinecraftRuntimeManager } from './runtimeManager';
import type { MinecraftCognitionCoordinator } from './cognitionCoordinator';

export const minecraftRuntime = new MinecraftRuntimeManager();

let minecraftGoalCoordinator: MinecraftCognitionCoordinator | undefined;

export function setMinecraftGoalCoordinator(
  coordinator: MinecraftCognitionCoordinator | undefined,
): void {
  minecraftGoalCoordinator = coordinator;
}

export function getMinecraftGoalCoordinator(): MinecraftCognitionCoordinator | undefined {
  return minecraftGoalCoordinator;
}

export * from './lanDiscovery';
export * from './protocol';
export * from './runtimeManager';
export * from './cognitionCoordinator';
