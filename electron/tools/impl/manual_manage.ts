/**
 * 工具：manual_manage
 *
 * 管理说明书（创建、编辑、查阅、列表）
 * 实验性功能：AI 在完成复杂任务后，可主动将工作流程保存为新说明书。
 *
 * Actions:
 *   create - 创建新说明书（后台异步生成，立即返回）
 *   edit   - 编辑现有说明书（后台异步更新，立即返回）
 *   read   - 读取说明书内容（复用 read_manual）
 *   list   - 列出所有说明书（复用 read_manual 无参）
 *
 * 设计原则：
 *   - create/edit 操作异步后台执行，不阻塞对话流程
 *   - LLM 总结会话历史 → 生成结构化 markdown → 保存到 electron/manual/
 *   - 调用前必须征得用户同意
 *   - 跳过简单一次性任务，聚焦可复用流程
 */

import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';
import type { ToolDefinition, ToolContext } from '../types';
import { taskManager } from '../../taskManager';

/**
 * 说明书目录路径（兼容开发模式和打包后）
 *
 * 开发时：app.getAppPath() 返回项目根目录
 * 打包后：process.resourcesPath 指向 resources/ 目录（需在 electron-builder 中配置 extraResources）
 */
const MANUAL_DIR = app.isPackaged
  ? path.join(process.resourcesPath, 'electron', 'manual')
  : path.join(app.getAppPath(), 'electron', 'manual');

const MAX_NAME_LENGTH = 64;
const VALID_NAME_RE = /^[\u4e00-\u9fa5a-zA-Z0-9][_\-\u4e00-\u9fa5a-zA-Z0-9\s]*$/;

/**
 * 验证说明书名称（允许中英文、数字、下划线、连字符、空格）
 */
function validateName(name: string): string | null {
  if (!name || name.trim().length === 0) {
    return '说明书名称不能为空';
  }
  const trimmed = name.trim();
  if (trimmed.length > MAX_NAME_LENGTH) {
    return `说明书名称过长（最大 ${MAX_NAME_LENGTH} 字符）`;
  }
  if (!VALID_NAME_RE.test(trimmed)) {
    return '说明书名称只能包含中英文、数字、下划线、连字符和空格，且必须以字母或数字开头';
  }
  return null;
}

/**
 * 检查说明书是否已存在（递归搜索子目录）
 */
function manualExists(name: string): boolean {
  if (!fs.existsSync(MANUAL_DIR)) return false;
  return findManualFile(name.trim()) !== null;
}

/**
 * 递归查找说明书文件，返回完整路径或 null
 */
function findManualFile(name: string): string | null {
  if (!fs.existsSync(MANUAL_DIR)) return null;
  const target = `${name}.md`;

  function search(dir: string): string | null {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        const found = search(fullPath);
        if (found) return found;
      } else if (entry.name === target) {
        return fullPath;
      }
    }
    return null;
  }

  return search(MANUAL_DIR);
}

/**
 * 列出所有说明书（递归搜索子目录）
 */
async function getManualGeneratorInstance() {
  const { getManualGenerator } = await import('../../manual/manualGenerator');
  return getManualGenerator();
}

function listManuals(): string[] {
  if (!fs.existsSync(MANUAL_DIR)) return [];
  const results: string[] = [];

  function scan(dir: string, prefix: string) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        scan(fullPath, prefix ? `${prefix}/${entry.name}` : entry.name);
      } else if (entry.name.endsWith('.md')) {
        const name = entry.name.replace(/\.md$/, '');
        results.push(prefix ? `${prefix}/${name}` : name);
      }
    }
  }

  scan(MANUAL_DIR, '');
  return results;
}

interface ManualManageParams {
  action: 'create' | 'edit' | 'read' | 'list' | 'patch';
  name?: string;
  title?: string;
  description?: string;
  category?: string;
  sync?: boolean;
  old_string?: string;
  new_string?: string;
}

