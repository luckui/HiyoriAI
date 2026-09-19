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

export function buildBatchCompletedWakeup(
  task: Pick<DBTask, 'id' | 'title' | 'result'>,
  problemCount = 0,
): string {
  const lines = [
    `【系统通知】批量任务「${task.title}」全部子任务已执行完毕。`,
    `任务 ID：${task.id}`,
    '',
    task.result?.trim() || '（无汇总）',
    '',
    '⚠️ 各项完整结果未注入上下文。',
    `请先调用 async_task({"action":"result","task_id":"${task.id}"}) 分页读取（按页脚提示的 offset 继续），再回复用户。`,
  ];
  if (problemCount > 0) {
    lines.push(`有 ${problemCount} 项失败或未执行；如需补跑，可调用 async_task({"action":"retry","task_id":"${task.id}"})（只重跑这些项）。`);
  }
  return lines.join('\n');
}

export function buildTaskFailedWakeup(
  task: Pick<DBTask, 'id' | 'title' | 'error'> & Partial<Pick<DBTask, 'type'>>,
): string {
  const retryHint = task.type === 'batch'
    ? `如问题已排除或属于临时故障，可调用 async_task({"action":"retry","task_id":"${task.id}"}) 继续：只重跑失败/未执行的项，已成功的项保留。`
    : `如属临时故障或问题已排除，可调用 async_task({"action":"retry","task_id":"${task.id}"}) 重试。`;
  return [
    `【系统通知】后台任务「${task.title}」执行失败。`,
    `任务 ID：${task.id}`,
    `错误信息：${task.error ?? '未知错误'}`,
    '',
    retryHint,
    '请处理错误或告知用户。',
  ].join('\n');
}
