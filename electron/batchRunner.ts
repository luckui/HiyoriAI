/**
 * BatchRunner — 批量任务编排
 *
 * 流程（AI 调用 async_task batch → TaskManager.createBatch 一次性建档 → 以编排者身份运行 runBatch，不占 worker 槽位）：
 *   1. 建档：父任务与全部子任务在同一事务中创建；重试 / 断点续跑时复用已有子任务，只补齐缺失项
 *   2. 调度：先挂好取消监听，再把所有未终结的子任务交给 TaskManager 排队；并发与临时故障重试由 TaskManager 负责
 *   3. 跟踪：按子任务终态累计进度；出现鉴权 / 额度类错误或连续失败达到阈值时熔断，停掉其余子任务
 *   4. 汇总：父任务 result 只存统计与失败摘要，各项完整结果通过 formatBatchResultPage 分页读取
 *
 * metadata 格式（父 batch 任务）：
 *   { promptTemplate, items, toolsets?, maxRounds?, maxAttempts?, timeoutMs?, replyTarget? }
 * metadata 格式（子任务）：
 *   { batchIndex, item, toolsets, maxRounds, maxAttempts, timeoutMs, attempt?, failureKind? }
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { extname, isAbsolute, join } from 'path';
import {
  FORMAT_ERROR_PREFIX,
  normalizeResultSchema,
  resultsToCsv,
  summarizeResults,
  type ResultRow,
  type ResultSchema,
} from './resultSchema';
import {
  createTasks as dbCreateTasks,
  listTasks as dbListTasks,
  parseTaskMetadata,
  type DBTask,
  type NewTask,
  type TaskStatus,
} from './db';

// ── 类型与常量 ────────────────────────────────────────────

export interface BatchMeta {
  promptTemplate: string;
  items: string[];
  toolsets: string[];
  maxRounds: number;
  maxAttempts: number;
  timeoutMs: number;
  /** 声明后，子任务输出按此校验，完成时生成 CSV 结果表与统计 */
  resultSchema?: ResultSchema;
}

/** 结构化结果表（CSV）的存放目录；应用启动时设为 userData/batch-results */
let batchResultsDir = join(tmpdir(), 'hiyori-batch-results');

export function configureBatchResultsDir(dir: string): void {
  batchResultsDir = dir;
}

/** runBatch 需要的调度能力（由 TaskManager 注入，避免循环依赖） */
export interface BatchTaskHost {
  startExisting(task: DBTask): Promise<DBTask | null>;
  cancelTask(taskId: string, reason?: string): Promise<boolean>;
}

export const BATCH_MAX_ITEMS = 500;
export const BATCH_DEFAULT_TOOLSETS: readonly string[] = ['worker'];
export const BATCH_DEFAULT_MAX_ROUNDS = 10;
export const BATCH_DEFAULT_MAX_ATTEMPTS = 3;
/** 子任务单次尝试的超时：卡死的子任务会被中断并按临时故障重试 */
export const BATCH_CHILD_TIMEOUT_MS = 15 * 60_000;
/** 连续这么多个子任务最终失败（中间没有任何成功）即熔断 */
export const BATCH_CIRCUIT_BREAKER_FAILURES = 5;

const SUMMARY_FAILURE_LINES = 20;
const PAGE_DEFAULT_LIMIT = 20;
const PAGE_MAX_LIMIT = 100;
const PAGE_CHAR_BUDGET = 12_000;
const PAGE_ITEM_RESULT_LIMIT = 4_000;

type TerminalStatus = 'completed' | 'failed' | 'cancelled';
type SupervisionOutcome = { kind: 'done' } | { kind: 'cancelled' } | { kind: 'halted'; reason: string };

// ── 主函数 ────────────────────────────────────────────────

/**
 * 执行批量任务：确保子任务已建档 → 调度未完成的子任务 → 聚合结果
 *
 * @param parentTask - 父 batch 任务（type='batch'）
 * @param signal     - 取消信号
 * @param onProgress - 进度回调
 * @param host       - 子任务调度器（TaskManager）
 * @returns 汇总文本（统计 + 失败摘要）；熔断或全部失败时抛错
 */
