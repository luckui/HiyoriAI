import { mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: () => join(tmpdir(), 'hiyori-avatar-test-user-data'),
  },
}));

import {
  deleteAvatarModel,
  importAvatarModelFolder,
  selectAvatarModel,
  withBuiltinAvatarProfile,
} from '../avatarManager';
import type { AvatarConfig } from '../avatarConfig';

function makeChineseNamedModelFixture(): string {
  const dir = join(tmpdir(), `hiyori-avatar-manager-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(dir, 'motions'), { recursive: true });
  writeFileSync(join(dir, '派蒙.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'Paimon.moc3',
      Textures: ['textures/texture_00.png'],
      Motions: {
        Idle: [{ File: 'motions/idle.motion3.json' }],
      },
    },
  }), 'utf-8');
  writeFileSync(join(dir, 'Paimon.moc3'), '');
  return dir;
}

describe('importAvatarModelFolder', () => {
  let config: AvatarConfig;

  beforeEach(() => {
    config = { activeModelId: 'builtin:hiyori_pro', models: [] };
  });

  it('uses avatar fallback ids when the model name cannot be slugged', () => {
    const modelsDir = join(tmpdir(), `hiyori-avatar-imports-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    const first = importAvatarModelFolder(makeChineseNamedModelFixture(), config, modelsDir);
    const second = importAvatarModelFolder(makeChineseNamedModelFixture(), first.config, modelsDir);

    expect(first.profile.id).toBe('avatar');
    expect(second.profile.id).toBe('avatar-2');
    expect(second.config.activeModelId).toBe('avatar-2');
  });
});

describe('withBuiltinAvatarProfile', () => {
  it('injects the builtin Hiyori profile while preserving saved builtin mappings', () => {
    const sourceDir = makeChineseNamedModelFixture();
    const saved: AvatarConfig = {
      activeModelId: 'builtin:hiyori_pro',
      models: [{
        id: 'builtin:hiyori_pro',
        name: 'Old Builtin',
        sourceDir: 'stale',
        modelJsonName: 'stale.model3.json',
        motions: [],
        expressions: [],
        hitAreas: [],
        lipSyncIds: [],
        mapping: {
          motions: {
            idle: ['Idle:0'],
            touch: [],
            thinking: ['Idle:0'],
            speaking: [],
          },
          expressions: {},
        },
        unassignedMotionIds: [],
      }],
    };

    const config = withBuiltinAvatarProfile(saved, sourceDir);
    const builtin = config.models.find((model) => model.id === 'builtin:hiyori_pro');

    expect(builtin?.sourceDir).toBe(sourceDir);
    expect(builtin?.name).toBe('Hiyori_pro');
    expect(builtin?.motions.map((motion) => motion.id)).toEqual(['Idle:0']);
    expect(builtin?.mapping.motions.thinking).toEqual(['Idle:0']);
  });
});

describe('avatar model selection and deletion', () => {
  function makeConfig(activeModelId = 'custom-1'): AvatarConfig {
    return {
      activeModelId,
      models: [
        {
          id: 'builtin:hiyori_pro',
          name: 'Hiyori_pro',
          sourceDir: 'builtin',
          modelJsonName: 'hiyori.model3.json',
          motions: [],
          expressions: [],
          hitAreas: [],
          lipSyncIds: [],
          mapping: { motions: { idle: [], touch: [], thinking: [], speaking: [] }, expressions: {} },
          unassignedMotionIds: [],
        },
        {
          id: 'custom-1',
          name: 'Custom 1',
          sourceDir: 'custom-1-dir',
          modelJsonName: 'custom.model3.json',
          motions: [],
          expressions: [],
          hitAreas: [],
          lipSyncIds: [],
          mapping: { motions: { idle: [], touch: [], thinking: [], speaking: [] }, expressions: {} },
          unassignedMotionIds: [],
        },
        {
          id: 'custom-2',
          name: 'Custom 2',
          sourceDir: 'custom-2-dir',
          modelJsonName: 'custom.model3.json',
          motions: [],
          expressions: [],
          hitAreas: [],
          lipSyncIds: [],
          mapping: { motions: { idle: [], touch: [], thinking: [], speaking: [] }, expressions: {} },
          unassignedMotionIds: [],
        },
      ],
    };
  }

  it('selects an existing model and rejects unknown ids', () => {
    expect(selectAvatarModel(makeConfig(), 'custom-2').activeModelId).toBe('custom-2');
    expect(() => selectAvatarModel(makeConfig(), 'missing')).toThrow('Avatar model not found');
  });

  it('deletes imported models and falls back to the builtin model when deleting the active one', () => {
    const deletedActive = deleteAvatarModel(makeConfig('custom-1'), 'custom-1');

    expect(deletedActive.activeModelId).toBe('builtin:hiyori_pro');
    expect(deletedActive.models.map((model) => model.id)).toEqual(['builtin:hiyori_pro', 'custom-2']);

    const deletedInactive = deleteAvatarModel(makeConfig('custom-1'), 'custom-2');
    expect(deletedInactive.activeModelId).toBe('custom-1');
    expect(deletedInactive.models.map((model) => model.id)).toEqual(['builtin:hiyori_pro', 'custom-1']);
  });

  it('does not delete the builtin model', () => {
    expect(() => deleteAvatarModel(makeConfig(), 'builtin:hiyori_pro')).toThrow('Builtin avatar model cannot be deleted');
  });
});
