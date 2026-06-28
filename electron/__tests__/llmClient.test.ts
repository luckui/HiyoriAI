import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchCompletion } from '../llmClient';
import type { LLMProviderConfig } from '../ai.config';

const provider: LLMProviderConfig = {
  type: 'openai-compatible',
  name: 'Test',
  baseUrl: 'https://api.example/v1',
  apiKey: 'test-key',
  model: 'test-model',
  maxTokens: 1024,
  temperature: 0.85,
};

describe('fetchCompletion', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('allows memory callers to override max tokens and temperature without changing provider config', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchCompletion(
      provider,
      [{ role: 'user', content: 'hello' }],
      undefined,
      undefined,
      { maxTokens: 400, temperature: 0.2 },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.max_tokens).toBe(400);
    expect(body.temperature).toBe(0.2);
  });

  it('can disable thinking for memory calls on thinking-capable models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchCompletion(
      { ...provider, model: 'doubao-seed-2-1-pro-260628' },
      [{ role: 'user', content: 'summarize' }],
      undefined,
      undefined,
      { disableThinking: true },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toEqual({ type: 'disabled' });
  });

  it('does not send provider-specific thinking controls to ordinary chat models', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);

    await fetchCompletion(
      { ...provider, model: 'gpt-4o-mini' },
      [{ role: 'user', content: 'summarize' }],
      undefined,
      undefined,
      { disableThinking: true },
    );

    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.thinking).toBeUndefined();
  });

  it('retries transient gateway failures', async () => {
    vi.useFakeTimers();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response('bad gateway', { status: 502 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { role: 'assistant', content: 'ok' }, finish_reason: 'stop' }] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);

    const promise = fetchCompletion(provider, [{ role: 'user', content: 'hello' }]);
    await vi.runAllTimersAsync();

    await expect(promise).resolves.toMatchObject({
      choices: [{ message: { content: 'ok' } }],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
