import { describe, expect, it } from 'vitest';
import config from '../../electron.vite.config';

describe('electron-vite Minecraft worker config', () => {
  it('keeps mineflayer runtime dependencies external so protodef dynamic compilers run in Node scope', () => {
    const mainConfig = Array.isArray(config) ? config[0]?.main : config.main;
    const external = mainConfig?.build?.rollupOptions?.external;

    expect(Array.isArray(external)).toBe(true);
    expect(external).toEqual(
      expect.arrayContaining([
        'mineflayer',
        'mineflayer-auto-eat',
        'mineflayer-collectblock',
        'mineflayer-pathfinder',
        'mineflayer-pvp',
        'mineflayer-tool',
        'protodef',
      ]),
    );
  });
});
