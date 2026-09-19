/// <reference types="node" />
// 必须是第一个 import：其他模块加载时就会读取 process.env
import './bootstrapEnv';
import { app, desktopCapturer, session } from 'electron';
import { join } from 'path';
import {
  countNonSystemMessages,
  getGlobalMemoryCursor,
  getMemoryCursor,
  getMemoryFragments,
  initDatabase,
  listConversations,
} from './db';
import { sendChatMessage } from './aiService';
import { configureTurnTrace, traceTurnEvent } from './turnTrace';
import { globalMemoryManager, memoryManager, runStartupCatchUp, startIdleScheduler } from './memory/index';
import { startBridges, stopBridges } from './bridges/index';
import { getReplyTargetForConversation } from './bridges/asyncDelivery';
import { taskManager } from './taskManager';
import { configureBatchResultsDir } from './batchRunner';
import { taskScheduler } from './taskScheduler';
import { minecraftRuntime } from './minecraft';
import { configureMinecraftMainIntegration } from './minecraft/mainIntegration';
import { MinecraftGoalController } from './minecraft/goalController';
import { setMinecraftGoalController } from './minecraft/goalContext';
import { buildMinecraftGoalWakeup } from './minecraft/goalWakeup';
import { getBridgeConfig, loadPersistedConfig } from './config/runtimeConfig';
import { activateTTSProvider, applyTTSRuntime, broadcastTTSChanged, playTTSAudio } from './ttsRuntime';
import { sendAgentWakeup, wireAgentNotifications } from './agentWakeup';
import { getMainWindow, sendToRenderer } from './mainWindow';
import { createMainWindow, registerWindowIpc } from './ipc/window';
import { defaultConversationId, getActiveConversationId, registerChatIpc } from './ipc/chat';
import { registerSettingsIpc } from './ipc/settings';
import { registerBridgeIpc } from './ipc/bridges';
import { registerTTSIpc } from './ipc/tts';
import { registerHearingIpc } from './ipc/hearing';
import { registerAvatarIpc, registerAvatarProtocol, registerAvatarScheme } from './ipc/avatar';

registerAvatarScheme();

let minecraftIntegration: ReturnType<typeof configureMinecraftMainIntegration> | undefined;
let minecraftGoalController: MinecraftGoalController | undefined;

