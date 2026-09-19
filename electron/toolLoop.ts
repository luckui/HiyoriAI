/**
 * ReAct 工具循环：请求模型 → 模型调用工具 → 回填结果 → 再请求，直到模型给出最终回答。
 *
 * 主对话（aiService）、后台子任务（agentRunner）、直播付费点播（streamerController）
 * 共用这一份循环骨架；各自不同的地方通过钩子注入：
 *   - complete   怎么请求模型（超时、截断重试等）
 *   - runTools   怎么执行一轮的工具调用（并行/串行、守卫、追踪）
 *   - onFinal    模型不再调用工具时怎么收尾（纠偏重试、结果校验）
 *   - afterTools 工具结果回填后要不要追加提示
 *   - onRoundLimit 轮数用尽时怎么兜底
 */

import type { ChatCompletionResponse } from './llmClient';
import { isToolImageResult, type ChatMessage, type ContentPart, type ToolCall, type ToolImageResult, type ToolSchema } from './tools/types';
import { stripThinkTags } from './utils/textUtils';

export type ToolLoopChoice = ChatCompletionResponse['choices'][number];

export interface ToolCallOutcome {
  call: ToolCall;
  result: string | ToolImageResult;
}

export interface ToolRoundInfo {
  /** 从 0 开始的轮次 */
  round: number;
  /** 模型在发起工具调用时附带的文字（可能为空） */
  assistantText: string;
}

export interface ToolLoopOptions {
  /** 对话缓冲区；循环会原地追加 assistant / tool / user 消息 */
  messages: ChatMessage[];
  tools?: ToolSchema[];
  maxRounds: number;
  signal?: AbortSignal;
  /** 中断时抛出的错误信息 */
  abortMessage?: string;
  /**
   * 截图等图像结果的处理：给出说明文字时，追加一条带图片的 user 消息让视觉模型看到截图；
   * 不给时只回填文字说明。
   */
  imageCaption?: string;

  complete(messages: ChatMessage[], tools: ToolSchema[] | undefined, signal?: AbortSignal): Promise<ChatCompletionResponse>;
  runTools(calls: ToolCall[], info: ToolRoundInfo): Promise<ToolCallOutcome[]>;
  /**
   * 模型没有调用工具时调用，text 已去掉思考标签。
   * 返回字符串 = 最终结果；返回 undefined = 已向 messages 追加纠偏提示，继续下一轮。
   */
  onFinal(text: string, choice: ToolLoopChoice, round: number): string | undefined | Promise<string | undefined>;
  onRoundLimit(): string | Promise<string>;

  beforeRound?(round: number): void;
  onResponse?(choice: ToolLoopChoice, round: number): void;
  afterTools?(outcomes: ToolCallOutcome[], round: number): void;
}

export function toolResultText(result: string | ToolImageResult): string {
  return isToolImageResult(result) ? result.text : String(result);
}

export async function runToolLoop(options: ToolLoopOptions): Promise<string> {
  const { messages, maxRounds, signal } = options;
  const tools = options.tools?.length ? options.tools : undefined;

  for (let round = 0; round < maxRounds; round++) {
    if (signal?.aborted) throw new Error(options.abortMessage ?? '已中断');
    options.beforeRound?.(round);

    const response = await options.complete(messages, tools, signal);
    const choice = response.choices[0];
    options.onResponse?.(choice, round);

    const calls = choice.message.tool_calls;
    if (choice.finish_reason !== 'tool_calls' || !calls?.length) {
      const final = await options.onFinal(stripThinkTags(choice.message.content?.trim() ?? ''), choice, round);
      if (final !== undefined) return final;
      continue;
    }

    messages.push({ role: 'assistant', content: choice.message.content, tool_calls: calls });
    const outcomes = await options.runTools(calls, {
      round,
      assistantText: stripThinkTags(choice.message.content?.trim() ?? ''),
    });
    appendToolResults(messages, outcomes, options.imageCaption);
    options.afterTools?.(outcomes, round);
  }

  return options.onRoundLimit();
}

function appendToolResults(messages: ChatMessage[], outcomes: ToolCallOutcome[], imageCaption?: string): void {
  const images: ContentPart[] = [];
  for (const { call, result } of outcomes) {
    messages.push({ role: 'tool', tool_call_id: call.id, content: toolResultText(result) });
    if (imageCaption && isToolImageResult(result) && result.imageBase64) {
      images.push({
        type: 'image_url',
        image_url: { url: `data:${result.mimeType};base64,${result.imageBase64}`, detail: 'low' },
      });
    }
  }
  // tool 消息必须紧跟在 assistant 的 tool_calls 之后，图片只能在所有 tool 消息之后以 user 消息补充
  if (images.length) messages.push({ role: 'user', content: [{ type: 'text', text: imageCaption! }, ...images] });
}
