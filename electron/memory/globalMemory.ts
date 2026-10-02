/**
 * 全局记忆的存储语义：容量、校验、编辑操作、渲染。
 *
 * 精炼子智能体（globalRefiner）和 memory 工具共用这里的规则，
 * 两边都只能通过 applyMemoryOps 改写记忆，不再各自维护一套上限和校验。
 */

export type MemoryBlock = 'user' | 'memory';

export const MEMORY_BLOCK_LABEL: Record<MemoryBlock, string> = {
  user: 'USER（用户画像）',
  memory: 'MEMORY（环境配置和工具经验）',
};

/** 每块条目上限。满了之后只能 update / remove，再 add 会被丢弃 */
export const MAX_ENTRIES_PER_BLOCK = 12;
/** 单条上限（字符数） */
export const MAX_ENTRY_CHARS = 200;

/** 编号是请求时快照里的 1-based 位置；add 不带编号 */
export type MemoryOp =
  | { action: 'add'; content: string }
  | { action: 'update'; index: number; content: string }
  | { action: 'remove'; index: number };

/** 记忆会被写进 system prompt，所以内容过滤比普通用户输入更严 */
const THREAT_PATTERNS: Array<{ pattern: RegExp; id: string }> = [
  { pattern: /ignore\s+(previous|all|above|prior)\s+instructions/i, id: 'prompt_injection' },
  { pattern: /disregard\s+(your|all|any)\s+(instructions|rules|guidelines)/i, id: 'disregard_rules' },
  { pattern: /you\s+are\s+now\s+/i, id: 'role_hijack' },
  { pattern: /system\s+prompt\s+override/i, id: 'sys_prompt_override' },
  { pattern: /do\s+not\s+tell\s+the\s+user/i, id: 'deception_hide' },
  { pattern: /(curl|wget)\s+[^\n]*\$\{?\w*(KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL|API)/i, id: 'exfil' },
  { pattern: /cat\s+[^\n]*(\.env|credentials|\.netrc|\.pgpass|\.npmrc|\.pypirc)/i, id: 'read_secrets' },
  { pattern: /authorized_keys|\$HOME\/\.ssh|~\/\.ssh/i, id: 'ssh_backdoor' },
];
/** 零宽字符和 BiDi 覆写字符常用于藏注入指令 */
const INVISIBLE_CHARS = /[​-‏‪-‮⁠﻿]/;

/** 返回拒绝原因，null 表示可以写入 */
export function rejectEntry(content: string): string | null {
  const trimmed = content.trim();
  if (!trimmed) return '条目为空';
  if (trimmed.length > MAX_ENTRY_CHARS) return `条目超过 ${MAX_ENTRY_CHARS} 字`;
  if (trimmed.includes('§')) return '条目不能包含分隔符 §';
  if (INVISIBLE_CHARS.test(trimmed)) return '条目包含不可见字符（可能是注入攻击）';
  const threat = THREAT_PATTERNS.find(({ pattern }) => pattern.test(trimmed));
  return threat ? `条目匹配威胁模式 ${threat.id}（记忆会进入 system prompt）` : null;
}

/**
 * 按快照编号批量改写一个分块。
 *
 * 协议错误（编号越界、重复编号）会抛出：说明调用方/模型没理解契约，整份输出都不可信。
 * 内容问题（为空、超长、命中威胁模式、超出容量）只丢弃该条：
 * 重试同样的片段不会有不同结果，整次失败只会让游标永远卡住。
 * 返回的 dropped 是被丢弃的操作及原因，调用方只记日志。
 */
export function applyMemoryOps(entries: string[], ops: MemoryOp[]): { entries: string[]; dropped: string[] } {
  const result = [...entries];
  const removals = new Set<number>();
  const addressed = new Set<number>();
  const dropped: string[] = [];

  for (const op of ops) {
    if (op.action !== 'add') {
      if (!Number.isInteger(op.index) || op.index < 1 || op.index > entries.length) {
        throw new Error(`记忆编号 ${op.index} 不在 1-${entries.length} 范围内`);
      }
      if (addressed.has(op.index)) throw new Error(`记忆编号 ${op.index} 被重复编辑`);
      addressed.add(op.index);
    }
    if (op.action === 'remove') {
      removals.add(op.index);
      continue;
    }
    const reason = rejectEntry(op.content);
    if (reason) {
      dropped.push(`${reason}：${op.content.slice(0, 40)}`);
      continue;
    }
    const content = op.content.trim();
    if (op.action === 'update') result[op.index - 1] = content;
    else result.push(content);
  }

  const kept = result.filter((_, i) => !removals.has(i + 1));
  const unique = [...new Set(kept)];
  // 容量只约束新增：不替模型淘汰它没提到的条目
  const limit = Math.max(MAX_ENTRIES_PER_BLOCK, entries.length - removals.size);
  if (unique.length > limit) {
    for (const entry of unique.slice(limit)) dropped.push(`分块已满（${limit} 条）：${entry.slice(0, 40)}`);
  }
  return { entries: unique.slice(0, limit), dropped };
}

function renderBlock(block: MemoryBlock, entries: string[]): string[] {
  const separator = '─'.repeat(46);
  return [
    separator,
    `${MEMORY_BLOCK_LABEL[block]}（${entries.length}/${MAX_ENTRIES_PER_BLOCK} 条）`,
    separator,
    ...entries.map((entry, i) => `${i + 1}. ${entry}`),
  ];
}

/**
 * 渲染成提示词片段。userOnly 供 chat / minecraft 模式使用：
 * 保留稳定的用户画像，省掉用不上的环境配置和工具经验。
 */
export function renderGlobalMemory(
  memory: { user: string[]; memory: string[] },
  options: { userOnly?: boolean } = {},
): string {
  const blocks: MemoryBlock[] = options.userOnly ? ['user'] : ['user', 'memory'];
  const parts = blocks
    .filter(block => memory[block].length > 0)
    .flatMap(block => ['', ...renderBlock(block, memory[block])]);
  return parts.length ? `\n${parts.join('\n')}` : '';
}
