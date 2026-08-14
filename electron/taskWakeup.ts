import type { DBTask } from './db';

export function taskBelongsToSlot(
  task: Pick<DBTask, 'metadata'>,
  slotKey: string,
): boolean {
  if (!task.metadata) return false;
  try {
    return JSON.parse(task.metadata).slotKey === slotKey;
  } catch {
    return false;
  }
}

export function buildTaskCompletedWakeup(
  task: Pick<DBTask, 'id' | 'title' | 'result'>,
): string {
  const resultPreview = task.result && task.result.length > 1500
    ? task.result.slice(0, 1500) + `\n…(共 ${task.result.length} 字，如需完整结果请调用 async_task result task_id="${task.id}")`
    : task.result ?? '';
  return [
    `【系统通知】后台任务「${task.title}」已完成。`,
    `任务 ID：${task.id}`,
    resultPreview ? `\n结果：\n${resultPreview}` : '',
    '\n请检查结果并继续执行后续步骤。',
  ].filter(Boolean).join('\n');
}

export function buildTaskFailedWakeup(
  task: Pick<DBTask, 'id' | 'title' | 'error'>,
): string {
  return [
    `【系统通知】后台任务「${task.title}」执行失败。`,
    `任务 ID：${task.id}`,
    `错误信息：${task.error ?? '未知错误'}`,
    '\n请处理错误或告知用户。',
  ].join('\n');
}
