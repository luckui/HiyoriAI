/**
 * Streamer 主控循环
 * 协调 streamerSession、TTS、Live2D 的自动化工作流
 * 
 * 职责：
 * 1. 定期检查弹幕池（优先队列 + 普通弹幕）
 * 2. 自动生成回复（调用 AI）
 * 3. 自动触发 TTS 朗读
 * 4. 自动控制 Live2D 情绪/动作
 * 5. 主动开口（距上次发言 > threshold 且无待处理弹幕）
 */

import { EventEmitter } from 'events';
import { streamerSession } from './streamerSession';
import type { StreamerReply } from './types';
import { playTTSAudio } from '../main';
import { sendLive2DCommand } from '../live2dBridge';
import aiConfig from '../ai.config';
import { fetchCompletion } from '../llmClient';
import { giftCreditLedger } from './giftCreditLedger';
import { toolRegistry } from '../tools/index';
import { resolveToolset } from '../toolsets';
import { browserSession } from '../tools/impl/browserSession';
import { FUNDED_ALLOWED_TOOLS, checkToolCall } from './streamerGuard';
import { isToolImageResult, type ChatMessage, type ToolSchema } from '../tools/types';
import {
  SESSION_SYSTEM_PROMPT,
  FUNDED_EXECUTOR_SYSTEM_PROMPT,
  TOOL_LOOP_CONTINUE,
  fundedAckFallback,
  fundedErrorText,
  proactiveUserPrompt,
} from './streamerPrompts';

export interface StreamerControllerConfig {
  /** 主动开口阈值（毫秒），默认 5 分钟 */
  idleThresholdMs?: number;
  /** 检查间隔（毫秒），默认 3 秒 */
  checkIntervalMs?: number;
  /** 是否自动朗读回复（默认 true） */
  autoTTS?: boolean;
  /** 是否自动控制 Live2D（默认 true） */
  autoLive2D?: boolean;
}

/** 从 .env 读取数值，解析失败则用 fallback */
function envInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  const n = parseInt(v, 10);
  return isNaN(n) ? fallback : n;
}

/** 从 .env 读取布尔值（'false'/'0' → false，其余非空 → true） */
function envBool(key: string, fallback: boolean): boolean {
  const v = process.env[key];
  if (v === undefined || v === '') return fallback;
  return v !== 'false' && v !== '0';
}

class StreamerControllerManager extends EventEmitter {
  private running = false;
  private timer: NodeJS.Timeout | null = null;
  private lastSpeakAt = 0;
  private ticking = false; // 防止普通 tick 并发

  /** funded_request 专属逐次执行队列，独立于主 tick 循环 */
  private fundedQueue: StreamerReply[] = [];
  private fundedRunning = false; // 是否有 funded 任务正在执行
  private config: Required<StreamerControllerConfig> = {
    idleThresholdMs: envInt('STREAMER_IDLE_THRESHOLD_MS', 300_000),
    checkIntervalMs: envInt('STREAMER_CHECK_INTERVAL_MS', 3_000),
    autoTTS:         envBool('STREAMER_AUTO_TTS', true),
    autoLive2D:      envBool('STREAMER_AUTO_LIVE2D', true),
  };

  /**
   * 启动主控循环
   */
  start(config?: StreamerControllerConfig): void {
    if (this.running) {
      console.warn('[StreamerController] Already running');
      return;
    }

    this.config = {
      ...this.config,
      ...config,
    };

    this.running = true;
    this.lastSpeakAt = Date.now();

    console.log('[StreamerController] Started with config:', this.config);

    this.timer = setInterval(() => {
      void this.tick();
    }, this.config.checkIntervalMs);
  }

  /**
   * 停止主控循环
   */
  stop(): void {
    if (!this.running) return;

    this.running = false;

    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    // 清空待执行的 funded 任务队列（已在运行的任务会自然完成）
    if (this.fundedQueue.length > 0) {
      console.log(`[StreamerController] Discarding ${this.fundedQueue.length} pending funded tasks on stop`);
      this.fundedQueue = [];
    }

    console.log('[StreamerController] Stopped');
  }

  /**
   * 获取运行状态
   */
  getStatus() {
    return {
      running: this.running,
      lastSpeakAt: this.lastSpeakAt,
      idleDurationMs: Date.now() - this.lastSpeakAt,
      fundedTaskRunning: this.fundedRunning,
      fundedTaskQueueSize: this.fundedQueue.length,
      config: this.config,
    };
  }

