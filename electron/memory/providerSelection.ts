import type { AIConfig, LLMProviderConfig } from '../ai.config';

export type MemoryProviderSelection =
  | { key: string; provider: LLMProviderConfig; reason: 'ok' }
  | { key: string; provider: null; reason: 'missing_provider' | 'missing_api_key' };

export function selectMemoryRefinementProvider(config: AIConfig): MemoryProviderSelection {
  const key = config.activeProvider;
  const provider = config.providers[key];
  if (!provider) return { key, provider: null, reason: 'missing_provider' };
  if (!provider.apiKey?.trim()) return { key, provider: null, reason: 'missing_api_key' };
  return { key, provider, reason: 'ok' };
}
