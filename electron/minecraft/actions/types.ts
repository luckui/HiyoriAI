import type {
  MinecraftActionInstruction,
  MinecraftActionName,
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
} from '../contracts';
import type { MinecraftRawObservation, MinecraftStatus } from '../protocol';

export interface MinecraftConnectionOptions {
  host: string;
  port: number;
  username: string;
  owner?: string;
}

export interface CollectionRequest {
  block: string;
  quantity: number;
  radius: number;
  signal: AbortSignal;
}

export interface MinecraftEntitySnapshot {
  kind: 'player' | 'hostile' | 'neutral';
  name: string;
}

export interface MinecraftPolicyHandlers {
  onFoodState(state: { food: number; hasInventoryFood: boolean }): void;
  shouldDefendAgainst(entity: MinecraftEntitySnapshot): boolean;
}

export interface MinecraftBodyAdapter {
  isConnected(): boolean;
  getSnapshot(): Promise<MinecraftEnvironmentSnapshot>;
  say(message: string): Promise<void>;
  navigateToPlayer(playerName: string, options: { range: number; timeoutMs: number; dynamic: boolean }): Promise<void>;
  stopNavigation(): Promise<void>;
  inspect(options: { radius: number }): Promise<MinecraftEnvironmentSnapshot>;
  collectBlock(options: { block: string; radius: number; maxCount: number; preserveRoot: boolean }): Promise<MinecraftActionResult>;
  pickupDrops(options: { radius: number }): Promise<MinecraftActionResult>;
}

export interface MinecraftBotAdapter extends MinecraftBodyAdapter {
  connect(options: MinecraftConnectionOptions): Promise<void>;
  disconnect(): Promise<void>;
  status(): MinecraftStatus;
  getRawObservation(ownerName?: string): MinecraftRawObservation;
  startFollowing(player: string): Promise<void>;
  stopForeground(): Promise<void>;
  resolveBlock(name: string): string | null;
  collect(request: CollectionRequest): Promise<number>;
  configurePolicies(handlers: MinecraftPolicyHandlers): void;
}

export interface MinecraftActionContext {
  adapter: MinecraftBodyAdapter;
  signal: AbortSignal;
  now: () => number;
  snapshot: () => Promise<MinecraftEnvironmentSnapshot>;
}

export interface MinecraftActionHandler {
  name: MinecraftActionName;
  run(instruction: MinecraftActionInstruction, context: MinecraftActionContext): Promise<MinecraftActionResult>;
}
