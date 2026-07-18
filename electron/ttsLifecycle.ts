import type { TTSConfig } from './tts.config';

type InstallAndStart = (
  onProgress?: (msg: string) => void,
  engine?: string,
) => Promise<{ ok: boolean; detail: string }>;

export interface TTSLifecycleDeps {
  installAndStart?: InstallAndStart;
  onProgress?: (msg: string) => void;
}

export async function ensureTTSRuntimeReady(
  config: TTSConfig,
  deps: TTSLifecycleDeps = {},
): Promise<{ ok: boolean; detail: string }> {
  if (!config.enabled) {
    return { ok: true, detail: 'TTS disabled' };
  }

  const provider = config.providers[config.activeProvider];
  if (!provider) {
    return { ok: false, detail: `TTS provider not found: ${config.activeProvider}` };
  }

  if (!provider.isLocal) {
    return { ok: true, detail: 'External TTS provider selected' };
  }

  const installAndStart = deps.installAndStart;
  if (!installAndStart) {
    return { ok: false, detail: 'TTS install/start dependency is not configured' };
  }
  return installAndStart(deps.onProgress, provider.localEngine);
}
