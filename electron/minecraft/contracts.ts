export const MINECRAFT_RUNTIME_CONTRACT_VERSION = 1;

export type MinecraftFollowPhase =
  | 'inactive'
  | 'approaching'
  | 'nearby'
  | 'recovering'
  | 'blocked'
  | 'target-lost';

export type MinecraftActionName =
  | 'navigate_to_player'
  | 'follow_player'
  | 'wait'
  | 'inspect'
  | 'collect_block'
  | 'pickup_drops'
  | 'craft_item'
  | 'smelt_item'
  | 'use_container'
  | 'eat'
  | 'equip'
  | 'defend'
  | 'retreat'
  | 'sleep'
  | 'harvest_crop'
  | 'till_soil'
  | 'sow_crop'
  | 'place_block'
  | 'break_block'
  | 'execute_blueprint';

export type MinecraftActionErrorCode =
  | 'not_connected'
  | 'target_not_found'
  | 'path_unreachable'
  | 'blocked'
  | 'missing_tool'
  | 'missing_item'
  | 'inventory_full'
  | 'unsafe'
  | 'timeout'
  | 'cancelled'
  | 'adapter_error';

export interface MinecraftFact {
  id: string;
  at: number;
  severity: 'info' | 'notice' | 'warning' | 'error';
  kind: string;
  text: string;
  data?: Record<string, unknown>;
}

export interface MinecraftObservedBlock {
  name: string;
  displayName?: string;
  position: { x: number; y: number; z: number };
  distance: number;
}

export interface MinecraftObservedEntity {
  name: string;
  type: string;
  position: { x: number; y: number; z: number };
  distance: number;
  hostile: boolean;
}

export interface MinecraftEnvironmentSnapshot {
  capturedAt: number;
  stale: boolean;
  connection: { connected: boolean; username?: string; host?: string; port?: number };
  world?: { dimension: string; biome?: string; timeOfDay?: number; weather?: string };
  body?: {
    position: { x: number; y: number; z: number };
    health: number;
    food: number;
    oxygen?: number;
    inventory: Record<string, number>;
  };
  owner?: { name: string; visible: boolean; distance?: number; relativeDirection?: string };
  follow: { phase: MinecraftFollowPhase; target?: string; distance?: number };
  nearby: { blocks: MinecraftObservedBlock[]; entities: MinecraftObservedEntity[] };
  action?: { id: string; name: MinecraftActionName; state: 'running' | 'paused' | 'cancelled' };
  recentEvents: MinecraftFact[];
}

export interface MinecraftActionInstruction {
  id: string;
  name: MinecraftActionName;
  args: Record<string, unknown>;
}

export interface MinecraftWorldChange {
  kind: 'block_broken' | 'block_placed' | 'item_picked_up' | 'entity_hit';
  name: string;
  position?: { x: number; y: number; z: number };
  count?: number;
}

export interface MinecraftActionResult {
  actionId: string;
  outcome: 'succeeded' | 'partial' | 'failed' | 'cancelled';
  summary: string;
  durationMs: number;
  inventoryDelta: Record<string, number>;
  worldChanges: MinecraftWorldChange[];
  observations: MinecraftFact[];
  error?: { code: MinecraftActionErrorCode; recoverable: boolean; details: Record<string, unknown> };
}

export type MinecraftPlannerDecision =
  | { kind: 'act'; action: MinecraftActionInstruction; rationale: string }
  | { kind: 'complete'; result: string }
  | { kind: 'ask-user'; question: string; reason: string }
  | { kind: 'wait'; condition: { kind: 'action' | 'player' | 'time'; value: string } }
  | { kind: 'revise-plan'; plan: Array<{ title: string; expected: string }> };

export type MinecraftWorkerCommand =
  | { type: 'discover'; requestId: string }
  | { type: 'connect'; requestId: string; host: string; port: number; username?: string }
  | { type: 'disconnect'; requestId: string }
  | { type: 'status'; requestId: string }
  | { type: 'say'; requestId: string; message: string }
  | { type: 'snapshot'; requestId: string }
  | { type: 'execute-action'; requestId: string; instruction: MinecraftActionInstruction }
  | { type: 'cancel-action'; requestId: string; actionId: string };
