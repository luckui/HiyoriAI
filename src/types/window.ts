// preload 注入到 window 上的接口，定义见 shared/preloadApi.ts
import type { PreloadApis } from '../../shared/preloadApi';

declare global {
  interface Window extends PreloadApis {
    /** TTS 播放器写入的实时口型开合度（0–1），Live2D 模型每帧读取 */
    _live2dMouthOpen?: number;
  }
}

export {};
