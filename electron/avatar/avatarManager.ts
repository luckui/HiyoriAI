import { cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { basename, join, relative, resolve } from 'path';
import { app } from 'electron';
import type { AvatarConfig } from './avatarConfig';
import { BUILTIN_HIYORI_MODEL_ID, DEFAULT_AVATAR_CONFIG } from './avatarConfig';
import { scanLive2DModelFolder, type Live2DModelProfile } from './live2dAvatar';

export function getAvatarModelsDir(): string {
  return join(app.getPath('userData'), 'avatar-models');
}

export function cloneAvatarConfig(config: AvatarConfig): AvatarConfig {
  return JSON.parse(JSON.stringify(config)) as AvatarConfig;
}

export function normalizeAvatarConfig(config: AvatarConfig | null | undefined): AvatarConfig {
  if (!config) return cloneAvatarConfig(DEFAULT_AVATAR_CONFIG);
  return {
    activeModelId: typeof config.activeModelId === 'string'
      ? config.activeModelId
      : DEFAULT_AVATAR_CONFIG.activeModelId,
    models: Array.isArray(config.models) ? config.models : [],
  };
}

export function withBuiltinAvatarProfile(config: AvatarConfig, sourceDir: string): AvatarConfig {
  const next = normalizeAvatarConfig(config);
  const existing = next.models.find((model) => model.id === BUILTIN_HIYORI_MODEL_ID);
  const scanned = scanLive2DModelFolder(sourceDir);
  const builtin: Live2DModelProfile = {
    ...scanned,
    id: BUILTIN_HIYORI_MODEL_ID,
    name: 'Hiyori_pro',
    sourceDir,
    mapping: existing?.mapping ?? scanned.mapping,
  };
  const assigned = new Set(Object.values(builtin.mapping.motions).flat());
  builtin.unassignedMotionIds = builtin.motions
    .map((motion) => motion.id)
    .filter((id) => !assigned.has(id));
  next.models = [builtin, ...next.models.filter((model) => model.id !== BUILTIN_HIYORI_MODEL_ID)];
  if (!next.activeModelId) next.activeModelId = BUILTIN_HIYORI_MODEL_ID;
  return next;
}

export function importAvatarModelFolder(
  sourceDir: string,
  current: AvatarConfig,
  modelsDir = getAvatarModelsDir(),
): { config: AvatarConfig; profile: Live2DModelProfile } {
  const initialProfile = scanLive2DModelFolder(sourceDir);
  const modelId = uniqueModelId(slugify(initialProfile.name || basename(sourceDir)), current, modelsDir);
  const targetDir = join(modelsDir, modelId);

  mkdirSync(modelsDir, { recursive: true });
  if (existsSync(targetDir)) rmSync(targetDir, { recursive: true, force: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => !shouldSkipCopiedPath(src),
  });

  const profile = {
    ...scanLive2DModelFolder(targetDir),
    id: modelId,
    sourceDir: targetDir,
    importedAt: Date.now(),
  };
  const next = normalizeAvatarConfig(current);
  next.models = next.models.filter((model) => model.id !== modelId);
  next.models.push(profile);
  next.activeModelId = modelId;
  return { config: next, profile };
}

export function selectAvatarModel(config: AvatarConfig, modelId: string): AvatarConfig {
  const next = normalizeAvatarConfig(config);
  if (!next.models.some((model) => model.id === modelId)) {
    throw new Error(`Avatar model not found: ${modelId}`);
  }
  next.activeModelId = modelId;
  return next;
}

export function deleteAvatarModel(
  config: AvatarConfig,
  modelId: string,
  modelsDir = getAvatarModelsDir(),
): AvatarConfig {
  if (modelId === BUILTIN_HIYORI_MODEL_ID) {
    throw new Error('Builtin avatar model cannot be deleted.');
  }
  const next = normalizeAvatarConfig(config);
  const existing = next.models.find((model) => model.id === modelId);
  if (!existing) {
    throw new Error(`Avatar model not found: ${modelId}`);
  }
  next.models = next.models.filter((model) => model.id !== modelId);
  if (next.activeModelId === modelId) {
    next.activeModelId = BUILTIN_HIYORI_MODEL_ID;
  }

  const targetDir = resolve(modelsDir, modelId);
  const rel = relative(resolve(modelsDir), targetDir);
  if (!rel.startsWith('..') && rel !== '..' && existsSync(targetDir)) {
    rmSync(targetDir, { recursive: true, force: true });
  }
  return next;
}

export function modelBaseUrl(modelId: string): string {
  return `hiyori-avatar://model/${encodeURIComponent(modelId)}/`;
}

export function resolveAvatarProtocolPath(
  url: URL,
  modelsDir = getAvatarModelsDir(),
  builtinModelDir?: string,
): string | null {
  if (url.hostname !== 'model') return null;
  const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
  const [modelId, ...rest] = parts;
  if (!modelId) return null;
  const root = modelId === BUILTIN_HIYORI_MODEL_ID && builtinModelDir
    ? resolve(builtinModelDir)
    : resolve(modelsDir, modelId);
  const filePath = resolve(root, ...rest);
  const rel = relative(root, filePath);
  if (rel.startsWith('..') || rel === '..') return null;
  return filePath;
}

function uniqueModelId(base: string, current: AvatarConfig, modelsDir: string): string {
  const used = new Set(current.models.map((model) => model.id));
  const safeBase = base || 'avatar';
  let candidate = safeBase;
  let suffix = 2;
  while (used.has(candidate) || existsSync(join(modelsDir, candidate))) {
    candidate = `${safeBase}-${suffix++}`;
  }
  return candidate;
}

function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '');
}

function shouldSkipCopiedPath(src: string): boolean {
  const name = basename(src).toLowerCase();
  return name === 'thumbs.db' || name === '.ds_store';
}
