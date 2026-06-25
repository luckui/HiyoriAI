import { describe, expect, it } from 'vitest';
import { resolveToolset } from '../../../toolsets';

describe('coding agent tool registration', () => {
  it('exposes coding_agent to user-facing agent modes', () => {
    expect(resolveToolset('agent')).toContain('coding_agent');
    expect(resolveToolset('agent-debug')).toContain('coding_agent');
    expect(resolveToolset('developer')).toContain('coding_agent');
  });

  it('keeps raw runtime tools out of the normal agent mode', () => {
    expect(resolveToolset('agent')).not.toContain('runtime_start');
    expect(resolveToolset('agent')).not.toContain('runtime_providers');
  });
});
