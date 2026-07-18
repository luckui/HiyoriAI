import { mkdtempSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import type { AIConfig } from '../../ai.config';
import type { TTSConfig } from '../../tts.config';
import type { SkillsConfig } from '../../skillsConfig';
import type { BridgeAppConfig } from '../appConfig';
import { loadAppConfigFromFile, saveAppConfig, type SettingsStore } from '../configStore';

function makeStore(): SettingsStore & { values: Map<string, string> } {
  const values = new Map<string, string>();
  return {
    values,
    getSetting: (key) => values.get(key) ?? null,
    setSetting: (key, value) => {
      values.set(key, value);
    },
  };
}

function defaults() {
  const llm: AIConfig = {
    activeProvider: 'local',
    contextWindowRounds: 4,
    providers: {
      local: {
        type: 'openai-compatible',
        name: 'Local',
        baseUrl: 'http://localhost:8000/v1',
        apiKey: '',
        model: 'model-a',
        systemPrompt: 'legacy prompt',
      },
    },
  };
  const tts: TTSConfig = {
    enabled: false,
    activeProvider: 'edge',
    providers: {
      edge: {
        type: 'http-tts',
        name: 'Edge',
        baseUrl: 'http://127.0.0.1:9880',
        apiKey: '',
        speaker: 'xiaoxiao',
        language: 'Auto',
      },
    },
  };
  const skills: SkillsConfig = {
    enabled: true,
    listingMode: 'full',
    disabledCollections: [],
    disabledSkills: [],
    collectionModes: {},
  };
  const bridges: BridgeAppConfig = {
    discord: { enabled: false, token: '', allowedChannels: '', proxyUrl: '' },
    wechat: {
      enabled: false,
      token: '',
      accountId: '',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      sendChunkDelay: 0.35,
    },
  };
  return { llm, tts, skills, bridges };
}

describe('configStore', () => {
  it('creates config.json and mirrors it into SQLite settings on startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hiyori-config-'));
    const filePath = join(dir, 'config.json');
    const store = makeStore();

    const config = loadAppConfigFromFile(defaults(), store, filePath);

    expect(config.llm.activeProvider).toBe('local');
    expect(JSON.parse(readFileSync(filePath, 'utf-8')).llm.activeProvider).toBe('local');
    expect(JSON.parse(readFileSync(filePath, 'utf-8')).llm.providers.local.systemPrompt).toBeUndefined();
    expect(JSON.parse(store.values.get('llm_config') ?? '{}').activeProvider).toBe('local');
    expect(JSON.parse(store.values.get('bridge_config') ?? '{}').wechat.sendChunkDelay).toBe(0.35);
  });

  it('uses config.json to overwrite stale SQLite settings on startup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hiyori-config-'));
    const filePath = join(dir, 'config.json');
    const store = makeStore();
    store.setSetting('llm_config', JSON.stringify({ activeProvider: 'stale' }));
    const fileConfig = {
      version: 1,
      ...defaults(),
      llm: {
        ...defaults().llm,
        activeProvider: 'file-provider',
        providers: {
          'file-provider': {
            type: 'openai-compatible',
            name: 'File Provider',
            baseUrl: 'http://localhost:9000/v1',
            apiKey: '',
            model: 'model-file',
          },
        },
      },
    };
    require('fs').writeFileSync(filePath, JSON.stringify(fileConfig), 'utf-8');

    loadAppConfigFromFile(defaults(), store, filePath);

    expect(JSON.parse(store.values.get('llm_config') ?? '{}').activeProvider).toBe('file-provider');
  });

  it('saveAppConfig writes config.json and SQLite settings together', () => {
    const dir = mkdtempSync(join(tmpdir(), 'hiyori-config-'));
    const filePath = join(dir, 'config.json');
    const store = makeStore();
    const config = {
      version: 1 as const,
      ...defaults(),
      bridges: {
        ...defaults().bridges,
        discord: {
          enabled: true,
          token: 'token',
          allowedChannels: '123,456',
          proxyUrl: 'http://127.0.0.1:7897',
        },
      },
    };

    saveAppConfig(config, store, filePath);

    expect(JSON.parse(readFileSync(filePath, 'utf-8')).bridges.discord.enabled).toBe(true);
    expect(JSON.parse(store.values.get('bridge_config') ?? '{}').discord.proxyUrl).toBe('http://127.0.0.1:7897');
  });
});