export async function runBatch(
  parentTask: DBTask,
  signal: AbortSignal,
  onProgress: (progress: number, text: string) => void,
  host: BatchTaskHost,
): Promise<string> {
  const meta = parseBatchMeta(parentTask);
  const total = meta.items.length;
  if (signal.aborted) throw new Error('批量任务已被取消');

  const children = ensureBatchChildren(parentTask, meta);
  const tally: Record<TerminalStatus, number> = { completed: 0, failed: 0, cancelled: 0 };
  for (const child of children) {
    if (isTerminal(child.status)) tally[child.status] += 1;
  }
  const report = () => {
    const done = tally.completed + tally.failed + tally.cancelled;
    onProgress(done / total, `${done}/${total} 完成（✅${tally.completed} ❌${tally.failed} 🚫${tally.cancelled}）`);
  };
  report();

  let consecutiveFailures = 0;
  let consecutiveFormatFailures = 0;
  const outcome = await superviseChildren(
    children.filter((child) => !isTerminal(child.status)),
    signal,
    host,
    (settled) => {
      const status: TerminalStatus = settled?.status === 'completed' || settled?.status === 'cancelled'
        ? settled.status
        : 'failed';
      tally[status] += 1;
      report();
      if (status === 'completed') {
        consecutiveFailures = 0;
        consecutiveFormatFailures = 0;
        return undefined;
      }
      if (status === 'cancelled') return undefined;

      consecutiveFailures += 1;
      if (settled?.error?.startsWith(FORMAT_ERROR_PREFIX)) consecutiveFormatFailures += 1;
      const error = preview(settled?.error ?? '未知错误', 200);
      if (parseTaskMetadata(settled?.metadata ?? null).failureKind === 'fatal') {
        return `子任务遇到不可重试的服务错误（鉴权 / 额度等）：${error}`;
      }
      if (consecutiveFailures >= BATCH_CIRCUIT_BREAKER_FAILURES) {
        // 声明本身合法、却与任务意图不符（取值范围 / 可选值写错）时，会表现为大量格式不符
        const hint = consecutiveFormatFailures * 2 >= consecutiveFailures
          ? '。其中多数是结果格式不符：请检查 result_schema 是否与任务匹配（字段、取值范围、可选值），修正后重新创建批量任务'
          : '';
        return `连续 ${consecutiveFailures} 个子任务失败，最近一次错误：${error}${hint}`;
      }
      return undefined;
    },
  );

  if (outcome.kind === 'cancelled') throw new Error('批量任务已被取消');
  const finalChildren = dbListTasks({ parentTaskId: parentTask.id });
  const resultReport = meta.resultSchema ? writeResultReport(parentTask, finalChildren, meta.resultSchema) : [];
  const summary = [buildBatchSummary(parentTask, finalChildren), ...resultReport].join('\n');
  if (outcome.kind === 'halted') throw new Error(`批量任务已熔断：${outcome.reason}\n\n${summary}`);
  if (tally.completed === 0) throw new Error(`批量任务的 ${total} 个子任务全部未成功。\n\n${summary}`);
  return summary;
}

/**
 * 调度并监督子任务，直到全部终结、被取消或触发熔断。
 * 取消 / 熔断时会等剩余子任务真正退出后才返回，保证父任务进入终态时没有仍在运行的子任务。
 *
 * @param onSettled - 每个子任务终结时调用；返回非空字符串表示熔断原因
 */
function superviseChildren(
  active: DBTask[],
  signal: AbortSignal,
  host: BatchTaskHost,
  onSettled: (settled: DBTask | null) => string | undefined,
): Promise<SupervisionOutcome> {
  return new Promise((resolve) => {
    const remaining = new Set(active.map((child) => child.id));
    let stopping = false;

    const finish = (outcome: SupervisionOutcome) => {
      stopping = true;
      signal.removeEventListener('abort', onAbort);
      resolve(outcome);
    };
    const stop = (outcome: SupervisionOutcome, reason: string) => {
      if (stopping) return;
      stopping = true;
      signal.removeEventListener('abort', onAbort);
      void Promise.all([...remaining].map((id) => host.cancelTask(id, reason))).then(() => resolve(outcome));
    };
    const onAbort = () => stop({ kind: 'cancelled' }, 'parent_cancelled');

    // 先挂取消监听再调度：任何时刻取消父任务，都能覆盖到全部子任务
    signal.addEventListener('abort', onAbort, { once: true });
    if (remaining.size === 0) {
      finish({ kind: 'done' });
      return;
    }

    for (const child of active) {
      void host.startExisting(child).then((settled) => {
        remaining.delete(child.id);
        if (stopping) return;
        const haltReason = onSettled(settled);
        if (haltReason) stop({ kind: 'halted', reason: haltReason }, 'batch_halted');
        else if (remaining.size === 0) finish({ kind: 'done' });
      });
    }
  });
}

