/**
 * Skill: discord_send_file
 *
 * 搜索本地文件并通过 Discord Bot 发送到用户所在频道。
 * 专为 Discord 会话中"把某文件发给我"场景设计，
 * 将"搜索→验证→发送"三步合并为一次确定性执行。
 *
 * ── 决策树 ─────────────────────────────────────────────────────
 *
 *   提供了 file_path（绝对路径）
 *     ├→ 文件存在 → 直接发送
 *     └→ 文件不存在 → ⏸️ 告知用户文件不存在，请确认路径
 *
 *   只提供了 file_name（文件名）
 *     ├→ 在常用目录（Desktop / Downloads / Documents / OneDrive桌面）搜索
 *     ├→ 找到唯一匹配 → 发送
 *     ├→ 找到多个匹配 → ⏸️ 列出候选路径，请用户确认
 *     └→ 未找到 → ⏸️ 提示用户提供完整路径
 *
 * ── 注意 ───────────────────────────────────────────────────────
 *   - 只应在含 [来源：Discord | ...] 标签的会话中调用
 *   - channel_id 从消息标签"频道："字段取
 *   - 附件大小超过 Discord 限制（8MB）时会报错
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { desktopCapturer, nativeImage } from 'electron';
import { AttachmentBuilder, TextChannel } from 'discord.js';
import type { ToolDefinition, ToolPauseResult } from '../types';
import { DiscordAdapter } from '../../bridges/adapters/discord';

interface DiscordSendFileParams {
  /** 目标 Discord 频道 ID（从消息标签"频道："字段取） */
  channel_id: string;
  /**
   * 文件的绝对路径（已知路径时填此项，优先于 file_name）。
   * 例：C:/Users/PC/Desktop/hello_world.py
   */
  file_path?: string;
  /**
   * 仅知道文件名时填此项（Skill 会自动搜索常用目录）。
   * 例：hello_world.py
   */
  file_name?: string;
  /** 随文件一起发送的文字说明（可选） */
  message?: string;
  /**
   * 截取当前屏幕并发送（无需 file_path / file_name）。
   * 用于"把我的桌面截图发给我"等场景。
   */
  screenshot?: boolean;
}

// 搜索的常用目录列表（按优先级排序）
function getSearchDirs(): string[] {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Desktop'),
    path.join(home, 'OneDrive', 'Desktop'),   // 微软账户的 OneDrive 桌面
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    home,
  ];

  // 🆕 去重：OneDrive 桌面同步可能让 Desktop 和 OneDrive\Desktop 指向同一物理位置
  const seen = new Set<string>();
  const result: string[] = [];
  for (const dir of candidates) {
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
      const realPath = fs.realpathSync(dir);  // 解析符号链接，获取真实路径
      if (!seen.has(realPath)) {
        seen.add(realPath);
        result.push(dir);  // 保留原始路径（用户友好），但用 realPath 去重
      }
    } catch { /* 目录不存在，跳过 */ }
  }
  return result;
}

