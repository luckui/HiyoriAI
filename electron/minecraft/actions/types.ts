import type {
  MinecraftActionInstruction,
  MinecraftActionName,
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
} from '../contracts';
import type { MinecraftRawObservation, MinecraftStatus } from '../protocol';
import type { PathfindResult } from '../patchedGoto';

export interface MinecraftConnectionOptions {
  host: string;
  port: number;
  username: string;
  owner?: string;
}

export interface CollectionRequest {
  blocks: string[];
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
  onOxygenEmergency(state: MinecraftOxygenEmergency): void;
  onDeath(state: MinecraftDeathEvent): void;
  onFollowBlocked?(state: MinecraftFollowBlocked): void;
  onFollowRecovered?(state: MinecraftFollowBlocked): void;
  onPlayersChanged?(players: string[]): void | Promise<void>;
  shouldDefendAgainst(entity: MinecraftEntitySnapshot): boolean;
}

export interface MinecraftOxygenEmergency {
  oxygen: number;
  position: { x: number; y: number; z: number };
}

export interface MinecraftDeathEvent {
  position?: { x: number; y: number; z: number };
}

export interface MinecraftFollowBlocked {
  player: string;
  position: { x: number; y: number; z: number };
  distance: number;
}

export interface MinecraftSafetyRecovery {
  recovered: boolean;
  oxygen: number;
  method: 'surface' | 'last-breathable-position' | 'failed';
}

export interface MinecraftBodyAdapter {
  isConnected(): boolean;
  getSnapshot(): Promise<MinecraftEnvironmentSnapshot>;
  say(message: string): Promise<void>;
  navigateToPlayer(playerName: string, options: {
    range: number;
    timeoutMs: number;
    dynamic: boolean;
    signal?: AbortSignal;
  }): Promise<PathfindResult>;
  stopNavigation(): Promise<void>;
  escapeToAir(): Promise<MinecraftSafetyRecovery>;
  inspect(options: { radius: number }): Promise<MinecraftEnvironmentSnapshot>;
  scanBlocks(options: { radius: number; verticalRadius: number; limit: number }): Promise<MinecraftActionResult>;
  searchBlock(options: { block: string; radius: number; count: number }): Promise<MinecraftActionResult>;
  searchEntity(options: { entity: string; radius: number }): Promise<MinecraftActionResult>;
  approachEntity(options: { entity: string; range: number; radius: number }): Promise<MinecraftActionResult>;
  attackEntity(options: {
    actionId: string;
    entity: string;
    radius: number;
    quantity: number;
    kill: boolean;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  collectItem(options: {
    actionId: string;
    block?: string;
    item?: string;
    radius: number;
    maxCount: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  craftItem(options: {
    actionId: string;
    item: string;
    quantity?: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  smeltItem(options: {
    actionId: string;
    item?: string;
    block?: string;
    quantity: number;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  equipItem(options: { item: string }): Promise<MinecraftActionResult>;
  dropItem(options: { item: string; count: number; player?: string }): Promise<MinecraftActionResult>;
  placeBlockItem(options: {
    actionId: string;
    block: string;
    position?: { x: number; y: number; z: number };
    face?: string;
    signal: AbortSignal;
  }): Promise<MinecraftActionResult>;
  pickupDrops(options: { radius: number }): Promise<MinecraftActionResult>;
}

export interface MinecraftBotAdapter extends MinecraftBodyAdapter {
  connect(options: MinecraftConnectionOptions): Promise<void>;
  disconnect(): Promise<void>;
  setOwner(player?: string): void;
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