// ── 数据项来源 ────────────────────────────────────────────

/** 由系统列举数据项的来源：文件夹中匹配的文件，或清单文件的每一行 */
export interface BatchItemSource {
  dir?: string;
  /** 文件名通配符（* ?），多个用 ; 分隔，默认 * */
  pattern?: string;
  recursive?: boolean;
  file?: string;
}

/** 递归列举时最多扫描的条目数，防止误把整个磁盘当作文件夹 */
const MAX_SCANNED_ENTRIES = 20_000;

/**
 * 由系统列举数据项，而不是让 LLM 把清单手抄进 items
 * （手抄会被输出长度截断，也可能漏项、重复或写错路径，系统无从察觉）。
 * 参数有误时抛出面向 LLM 的错误信息。
 */
export function resolveItemSource(source: BatchItemSource): { items: string[]; description: string } {
  if (source.file) return readItemListFile(source.file);
  if (source.dir) return listDirectoryItems(source.dir, source.pattern, source.recursive);
  throw new Error('缺少 items_dir 或 items_file');
}

function listDirectoryItems(dir: string, pattern = '*', recursive = false): { items: string[]; description: string } {
  if (!isAbsolute(dir)) throw new Error(`items_dir 必须是绝对路径：${dir}`);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`文件夹不存在：${dir}`);

  const globs = pattern.split(/[;；]/).map((value) => value.trim()).filter(Boolean);
  const matchers = (globs.length > 0 ? globs : ['*']).map(globToRegExp);
  const matched: string[] = [];
  const unmatchedExtensions = new Map<string, number>();
  let scanned = 0;

  const walk = (current: string) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (++scanned > MAX_SCANNED_ENTRIES) {
        throw new Error(`${dir} 下的文件超过 ${MAX_SCANNED_ENTRIES} 个，请指定更具体的文件夹`);
      }
      // 跳过隐藏文件与 Office 打开文档时生成的 ~$ 临时锁文件
      if (entry.name.startsWith('.') || entry.name.startsWith('~$')) continue;
      const fullPath = join(current, entry.name);
      if (entry.isDirectory()) {
        if (recursive) walk(fullPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (matchers.some((matcher) => matcher.test(entry.name))) {
        matched.push(fullPath);
      } else {
        const extension = extname(entry.name).toLowerCase() || '(无扩展名)';
        unmatchedExtensions.set(extension, (unmatchedExtensions.get(extension) ?? 0) + 1);
      }
    }
  };
  walk(dir);

  const scope = `${dir}${recursive ? '（含子文件夹）' : ''}中匹配 ${globs.join('; ') || '*'} 的文件`;
  if (matched.length === 0) {
    const present = [...unmatchedExtensions].slice(0, 8).map(([extension, count]) => `${extension}×${count}`).join('、');
    throw new Error(`${scope}一个都没有。${present ? `该文件夹里现有：${present}` : '该文件夹是空的'}`);
  }
  if (matched.length > BATCH_MAX_ITEMS) {
    throw new Error(`${scope}共 ${matched.length} 个，超过单个批量任务上限 ${BATCH_MAX_ITEMS}。请缩小范围（更具体的 pattern 或子文件夹），分成多个批量任务`);
  }
  // 自然排序：学生2 排在 学生10 前面
  matched.sort((a, b) => a.localeCompare(b, 'zh-CN', { numeric: true }));
  return { items: matched, description: `${scope}，共 ${matched.length} 个` };
}

