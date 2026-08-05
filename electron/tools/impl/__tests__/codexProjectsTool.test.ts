import { beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveToolset } from '../../../toolsets';
import codexProjectsTool from '../codexProjects';
import { listCodexProjectIndex } from '../../../runtimes/providers/codexProjectDiscovery';

vi.mock('../../../runtimes/providers/codexProjectDiscovery', () => ({
  listCodexProjectIndex: vi.fn(),
  listCodexProjectTasks: vi.fn(),
  resolveCodexProject: vi.fn(),
}));

const mockedListCodexProjectIndex = vi.mocked(listCodexProjectIndex);

describe('codex_projects tool', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('is available alongside coding_agent in agent modes', () => {
    expect(resolveToolset('agent')).toContain('codex_projects');
    expect(resolveToolset('agent-debug')).toContain('codex_projects');
    expect(resolveToolset('developer')).toContain('codex_projects');
  });

  it('exposes project and task discovery actions', () => {
    const action = codexProjectsTool.schema.function.parameters.properties.action;
    expect(action.enum).toEqual(['list_projects', 'list_tasks', 'resolve_project']);
  });

  it('suggests a chat-friendly numbered project list instead of a markdown table', async () => {
    mockedListCodexProjectIndex.mockResolvedValue({
      totalCount: 16,
      shownCount: 2,
      hasMore: true,
      projects: [
        {
          name: 'live2d-pet',
          cwd: 'D:\\Other\\Live2dWeb\\live2d-pet',
          taskCount: 2,
          latestTaskId: 'thread-1',
          latestTaskTitle: 'live2d主线开发',
          updatedAt: new Date('2026-08-05T03:03:00.000Z').getTime(),
          sourceCounts: { hiyori: 1, desktop: 1, vscode: 0, sdk: 0, external: 0 },
          sourceLabels: ['Hiyori 1', 'Codex Desktop 1'],
        },
        {
          name: '简历',
          cwd: 'D:\\School\\简历',
          taskCount: 1,
          latestTaskId: 'thread-2',
          latestTaskTitle: '优化研究生简历',
          updatedAt: new Date('2026-08-04T14:41:00.000Z').getTime(),
          sourceCounts: { hiyori: 0, desktop: 1, vscode: 0, sdk: 0, external: 0 },
          sourceLabels: ['Codex Desktop 1'],
        },
      ],
    });

    const result = await codexProjectsTool.execute({ action: 'list_projects' });

    expect(result).toContain('我按最近活动列成编号给你看');
    expect(result).toContain('1. live2d-pet');
    expect(result).toContain('路径：D:\\Other\\Live2dWeb\\live2d-pet');
    expect(result).toContain('任务：2 个');
    expect(result).toContain('最近：live2d主线开发');
    expect(result).not.toContain('| 项目名 |');
    expect(result).not.toContain('|--------|');
  });
});
