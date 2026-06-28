import { describe, expect, it } from 'vitest';
import type { AIConfig } from '../../ai.config';
import { selectMemoryRefinementProvider } from '../providerSelection';

function makeConfig(activeProvider: string): AIConfig {
  return {
    activeProvider,
    contextWindowRounds: 6,
    providers: {
      active: {
        type: 'openai-compatible',
        name: 'Active',
        baseUrl: 'https://active.example/v1',
        apiKey: '',
        model: 'active-model',
      },
      stale: {
        type: 'openai-compatible',
        name: 'Stale',
        baseUrl: 'https://stale.example/v1',
        apiKey: 'stale-key',
        model: 'stale-model',
      },
    },
  };
}

describe('selectMemoryRefinementProvider', () => {
  it('does not fall back to another provider when the active provider has no API key', () => {
    const selected = selectMemoryRefinementProvider(makeConfig('active'));

    expect(selected).toEqual({
      key: 'active',
      provider: null,
      reason: 'missing_api_key',
    });
  });
});
