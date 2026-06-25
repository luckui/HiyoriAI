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

  it('does not expose the legacy proactive speak tool to agent modes', () => {
    expect(resolveToolset('agent')).not.toContain('speak');
    expect(resolveToolset('agent-debug')).not.toContain('speak');
    expect(resolveToolset('developer')).not.toContain('speak');
    expect(resolveToolset('streamer')).not.toContain('speak');
  });
});
