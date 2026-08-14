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
import { traceTurnEvent } from './turnTrace';

// ── 子智能体默认配置 ─────────────────────────────────────

const DEFAULT_MAX_ROUNDS = 15;
const CHILD_MAX_OUTPUT_TOKENS = 4096;
const CHILD_TRUNCATION_RETRY_TOKENS = 8192;

async function fetchChildCompletion(
  provider: Parameters<typeof fetchCompletion>[0],
  messages: ChatMessage[],
  tools: ToolSchema[] | undefined,
  signal: AbortSignal,
) {
  const configured = Number(provider.maxTokens ?? 0);
  const firstBudget = Math.max(CHILD_MAX_OUTPUT_TOKENS, Number.isFinite(configured) ? configured : 0);
  let response = await fetchCompletion(provider, messages, tools, signal, { maxTokens: firstBudget });
  const firstChoice = response.choices[0];
  if (firstChoice?.finish_reason !== 'length') return response;

  const partial = stripThinkTags(firstChoice.message.content?.trim() ?? '');
  if (partial) messages.push({ role: 'assistant', content: partial });
  messages.push({
    role: 'user',
    content: '[System] The previous response reached its output limit before completing. Continue from that point and return a complete tool call or final factual result.',
  });
  console.warn(`[AgentRunner] child response reached output limit; retrying with ${CHILD_TRUNCATION_RETRY_TOKENS} tokens`);
  response = await fetchCompletion(provider, messages, tools, signal, {
    maxTokens: Math.max(CHILD_TRUNCATION_RETRY_TOKENS, firstBudget),
  });
  if (response.choices[0]?.finish_reason === 'length') {
    throw new Error('Child task output reached the length limit twice and was truncated before completion.');
  }
  return response;
}

// 从子智能体的工具调用历史合成最终摘要（LLM 返回空结果时兜底，避免“完成但无结果”）
function synthesizeToolHistorySummary(msgBuf: ChatMessage[]): string {
  const lines: string[] = [];
  for (const msg of msgBuf) {
    if (msg.role !== 'assistant' || !Array.isArray((msg as any).tool_calls)) continue;
    for (const call of (msg as any).tool_calls ?? []) {
      const name: string = call?.function?.name ?? '?';
      let argsText = '';
      try {
        const args = JSON.parse(call?.function?.arguments ?? '{}');
        const parts: string[] = [];
        for (const key of ['action', 'item', 'block', 'entity', 'quantity', 'maxCount']) {
          if (args[key] !== undefined) parts.push(`${key}=${args[key]}`);
        }
        argsText = parts.length ? `(${parts.join(', ')})` : '';
      } catch {
        // 参数解析失败就用空参
      }
      const resultMsg = msgBuf.find((m) => m.role === 'tool' && (m as any).tool_call_id === call?.id);
      const raw = typeof resultMsg?.content === 'string' ? resultMsg.content : '';
      lines.push(`- ${name}${argsText}：${extractToolResultSummary(raw)}`);
    }
  }
  return lines.length ? `根据工具调用记录，本次任务实际执行了：\n${lines.join('\n')}` : '';
}

