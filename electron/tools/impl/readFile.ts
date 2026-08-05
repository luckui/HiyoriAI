/**
 * 文件操作工具 - read_file
 * 
 * 读取文件内容，支持行范围读取、大文件分页。
 * 借鉴 Hermes Agent 的 read_file_tool 设计。
 * 
 * 特性：
 *   - 行范围读取（startLine, endLine）
 *   - 大文件保护（最大 10000 行警告）
 *   - 二进制文件检测
 *   - 行号显示
 */

import fs from 'fs/promises';
import path from 'path';
import { nativeImage } from 'electron';
import type { ToolDefinition, ToolImageResult } from '../types';

interface ReadFileParams {
  file_path: string;
  start_line?: number;
  end_line?: number;
}

/** 支持多模态直读的图片格式映射（mimeType 须在 ToolImageResult 允许范围内） */
const IMG_MIME_MAP: Record<string, ToolImageResult['mimeType']> = {
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png':  'image/png',
  '.webp': 'image/webp',
};

/**
 * 将文件名中各种 Unicode 空白统一为普通空格（U+0020），便于模糊比对。
 * 覆盖：NO-BREAK SPACE (U+00A0)、窄不换行空格 (U+202F)、细空格 (U+2009)、
 *        表意空格 (U+3000)、以及常规 \t / \r / \n。
 */
function normalizeWhitespace(s: string): string {
  return s.replace(/[\u00A0\u202F\u2009\u3000\t\r\n]/g, ' ');
}

/**
 * 当精确路径不存在时，扫描父目录寻找最近似的文件名：
 *   1. 先把所有 Unicode 空白统一为普通空格后精确匹配（解决 NBSP 问题）
 *   2. 再把路径中的 `?` 作为通配符（.）进行正则匹配（解决字符被替换问题）
 * 找到则返回正确的完整路径，否则返回 null。
 */
async function fuzzyResolvePath(resolvedPath: string): Promise<string | null> {
  const dir = path.dirname(resolvedPath);
  const basename = path.basename(resolvedPath);

  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return null; // 目录本身不存在
  }

  // ── 策略 1：Unicode 空白归一化后精确比对 ──
  const normTarget = normalizeWhitespace(basename);
  const exactMatch = entries.find(e => normalizeWhitespace(e) === normTarget);
  if (exactMatch) return path.join(dir, exactMatch);

  // ── 策略 2：? 作为任意单字符通配符（同时做空白归一化）──
  if (basename.includes('?')) {
    const regexStr = '^' +
      normalizeWhitespace(basename)
        .split('')
        .map(c => {
          if (c === '?') return '.'; // ? → 匹配任意一个字符
          // 转义正则特殊字符（. + * [ ] { } ( ) | \ ^ $）
          return /[.+*[\]{}()|\\^$]/.test(c) ? `\\${c}` : c;
        })
        .join('') +
      '$';
    try {
      const regex = new RegExp(regexStr, 'i');
      const fuzzyMatch = entries.find(e => regex.test(normalizeWhitespace(e)));
      if (fuzzyMatch) return path.join(dir, fuzzyMatch);
    } catch { /* 正则构造异常时忽略 */ }
  }

  return null;
}

