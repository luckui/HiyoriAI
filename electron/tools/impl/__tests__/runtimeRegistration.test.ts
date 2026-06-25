import { describe, expect, it } from 'vitest';
import { resolveToolset } from '../../../toolsets';
import { runtimeTools } from '../runtime';

const runtimeToolNames = [
  'runtime_start',
  'runtime_send',
  'runtime_status',
  'runtime_interrupt',
  'runtime_list',
];

describe('runtime tool registration', () => {
  it('exports the expected runtime tools', () => {
    expect(runtimeTools.map((tool) => tool.schema.function.name)).toEqual(runtimeToolNames);
  });

  it('exposes runtime tools to debug and developer modes only', () => {
    const chatTools = resolveToolset('chat');
    const agentDebugTools = resolveToolset('agent-debug');
    const developerTools = resolveToolset('developer');

    for (const name of runtimeToolNames) {
      expect(chatTools).not.toContain(name);
      expect(agentDebugTools).toContain(name);
      expect(developerTools).toContain(name);
    }
  });
});
