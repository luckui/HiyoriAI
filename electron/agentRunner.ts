/**
 * AgentRunner — 子智能体执行引擎
 *
 * 在后台运行一个隔离的 ReAct 工具循环。
 * 复用 aiService 的核心 LLM 调用逻辑，但：
 *   - 不继承父对话历史（上下文隔离）
 *   - 工具集受限（CHILD_BLOCKED_TOOLS 禁止递归/模式切换/记忆写入）
 *   - 有独立 AbortSignal（可单独取消）
 *   - 进度回调（每轮工具调用后上报）
 */

import aiConfig from './ai.config';
import { fetchCompletion } from './llmClient';
import { toolRegistry } from './tools/index';
import { resolveToolset } from './toolsets';
import { isToolImageResult } from './tools/types';
import { stripThinkTags } from './utils/textUtils';
import { CHILD_BLOCKED_TOOLS } from './taskManager';
import type { DBTask } from './db';
import type { ChatMessage, ContentPart, ToolSchema } from './tools/types';

// ── 子智能体默认配置 ─────────────────────────────────────

const DEFAULT_MAX_ROUNDS = 15;

// ── 构建子智能体 System Prompt ───────────────────────────

function buildChildSystemPrompt(task: DBTask): string {
  const parts: string[] = [
    '你是一个专注的后台工作智能体，正在执行一项被委派的任务。',
    '',
    '## 你的任务',
    task.prompt,
  ];

  // 注入额外上下文
  if (task.context) {
    try {
      const ctx = JSON.parse(task.context);
      if (ctx.additionalContext) {
        parts.push('', '## 额外上下文', String(ctx.additionalContext));
      }
    } catch { /* ignore */ }
  }

  parts.push(
    '',
    '## 规则',
  );

  if (task.type === 'cron') {
    // 定时任务：结果交回系统唤醒机制，由主对话决定如何告知用户。
    parts.push(
      '- 这是一个定时触发的任务，根据任务内容决定是否需要告知用户',
      '- 完成后用简洁的自然语言输出结果摘要',
    );
  } else {
    parts.push(
      '- 你是后台任务，用户看不到你的中间过程，只能看到最终结果',
      '- 专注完成任务，不要闲聊',
      '- 完成后用简洁的自然语言输出结果摘要',
      '- 如果遇到无法解决的问题，说明原因并给出已完成的部分结果',
    );
  }

  return parts.join('\n');
}

// ── 获取子智能体可用工具 ─────────────────────────────────

function getChildToolSchemas(task: DBTask): ToolSchema[] | undefined {
  // 解析 metadata 中的 toolsets 配置
  let toolsetNames: string[] = ['agent']; // 默认 agent 工具集
  if (task.metadata) {
    try {
      const meta = JSON.parse(task.metadata);
      if (Array.isArray(meta.toolsets) && meta.toolsets.length > 0) {
        toolsetNames = meta.toolsets;
      }
    } catch { /* ignore */ }
  }

  // 展开 toolsets → 工具名列表
  const allToolNames = new Set<string>();
  for (const tsName of toolsetNames) {
    for (const name of resolveToolset(tsName)) {
      allToolNames.add(name);
    }
  }

  // 移除禁止工具
  for (const blocked of CHILD_BLOCKED_TOOLS) {
    allToolNames.delete(blocked);
  }

  // 从 registry 获取 schema
  const schemas = toolRegistry.getSchemasByNames([...allToolNames]);
  return schemas.length > 0 ? schemas : undefined;
}

// ── 主执行函数 ───────────────────────────────────────────

