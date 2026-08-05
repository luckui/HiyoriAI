import { listCodexProjectTasks } from './codexProjectDiscovery';

export interface CodexSessionCandidate {
  id: string;
  cwd?: string;
  file?: string;
  title?: string;
  updatedAt: number;
}

export async function listCodexSessionCandidates(options: {
  cwd?: string;
  limit?: number;
} = {}): Promise<CodexSessionCandidate[]> {
  const tasks = await listCodexProjectTasks({
    cwd: options.cwd,
    limit: options.limit ?? 5,
  });

  return tasks.map((task) => ({
    id: task.id,
    cwd: task.cwd,
    file: task.file,
    title: task.title,
    updatedAt: task.updatedAt,
  }));
}
