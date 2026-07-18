import type { ToolPauseResult, ToolDefinition } from '../types';
import { streamerSession } from '../../streaming/streamerSession';
import type { EphemeralLiveCredentials, LiveEvent, StreamerSessionConfig } from '../../streaming/types';

interface ManageBilibiliLiveParams {
  action: 'start' | 'stop' | 'status' | 'ingest_test' | 'flush' | 'replies' | 'set_auto_reply' | 'set_topic' | 'update_config';
  room_id?: number;
  topic?: string;
  cookie?: string;
  require_cookie?: boolean;
  auto_reply?: boolean;
  enabled?: boolean;
  event_type?: LiveEvent['type'];
  uid?: string;
  uname?: string;
  text?: string;
  gift_name?: string;
  gift_count?: number;
  gift_value?: number;
  limit?: number;
  /** update_config: 暗场阈値（毫秒） */
  idle_threshold_ms?: number;
  /** update_config: 是否自动 TTS */
  auto_tts?: boolean;
  /** update_config: 是否自动 Live2D */
  auto_live2d?: boolean;
}

function formatStatus() {
  const status = streamerSession.status();
  return JSON.stringify(status, null, 2);
}

async function getStreamerController() {
  const { streamerController } = await import('../../streaming/streamerController');
  return streamerController;
}

function requestRoomIdPause(topic?: string): ToolPauseResult {
  return {
    __pause: true,
    trace: [
      'Bilibili live start requested.',
      'No room_id was provided in this tool call.',
      'room_id must be collected from the user.',
    ],
    userMessage:
      `要开始 B 站直播${topic ? `（主题：${topic}）` : ''}，请提供直播间的房间号（room_id）。` +
      '可以在 B 站直播间 URL 中找到，例如 live.bilibili.com/26835777 中的 26835777。',
    resumeHint:
      '用户提供房间号后，立刻重新调用 manage_bilibili_live(action="start", room_id=用户提供的房间号, topic=原主题)。',
  };
}

function requestCookiePause(roomId: number, topic?: string): ToolPauseResult {
  return {
    __pause: true,
    trace: [
      'Bilibili live start requested.',
      'No Cookie was provided in this tool call.',
      'Cookie must be collected from the user for this start attempt only.',
    ],
    userMessage:
      `要连接 B 站直播间 ${roomId}${topic ? `（主题：${topic}）` : ''}，请提供本次使用的 B 站 Cookie。` +
      '我不会把 Cookie 写入源码、数据库或长期配置；这次启动流程结束或停止直播后就丢弃。',
    resumeHint:
      '用户提供 Cookie 后，立刻重新调用 manage_bilibili_live(action="start", room_id=原房间号, topic=原主题, cookie=用户提供的 Cookie)。' +
      '不要把 Cookie 写入文件、记忆、日志或普通聊天总结。',
  };
}

