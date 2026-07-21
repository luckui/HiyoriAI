import { readdirSync, readFileSync, statSync } from 'fs';
import { basename, join } from 'path';

export type AvatarMotionSlot = 'idle' | 'touch' | 'thinking' | 'speaking';

export interface AvatarMotionResource {
  id: string;
  group: string;
  index: number;
  file: string;
  label: string;
}

export interface AvatarExpressionResource {
  id: string;
  name: string;
  file: string;
}

export interface AvatarHitArea {
  id: string;
  name: string;
}

export interface AvatarMapping {
  motions: Record<AvatarMotionSlot, string[]>;
  expressions: Record<string, string>;
}

export interface Live2DModelProfile {
  id: string;
  name: string;
  sourceDir: string;
  modelJsonName: string;
  importedAt?: number;
  motions: AvatarMotionResource[];
  expressions: AvatarExpressionResource[];
  hitAreas: AvatarHitArea[];
  lipSyncIds: string[];
  mapping: AvatarMapping;
  unassignedMotionIds: string[];
}

interface Model3Json {
  FileReferences?: {
    Motions?: Record<string, Array<{ File?: string }>>;
    Expressions?: Array<{ Name?: string; File?: string }>;
  };
  HitAreas?: Array<{ Id?: string; Name?: string }>;
  Groups?: Array<{ Name?: string; Ids?: string[] }>;
}

export function scanLive2DModelFolder(folderPath: string): Live2DModelProfile {
  const modelJsonName = findModelJson(folderPath);
  const modelJsonPath = join(folderPath, modelJsonName);
  const parsed = JSON.parse(readFileSync(modelJsonPath, 'utf-8')) as Model3Json;
  const name = basename(modelJsonName, '.model3.json');
  const motions = extractMotions(parsed);
  const expressions = extractExpressions(parsed);
  const mapping = createDefaultMapping(motions);
  const assigned = new Set(Object.values(mapping.motions).flat());

  return {
    id: stableModelId(folderPath, modelJsonName),
    name,
    sourceDir: folderPath,
    modelJsonName,
    motions,
    expressions,
    hitAreas: (parsed.HitAreas ?? [])
      .filter((area) => area.Id && area.Name)
      .map((area) => ({ id: area.Id!, name: area.Name! })),
    lipSyncIds: (parsed.Groups ?? []).find((group) => group.Name === 'LipSync')?.Ids ?? [],
    mapping,
    unassignedMotionIds: motions.map((motion) => motion.id).filter((id) => !assigned.has(id)),
  };
}

function findModelJson(folderPath: string): string {
  const candidates = readdirSync(folderPath)
    .filter((entry) => entry.endsWith('.model3.json') && statSync(join(folderPath, entry)).isFile())
    .sort((a, b) => a.localeCompare(b));
  if (candidates.length === 0) {
    throw new Error('No .model3.json found in Live2D model folder.');
  }
  return candidates[0];
}

function extractMotions(model: Model3Json): AvatarMotionResource[] {
  const result: AvatarMotionResource[] = [];
  const groups = model.FileReferences?.Motions ?? {};
  for (const [group, entries] of Object.entries(groups)) {
    entries.forEach((entry, index) => {
      if (!entry.File) return;
      result.push({
        id: `${group}:${index}`,
        group,
        index,
        file: entry.File,
        label: `${group} / ${basename(entry.File, '.motion3.json')}`,
      });
    });
  }
  return result;
}

function extractExpressions(model: Model3Json): AvatarExpressionResource[] {
  return (model.FileReferences?.Expressions ?? [])
    .filter((entry) => entry.Name && entry.File)
    .map((entry) => ({ id: entry.Name!, name: entry.Name!, file: entry.File! }));
}

function createDefaultMapping(motions: AvatarMotionResource[]): AvatarMapping {
  const mapping: AvatarMapping = {
    motions: {
      idle: [],
      touch: [],
      thinking: [],
      speaking: [],
    },
    expressions: {},
  };

  mapping.motions.idle = motions.filter((motion) => /^idle$/i.test(motion.group)).map((motion) => motion.id);
  mapping.motions.touch = motions
    .filter((motion) => /^tap(body)?$/i.test(motion.group) || /^tap@body$/i.test(motion.group))
    .map((motion) => motion.id);

  return mapping;
}

function stableModelId(folderPath: string, modelJsonName: string): string {
  return `${basename(folderPath)}:${modelJsonName}`.replace(/[^\w.-]+/g, '_');
}
