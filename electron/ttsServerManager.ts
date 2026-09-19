/**
 * TTS Server 进程管理器（主进程）— 多引擎版
 *
 * 支持多个独立的 TTS 引擎，每个引擎拥有独立的：
 *   - 服务器目录（tts-server/ 或 tts-server-nano/）
 *   - Python 虚拟环境（.venv/）— 由 uv 创建管理
 *   - 进程（PID）与端口
 *
 * 环境管理策略：
 *   - uv（tools/uv.exe）管理 Python 解释器和 venv；缺失时自动从清华 PyPI 镜像下载（uvRuntime.ts）
 *   - 优先使用系统 Python，无 Python 时 uv 自动下载（npmmirror 镜像）
 *   - 每个引擎独立 .venv，完全隔离
 *   - pip 源使用清华镜像，模型权重使用 hf-mirror.com
 *
 * 路径策略：
 *   - 开发：项目根目录下 tts-server[-nano]/
 *   - 打包：process.resourcesPath/tts-server[-nano]/（extraResources 复制）
 */

import { app } from 'electron';
import { join } from 'path';
import { ChildProcess, spawn } from 'child_process';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'fs';
import { ensureAppUv, PYPI_INDEX, PYTHON_INSTALL_MIRROR } from './uvRuntime';

// ── 国内镜像 ────────────────────────────────────────────────────────

const HF_MIRROR  = 'https://hf-mirror.com';

// ── 引擎配置 ────────────────────────────────────────────────────────

interface EngineSpec {
  /** 服务器目录名 */
  dir: string;
  /** 监听端口 */
  port: number;
  /** 启动超时（ms） */
  startupTimeout: number;
  /** 安装提示文本 */
  installHint: string;
  /** 额外 pip 包（本地源码路径或 PyPI 包名） */
  extraPackages?: (serverDir: string) => string[];
  /** 安装完成后是否运行 download_models.py */
  hasModelDownload?: boolean;
}

const ENGINES: Record<string, EngineSpec> = {
  'edge-tts': {
    dir: 'tts-server',
    port: 9880,
    startupTimeout: 15_000,
    installHint: '一键部署免费的 edge-tts 本地服务',
  },
  'moss-tts-nano': {
    dir: 'tts-server-nano',
    port: 9881,
    startupTimeout: 180_000,
    installHint: '部署 MOSS-TTS-Nano 本地离线语音合成（约 2GB 磁盘）',
    extraPackages: (serverDir) => {
      // 优先从本地源码安装（开发模式 / 打包携带源码）
      const candidates = [
        join(serverDir, '..', '..', 'MOSS-TTS-Nano-main'),
        join(serverDir, '..', 'MOSS-TTS-Nano-main'),
      ];
      for (const c of candidates) {
        if (existsSync(join(c, 'pyproject.toml'))) {
          return [c];
        }
      }
      // 回退：从 PyPI 安装（通过清华镜像，无需访问 GitHub）
      return ['moss-tts-nano'];
    },
    hasModelDownload: true,
  },
  'genie-tts': {
    dir: 'tts-server-genie',
    port: 9882,
    startupTimeout: 60_000,
    installHint: '部署 Genie-TTS 本地语音合成（菲比，GPT-SoVITS ONNX，CPU 推理，约 1.5GB 磁盘）',
    extraPackages: (serverDir) => {
      // 优先从本地源码安装（开发模式 / 打包携带源码）
      const candidates = [
        join(serverDir, '..', '..', 'Genie-TTS-master'),
        join(serverDir, '..', 'Genie-TTS-master'),
      ];
      for (const c of candidates) {
        if (existsSync(join(c, 'pyproject.toml'))) {
          return [c];
        }
      }
      // 回退：从 PyPI 安装。锁定版本：server.py 按 2.0.x 的接口编写，新版本可能再次改接口
      return ['genie-tts==2.0.2'];
    },
    hasModelDownload: true,
  },
};

function resolveEngine(engine?: string): EngineSpec {
  const key = engine || 'edge-tts';
  const spec = ENGINES[key];
  if (!spec) throw new Error(`Unknown TTS engine: ${key}`);
  return spec;
}

// ── 路径 ────────────────────────────────────────────────────────────

function getTtsServerDir(engine?: string): string {
  const spec = resolveEngine(engine);
  return app.isPackaged
    ? join(process.resourcesPath, spec.dir)
    : join(app.getAppPath(), spec.dir);
}

function getVenvDir(engine?: string): string {
  return join(getTtsServerDir(engine), '.venv');
}

function getPythonExe(engine?: string): string {
  const venv = getVenvDir(engine);
  return process.platform === 'win32'
    ? join(venv, 'Scripts', 'python.exe')
    : join(venv, 'bin', 'python');
}