function readItemListFile(file: string): { items: string[]; description: string } {
  if (!isAbsolute(file)) throw new Error(`items_file 必须是绝对路径：${file}`);
  if (!existsSync(file) || !statSync(file).isFile()) throw new Error(`清单文件不存在：${file}`);
  const items = readFileSync(file, 'utf8')
    .replace(/^﻿/, '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (items.length === 0) throw new Error(`清单文件是空的：${file}`);
  if (items.length > BATCH_MAX_ITEMS) {
    throw new Error(`清单文件 ${file} 共 ${items.length} 行，超过单个批量任务上限 ${BATCH_MAX_ITEMS}，请拆分成多个清单`);
  }
  return { items, description: `清单文件 ${file} 的每一行，共 ${items.length} 项` };
}

const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

/** items 全部是绝对路径时，返回其中不存在的路径（LLM 手抄路径时常见的错字 / 臆造） */
export function findMissingPaths(items: string[]): string[] {
  if (items.length === 0 || !items.every((item) => ABSOLUTE_PATH.test(item))) return [];
  return items.filter((item) => !existsSync(item));
}

function globToRegExp(glob: string): RegExp {
  const source = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${source}$`, 'i');
}

// ── 建档 ──────────────────────────────────────────────────

/** 用函数作为替换值：item 中的 $&、$$、$' 等不会被当作替换模式解析 */
export function renderItemPrompt(template: string, item: string): string {
  return template.replace(/\{\{item\}\}/g, () => item);
}

/** 生成子任务行（默认全部 items；续跑时只传缺失的下标） */
export function buildBatchChildRows(
  parent: DBTask,
  meta: BatchMeta,
  indices: number[] = meta.items.map((_, index) => index),
): NewTask[] {
  const total = meta.items.length;
  return indices.map((index): NewTask => ({
    title: `${parent.title} [${index + 1}/${total}]`,
    prompt: renderItemPrompt(meta.promptTemplate, meta.items[index]),
    conversation_id: parent.conversation_id,
    type: 'background',
    status: 'pending',
    context: null,
    parent_task_id: parent.id,
    metadata: JSON.stringify({
      batchIndex: index,
      item: meta.items[index],
      toolsets: meta.toolsets,
      maxRounds: meta.maxRounds,
      maxAttempts: meta.maxAttempts,
      timeoutMs: meta.timeoutMs,
      resultSchema: meta.resultSchema,
    }),
  }));
}

/** 取出已有子任务并补齐缺失项（正常情况下 createBatch 已全部建档，这里是续跑兜底） */
function ensureBatchChildren(parent: DBTask, meta: BatchMeta): DBTask[] {
  const byIndex = new Map<number, DBTask>();
  for (const child of dbListTasks({ parentTaskId: parent.id })) {
    const index = batchIndexOf(child);
    if (index !== undefined && !byIndex.has(index)) byIndex.set(index, child);
  }
  const missing = meta.items.map((_, index) => index).filter((index) => !byIndex.has(index));
  if (missing.length > 0) {
    for (const child of dbCreateTasks(buildBatchChildRows(parent, meta, missing))) {
      byIndex.set(batchIndexOf(child)!, child);
    }
  }
  return meta.items.map((_, index) => byIndex.get(index)!);
}

/** 从父任务 metadata 解析并校验 BatchMeta */
export function parseBatchMeta(task: DBTask): BatchMeta {
  const raw = parseTaskMetadata(task.metadata);
  if (typeof raw.promptTemplate !== 'string' || !raw.promptTemplate.trim()) {
    throw new Error('batch metadata 缺少 promptTemplate');
  }
  if (!raw.promptTemplate.includes('{{item}}')) {
    throw new Error('batch promptTemplate 必须包含 {{item}} 占位符');
  }
  if (!Array.isArray(raw.items) || raw.items.length === 0) {
    throw new Error('batch metadata 缺少 items 或 items 为空');
  }
  if (raw.items.length > BATCH_MAX_ITEMS) {
    throw new Error(`batch items 共 ${raw.items.length} 项，超过上限 ${BATCH_MAX_ITEMS}`);
  }
  let resultSchema: ResultSchema | undefined;
  if (raw.resultSchema !== undefined) {
    const normalized = normalizeResultSchema(raw.resultSchema);
    if (normalized.errors) throw new Error(`result_schema 有误：${normalized.errors.join('；')}`);
    resultSchema = normalized.schema;
  }
  return {
    resultSchema,
    promptTemplate: raw.promptTemplate,
    items: raw.items.map((item) => String(item)),
    toolsets: Array.isArray(raw.toolsets) && raw.toolsets.length > 0
      ? raw.toolsets.map((name) => String(name))
      : [...BATCH_DEFAULT_TOOLSETS],
    maxRounds: positiveInt(raw.maxRounds) ?? BATCH_DEFAULT_MAX_ROUNDS,
    maxAttempts: positiveInt(raw.maxAttempts) ?? BATCH_DEFAULT_MAX_ATTEMPTS,
    timeoutMs: positiveInt(raw.timeoutMs) ?? BATCH_CHILD_TIMEOUT_MS,
  };
}

// ── 报告 ──────────────────────────────────────────────────

/** 父任务的紧凑汇总：统计 + 失败摘要（各项完整结果走分页，不放进这里） */
export function buildBatchSummary(parent: DBTask, children: DBTask[]): string {
  const sorted = sortByBatchIndex(children);
  const counts = countStatuses(sorted);
  const unfinished = counts.pending + counts.running;
  const lines = [
    `# 批量任务结果：${parent.title}`,
    `共 ${sorted.length} 项：✅ 成功 ${counts.completed} · ❌ 失败 ${counts.failed} · 🚫 未执行 ${counts.cancelled}`
      + (unfinished > 0 ? ` · ⏳ 未完成 ${unfinished}` : ''),
  ];
  const failed = sorted.filter((child) => child.status === 'failed');
  if (failed.length > 0) {
    lines.push('', '## 失败项');
    for (const child of failed.slice(0, SUMMARY_FAILURE_LINES)) {
      lines.push(`- ${itemLabel(child)}：${preview(child.error ?? '未知错误', 160)}`);
    }
    if (failed.length > SUMMARY_FAILURE_LINES) {
      lines.push(`- ……另有 ${failed.length - SUMMARY_FAILURE_LINES} 项失败`);
    }
  }
  return lines.join('\n');
}

