/// <reference types="node" />
import aiConfig, { LLMProviderConfig } from './ai.config';
import { addMessage, getRecentContext, getMessages, renameConversation } from './db';
import { toolRegistry } from './tools/index';
import { getCurrentToolsets, getAgentMode } from './agentMode';
import type { ChatMessage, ContentPart, ToolSchema } from './tools/types';
import { isToolImageResult } from './tools/types';
import { memoryManager, globalMemoryManager, recordMessageActivity } from './memory/index';
import { stripThinkTags } from './utils/textUtils';
import { fetchCompletion } from './llmClient';
import { getSkillTopicsForPrompt } from './tools/impl/skill';
import { buildChatPrompt } from './prompts/chat';
import { buildAgentPrompt } from './prompts/agent';
import { buildDeveloperPrompt } from './prompts/developer';
import { buildStreamerPrompt } from './prompts/streamer';
import { browserSession } from './tools/impl/browserSession';

// ── 工具调用调试事件 ─────────────────────────────────────
/** 单次工具调用的调试记录（推送给渲染层展示） */
export interface ToolCallEvent {
  /** 工具名，如 browser_click_smart */
  name: string;
  /** 解析后的参数对象 */
  args: Record<string, unknown>;
  /** 执行结果文字（截取前 300 字） */
  result: string;
  /** true = ✅ 成功；false = ❌ 失败 / ⏸️ 暂停 */
  ok: boolean;
  /** 执行耗时（毫秒） */
  durationMs: number;
  /** 工具调用来源对话ID（用于区分跨对话工具调用） */
  conversationId?: string;
}

let _toolEventListener: ((ev: ToolCallEvent) => void) | null = null;

/** 由 main.ts 调用，注册工具调用调试事件回调（传 null 取消） */
export function setToolEventListener(cb: ((ev: ToolCallEvent) => void) | null): void {
  _toolEventListener = cb;
}

// ── AI 中断控制 ─────────────────────────────────────
let currentAbortController: AbortController | null = null;

/** 由 main.ts 调用，中断当前正在进行的 AI 请求 */
export function stopCurrentAI(): void {
  if (currentAbortController) {
    console.log('[AI Service] 用户请求中断 AI');
    currentAbortController.abort();
    currentAbortController = null;
  }
}

/** 内部：执行工具并同时发射调试事件 */
async function execAndEmit(name: string, argsJson: string, conversationId?: string) {
  const t0 = Date.now();
  const context = conversationId ? { conversationId } : undefined;
  const result = await toolRegistry.execute(name, argsJson, context);
  const durationMs = Date.now() - t0;
  if (_toolEventListener) {
    const resultText = isToolImageResult(result) ? result.text : String(result);
    let parsedArgs: Record<string, unknown> = {};
    try { parsedArgs = JSON.parse(argsJson); } catch { /* ignore */ }
    _toolEventListener({
      name,
      args: parsedArgs,
      result: resultText.slice(0, 300),
      ok: !resultText.startsWith('❌') && !resultText.startsWith('[工具错误]'),
      durationMs,
      conversationId,  // 🆕 传递对话ID，用于区分工具调用来源
    });
  }
  return result;
}

function getLatestRealUserText(messages: ChatMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'user') continue;
    if (typeof m.content !== 'string') continue;
    const txt = m.content.trim();
    // 跳过内部注入提示
    if (txt.startsWith('【系统】') || txt.startsWith('【系统提示】')) continue;
    return txt;
  }
  return '';
}

/** 除 browser_ 前缀工具外，还有少数直接使用 browserSession 的工具 */
const BROWSER_SESSION_TOOLS = new Set(['watch_bilibili_video']);

function hasBrowserTools(toolSchemas?: ToolSchema[]): boolean {
  if (!toolSchemas?.length) return false;
  return toolSchemas.some((t) =>
    t.function.name.startsWith('browser_') || BROWSER_SESSION_TOOLS.has(t.function.name)
  );
}