function extractToolResultSummary(raw: string): string {
  const status = raw.match(/状态[：:]\s*(\S+)/);
  const summary = raw.match(/Summary[：:]\s*([^\n]+)/);
  if (summary) {
    const prefix = status ? `状态=${status[1]}，` : '';
    return `${prefix}${summary[1].trim()}`;
  }
  const flattened = raw.replace(/\s+/g, ' ').trim();
  return flattened.slice(0, 140) || '（无结果）';
}

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

  if (taskUsesToolset(task, 'minecraft')) {
    parts.push(
      '',
      '## Minecraft 任务执行',
      '- 你在 Minecraft 世界中执行真实游戏任务（不是角色扮演）。',
      '- 你必须自己完成这项任务：所有操作直接用 Minecraft 动作工具完成，不要尝试创建或移交子任务。',
      '- 你拥有这项游戏任务直到产生明确终态；每个 Minecraft 动作工具都会返回真实终态结果。',
      '- 先观察事实，再行动，再核对背包、实体或世界变化；未达到目标时继续选择下一步。',
      '- 数量目标按“本次新收集量”理解：背包已有数量不算；必须实际调用 collect_item 等动作直到本次新增数量达标，工具返回终态前不得声称任务已完成。',
      '- 用户没有指定收集数量时，默认收集 64 个（一组）；收集够数量或周围没有更多目标时，汇报实际收集数量并完成任务。',
      '- collect_item 会自动搜索并持续采集，直到达到数量或周围没有更多目标；同一采集目标无需先调用 search_block。',
      '- attack_entity 会自动靠近最近目标并攻击，quantity 一次指定多个目标（如 3 只羊），一次调用即可完成全部击杀与掉落拾取。',
      '- craft_item 会自动规划并完成中间步骤（木板、木棍、工作台）与工作台放置，直接指定目标物品一次调用即可，不需要先分别合成中间材料。',
      '- 不向用户输出中间播报。只在目标完成、无法继续或需要用户介入时给出最终事实摘要。',
      '- 最终摘要只写可验证的游戏事实、实际变化、阻塞原因和仍需用户决定的事项；不要称呼用户，也不要提及后台任务、子智能体、委派、任务编号或内部实现。',
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
  const traceBase = {
    turnId: task.id,
    taskId: task.id,
    conversationId: task.conversation_id ?? `task-${task.id}`,
  };
  traceTurnEvent({
    ...traceBase,
    type: 'child-task-started',
    title: task.title,
    prompt: task.prompt,
    tools: toolSchemas?.map((tool) => tool.function.name) ?? [],
  });

  console.log(
    `[AgentRunner] 任务启动: "${task.title}" (${task.id})\n` +
    `  可用工具数: ${toolSchemas?.length ?? 0}  最大轮次: ${maxRounds}\n` +
    `  prompt: ${task.prompt.length > 120 ? task.prompt.slice(0, 120) + '…' : task.prompt}`,
  );

  const msgBuf: ChatMessage[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: task.prompt },
  ];
  let lastMinecraftAction: { status: 'failed' | 'partial' | 'cancelled'; result: string } | undefined;

  for (let round = 0; round < maxRounds; round++) {
    if (signal.aborted) {
      traceTurnEvent({ ...traceBase, type: 'child-task-cancelled', round: round + 1 });
      throw new Error('任务已被取消');
    }

    onProgress(round / maxRounds, `执行中 (轮次 ${round + 1}/${maxRounds})`);
    console.log(`[AgentRunner] "${task.title}" 轮次 ${round + 1}/${maxRounds} — 等待 LLM 响应…`);

    const data = await fetchChildCompletion(provider, msgBuf, withTools ? toolSchemas : undefined, signal);
    const choice = data.choices[0];
    traceTurnEvent({
      ...traceBase,
      type: 'child-llm-response',
      round: round + 1,
      finishReason: choice.finish_reason,
      visibleText: stripThinkTags(choice.message.content?.trim() ?? ''),
      toolCalls: choice.message.tool_calls?.map((call) => ({
        id: call.id,
        name: call.function.name,
        arguments: call.function.arguments,
      })) ?? [],
    });

    // 无工具调用 → 返回最终文本
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      let finalText = stripThinkTags(choice.message.content?.trim() ?? '');
      if (!finalText) {
        traceTurnEvent({ ...traceBase, type: 'child-task-empty-retry', round: round + 1 });
        msgBuf.push({
          role: 'user',
          content: '【系统】你的回复为空。请根据已完成的工作，给出最终结果摘要。',
        });
        const retry = await fetchChildCompletion(provider, msgBuf, undefined, signal);
        finalText = stripThinkTags(retry.choices[0]?.message.content?.trim() ?? '');
        if (!finalText) finalText = synthesizeToolHistorySummary(msgBuf) || '（任务结束但未生成结果）';
        if (!finalText) finalText = '（任务结束但未生成结果）';
      }
      console.log(
        `[AgentRunner] "${task.title}" 第 ${round + 1} 轮结束（无工具调用，返回最终结果）\n` +
        `  结果预览: ${finalText.slice(0, 100)}${finalText.length > 100 ? '…' : ''}`,
      );
      if (lastMinecraftAction) {
        throw new Error(
          `Minecraft 子任务未确认完成（最后动作状态：${lastMinecraftAction.status}）。`
          + `最终摘要：${finalText}。工具结果：${extractToolResultSummary(lastMinecraftAction.result)}`,
        );
      }
      traceTurnEvent({ ...traceBase, type: 'child-task-completed', round: round + 1, result: finalText });
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

    const taskContext = {
      conversationId: `task-${task.id}`,
      parentConversationId: task.conversation_id ?? undefined,
      executor: 'child' as const,
      taskId: task.id,
      signal,
    };
    const calls = choice.message.tool_calls.map((tc) => ({
      id: tc.id,
      name: tc.function.name,
      arguments: tc.function.arguments,
    }));
    const batchResults = await toolRegistry.executeBatch(calls, taskContext, {
      queued: ({ call, args, claims }) => traceTurnEvent({
        ...traceBase,
        type: 'child-tool-queued',
        round: round + 1,
        toolCallId: call.id,
        tool: call.name,
        args,
        claims,
      }),
      started: ({ call, args, claims, queueWaitMs }) => traceTurnEvent({
        ...traceBase,
        type: 'child-tool-started',
        round: round + 1,
        toolCallId: call.id,
        tool: call.name,
        args,
        claims,
        queueWaitMs,
      }),
      completed: ({ call, args, claims, queueWaitMs, durationMs, result }) => traceTurnEvent({
        ...traceBase,
        type: 'child-tool-completed',
        round: round + 1,
        toolCallId: call.id,
        tool: call.name,
        args,
        claims,
        queueWaitMs,
        durationMs,
        result: isToolImageResult(result) ? result.text : String(result),
      }),
    });
    const toolCallsById = new Map(choice.message.tool_calls.map((tc) => [tc.id, tc]));
    const execResults = batchResults.map(({ call, result }) => ({
      tc: toolCallsById.get(call.id)!,
      result,
    }));

    // 回填结果，同时打印摘要
    for (const { tc, result } of execResults) {
      const resultPreview = typeof result === 'object' && result !== null
        ? JSON.stringify(result).slice(0, 120)
        : String(result).slice(0, 120);
      console.log(`[AgentRunner] "${task.title}" 工具返回 ${tc.function.name}: ${resultPreview}${resultPreview.length >= 120 ? '…' : ''}`);
      if (taskUsesToolset(task, 'minecraft') && tc.function.name === 'minecraft_action') {
        const text = isToolImageResult(result) ? result.text : String(result);
        const status = structuredToolStatus(text);
        lastMinecraftAction = status === 'failed' || status === 'partial' || status === 'cancelled'
          ? { status, result: text }
          : undefined;
      }
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
    const fallback = await fetchChildCompletion(provider, msgBuf, undefined, signal);
    const summary = stripThinkTags(fallback.choices[0]?.message.content?.trim() ?? '')
      || '未能生成最终总结';
    throw new Error(`子任务达到最大轮数 ${maxRounds}，未确认完成。最后总结：${summary}`);
  } catch (error) {
    if (error instanceof Error && error.message.includes(`最大轮数 ${maxRounds}`)) throw error;
    throw new Error(
      `子任务达到最大轮数 ${maxRounds}，未确认完成；生成最后总结时失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function structuredToolStatus(result: string): string | undefined {
  return result.match(/^【工具结果】\s*\r?\n状态[：:]\s*([^\s]+)/)?.[1]?.toLowerCase();
}

function taskUsesToolset(task: DBTask, name: string): boolean {
  if (!task.metadata) return false;
  try {
    const metadata = JSON.parse(task.metadata);
    return Array.isArray(metadata.toolsets) && metadata.toolsets.includes(name);
  } catch {
    return false;
  }
}
