import { beforeEach, describe, expect, it, vi } from 'vitest';
import manageTTSTool from '../manageTTS';

const configState = vi.hoisted(() => ({
  cfg: {
    enabled: false,
    activeProvider: 'local_edge_tts',
    providers: {
      local_edge_tts: {
        type: 'http-tts' as const,
        name: 'Edge TTS',
        baseUrl: 'http://127.0.0.1:9880',
        apiKey: '',
        speaker: 'xiaoxiao',
        language: 'Auto',
        isLocal: true,
        localEngine: 'edge-tts',
      },
      local_genie_tts: {
        type: 'http-tts' as const,
        name: 'Genie TTS',
        baseUrl: 'http://127.0.0.1:9882',
        apiKey: '',
        speaker: 'feibi',
        language: 'auto',
        isLocal: true,
        localEngine: 'genie-tts',
      },
    },
    deletedProviders: [],
  },
  updates: [] as unknown[],
}));

const managerMocks = vi.hoisted(() => ({
  getStatus: vi.fn(),
  installAndStart: vi.fn(),
  stopServer: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getAllWindows: () => [],
  },
}));

vi.mock('../../../main', () => ({
  getTTSConfig: () => configState.cfg,
  updateTTSConfig: (patch: unknown) => {
    configState.updates.push(patch);
    Object.assign(configState.cfg, patch);
  },
}));

vi.mock('../../../ttsServerManager', () => managerMocks);

describe('manage_tts tool', () => {
  beforeEach(() => {
    configState.cfg.enabled = false;
    configState.cfg.activeProvider = 'local_edge_tts';
    configState.updates = [];
    managerMocks.getStatus.mockReset();
    managerMocks.getStatus.mockResolvedValue({
      installed: false,
      running: false,
      healthy: false,
      pid: null,
      port: 9880,
      serverDir: 'tts-server',
      engine: 'edge-tts',
    });
    managerMocks.installAndStart.mockReset();
    managerMocks.installAndStart.mockResolvedValue({ ok: true, detail: 'started' });
    managerMocks.stopServer.mockReset();
    managerMocks.stopServer.mockResolvedValue({ ok: true, detail: 'stopped' });
  });

  it('exposes only user-intent TTS actions to the model', () => {
    const action = manageTTSTool.schema.function.parameters.properties.action;
    expect(action.enum).toEqual(['status', 'set_enabled', 'set_provider']);
  });

  it('does not switch providers while voice broadcast is disabled', async () => {
    const result = await manageTTSTool.execute({
      action: 'set_provider',
      provider: 'local_genie_tts',
    });

    expect(String(result)).toContain('语音播报未开启');
    expect(configState.cfg.activeProvider).toBe('local_edge_tts');
    expect(configState.updates).toEqual([]);
    expect(managerMocks.installAndStart).not.toHaveBeenCalled();
  });

  it('turns on the active local provider through install-and-start', async () => {
    const result = await manageTTSTool.execute({
      action: 'set_enabled',
      enabled: true,
    });

    expect(managerMocks.installAndStart).toHaveBeenCalledWith(expect.any(Function), 'edge-tts');
    expect(configState.updates).toContainEqual({ enabled: true });
    expect(String(result)).toContain('语音播报已开启');
  });
});
