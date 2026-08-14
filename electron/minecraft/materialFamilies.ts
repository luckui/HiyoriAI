export type MinecraftMaterialFamily = 'logs' | 'planks';

export function minecraftMaterialFamily(name: string): MinecraftMaterialFamily | undefined {
  const normalized = String(name ?? '').toLowerCase();
  if (normalized === 'planks' || normalized.endsWith('_planks')) return 'planks';
  if (
    normalized === 'log'
    || normalized === 'log2'
    || normalized.endsWith('_log')
    || normalized.endsWith('_wood')
    || normalized.endsWith('_stem')
    || normalized.endsWith('_hyphae')
  ) {
    return 'logs';
  }
  return undefined;
}

export function canonicalMinecraftMaterial(name: string): string {
  const family = minecraftMaterialFamily(name);
  if (family === 'planks') return 'planks';
  if (family === 'logs') return 'log';
  return name;
}

export function sameMinecraftMaterialFamily(left: string, right: string): boolean {
  const family = minecraftMaterialFamily(left);
  return family !== undefined && family === minecraftMaterialFamily(right);
}