function getPidFile(engine?: string): string {
  return join(getTtsServerDir(engine), '.server.pid');
}

// ── 辅助 ────────────────────────────────────────────────────────────

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
      cwd: cwd ?? getTtsServerDir(),
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
      // 同时按 \r 和 \n 分割，以正确显示 tqdm 进度条
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

// ── 服务进程（按引擎隔离） ──────────────────────────────────────────

const serverProcesses = new Map<string, ChildProcess>();

// ── 公开 API ────────────────────────────────────────────────────────

export interface TtsServerStatus {
  installed: boolean;     // venv + deps 已安装
  running: boolean;       // 进程存活
  healthy: boolean;       // HTTP /health 可达
  pid: number | null;
  port: number;
  serverDir: string;
  engine: string;
}

/**
 * 获取服务当前状态
 */
export async function getStatus(engine?: string): Promise<TtsServerStatus> {
  const spec = resolveEngine(engine);
  const serverDir = getTtsServerDir(engine);
  const installed = existsSync(getPythonExe(engine));
  const pid = readPid(engine);
  const running = pid !== null && isProcessAlive(pid);
  let healthy = false;

  const localUrl = `http://127.0.0.1:${spec.port}`;
  if (running) {
    try {
      const resp = await fetch(`${localUrl}/health`, { signal: AbortSignal.timeout(3000) });
      healthy = resp.ok;
    } catch { /* 不可达 */ }
  }

  return { installed, running, healthy, pid, port: spec.port, serverDir, engine: engine || 'edge-tts' };
}

/**
 * 安装：uv 创建 venv + 安装依赖 + 下载模型权重
 */
export async function install(onProgress?: (msg: string) => void, engine?: string): Promise<{ ok: boolean; detail: string }> {
  const spec = resolveEngine(engine);
  const serverDir = getTtsServerDir(engine);
  if (!existsSync(join(serverDir, 'server.py'))) {
    return { ok: false, detail: `tts-server 目录不存在或缺少 server.py: ${serverDir}` };
  }

  const log = (m: string) => { onProgress?.(m); };

  let uv: string;
  try {
    uv = await ensureAppUv(onProgress);
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }

  // 1. 创建 venv（uv 自动检测/下载 Python）
  const venvDir = getVenvDir(engine);
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

  const pythonExe = getPythonExe(engine);
  log(`Python: ${pythonExe}`);

  // 2. pip install requirements.txt
  log('安装依赖…');
  const pipResult = await runCmd(
    `"${uv}" pip install -r requirements.txt --python "${pythonExe}" --index-url ${PYPI_INDEX}`,
    serverDir, 600_000, onProgress,
  );
  if (pipResult.code !== 0) {
    return { ok: false, detail: `依赖安装失败:\n${pipResult.stderr.slice(0, 1000)}` };
  }

  // 3. 引擎特定的额外包（如 moss-tts-nano）
  if (spec.extraPackages) {
    const packages = spec.extraPackages(serverDir);
    for (const pkg of packages) {
      const label = pkg.includes('/') || pkg.includes('\\') ? '引擎核心包（本地源码）' : `引擎核心包（${pkg}）`;
      log(`安装${label}…`);
      const extraResult = await runCmd(
        `"${uv}" pip install "${pkg}" --python "${pythonExe}" --index-url ${PYPI_INDEX}`,
        serverDir, 1_200_000, onProgress, // 20 分钟（torch 较大）
      );
      if (extraResult.code !== 0) {
        return { ok: false, detail: `引擎包安装失败:\n${extraResult.stderr.slice(0, 1000)}` };
      }
    }
  }

  // 4. 下载模型权重（hasModelDownload 引擎，使用 hf-mirror.com）
  if (spec.hasModelDownload && existsSync(join(serverDir, 'download_models.py'))) {
    log('下载模型权重（使用 hf-mirror.com 国内镜像）…');
    const dlResult = await runCmd(
      `"${pythonExe}" download_models.py`,
      serverDir, 3_600_000, onProgress, // 60 分钟（genie-tts ~1.5GB）
      { HF_ENDPOINT: HF_MIRROR },
    );
    if (dlResult.code !== 0) {
      return { ok: false, detail: `模型权重下载失败:\n${dlResult.stderr.slice(0, 1000)}` };
    }
  }

  log('✅ 安装完成');
  return { ok: true, detail: '安装完成' };
}

/**
 * 启动 TTS Server 子进程
 */