app.whenReady().then(() => {
  configureTurnTrace(join(app.getPath('userData'), 'logs', 'agent-turns.jsonl'));
  initDatabase();
  configureBatchResultsDir(join(app.getPath('userData'), 'batch-results'));
  // 上次退出时仍在排队 / 执行的任务已无人接管：标记为中断，之后可用 async_task retry 从断点继续
  taskManager.reconcileInterruptedTasks();
  loadPersistedConfig();
  registerAvatarProtocol();

  minecraftGoalController = new MinecraftGoalController({
    taskManager,
    runtime: minecraftRuntime,
    onTerminal: (notice) => {
      sendAgentWakeup(
        notice.goal.conversationId,
        buildMinecraftGoalWakeup(notice),
        notice.goal.replyTarget ?? getReplyTargetForConversation(notice.goal.conversationId),
        { source: 'background_task', event: 'minecraft-goal-terminal', sourceId: notice.goal.title },
      );
    },
    onTrace: (event) => traceTurnEvent({
      ...event,
      type: String(event.type ?? 'minecraft-slot-event'),
      turnId: `minecraft-slot-${String(event.generation ?? '0')}`,
      conversationId: minecraftRuntime.currentOrigin()?.conversationId ?? 'minecraft',
    }),
  });
  setMinecraftGoalController(minecraftGoalController);
  wireAgentNotifications();

  // 系统音频捕获：拦截 renderer 的 getDisplayMedia 请求，自动选择主屏幕 + loopback 回环音频
  session.defaultSession.setDisplayMediaRequestHandler((_request, callback) => {
    desktopCapturer.getSources({ types: ['screen'] }).then((sources) => {
      callback({ video: sources[0], audio: 'loopback' });
    }).catch(() => {
      callback({ video: undefined as never, audio: undefined as never });
    });
  });

  // 启动时激活 TTS provider；若为本地服务则后台静默拉起（重启后无需用户手动 enable）
  activateTTSProvider();
  void applyTTSRuntime((msg) => console.info(`[TTS] startup apply: ${msg}`))
    .then((result) => {
      if (!result.ok) console.warn('[TTS] startup apply failed:', result.detail);
      broadcastTTSChanged();
    })
    .catch((e) => console.warn('[TTS] startup apply failed:', (e as Error).message));

  registerWindowIpc();
  registerChatIpc();
  registerSettingsIpc();
  registerBridgeIpc();
  registerTTSIpc();
  registerHearingIpc();
  registerAvatarIpc();
  createMainWindow();

  // 平台桥接与 Minecraft 默认绑定到最近的对话
  const defaultConvId = defaultConversationId();
  minecraftIntegration = configureMinecraftMainIntegration({
    runtime: minecraftRuntime,
    sendChatMessage,
    playTTS: async (text) => { await playTTSAudio(text); },
    sendWakeup: sendAgentWakeup,
    getFallbackConversationId: () => getActiveConversationId() ?? defaultConvId,
    getMinecraftGoalState: () => minecraftGoalController?.status() ?? null,
    failMinecraftGoal: (reason) => minecraftGoalController?.fail(reason) ?? Promise.resolve(false),
    mirror: (turn) => sendToRenderer('chat:external-turn', turn),
    onError: (error) => console.error('[Minecraft Chat] turn failed:', error.message),
  });
  startBridges(defaultConvId, getBridgeConfig()).catch((e) =>
    console.error('[Bridges] 启动失败:', (e as Error).message)
  );

  // 启动时批量追赶：延迟 3s 等 UI 稳定后处理所有遗留的未总结消息
  setTimeout(() => {
    runStartupCatchUp(listConversations().map((c) => c.id))
      .catch((e) => console.error('[Memory] 启动追赶异常:', (e as Error).message));
  }, 3000);

  // 空闲调度器：用户停止聊天 10 分钟后自动后台总结
  startIdleScheduler(getActiveConversationId);
  taskScheduler.start();
});

/** 防止 before-quit 重入：流水线执行完成后我们主动调用 app.quit()，不再被拦截 */
let isQuitting = false;

app.on('before-quit', (event) => {
  taskScheduler.stop();
  if (isQuitting) return;

  // 快速判断当前对话是否还有需要总结的内容
  const convId = getActiveConversationId();
  const batchSize = 6; // leaveMinRounds(3) * 2，与 DEFAULT_MEMORY_CONFIG 保持一致
  const unsummarized = convId ? countNonSystemMessages(convId) - getMemoryCursor(convId) : 0;
  const newFragments = convId ? getMemoryFragments(convId).length - getGlobalMemoryCursor(convId) : 0;
  const hasWork = Boolean(convId) && (unsummarized >= batchSize || newFragments > 0);

  // 拦截退出：先释放目标槽、Minecraft worker 和桥接，再按需保存记忆
  event.preventDefault();
  isQuitting = true;
  sendToRenderer('app:quitting');

  (async () => {
    try {
      await minecraftGoalController?.shutdown();
    } catch (error) {
      console.error('[Minecraft] failed to stop goal slot during shutdown:', (error as Error).message);
    }
    try {
      await minecraftIntegration?.shutdown();
    } catch (error) {
      console.error('[Minecraft] failed to stop runtime during shutdown:', (error as Error).message);
    }
    if (hasWork && convId) {
      console.info('[Memory] 应用退出，执行记忆流水线...');
      await memoryManager.forcePartialSummarize(convId);
      await globalMemoryManager.refineAsync(convId);
      console.info('[Memory] 记忆流水线完成，正常退出');
    }
  })()
    .catch((e) => console.error('[Memory] 退出时流水线异常:', (e as Error).message))
    .finally(() => {
      void stopBridges().finally(() => {
        const win = getMainWindow();
        if (!win) {
          app.quit();
          return;
        }
        // 通知渲染层流水线完成，短暂展示"已保存"后关闭
        win.webContents.send('app:quit-ready');
        setTimeout(() => {
          win.destroy(); // 直接 destroy 跳过 close 事件，防止重入
          app.quit();
        }, 400);
      });
    });
});

app.on('window-all-closed', () => {
  app.quit();
});
