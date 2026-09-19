/**
 * uv 运行时 — 定位 / 按需下载 uv.exe，以及 Python 环境安装用到的镜像
 *
 * tools/uv.exe 体积大（~68MB）不进 git：安装包通过 extraResources 自带，
 * 源码构建的用户第一次打开本地语音 / 听觉服务时由这里自动补齐：
 * 从清华 PyPI 镜像下载官方 uv wheel（版本固定，校验 SHA-256），解压出 uv.exe，
 * 运行 `uv --version` 验证后再放到目标位置。
 *
 * 存放位置：
 *   - 开发：<项目>/tools/uv.exe（与打包配置 extraResources 一致，pack:win 可直接使用）
 *   - 打包：优先 resources/tools/uv.exe；缺失时下载到 userData/tools/uv.exe（安装目录可能没有写权限）
 */

import { app } from 'electron';
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { inflateRawSync } from 'zlib';

// ── 镜像 ──────────────────────────────────────────────────

/** pip 源 */
export const PYPI_INDEX = 'https://mirrors.tuna.tsinghua.edu.cn/pypi/web/simple';
/** uv 下载 Python 解释器（python-build-standalone）的镜像：清华未收录，使用 npmmirror */
export const PYTHON_INSTALL_MIRROR = 'https://registry.npmmirror.com/-/binary/python-build-standalone';

const TUNA_PYPI_FILES = 'https://mirrors.tuna.tsinghua.edu.cn/pypi/web';

// ── uv 版本 ───────────────────────────────────────────────

export const UV_VERSION = '0.11.7';

/** 官方 uv wheel（PyPI 文件内容不可变，SHA-256 取自 PyPI JSON API） */
const UV_WHEELS: Record<string, { path: string; sha256: string }> = {
  x64: {
    path: '/packages/a6/1d/b73e473da616ac758b8918fb218febcc46ddf64cba9e03894dfa226b28bd/uv-0.11.7-py3-none-win_amd64.whl',
    sha256: '5674dfb5944513f4b3735b05c2deba6b1b01151f46729d533d413a9a905f8c5d',
  },
  arm64: {
    path: '/packages/1b/bb/e6bfdea92ed270f3445a5a3c17599d041b3f2dbc5026c09e02830a03bbaf/uv-0.11.7-py3-none-win_arm64.whl',
    sha256: '6158b7e39464f1aa1e040daa0186cae4749a78b5cd80ac769f32ca711b8976b1',
  },
};

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export interface UvDownload {
  url: string;
  sha256: string;
}

export interface UvPaths {
  /** 随应用分发的 uv.exe 位置 */
  bundledPath: string;
  /** 自动下载的 uv.exe 存放目录 */
  downloadDir: string;
}

export interface EnsureUvOptions extends UvPaths {
  onProgress?: (message: string) => void;
  fetch?: FetchLike;
  /** 覆盖下载地址（测试用） */
  download?: UvDownload;
  /** 验证解压出的 uv 可执行，返回版本输出（默认运行 `uv --version`） */
  verify?: (exePath: string) => Promise<string>;
}

export function uvDownload(platform: string = process.platform, arch: string = process.arch): UvDownload {
  const wheel = platform === 'win32' ? UV_WHEELS[arch] : undefined;
  if (!wheel) {
    throw new Error(`暂不支持为 ${platform}-${arch} 自动下载 uv，请手动安装 uv ${UV_VERSION} 并放到 tools/uv.exe`);
  }
  return { url: TUNA_PYPI_FILES + wheel.path, sha256: wheel.sha256 };
}

// ── 定位 / 确保存在 ───────────────────────────────────────

export function findUv(paths: UvPaths): string | undefined {
  if (existsSync(paths.bundledPath)) return paths.bundledPath;
  const downloaded = join(paths.downloadDir, 'uv.exe');
  return existsSync(downloaded) ? downloaded : undefined;
}

const inflight = new Map<string, Promise<string>>();

/** 返回可用的 uv.exe 路径；不存在时自动下载（TTS / STT 同时安装也只下载一次） */
export async function ensureUv(options: EnsureUvOptions): Promise<string> {
  const existing = findUv(options);
  if (existing) return existing;
  const target = join(options.downloadDir, 'uv.exe');
  let pending = inflight.get(target);
  if (!pending) {
    pending = downloadUv(target, options).finally(() => inflight.delete(target));
    inflight.set(target, pending);
  }
  return pending;
}