const STATUS_TEXT: Record<string, string> = { completed: '成功', failed: '失败', cancelled: '未执行', pending: '等待中', running: '执行中' };

/** 写 CSV 结果表并返回统计行（追加到父任务汇总）；写文件失败不影响汇总 */
function writeResultReport(parent: DBTask, children: DBTask[], schema: ResultSchema): string[] {
  const rows: ResultRow[] = sortByBatchIndex(children).map((child) => {
    const meta = parseTaskMetadata(child.metadata);
    let value: Record<string, unknown> | undefined;
    if (child.status === 'completed' && child.result) {
      try {
        value = JSON.parse(child.result);
      } catch {
        value = undefined;
      }
    }
    return {
      index: (typeof meta.batchIndex === 'number' ? meta.batchIndex : 0) + 1,
      item: typeof meta.item === 'string' ? meta.item : child.title,
      status: STATUS_TEXT[child.status] ?? child.status,
      value,
      error: child.status === 'failed' ? child.error ?? undefined : undefined,
    };
  });

  const stats = summarizeResults(schema, rows.flatMap((row) => (row.value ? [row.value] : [])));
  const lines = ['', '## 结果统计', ...(stats.length > 0 ? stats : ['（没有可统计的数字、是否或可选值字段）'])];
  const fileName = `${parent.title.replace(/[\\/:*?"<>|\s]+/g, '_').slice(0, 40) || 'batch'}-${parent.id.slice(0, 8)}.csv`;
  const filePath = join(batchResultsDir, fileName);
  try {
    mkdirSync(batchResultsDir, { recursive: true });
    writeFileSync(filePath, resultsToCsv(schema, rows), 'utf8');
    lines.push(`完整结果表：${filePath}（每一项的字段值、状态与失败原因）`);
  } catch (error) {
    lines.push(`（结果表写入失败：${error instanceof Error ? error.message : String(error)}）`);
  }
  return lines;
}

/** 批量任务的子任务状态分布（供 async_task status 使用） */
export function formatBatchStatus(parent: DBTask): string {
  const children = sortByBatchIndex(dbListTasks({ parentTaskId: parent.id }));
  const counts = countStatuses(children);
  const retrying = children.filter(
    (child) => child.status === 'pending' && Number(parseTaskMetadata(child.metadata).attempt ?? 0) > 0,
  ).length;
  const lines = [
    `子任务（共 ${children.length}）：⏳ 排队 ${counts.pending - retrying} · 🔁 等待重试 ${retrying} · 🔄 执行中 ${counts.running}`
      + ` · ✅ ${counts.completed} · ❌ ${counts.failed} · 🚫 ${counts.cancelled}`,
  ];
  const failed = children.filter((child) => child.status === 'failed');
  if (failed.length > 0) {
    lines.push(`失败项：${failed.slice(0, 10).map(itemLabel).join('；')}${failed.length > 10 ? ` 等 ${failed.length} 项` : ''}`);
  }
  const parentActive = parent.status === 'pending' || parent.status === 'running';
  if (!parentActive && (counts.failed + counts.cancelled > 0 || parent.status !== 'completed')) {
    lines.push(`可调用 async_task({"action":"retry","task_id":"${parent.id}"}) 重跑失败/未执行的项（已成功的项保留）`);
  }
  return lines.join('\n');
}

