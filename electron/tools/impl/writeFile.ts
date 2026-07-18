/**
 * Tool: write_file
 *
 * 用 Node.js fs 模块写入文件，比 run_command 拼 echo/cat 更安全、更可靠。
 *
 * ── 决策树 ─────────────────────────────────────────────────────
 *
 *   文件不存在
 *     └→ 直接创建并写入（无需 mode）
 *
 *   文件已存在 + mode 已提供
 *     ├→ overwrite：覆盖全部内容
 *     └→ append：追加到末尾
 *
 *   文件已存在 + mode 未提供
 *     └→ ⏸️ ToolPauseResult：AI 向用户确认 overwrite / append，
 *        用户回答后 AI 带上 mode 重新调用本工具
 *
 * ── 注意 ───────────────────────────────────────────────────────
 *   - path 支持绝对路径和相对路径（相对于进程 cwd）
 *   - 父目录不存在时自动递归创建
 *   - content 是原始字符串，AI 不需要转义换行
 */

import * as fs from 'fs';
import * as path from 'path';
import type { ToolDefinition, ToolExecuteResult, ToolPauseResult } from '../types';

interface WriteFileParams {
  /** 目标文件路径（绝对路径或相对路径） */
  path: string;
  /** 要写入的文字内容 */
  content: string;
  /**
   * 写入模式：
   *   overwrite - 覆盖全部内容（文件已存在时）
   *   append    - 追加到末尾（文件已存在时）
   * 文件不存在时此参数可省略（自动创建）。
   * 文件已存在时若不传，工具会暂停并由 AI 询问用户。
   */
  mode?: 'overwrite' | 'append';
  /** 文件编码，默认 utf8 */
  encoding?: 'utf8' | 'utf-8' | 'ascii' | 'base64';
}