function isLikelyBrowseIntent(userText: string): boolean {
  const t = userText.toLowerCase();
  if (!t) return false;
  return /(打开|进入|访问|去|导航|网页|网站|页面|链接|网址|url|浏览器|搜索|查找|点击|查看|看看|点开|执行)/i.test(t);
}

function isLikelyToolFreeBrowserHallucination(replyText: string): boolean {
  const t = replyText.toLowerCase();
  return /(已打开|已经打开|已进入|已经进入|我已到达|已访问|当前页面|我在该网站|已跳转|我已搜索|搜索完成|正在打开|正在点击|马上去|马上打开|马上进入|已找到)/i.test(t);
}

function isLikelyProgressOnlyText(replyText: string): boolean {
  const t = replyText.toLowerCase();
  return /(正在|马上|立刻|这就|等一会|稍等|马上去|马上打开|正在打开|正在点击)/i.test(t);
}

function isLikelyDomParseIntent(userText: string): boolean {
  const t = userText.toLowerCase();
  if (!t) return false;
  return /(解析|html|a元素|标签|outerhtml|源码|原封不动|元素代码|dom)/i.test(t);
}

function isLikelyCannotParseExcuse(replyText: string): boolean {
  const t = replyText.toLowerCase();
  return /(无法|不能|不支持|没有.*功能|没办法|无法直接解析|不能解析html|看不了源码)/i.test(t);
}

/**
 * 检测消息来源平台（基于平台标签）
 *
 * 介绍：Discord/WeChat Adapter 会在转发消息时注入平台标签：
 *   - Discord：`[来源：Discord | 频道：xxx | 用户：xxx]`
 *   - WeChat：`[来源：WeChat | 用户：xxx]`
 *   - Lark / Feishu：`[来源：Lark / Feishu | 聊天：xxx | 用户：xxx]`
 *
 * 当检测到平台标签时，会自动注入对应平台的附件工具。
 * 普通文字回复由通知路由自动投递，不作为 LLM 工具暴露。
 *   - Discord → `discord_send_file`
 *   - WeChat → `wechat_send_file`
 *   - Lark / Feishu → `feishu_send_file`
 *
 * @returns 平台名（'discord' | 'wechat' | 'feishu'）或 null
 */
export function detectPlatform(userContent: string): string | null {
  if (userContent.includes('[来源：Discord')) return 'discord';
  if (userContent.includes('[来源：WeChat')) return 'wechat';
  if (userContent.includes('[来源：Lark / Feishu')) return 'feishu';
  return null;
}

// ── 工具调用循环 ──────────────────────────────────────────

/**
 * 调用 LLM 并自动处理工具调用循环。
 *
 * - 若 toolRegistry 为空，直接发起单次请求
 * - 若 LLM 返回 finish_reason === 'tool_calls'，并行执行所有工具，
 *   将结果以 `tool` 角色回填，再次请求，直到得到最终回复
 * - 设有最大循环轮数保护，防止意外死循环
 */
async function callWithToolLoop(
  provider: LLMProviderConfig,
  messages: ChatMessage[],
  toolSchemas?: ToolSchema[],
  conversationId?: string,
): Promise<string> {
  // 🆕 创建 AbortController 用于中断请求
  currentAbortController = new AbortController();
  const signal = currentAbortController.signal;

  try {
    return await _callWithToolLoopInternal(provider, messages, toolSchemas, conversationId, signal);
  } catch (e) {
    if ((e as Error).name === 'AbortError' || signal.aborted) {
      throw new Error('AI 回答已被用户中断');
    }
    throw e;
  } finally {
    currentAbortController = null;
  }
}

