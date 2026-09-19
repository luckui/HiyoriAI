/**
 * TTS 本地服务（多引擎）：每个引擎有独立的服务目录、.venv、端口和进程。
 * 通用的安装/启动/停止逻辑见 pythonService.ts；这里只描述各引擎的差异：
 * 引擎核心包、模型权重下载（hf-mirror.com 国内镜像）、启动后的健康检查。
 */

import { existsSync } from 'fs';
import { join } from 'path';
import { PythonService, type InstallContext, type PythonServiceStatus, type ServiceResult } from './pythonService';
import { PYPI_INDEX } from './uvRuntime';

const HF_MIRROR = 'https://hf-mirror.com';
const DEFAULT_ENGINE = 'edge-tts';

interface EngineSpec {
  dir: string;
  port: number;
  startupTimeoutMs: number;
  /** 额外的引擎核心包：本地源码目录或 PyPI 包名 */
  extraPackages?(serverDir: string): string[];
  /** 安装后运行 download_models.py 下载模型权重 */
  hasModelDownload?: boolean;
}

/** 优先从本地源码安装（开发模式 / 打包携带源码），否则回退到 PyPI 包 */
function localSourceOr(folder: string, pypiPackage: string) {
  return (serverDir: string): string[] => {
    const local = [join(serverDir, '..', '..', folder), join(serverDir, '..', folder)]
      .find((candidate) => existsSync(join(candidate, 'pyproject.toml')));
    return [local ?? pypiPackage];
  };
}

const ENGINES: Record<string, EngineSpec> = {
  'edge-tts': {
    dir: 'tts-server',
    port: 9880,
    startupTimeoutMs: 15_000,
  },
  'moss-tts-nano': {
    dir: 'tts-server-nano',
    port: 9881,
    startupTimeoutMs: 180_000,
    extraPackages: localSourceOr('MOSS-TTS-Nano-main', 'moss-tts-nano'),
    hasModelDownload: true,
  },
  'genie-tts': {
    dir: 'tts-server-genie',
    port: 9882,
    startupTimeoutMs: 60_000,
    // 锁定版本：server.py 按 2.0.x 的接口编写，新版本可能再次改接口
    extraPackages: localSourceOr('Genie-TTS-master', 'genie-tts==2.0.2'),
    hasModelDownload: true,
  },
};

async function installEngineExtras(spec: EngineSpec, ctx: InstallContext): Promise<ServiceResult | void> {
  for (const pkg of spec.extraPackages?.(ctx.serverDir) ?? []) {
    ctx.log(`安装${pkg.includes('/') || pkg.includes('\\') ? '引擎核心包（本地源码）' : `引擎核心包（${pkg}）`}…`);
    const result = await ctx.run(
      `"${ctx.uv}" pip install "${pkg}" --python "${ctx.pythonExe}" --index-url ${PYPI_INDEX}`,
      1_200_000, // 20 分钟（torch 较大）
    );
    if (result.code !== 0) return { ok: false, detail: `引擎包安装失败:\n${result.stderr.slice(0, 1000)}` };
  }

  if (spec.hasModelDownload && existsSync(join(ctx.serverDir, 'download_models.py'))) {
    ctx.log('下载模型权重（使用 hf-mirror.com 国内镜像）…');
    const result = await ctx.run(`"${ctx.pythonExe}" download_models.py`, 3_600_000, { HF_ENDPOINT: HF_MIRROR }); // 60 分钟（genie-tts ~1.5GB）
    if (result.code !== 0) return { ok: false, detail: `模型权重下载失败:\n${result.stderr.slice(0, 1000)}` };
  }
}

const services = new Map<string, PythonService>();

function engineKey(engine?: string): string {
  return engine || DEFAULT_ENGINE;
}

function serviceFor(engine?: string): PythonService {
  const key = engineKey(engine);
  const spec = ENGINES[key];
  if (!spec) throw new Error(`Unknown TTS engine: ${key}`);
  let service = services.get(key);
  if (!service) {
    service = new PythonService({
      label: 'TTS Server',
      dir: spec.dir,
      port: spec.port,
      startupTimeoutMs: spec.startupTimeoutMs,
      readyMarkers: ['Uvicorn running', 'Application startup complete'],
      env: (serverDir) => ({
        HF_ENDPOINT: HF_MIRROR,
        HF_HUB_OFFLINE: existsSync(join(serverDir, 'models', 'tts-nano')) ? '1' : '0',
      }),
      afterRequirements: (ctx) => installEngineExtras(spec, ctx),
    });
    services.set(key, service);
  }
  return service;
}

export interface TtsServerStatus extends PythonServiceStatus {
  engine: string;
}

export async function getStatus(engine?: string): Promise<TtsServerStatus> {
  return { ...(await serviceFor(engine).getStatus()), engine: engineKey(engine) };
}

export function install(onProgress?: (msg: string) => void, engine?: string): Promise<ServiceResult> {
  return serviceFor(engine).install(onProgress);
}

export function startServer(engine?: string): Promise<ServiceResult> {
  return serviceFor(engine).start();
}

export function stopServer(engine?: string): Promise<ServiceResult> {
  return serviceFor(engine).stop();
}

/** 安装 + 启动（一键）。只管服务本身，TTS 配置由 ttsRuntime 处理 */
export async function installAndStart(onProgress?: (msg: string) => void, engine?: string): Promise<ServiceResult> {
  const installed = await install(onProgress, engine);
  if (!installed.ok) return installed;

  onProgress?.('启动 TTS Server…');
  const started = await startServer(engine);
  if (!started.ok) return started;

  // 进程起来不代表能出声：服务明确报告不可用（如 Genie 一个角色都没加载成功）时如实失败，让开关退回关闭
  const service = serviceFor(engine);
  const problem = await findHealthProblem(service.localUrl);
  if (problem) {
    await service.stop();
    return { ok: false, detail: `TTS 服务已启动但不可用：${problem}` };
  }
  onProgress?.('全部完成');
  return { ok: true, detail: `${started.detail}\nTTS 本地服务已就绪 (${service.localUrl})` };
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
