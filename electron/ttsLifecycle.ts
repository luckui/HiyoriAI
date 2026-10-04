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

  const installAndStart = deps.installAndStart;
  if (!provider.isLocal) {
    // 云端方案配了本地备用：顺带把本地服务拉起来，云端断了才接得上；拉不起来不影响主方案
    const fallback = provider.fallbackProvider ? config.providers[provider.fallbackProvider] : undefined;
    if (fallback?.isLocal && installAndStart) {
      const result = await installAndStart(deps.onProgress, fallback.localEngine);
      if (!result.ok) return { ok: true, detail: `External TTS provider selected; fallback not ready: ${result.detail}` };
    }
    return { ok: true, detail: 'External TTS provider selected' };
  }

  if (!installAndStart) {
    return { ok: false, detail: 'TTS install/start dependency is not configured' };
  }
  return installAndStart(deps.onProgress, provider.localEngine);
}
