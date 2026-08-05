import { basename, normalize } from 'path';
import { CodexAppServerClient } from './codexAppServerClient';

export interface CodexTaskSummary {
  id: string;
  cwd: string;
  title: string;
  preview: string;
  file?: string;
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
  limit?: number;
  listThreads?: (params: CodexThreadListParams) => Promise<CodexThreadListResponse>;
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

interface CodexThreadListParams {
  cursor?: string | null;
  limit?: number | null;
  archived?: boolean | null;
  cwd?: string | string[] | null;
  searchTerm?: string | null;
  sourceKinds?: string[] | null;
}

interface CodexThreadListResponse {
  data: CodexThreadSummary[];
  nextCursor?: string | null;
}

interface CodexThreadSummary {
  id: string;
  preview?: string;
  cwd?: string;
  path?: string | null;
  name?: string | null;
  source?: string | { custom?: string } | { subAgent?: unknown };
  threadSource?: string | null;
  modelProvider?: string;
  createdAt?: number;
  updatedAt?: number;
  recencyAt?: number | null;
}

const CODEX_THREAD_SOURCE_KINDS = ['cli', 'vscode', 'exec', 'appServer', 'unknown'];

let sharedClient: CodexAppServerClient | undefined;

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
      name: projectDisplayName(latest),
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
      const project = normalizeMatchText(projectDisplayName(task));
      const title = normalizeMatchText(task.title);
      return cwd === target || cwd.includes(target) || project === target || project.includes(target) || title.includes(target);
    })
    .slice(0, options.limit ?? 10);
}

export async function resolveCodexProject(options: CodexProjectResolveOptions): Promise<CodexProjectResolveResult> {
  const query = normalizeMatchText(options.query.trim());
  const projects = await listCodexProjects({ listThreads: options.listThreads });
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
    const title = normalizeMatchText(project.latestTaskTitle);
    return name.includes(query) || cwd.includes(query) || title.includes(query);
  });
  if (fuzzy.length === 1) return { status: 'matched', project: fuzzy[0], candidates: fuzzy };
  if (fuzzy.length > 1) return { status: 'ambiguous', candidates: fuzzy.slice(0, options.limit ?? 5) };
  return { status: 'not_found', candidates: projects.slice(0, options.limit ?? 5) };
}

export function classifyCodexTaskSource(source?: string, threadSource?: string | null): CodexTaskSourceKind {
  const normalizedSource = (source ?? '').trim().toLowerCase();
  const normalizedThreadSource = (threadSource ?? '').trim().toLowerCase();
  if (normalizedThreadSource === 'hiyori') return 'hiyori';
  if (normalizedSource === 'vscode') return 'desktop';
  if (normalizedSource === 'appserver' || normalizedSource === 'exec') return 'sdk';
  if (normalizedSource === 'cli') return 'external';
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

function normalizeMatchText(value: string): string {
  return value.replace(/\\/g, '/').toLowerCase();
}

function truncateTitle(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return '未命名任务';
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
}

function isCodexTemporaryWorkspace(cwd: string): boolean {
  return /[\\/]Documents[\\/]Codex[\\/]\d{4}-\d{2}-\d{2}[\\/][^\\/]+$/i.test(cwd);
}

function projectDisplayName(task: Pick<CodexTaskSummary, 'cwd' | 'title'>): string {
  if (isCodexTemporaryWorkspace(task.cwd)) return `临时任务：${task.title}`;
  return basename(normalize(task.cwd)) || task.cwd;
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
  const listThreads = options.listThreads ?? defaultListThreads;
  const threads: CodexThreadSummary[] = [];
  let cursor: string | null | undefined;

  do {
    const response = await listThreads({
      cursor,
      limit: 100,
      archived: false,
      sourceKinds: CODEX_THREAD_SOURCE_KINDS,
    });
    threads.push(...response.data);
    cursor = response.nextCursor;
  } while (cursor && threads.length < 500);

  return threads.map(toTaskSummary).sort((a, b) => b.updatedAt - a.updatedAt);
}

async function defaultListThreads(params: CodexThreadListParams): Promise<CodexThreadListResponse> {
  if (!sharedClient) sharedClient = new CodexAppServerClient();
  await sharedClient.start();
  return sharedClient.request('thread/list', params);
}

function toTaskSummary(thread: CodexThreadSummary): CodexTaskSummary {
  const source = normalizeThreadSource(thread.source);
  const sourceKind = classifyCodexTaskSource(source, thread.threadSource);
  return {
    id: thread.id,
    cwd: thread.cwd ?? '',
    title: truncateTitle(thread.name || thread.preview || thread.id),
    preview: thread.preview ?? '',
    file: thread.path ?? undefined,
    createdAt: thread.createdAt ? new Date(thread.createdAt * 1000).toISOString() : undefined,
    updatedAt: (thread.recencyAt ?? thread.updatedAt ?? thread.createdAt ?? 0) * 1000,
    originator: thread.threadSource ?? undefined,
    model: thread.modelProvider,
    source,
    sourceKind,
    sourceLabel: codexTaskSourceLabel(sourceKind),
  };
}

function normalizeThreadSource(source: CodexThreadSummary['source']): string | undefined {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && 'custom' in source) return source.custom;
  if (source && typeof source === 'object' && 'subAgent' in source) return 'subAgent';
  return undefined;
}
