/**
 * 全局记忆的导出 / 导入：让用户能手工修正 AI 记错的内容。
 *
 * 格式是「每行一条」的 Markdown 列表，删掉整行就是删掉那条记忆。
 * 导入会完全覆盖，并且走和写入同一套校验（长度、分隔符、注入过滤）。
 */

import { dialog, app } from 'electron';
import { writeFileSync, readFileSync } from 'fs';
import { join } from 'path';
import type { StructuredGlobalMemory } from '../db';
import { MAX_ENTRIES_PER_BLOCK, MEMORY_BLOCK_LABEL, rejectEntry, type MemoryBlock } from './globalMemory';

function generateMemoryMarkdown(memory: StructuredGlobalMemory): string {
  const block = (name: MemoryBlock) => [
    `## ${MEMORY_BLOCK_LABEL[name]}`,
    '',
    ...(memory[name].length ? memory[name].map(entry => `- ${entry}`) : ['（空）']),
    '',
  ];
  return [
    '# 全局记忆',
    '',
    `> 导出时间：${new Date().toLocaleString('zh-CN')}`,
    `> 每行一条，以 "- " 开头；删掉整行即删除该条。每块最多 ${MAX_ENTRIES_PER_BLOCK} 条。`,
    '> 导入会完全覆盖当前记忆，建议先留一份备份。',
    '',
    ...block('user'),
    ...block('memory'),
  ].join('\n');
}

/** 兼容旧导出：没有列表项时按 § 切分 */
function parseEntries(section: string): string[] {
  const bullets = section.split('\n')
    .map(line => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter((line, index, lines) => line && line !== '（空）' && lines.indexOf(line) === index);
  const hasBullets = /^\s*[-*]\s+/m.test(section);
  return hasBullets ? bullets : section.split('§').map(s => s.trim()).filter(Boolean);
}

function parseMemoryMarkdown(markdown: string): StructuredGlobalMemory {
  const section = (keyword: string) =>
    markdown.match(new RegExp(`^##\\s*${keyword}[^\\n]*\\n([\\s\\S]*?)(?=^##\\s|$(?![\\s\\S]))`, 'im'))?.[1] ?? '';
  return { user: parseEntries(section('USER')), memory: parseEntries(section('MEMORY')) };
}

export async function exportMemoryToMarkdown(
  memory: StructuredGlobalMemory,
): Promise<{ success: boolean; path?: string; error?: string }> {
  try {
    const { filePath, canceled } = await dialog.showSaveDialog({
      title: '导出全局记忆',
      defaultPath: join(app.getPath('documents'), 'global_memory.md'),
      filters: [{ name: 'Markdown Files', extensions: ['md'] }],
    });
    if (canceled || !filePath) return { success: false, error: '用户取消导出' };
    writeFileSync(filePath, generateMemoryMarkdown(memory), 'utf-8');
    return { success: true, path: filePath };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}

export async function importMemoryFromMarkdown(): Promise<{
  success: boolean;
  content?: StructuredGlobalMemory;
  error?: string;
}> {
  try {
    const { filePaths, canceled } = await dialog.showOpenDialog({
      title: '导入全局记忆',
      filters: [{ name: 'Markdown Files', extensions: ['md'] }, { name: 'All Files', extensions: ['*'] }],
      properties: ['openFile'],
    });
    if (canceled || !filePaths?.length) return { success: false, error: '用户取消导入' };

    const content = parseMemoryMarkdown(readFileSync(filePaths[0], 'utf-8'));
    if (!content.user.length && !content.memory.length) {
      return { success: false, error: '文件里没有解析出记忆条目：每条请以 "- " 开头，放在 ## USER / ## MEMORY 标题下' };
    }
    for (const name of ['user', 'memory'] as const) {
      if (content[name].length > MAX_ENTRIES_PER_BLOCK) {
        return {
          success: false,
          error: `${MEMORY_BLOCK_LABEL[name]}有 ${content[name].length} 条，超过上限 ${MAX_ENTRIES_PER_BLOCK} 条，请先合并精简`,
        };
      }
      for (const entry of content[name]) {
        const reason = rejectEntry(entry);
        if (reason) return { success: false, error: `${MEMORY_BLOCK_LABEL[name]}中有条目被拒绝（${reason}）：${entry.slice(0, 60)}` };
      }
    }
    return { success: true, content };
  } catch (e) {
    return { success: false, error: (e as Error).message };
  }
}
