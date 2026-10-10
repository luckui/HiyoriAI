import type { TTSProviderConfig } from '../../shared/types/config';
import type { SpeechEngine } from './engine';
import { DOUBAO_BIDIRECTIONAL_URL, DoubaoSpeechEngine } from './doubaoEngine';
import { HttpSpeechEngine } from './httpEngine';

function parseExtraParams(raw: string | undefined): Record<string, unknown> | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const value = JSON.parse(raw);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  } catch { /* 下面统一提示 */ }
  console.warn('[TTS] 豆包语音的额外参数不是合法的 JSON 对象，已忽略');
  return undefined;
}

export function createSpeechEngine(provider: TTSProviderConfig): SpeechEngine {
  if (provider.type === 'doubao-tts') {
    const doubao = provider.doubao ?? { appId: '', resourceId: 'seed-tts-1.0' };
    return new DoubaoSpeechEngine({
      url: provider.baseUrl || DOUBAO_BIDIRECTIONAL_URL,
      apiKey: provider.apiKey,
      appId: doubao.appId,
      resourceId: doubao.resourceId || 'seed-tts-1.0',
      speaker: provider.speaker,
      speechRate: doubao.speechRate,
      pitch: doubao.pitch,
      language: provider.language,
      extraParams: parseExtraParams(doubao.extraParams),
    });
  }
  return new HttpSpeechEngine({
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    speaker: provider.speaker,
    language: provider.language,
    // 本地引擎合成慢，第一句切短先播；远程服务一般够快，保持整句的韵律
    quickStart: Boolean(provider.isLocal),
  });
}