const writeFileSkill: ToolDefinition<WriteFileParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        '将文字内容写入本地文件，比 run_command 更安全（不需要转义、不受 Shell 行长度限制）。\n' +
        '决策树：\n' +
        '  • 文件不存在 → 自动创建（含父目录），直接写入\n' +
        '  • 文件已存在 + 传了 mode → 按 mode 执行（overwrite=覆盖 / append=追加）\n' +
        '  • 文件已存在 + 未传 mode → 工具暂停，AI 需询问用户选择\n' +
        '【提示】如果用户在对话中已经表明了意图（"覆盖写入"、"追加"、"替换"等），\n' +
        '请直接传对应 mode，无需再次询问。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              '目标文件路径，必须是绝对路径（如 C:/Users/xxx/Desktop/foo.txt）。\n' +
              '【重要】禁止猜测和使用相对路径（Desktop/foo.txt、./foo.txt 等均禁止），\n' +
              '相对路径会被写入程序内部目录而非用户期望的位置。\n' +
              '必须先用 run_command 查询真实路径再填写：\n' +
              '  桌面路径：run_command("echo %USERPROFILE%\\Desktop")\n' +
              '  文档路径：run_command("echo %USERPROFILE%\\Documents")',
          },
          content: {
            type: 'string',
            description: '要写入的文字内容，支持多行，无需对换行符转义。',
          },
          mode: {
            type: 'string',
            enum: ['overwrite', 'append'],
            description:
              '写入模式（文件存在时必须提供）：\n' +
              '  overwrite - 清空原内容后写入\n' +
              '  append    - 保留原内容，追加到末尾',
          },
          encoding: {
            type: 'string',
            enum: ['utf8', 'utf-8', 'ascii', 'base64'],
            description: '文件编码，默认 utf8。',
          },
        },
        required: ['path', 'content'],
      },
    },
  },


  async execute({ path: filePath, content, mode, encoding = 'utf8' }): Promise<ToolExecuteResult> {
    // 拒绝相对路径：相对路径会被 resolve 到程序内部 cwd，远非用户期望的位置
    if (!path.isAbsolute(filePath)) {
      return (
        `❌ 错误：path 必须是绝对路径，收到的是相对路径："${filePath}"。\n` +
        `请先用 run_command("echo %USERPROFILE%\\\\Desktop") 查询真实路径，再重新调用 write_file。`
      );
    }

    // 统一成 Windows 路径分隔符
    const absPath = filePath.replace(/\//g, '\\');

    const fileExists = fs.existsSync(absPath);

    // ── 文件已存在 + 未提供 mode ─────────────────────────────────
    if (fileExists && !mode) {
      let preview = '';
      try {
        const raw = fs.readFileSync(absPath, 'utf8');
        const lines = raw.split('\n');
        const previewLines = lines.slice(0, 5).join('\n');
        preview = lines.length > 5
          ? `${previewLines}\n... （共 ${lines.length} 行）`
          : previewLines;
      } catch {
        preview = '（无法读取文件内容）';
      }

      return {
        __pause: true as const,
        trace: [`检查文件：${absPath}`, `文件已存在，等待用户确认写入模式`],
        userMessage:
          `文件 \`${absPath}\` 已存在。\n\n` +
          `现有内容预览：\n\`\`\`\n${preview}\n\`\`\`\n\n` +
          `请问要【覆盖写入】（替换全部内容）还是【追加】（添加到末尾）？`,
        resumeHint:
          `用户确认后，请重新调用 write_file，传入相同的 path 和 content，` +
          `并根据用户选择设置 mode="overwrite" 或 mode="append"。`,
      } satisfies ToolPauseResult;
    }

    // ── 准备写入 ──────────────────────────────────────────────────
    const enc = (encoding ?? 'utf8') as BufferEncoding;

    // 父目录不存在时递归创建
    const dir = path.dirname(absPath);
    if (!fs.existsSync(dir)) {
      try {
        fs.mkdirSync(dir, { recursive: true });
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        return {
          __pause: true as const,
          trace: [`目标路径：${absPath}`, `创建父目录失败（${err.code}）：${err.message}`],
          userMessage:
            `无法创建目录 \`${dir}\`（${err.code}）：${err.message}\n\n` +
            `可能的原因：路径拼写错误、驱动器不存在或权限不足。\n` +
            `请提供正确的文件路径。`,
          resumeHint:
            `用户提供正确路径后，请重新调用 write_file，` +
            `使用修正后的 path，content 和 mode 保持不变。`,
        } satisfies ToolPauseResult;
      }
    }

    try {
      if (!fileExists) {
        fs.writeFileSync(absPath, content, { encoding: enc });
        const lineCount = content.split('\n').length;
        return `✅ 文件已创建：${absPath}（${lineCount} 行，${Buffer.byteLength(content, enc)} 字节）`;
      }

      if (mode === 'append') {
        const prevSize = fs.statSync(absPath).size;
        fs.appendFileSync(absPath, content, { encoding: enc });
        const newSize = fs.statSync(absPath).size;
        return (
          `✅ 已追加写入：${absPath}\n` +
          `  追加内容：${content.split('\n').length} 行 / ${Buffer.byteLength(content, enc)} 字节\n` +
          `  文件大小：${prevSize} → ${newSize} 字节`
        );
      }

      // mode === 'overwrite'
      const prevLines = fs.readFileSync(absPath, 'utf8').split('\n').length;
      fs.writeFileSync(absPath, content, { encoding: enc });
      const newLines = content.split('\n').length;
      return (
        `✅ 已覆盖写入：${absPath}\n` +
        `  原内容：${prevLines} 行 → 新内容：${newLines} 行 / ${Buffer.byteLength(content, enc)} 字节`
      );
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const detail =
        err.code === 'EACCES' || err.code === 'EPERM'
          ? `权限不足（${err.code}），文件可能被其他程序占用，或该位置不允许写入。`
          : err.code === 'EISDIR'
          ? `路径 \`${absPath}\` 指向的是一个目录，不能作为文件写入。`
          : err.code === 'ENOENT'
          ? `路径中某一级目录不存在（${err.message}）。`
          : err.message ?? String(e);
      return {
        __pause: true as const,
        trace: [`目标路径：${absPath}`, `写入失败（${err.code ?? 'unknown'}）：${err.message}`],
        userMessage:
          `写入文件 \`${absPath}\` 时失败：${detail}\n\n` +
          `请确认路径是否正确，或提供新的目标路径。`,
        resumeHint:
          `用户确认或提供新路径后，请重新调用 write_file，` +
          `使用修正后的 path，content 和 mode 保持不变。`,
      } satisfies ToolPauseResult;
    }
  },
};

export default writeFileSkill;
