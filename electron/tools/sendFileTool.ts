/**
 * 平台"发文件"工具的公共部分（discord_send_file / wechat_send_file / feishu_send_file）。
 *
 * 三个平台的流程一致，只有上传方式不同：
 *   提供了 file_path（绝对路径）
 *     ├→ 文件存在 → 直接发送
 *     └→ 文件不存在 → ⏸️ 告知用户文件不存在，请确认路径
 *   只提供了 file_name（文件名）
 *     ├→ 在常用目录（Desktop / Downloads / Documents / OneDrive桌面）搜索
 *     ├→ 找到唯一匹配 → 发送
 *     ├→ 找到多个匹配 → ⏸️ 列出候选路径，请用户确认
 *     └→ 未找到 → ⏸️ 提示用户提供完整路径
 *   screenshot=true → 截取当前屏幕，发送后删除临时文件
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { desktopCapturer, nativeImage } from 'electron';
import type { ToolDefinition, ToolPauseResult } from './types';

export interface SendFileParams {
  file_path?: string;
  file_name?: string;
  message?: string;
  screenshot?: boolean;
  [targetParam: string]: string | boolean | undefined;
}

export interface PlatformFileSender {
  /** 工具名，如 discord_send_file */
  name: string;
  /** 平台显示名，用于提示文字 */
  platform: string;
  /** 给模型看的工具说明（何时调用、目标 ID 从哪里取） */
  description: string;
  /** 目标 ID 参数，如 channel_id / user_id / chat_id */
  targetParam: string;
  targetDescription: string;
  /** 成功提示里怎么称呼目标，如「频道 123」 */
  describeTarget(target: string): string;
  isOnline(): boolean;
  /** 发送文件（及可选的文字说明），失败时抛出 */
  send(target: string, filePath: string, message: string | undefined): Promise<void>;
  /** 平台特有的失败说明（如 Discord 的大小限制）；返回 undefined 用通用提示 */
  describeError?(error: Error, filePath: string): string | undefined;
}

/** 搜索的常用目录（按优先级排序），按真实路径去重：OneDrive 同步可能让 Desktop 和 OneDrive\Desktop 指向同一位置 */
function searchDirs(): string[] {
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
      if (seen.has(realPath)) continue;
      seen.add(realPath);
      result.push(dir); // 保留原始路径（用户友好），用真实路径去重
    } catch { /* 目录不存在 */ }
  }
  return result;
}

/** 在目录中按文件名（忽略大小写）递归搜索，最多 2 层，避免太慢；符号链接指向同一文件时只保留一个 */
function findFiles(name: string, dirs: string[], maxDepth = 2): string[] {
  const results: string[] = [];
  const seen = new Set<string>();
  const nameLower = name.toLowerCase();

  function scan(dir: string, depth: number): void {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === nameLower) {
        let key = fullPath;
        try { key = fs.realpathSync(fullPath); } catch { /* 文件刚被删除 */ }
        if (seen.has(key)) continue;
        seen.add(key);
        results.push(fullPath);
      } else if (entry.isDirectory() && depth < maxDepth) {
        scan(fullPath, depth + 1);
      }
    }
  }

  for (const dir of dirs) scan(dir, 0);
  return results;
}

/** 截取主屏幕写入临时 PNG（超过 1280 宽等比缩小） */
async function captureScreenToTempFile(): Promise<string> {
  const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 1920, height: 1080 } });
  if (sources.length === 0) throw new Error('未找到可用屏幕源，请检查系统截图权限。');
  const primary = sources.find((s) => s.name === 'Entire Screen' || s.name === 'Screen 1') ?? sources[0];
  let img = primary.thumbnail;
  if (img.getSize().width > 1280) img = nativeImage.createFromBuffer(img.resize({ width: 1280 }).toPNG());
  const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
  fs.writeFileSync(tmpPath, img.toPNG());
  return tmpPath;
}

function pause(toolName: string, trace: string[], userMessage: string, resumeHint: string): ToolPauseResult {
  return { __pause: true, trace, userMessage, resumeHint: resumeHint.replace('{tool}', toolName) };
}

