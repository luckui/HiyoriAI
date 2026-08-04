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
  sourceKind: CodexTaskSourceKind;
  sourceLabel: string;
}

export type CodexTaskSourceKind = 'hiyori' | 'desktop' | 'vscode' | 'sdk' | 'external';

export interface CodexTaskSourceCounts {
  hiyori: number;
  desktop: number;
  vscode: number;
  sdk: number;
  external: number;
}

export interface CodexProjectSummary {
  name: string;
  cwd: string;
  taskCount: number;
  latestTaskId: string;
  latestTaskTitle: string;
  updatedAt: number;
  sourceCounts: CodexTaskSourceCounts;
  sourceLabels: string[];
}

export interface CodexProjectIndex {
  projects: CodexProjectSummary[];
  totalCount: number;
  shownCount: number;
  hasMore: boolean;
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
  const index = await listCodexProjectIndex(options);
  return index.projects;
}

export async function listCodexProjectIndex(options: CodexDiscoveryOptions = {}): Promise<CodexProjectIndex> {
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
    const sourceCounts = countSources(group);
    return {
      name: projectName(latest.cwd),
      cwd: latest.cwd,
      taskCount: group.length,
      latestTaskId: latest.id,
      latestTaskTitle: latest.title,
      updatedAt: latest.updatedAt,
      sourceCounts,
      sourceLabels: sourceLabels(sourceCounts),
    };
  });

  const sorted = projects.sort((a, b) => b.updatedAt - a.updatedAt);
  const limit = options.limit ?? 20;
  const shown = sorted.slice(0, limit);
  return {
    projects: shown,
    totalCount: sorted.length,
    shownCount: shown.length,
    hasMore: shown.length < sorted.length,
  };
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
  const projects = await listCodexProjects({ sessionsRoot: options.sessionsRoot });
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

export function classifyCodexTaskSource(originator?: string, source?: string): CodexTaskSourceKind {
  const normalizedOriginator = (originator ?? '').trim().toLowerCase();
  const normalizedSource = (source ?? '').trim().toLowerCase();
  if (normalizedOriginator === 'hiyori') return 'hiyori';
  if (normalizedOriginator === 'codex desktop') return 'desktop';
  if (normalizedOriginator === 'codex_vscode' || normalizedSource === 'vscode') return 'vscode';
  if (normalizedOriginator === 'codex_sdk_ts' || normalizedSource === 'exec') return 'sdk';
  return 'external';
}

export function codexTaskSourceLabel(sourceKind: CodexTaskSourceKind): string {
  switch (sourceKind) {
    case 'hiyori':
      return 'Hiyori';
    case 'desktop':
      return 'Codex Desktop';
    case 'vscode':
      return 'VSCode';
    case 'sdk':
      return 'SDK/自动化';
    case 'external':
      return '外部来源';
  }
}

function emptySourceCounts(): CodexTaskSourceCounts {
  return {
    hiyori: 0,
    desktop: 0,
    vscode: 0,
    sdk: 0,
    external: 0,
  };
}

function countSources(tasks: CodexTaskSummary[]): CodexTaskSourceCounts {
  const counts = emptySourceCounts();
  for (const task of tasks) counts[task.sourceKind]++;
  return counts;
}

function sourceLabels(counts: CodexTaskSourceCounts): string[] {
  const entries: Array<[CodexTaskSourceKind, number]> = [
    ['hiyori', counts.hiyori],
    ['desktop', counts.desktop],
    ['vscode', counts.vscode],
    ['sdk', counts.sdk],
    ['external', counts.external],
  ];
  return entries
    .filter(([, count]) => count > 0)
    .map(([kind, count]) => `${codexTaskSourceLabel(kind)} ${count}`);
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
    sourceKind: classifyCodexTaskSource(meta.originator, meta.source),
    sourceLabel: codexTaskSourceLabel(classifyCodexTaskSource(meta.originator, meta.source)),
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
