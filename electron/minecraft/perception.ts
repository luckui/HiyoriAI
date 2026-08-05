import type {
  MinecraftEnvironmentSnapshot,
  MinecraftFact,
  MinecraftObservedBlock,
  MinecraftObservedEntity,
} from './contracts';

export interface MinecraftRawObservation {
  capturedAt: number;
  connection: MinecraftEnvironmentSnapshot['connection'];
  world?: MinecraftEnvironmentSnapshot['world'];
  body?: MinecraftEnvironmentSnapshot['body'];
  owner?: MinecraftEnvironmentSnapshot['owner'];
  follow?: MinecraftEnvironmentSnapshot['follow'];
  nearbyBlocks: MinecraftObservedBlock[];
  nearbyEntities: MinecraftObservedEntity[];
  recentEvents: MinecraftFact[];
}

export function buildMinecraftSnapshot(input: MinecraftRawObservation): MinecraftEnvironmentSnapshot {
  const connected = input.connection.connected;
  return {
    capturedAt: input.capturedAt,
    stale: !connected,
    connection: input.connection,
    world: connected ? input.world : undefined,
    body: connected ? input.body : undefined,
    owner: connected ? input.owner : undefined,
    follow: input.follow ?? { phase: 'inactive' },
    nearby: {
      blocks: [...input.nearbyBlocks].sort(byDistance),
      entities: [...input.nearbyEntities].sort(byDistance),
    },
    recentEvents: [...input.recentEvents],
  };
}

function byDistance(
  left: { distance: number; name: string },
  right: { distance: number; name: string },
): number {
  return left.distance - right.distance || left.name.localeCompare(right.name);
}
