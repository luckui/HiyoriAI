/**
 * 原子工具：run_command
 *
 * 通过 child_process.exec 执行任意命令行命令，
 * 返回 stdout + stderr 合并输出（截取前 4000 字符）。
 *
 * 特性：
 *   - 跨平台：Windows 走 cmd.exe /c，macOS/Linux 走 /bin/sh -c
 *   - 超时保护（默认 30 秒）
 *   - 非零退出码不抛出异常，而是在结果中注明
 *   - 输出过长时截断，防止塞满 context
 *   - background 模式：异步启动长驻进程（开发服务器等），返回 session_id
 *     用 process 工具管理后台进程（poll/log/kill/send）
 */

import { exec } from 'child_process';
import { app } from 'electron';
import { join } from 'path';
import type { ToolDefinition } from '../types';
import { terminalManager } from '../terminalManager';

/**
 * 为子进程注入 Hiyori 应用路径环境变量，
 * 使 Agent 在任意 shell 命令中可通过 %HIYORI_UV_EXE% / %HIYORI_DATA_DIR% 访问。
 */
function buildEnv(userEnv?: Record<string, string>): Record<string, string> {
  const uvExe = app.isPackaged
    ? join(process.resourcesPath, 'tools', 'uv.exe')
    : join(app.getAppPath(), 'tools', 'uv.exe');
  const dataDir = app.getPath('userData');

  return {
    ...process.env as Record<string, string>,
    HIYORI_UV_EXE: uvExe,
    HIYORI_DATA_DIR: dataDir,
    ...userEnv,
  };
}

interface RunCommandParams {
  /** 要执行的命令（Shell 语法） */
  command: string;
  /** 超时毫秒，默认 30000 */
  timeoutMs?: number;
  /** 工作目录，默认继承当前进程 cwd */
  cwd?: string;
  /** 额外环境变量，会与当前 process.env 合并 */
  env?: Record<string, string>;
  /** 后台运行（长驻进程如 npm run dev），返回 session_id，用 process 工具管理 */
  background?: boolean;
}

