// preload 注入到 window 上的接口，定义见 shared/preloadApi.ts
import type { PreloadApis } from '../../shared/preloadApi';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  interface Window extends PreloadApis {}
}

export {};