async function _callWithToolLoopInternal(
  provider: LLMProviderConfig,
  messages: ChatMessage[],
  toolSchemas?: ToolSchema[],
  conversationId?: string,
  signal?: AbortSignal
): Promise<string> {
  const withTools = !!toolSchemas?.length;
  // 在副本上操作，不污染调用方的数组
  const msgBuf: ChatMessage[] = [...messages];
  let antiHallucinationNudgeUsed = false;

  // 模式感知的最大循环轮数：chat 轻量 / agent 标准 / developer 深度
  const currentMode = getAgentMode();
  const MAX_ROUNDS = ({ chat: 10, agent: 25, 'agent-debug': 25, developer: 200, streamer: 25 } as Record<string, number>)[currentMode] ?? 25;
  
  for (let round = 0; round < MAX_ROUNDS; round++) {
    // 🆕 检查中断信号
    if (signal?.aborted) {
      throw new Error('AI 回答已被用户中断');
    }

    const data = await fetchCompletion(provider, msgBuf, withTools ? toolSchemas : undefined, signal);
    const choice = data.choices[0];

    // ── 无工具调用 → 返回最终文本 ──
    if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
      const finalText = stripThinkTags(choice.message.content?.trim() ?? '');
      // 防浏览器幻觉：用户要求访问/操作网站，但模型未调用工具却给出“已完成/进行中”口头回复。
      if (!antiHallucinationNudgeUsed && withTools && hasBrowserTools(toolSchemas)) {
        const latestUser = getLatestRealUserText(msgBuf);
        const needToolAction = isLikelyBrowseIntent(latestUser);
        const fakeDone = isLikelyToolFreeBrowserHallucination(finalText) || isLikelyProgressOnlyText(finalText);
        if (needToolAction && fakeDone) {
          antiHallucinationNudgeUsed = true;
          msgBuf.push({
            role: 'assistant',
            content: choice.message.content ?? finalText,
          });
          msgBuf.push({
            role: 'user',
            content:
              '【系统提示】用户请求涉及浏览器真实状态。请先用可用的浏览器工具获取事实，再回答用户；' +
              '如果无法继续或缺少信息，请向用户说明需要什么。不要口头声称页面已经打开、点击或搜索完成。',
          });
          continue;
        }

        const needDomParse = isLikelyDomParseIntent(latestUser);
        const giveExcuse = isLikelyCannotParseExcuse(finalText);
        if (needDomParse && giveExcuse) {
          antiHallucinationNudgeUsed = true;
          msgBuf.push({
            role: 'assistant',
            content: choice.message.content ?? finalText,
          });
          msgBuf.push({
            role: 'user',
            content:
              '【系统提示】用户请求涉及 DOM/HTML 原文。请优先使用可用的页面读取或元素工具获取真实内容；' +
              '如果当前工具确实不足，请说明限制并询问用户是否接受替代方案。',
          });
          continue;
        }
      }

      return finalText;
    }

    // ── 有工具调用 → 追加 assistant 消息 ──
    msgBuf.push({
      role: 'assistant',
      content: choice.message.content,
      tool_calls: choice.message.tool_calls,
    });

    // ── 并行执行本轮所有工具 ──
    const execResults = await Promise.all(
      choice.message.tool_calls.map(async (tc) => ({
        tc,
        result: await execAndEmit(tc.function.name, tc.function.arguments, conversationId),
      }))
    );

    // ── 回填结果：普通文本 → tool 消息；图像 → tool 消息 + user 多模态消息 ──
    for (const { tc, result } of execResults) {
      if (isToolImageResult(result)) {
        // 1. tool 消息（文字描述，让模型知道工具已执行）
        msgBuf.push({ role: 'tool', tool_call_id: tc.id, content: result.text });
        // 2. user 多模态消息（注入图像，让视觉模型能"看到"截图）
        const imageParts: ContentPart[] = [
          { type: 'text', text: '（以下是截取的屏幕截图，请结合图像内容回答用户的问题）' },
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
        // 普通文本结果
        msgBuf.push({ role: 'tool', tool_call_id: tc.id, content: result });
      }
    }
    // 每轮工具结果回填后注入统一提示。
    // 这里不强制继续；工具结果要求询问/回复时，模型应停止工具循环并面向用户回答。
    const hasToolContinuation = execResults.some(({ result }) => {
      const text = isToolImageResult(result) ? result.text : String(result);
      return text.startsWith('🔄');
    });

    // run_command 失败：给出基于错误事实的下一步判断，不强制跳转到知识库。
    const hasCommandFailure = execResults.some(({ tc, result }) => {
      if (tc.function.name !== 'run_command') return false;
      const text = isToolImageResult(result) ? result.text : String(result);
      return text.startsWith('❌');
    });

    if (hasToolContinuation) {
      msgBuf.push({
        role: 'user',
        content:
          '【工具结果处理】上面的工具给出了“建议下一步”。请先判断是否信息充足、是否仍符合用户目标：' +
          '若需要用户选择或确认，就询问用户并结束本轮；若已经可以回答，就回复用户；只有确实应继续执行时，才调用下一步工具。',
      });
    } else if (hasCommandFailure) {
      msgBuf.push({
        role: 'user',
        content:
          '【工具结果处理】run_command 执行失败。请基于错误信息判断下一步：' +
          '能修正且仍符合用户目标时再重试；需要更多信息时询问用户；无法继续时如实说明失败原因。' +
          '不要编造命令已成功。',
      });
    } else {
      msgBuf.push({
        role: 'user',
        content:
          '【工具结果处理】根据以上工具结果选择下一步：' +
          '工具结果要求“回复用户”时，回复用户并结束本轮；要求“询问用户”时，提出问题并等待；' +
          '只有工具结果或用户目标明确需要继续操作时，才继续调用工具。不要重复已完成的同一工具调用。',
      });
    }
    // 继续循环，带上工具结果再请求
  }

  // 超出轮数：追加系统提示，让 AI 用自然语言总结失败原因并回复用户
  msgBuf.push({
    role: 'user',
    content:
      '【系统提示】你已经连续调用了 ' + MAX_ROUNDS + ' 轮工具，操作仍未完成。' +
      '请停止继续调用工具，用自然语言向用户总结：① 你尝试了哪些步骤，② 哪一步卡住了，③ 可能的原因是什么。',
  });
  try {
    const fallback = await fetchCompletion(provider, msgBuf); // 不带工具，强制输出文字
    return stripThinkTags(fallback.choices[0]?.message.content?.trim() ?? '（操作超出轮数，且无法生成总结）');
  } catch {
    return `（操作未完成：工具调用超过 ${MAX_ROUNDS} 轮，请检查页面状态后重试）`;
  }
}