export async function runChildAgent(
  task: DBTask,
  signal: AbortSignal,
  onProgress: (progress: number, text: string) => void,
): Promise<string> {
  const provider = aiConfig.providers[aiConfig.activeProvider];
  if (!provider) throw new Error(`未找到 provider: ${aiConfig.activeProvider}`);

  // 解析最大轮数
  let maxRounds = DEFAULT_MAX_ROUNDS;
  if (task.metadata) {
    try {
      const meta = JSON.parse(task.metadata);
      if (typeof meta.maxRounds === 'number' && meta.maxRounds > 0) {
        maxRounds = Math.min(meta.maxRounds, 50); // 硬上限 50
      }
    } catch { /* ignore */ }
  }

  const systemPrompt = buildChildSystemPrompt(task);
  const toolSchemas = getChildToolSchemas(task);
  const withTools = !!toolSchemas?.length;

  console.log(
    `[AgentRunner] 任务启动: "${task.title}" (${task.id})\n` +
    `  可用工具数: ${toolSchemas?.length ?? 0}  最大轮次: ${maxRounds}\n` +
    `  prompt: ${task.prompt.length > 120 ? task.prompt.slice(0, 120) + '…' : task.prompt}`,
  );

  const msgBuf: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.prompt },
  ];

  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) throw new Error('任务已被取消');

    onProgress(round / maxRounds, `执行中 (轮次 ${round + 1}/${maxRounds})`);
    console.log(`[AgentRunner] "${task.title}" 轮次 ${round + 1}/${maxRounds} — 等待 LLM 响应…`);

    const data = await fetchCompletion(provider, msgBuf, withTools ? toolSchemas : undefined, signal);
    const choice = data.choices[0];

    // 无工具调用 → 返回最终文本
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      const finalText = stripThinkTags(choice.message.content?.trim() ?? '');
      console.log(
        `[AgentRunner] "${task.title}" 第 ${round + 1} 轮结束（无工具调用，返回最终结果）\n` +
        `  结果预览: ${finalText.slice(0, 100)}${finalText.length > 100 ? '…' : ''}`,
      );
      return finalText;
    }

    // 有工具调用 → 打印工具列表
    const toolNames = choice.message.tool_calls.map((tc) => {
      let argsPreview = '';
      try {
        const parsed = JSON.parse(tc.function.arguments);
        argsPreview = JSON.stringify(parsed).slice(0, 80);
      } catch { argsPreview = tc.function.arguments.slice(0, 80); }
      return `${tc.function.name}(${argsPreview})`;
    });
    console.log(`[AgentRunner] "${task.title}" 轮次 ${round + 1} 工具调用:\n  ${toolNames.join('\n  ')}`);

    // 有工具调用 → 追加 assistant 消息
    msgBuf.push({
      role: 'assistant',
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    });

    // 并行执行所有工具
    const execResults = await Promise.all(
      choice.message.tool_calls.map(async (tc) => {
        const taskContext = { conversationId: `task-${task.id}` };
        const result = await toolRegistry.execute(tc.function.name, tc.function.arguments, taskContext);
        return { tc, result };
      })
    );

    // 回填结果，同时打印摘要
    for (const { tc, result } of execResults) {
      const resultPreview = typeof result === 'object' && result !== null
        ? JSON.stringify(result).slice(0, 120)
        : String(result).slice(0, 120);
      console.log(`[AgentRunner] "${task.title}" 工具返回 ${tc.function.name}: ${resultPreview}${resultPreview.length >= 120 ? '…' : ''}`);
    }
    for (const { tc, result } of execResults) {
      if (isToolImageResult(result)) {
        msgBuf.push({ role: 'tool', tool_call_id: tc.id, content: result.text });
        const imageParts: ContentPart[] = [
          { type: 'text', text: '（以下是截取的屏幕截图）' },
          {
            type: 'image_url',
            image_url: {
              url: `data:${result.mimeType};base64,${result.imageBase64}`,
              detail: 'low',
            },
          },
        ];
        msgBuf.push({ role: 'user', content: imageParts });
      } else {
        const textResult = typeof result === 'object' ? JSON.stringify(result) : String(result);
        msgBuf.push({ role: 'tool', tool_call_id: tc.id, content: textResult });
      }
    }

    // 注入继续提示
    msgBuf.push({
      role: 'user',
      content: '【系统】根据以上工具结果，继续执行下一步或给出最终结果。',
    });

    onProgress((round + 1) / maxRounds, `轮次 ${round + 1} 完成，工具调用 ${execResults.length} 次`);
  }

  // 超出轮数：强制总结
  msgBuf.push({
    role: 'user',
    content: `【系统提示】已达到最大轮数 ${maxRounds}。请停止调用工具，用自然语言总结已完成的工作和结果。`,
  });

  try {
    const fallback = await fetchCompletion(provider, msgBuf, undefined, signal);
    return stripThinkTags(fallback.choices[0]?.message.content?.trim() ?? '（任务超出轮数，未能生成总结）');
  } catch {
    return `（任务未完成：工具调用超过 ${maxRounds} 轮）`;
  }
}
