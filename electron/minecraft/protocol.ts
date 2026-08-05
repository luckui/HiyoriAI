export type MinecraftAction =
  | 'discover'
  | 'connect'
  | 'disconnect'
  | 'status'
  | 'say'
  | 'snapshot'
  | 'execute-action'
  | 'cancel-action'
  | 'follow'
  | 'collect'
  | 'stop';

export type {
  MinecraftActionErrorCode,
  MinecraftActionInstruction,
  MinecraftActionName,
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
  MinecraftFact,
  MinecraftFollowPhase,
  MinecraftObservedBlock,
  MinecraftObservedEntity,
  MinecraftPlannerDecision,
  MinecraftWorkerCommand,
  MinecraftWorldChange,
} from './contracts';

export interface MinecraftCommand<T = unknown> {
  type: 'command';
  id: string;
  action: MinecraftAction;
  payload: T;
}

export interface MinecraftRoom {
  motd: string;
  advertisedHost: string;
  host: string;
  port: number;
}

export type MinecraftBehavior =
  | { kind: 'idle' }
  | { kind: 'follow'; player: string }
  | {
      kind: 'collect';
      jobId: string;
      block: string;
      requested: number;
      collected: number;
    };

export interface MinecraftStatus {
  connected: boolean;
  username?: string;
  host?: string;
  port?: number;
  players: string[];
  owner?: string;
  health?: number;
  food?: number;
  behavior: MinecraftBehavior;
}

export type MinecraftTerminalOutcome =
  | 'completed'
  | 'partial'
  | 'cancelled'
  | 'failed';

export interface MinecraftTerminalEvent {
  kind: 'collection-terminal';
  jobId: string;
  outcome: MinecraftTerminalOutcome;
  block: string;
  requested: number;
  collected: number;
  message?: string;
}

export type MinecraftRuntimeEvent =
  | MinecraftTerminalEvent
  | { kind: 'chat'; player: string; message: string }
  | { kind: 'players'; players: string[] }
  | { kind: 'food-shortage'; food: number }
  | { kind: 'food-recovered'; food: number }
  | { kind: 'disconnected'; reason: string }
  | { kind: 'log'; level: 'info' | 'warn' | 'error'; message: string };

export type MinecraftWorkerMessage =
  | { type: 'response'; id: string; ok: true; data: unknown }
  | { type: 'response'; id: string; ok: false; error: string }
  | { type: 'event'; event: MinecraftRuntimeEvent };
