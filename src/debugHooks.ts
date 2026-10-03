/**
 * 调试开关：在开发者工具里执行
 *   localStorage.setItem('hiyori.debug.liveliness', '1')
 * 然后重载页面，就会
 *   - 每 2 秒打印一次节拍时钟和律动强度（排查「为什么不跟着晃」）
 *   - 挂出 window.__hiyoriDebug：让她说一句话（say）、看灵动层状态、读模型参数（params）
 * 关掉：localStorage.removeItem('hiyori.debug.liveliness') 再重载。
 */

import { CubismFramework } from '@framework/live2dcubismframework';
import { LAppDelegate } from './lappdelegate';
import { liveliness } from './liveliness/motor';
import { playTTS } from './ttsPlayer';

/** 读模型参数的范围、默认值和当前值：给新模型调表情、排查「这个参数怎么没反应」 */
function readParams(ids: string[]) {
  const model = LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().getFirstModel()?.getModel();
  if (!model) return [];
  return ids.map((id) => {
    const index = model.getParameterIndex(CubismFramework.getIdManager().getId(id));
    if (index >= model.getParameterCount()) return { id, missing: true };
    return {
      id,
      min: model.getParameterMinimumValue(index),
      max: model.getParameterMaximumValue(index),
      default: model.getParameterDefaultValue(index),
      value: Number(model.getParameterValueByIndex(index).toFixed(3)),
    };
  });
}

export function installDebugHooks(): void {
  let enabled = false;
  try { enabled = localStorage.getItem('hiyori.debug.liveliness') === '1'; } catch { /* 存储不可用 */ }
  if (!enabled) return;

  (window as unknown as Record<string, unknown>).__hiyoriDebug = {
    liveliness,
    say: (text: string) => playTTS(text),
    params: readParams,
    /** 漫符的落点（设备像素）：脸、脸颊、头顶 */
    anchors: () => LAppDelegate.getInstance().getFirstSubdelegate()?.getLive2DManager().getFirstModel()?.getAnchors() ?? null,
  };
  setInterval(() => {
    console.log('[Liveliness]', JSON.stringify(liveliness.status(performance.now())));
  }, 2000);
  console.log('[Debug] 灵动层调试已开启：window.__hiyoriDebug');
}
