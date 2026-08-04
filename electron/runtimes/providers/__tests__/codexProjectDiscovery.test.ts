import { mkdtemp, mkdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { describe, expect, it } from 'vitest';
import {
  listCodexProjectIndex,
  listCodexProjects,
  listCodexProjectTasks,
  resolveCodexProject,
} from '../codexProjectDiscovery';

async function writeSession(
  root: string,
  id: string,
  cwd: string,
  updatedAt: Date,
  firstPrompt: string,
  originator = 'Codex Desktop',
  source = 'vscode'
): Promise<void> {
  const dir = join(root, '2026', '07', '17');
  await mkdir(dir, { recursive: true });
  const file = join(dir, `rollout-${id}.jsonl`);
  const lines = [
    JSON.stringify({
      type: 'session_meta',
      payload: { id, cwd, timestamp: updatedAt.toISOString(), originator, source },
    }),
    JSON.stringify({
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: firstPrompt }],
      },
    }),
  ];
  await writeFile(file, lines.join('\n'), 'utf8');
  await new Promise((resolve) => setTimeout(resolve, 5));
}

describe('codex project discovery', () => {
  it('groups Codex sessions by cwd as projects and exposes tasks', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-projects-'));
    await writeSession(root, 'thread-old', 'D:/repo/live2d-pet', new Date('2026-07-16T10:00:00Z'), '修设置页面');
    await writeSession(root, 'thread-new', 'D:/repo/live2d-pet', new Date('2026-07-17T10:00:00Z'), '整理提示词系统');
    await writeSession(root, 'thread-other', 'D:/repo/other', new Date('2026-07-17T09:00:00Z'), '检查构建');

    const projects = await listCodexProjects({ sessionsRoot: root });

    expect(projects).toHaveLength(2);
    expect(projects[0]).toMatchObject({
      name: 'live2d-pet',
      cwd: 'D:/repo/live2d-pet',
      taskCount: 2,
      latestTaskId: 'thread-new',
    });

    const tasks = await listCodexProjectTasks({ sessionsRoot: root, project: 'live2d' });
    expect(tasks.map((task) => task.id)).toEqual(['thread-new', 'thread-old']);
    expect(tasks[0].title).toBe('整理提示词系统');
  });

  it('resolves a project by path basename or fuzzy alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-resolve-'));
    await writeSession(root, 'thread-one', 'D:/Other/Live2dWeb/live2d-pet', new Date('2026-07-17T10:00:00Z'), 'hello');

    const resolved = await resolveCodexProject({ sessionsRoot: root, query: 'live2d' });

    expect(resolved.status).toBe('matched');
    expect(resolved.project?.cwd).toBe('D:/Other/Live2dWeb/live2d-pet');
  });

  it('reports total project count and source counts separately from the display limit', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-project-index-'));
    await writeSession(root, 'thread-desktop', 'D:/repo/live2d-pet', new Date('2026-07-17T10:00:00Z'), 'desktop task', 'Codex Desktop', 'vscode');
    await writeSession(root, 'thread-hiyori', 'D:/repo/live2d-pet', new Date('2026-07-17T11:00:00Z'), 'hiyori task', 'Hiyori', 'exec');
    await writeSession(root, 'thread-vscode', 'D:/repo/other', new Date('2026-07-17T09:00:00Z'), 'other task', 'codex_vscode', 'vscode');
    await writeSession(root, 'thread-old', 'D:/repo/old-project', new Date('2026-07-16T09:00:00Z'), 'old task', 'Codex Desktop', 'vscode');

    const index = await listCodexProjectIndex({ sessionsRoot: root, limit: 2 });

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

  it('resolves projects using all sessions even when candidate output is limited', async () => {
    const root = await mkdtemp(join(tmpdir(), 'codex-resolve-limit-'));
    await writeSession(root, 'thread-new', 'D:/repo/new-project', new Date('2026-07-17T10:00:00Z'), 'new');
    await writeSession(root, 'thread-old', 'D:/repo/GF-POST-STA-MINE', new Date('2026-06-03T10:00:00Z'), 'old');

    const resolved = await resolveCodexProject({ sessionsRoot: root, query: 'GF-POST-STA-MINE', limit: 1 });

    expect(resolved.status).toBe('matched');
    expect(resolved.project?.cwd).toBe('D:/repo/GF-POST-STA-MINE');
  });
});