/**
 * 分页读取批量任务各项结果。
 * 每页最多 limit 项且总字数不超过预算（至少返回 1 项），页脚给出下一页的 offset。
 */
export function formatBatchResultPage(
  parent: DBTask,
  options: { offset?: number; limit?: number } = {},
): string {
  const children = sortByBatchIndex(dbListTasks({ parentTaskId: parent.id }));
  const total = children.length;
  const counts = countStatuses(children);
  const header = [
    `# 批量任务「${parent.title}」结果（${STATUS_LABEL[parent.status] ?? parent.status}）`,
    `共 ${total} 项：✅ ${counts.completed} · ❌ ${counts.failed} · 🚫 ${counts.cancelled} · ⏳ ${counts.pending + counts.running}`,
  ];
  if (total === 0) return [...header, '尚未创建子任务'].join('\n');

  const offset = clampInt(options.offset, 0, total - 1, 0);
  const limit = clampInt(options.limit, 1, PAGE_MAX_LIMIT, PAGE_DEFAULT_LIMIT);
  const blocks: string[] = [];
  let used = 0;
  let next = offset;
  while (next < total && next < offset + limit) {
    const block = formatItemBlock(children[next]);
    if (blocks.length > 0 && used + block.length > PAGE_CHAR_BUDGET) break;
    blocks.push(block);
    used += block.length;
    next += 1;
  }

  const range = `第 ${offset + 1}–${next} 项 / 共 ${total} 项`;
  const footer = next < total
    ? `—— ${range}。下一页：async_task({"action":"result","task_id":"${parent.id}","offset":${next}}) ——`
    : `—— ${range}（已到末尾）——`;
  return [...header, '', ...blocks, footer].join('\n');
}

const STATUS_LABEL: Record<string, string> = {
  pending: '等待中',
  running: '执行中',
  completed: '已完成',
  failed: '失败',
  cancelled: '已取消',
};

function formatItemBlock(child: DBTask): string {
  const label = itemLabel(child);
  switch (child.status) {
    case 'completed':
      return `### ${label} ✅\n${truncate(child.result?.trim() || '（无结果文本）', PAGE_ITEM_RESULT_LIMIT)}\n`;
    case 'failed':
      return `### ${label} ❌ 失败\n${preview(child.error ?? '未知错误', 500)}\n`;
    case 'cancelled':
      return `### ${label} 🚫 已取消（未执行完）\n`;
    default:
      return `### ${label} ⏳ ${child.status === 'running' ? '执行中' : '等待中'}`
        + `${child.progress_text ? `（${child.progress_text}）` : ''}\n`;
  }
}

// ── 内部工具函数 ─────────────────────────────────────────

export function batchIndexOf(task: DBTask): number | undefined {
  const index = parseTaskMetadata(task.metadata).batchIndex;
  return typeof index === 'number' ? index : undefined;
}

function sortByBatchIndex(children: DBTask[]): DBTask[] {
  return [...children].sort((a, b) => (batchIndexOf(a) ?? 0) - (batchIndexOf(b) ?? 0));
}

function itemLabel(child: DBTask): string {
  const meta = parseTaskMetadata(child.metadata);
  const index = typeof meta.batchIndex === 'number' ? meta.batchIndex + 1 : '?';
  const item = typeof meta.item === 'string' ? meta.item : child.title;
  return `[${index}] ${preview(item, 80)}`;
}

function countStatuses(children: DBTask[]): Record<TaskStatus, number> {
  const counts: Record<TaskStatus, number> = { pending: 0, running: 0, completed: 0, failed: 0, cancelled: 0 };
  for (const child of children) counts[child.status] += 1;
  return counts;
}

function isTerminal(status: TaskStatus): status is TerminalStatus {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function positiveInt(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
  return Math.min(max, Math.max(min, n));
}

function preview(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…（截断，原文 ${text.length} 字）` : text;
}