const manualManageTool: ToolDefinition<ManualManageParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'manual_manage',
      description:
        '管理说明书（创建、编辑、查阅、列表）。说明书是你的程序性记忆——针对特定任务类型的可复用方法。\n' +
        '【何时创建】\n' +
        '  • 复杂任务成功完成（5+ 工具调用、多次迭代、克服错误）\n' +
        '  • 用户纠正过的方法有效后\n' +
        '  • 发现非平凡工作流程\n' +
        '  • 用户明确要求记录流程时\n' +
        '【何时编辑】\n' +
        '  • 使用说明书时发现步骤过时/错误\n' +
        '  • 遇到说明书未覆盖的陷阱\n' +
        '  • 发现更好的方法\n' +
        '【注意事项】\n' +
        '  • 创建/编辑前必须征得用户同意\n' +
        '  • 跳过简单一次性任务\n' +
        '  • create/edit 默认异步生成（不阻塞对话），设 sync=true 可同步等待结果\n' +
        '  • 优秀说明书应包含：触发条件、分步指令、命令示例、常见陷阱、验证步骤\n' +
        '【Actions】\n' +
        '  create - 创建新说明书（需要 name, title, description）\n' +
        '  edit   - LLM 重写整篇说明书（需要 name, title, description）\n' +
        '  patch  - 局部修正（find-replace，需要 name, old_string, new_string）\n' +
        '  read   - 读取说明书内容（需要 name）\n' +
        '  list   - 列出所有说明书（无需参数）',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['create', 'edit', 'read', 'list', 'patch'],
            description: '操作类型：create=创建, edit=编辑（LLM重写）, patch=局部修正（find-replace）, read=读取, list=列出所有',
          },
          name: {
            type: 'string',
            description:
              '说明书名称（中英文、数字、下划线、连字符、空格）。' +
              'create 时作为新文件名，edit/read 时定位现有文件。' +
              '示例："Git 冲突解决流程"、"Django Migration 修复"',
          },
          category: {
            type: 'string',
            description:
              '说明书分类目录（create 时使用）。' +
              '可选值：dev（开发）、ops（运维/命令行）、workflow（工作流）、browser（浏览器操作）。' +
              '不填则保存到根目录。',
          },
          title: {
            type: 'string',
            description:
              '说明书标题（简短描述，2-10 字）。' +
              '用于 create/edit 生成 markdown 前言。' +
              '示例："Git 冲突解决"、"Migration 修复"',
          },
          description: {
            type: 'string',
            description:
              '说明书描述（50-200 字）。' +
              '用于 create/edit 指导 LLM 生成内容。' +
              '应包含：任务背景、关键步骤、预期结果。' +
              '示例："当 git pull 遇到冲突时，如何查看冲突文件、手动解决、验证并提交"',
          },
          sync: {
            type: 'boolean',
            description:
              'create/edit 是否同步等待生成完成后再返回结果（默认 false=异步后台生成）。' +
              '当用户主动要求总结/创建说明书时建议设为 true，AI 可以立即查看生成结果。',
          },
          old_string: {
            type: 'string',
            description:
              'patch 操作专用：要替换的原文内容。支持精确匹配和空白归一化匹配。',
          },
          new_string: {
            type: 'string',
            description:
              'patch 操作专用：替换后的新内容。设为空字符串可删除匹配的文本。',
          },
        },
        required: ['action'],
      },
    },
  },

  execute({ action, name, title, description, category, sync, old_string, new_string }, context?: ToolContext): string | Promise<string> {
    // ── list：列出所有说明书 ──────────────────────────────────────
    if (action === 'list') {
      const manuals = listManuals();
      if (manuals.length === 0) {
        return (
          '📖 说明书目录为空。\n' +
          `知识库路径：${MANUAL_DIR}\n` +
          '使用 manual_manage(action="create", name="...", title="...", description="...") 创建新说明书。'
        );
      }
      return (
        `📖 可用说明书（共 ${manuals.length} 篇）：\n` +
        manuals.map(m => `  • ${m}`).join('\n') +
        '\n\n调用 manual_manage(action="read", name="...") 查阅具体内容。'
      );
    }

    // ── read：读取说明书内容 ──────────────────────────────────────
    if (action === 'read') {
      if (!name) {
        return '❌ read 操作需要 name 参数';
      }
      const filepath = findManualFile(name.trim());
      if (!filepath) {
        const manuals = listManuals();
        return (
          `❌ 未找到说明书"${name}"。\n\n` +
          `当前可用说明书：${manuals.join('、')}\n\n` +
          '请检查名称是否正确。'
        );
      }
      try {
        const content = fs.readFileSync(filepath, 'utf-8').trim();
        if (!content) return `⚠️ 说明书"${name}"内容为空。`;
        const MAX = 3000;
        const truncated =
          content.length > MAX
            ? content.slice(0, MAX) + `\n\n…（内容已截断，原文 ${content.length} 字）`
            : content;
        return `📖 【${name}】\n\n${truncated}`;
      } catch (e) {
        return `❌ 读取说明书失败：${(e as Error).message}`;
      }
    }

    // ── create：创建新说明书 ──────────────────────────────────────
    if (action === 'create') {
      if (!name || !title || !description) {
        return '❌ create 操作需要 name, title, description 参数';
      }
      const nameErr = validateName(name);
      if (nameErr) {
        return `❌ ${nameErr}`;
      }
      if (manualExists(name)) {
        return `❌ 说明书"${name}"已存在。使用 action="edit" 进行编辑。`;
      }

      // 拼接分类路径：category="browser" + name="搜索流程" → "browser/搜索流程"
      const fullName = category ? `${category.trim()}/${name.trim()}` : name.trim();

      const taskPayload = {
        name: fullName,
        title: title.trim(),
        description: description.trim(),
        conversationId: context?.conversationId,
      };

      // 同步模式：阻塞等待生成完成
      if (sync) {
        return (async () => {
          const generator = await getManualGeneratorInstance();
          const result = await generator.syncExecute({ type: 'create', ...taskPayload });
          if (!result.success) {
            return `❌ 说明书"${name}"生成失败：${result.error}`;
          }
          const preview = result.content && result.content.length > 800
            ? result.content.slice(0, 800) + `\n\n…（已截断，完整 ${result.content.length} 字）`
            : result.content;
          return (
            `✅ 说明书"${name}"已生成并保存。\n\n` +
            `📖 内容预览：\n${preview}`
          );
        })();
      }

      // 异步模式（默认）：通过 TaskManager 统一调度
      const task = taskManager.createAndStart({
        title: `说明书: ${name}`,
        prompt: description.trim(),
        conversationId: context?.conversationId,
        type: 'manual',
        metadata: { manualAction: 'create', name: fullName, title: title.trim(), description: description.trim() },
      });

      return (
        `✅ 说明书"${name}"创建请求已提交，正在后台生成中...\n` +
        `🆔 任务 ID: ${task.id}\n` +
        `📝 标题：${title}\n` +
        `📋 描述：${description}\n\n` +
        `生成完成后将自动保存到 ${MANUAL_DIR}/${fullName}.md\n` +
        `你可以用 async_task status 查询进度。`
      );
    }

    // ── edit：编辑现有说明书 ──────────────────────────────────────
    if (action === 'edit') {
      if (!name || !title || !description) {
        return '❌ edit 操作需要 name, title, description 参数';
      }
      if (!manualExists(name)) {
        return `❌ 说明书"${name}"不存在。使用 action="create" 创建新说明书。`;
      }

      const taskPayload = {
        name: name.trim(),
        title: title.trim(),
        description: description.trim(),
        conversationId: context?.conversationId,
      };

      // 同步模式：阻塞等待生成完成
      if (sync) {
        return (async () => {
          const generator = await getManualGeneratorInstance();
          const result = await generator.syncExecute({ type: 'edit', ...taskPayload });
          if (!result.success) {
            return `❌ 说明书"${name}"更新失败：${result.error}`;
          }
          const preview = result.content && result.content.length > 800
            ? result.content.slice(0, 800) + `\n\n…（已截断，完整 ${result.content.length} 字）`
            : result.content;
          return (
            `✅ 说明书"${name}"已更新完成。\n\n` +
            `📖 内容预览：\n${preview}`
          );
        })();
      }

      // 异步模式（默认）：通过 TaskManager 统一调度
      const task = taskManager.createAndStart({
        title: `说明书编辑: ${name}`,
        prompt: description.trim(),
        conversationId: context?.conversationId,
        type: 'manual',
        metadata: { manualAction: 'edit', name: name.trim(), title: title.trim(), description: description.trim() },
      });

      return (
        `✅ 说明书"${name}"编辑请求已提交，正在后台更新中...\n` +
        `🆔 任务 ID: ${task.id}\n` +
        `📝 新标题：${title}\n` +
        `📋 新描述：${description}\n\n` +
        `更新完成后将自动保存到 ${MANUAL_DIR}/${name}.md\n` +
        `你可以用 async_task status 查询进度。`
      );
    }

    // ── patch：局部修正（find-and-replace） ──────────────────────
    if (action === 'patch') {
      if (!name) {
        return '❌ patch 操作需要 name 参数';
      }
      if (!old_string) {
        return '❌ patch 操作需要 old_string 参数（要替换的原文内容）';
      }
      if (new_string === undefined || new_string === null) {
        return '❌ patch 操作需要 new_string 参数（替换后的新内容，设为空字符串可删除匹配文本）';
      }

      const filepath = findManualFile(name.trim());
      if (!filepath) {
        const manuals = listManuals();
        return (
          `❌ 未找到说明书"${name}"。\n\n` +
          `当前可用说明书：${manuals.join('、')}\n\n` +
          '请检查名称是否正确。'
        );
      }

      try {
        const content = fs.readFileSync(filepath, 'utf-8');

        // 两级匹配：① 精确匹配 ② 空白归一化匹配
        let matchCount = 0;
        let newContent: string;

        // ① 精确匹配
        const exactCount = content.split(old_string).length - 1;
        if (exactCount === 1) {
          newContent = content.replace(old_string, new_string);
          matchCount = 1;
        } else if (exactCount > 1) {
          return (
            `❌ old_string 在说明书"${name}"中匹配了 ${exactCount} 处，需要唯一匹配。\n` +
            '请提供更多上下文使匹配唯一。'
          );
        } else {
          // ② 空白归一化匹配：折叠连续空白为单空格后匹配
          const normalize = (s: string) => s.replace(/\s+/g, ' ').trim();
          const normalizedOld = normalize(old_string);
          const normalizedContent = normalize(content);

          const idx = normalizedContent.indexOf(normalizedOld);
          if (idx === -1) {
            // 提供文件前 500 字帮助 AI 定位
            const preview = content.slice(0, 500) + (content.length > 500 ? '...' : '');
            return (
              `❌ 未在说明书"${name}"中找到匹配内容。\n\n` +
              `📖 文件前 500 字预览：\n${preview}`
            );
          }

          // 检查唯一性
          const secondIdx = normalizedContent.indexOf(normalizedOld, idx + 1);
          if (secondIdx !== -1) {
            return (
              `❌ 空白归一化后匹配了多处，需要唯一匹配。\n` +
              '请提供更多上下文使匹配唯一。'
            );
          }

          // 反向定位原始内容中的对应区间
          // 用逐字符映射：normalized 字符位置 → 原始字符位置
          const origPositions: number[] = [];
          let inWhitespace = false;
          for (let i = 0; i < content.length; i++) {
            if (/\s/.test(content[i])) {
              if (!inWhitespace) {
                origPositions.push(i);
                inWhitespace = true;
              }
            } else {
              origPositions.push(i);
              inWhitespace = false;
            }
          }

          // 偏移映射：normalize 的 trim() 会去掉前导空白
          // 计算 replace(/\s+/g, ' ') 后、trim() 前的字符串，看 trim 掉了多少前导字符
          const preNormalized = content.replace(/\s+/g, ' ');
          const leadingTrimmed = preNormalized.length - preNormalized.trimStart().length;
          const origStart = origPositions[idx + leadingTrimmed] ?? 0;
          const origEnd = (origPositions[idx + normalizedOld.length + leadingTrimmed - 1] ?? content.length - 1) + 1;

          newContent = content.slice(0, origStart) + new_string + content.slice(origEnd);
          matchCount = 1;
        }

        fs.writeFileSync(filepath, newContent, 'utf-8');

        return (
          `✅ 已修正说明书"${name}"（${matchCount} 处替换）。\n` +
          `替换内容：\n  - 旧：${old_string.slice(0, 100)}${old_string.length > 100 ? '...' : ''}\n` +
          `  + 新：${new_string.slice(0, 100)}${new_string.length > 100 ? '...' : ''}`
        );
      } catch (e) {
        return `❌ patch 操作失败：${(e as Error).message}`;
      }
    }

    return `❌ 未知操作：${action}`;
  },
};

export default manualManageTool;
