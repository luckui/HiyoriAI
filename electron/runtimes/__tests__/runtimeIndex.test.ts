import { describe, expect, it } from 'vitest';
import { runtimeHost, runtimeRegistry } from '../index';

describe('runtime index', () => {
  it('registers the fake provider by default', () => {
    expect(runtimeRegistry.getProvider('fake')?.id).toBe('fake');
  });

  it('registers the Codex provider by default', () => {
    expect(runtimeRegistry.getProvider('codex')?.id).toBe('codex');
  });

  it('exposes an initially empty runtime host', () => {
    expect(runtimeHost.listSessions()).toEqual([]);
  });
});
