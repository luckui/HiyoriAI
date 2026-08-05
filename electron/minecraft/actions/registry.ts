import type { MinecraftActionName } from '../contracts';
import { createNavigationActions } from './navigation';
import { createResourceActions } from './resources';
import type { MinecraftActionHandler } from './types';

export function createMinecraftActionRegistry(): Map<MinecraftActionName, MinecraftActionHandler> {
  return new Map(
    [...createNavigationActions(), ...createResourceActions()].map((handler) => [
      handler.name,
      handler,
    ]),
  );
}