const manageBilibiliLiveTool: ToolDefinition<ManageBilibiliLiveParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'manage_bilibili_live',
      description:
        '管理 B 站直播主播后台会话：启动/停止 streamer 会话、查看弹幕池状态、注入测试弹幕、触发一次回复规划。' +
        'start 动作：如果缺少 room_id 或 Cookie，工具会暂停并要求 AI 向用户询问。Cookie 只能临时使用，禁止写入文件、记忆或数据库。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status', 'ingest_test', 'flush', 'replies', 'set_auto_reply', 'set_topic', 'update_config'],
            description: 'start 启动直播会话；stop 停止；status 状态；ingest_test 注入测试事件；flush 生成/规划一条回复；replies 查看最近回复；set_auto_reply 动态开关自动回复；set_topic 实时修改直播主题（暂不重启）；update_config 修改暗场阈值/TTS/Live2D 开关',
          },
          room_id: { type: 'integer', description: 'B 站直播间 room_id。start 时如果不提供，工具会暂停并询问用户。' },
          topic: { type: 'string', description: '本场直播主题，例如打游戏、读书、一起冲浪。start 和 set_topic 均可使用' },
          cookie: { type: 'string', description: '本次 start 调用使用的 B 站 Cookie。不得硬编码、不得持久化、不得写入记忆；缺失时工具会要求 AI 询问用户。' },
          require_cookie: { type: 'boolean', description: 'start 是否要求 Cookie。默认 true。仅离线测试弹幕池时可设为 false。' },
          auto_reply: { type: 'boolean', description: '是否自动调用 LLM 生成回复。默认 true，开播后自动回复弹幕。若需手动控制可传 false。' },
          enabled: { type: 'boolean', description: 'set_auto_reply 动作的开关值' },
          event_type: { type: 'string', enum: ['danmu', 'gift', 'super_chat', 'guard', 'enter', 'like', 'system'], description: 'ingest_test 的事件类型' },
          uid: { type: 'string', description: '测试事件用户 uid' },
          uname: { type: 'string', description: '测试事件用户名' },
          text: { type: 'string', description: '测试弹幕/SC 文本' },
          gift_name: { type: 'string', description: '测试礼物名称' },
          gift_count: { type: 'integer', description: '测试礼物数量' },
          gift_value: { type: 'number', description: '测试礼物价值，单位由上游适配器归一化' },
          limit: { type: 'integer', description: 'replies 返回条数，默认 10' },
          idle_threshold_ms: { type: 'integer', description: 'update_config: 暗场阈值（毫秒）。改小让 AI 更积极尝试开口，改大让 AI 更安静。例如 60000 表示 1 分钟暗场触发一次。' },
          auto_tts: { type: 'boolean', description: 'update_config: 是否自动 TTS 朗读回复' },
          auto_live2d: { type: 'boolean', description: 'update_config: 是否自动控制 Live2D 情绪/动作' },
        },
        required: ['action'],
      },
    },
  },

  async execute(params, context) {
    switch (params.action) {
      case 'start': {
        // 1. 检查 room_id
        if (!params.room_id) {
          return requestRoomIdPause(params.topic);
        }

        // 2. 检查 Cookie
        const requireCookie = params.require_cookie ?? true;
        if (requireCookie && !params.cookie?.trim()) {
          return requestCookiePause(params.room_id, params.topic);
        }

        // 3. 启动会话
        const config: StreamerSessionConfig = {
          platform: 'bilibili',
          roomId: params.room_id,
          topic: params.topic,
          conversationId: context?.conversationId,
          autoReply: params.auto_reply ?? true,
        };
        const credentials: EphemeralLiveCredentials | undefined = params.cookie?.trim()
          ? { cookie: params.cookie.trim(), receivedAt: Date.now() }
          : undefined;
        const status = streamerSession.start(config, credentials);
        
        // 4. 启动主控循环（配置从 .env 读取，见 STREAMER_IDLE_THRESHOLD_MS 等变量）
        (await getStreamerController()).start();
        
        return `B 站 streamer 会话已启动。\n${JSON.stringify(status, null, 2)}`;
      }
      case 'stop': {
        // 停止主控循环
        (await getStreamerController()).stop();
        // 停止会话
        const status = streamerSession.stop();
        return `B 站 streamer 会话已停止。\n${JSON.stringify(status, null, 2)}`;
      }
      case 'status':
        return formatStatus();
      case 'ingest_test': {
        const event: LiveEvent = {
          id: `test-${Date.now()}-${Math.random().toString(16).slice(2)}`,
          platform: 'bilibili',
          type: params.event_type ?? 'danmu',
          ts: Date.now(),
          uid: params.uid,
          uname: params.uname,
          text: params.text,
          giftName: params.gift_name,
          giftCount: params.gift_count,
          giftValue: params.gift_value,
        };
        const result = streamerSession.ingest(event);
        return JSON.stringify(result, null, 2);
      }
      case 'flush': {
        const reply = await streamerSession.flushOnce();
        return reply ? JSON.stringify(reply, null, 2) : '当前没有待处理的直播事件。';
      }
      case 'replies':
        return JSON.stringify(streamerSession.listReplies(params.limit ?? 10), null, 2);
      case 'set_auto_reply': {
        const enabled = params.enabled ?? true;
        const success = streamerSession.setAutoReply(enabled);
        if (!success) {
          return '设置失败：当前没有活跃的直播会话。请先使用 action="start" 启动直播会话。';
        }
        return `自动回复已${enabled ? '开启' : '关闭'}。${enabled ? '现在会自动调用 AI 回复弹幕。' : '现在只规划回复内容，不自动生成 AI 回复。'}`;
      }
      case 'set_topic': {
        const newTopic = params.topic?.trim();
        if (!newTopic) {
          return '请提供新的直播主题（topic 参数）。';
        }
        const ok = streamerSession.setTopic(newTopic);
        if (!ok) {
          return '设置失败：当前没有活跃的直播会话。请先使用 action="start" 启动直播会话。';
        }
        return `直播主题已更新为「${newTopic}」。后续弹幕回复和暗场将使用新主题。`;
      }
      case 'update_config': {
        const patch: Record<string, unknown> = {};
        if (params.idle_threshold_ms !== undefined) patch.idleThresholdMs = params.idle_threshold_ms;
        if (params.auto_tts !== undefined) patch.autoTTS = params.auto_tts;
        if (params.auto_live2d !== undefined) patch.autoLive2D = params.auto_live2d;
        if (Object.keys(patch).length === 0) {
          return '请至少提供一个要更新的配置项（idle_threshold_ms / auto_tts / auto_live2d）。';
        }
        (await getStreamerController()).updateConfig(patch);
        const updated: string[] = [];
        if (params.idle_threshold_ms !== undefined) updated.push(`暗场阈值 = ${params.idle_threshold_ms / 1000}秒`);
        if (params.auto_tts !== undefined) updated.push(`自动TTS = ${params.auto_tts ? '开' : '关'}`);
        if (params.auto_live2d !== undefined) updated.push(`自动Live2D = ${params.auto_live2d ? '开' : '关'}`);
        return `配置已更新：${updated.join('，')}。无需重启即生效。`;
      }
      default:
        return `未知操作: ${params.action}`;
    }
  },
};

export default manageBilibiliLiveTool;
