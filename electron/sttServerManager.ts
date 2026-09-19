/**
 * STT Server 进程管理器（主进程）— faster-whisper WebSocket 服务
 *
 * 管理本地 STT 语音转文字服务的完整生命周期：
 *   - Python 虚拟环境创建（uv 管理）
 *   - faster-whisper + websockets 依赖安装
 *   - CUDA 自动检测与模型选择
 *   - WebSocket STT 服务进程启停
 *   - PID 追踪与健康检查
 *
 * 架构对标 ttsServerManager.ts，复用相同的环境管理策略。
 *
 * 路径策略：
 *   - 开发：项目根目录下 stt-server/
 *   - 打包：process.resourcesPath/stt-server/（extraResources 复制）
 */

import { app } from 'electron';
import { join } from 'path';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { ensureAppUv, PYPI_INDEX, PYTHON_INSTALL_MIRROR } from './uvRuntime';

// ── 配置 ────────────────────────────────────────────────────────────

const STT_PORT = 9890;
const STARTUP_TIMEOUT = 60_000;  // 60s（模型首次加载较慢）

export type STTModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';

export interface STTServerConfig {
  model: STTModelSize;
  language: string;
  device: 'auto' | 'cpu' | 'cuda';
}

const defaultConfig: STTServerConfig = {
  model: 'base',
  language: 'zh',
  device: 'auto',
};

let currentConfig: STTServerConfig = { ...defaultConfig };

// ── 路径 ────────────────────────────────────────────────────────────

function getSttServerDir(): string {
  return app.isPackaged
    ? join(process.resourcesPath, 'stt-server')
    : join(app.getAppPath(), 'stt-server');
}

function getVenvDir(): string {
  return join(getSttServerDir(), '.venv');
}

function getPythonExe(): string {
  const venv = getVenvDir();
  return process.platform === 'win32'
    ? join(venv, 'Scripts', 'python.exe')
    : join(venv, 'bin', 'python');
}

function getPidFile(): string {
  return join(getSttServerDir(), '.server.pid');
}

// ── 辅助：执行命令 ──────────────────────────────────────────────────

function runCmd(
  cmd: string,
  cwd?: string,
  timeoutMs = 120_000,
  onLine?: (line: string) => void,
  extraEnv?: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
    const shellArgs = process.platform === 'win32' ? ['/s', '/c', `"${cmd}"`] : ['-c', cmd];
    const child = spawn(shell, shellArgs, {
      cwd: cwd ?? getSttServerDir(),
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1', ...extraEnv },
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

    child.on('error', (err) => finish((err as any).code ?? 1));
    child.on('close', (code) => finish(code ?? 1));

    if (timeoutMs > 0) {
      setTimeout(() => {
        if (!done) {
          try { child.kill(); } catch { /* ignore */ }
          finish(1);
        }
      }, timeoutMs);
    }
  });
}

// ── 服务进程 ────────────────────────────────────────────────────────

let serverProcess: ChildProcess | null = null;

// ── 公开 API ────────────────────────────────────────────────────────

export interface SttServerStatus {
  installed: boolean;     // venv + deps 已安装
  running: boolean;       // 进程存活
  healthy: boolean;       // /health 可达
  pid: number | null;
  port: number;
  serverDir: string;
  model: STTModelSize;
  language: string;
}

/**
 * 获取服务当前状态
 */
export async function getStatus(): Promise<SttServerStatus> {
  const serverDir = getSttServerDir();
  const installed = existsSync(getPythonExe());
  const pid = readPid();
  const running = pid !== null && isProcessAlive(pid);
  let healthy = false;

  if (running) {
    try {
      const resp = await fetch(`http://127.0.0.1:${STT_PORT}/health`, { signal: AbortSignal.timeout(3000) });
      healthy = resp.ok;
    } catch { /* 不可达 */ }
  }

  return {
    installed,
    running,
    healthy,
    pid,
    port: STT_PORT,
    serverDir,
    model: currentConfig.model,
    language: currentConfig.language,
  };
}

/**
 * 安装：uv 创建 venv + 安装依赖
 */