// 在目录列表中递归搜索文件名（最多递归 2 层，避免太慢）
function findFiles(name: string, dirs: string[], maxDepth = 2): string[] {
  const results: string[] = [];
  const seen = new Set<string>();  // 🆕 去重：避免符号链接导致同一文件被多次找到
  const nameLower = name.toLowerCase();

  function scan(dir: string, depth: number) {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.toLowerCase() === nameLower) {
        // 🆕 使用真实路径去重（处理符号链接/硬链接）
        try {
          const realPath = fs.realpathSync(fullPath);
          if (!seen.has(realPath)) {
            seen.add(realPath);
            results.push(fullPath);  // 保留原始路径（用户友好）
          }
        } catch {
          // realpathSync 失败，直接添加（罕见情况：文件被删除）
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

/** 瞬态网络错误关键词（可重试） */
const TRANSIENT_NET_ERRORS = /aborted|socket disconnected|ECONNRESET|ECONNREFUSED|ETIMEDOUT|TLS|timeout|network/i;
const SEND_MAX_RETRIES = 3;
const SEND_RETRY_DELAY_MS = 1200;

/**
 * 对 Discord REST 调用进行重试，处理 undici/TLS 瞬态网络错误。
 * 非网络错误（如权限问题）直接抛出，不重试。
 */
async function retryNetworkOp<T>(fn: () => Promise<T>): Promise<T> {
  let lastErr: Error = new Error('unknown');
  for (let attempt = 0; attempt < SEND_MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (e) {
      lastErr = e as Error;
      const msg = lastErr.message ?? '';
      if (!TRANSIENT_NET_ERRORS.test(msg)) throw e;  // 非瞬态错误，不重试
      if (attempt < SEND_MAX_RETRIES - 1) {
        const delay = SEND_RETRY_DELAY_MS * (attempt + 1);
        console.warn(`[discord_send_file] 网络错误（第 ${attempt + 1}/${SEND_MAX_RETRIES} 次）: ${msg.slice(0, 120)}，${delay}ms 后重试...`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  throw lastErr;
}

const discordSendFileSkill: ToolDefinition<DiscordSendFileParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'discord_send_file',
      description:
        '搜索本地文件并通过 Discord Bot 发送给用户。\n' +
        '【何时调用】Discord 会话中（消息含 [来源：Discord | ...] 标签），\n' +
        '用户要求发送某个文件时（"把 XX 发给我"、"发送 XX 文件" 等）。\n' +
        '【参数选择】\n' +
        '  • 已知完整路径 → 填 file_path（直接发送，不搜索）\n' +
        '  • 只知道文件名 → 填 file_name（Skill 自动在 Desktop/Downloads/Documents 搜索）\n' +
        '【channel_id】从消息标签"频道："字段直接取，不要猜测。\n' +
        '【截图发送】用户要求发送桌面截图时，填 screenshot=true，无需 file_path/file_name。\n' +
        '【不要用的场景】无 Discord 标签的桌面聊天不要调用此 Skill。',
      parameters: {
        type: 'object',
        properties: {
          channel_id: {
            type: 'string',
            description: '目标 Discord 频道 ID，从消息标签 [来源：Discord | 频道：xxx | ...] 中取',
          },
          file_path: {
            type: 'string',
            description: '文件绝对路径（已知时优先填此项）。例：C:/Users/PC/Desktop/report.pdf',
          },
          file_name: {
            type: 'string',
            description: '仅文件名（不知路径时填此项，Skill 会自动搜索）。例：report.pdf',
          },
          message: {
            type: 'string',
            description: '随附件一起发送的文字说明（可选）',
          },
          screenshot: {
            type: 'boolean',
            description: '为 true 时截取当前屏幕并发送，无需 file_path/file_name。用于"发送桌面截图"场景。',
          },
        },
        required: ['channel_id'],
      },
    },
  },

  async execute({ channel_id, file_path, file_name, message, screenshot }): Promise<string | ToolPauseResult> {
    // ── 1. 守卫：Bot 必须在线 ────────────────────────────────────
    const client = DiscordAdapter.activeClient;
    if (!client) {
      return '❌ Discord Bot 当前不在线，无法发送文件。';
    }

    // ── 2. 确定最终文件路径 ──────────────────────────────────────
    let resolvedPath: string | null = null;
    let isTempFile = false;   // 截图临时文件标记，发送后自动删除

    if (screenshot) {
      // 截图模式：截屏 → 写临时 PNG → 发送后删除
      try {
        const sources = await desktopCapturer.getSources({
          types: ['screen'],
          thumbnailSize: { width: 1920, height: 1080 },
        });
        if (sources.length === 0) return '❌ 未找到可用屏幕源，请检查系统截图权限。';
        const primary =
          sources.find(s => s.name === 'Entire Screen' || s.name === 'Screen 1') ?? sources[0];
        let img = primary.thumbnail;
        if (img.getSize().width > 1280) {
          img = nativeImage.createFromBuffer(img.resize({ width: 1280 }).toPNG());
        }
        const tmpPath = path.join(os.tmpdir(), `screenshot_${Date.now()}.png`);
        fs.writeFileSync(tmpPath, img.toPNG());
        resolvedPath = tmpPath;
        isTempFile = true;
      } catch (e) {
        return `❌ 截图失败：${(e as Error).message}`;
      }
    } else if (file_path) {
      // 直接路径模式
      const normalized = path.normalize(file_path);
      if (!fs.existsSync(normalized)) {
        return {
          __pause: true as const,
          trace: [`搜索路径：${normalized}`, '结果：文件不存在'],
          userMessage: `文件不存在：\`${normalized}\`\n请检查路径是否正确，或文件是否已被移动/删除。`,
          resumeHint: '请用户提供正确的文件路径，然后重新调用 discord_send_file(file_path="正确路径")',
        } satisfies ToolPauseResult;
      }
      resolvedPath = normalized;
    } else if (file_name) {
      // 文件名搜索模式
      const searchDirs = getSearchDirs();
      const found = findFiles(file_name, searchDirs);

      if (found.length === 0) {
        return {
          __pause: true as const,
          trace: [`搜索文件名：${file_name}`, `搜索目录：${searchDirs.join(', ')}`, '结果：未找到'],
          userMessage:
            `在常用目录（桌面、下载、文档）中未找到文件：\`${file_name}\`\n` +
            `搜索范围：\n${searchDirs.map(d => `  • ${d}`).join('\n')}`,
          resumeHint: '请用户提供文件的完整路径，然后重新调用 discord_send_file(file_path="完整路径")',
        } satisfies ToolPauseResult;
      }

      if (found.length > 1) {
        return {
          __pause: true as const,
          trace: [`搜索文件名：${file_name}`, `结果：找到 ${found.length} 个同名文件`],
          userMessage:
            `找到多个同名文件 \`${file_name}\`：\n` +
            found.map((p, i) => `  ${i + 1}. ${p}`).join('\n'),
          resumeHint: '请用户确认要发送哪一个，然后重新调用 discord_send_file(file_path="选定路径")',
        } satisfies ToolPauseResult;
      }

      resolvedPath = found[0];
    } else {
      return '❌ file_path 和 file_name 至少需要提供一个。';
    }

    // ── 3. 获取频道 ──────────────────────────────────────────────
    let channel;
    try {
      channel = await retryNetworkOp(() => client.channels.fetch(channel_id));
    } catch (e) {
      return `❌ 无法获取频道 ${channel_id}：${(e as Error).message}`;
    }
    if (!channel || !('send' in channel)) {
      return `❌ 频道 ${channel_id} 不可发送消息。`;
    }

    // ── 4. 发送 ─────────────────────────────────────────────────
    try {
      await retryNetworkOp(() => {
        // 每次重试重新构建 AttachmentBuilder，避免内部流状态问题
        const attachment = new AttachmentBuilder(resolvedPath!, {
          name: path.basename(resolvedPath!),
        });
        return (channel as TextChannel).send({
          content: message?.trim() || undefined,
          files: [attachment],
        });
      });
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      // 常见：文件超过 8MB Discord 限制
      if (/too large|payload|size/i.test(msg)) {
        return `❌ 文件过大无法发送（Discord 免费服务器限制 8MB）：${path.basename(resolvedPath!)}`;
      }
      return `❌ 发送失败（已重试 ${SEND_MAX_RETRIES} 次）：${msg.slice(0, 300)}`;
    }

    // 截图临时文件用完即删
    if (isTempFile && resolvedPath) {
      try { fs.unlinkSync(resolvedPath); } catch { /* ignore */ }
    }

    if (screenshot) {
      return `✅ 已向频道 ${channel_id} 发送桌面截图${message ? `（备注：${message}）` : ''}`;
    }
    return `✅ 已向频道 ${channel_id} 发送文件：${path.basename(resolvedPath)}（来自 ${resolvedPath}）`;
  },
};

export default discordSendFileSkill;