// ── 主接口 ────────────────────────────────────────────────

/**
 * 发送消息并返回 AI 回复。
 * - 自动保存 user / assistant 消息至 SQLite
 * - 维护 contextWindowRounds 轮短期记忆
 * - 若 toolRegistry 注册了工具，自动启用 Function Calling 并处理多轮工具循环
 * - 第一轮对话自动以用户首句命名对话
 */
export async function sendChatMessage(
  conversationId: string,
  userContent: string
): Promise<{ content: string; created_at: number }> {
  const provider = aiConfig.providers[aiConfig.activeProvider];
  if (!provider) throw new Error(`未找到 provider: ${aiConfig.activeProvider}`);

  // 1. 保存用户消息
  addMessage({ conversation_id: conversationId, role: 'user', content: userContent });

  // 2. 构建上下文（含刚保存的 user 消息）
  const context = getRecentContext(conversationId, aiConfig.contextWindowRounds);

  // ── 模式感知的上下文工程 ─────────────────────────────────────
  // 提示词、记忆、Skills 按模式精细化注入，节省 token 但不缺功能
  const currentAgentMode = getAgentMode();

  // 提示词：三档人格（chat=桌宠 / agent=助手 / developer=工程师）
  const basePrompt = (() => {
    switch (currentAgentMode) {
      case 'chat':      return buildChatPrompt();
      case 'developer': return buildDeveloperPrompt();
      case 'streamer':  return buildStreamerPrompt();
      default:          return buildAgentPrompt(); // agent, agent-debug
    }
  })();

  // Skills 目录：chat 无 read_skill 工具，不注入
  const skillTopics = currentAgentMode === 'chat' ? '' : getSkillTopicsForPrompt();

  // 记忆：chat 仅注入用户画像，agent/developer 注入完整记忆（含环境配置）
  const memoryAppend = memoryManager.buildMemoryAppend(conversationId) + (
    currentAgentMode === 'chat'
      ? globalMemoryManager.buildUserProfileOnly()
      : globalMemoryManager.buildGlobalMemoryAppend()
  );

  const systemContent = basePrompt + skillTopics + memoryAppend;

  const messages: ChatMessage[] = [
    ...(systemContent ? [{ role: 'system' as const, content: systemContent }] : []),
    ...context.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content })),
  ];

  // 3. 调用 AI（含工具调用循环）
  let replyContent: string;
  try {
    // ReAct 模式：工具调用循环，走一步看一步
    // Toolset 系统（借鉴 hermes-agent）：使用全局 Agent 模式（chat/agent/agent-debug）
    const enabledToolsets = getCurrentToolsets();  // ['chat'] 或 ['agent']

    // 🆕 平台检测：根据消息来源动态注入平台附件工具
    // 例：[来源：Discord | ...] → 自动添加 discord_send_file
    const platform = detectPlatform(userContent);
    if (platform) {
      enabledToolsets.push(platform);  // ['chat', 'discord']
      console.log(`[平台检测] 检测到 ${platform} 来源，已注入平台工具`);
    }

    const tools = toolRegistry.isEmpty ? undefined : toolRegistry.getSchemasForToolset(enabledToolsets);

    // streamer 模式下：若本轮对话包含浏览器工具，需占用浏览器互斥锁，
    // 防止与 funded_request 工具循环（processFundedRequest）同时操控同一 Playwright page。
    // 普通模式/无浏览器工具时无需加锁，零开销。
    const needBrowserLock = currentAgentMode === 'streamer' && hasBrowserTools(tools);
    const releaseBrowserLock = needBrowserLock
      ? await browserSession.mutex.acquire('chat')
      : null;
    try {
      replyContent = await callWithToolLoop(provider, messages, tools, conversationId);
    } finally {
      releaseBrowserLock?.();
    }
  } catch (e) {
    replyContent = `（请求失败：${(e as Error).message}）`;
  }

  // 4. 保存 AI 最终回复
  const saved = addMessage({
    conversation_id: conversationId,
    role: 'assistant',
    content: replyContent,
  });

  // 记录消息活跃时间（供空闲调度器判断何时触发后台总结，不再在热路径调用 LLM）
  recordMessageActivity();

  // streamer 模式：主播在聊天界面发送消息，AI 回复同样要经过 TTS 播报给直播间
  // 原则：AI 生成文字后自动送 TTS，不需要 AI 主动调用 speak 工具
  // 动态 import 避免 aiService ↔ streamerController ↔ main 静态循环依赖
  if (currentAgentMode === 'streamer' && replyContent.trim() && !replyContent.startsWith('（请求失败：')) {
    void import('./streaming/streamerController').then(({ streamerController }) => {
      void streamerController.speak(replyContent);
    });
  }

  // 6. 首轮对话自动用用户首句命名
  const allUserMsgs = getMessages(conversationId).filter((m) => m.role === 'user');
  if (allUserMsgs.length === 1) {
    const title = userContent.length > 18 ? userContent.slice(0, 18) + '…' : userContent;
    renameConversation(conversationId, title);
  }

  return { content: replyContent, created_at: saved.created_at };
}