export async function install(
  onProgress?: (msg: string) => void,
): Promise<{ ok: boolean; detail: string }> {
  const serverDir = getSttServerDir();
  if (!existsSync(join(serverDir, 'server.py'))) {
    return { ok: false, detail: `stt-server 目录不存在或缺少 server.py: ${serverDir}` };
  }

  const log = (m: string) => { onProgress?.(m); };

  let uv: string;
  try {
    uv = await ensureAppUv(onProgress);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // 1. 创建 venv
  const venvDir = getVenvDir();
  if (!existsSync(join(venvDir, process.platform === 'win32' ? 'Scripts' : 'bin'))) {
    log('创建 Python 虚拟环境（uv 自动管理 Python）…');
    const venvResult = await runCmd(
      `"${uv}" venv .venv --python ">=3.10"`,
      serverDir, 300_000, onProgress, { UV_PYTHON_INSTALL_MIRROR: PYTHON_INSTALL_MIRROR },
    );
    if (venvResult.code !== 0) {
      return { ok: false, detail: `创建 venv 失败:\n${venvResult.stderr.slice(0, 1000)}` };
    }
  } else {
    log('虚拟环境已存在，跳过创建');
  }

  const pythonExe = getPythonExe();
  log(`Python: ${pythonExe}`);

  // 2. pip install requirements.txt
  log('安装 STT 依赖（faster-whisper + websockets）…');
  const pipResult = await runCmd(
    `"${uv}" pip install -r requirements.txt --python "${pythonExe}" --index-url ${PYPI_INDEX}`,
    serverDir, 600_000, onProgress,
  );
  if (pipResult.code !== 0) {
    return { ok: false, detail: `依赖安装失败:\n${pipResult.stderr.slice(0, 1000)}` };
  }

  log('✅ STT 环境安装完成');
  return { ok: true, detail: '安装完成' };
}

/**
 * 启动 STT WebSocket Server 子进程
 */
export async function startServer(
  config?: Partial<STTServerConfig>,
): Promise<{ ok: boolean; detail: string }> {
  if (config) {
    currentConfig = { ...currentConfig, ...config };
  }

  // 如果已在运行
  const status = await getStatus();
  if (status.running && status.healthy) {
    return { ok: true, detail: `STT Server 已在运行 (PID ${status.pid})` };
  }

  const pythonExe = getPythonExe();
  if (!existsSync(pythonExe)) {
    return { ok: false, detail: '未安装，请先执行 install' };
  }

  const serverDir = getSttServerDir();

  // 终止旧进程
  await stopServer();

  return new Promise((resolve) => {
    const args = [
      'server.py',
      '--port', String(STT_PORT),
      '--model', currentConfig.model,
      '--device', currentConfig.device,
      '--language', currentConfig.language,
    ];

    const child = spawn(pythonExe, args, {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
      },
    });

    serverProcess = child;
    let started = false;
    let output = '';

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output += text;
      // server.py 启动成功打印 "Application startup complete"
      // websockets 16+ 自行打印 "server listening on ..."
      if (!started && (
        text.includes('Application startup complete') ||
        text.includes('running on') ||
        text.includes('server listening')
      )) {
        started = true;
        writePid(child.pid!);
        resolve({ ok: true, detail: `STT Server 已启动 (PID ${child.pid}, model=${currentConfig.model})` });
      }
    };

    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    child.on('error', (err) => {
      if (!started) {
        resolve({ ok: false, detail: `启动失败: ${err.message}` });
      }
    });

    child.on('exit', (code) => {
      serverProcess = null;
      cleanPid();
      if (!started) {
        resolve({ ok: false, detail: `进程退出 (code=${code})\n${output.slice(-500)}` });
      }
    });

    // 超时
    setTimeout(() => {
      if (!started) {
        resolve({ ok: false, detail: `启动超时（${STARTUP_TIMEOUT / 1000}s）\n${output.slice(-500)}` });
      }
    }, STARTUP_TIMEOUT);
  });
}

/**
 * 停止 STT Server
 */
export async function stopServer(): Promise<{ ok: boolean; detail: string }> {
  // 优先终止管理的子进程
  if (serverProcess && !serverProcess.killed) {
    try {
      serverProcess.kill('SIGTERM');
    } catch { /* ignore */ }
    serverProcess = null;
  }

  // 也尝试通过 PID 文件终止
  const pid = readPid();
  if (pid !== null && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* ignore */ }
  }
  cleanPid();

  // 等待端口释放
  await new Promise(r => setTimeout(r, 500));
  return { ok: true, detail: '已停止' };
}

/**
 * 安装 + 启动（一键）
 */
export async function installAndStart(
  onProgress?: (msg: string) => void,
  config?: Partial<STTServerConfig>,
): Promise<{ ok: boolean; detail: string }> {
  const installResult = await install(onProgress);
  if (!installResult.ok) return installResult;

  onProgress?.('启动 STT Server…');
  const startResult = await startServer(config);
  if (!startResult.ok) return startResult;

  onProgress?.('全部完成');
  return { ok: true, detail: `${startResult.detail}\nSTT 服务已就绪 (ws://127.0.0.1:${STT_PORT})` };
}

/**
 * 更新运行时配置
 */
export function updateConfig(config: Partial<STTServerConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

export function getConfig(): STTServerConfig {
  return { ...currentConfig };
}

export function getWebSocketUrl(): string {
  return `ws://127.0.0.1:${STT_PORT}`;
}

// ── PID 管理 ────────────────────────────────────────────────────────

function readPid(): number | null {
  try {
    const raw = readFileSync(getPidFile(), 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function writePid(pid: number): void {
  try { writeFileSync(getPidFile(), String(pid), 'utf-8'); } catch { /* ignore */ }
}

function cleanPid(): void {
  try { unlinkSync(getPidFile()); } catch { /* ignore */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

// ── 进程退出时清理 ──────────────────────────────────────────────────

app.on('before-quit', () => {
  if (serverProcess && !serverProcess.killed) {
    try { serverProcess.kill('SIGTERM'); } catch { /* ignore */ }
  }
});
