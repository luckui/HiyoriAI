/**
 * TTS 多 Provider 配置
 *
 * 与 ai.config.ts 的 LLM 多服务商架构一致：
 *   providers: Record<key, TTSProviderConfig>
 *   activeProvider: 当前使用的 key
 *
 * 所有 TTS 服务统一 RESTful 规范：
 *   POST /tts/generate  body: { text, speaker, language } → 音频流
 *   GET  /health        → 健康检查
 */

// ── 类型定义 ────────────────────────────────────────────────────────

/** 预设音色项 */
export interface VoicePresetItem {
  /** 预设 ID，同时作为 speaker 字段发送给 TTS 服务 */
  id: string;
  /** 显示名 */
  name: string;
  /** 描述（如"中文女声 A"） */
  description: string;
  /** 对应的参考音频文件名（相对于 voices/ 目录） */
  refAudioFile?: string;
}

export interface TTSProviderConfig {
  /** 目前仅 http-tts；将来可扩展 websocket 等 */
  type: 'http-tts';
  /** 显示名："Edge-TTS 本地"、"CosyVoice 远程"… */
  name: string;
  /** RESTful 端点（不带尾斜杠） */
  baseUrl: string;
  /** Bearer Token，留空则不发 */
  apiKey: string;
  /** 音色 ID */
  speaker: string;
  /** 语言代码 */
  language: string;
  /** 是否由本应用管理进程生命周期 */
  isLocal?: boolean;
  /** 本地引擎标识：'edge-tts' | 'moss-tts-nano' … */
  localEngine?: string;
  /** 音色选择模式：text = 自由文本输入（默认），preset = 下拉预设列表 */
  speakerMode?: 'text' | 'preset';
  /** 预设音色列表（speakerMode='preset' 时在 UI 展示下拉） */
  voicePresets?: VoicePresetItem[];
}

export interface TTSConfig {
  /** 全局开关：用户是否想要语音 */
  enabled: boolean;
  /** 当前使用的 provider key */
  activeProvider: string;
  /** 所有已配置的 TTS 服务商 */
  providers: Record<string, TTSProviderConfig>;
  /** 用户主动删除的 key，防止代码更新后同名 provider 复活 */
  deletedProviders?: string[];
}

// ── MOSS-TTS-Nano 预设音色 ──────────────────────────────────────────

const NANO_VOICE_PRESETS: VoicePresetItem[] = [
  // 中文
  { id: 'Junhao',  name: '俊豪',   description: '中文男声 A', refAudioFile: 'zh_1.wav' },
  { id: 'Zhiming', name: '志明',   description: '中文男声 B', refAudioFile: 'zh_2.wav' },
  { id: 'Weiguo',  name: '伟国',   description: '中文男声 C', refAudioFile: 'zh_5.wav' },
  { id: 'Xiaoyu',  name: '小雨',   description: '中文女声 A', refAudioFile: 'zh_3.wav' },
  { id: 'Yuewen',  name: '月雯',   description: '中文女声 B', refAudioFile: 'zh_4.wav' },
  { id: 'Lingyu',  name: '灵雨',   description: '中文女声 C', refAudioFile: 'zh_6.wav' },
  // 英文
  { id: 'Trump',   name: 'Trump',   description: 'Trump 参考音色',  refAudioFile: 'en_1.wav' },
  { id: 'Ava',     name: 'Ava',     description: '英文女声 A',      refAudioFile: 'en_2.wav' },
  { id: 'Bella',   name: 'Bella',   description: '英文女声 B',      refAudioFile: 'en_3.wav' },
  { id: 'Adam',    name: 'Adam',    description: '英文男声 A',      refAudioFile: 'en_4.wav' },
  { id: 'Nathan',  name: 'Nathan',  description: '英文男声 B',      refAudioFile: 'en_5.wav' },
  // 日文
  { id: 'Sakura',  name: 'Sakura',  description: '日文女声 A',      refAudioFile: 'jp_1.mp3' },
  { id: 'Yui',     name: 'Yui',     description: '日文女声 B',      refAudioFile: 'jp_2.wav' },
  { id: 'Aoi',     name: 'Aoi',     description: '日文女声 C',      refAudioFile: 'jp_3.wav' },
  { id: 'Hina',    name: 'Hina',    description: '日文女声 D',      refAudioFile: 'jp_4.wav' },
  { id: 'Mei',     name: 'Mei',     description: '日文女声 E',      refAudioFile: 'jp_5.wav' },
  // 自定义
  { id: 'Hiyori',  name: 'ひより',  description: 'Hiyori カスタム', refAudioFile: 'hiyori-ch.wav' },
];

// ── 默认配置 ────────────────────────────────────────────────────────

const defaultTTSConfig: TTSConfig = {
  enabled: false,
  activeProvider: 'local_edge_tts',
  providers: {
    local_edge_tts: {
      type: 'http-tts',
      name: 'Edge-TTS 本地',
      baseUrl: 'http://127.0.0.1:9880',
      apiKey: '',
      speaker: 'xiaoxiao',
      language: 'Auto',
      isLocal: true,
      localEngine: 'edge-tts',
    },
    local_moss_nano: {
      type: 'http-tts',
      name: 'MOSS-TTS-Nano 本地',
      baseUrl: 'http://127.0.0.1:9881',
      apiKey: '',
      speaker: 'Hiyori',
      language: 'Auto',
      isLocal: true,
      localEngine: 'moss-tts-nano',
      speakerMode: 'preset',
      voicePresets: NANO_VOICE_PRESETS,
    },
    local_genie_tts: {
      type: 'http-tts',
      name: 'Genie-TTS 本地',
      baseUrl: 'http://127.0.0.1:9882',
      apiKey: '',
      speaker: 'feibi',
      language: 'auto',
      isLocal: true,
      localEngine: 'genie-tts',
      speakerMode: 'preset',
      voicePresets: [
        { id: 'feibi', name: '菲比', description: 'GPT-SoVITS v2ProPlus · 中文/英文/日文/韩文' },
      ],
    },
  },
  deletedProviders: [],
};

export default defaultTTSConfig;
