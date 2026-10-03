/**
 * Live2D 渲染进程控制器
 *
 * 职责：
 *   - 监听主进程 IPC `live2d:cmd`（manage_live2d 工具等）
 *   - 表情交给灵动层演；动作、参数直控交给 LAppModel
 *
 * 使用：在 src/main.ts 中调用 initLive2DController()。
 */

import { LAppDelegate } from './lappdelegate';
import * as LAppDefine from './lappdefine';
import { liveliness } from './liveliness/motor';
import { isExpression } from '../shared/expressions';

// ── 获取当前模型实例 ──────────────────────────────────────────────

function getModel() {
  const delegate = LAppDelegate.getInstance();
  const sub = delegate.getFirstSubdelegate();
  if (!sub) return null;
  return sub.getLive2DManager().getFirstModel();
}

// ── 命令处理 ──────────────────────────────────────────────────────

function handleCommand(cmd: { type: string; [key: string]: unknown }): void {
  switch (cmd.type) {
    case 'emotion': {
      if (!isExpression(cmd.emotion)) break;
      const intensity = typeof cmd.intensity === 'number' ? cmd.intensity : 0.7;
      const durationMs = typeof cmd.durationMs === 'number' && cmd.durationMs > 0 ? cmd.durationMs : undefined;
      liveliness.setExpression({ expression: cmd.emotion, intensity }, durationMs);
      getModel()?.notifyInteraction();
      break;
    }

    case 'motion': {
      const group = (cmd.group as string);
      const no = cmd.no as number | undefined;
      const priority = (cmd.priority as number) ?? LAppDefine.PriorityNormal;
      const model = getModel();
      if (!model || !group) break;
      if (no !== undefined && no >= 0) {
        model.startMotion(group, no, priority);
      } else {
        model.startRandomMotion(group, priority);
      }
      break;
    }

    case 'param': {
      const parameterId = cmd.parameterId as string;
      const value = cmd.value as number;
      const model = getModel();
      if (!model || !parameterId || value === undefined) break;
      model.setParameterDirect(parameterId, value);
      break;
    }

    case 'query':
      // 未来可通过另一个 IPC 回传状态，目前仅记录
      console.log('[Live2D] query received, model:', !!getModel());
      break;

    default:
      console.warn('[Live2D] unknown cmd type:', cmd.type);
  }
}

/** 通知有用户交互（发送/收到消息），重置 bored 计时器 */
export function notifyInteraction(): void {
  const model = getModel();
  model?.notifyInteraction();
}

// ── 初始化：注册 IPC 监听器 ───────────────────────────────────────

let _initialized = false;

export function initLive2DController(): void {
  if (_initialized) return;
  _initialized = true;

  const api = window.live2dAPI;

  if (!api?.onCommand) {
    console.warn('[Live2DController] live2dAPI.onCommand 未找到，Live2D IPC 控制不可用');
    return;
  }

  api.onCommand((cmd) => {
    try {
      handleCommand(cmd as { type: string; [key: string]: unknown });
    } catch (e) {
      console.error('[Live2DController] 命令处理失败:', e, cmd);
    }
  });

  console.log('[Live2DController] 已初始化，等待 Live2D 命令');
}
