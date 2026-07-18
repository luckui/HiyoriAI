import { createReadStream } from 'fs';
import { readdir, stat } from 'fs/promises';
import { homedir } from 'os';
import { basename, join, normalize } from 'path';
import { createInterface } from 'readline';

export interface CodexTaskSummary {
  id: string;
  cwd: string;
  title: string;
  file: string;
  createdAt?: string;
  updatedAt: number;
  originator?: string;
  model?: string;
  source?: string;
}

export interface CodexProjectSummary {
  name: string;
  cwd: string;
  taskCount: number;
  latestTaskId: string;
  latestTaskTitle: string;
  updatedAt: number;
}

export interface CodexDiscoveryOptions {
  sessionsRoot?: string;
  limit?: number;
}

export interface CodexProjectQueryOptions extends CodexDiscoveryOptions {
  project?: string;
  cwd?: string;
}

export interface CodexProjectResolveOptions extends CodexDiscoveryOptions {
  query: string;
}

export type CodexProjectResolveResult =
  | { status: 'matched'; project: CodexProjectSummary; candidates: CodexProjectSummary[] }
  | { status: 'ambiguous'; candidates: CodexProjectSummary[] }
  | { status: 'not_found'; candidates: CodexProjectSummary[] };

interface SessionMetaPayload {
  id?: string;
  session_id?: string;
  cwd?: string;
  timestamp?: string;
  originator?: string;
  source?: string;
  model?: string;
  model_provider?: string;
}

interface SessionJsonlRecord {
  type?: string;
  payload?: any;
}

function defaultSessionsRoot(): string {
  return join(homedir(), '.codex', 'sessions');
}

function projectName(cwd: string): string {
  return basename(normalize(cwd)) || cwd;
}

function normalizeMatchText(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '未命名任务';
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

export async function listCodexProjects(options: CodexDiscoveryOptions = {}): Promise<CodexProjectSummary[]> {
  const tasks = await readCodexTasks(options);
  const groups = new Map<string, CodexTaskSummary[]>();

  for (const task of tasks) {
    const key = normalize(task.cwd);
    const group = groups.get(key) ?? [];
    group.push(task);
    groups.set(key, group);
  }

  const projects = Array.from(groups.values()).map((group) => {
    group.sort((a, b) => b.updatedAt - a.updatedAt);
    const latest = group[0];
    return {
      name: projectName(latest.cwd),
      cwd: latest.cwd,
      taskCount: group.length,
      latestTaskId: latest.id,
      latestTaskTitle: latest.title,
      updatedAt: latest.updatedAt,
    };
  });

  return projects
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, options.limit ?? 20);
}

export async function listCodexProjectTasks(options: CodexProjectQueryOptions = {}): Promise<CodexTaskSummary[]> {
  const tasks = await readCodexTasks(options);
  const target = options.cwd
    ? normalizeMatchText(normalize(options.cwd))
    : options.project?.trim()
      ? normalizeMatchText(options.project.trim())
      : '';

  if (!target) return tasks.slice(0, options.limit ?? 10);

  return tasks
    .filter((task) => {
      const cwd = normalizeMatchText(normalize(task.cwd));
      const name = normalizeMatchText(projectName(task.cwd));
      return cwd === target || cwd.includes(target) || name === target || name.includes(target);
    })
    .slice(0, options.limit ?? 10);
}

export async function resolveCodexProject(options: CodexProjectResolveOptions): Promise<CodexProjectResolveResult> {
  const query = normalizeMatchText(options.query.trim());
  const projects = await listCodexProjects(options);
  if (!query) return { status: 'not_found', candidates: projects.slice(0, options.limit ?? 5) };

  const exact = projects.filter((project) => {
    const name = normalizeMatchText(project.name);
    const cwd = normalizeMatchText(normalize(project.cwd));
    return name === query || cwd === query;
  });
  if (exact.length === 1) return { status: 'matched', project: exact[0], candidates: exact };
  if (exact.length > 1) return { status: 'ambiguous', candidates: exact };

  const fuzzy = projects.filter((project) => {
    const name = normalizeMatchText(project.name);
    const cwd = normalizeMatchText(normalize(project.cwd));
    return name.includes(query) || cwd.includes(query);
  });
  if (fuzzy.length === 1) return { status: 'matched', project: fuzzy[0], candidates: fuzzy };
  if (fuzzy.length > 1) return { status: 'ambiguous', candidates: fuzzy.slice(0, options.limit ?? 5) };
  return { status: 'not_found', candidates: projects.slice(0, options.limit ?? 5) };
}

async function readCodexTasks(options: CodexDiscoveryOptions = {}): Promise<CodexTaskSummary[]> {
  const files = await listJsonlFiles(options.sessionsRoot ?? defaultSessionsRoot()).catch(() => []);
  const sorted = files.sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 500);
  const tasks: CodexTaskSummary[] = [];

  for (const file of sorted) {
    const task = await readTaskSummary(file.path, file.updatedAt);
    if (!task) continue;
    tasks.push(task);
  }

  return tasks.sort((a, b) => b.updatedAt - a.updatedAt);
}

async function listJsonlFiles(dir: string): Promise<Array<{ path: string; updatedAt: number }>> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: Array<{ path: string; updatedAt: number }> = [];

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listJsonlFiles(fullPath));
      continue;
    }
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const info = await stat(fullPath);
    files.push({ path: fullPath, updatedAt: info.mtimeMs });
  }

  return files;
}

async function readTaskSummary(file: string, fallbackUpdatedAt: number): Promise<CodexTaskSummary | undefined> {
  const rl = createInterface({
    input: createReadStream(file, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  let meta: SessionMetaPayload | undefined;
  let firstUserText = '';
  let lineCount = 0;

  try {
    for await (const line of rl) {
      lineCount++;
      if (!meta && line.includes('"session_meta"')) {
        const record = JSON.parse(line) as SessionJsonlRecord;
        if (record.type === 'session_meta') meta = record.payload;
      }
      if (!firstUserText && line.includes('"role":"user"')) {
        firstUserText = extractUserText(line);
      }
      if (meta && firstUserText) break;
      if (lineCount > 200) break;
    }
  } catch {
    return undefined;
  } finally {
    rl.close();
  }

  const id = meta?.id ?? meta?.session_id;
  if (!id || !meta?.cwd) return undefined;
  const updatedAt = meta.timestamp ? Date.parse(meta.timestamp) || fallbackUpdatedAt : fallbackUpdatedAt;

  return {
    id,
    cwd: meta.cwd,
    title: truncateTitle(firstUserText),
    file,
    createdAt: meta.timestamp,
    updatedAt,
    originator: meta.originator,
    model: meta.model ?? meta.model_provider,
    source: meta.source,
  };
}

function extractUserText(line: string): string {
  try {
    const record = JSON.parse(line) as SessionJsonlRecord;
    const payload = record.payload;
    if (payload?.type !== 'message' || payload.role !== 'user') return '';
    const content = payload.content;
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content
      .map((part) => part?.text ?? part?.input_text ?? '')
      .filter(Boolean)
      .join('\n');
  } catch {
    return '';
  }
}