  /**
   * 运行时更新主控配置（不需要重启）
   * - idleThresholdMs: 暖场阈值，改小让 AI 更积极开口，改大让 AI 更安静
   * - autoTTS: 是否自动 TTS 朗读回复
   * - autoLive2D: 是否自动控制 Live2D
   * checkIntervalMs 不支持热更新（需要重启计时器），忽略该字段
   */
  updateConfig(patch: Omit<Partial<StreamerControllerConfig>, 'checkIntervalMs'>): void {
    const before = { ...this.config };
    this.config = { ...this.config, ...patch };
    console.log('[StreamerController] Config updated:', { before, after: this.config });
  }

  /**
   * 公共 TTS 接口：供主播对话路径直接将 AI 回复送去朗读。
   * - 只有 running=true 且 autoTTS=true 时才实际播放，其余情况静默忽略
   * - 重置 lastSpeakAt，避免论论和暗场在 TTS 刷新后立即重复触发
   */
  async speak(text: string): Promise<void> {
    if (!this.running || !this.config.autoTTS || !text.trim()) return;
    this.lastSpeakAt = Date.now();
    await this.speakText(text);
  }

  /**
   * 主循环 tick
   */
  private async tick(): Promise<void> {
    if (!this.running) return;
    if (this.ticking) return; // 上一次 tick 还没完成，跳过

    this.ticking = true;
    try {
      const status = streamerSession.status();
      if (!status.running) return;

      // 1. 检查是否有待处理的弹幕/礼物
      const hasPending = status.queue.pendingDanmu > 0 || status.queue.pendingPriority > 0;

      if (hasPending) {
        // 有弹幕：生成并朗读回复
        await this.processReply();
      } else {
        // 无弹幕：检查是否需要主动开口
        await this.checkProactiveSpeak();
      }
    } finally {
      this.ticking = false;
    }
  }

  /**
   * 处理一条回复（生成 + TTS + Live2D）
   */
  private async processReply(): Promise<void> {
    try {
      console.log('[StreamerController] Processing reply from queue...');
      const reply = await streamerSession.flushOnce();
      if (!reply) {
        console.log('[StreamerController] No reply generated (queue might be empty)');
        return;
      }

      console.log(`[StreamerController] Generated reply (kind=${reply.kind}): ${reply.reply?.slice(0, 80) || '(empty)'}`);

      // 更新发言时间
      this.lastSpeakAt = Date.now();

      // funded_request：放入专属逐次队列，不阻塞主 tick（让普通弹幕继续得到回复）
      if (reply.kind === 'funded_request' && reply.fundedBy) {
        this.enqueueFundedTask(reply);
        return;
      }

      // 普通路径：TTS 朗读 + Live2D
      if (this.config.autoTTS && reply.reply) {
        console.log(`[StreamerController] Speaking via TTS: ${reply.reply.slice(0, 50)}...`);
        await this.speakText(reply.reply);
      } else if (!reply.reply) {
        console.warn('[StreamerController] Reply text is empty, skipping TTS');
      }

      if (this.config.autoLive2D) {
        this.controlLive2D(reply);
      }

      this.emit('reply', reply);
    } catch (err) {
      console.error('[StreamerController] Process reply error:', err);
    }
  }

  /**
   * 将 funded_request 放入逐次执行队列，并启动 drain（若尚未运行）
   * 队列是 FIFO，保证送礼物的观众按先后顺序得到响应，互不打断
   */
  private enqueueFundedTask(reply: StreamerReply): void {
    this.fundedQueue.push(reply);
    console.log(`[StreamerController] Funded task enqueued (queue size: ${this.fundedQueue.length})`);
    if (!this.fundedRunning) {
      void this.drainFundedQueue();
    }
  }

  /**
   * 逐次消费 fundedQueue：一个任务完成后才取下一个，保证顺序且不互相打断
   * 独立于主 tick，不持有 ticking 锁，普通弹幕和 proactive 可正常执行
   */
  private async drainFundedQueue(): Promise<void> {
    if (this.fundedRunning) return;
    this.fundedRunning = true;
    try {
      while (this.fundedQueue.length > 0) {
        const task = this.fundedQueue.shift()!;
        console.log(`[StreamerController] Funded queue: starting task, ${this.fundedQueue.length} remaining after this`);
        await this.processFundedRequest(task);
      }
    } finally {
      this.fundedRunning = false;
    }
  }

