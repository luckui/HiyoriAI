import type { ToolPauseResult, ToolDefinition } from '../types';
import { streamerSession } from '../../streaming/streamerSession';
import type { StreamerSessionConfig } from '../../streaming/types';
import { getLiveConfig } from '../../config/runtimeConfig';

interface ManageBilibiliLiveParams {
  action: 'start' | 'stop' | 'status' | 'ingest_test' | 'flush' | 'replies' | 'set_auto_reply' | 'set_topic' | 'update_config';
  room_id?: number;
  topic?: string;
  auto_reply?: boolean;
  enabled?: boolean;
  uname?: string;
  text?: string;
  limit?: number;
  /** update_config: 暗场阈値（毫秒） */
  idle_threshold_ms?: number;
  /** update_config: 是否自动 TTS */
  auto_tts?: boolean;
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

const manageBilibiliLiveTool: ToolDefinition<ManageBilibiliLiveParams> = {
  schema: {
    type: 'function',
    function: {
      name: 'manage_bilibili_live',
      description:
        '管理 B 站直播的 AI 互动：启动/停止自动回弹幕、查看弹幕池状态、注入测试弹幕、触发一次回复。' +
        '连接用设置 › 直播里保存的房间号和登录 Cookie；start 不给 room_id 且设置里也没有时，工具会暂停并要求向用户询问房间号。',
      parameters: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: ['start', 'stop', 'status', 'ingest_test', 'flush', 'replies', 'set_auto_reply', 'set_topic', 'update_config'],
            description: 'start 启动 AI 互动；stop 停止（不会断开弹幕姬）；status 状态；ingest_test 注入一条测试弹幕；flush 立刻挑一个话题说一句；replies 查看最近回复；set_auto_reply 动态开关自动回复；set_topic 实时修改直播主题（暂不重启）；update_config 调整冷场多久自己找话、是否朗读',
          },
          room_id: { type: 'integer', description: 'B 站直播间 room_id。不提供时用设置里保存的房间号；都没有时工具会暂停并询问用户。' },
          topic: { type: 'string', description: '本场直播主题，例如打游戏、读书、一起冲浪。start 和 set_topic 均可使用' },
          auto_reply: { type: 'boolean', description: '是否自动调用 LLM 生成回复。默认 true，开播后自动回复弹幕。若需手动控制可传 false。' },
          enabled: { type: 'boolean', description: 'set_auto_reply 动作的开关值' },
          uname: { type: 'string', description: 'ingest_test 的测试用户名' },
          text: { type: 'string', description: 'ingest_test 的测试弹幕文本' },
          limit: { type: 'integer', description: 'replies 返回条数，默认 10' },
          idle_threshold_ms: { type: 'integer', description: 'update_config: 没人说话多久后她自己找话说（毫秒），默认 45000。' },
          auto_tts: { type: 'boolean', description: 'update_config: 是否自动 TTS 朗读回复' },
        },
        required: ['action'],
      },
    },
  },

  async execute(params, context) {
    switch (params.action) {
      case 'start': {
        const saved = getLiveConfig();
        const roomId = params.room_id ?? saved.roomId;
        if (!roomId) return requestRoomIdPause(params.topic);

        const config: StreamerSessionConfig = {
          platform: 'bilibili',
          roomId,
          topic: params.topic,
          conversationId: context?.conversationId,
          autoReply: params.auto_reply ?? true,
        };
        // Cookie 是账号级的，换房间也能用
        const status = streamerSession.start(config, saved.cookie);

        // 启动主控循环（配置从 .env 读取，见 STREAMER_IDLE_THRESHOLD_MS 等变量）
        (await getStreamerController()).start();

        const hint = saved.cookie ? '' : '\n提示：设置 › 直播里没有登录 Cookie，B 站会把大部分观众名打码。';
        return `B 站 AI 互动已启动。${hint}\n${JSON.stringify(status, null, 2)}`;
      }
      case 'stop': {
        // 停止主控循环
        (await getStreamerController()).stop();
        // 停止会话
        const status = streamerSession.stop();
        return `B 站 AI 互动已停止（弹幕姬连接保持不变）。\n${JSON.stringify(status, null, 2)}`;
      }
      case 'status':
        return formatStatus();
      case 'ingest_test':
        return JSON.stringify(streamerSession.ingestTest(params.uname ?? '测试用户', params.text ?? '你好'), null, 2);
      case 'flush': {
        const reply = await (await getStreamerController()).flushOnce();
        return reply ? JSON.stringify(reply, null, 2) : '现在没有值得说的话题。';
      }
      case 'replies':
        return JSON.stringify(streamerSession.listReplies(params.limit ?? 10), null, 2);
      case 'set_auto_reply': {
        const enabled = params.enabled ?? true;
        const success = streamerSession.setAutoReply(enabled);
        if (!success) {
          return '设置失败：当前没有活跃的直播会话。请先使用 action="start" 启动直播会话。';
        }
        return `自动回复已${enabled ? '开启' : '关闭'}。${enabled ? '她会自己挑弹幕、礼物和进场来回应。' : '她不再自己开口；可以用 flush 手动让她说一句。'}`;
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
        const patch: { idleThresholdMs?: number; autoTTS?: boolean } = {};
        if (params.idle_threshold_ms !== undefined) patch.idleThresholdMs = params.idle_threshold_ms;
        if (params.auto_tts !== undefined) patch.autoTTS = params.auto_tts;
        if (Object.keys(patch).length === 0) {
          return '请至少提供一个要更新的配置项（idle_threshold_ms / auto_tts）。';
        }
        (await getStreamerController()).updateConfig(patch);
        const updated: string[] = [];
        if (params.idle_threshold_ms !== undefined) updated.push(`冷场多久自己找话 = ${params.idle_threshold_ms / 1000}秒`);
        if (params.auto_tts !== undefined) updated.push(`自动TTS = ${params.auto_tts ? '开' : '关'}`);
        return `配置已更新：${updated.join('，')}。无需重启即生效。`;
      }
      default:
        return `未知操作: ${params.action}`;
    }
  },
};

export default manageBilibiliLiveTool;
