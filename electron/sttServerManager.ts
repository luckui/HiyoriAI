/**
 * STT 本地服务（faster-whisper WebSocket，stt-server/）。
 * 通用的安装/启动/停止逻辑见 pythonService.ts；这里只描述 STT 的端口、启动参数与模型配置。
 */

import { PythonService, type PythonServiceStatus, type ServiceResult } from './pythonService';

export type STTModelSize = 'tiny' | 'base' | 'small' | 'medium' | 'large-v3';

export interface STTServerConfig {
  model: STTModelSize;
  language: string;
  device: 'auto' | 'cpu' | 'cuda';
}

export interface SttServerStatus extends PythonServiceStatus {
  model: STTModelSize;
  language: string;
}

const STT_PORT = 9890;

let currentConfig: STTServerConfig = { model: 'base', language: 'zh', device: 'auto' };

const service = new PythonService({
  label: 'STT Server',
  dir: 'stt-server',
  port: STT_PORT,
  startupTimeoutMs: 60_000, // 模型首次加载较慢
  // server.py 打印 "Application startup complete"；websockets 16+ 自行打印 "server listening on ..."
  readyMarkers: ['Application startup complete', 'running on', 'server listening'],
  requirementsLabel: '安装 STT 依赖（faster-whisper + websockets）…',
  args: () => [
    '--port', String(STT_PORT),
    '--model', currentConfig.model,
    '--device', currentConfig.device,
    '--language', currentConfig.language,
  ],
});

export async function getStatus(): Promise<SttServerStatus> {
  return { ...(await service.getStatus()), model: currentConfig.model, language: currentConfig.language };
}

export function install(onProgress?: (msg: string) => void): Promise<ServiceResult> {
  return service.install(onProgress);
}

export function startServer(config?: Partial<STTServerConfig>): Promise<ServiceResult> {
  if (config) updateConfig(config);
  return service.start();
}

export function stopServer(): Promise<ServiceResult> {
  return service.stop();
}

/** 安装 + 启动（一键） */
export async function installAndStart(
  onProgress?: (msg: string) => void,
  config?: Partial<STTServerConfig>,
): Promise<ServiceResult> {
  const installed = await install(onProgress);
  if (!installed.ok) return installed;

  onProgress?.('启动 STT Server…');
  const started = await startServer(config);
  if (!started.ok) return started;

  onProgress?.('全部完成');
  return { ok: true, detail: `${started.detail}\nSTT 服务已就绪 (${getWebSocketUrl()})` };
}

export function updateConfig(config: Partial<STTServerConfig>): void {
  currentConfig = { ...currentConfig, ...config };
}

export function getConfig(): STTServerConfig {
  return { ...currentConfig };
}

export function getWebSocketUrl(): string {
  return `ws://127.0.0.1:${STT_PORT}`;
}
