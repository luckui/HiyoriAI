/**
 * 本地 Python 服务（TTS / STT 等）的通用生命周期管理：
 *   - uv 创建独立 .venv 并安装 requirements.txt（清华 PyPI 镜像，Python 由 uv 自动下载）
 *   - 启动 server.py 子进程，按日志里的就绪标记判断启动成功
 *   - PID 文件追踪（应用重启后仍能找到并停止残留进程）、/health 健康检查
 *   - 应用退出时统一结束所有子进程
 *
 * 各服务只描述自己的差异（目录、端口、启动参数、额外安装步骤），见 ttsServerManager / sttServerManager。
 *
 * 路径策略：开发时在项目根目录下，打包后在 process.resourcesPath 下（extraResources 复制）。
 */

import { app } from 'electron';
import { join } from 'path';
import { type ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'fs';
import { ensureAppUv, PYPI_INDEX, PYTHON_INSTALL_MIRROR } from './uvRuntime';

export interface ServiceResult {
  ok: boolean;
  detail: string;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** 额外安装步骤可用的上下文 */
export interface InstallContext {
  uv: string;
  pythonExe: string;
  serverDir: string;
  log(msg: string): void;
  run(cmd: string, timeoutMs: number, extraEnv?: Record<string, string>): Promise<CommandResult>;
}

export interface PythonServiceSpec {
  /** 用于日志与提示，如 "TTS Server" */
  label: string;
  /** 服务目录名（包含 server.py 与 requirements.txt） */
  dir: string;
  port: number;
  startupTimeoutMs: number;
  /** 子进程输出中出现任一标记即视为启动成功 */
  readyMarkers: string[];
  /** 安装依赖时显示的说明 */
  requirementsLabel?: string;
  /** server.py 之后的命令行参数 */
  args?(): string[];
  /** 启动子进程时追加的环境变量 */
  env?(serverDir: string): Record<string, string>;
  /** requirements.txt 装完后的额外步骤；返回失败结果即中止安装 */
  afterRequirements?(ctx: InstallContext): Promise<ServiceResult | void>;
}

export interface PythonServiceStatus {
  installed: boolean;     // venv + 依赖已安装
  running: boolean;       // 进程存活
  healthy: boolean;       // /health 可达
  pid: number | null;
  port: number;
  serverDir: string;
}

const PYTHON_ENV = { PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' };
const liveProcesses = new Set<ChildProcess>();

app.on('before-quit', () => {
  for (const proc of liveProcesses) {
    if (!proc.killed) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
});

/** 通过系统 shell 执行命令，逐行回调输出（同时按 \r 分割，以正确显示 tqdm 进度条） */
export function runShellCommand(
  cmd: string,
  cwd: string,
  timeoutMs: number,
  onLine?: (line: string) => void,
  extraEnv?: Record<string, string>,
): Promise<CommandResult> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/s', '/c', `"${cmd}"`] : ['-c', cmd];
    const child = spawn(shell, shellArgs, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...PYTHON_ENV, ...extraEnv },
      windowsVerbatimArguments: true,
    });

    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      resolve({ code, stdout, stderr });
    };
    const emitLines = (text: string) => {
      if (!onLine) return;
      for (const line of text.split(/\r\n|\r|\n/)) {
        const trimmed = line.trim();
        if (trimmed) onLine(trimmed);
      }
    };

    child.stdout.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stdout += text;
      emitLines(text);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      stderr += text;
      emitLines(text);
    });
    child.on('error', () => finish(1)); // 如 ENOENT：命令本身无法启动
    child.on('close', (code) => finish(code ?? 1));

    if (timeoutMs > 0) {
      setTimeout(() => {
        if (done) return;
        try { child.kill(); } catch { /* ignore */ }
        finish(1);
      }, timeoutMs);
    }
  });
}

export class PythonService {
  private process: ChildProcess | null = null;

  constructor(private readonly spec: PythonServiceSpec) {}

  get port(): number {
    return this.spec.port;
  }

  get localUrl(): string {
    return `http://127.0.0.1:${this.spec.port}`;
  }

  get serverDir(): string {
    return app.isPackaged
      ? join(process.resourcesPath, this.spec.dir)
      : join(app.getAppPath(), this.spec.dir);
  }

  private get venvDir(): string {
    return join(this.serverDir, '.venv');
  }

  get pythonExe(): string {
    return process.platform === 'win32'
      ? join(this.venvDir, 'Scripts', 'python.exe')
      : join(this.venvDir, 'bin', 'python');
  }

  private get pidFile(): string {
    return join(this.serverDir, '.server.pid');
  }

  async getStatus(): Promise<PythonServiceStatus> {
    const pid = this.readPid();
    const running = pid !== null && isProcessAlive(pid);
    let healthy = false;
    if (running) {
      try {
        const resp = await fetch(`${this.localUrl}/health`, { signal: AbortSignal.timeout(3000) });
        healthy = resp.ok;
      } catch { /* 不可达 */ }
    }
    return {
      installed: existsSync(this.pythonExe),
      running,
      healthy,
      pid,
      port: this.spec.port,
      serverDir: this.serverDir,
    };
  }

