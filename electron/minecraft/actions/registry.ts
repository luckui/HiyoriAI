import type { MinecraftActionName } from '../contracts';
import { createNavigationActions } from './navigation';
import { createProductionActions } from './production';
import { createResourceActions } from './resources';
import { createSearchActions } from './search';
import type { MinecraftActionHandler } from './types';

export function createMinecraftActionRegistry(): Map<MinecraftActionName, MinecraftActionHandler> {
  return new Map(
    [...createNavigationActions(), ...createSearchActions(), ...createResourceActions(), ...createProductionActions()].map((handler) => [
      handler.name,
      handler,
    ]),
  );
}
