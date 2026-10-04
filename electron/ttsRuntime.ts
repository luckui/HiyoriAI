/**
 * TTS 运行时：把当前 TTS 配置应用到 ttsService，并对外提供播放与配置修改入口。
 *
 * 配置本身存放在 config/runtimeConfig；这里负责"改配置之后要做的事"：
 * 确保本地服务就绪 → 激活 provider → 持久化 → 通知各窗口刷新。
 */

import { ttsService } from './ttsService';
import defaultTTSConfig, { type TTSConfig } from './tts.config';
import { ensureTTSRuntimeReady } from './ttsLifecycle';
import * as ttsServerManager from './ttsServerManager';
import { mergeBuiltinTTSProviders } from './genieVoiceManager';
import { configureBridgeVoiceRuntime } from './bridges/voiceReplies';
import { getTTSConfig, persistAppConfig, setTTSConfig } from './config/runtimeConfig';
import { broadcastToWindows, sendToRenderer } from './mainWindow';

configureBridgeVoiceRuntime({
  getProvider: () => {
    const cfg = getTTSConfig();
    return ttsService.isEnabled ? cfg.providers[cfg.activeProvider] : null;
  },
});

/** 根据当前 TTS 配置激活/禁用 ttsService */
export function activateTTSProvider(): void {
  const cfg = getTTSConfig();
  console.log(`[TTS] activateTTSProvider: enabled=${cfg.enabled}, activeProvider=${cfg.activeProvider}`);
  if (!cfg.enabled) {
    console.log('[TTS] → 全局开关关闭，禁用 TTS');
    ttsService.configure(null);
    return;
  }
  const provider = cfg.providers[cfg.activeProvider];
  if (!provider) {
    console.log(`[TTS] → 找不到 provider "${cfg.activeProvider}"，禁用 TTS`);
    ttsService.configure(null);
    return;
  }
  const fallback = provider.fallbackProvider && provider.fallbackProvider !== cfg.activeProvider
    ? cfg.providers[provider.fallbackProvider] ?? null
    : null;
  console.log(`[TTS] → 激活 provider "${cfg.activeProvider}": url=${provider.baseUrl}, speaker=${provider.speaker}, engine=${provider.localEngine ?? provider.type}, fallback=${fallback ? provider.fallbackProvider : 'none'}`);
  ttsService.configure(provider, fallback);
}

export function broadcastTTSChanged(): void {
  broadcastToWindows('tts:config-changed');
}

/** 确保本地 TTS 服务（如果当前方案是本地的）已安装并启动，然后激活 provider */
export async function applyTTSRuntime(onProgress: (msg: string) => void): Promise<{ ok: boolean; detail?: string }> {
  const result = await ensureTTSRuntimeReady(getTTSConfig(), {
    installAndStart: ttsServerManager.installAndStart,
    onProgress,
  });
  activateTTSProvider();
  return result;
}

/** 供 manageTTS 工具使用：部分更新 TTS 配置并立即生效 */
export function updateTTSConfig(patch: Partial<TTSConfig>): void {
  setTTSConfig({ ...getTTSConfig(), ...patch });
  activateTTSProvider();
  persistAppConfig();
  broadcastTTSChanged();
}

/** 设置页保存 TTS 方案：内置方案关键字段强制用代码版本，然后拉起本地服务 */
export async function saveTTSSettings(next: TTSConfig, onProgress: (msg: string) => void) {
  setTTSConfig(mergeBuiltinTTSProviders(next, defaultTTSConfig));
  const runtime = await applyTTSRuntime(onProgress);
  if (!runtime.ok) console.warn('[TTS] config save apply failed:', runtime.detail);
  persistAppConfig();
  broadcastTTSChanged();
  return runtime;
}

/**
 * 桥接语音回复需要 TTS：未开启时自动开启，并确保本地服务就绪。
 * 返回 ok=false 时调用方应关闭语音回复。
 */
export async function enableTTSForVoiceReplies(source: string): Promise<{ ok: boolean; detail?: string }> {
  const cfg = getTTSConfig();
  if (!cfg.enabled) setTTSConfig({ ...cfg, enabled: true });
  const result = await applyTTSRuntime((msg) => console.info(`[BridgeVoice] ${source}: ${msg}`));
  broadcastTTSChanged();
  return result;
}

/**
 * 让渲染进程朗读一段文字（复用聊天框的播放逻辑：分句、口型、字幕）。
 * 供主进程里的自动化流程（直播、Minecraft）调用。
 */
export async function playTTSAudio(text: string): Promise<boolean> {
  if (!sendToRenderer('tts:play', { text })) {
    console.warn('[TTS] playTTSAudio → 跳过: 主窗口不可用');
    return false;
  }
  console.log(`[TTS] playTTSAudio → 发送文本到渲染进程: ${text.substring(0, 50)}...`);
  return true;
}

let nextPlayId = 0;
const pendingPlays = new Map<number, () => void>();

/**
 * 同 playTTSAudio，但等到渲染进程实际播完才返回（直播节奏要知道她什么时候说完）。
 * 渲染进程排队、合成慢都算在内；为防回报丢失，超过按字数估的时长加 20 秒就当说完。
 * 返回 false 表示没能交给渲染进程。
 */
export function speakAndWait(text: string): Promise<boolean> {
  const id = ++nextPlayId;
  return new Promise((resolve) => {
    const timer = setTimeout(() => finish(), 20_000 + text.length * 400);
    const finish = () => {
      clearTimeout(timer);
      pendingPlays.delete(id);
      resolve(true);
    };
    pendingPlays.set(id, finish);
    if (!sendToRenderer('tts:play', { text, id })) {
      clearTimeout(timer);
      pendingPlays.delete(id);
      resolve(false);
    }
  });
}

/** 渲染进程回报某段朗读播完 */
export function notifyPlayDone(id: number): void {
  pendingPlays.get(id)?.();
}