const runCommandTool: ToolDefinition<RunCommandParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        '在系统 Shell 中执行命令。支持两种模式：\n' +
        '\n' +
        '【同步模式（默认）】阻塞执行，命令完成后返回结果。⚠️ 仅适合预期30秒内完成的命令。\n' +
        '  适用：python --version、npm run build（小项目）、系统查询等\n' +
        '  ⚠️ 不确定耗时的命令请用 background=true——超时后只能重试，非常浪费。\n' +
        '\n' +
        '【后台模式（background=true）】异步启动，立即返回 session_id，用 process 工具跟踪。\n' +
        '  适用（凡是耗时不确定的，都优先用这个）：\n' +
        '    • pip install / npm install（网速慢时可能几分钟）\n' +
        '    • python script.py（计算密集型、爬虫、训练等耗时不定）\n' +
        '    • wget / curl 大文件下载\n' +
        '    • npm run dev / python -m http.server 等长驻进程\n' +
        '  启动后【必须】用 process({ action:"poll", session_id }) 检查进度\n' +
        '\n' +
        '【⚠️ 工作目录】需要在特定目录执行时，必须用 cwd 参数指定绝对路径，\n' +
        '  不要用 cd 切换目录！cmd.exe 的 cd 不能跨盘符（如从 D: 切到 C:）。\n' +
        '  ❌ 错误：command="cd C:\\Users\\xxx && npm init"\n' +
        '  ✅ 正确：command="npm init -y", cwd="C:\\Users\\xxx"\n' +
        '【⚠️ 交互式命令】脚手架/初始化命令（npm create、npx create-xxx）必须传 env={"CI":"true"} 跳过交互！\n' +
        '【⚠️ 执行 Python 代码】直接 command="python script.py"，不需要额外工具。\n' +
        '  多行代码先用 write_file 写到临时文件，再用此工具执行。\n' +
        '【注意】避免执行破坏性命令（rm -rf、format 等），该工具不做安全检查。',
      parameters: {
        type: 'object',
        properties: {
          command: {
            type: 'string',
            description: '要执行的 Shell 命令，例如："python --version"、"npm run build"、"pip install pandas"',
          },
          timeoutMs: {
            type: 'number',
            description:
              '超时毫秒数，默认 30000（30 秒）。同步模式专用，后台模式忽略此参数。\n' +
              '⚠️ 不要靠增大超时解决"耗时不确定"的问题——改用 background=true 才是正解。\n' +
              '只有你明确知道命令会在 N 秒内完成时，才考虑调大此值（如 timeoutMs: 120000）。',
          },
          cwd: {
            type: 'string',
            description: '工作目录（绝对路径）。⚠️ 必须用此参数指定目录，不要在 command 中用 cd！',
          },
          env: {
            type: 'object',
            description: '额外环境变量（key-value 对象），会与系统环境变量合并。\n' +
              '⚠️ 脚手架/初始化命令必须传 {"CI": "true"} 跳过交互提示！',
          },
          background: {
            type: 'boolean',
            description: '后台模式：异步启动进程，返回 session_id。\n' +
              '⚠️ 开发服务器（npm run dev、python -m http.server）必须用 background=true！\n' +
              '启动后用 process 工具的 poll/log/kill/send 管理后台进程。',
          },
        },
        required: ['command'],
      },
    },
  },

  async execute({ command, timeoutMs = 30000, cwd, env, background }) {
    // ── 后台模式：异步启动，返回 session_id ──
    if (background) {
      try {
        const { id, output } = await terminalManager.startTerminal(
          command,
          cwd ?? process.cwd(),
          buildEnv(env),
          5000,  // 初始输出等待 5s
        );

        return [
          `✅ 后台进程已启动`,
          ``,
          `🆔 session_id: ${id}`,
          `📍 工作目录: ${cwd ?? process.cwd()}`,
          `⌨️  命令: ${command}`,
          ``,
          `📤 初始输出:`,
          output || '（暂无输出）',
          ``,
          `⚠️ 【重要】进程已在后台运行，你必须主动跟踪其状态！不跟踪 = 不知道成功还是失败。`,
          ``,
          `【必须执行的后续操作】`,
          `  1️⃣  稍等 3—10 秒（进程需要启动时间）`,
          `  2️⃣  process({ action: "poll", session_id: "${id}" })  ← 检查输出，确认进程是否正常`,
          `  3️⃣  根据输出内容判断结果：`,
          `       • 下载/安装：找 progress 百分比或 “Successfully installed”`,
          `       • 服务器：找地址行（如 “Local: http://localhost:5173”）`,
          `       • 如果进程还未完成，再等一会再次 poll`,
          ``,
          `📋 如果忘记了 session_id，用 process({ action: "list" }) 找回所有后台进程`,
          ``,
          `🔧 其他操作:`,
          `  • process({ action: "log", session_id: "${id}" })             — 完整输出日志`,
          `  • process({ action: "send", session_id: "${id}", data: "..." }) — 发送输入`,
          `  • process({ action: "kill", session_id: "${id}" })             — 终止进程`,
        ].join('\n');
      } catch (error: any) {
        return `❌ 后台启动失败: ${error.message}`;
      }
    }

    // ── 同步模式：检测长驻进程命令并拦截 ──
    const longRunningPatterns = [
      /npm\s+run\s+(dev|start|serve)/i,
      /python\s+-m\s+(http\.server|SimpleHTTPServer)/i,
      /node\s+.*server/i,
      /vite\s+(--)?(?!build)/i,
      /webpack-dev-server/i,
      /ng\s+serve/i,
    ];

    if (longRunningPatterns.some(p => p.test(command))) {
      return (
        '❌ 检测到长驻进程命令（开发服务器等），同步模式会超时！\n' +
        `命令：${command}\n\n` +
        '【正确做法】加 background=true 后台启动：\n' +
        `  run_command({ command: "${command.replace(/"/g, '\\"')}", cwd: "项目目录", background: true })\n\n` +
        '启动后用 process 工具管理：\n' +
        '  • process({ action: "poll", session_id }) — 检查状态\n' +
        '  • process({ action: "kill", session_id }) — 终止进程'
      );
    }

    // ── 同步模式：阻塞执行 ──
    return new Promise<string>((resolve) => {
      const isWin = process.platform === 'win32';
      const shell = isWin ? 'cmd.exe' : '/bin/sh';

      // Windows：chcp 65001 切换到 UTF-8，避免中文输出乱码
      const actualCommand = isWin ? `chcp 65001 > nul && ${command}` : command;

      // 合并环境变量（自动注入 HIYORI_UV_EXE / HIYORI_DATA_DIR）
      const mergedEnv = buildEnv(env);

      exec(
        actualCommand,
        {
          shell,
          timeout: timeoutMs,
          cwd: cwd ?? process.cwd(),
          env: mergedEnv,
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          windowsHide: true,
        },
        (err, stdout, stderr) => {
          const out = (stdout ?? '').trim();
          const errText = (stderr ?? '').trim();
          const combined = [out, errText].filter(Boolean).join('\n');

          if (err?.killed || err?.signal === 'SIGTERM') {
            resolve(
              `⏱️ 命令超时（>${timeoutMs}ms）：${command}\n\n` +
              `【你现在必须做的选择】\n` +
              `  A) 耗时不确定（下载/安装/计算密集型脚本）→ 改用后台模式：\n` +
              `     run_command({ command: "${command.replace(/"/g, '\\"')}", background: true${cwd ? `, cwd: "${cwd}"` : ''} })\n` +
              `     然后用 process({ action: "poll", session_id }) 跟踪进度\n` +
              `\n` +
              `  B) 确定命令会完成但需要更多时间 → 增大超时重试：\n` +
              `     run_command({ command: "${command.replace(/"/g, '\\"')}", timeoutMs: ${timeoutMs * 4}${cwd ? `, cwd: "${cwd}"` : ''} })\n` +
              `\n` +
              `⚠️ 不要向用户解释超时——选择 A 或 B 直接重试。`
            );
            return;
          }

          const exitCode = err?.code ?? 0;

          if (exitCode !== 0) {
            const output = `❌ 命令执行失败（退出码 ${exitCode}）\n命令：${command}\n输出：\n${combined || '（无输出）'}`.slice(0, 4000);
            resolve(output + '\n\n【操作指引】命令失败，请立即调用 read_manual 查阅正确写法后重试，不要向用户解释错误。');
            return;
          }

          const output = combined
            ? combined.slice(0, 4000)
            : '（退出码 0，命令正常完成，但没有产生任何输出。' +
              '对于 Get-ChildItem / dir / find 等查找命令，无输出即代表没有找到任何匹配项，结果是确定的"未找到"，不是不确定。）';

          // 乱码检测
          const garbageCount = (output.match(/\uFFFD/g) ?? []).length;
          const garbageHint = garbageCount >= 3
            ? '\n\n⚠️【编码警告】输出含乱码字符（可能是 GBK 命令输出未正确转 UTF-8）。' +
              '如需理解输出内容，请调用 read_manual(topic="命令行操作") 查阅无乱码的替代命令。'
            : '';

          resolve(`✅ ${output}${garbageHint}`);
        },
      );
    });
  },
};

export default runCommandTool;
