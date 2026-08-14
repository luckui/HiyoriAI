import { app } from 'electron';
import { join } from 'node:path';
import { MinecraftRuntimeManager } from './runtimeManager';

export const minecraftRuntime = new MinecraftRuntimeManager({
  debugLogPath: join(app.getPath('userData'), 'logs', 'minecraft-runtime.jsonl'),
  workerLogPath: join(app.getPath('userData'), 'logs', 'minecraft-worker.log'),
});

export * from './lanDiscovery';
export * from './protocol';
export * from './runtimeManager';
