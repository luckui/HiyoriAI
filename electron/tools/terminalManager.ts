/**
 * 终端管理器 - 跨平台持久化终端会话管理
 * 
 * 架构设计参考 GitHub Copilot 的 run_in_terminal：
 *   - UUID 标识会话（不依赖 PID）
 *   - 持久化会话（cwd/env 保持）
 *   - 异步输出监控（持续收集 stdout/stderr）
 *   - 交互式输入支持（send_to_terminal）
 * 
 * 跨平台支持：
 *   - Windows: cmd.exe（UTF-8 模式）
 *   - Linux/macOS: /bin/bash
 */

import { spawn, ChildProcessWithoutNullStreams } from 'child_process';
import { randomUUID } from 'crypto';

interface TerminalSession {
  id: string;
  process: ChildProcessWithoutNullStreams;
  cwd: string;
  command: string;
  env: Record<string, string>;
  outputBuffer: string;
  stderrBuffer: string;
  startTime: number;
  exitCode: number | null;
  isAlive: boolean;
}

class TerminalManager {
  private sessions: Map<string, TerminalSession> = new Map();

  /**
   * 启动新终端会话
   * @param command 要执行的命令
   * @param cwd 工作目录
   * @param env 环境变量（会与 process.env 合并）
   * @param timeout 初始检测超时（毫秒），检测到输出或超时后返回
   * @returns { id: UUID, output: 初始输出 }
   */
  async startTerminal(
    command: string,
    cwd: string,
    env?: Record<string, string>,
    timeout = 5000
  ): Promise<{ id: string; output: string }> {
    return new Promise((resolve, reject) => {
      const id = randomUUID();
      const isWin = process.platform === 'win32';
      
      // 跨平台 shell 选择
      const shell = isWin ? 'cmd.exe' : '/bin/bash';
      
      // Windows: 设置 UTF-8 编码，避免中文乱码
      const actualCommand = isWin 
        ? `chcp 65001 > nul && ${command}` 
        : command;
      
      const args = isWin ? ['/c', actualCommand] : ['-c', actualCommand];
      
      // 环境变量（调用方已通过 buildEnv 合并 process.env + Hiyori 变量）
      const mergedEnv = env ?? { ...process.env };

      // 启动进程
      try {
        const proc = spawn(shell, args, {
          cwd,
          env: mergedEnv,
          windowsHide: true,
          detached: false,
        });

        const session: TerminalSession = {
          id,
          process: proc,
          cwd,
          command,
          env: mergedEnv as Record<string, string>,
          outputBuffer: '',
          stderrBuffer: '',
          startTime: Date.now(),
          exitCode: null,
          isAlive: true,
        };

        this.sessions.set(id, session);

        // 监听 stdout
        proc.stdout.on('data', (data) => {
          session.outputBuffer += data.toString('utf8');
        });

        // 监听 stderr
        proc.stderr.on('data', (data) => {
          session.stderrBuffer += data.toString('utf8');
        });

        // 监听进程退出
        proc.on('exit', (code, signal) => {
          session.exitCode = code;
          session.isAlive = false;
        });

        // 监听错误
        proc.on('error', (err) => {
          session.isAlive = false;
          reject(new Error(`进程启动失败: ${err.message}`));
        });

        // 等待初始输出或超时
        let resolved = false;
        const timer = setTimeout(() => {
          if (!resolved) {
            resolved = true;
            const output = this.getCombinedOutput(session);
            resolve({ id, output });
          }
        }, timeout);

        // 有输出立即返回（不等到超时）
        const checkOutput = () => {
          if (!resolved && (session.outputBuffer || session.stderrBuffer)) {
            resolved = true;
            clearTimeout(timer);
            const output = this.getCombinedOutput(session);
            resolve({ id, output });
          }
        };

        proc.stdout.once('data', checkOutput);
        proc.stderr.once('data', checkOutput);

      } catch (err: any) {
        reject(new Error(`启动进程失败: ${err.message}`));
      }
    });
  }

  /**
   * 获取终端输出
   * @param id 终端会话 ID
   * @returns 累积的输出（stdout + stderr）
   */
  getOutput(id: string): string {
    const session = this.sessions.get(id);
    if (!session) {
      return `❌ 终端会话不存在: ${id}`;
    }

    const output = this.getCombinedOutput(session);
    const status = session.isAlive 
      ? '🟢 运行中' 
      : `⚫ 已退出（退出码 ${session.exitCode})`;

    return `${status}\n\n${output}`;
  }

  /**
   * 发送输入到终端
   * @param id 终端会话 ID
   * @param input 输入内容（会自动追加换行符）
   */
  sendInput(id: string, input: string): void {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`终端会话不存在: ${id}`);
    }

    if (!session.isAlive) {
      throw new Error(`终端已退出，无法发送输入`);
    }

    // 发送输入 + 换行
    session.process.stdin.write(`${input}\n`);
  }

  /**
   * 终止终端会话
   * @param id 终端会话 ID
   */
  async killTerminal(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) {
      throw new Error(`终端会话不存在: ${id}`);
    }

    if (session.isAlive) {
      session.process.kill('SIGTERM');
      
      // 等待进程退出（最多 3 秒）
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (session.isAlive) {
            session.process.kill('SIGKILL');  // 强制杀死
          }
          resolve();
        }, 3000);

        session.process.once('exit', () => {
          clearTimeout(timeout);
          resolve();
        });
      });
    }

    this.sessions.delete(id);
  }

  /**
   * 列出所有活跃终端
   */
  listTerminals(): Array<{ id: string; pid: number; command: string; isAlive: boolean; uptime: number }> {
    const result: Array<{ id: string; pid: number; command: string; isAlive: boolean; uptime: number }> = [];
    
    for (const [id, session] of this.sessions) {
      result.push({
        id,
        pid: session.process.pid ?? 0,
        command: session.command,
        isAlive: session.isAlive,
        uptime: Date.now() - session.startTime,
      });
    }

    return result;
  }

  /**
   * 清理所有已退出的终端会话
   */
  cleanup(): void {
    for (const [id, session] of this.sessions) {
      if (!session.isAlive) {
        this.sessions.delete(id);
      }
    }
  }

  /**
   * 获取合并的输出（stdout + stderr）
   */
  private getCombinedOutput(session: TerminalSession): string {
    // 注意：很多工具（git/pip/npm/curl）把进度信息写到 stderr，stdout 留给纯数据。
    // 不区分 stdout/stderr，直接合并展示，避免 AI 误判 stderr 内容为"出错"。
    const combined = [session.outputBuffer, session.stderrBuffer]
      .filter(Boolean)
      .join('\n');

    if (!combined.trim()) {
      return '（无输出）';
    }

    const parts = ['📤 输出:', combined];

    return parts.join('\n');
  }
}

// 全局单例
export const terminalManager = new TerminalManager();