  /** uv 创建 venv → 安装 requirements.txt → 服务自己的额外步骤 */
  async install(onProgress?: (msg: string) => void): Promise<ServiceResult> {
    const serverDir = this.serverDir;
    if (!existsSync(join(serverDir, 'server.py'))) {
      return { ok: false, detail: `${this.spec.dir} 目录不存在或缺少 server.py: ${serverDir}` };
    }
    const log = (msg: string) => onProgress?.(msg);
    const run = (cmd: string, timeoutMs: number, extraEnv?: Record<string, string>) =>
      runShellCommand(cmd, serverDir, timeoutMs, onProgress, extraEnv);

    let uv: string;
    try {
      uv = await ensureAppUv(onProgress);
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }

    // 1. 创建 venv（uv 自动检测/下载 Python）
    if (!existsSync(join(this.venvDir, process.platform === 'win32' ? 'Scripts' : 'bin'))) {
      log('创建 Python 虚拟环境（uv 自动管理 Python）…');
      const venv = await run(`"${uv}" venv .venv --python ">=3.10"`, 300_000, { UV_PYTHON_INSTALL_MIRROR: PYTHON_INSTALL_MIRROR });
      if (venv.code !== 0) return { ok: false, detail: `创建 venv 失败:\n${venv.stderr.slice(0, 1000)}` };
    } else {
      log('虚拟环境已存在，跳过创建');
    }

    const pythonExe = this.pythonExe;
    log(`Python: ${pythonExe}`);

    // 2. requirements.txt
    log(this.spec.requirementsLabel ?? '安装依赖…');
    const pip = await run(`"${uv}" pip install -r requirements.txt --python "${pythonExe}" --index-url ${PYPI_INDEX}`, 600_000);
    if (pip.code !== 0) return { ok: false, detail: `依赖安装失败:\n${pip.stderr.slice(0, 1000)}` };

    // 3. 服务特有的步骤（引擎包、模型权重等）
    const extra = await this.spec.afterRequirements?.({ uv, pythonExe, serverDir, log, run });
    if (extra && !extra.ok) return extra;

    log(`✅ ${this.spec.label} 环境安装完成`);
    return { ok: true, detail: '安装完成' };
  }

  async start(): Promise<ServiceResult> {
    const status = await this.getStatus();
    if (status.running && status.healthy) {
      return { ok: true, detail: `${this.spec.label} 已在运行 (PID ${status.pid})` };
    }
    if (!existsSync(this.pythonExe)) {
      return { ok: false, detail: '未安装，请先执行 install' };
    }

    // 终止残留的旧进程
    await this.stop();

    const serverDir = this.serverDir;
    return new Promise((resolve) => {
      const child = spawn(this.pythonExe, ['server.py', ...(this.spec.args?.() ?? [])], {
        cwd: serverDir,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: false,
        env: { ...process.env, ...PYTHON_ENV, ...this.spec.env?.(serverDir) },
      });
      this.process = child;
      liveProcesses.add(child);

      let settled = false;
      let output = '';
      const settle = (result: ServiceResult) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };

      const onData = (chunk: Buffer) => {
        const text = chunk.toString('utf-8');
        output += text;
        if (!settled && this.spec.readyMarkers.some((marker) => text.includes(marker))) {
          this.writePid(child.pid!);
          settle({ ok: true, detail: `${this.spec.label} 已启动 (PID ${child.pid})` });
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);

      child.on('error', (err) => settle({ ok: false, detail: `启动失败: ${err.message}` }));
      child.on('exit', (code) => {
        liveProcesses.delete(child);
        if (this.process === child) this.process = null;
        this.cleanPid();
        settle({ ok: false, detail: `进程退出 (code=${code})\n${output.slice(-500)}` });
      });

      setTimeout(() => {
        settle({ ok: false, detail: `启动超时（${this.spec.startupTimeoutMs / 1000}s）\n${output.slice(-500)}` });
      }, this.spec.startupTimeoutMs);
    });
  }

  async stop(): Promise<ServiceResult> {
    // 优先终止自己启动的子进程，再按 PID 文件清理上次运行残留的进程
    if (this.process && !this.process.killed) {
      try { this.process.kill('SIGTERM'); } catch { /* ignore */ }
    }
    this.process = null;

    const pid = this.readPid();
    if (pid !== null && isProcessAlive(pid)) {
      try { process.kill(pid, 'SIGTERM'); } catch { /* ignore */ }
    }
    this.cleanPid();

    // 等待端口释放
    await new Promise((r) => setTimeout(r, 500));
    return { ok: true, detail: '已停止' };
  }

  private readPid(): number | null {
    try {
      const pid = parseInt(readFileSync(this.pidFile, 'utf-8').trim(), 10);
      return Number.isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }

  private writePid(pid: number): void {
    try { writeFileSync(this.pidFile, String(pid), 'utf-8'); } catch { /* ignore */ }
  }

  private cleanPid(): void {
    try { unlinkSync(this.pidFile); } catch { /* ignore */ }
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