export async function startServer(engine?: string): Promise<{ ok: boolean; detail: string }> {
  const spec = resolveEngine(engine);
  const engineKey = engine || 'edge-tts';

  // 如果已在运行
  const status = await getStatus(engine);
  if (status.running && status.healthy) {
    return { ok: true, detail: `TTS Server 已在运行 (PID ${status.pid})` };
  }

  const pythonExe = getPythonExe(engine);
  if (!existsSync(pythonExe)) {
    return { ok: false, detail: '未安装，请先执行 install' };
  }

  const serverDir = getTtsServerDir(engine);

  // 终止旧进程（如果有残留）
  await stopServer(engine);

  return new Promise((resolve) => {
    const child = spawn(pythonExe, ['server.py'], {
      cwd: serverDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        HF_ENDPOINT: HF_MIRROR,
        HF_HUB_OFFLINE: existsSync(join(serverDir, 'models', 'tts-nano')) ? '1' : '0',
      },
    });

    serverProcesses.set(engineKey, child);
    let started = false;
    let output = '';

    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf-8');
      output += text;
      // uvicorn 启动成功会打印 "Uvicorn running on"
      if (!started && (text.includes('Uvicorn running') || text.includes('Application startup complete'))) {
        started = true;
        writePid(child.pid!, engine);
        resolve({ ok: true, detail: `TTS Server 已启动 (PID ${child.pid})` });
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
      serverProcesses.delete(engineKey);
      cleanPid(engine);
      if (!started) {
        resolve({ ok: false, detail: `进程退出 (code=${code})\n${output.slice(-500)}` });
      }
    });

    // 超时
    setTimeout(() => {
      if (!started) {
        resolve({ ok: false, detail: `启动超时（${spec.startupTimeout / 1000}s）\n${output.slice(-500)}` });
      }
    }, spec.startupTimeout);
  });
}

/**
 * 停止 TTS Server
 */
export async function stopServer(engine?: string): Promise<{ ok: boolean; detail: string }> {
  const engineKey = engine || 'edge-tts';

  // 优先终止管理的子进程
  const proc = serverProcesses.get(engineKey);
  if (proc && !proc.killed) {
    try {
      proc.kill('SIGTERM');
    } catch { /* ignore */ }
    serverProcesses.delete(engineKey);
  }

  // 也尝试通过 PID 文件终止
  const pid = readPid(engine);
  if (pid !== null && isProcessAlive(pid)) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch { /* ignore */ }
  }
  cleanPid(engine);

  // 等待端口释放
  await new Promise(r => setTimeout(r, 500));
  return { ok: true, detail: '已停止' };
}

/**
 * 安装 + 启动（一键安装）。不涉及配置，配置由 main.ts 处理。
 */
export async function installAndStart(onProgress?: (msg: string) => void, engine?: string): Promise<{ ok: boolean; detail: string }> {
  const installResult = await install(onProgress, engine);
  if (!installResult.ok) return installResult;

  onProgress?.('启动 TTS Server…');
  const startResult = await startServer(engine);
  if (!startResult.ok) return startResult;

  const spec = resolveEngine(engine);
  const localUrl = `http://127.0.0.1:${spec.port}`;
  // 进程起来不代表能出声：服务明确报告不可用（如 Genie 一个角色都没加载成功）时如实失败，让开关退回关闭
  const problem = await findHealthProblem(localUrl);
  if (problem) {
    await stopServer(engine);
    return { ok: false, detail: `TTS 服务已启动但不可用：${problem}` };
  }
  onProgress?.('全部完成');
  return { ok: true, detail: `${startResult.detail}\nTTS 本地服务已就绪 (${localUrl})` };
}

/** 读取 /health 的 status；只把明确的失败状态当作不可用（loading / starting 属于正常启动过程） */
async function findHealthProblem(localUrl: string): Promise<string | undefined> {
  try {
    const resp = await fetch(`${localUrl}/health`, { signal: AbortSignal.timeout(15_000) });
    const body = await resp.json().catch(() => undefined) as { status?: string; errors?: unknown; error?: string } | undefined;
    if (body?.status === 'no_characters' || body?.status === 'error') {
      return body.errors ? JSON.stringify(body.errors) : body.error ?? body.status;
    }
  } catch {
    // 读不到健康状态不阻断：进程已确认启动，交给播放时的健康检查
  }
  return undefined;
}

// ── PID 管理 ────────────────────────────────────────────────────────

function readPid(engine?: string): number | null {
  try {
    const raw = readFileSync(getPidFile(engine), 'utf-8').trim();
    const pid = parseInt(raw, 10);
    return isNaN(pid) ? null : pid;
  } catch { return null; }
}

function writePid(pid: number, engine?: string): void {
  try { writeFileSync(getPidFile(engine), String(pid), 'utf-8'); } catch { /* ignore */ }
}

function cleanPid(engine?: string): void {
  try { unlinkSync(getPidFile(engine)); } catch { /* ignore */ }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}

// ── 进程退出时清理所有引擎 ──────────────────────────────────────────

app.on('before-quit', () => {
  for (const [, proc] of serverProcesses) {
    if (!proc.killed) {
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
    }
  }
});