async function execute(params: ReadFileParams): Promise<string | ToolImageResult> {
  const { file_path, start_line = 1, end_line } = params;

  try {
    // 解析路径
    let resolvedPath = path.isAbsolute(file_path)
      ? file_path
      : path.resolve(process.cwd(), file_path);

    // 检查文件是否存在；不存在时尝试模糊路径匹配
    let fileExists = false;
    try { await fs.access(resolvedPath); fileExists = true; } catch { /* 下面处理 */ }

    if (!fileExists) {
      const fuzzy = await fuzzyResolvePath(resolvedPath);
      if (fuzzy) {
        console.log(`[readFile] 模糊路径匹配: "${path.basename(resolvedPath)}" → "${path.basename(fuzzy)}"`);
        resolvedPath = fuzzy;
      } else {
        const hasQuestionMark = file_path.includes('?');
        return [
          `❌ 文件不存在: ${file_path}`,
          hasQuestionMark
            ? '💡 路径中含有 "?"，可能是文件名里的特殊字符（空格、间隔号等）被转义丢失。\n   建议用 list_directory 查看目录中的真实文件名后重试。'
            : '💡 建议用 list_directory 确认文件名（注意 Windows 路径区分特殊空白字符）。',
        ].join('\n');
      }
    }

    const ext = path.extname(resolvedPath).toLowerCase();

    // ── 图片：多模态直读（超过 API 像素上限时自动缩放）─────────
    /** API 允许的最大像素数（36MP），保留 10% 余量取 32.4MP */
    const MAX_PIXELS = 32_400_000;
    const imgMime = IMG_MIME_MAP[ext];
    if (imgMime) {
      const buf = await fs.readFile(resolvedPath);
      let img = nativeImage.createFromBuffer(buf);

      if (img.isEmpty()) {
        return `❌ 无法解析图片文件: ${file_path}（格式可能不受支持）`;
      }

      const { width, height } = img.getSize();
      let finalBuf: Buffer;
      let finalMime: ToolImageResult['mimeType'] = imgMime;

      if (width * height > MAX_PIXELS) {
        const scale = Math.sqrt(MAX_PIXELS / (width * height));
        const newWidth = Math.max(1, Math.floor(width * scale));
        const newHeight = Math.max(1, Math.floor(height * scale));
        img = img.resize({ width: newWidth });
        finalBuf = img.toJPEG(85);
        finalMime = 'image/jpeg';
        console.log(
          `[readFile] 图片像素过大 (${width}x${height}=${(width * height / 1e6).toFixed(1)}MP)，` +
          `已缩放至 ${newWidth}x${newHeight} 再发送`,
        );
      } else {
        finalBuf = buf;
      }

      return {
        text: `图片已读取：${file_path}`,
        imageBase64: finalBuf.toString('base64'),
        mimeType: finalMime,
      } satisfies ToolImageResult;
    }

    // ── gif / bmp：mimeType 不在多模态协议支持范围内 ───────────
    if (ext === '.gif' || ext === '.bmp') {
      return [
        `❌ ${ext} 格式图片暂不支持多模态直读（mimeType 不在协议范围内）`,
        '💡 建议先转换格式：',
        `   run_command({ command: "python -c \"from PIL import Image; Image.open(r'${file_path.replace(/\\/g, '\\\\')}').save(r'${file_path.replace(/\\/g, '\\\\').replace(/\.[^.]+$/, '.png')}')\"" })`,
        '   然后 read_file 重新读取 .png 文件',
      ].join('\n');
    }

    // ── 其余二进制文件 ────────────────────────────────────────
    const binaryExtensions = [
      '.exe', '.dll', '.so', '.dylib', '.bin', '.dat',
      '.mp4', '.avi', '.mov', '.mkv', '.mp3', '.wav',
      '.zip', '.tar', '.gz', '.rar', '.7z',
      '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    ];
    if (binaryExtensions.includes(ext)) {
      const docExtensions = ['.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx'];

      let hint: string;
      if (docExtensions.includes(ext)) {
        const escapedPath = file_path.replace(/\\/g, '\\\\');
        let pySnippet = '';
        if (ext === '.docx' || ext === '.doc') {
          pySnippet = `from docx import Document; print('\\n'.join(p.text for p in Document(r'${escapedPath}').paragraphs))`;
        } else if (ext === '.pdf') {
          pySnippet = `import pymupdf; doc=pymupdf.open(r'${escapedPath}'); [print(p.get_text()) for p in doc]`;
        } else if (ext === '.xlsx' || ext === '.xls') {
          pySnippet = `from openpyxl import load_workbook; wb=load_workbook(r'${escapedPath}',data_only=True); [print('\\t'.join(str(c) if c else '' for c in row)) for ws in wb for row in ws.iter_rows(values_only=True)]`;
        } else {
          pySnippet = `from pptx import Presentation; prs=Presentation(r'${escapedPath}'); [print(s.text) for sl in prs.slides for s in sl.shapes if s.has_text_frame]`;
        }
        hint = [
          `❌ 无法直接读取文档文件: ${file_path} (${ext})`,
          '',
          '💡 一步提取（直接复制执行，run_command 会返回 stdout）：',
          `   run_command({ command: "python -c \\"${pySnippet}\\"" })`,
          '',
          '   ⚠️ 脚本必须 print()！run_command 直接返回输出，无需写临时文件再读取。',
          '   ⚠️ 首次需安装依赖：run_command({ command: "pip install python-docx pymupdf openpyxl python-pptx" })',
          '   📖 更多格式可通过 read_skill("文档读取") 查阅（如存在对应技能）',
        ].join('\n');
      } else {
        hint = `❌ 无法读取二进制文件: ${file_path} (${ext})`;
      }
      return hint;
    }

    // 读取文件内容
    const content = await fs.readFile(resolvedPath, 'utf-8');
    const lines = content.split('\n');
    const totalLines = lines.length;

    // 验证行号范围
    if (start_line > totalLines) {
      return `❌ 起始行号 ${start_line} 超出文件范围（文件共 ${totalLines} 行）`;
    }

    const effectiveEndLine = end_line
      ? Math.min(end_line, totalLines)
      : totalLines;

    if (start_line > effectiveEndLine) {
      return `❌ 起始行号 ${start_line} 大于结束行号 ${effectiveEndLine}`;
    }

    // 提取指定行范围
    const selectedLines = lines.slice(start_line - 1, effectiveEndLine);
    
    // 添加行号
    const numberedLines = selectedLines.map((line, index) => {
      const lineNum = start_line + index;
      return `${lineNum.toString().padStart(4, ' ')} | ${line}`;
    });

    // 构建结果
    const result = [
      `📄 文件: ${file_path}`,
      `📊 总行数: ${totalLines} 行`,
      `📍 显示范围: 第 ${start_line} - ${effectiveEndLine} 行`,
      '',
      numberedLines.join('\n'),
    ];

    // 大文件警告
    if (effectiveEndLine - start_line + 1 > 1000) {
      result.push('');
      result.push('⚠️ 警告：读取了超过 1000 行，建议使用 start_line/end_line 参数分页读取。');
    }

    // 分页提示
    if (end_line && effectiveEndLine < totalLines) {
      result.push('');
      result.push(`💡 提示：还有更多内容，使用 start_line=${effectiveEndLine + 1} 继续读取。`);
    }

    return result.join('\n');

  } catch (error: any) {
    return `❌ 读取文件失败: ${error.message}`;
  }
}

const tool: ToolDefinition<ReadFileParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        '读取文件内容，支持文本文件（行范围读取）和图片文件（多模态直读）。' +
        '文本/代码文件返回带行号的内容；' +
        '图片文件（jpg/jpeg/png/webp）直接以多模态方式展示给 AI，无需 start_line/end_line。' +
        '当用户要求「看看这张图」「分析这个图片」「读取图片」时调用。',
      parameters: {
        type: 'object',
        properties: {
          file_path: {
            type: 'string',
            description: '要读取的文件路径（支持相对路径和绝对路径）',
          },
          start_line: {
            type: 'number',
            description: '起始行号（从 1 开始，默认为 1）',
          },
          end_line: {
            type: 'number',
            description: '结束行号（包含该行，默认读取到文件末尾）',
          },
        },
        required: ['file_path'],
      },
    },
  },
  execute,
};

export default tool;
