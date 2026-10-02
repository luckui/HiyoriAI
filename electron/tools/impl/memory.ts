/**
 * memory 工具 - AI 主动策展全局记忆。
 *
 * 与自动精炼的分工：
 * - 精炼子智能体（memory/globalRefiner）：压缩摘要后自动提取，兜底
 * - 本工具：用户当场说出重要信息时立刻写入，不用等下一次压缩
 *
 * 两边共用 memory/globalMemory 的容量、校验和编辑语义，保持一套规则。
 */

import type { ToolDefinition } from '../types';
import { getStructuredGlobalMemory, setStructuredGlobalMemory, searchMemoryFragments } from '../../db';
import {
  applyMemoryOps, renderGlobalMemory, rejectEntry,
  MAX_ENTRIES_PER_BLOCK, MAX_ENTRY_CHARS, MEMORY_BLOCK_LABEL,
  type MemoryBlock, type MemoryOp,
} from '../../memory/globalMemory';

interface MemoryParams {
  action: 'read' | 'search' | 'add' | 'update' | 'remove';
  /** 目标分块（add / update / remove 必填） */
  block?: MemoryBlock;
  /** 条目内容（add / update 必填） */
  entry?: string;
  /** 条目编号，取自 read 的输出（update / remove 必填） */
  index?: number;
  /** 搜索关键词（search 必填） */
  query?: string;
}

function write(block: MemoryBlock, op: MemoryOp): string {
  const current = getStructuredGlobalMemory();
  const { entries, dropped } = applyMemoryOps(current[block], [op]);
  if (dropped.length) return `❌ 未写入：${dropped[0]}`;
  setStructuredGlobalMemory({ ...current, [block]: entries });
  return `✅ ${MEMORY_BLOCK_LABEL[block]}已更新（${entries.length}/${MAX_ENTRIES_PER_BLOCK} 条）\n`
    + entries.map((e, i) => `${i + 1}. ${e}`).join('\n');
}

const memoryTool: ToolDefinition<MemoryParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'memory',
      description:
        '【全局记忆】跨对话保存的长期记忆，分两块：\n' +
        `  • user：用户身份、联系方式、偏好、习惯、反复强调的要求\n` +
        `  • memory：运行环境、工具特性与已知坑、项目约定\n` +
        '\n' +
        '【何时调用】\n' +
        '  • 用户告知个人信息或偏好（"我的 Discord 是 xxx"、"我更喜欢 TypeScript"）→ add\n' +
        '  • 用户纠正已有记忆 → update；记忆过时或被证伪 → remove\n' +
        '  • 用户问"我之前是怎么配置的""我上次说过什么" → search（会一并搜历史对话摘要）\n' +
        '\n' +
        '【不要记】本次任务进度、单次事件、临时状态 —— 这些由自动记忆系统处理。\n' +
        `【约束】每条 ≤ ${MAX_ENTRY_CHARS} 字；每块 ≤ ${MAX_ENTRIES_PER_BLOCK} 条，满了先 update 合并或 remove 过时条目。\n` +
        '【提示】记忆已在 system prompt 中，无需为了查看而 read。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['read', 'search', 'add', 'update', 'remove'],
            description: 'read=列出带编号的记忆，search=搜索记忆和历史摘要，add=新增条目，update=按编号替换，remove=按编号删除',
          },
          block: {
            type: 'string',
            enum: ['user', 'memory'],
            description: '【add/update/remove 必填】user=用户画像，memory=环境配置和工具经验',
          },
          entry: {
            type: 'string',
            description: '【add/update 必填】一条紧凑的事实陈述，如"Discord 账号 louis066505"、"项目用 npm，不用 yarn"',
          },
          index: {
            type: 'number',
            description: '【update/remove 必填】条目编号，取自 read 或 system prompt 中的记忆列表',
          },
          query: {
            type: 'string',
            description: '【search 必填】关键词，支持模糊匹配，多个词用空格分隔',
          },
        },
        required: ['action'],
      },
    },
  },

  async execute({ action, block, entry, index, query }) {
    if (action === 'read') {
      const rendered = renderGlobalMemory(getStructuredGlobalMemory());
      return rendered.trim()
        || '全局记忆为空。用户告知身份、偏好或环境事实时，用 memory(action="add") 保存。';
    }

    if (action === 'search') {
      if (!query?.trim()) return '❌ action=search 需要 query 参数';
      const keywords = query.trim().split(/[\s,，、]+/).filter(Boolean);
      const hit = (text: string) => keywords.some(k => text.toLowerCase().includes(k.toLowerCase()));
      const current = getStructuredGlobalMemory();
      const parts: string[] = [];
      for (const name of ['user', 'memory'] as const) {
        const matched = current[name].filter(hit);
        if (matched.length) parts.push(`【${MEMORY_BLOCK_LABEL[name]}】`, ...matched.map(e => `- ${e}`));
      }
      const fragments = searchMemoryFragments(query, 10);
      if (fragments.length) {
        parts.push('【历史对话摘要】');
        for (const fragment of fragments) {
          parts.push(`- [${new Date(fragment.created_at).toLocaleString('zh-CN')}] ${fragment.content}`);
        }
      }
      return parts.length
        ? parts.join('\n')
        : `未找到与"${query}"相关的记忆（关键词：${keywords.join('、')}）。换个说法或更短的关键词再试。`;
    }

    if (!block) return `❌ action=${action} 需要 block 参数（user 或 memory）`;

    if (action === 'add') {
      if (!entry?.trim()) return '❌ action=add 需要 entry 参数';
      const reason = rejectEntry(entry);
      if (reason) return `❌ 未写入：${reason}`;
      const existing = getStructuredGlobalMemory()[block];
      const trimmed = entry.trim();
      if (existing.some(e => e.includes(trimmed) || trimmed.includes(e))) {
        return `⚠️ ${MEMORY_BLOCK_LABEL[block]}已有相近条目，未重复添加。要改写请用 action="update"。`;
      }
      return write(block, { action: 'add', content: trimmed });
    }

    if (typeof index !== 'number') return `❌ action=${action} 需要 index 参数（条目编号）`;
    try {
      if (action === 'remove') return write(block, { action: 'remove', index });
      if (!entry?.trim()) return '❌ action=update 需要 entry 参数（替换后的完整条目）';
      return write(block, { action: 'update', index, content: entry });
    } catch (e) {
      return `❌ ${(e as Error).message}。先用 action="read" 查看当前编号。`;
    }
  },
};

export default memoryTool;
