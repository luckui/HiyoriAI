import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';

import { scanLive2DModelFolder } from '../live2dAvatar';

function makeModelFixture(): string {
  const dir = join(tmpdir(), `hiyori-avatar-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  mkdirSync(join(dir, 'motions'), { recursive: true });
  mkdirSync(join(dir, 'expressions'), { recursive: true });
  writeFileSync(join(dir, 'Haru.model3.json'), JSON.stringify({
    Version: 3,
    FileReferences: {
      Moc: 'Haru.moc3',
      Textures: ['textures/texture_00.png'],
      Motions: {
        Idle: [{ File: 'motions/idle_01.motion3.json' }],
        TapBody: [{ File: 'motions/tap_01.motion3.json' }],
        Flick: [{ File: 'motions/flick_01.motion3.json' }],
      },
      Expressions: [
        { Name: 'Smile', File: 'expressions/smile.exp3.json' },
      ],
    },
    HitAreas: [
      { Id: 'HitAreaHead', Name: 'Head' },
      { Id: 'HitAreaBody', Name: 'Body' },
    ],
    Groups: [
      { Target: 'Parameter', Name: 'LipSync', Ids: ['ParamMouthOpenY'] },
    ],
  }), 'utf-8');
  return dir;
}

describe('scanLive2DModelFolder', () => {
  it('reads motions, expressions, hit areas, and lip sync ids from model3.json', () => {
    const profile = scanLive2DModelFolder(makeModelFixture());

    expect(profile.name).toBe('Haru');
    expect(profile.modelJsonName).toBe('Haru.model3.json');
    expect(profile.motions.map((m) => `${m.group}:${m.file}`)).toEqual([
      'Idle:motions/idle_01.motion3.json',
      'TapBody:motions/tap_01.motion3.json',
      'Flick:motions/flick_01.motion3.json',
    ]);
    expect(profile.expressions).toEqual([
      { id: 'Smile', name: 'Smile', file: 'expressions/smile.exp3.json' },
    ]);
    expect(profile.hitAreas.map((area) => area.name)).toEqual(['Head', 'Body']);
    expect(profile.lipSyncIds).toEqual(['ParamMouthOpenY']);
  });

  it('maps Idle to idle and TapBody to touch without guessing thinking or speaking', () => {
    const profile = scanLive2DModelFolder(makeModelFixture());

    expect(profile.mapping.motions.idle).toEqual(['Idle:0']);
    expect(profile.mapping.motions.touch).toEqual(['TapBody:0']);
    expect(profile.mapping.motions.thinking).toEqual([]);
    expect(profile.mapping.motions.speaking).toEqual([]);
    expect(profile.unassignedMotionIds).toEqual(['Flick:0']);
  });
});