/** 把 file_path / file_name 解析成唯一的本地文件；需要用户确认时返回暂停结果 */
function resolveLocalFile(toolName: string, filePath?: string, fileName?: string): string | ToolPauseResult {
  if (filePath) {
    const normalized = path.normalize(filePath);
    if (fs.existsSync(normalized)) return normalized;
    return pause(
      toolName,
      [`搜索路径：${normalized}`, '结果：文件不存在'],
      `文件不存在：\`${normalized}\`\n请检查路径是否正确，或文件是否已被移动/删除。`,
      '请用户提供正确的文件路径，然后重新调用 {tool}(file_path="正确路径")',
    );
  }

  const dirs = searchDirs();
  const found = findFiles(fileName!, dirs);
  if (found.length === 1) return found[0];
  if (found.length === 0) {
    return pause(
      toolName,
      [`搜索文件名：${fileName}`, `搜索目录：${dirs.join(', ')}`, '结果：未找到'],
      `在常用目录（桌面、下载、文档）中未找到文件：\`${fileName}\`\n搜索范围：\n${dirs.map((d) => `  • ${d}`).join('\n')}`,
      '请用户提供文件的完整路径，然后重新调用 {tool}(file_path="完整路径")',
    );
  }
  return pause(
    toolName,
    [`搜索文件名：${fileName}`, `结果：找到 ${found.length} 个同名文件`],
    `找到多个同名文件 \`${fileName}\`：\n${found.map((p, i) => `  ${i + 1}. ${p}`).join('\n')}`,
    '请用户确认要发送哪一个，然后重新调用 {tool}(file_path="选定路径")',
  );
}

export function createSendFileTool(sender: PlatformFileSender): ToolDefinition<SendFileParams> {
  return {
    schema: {
      type: 'function',
      function: {
        name: sender.name,
        description: sender.description,
        parameters: {
          type: 'object',
          properties: {
            [sender.targetParam]: { type: 'string', description: sender.targetDescription },
            file_path: {
              type: 'string',
              description: '文件绝对路径（已知时优先填此项）。例：C:/Users/PC/Desktop/report.pdf',
            },
            file_name: {
              type: 'string',
              description: '仅文件名（不知路径时填此项，工具会自动搜索 Desktop/Downloads/Documents）。例：report.pdf',
            },
            message: { type: 'string', description: '随附件一起发送的文字说明（可选）' },
            screenshot: {
              type: 'boolean',
              description: '为 true 时截取当前屏幕并发送，无需 file_path/file_name。用于"发送桌面截图"场景。',
            },
          },
          required: [sender.targetParam],
        },
      },
    },

    async execute(params): Promise<string | ToolPauseResult> {
      const target = String(params[sender.targetParam] ?? '');
      const { file_path, file_name, screenshot } = params;
      const message = params.message?.trim() || undefined;

      if (!sender.isOnline()) return `❌ ${sender.platform} Bot 当前不在线，无法发送文件。`;
      if (!screenshot && !file_path && !file_name) return '❌ file_path、file_name 和 screenshot 至少需要提供一个。';

      let filePath: string;
      if (screenshot) {
        try {
          filePath = await captureScreenToTempFile();
        } catch (error) {
          return `❌ 截图失败：${(error as Error).message}`;
        }
      } else {
        const resolved = resolveLocalFile(sender.name, file_path, file_name);
        if (typeof resolved !== 'string') return resolved;
        filePath = resolved;
      }

      try {
        await sender.send(target, filePath, message);
      } catch (error) {
        const err = error instanceof Error ? error : new Error(String(error));
        return sender.describeError?.(err, filePath) ?? `❌ 发送失败：${err.message.slice(0, 300)}`;
      } finally {
        // 截图临时文件用完即删（发送失败也删）
        if (screenshot) {
          try { fs.unlinkSync(filePath); } catch { /* ignore */ }
        }
      }

      const what = screenshot ? '桌面截图' : `文件：${path.basename(filePath)}`;
      return `✅ 已向${sender.describeTarget(target)}发送${what}${message ? `（备注：${message}）` : ''}`;
    },
  };
}
