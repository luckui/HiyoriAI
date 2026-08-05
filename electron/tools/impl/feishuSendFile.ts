/**
 * Skill: feishu_send_file
 *
 * Search local files or capture a desktop screenshot, then send the file to
 * the Feishu/Lark chat that triggered the current conversation.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { desktopCapturer, nativeImage } from 'electron';
import type { ToolDefinition, ToolPauseResult } from '../types';
import { FeishuAdapter } from '../../bridges/adapters/feishu';

interface FeishuSendFileParams {
  chat_id: string;
  file_path?: string;
  file_name?: string;
  message?: string;
  screenshot?: boolean;
}

function getSearchDirs(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    home,
  ];

  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of candidates) {
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const realPath = fs.realpathSync(dir);
      if (!seen.has(realPath)) {
        seen.add(realPath);
        result.push(dir);
      }
    } catch {
      // Directory does not exist.
    }
  }
  return result;
}

function findFiles(name: string, dirs: string[], maxDepth = 2): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const nameLower = name.toLowerCase();

  function scan(dir: string, depth: number): void {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === nameLower) {
        try {
          const realPath = fs.realpathSync(fullPath);
          if (!seen.has(realPath)) {
            seen.add(realPath);
            results.push(fullPath);
          }
        } catch {
          if (!seen.has(fullPath)) {
            seen.add(fullPath);
            results.push(fullPath);
          }
        }
      } else if (entry.isDirectory() && depth < maxDepth) {
        scan(fullPath, depth + 1);
      }
    }
  }

  for (const dir of dirs) scan(dir, 0);
  return results;
}

const feishuSendFileTool: ToolDefinition<FeishuSendFileParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'feishu_send_file',
      description:
        '搜索本地文件并通过 Lark / Feishu Bot 发送给用户。\n' +
        '【何时调用】飞书会话中（消息含 [来源：Lark / Feishu | ...] 标签），用户要求发送文件或桌面截图时调用。\n' +
        '【参数选择】已知完整路径填 file_path；只知道文件名填 file_name；发送当前桌面截图填 screenshot=true。\n' +
        '【chat_id】从消息标签“聊天：”字段直接取，不要猜测。\n' +
        '【不要用的场景】无 Lark / Feishu 标签的桌面聊天不要调用此工具。',
      parameters: {
        type: 'object',
        properties: {
          chat_id: {
            type: 'string',
            description: '目标飞书 chat_id，从 [来源：Lark / Feishu | 聊天：xxx | 用户：xxx] 中取',
          },
          file_path: {
            type: 'string',
            description: '文件绝对路径（已知时优先填此项）。例：C:/Users/PC/Desktop/report.pdf',
          },
          file_name: {
            type: 'string',
            description: '仅文件名（不知路径时填此项，工具会自动搜索 Desktop/Downloads/Documents）。例：report.pdf',
          },
          message: {
            type: 'string',
            description: '随附件一起发送的文字说明（可选）',
          },
          screenshot: {
            type: 'boolean',
            description: '为 true 时截取当前屏幕并发送，无需 file_path/file_name。用于“发送桌面截图”场景。',
          },
        },
        required: ['chat_id'],
      },
    },
  },

  async execute({ chat_id, file_path, file_name, message, screenshot }): Promise<string | ToolPauseResult> {
    const adapter = FeishuAdapter.activeAdapter;
    if (!adapter) {
      return '❌ Feishu Bot 当前不在线，无法发送文件。';
    }

    let resolvedPath: string | null = null;
    let isTempFile = false;

    if (screenshot) {
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 },
        });
        if (sources.length === 0) return '❌ 未找到可用屏幕源，请检查系统截图权限。';
        const primary = sources.find(s => s.name === 'Entire Screen' || s.name === 'Screen 1') ?? sources[0];
        let img = primary.thumbnail;
        if (img.getSize().width > 1280) {
          img = nativeImage.createFromBuffer(img.resize({ width: 1280 }).toPNG());
        }
        const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
        fs.writeFileSync(tmpPath, img.toPNG());
        resolvedPath = tmpPath;
        isTempFile = true;
      } catch (error) {
        return `❌ 截图失败：${(error as Error).message}`;
      }
    } else if (file_path) {
      const normalized = path.normalize(file_path);
      if (!fs.existsSync(normalized)) {
        return {
          __pause: true as const,
          trace: [`搜索路径：${normalized}`, '结果：文件不存在'],
          userMessage: `文件不存在：\`${normalized}\`\n请检查路径是否正确，或文件是否已被移动/删除。`,
          resumeHint: '请用户提供正确的文件路径，然后重新调用 feishu_send_file(file_path="正确路径")',
        } satisfies ToolPauseResult;
      }
      resolvedPath = normalized;
    } else if (file_name) {
      const searchDirs = getSearchDirs();
      const found = findFiles(file_name, searchDirs);

      if (found.length === 0) {
        return {
          __pause: true as const,
          trace: [`搜索文件名：${file_name}`, `搜索目录：${searchDirs.join(', ')}`, '结果：未找到'],
          userMessage:
            `在常用目录（桌面、下载、文档）中未找到文件：\`${file_name}\`\n` +
            `搜索范围：\n${searchDirs.map(d => `  • ${d}`).join('\n')}`,
          resumeHint: '请用户提供文件的完整路径，然后重新调用 feishu_send_file(file_path="完整路径")',
        } satisfies ToolPauseResult;
      }

      if (found.length > 1) {
        return {
          __pause: true as const,
          trace: [`搜索文件名：${file_name}`, `结果：找到 ${found.length} 个同名文件`],
          userMessage:
            `找到多个同名文件 \`${file_name}\`：\n` +
            found.map((p, i) => `  ${i + 1}. ${p}`).join('\n'),
          resumeHint: '请用户确认要发送哪一个，然后重新调用 feishu_send_file(file_path="选定路径")',
        } satisfies ToolPauseResult;
      }

      resolvedPath = found[0];
    } else {
      return '❌ file_path、file_name 和 screenshot 至少需要提供一个。';
    }

    try {
      if (message?.trim()) {
        await adapter.sendText(chat_id, message.trim());
      }
      await adapter.sendFile(chat_id, resolvedPath);
    } catch (error) {
      const msg = (error as Error).message ?? String(error);
      return `❌ 发送失败：${msg.slice(0, 300)}`;
    } finally {
      if (isTempFile && resolvedPath) {
        try {
          fs.unlinkSync(resolvedPath);
        } catch {
          // Ignore temp cleanup failure.
        }
      }
    }

    if (screenshot) {
      return `✅ 已向飞书会话 ${chat_id} 发送桌面截图${message ? `（备注：${message}）` : ''}`;
    }
    return `✅ 已向飞书会话 ${chat_id} 发送文件：${path.basename(resolvedPath)}${message ? `（备注：${message}）` : ''}`;
  },
};

export default feishuSendFileTool;
