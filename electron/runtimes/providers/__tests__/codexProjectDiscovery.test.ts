import { describe, expect, it } from 'vitest';
import {
  listCodexProjectIndex,
  listCodexProjects,
  listCodexProjectTasks,
  resolveCodexProject,
} from '../codexProjectDiscovery';

function createListThreads(threads: any[]) {
  return async ({ limit = 100, cursor }: any) => {
    const start = cursor ? Number(cursor) : 0;
    const data = threads.slice(start, start + limit);
    const next = start + data.length < threads.length ? String(start + data.length) : null;
    return { data, nextCursor: next };
  };
}

function thread(
  id: string,
  cwd: string,
  updatedAt: number,
  name: string,
  source = 'vscode',
  threadSource: string | null = null
) {
  return {
    id,
    cwd,
    name,
    preview: `${name} preview`,
    source,
    threadSource,
    modelProvider: 'openai',
    createdAt: updatedAt - 60,
    updatedAt,
    recencyAt: updatedAt,
    path: `C:/Users/PC/.codex/sessions/${id}.jsonl`,
  };
}

describe('codex project discovery', () => {
  it('groups app-server Codex threads by cwd as projects and exposes named tasks', async () => {
    const listThreads = createListThreads([
      thread('thread-old', 'D:/repo/live2d-pet', 1780000000, '修设置页面'),
      thread('thread-new', 'D:/repo/live2d-pet', 1780000100, '整理提示词系统'),
      thread('thread-other', 'D:/repo/other', 1780000050, '检查构建'),
    ]);

    const projects = await listCodexProjects({ listThreads });

    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({
      name: 'live2d-pet',
      cwd: 'D:/repo/live2d-pet',
      taskCount: 2,
      latestTaskId: 'thread-new',
      latestTaskTitle: '整理提示词系统',
    });

    const tasks = await listCodexProjectTasks({ listThreads, project: 'live2d' });
    expect(tasks.map((task) => task.id)).toEqual(['thread-new', 'thread-old']);
    expect(tasks[0].title).toBe('整理提示词系统');
  });

  it('uses user-facing thread names for Codex Desktop temporary workspaces', async () => {
    const listThreads = createListThreads([
      thread('thread-xi', 'C:/Users/PC/Documents/Codex/2026-07-14/xi', 1780000100, '基金行情分析'),
      thread('thread-b', 'C:/Users/PC/Documents/Codex/2026-07-31/b', 1780000200, 'B站视频数据监控'),
    ]);

    const projects = await listCodexProjects({ listThreads });

    expect(projects.map((project) => project.name)).toEqual([
      '临时任务：B站视频数据监控',
      '临时任务：基金行情分析',
    ]);
    expect(projects.map((project) => project.name).join('\n')).not.toContain('xi');
    expect(projects.map((project) => project.name).join('\n')).not.toContain('/b');
  });

  it('reports total project count and source counts separately from the display limit', async () => {
    const listThreads = createListThreads([
      thread('thread-desktop', 'D:/repo/live2d-pet', 1780000100, 'desktop task', 'vscode'),
      thread('thread-hiyori', 'D:/repo/live2d-pet', 1780000200, 'hiyori task', 'appServer', 'hiyori'),
      thread('thread-other', 'D:/repo/other', 1780000050, 'other task', 'vscode'),
      thread('thread-old', 'D:/repo/old-project', 1779990000, 'old task', 'cli'),
    ]);

    const index = await listCodexProjectIndex({ listThreads, limit: 2 });

    expect(index.totalCount).toBe(3);
    expect(index.shownCount).toBe(2);
    expect(index.hasMore).toBe(true);
    expect(index.projects[0]).toMatchObject({
      name: 'live2d-pet',
      taskCount: 2,
      sourceCounts: {
        hiyori: 1,
        desktop: 1,
      },
    });
  });

  it('resolves projects using all app-server threads even when candidate output is limited', async () => {
    const listThreads = createListThreads([
      thread('thread-new', 'D:/repo/new-project', 1780000100, 'new'),
      thread('thread-old', 'D:/repo/GF-POST-STA-MINE', 1770000000, 'old'),
    ]);

    const resolved = await resolveCodexProject({ listThreads, query: 'GF-POST-STA-MINE', limit: 1 });

    expect(resolved.status).toBe('matched');
    expect(resolved.project?.cwd).toBe('D:/repo/GF-POST-STA-MINE');
  });
});
