import { describe, expect, it } from 'vitest';
import { resolveToolset } from '../../../toolsets';
import codexProjectsTool from '../codexProjects';

describe('codex_projects tool', () => {
  it('is available alongside coding_agent in agent modes', () => {
    expect(resolveToolset('agent')).toContain('codex_projects');
    expect(resolveToolset('agent-debug')).toContain('codex_projects');
    expect(resolveToolset('developer')).toContain('codex_projects');
  });

  it('exposes project and task discovery actions', () => {
    const action = codexProjectsTool.schema.function.parameters.properties.action;
    expect(action.enum).toEqual(['list_projects', 'list_tasks', 'resolve_project']);
  });
});