  /**
   * 处理礼物信用驱动的请求：启动工具调用循环，执行完后 TTS 播报结果，消费信用
   */
  private async processFundedRequest(reply: StreamerReply): Promise<void> {
    const { fundedBy } = reply;
    if (!fundedBy) return;

    console.log(`[StreamerController] funded_request from ${fundedBy.uname}: "${reply.prompt.slice(0, 80)}..."`);

    // 注意：不预先播报任何内容，等模型真正调用工具后才说确认语（避免幻觉承诺）

    let executedAnyTool = false; // 标记是否真正调用过工具，控制信用消费时机

    // 占用浏览器锁，防止与主播 chat 工具调用并发操控同一 Playwright page
    const releaseBrowser = await browserSession.mutex.acquire(`funded:${fundedBy.uid}`);
    try {
      // 从 streamer 工具集中筛选出白名单工具（streamerGuard.FUNDED_ALLOWED_TOOLS）
      // 双重约束：工具集已限制注册范围，白名单进一步锁死付费观众能触发的工具
      const registeredToolNames = new Set(resolveToolset('streamer'));
      const fundedToolNames = [...FUNDED_ALLOWED_TOOLS].filter(t => registeredToolNames.has(t));
      const toolSchemas: ToolSchema[] = toolRegistry.getSchemasByNames(fundedToolNames);

      const provider = aiConfig.providers[aiConfig.activeProvider];
      if (!provider) throw new Error('no active provider');

      const systemPrompt = FUNDED_EXECUTOR_SYSTEM_PROMPT;

      const msgBuf: ChatMessage[] = [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: reply.prompt },
      ];

      const MAX_ROUNDS = 8;
      let finalText = '';

      for (let round = 0; round < MAX_ROUNDS; round++) {
        const data = await fetchCompletion(provider, msgBuf, toolSchemas.length > 0 ? toolSchemas : undefined);
        const choice = data.choices[0];

        // 无工具调用 → 模型决定直接回复（普通聊天或最终播报）
        if (choice.finish_reason !== 'tool_calls' || !choice.message.tool_calls?.length) {
          finalText = choice.message.content?.trim() ?? '';
          break;
        }

        // ── 第一次工具调用：此刻才能诚实地说"我现在去做某事" ──
        if (!executedAnyTool) {
          executedAnyTool = true;
          // 模型在 content 字段里应已生成口语确认，如"好的，我去看这个视频！"
          // 有且长度合适则直接播出；否则用静态后备文案
          const modelAck = choice.message.content?.trim() ?? '';
          const ackText = modelAck.length > 0 && modelAck.length <= 60
            ? modelAck
            : fundedAckFallback(fundedBy.uname, choice.message.tool_calls[0].function.name);
          if (this.config.autoTTS) await this.speakText(ackText);
          // 确认真实调用工具后才消费信用，普通聊天不会走到这里
          giftCreditLedger.consume(fundedBy.uid);
          console.log(`[StreamerController] funded ack spoken: "${ackText}"`);
        }

        // 执行工具
        msgBuf.push({
          role: 'assistant',
          content: choice.message.content,
          tool_calls: choice.message.tool_calls,
        });

        for (const tc of choice.message.tool_calls) {
          // 程序层安全检查（白名单 + URL 参数验证），不依赖 AI 自律
          const currentPageUrl = browserSession.currentPage?.url();
          const guard = checkToolCall(tc.function.name, tc.function.arguments, currentPageUrl);
          if (!guard.safe) {
            const blocked = `[BLOCKED] ${guard.reason ?? '安全策略拒绝'}，无法执行此操作。`;
            msgBuf.push({ role: 'tool', tool_call_id: tc.id, content: blocked });
            console.warn(`[StreamerController] funded tool blocked: ${tc.function.name} — ${guard.reason}`);
            continue;
          }
          const taskCtx = { conversationId: `funded-${fundedBy.uid}-${Date.now()}` };
          const result = await toolRegistry.execute(tc.function.name, tc.function.arguments, taskCtx);
          // 截图等图像结果只回填文字说明，避免把整段 base64 塞进上下文
          const textResult = isToolImageResult(result) ? result.text : String(result);
          msgBuf.push({ role: 'tool', tool_call_id: tc.id, content: textResult });
          console.log(`[StreamerController] funded tool: ${tc.function.name} → ${textResult.slice(0, 80)}`);
        }

        msgBuf.push({ role: 'user', content: TOOL_LOOP_CONTINUE });
      }

      // 普通聊天分支（模型没有调用任何工具）
      if (!executedAnyTool) {
        // 信用保留，不消费（等下次真实请求再用）
        console.log(`[StreamerController] funded_request treated as casual chat, credit preserved`);
        if (this.config.autoTTS && finalText) await this.speakText(finalText);
        reply.reply = finalText;
        reply.kind = 'danmu_single'; // 降级，前端无需展示为任务
        this.emit('reply', reply);
        return;
      }

      // 播报执行结果
      if (finalText && this.config.autoTTS) {
        await this.speakText(finalText);
      }

      if (this.config.autoLive2D) {
        sendLive2DCommand({ type: 'emotion', emotion: 'happy', playMotion: true });
      }

      reply.reply = finalText;
      this.emit('reply', reply);

    } catch (err) {
      console.error('[StreamerController] funded_request error:', err);
      // 只有已经调用过工具（信用已消费）才播出错误提示
      if (executedAnyTool && this.config.autoTTS) {
        await this.speakText(fundedErrorText(fundedBy.uname));
      }
      // 未执行任何工具就出错（网络问题等），保留信用让观众可以重试
      if (!executedAnyTool) {
        console.warn(`[StreamerController] funded_request failed before tool execution, credit preserved for ${fundedBy.uid}`);
      }
    } finally {
      releaseBrowser(); // 必须在 finally 里释放，确保异常时也不死锁
    }
  }

  /** 工具调用确认语后备文案 — 统一由 streamerPrompts.fundedAckFallback 管理 */

  /**
   * 检查是否需要主动开口
   */
  private async checkProactiveSpeak(): Promise<void> {
    const idleDuration = Date.now() - this.lastSpeakAt;
    if (idleDuration < this.config.idleThresholdMs) return;

    try {
      console.log(`[StreamerController] Idle for ${Math.floor(idleDuration / 1000)}s, checking proactive speak...`);

      const status = streamerSession.status();
      const topic = status.topic || '自由聊天';

      const proactivePrompt = proactiveUserPrompt(topic, Math.floor(idleDuration / 1000));
      const proactiveText = await this.generateProactiveText(proactivePrompt);

      if (proactiveText) {
        console.log(`[StreamerController] Proactive: ${proactiveText}`);
        this.lastSpeakAt = Date.now();

        if (this.config.autoTTS) {
          await this.speakText(proactiveText);
        }

        if (this.config.autoLive2D) {
          this.setRandomExpression();
        }

        this.emit('proactive', proactiveText);
      } else {
        // 即使没有生成文本，也要重置计时器，避免重复触发
        console.log('[StreamerController] Proactive speak disabled (generateProactiveText returned null)');
        this.lastSpeakAt = Date.now();
      }
    } catch (err) {
      console.error('[StreamerController] Proactive speak error:', err);
      // 出错也要重置计时器
      this.lastSpeakAt = Date.now();
    }
  }

  /**
   * 生成主动开口文本（调用 AI）
   */
  private async generateProactiveText(prompt: string): Promise<string | null> {
    try {
      const provider = aiConfig.providers[aiConfig.activeProvider];
      if (!provider) {
        console.warn('[StreamerController] generateProactiveText: no active AI provider');
        return null;
      }
      const data = await fetchCompletion(provider, [
        { role: 'system', content: SESSION_SYSTEM_PROMPT },
        { role: 'user', content: prompt },
      ]);
      const text = data.choices[0]?.message.content?.trim() ?? '';
      return text || null;
    } catch (err) {
      console.error('[StreamerController] generateProactiveText error:', err);
      return null;
    }
  }

  /**
   * TTS 朗读文本
   */
  private async speakText(text: string): Promise<void> {
    try {
      // 清理文本（移除特殊标记）
      const cleanText = text
        .replace(/【.*?】/g, '')
        .replace(/\[.*?\]/g, '')
        .trim();

      if (!cleanText) return;

      // 播放 TTS 音频（自动发送到渲染进程）
      const success = await playTTSAudio(cleanText);
      if (!success) {
        console.log('[StreamerController] TTS playback failed or skipped');
      }
    } catch (err) {
      console.error('[StreamerController] TTS error:', err);
    }
  }

  /**
   * 控制 Live2D（根据回复内容）
   */
  private controlLive2D(reply: StreamerReply): void {
    try {
      // 根据回复类型设置情绪
      switch (reply.kind) {
        case 'gift_thanks':
          // 礼物感谢：开心表情
          sendLive2DCommand({ type: 'emotion', emotion: 'happy', playMotion: true });
          break;

        case 'danmu_single':
        case 'danmu_batch':
          // 普通弹幕：随机表情
          this.setRandomExpression();
          break;

        case 'topic_control':
          // 控场：专注表情
          sendLive2DCommand({ type: 'emotion', emotion: 'neutral' });
          break;
      }
    } catch (err) {
      console.error('[StreamerController] Live2D control error:', err);
    }
  }

  /**
   * 设置随机表情
   */
  private setRandomExpression(): void {
    const emotions: Array<'neutral' | 'happy' | 'shy' | 'surprised'> = ['neutral', 'happy', 'shy', 'surprised'];
    const random = emotions[Math.floor(Math.random() * emotions.length)];
    sendLive2DCommand({ type: 'emotion', emotion: random });
  }
}

export const streamerController = new StreamerControllerManager();