async function downloadUv(target: string, options: EnsureUvOptions): Promise<string> {
  const log = (message: string) => options.onProgress?.(message);
  const temp = `${target}.${process.pid}.download`;
  try {
    const { url, sha256 } = options.download ?? uvDownload();
    mkdirSync(options.downloadDir, { recursive: true });
    log(`未找到 uv，从清华 PyPI 镜像下载 uv ${UV_VERSION}…`);
    const archive = await downloadBuffer(url, options.fetch ?? fetch, log);
    const digest = createHash('sha256').update(archive).digest('hex');
    if (digest !== sha256) throw new Error(`SHA-256 校验失败（得到 ${digest.slice(0, 12)}…），文件已丢弃`);
    const exe = extractZipEntry(archive, (name) => name.slice(name.lastIndexOf('/') + 1) === 'uv.exe');
    if (!exe) throw new Error('压缩包中没有 uv.exe');
    writeFileSync(temp, exe);
    const version = await (options.verify ?? runUvVersion)(temp);
    renameSync(temp, target);
    log(`✓ uv 已就绪：${version.trim()}`);
    return target;
  } catch (error) {
    rmSync(temp, { force: true });
    throw new Error(`uv 下载失败：${describeError(error)}\n可以按 tools/README.md 手动下载 uv ${UV_VERSION}，放到 ${target}`);
  }
}

// ── 应用内路径 ────────────────────────────────────────────

export function appUvPaths(): UvPaths {
  return app.isPackaged
    ? { bundledPath: join(process.resourcesPath, 'tools', 'uv.exe'), downloadDir: join(app.getPath('userData'), 'tools') }
    : { bundledPath: join(app.getAppPath(), 'tools', 'uv.exe'), downloadDir: join(app.getAppPath(), 'tools') };
}

export function findAppUv(): string | undefined {
  return findUv(appUvPaths());
}

export function ensureAppUv(onProgress?: (message: string) => void): Promise<string> {
  return ensureUv({ ...appUvPaths(), onProgress });
}

// ── 下载 / 解压 / 验证 ────────────────────────────────────

const DOWNLOAD_IDLE_TIMEOUT_MS = 30_000;

/** 下载到内存；超过 30s 没有收到数据视为停滞并中止 */
async function downloadBuffer(url: string, fetchImpl: FetchLike, onProgress: (message: string) => void): Promise<Buffer> {
  const controller = new AbortController();
  const stall = () => controller.abort(new DOMException('下载停滞', 'TimeoutError'));
  let timer = setTimeout(stall, DOWNLOAD_IDLE_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { redirect: 'follow', signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status}`);
    const total = Number(response.headers.get('content-length')) || 0;
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let received = 0;
    let nextReport = 0.25;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      clearTimeout(timer);
      timer = setTimeout(stall, DOWNLOAD_IDLE_TIMEOUT_MS);
      chunks.push(value);
      received += value.length;
      if (total > 0 && received / total >= nextReport) {
        onProgress(`  已下载 ${Math.floor((received / total) * 100)}%（${toMB(received)} / ${toMB(total)}）`);
        while (received / total >= nextReport) nextReport += 0.25;
      }
    }
    return Buffer.concat(chunks);
  } finally {
    clearTimeout(timer);
  }
}

/** 从 zip（wheel 也是 zip）中取出第一个匹配的文件；支持 stored / deflate，不支持 zip64 */
export function extractZipEntry(zip: Buffer, match: (name: string) => boolean): Buffer | undefined {
  const EOCD = 0x06054b50;
  const CENTRAL = 0x02014b50;
  const LOCAL = 0x04034b50;
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === EOCD) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是有效的 zip 文件');

  const entryCount = zip.readUInt16LE(eocd + 10);
  let offset = zip.readUInt32LE(eocd + 16);
  for (let n = 0; n < entryCount; n++) {
    if (zip.readUInt32LE(offset) !== CENTRAL) throw new Error('zip 中央目录损坏');
    const method = zip.readUInt16LE(offset + 10);
    const compressedSize = zip.readUInt32LE(offset + 20);
    const nameLength = zip.readUInt16LE(offset + 28);
    const extraLength = zip.readUInt16LE(offset + 30);
    const commentLength = zip.readUInt16LE(offset + 32);
    const localOffset = zip.readUInt32LE(offset + 42);
    const name = zip.toString('utf8', offset + 46, offset + 46 + nameLength);
    if (match(name)) {
      if (zip.readUInt32LE(localOffset) !== LOCAL) throw new Error('zip 本地文件头损坏');
      const dataStart = localOffset + 30 + zip.readUInt16LE(localOffset + 26) + zip.readUInt16LE(localOffset + 28);
      const data = zip.subarray(dataStart, dataStart + compressedSize);
      if (method === 0) return Buffer.from(data);
      if (method === 8) return inflateRawSync(data);
      throw new Error(`不支持的 zip 压缩方式: ${method}`);
    }
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return undefined;
}

function runUvVersion(exePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, ['--version'], { windowsHide: true });
    let output = '';
    child.stdout.on('data', (chunk: Buffer) => { output += chunk.toString('utf8'); });
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('uv --version 超时'));
    }, 15_000);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0 && output.includes(UV_VERSION)) resolve(output.trim());
      else reject(new Error(`uv --version 校验失败（退出码 ${code}）：${output.trim()}`));
    });
  });
}

function describeError(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === 'TimeoutError' || error.name === 'AbortError') return '下载超时';
    return (error.cause as { code?: string } | undefined)?.code ?? error.message;
  }
  return String(error);
}

function toMB(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
}
