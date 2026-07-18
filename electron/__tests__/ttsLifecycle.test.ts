import { describe, expect, it, vi } from 'vitest';
import type { TTSConfig } from '../tts.config';
import { ensureTTSRuntimeReady } from '../ttsLifecycle';

function makeConfig(overrides: Partial<TTSConfig> = {}): TTSConfig {
  return {
    enabled: true,
    activeProvider: 'local_edge_tts',
    providers: {
      local_edge_tts: {
        type: 'http-tts',
        name: 'Edge TTS',
        baseUrl: 'http://127.0.0.1:9880',
        apiKey: '',
        speaker: 'xiaoxiao',
        language: 'Auto',
        isLocal: true,
        localEngine: 'edge-tts',
      },
      local_genie_tts: {
        type: 'http-tts',
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
    ...overrides,
  };
}

describe('TTS lifecycle', () => {
  it('does not touch local services when voice broadcast is disabled', async () => {
    const installAndStart = vi.fn();

    await ensureTTSRuntimeReady(makeConfig({ enabled: false }), { installAndStart });

    expect(installAndStart).not.toHaveBeenCalled();
  });

  it('starts or installs the active local provider when voice broadcast is enabled', async () => {
    const installAndStart = vi.fn().mockResolvedValue({ ok: true, detail: 'ready' });

    const result = await ensureTTSRuntimeReady(makeConfig(), { installAndStart });

    expect(installAndStart).toHaveBeenCalledWith(undefined, 'edge-tts');
    expect(result.ok).toBe(true);
  });

  it('uses the newly selected provider when applying saved settings', async () => {
    const installAndStart = vi.fn().mockResolvedValue({ ok: true, detail: 'ready' });

    await ensureTTSRuntimeReady(makeConfig({ activeProvider: 'local_genie_tts' }), { installAndStart });

    expect(installAndStart).toHaveBeenCalledWith(undefined, 'genie-tts');
  });
});
