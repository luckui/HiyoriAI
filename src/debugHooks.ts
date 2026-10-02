/**
 * 调试开关：在开发者工具里执行
 *   localStorage.setItem('hiyori.debug.liveliness', '1')
 * 然后重载页面，就会
 *   - 每 2 秒打印一次节拍时钟和律动强度（排查「为什么不跟着晃」）
 *   - 挂出 window.__hiyoriDebug，可以手动让她说一句话、看灵动层状态
 * 关掉：localStorage.removeItem('hiyori.debug.liveliness') 再重载。
 */

import { liveliness } from './liveliness/motor';
import { playTTS } from './ttsPlayer';

export function installDebugHooks(): void {
  let enabled = false;
  try { enabled = localStorage.getItem('hiyori.debug.liveliness') === '1'; } catch { /* 存储不可用 */ }
  if (!enabled) return;

  (window as unknown as Record<string, unknown>).__hiyoriDebug = {
    liveliness,
    say: (text: string) => playTTS(text),
  };
  setInterval(() => {
    console.log('[Liveliness]', JSON.stringify(liveliness.status(performance.now())));
  }, 2000);
  console.log('[Debug] 灵动层调试已开启：window.__hiyoriDebug');
}
