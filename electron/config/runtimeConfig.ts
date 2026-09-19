/**
 * 运行时配置：TTS / 平台桥接 / Live2D 形象三份可变配置的唯一持有者。
 *
 * LLM 配置仍是 ai.config 的单例对象（各处直接 import），这里只负责把它一起持久化。
 * 读配置用 getXxx()，改配置用 setXxx()；改完调用 persistAppConfig() 写回 config.json + SQLite。
 */

import { app } from 'electron';
import { join } from 'path';
import aiConfig from '../ai.config';
import defaultTTSConfig, { type TTSConfig } from '../tts.config';
import { DEFAULT_SKILLS_CONFIG, getSkillsConfig, saveSkillsConfig } from '../skillsConfig';
import { setSetting } from '../db';
import { mergeBuiltinTTSProviders } from '../genieVoiceManager';
import { DEFAULT_AVATAR_CONFIG, type AvatarConfig } from '../avatar/avatarConfig';
import { cloneAvatarConfig, normalizeAvatarConfig, withBuiltinAvatarProfile } from '../avatar/avatarManager';
import type { AppConfig, BridgeAppConfig } from './appConfig';
import { loadAppConfigFromFile, saveAppConfig } from './configStore';

/** 内置 TTS 方案 key，禁止删除，始终从代码默认值恢复 */
export const BUILTIN_TTS_PROVIDERS: ReadonlySet<string> = new Set(Object.keys(defaultTTSConfig.providers));

let ttsConfig: TTSConfig = structuredClone(defaultTTSConfig);
let bridgeConfig: BridgeAppConfig = bridgeConfigFromEnv();
let avatarConfig: AvatarConfig = cloneAvatarConfig(DEFAULT_AVATAR_CONFIG);

// ── TTS ──────────────────────────────────────────────────

export function getTTSConfig(): TTSConfig {
  return ttsConfig;
}

export function setTTSConfig(next: TTSConfig): void {
  ttsConfig = {
    ...next,
    // 内置方案不允许出现在删除列表中
    deletedProviders: (next.deletedProviders ?? []).filter((key) => !BUILTIN_TTS_PROVIDERS.has(key)),
  };
}

// ── 平台桥接 ─────────────────────────────────────────────

export function getBridgeConfig(): BridgeAppConfig {
  return bridgeConfig;
}

/** 更新桥接配置，并同步到 process.env（各 adapter 从环境变量读取启动参数） */
export function setBridgeConfig(next: BridgeAppConfig): void {
  bridgeConfig = next;
  applyBridgeEnv(next);
}

// ── Live2D 形象 ──────────────────────────────────────────

export function getAvatarConfig(): AvatarConfig {
  return avatarConfig;
}

export function setAvatarConfig(next: AvatarConfig): void {
  avatarConfig = withBuiltinAvatarProfile(normalizeAvatarConfig(next), builtinAvatarModelDir());
}

export function builtinAvatarModelDir(): string {
  return app.isPackaged
    ? join(__dirname, '../renderer/Resources/Hiyori_pro')
    : join(app.getAppPath(), 'public', 'Resources', 'Hiyori_pro');
}

// ── 持久化 ───────────────────────────────────────────────

function currentAppConfig(): AppConfig {
  return {
    version: 1,
    llm: aiConfig,
    tts: ttsConfig,
    skills: getSkillsConfig(),
    bridges: bridgeConfig,
    avatar: avatarConfig,
  };
}

export function persistAppConfig(): void {
  saveAppConfig(currentAppConfig(), { getSetting: () => null, setSetting });
}

/** 启动时从 config.json 载入全部配置；失败时保留内存中的默认值 */
export function loadPersistedConfig(): void {
  try {
    const cfg = loadAppConfigFromFile({
      llm: aiConfig,
      tts: defaultTTSConfig,
      skills: DEFAULT_SKILLS_CONFIG,
      bridges: bridgeConfig,
      avatar: DEFAULT_AVATAR_CONFIG,
    }, { getSetting: () => null, setSetting });

    aiConfig.activeProvider = cfg.llm.activeProvider;
    aiConfig.contextWindowRounds = cfg.llm.contextWindowRounds;
    aiConfig.providers = cfg.llm.providers;
    aiConfig.deletedProviders = cfg.llm.deletedProviders ?? [];
    setTTSConfig(mergeBuiltinTTSProviders(cfg.tts, defaultTTSConfig));
    setBridgeConfig(cfg.bridges);
    setAvatarConfig(cfg.avatar);
    saveSkillsConfig(cfg.skills);

    persistAppConfig();
    console.info('[Config] runtime config loaded from synchronized SQLite mirror');
  } catch (error) {
    console.error('[Config] failed to load config.json; using in-memory defaults:', (error as Error).message);
  }
}

// ── 环境变量 ↔ 桥接配置 ─────────────────────────────────

function bridgeConfigFromEnv(): BridgeAppConfig {
  const env = process.env;
  return {
    discord: {
      enabled: env['DISCORD_ENABLED'] === 'true',
      token: env['DISCORD_TOKEN'] ?? '',
      allowedChannels: env['DISCORD_ALLOWED_CHANNELS'] ?? '',
      proxyUrl: env['DISCORD_PROXY'] ?? '',
    },
    wechat: {
      enabled: env['WECHAT_ENABLED'] === 'true',
      token: env['WECHAT_TOKEN'] ?? '',
      accountId: env['WECHAT_ACCOUNT_ID'] ?? '',
      baseUrl: env['WECHAT_BASE_URL'] ?? 'https://ilinkai.weixin.qq.com',
      sendChunkDelay: parseFloat(env['WECHAT_SEND_CHUNK_DELAY'] ?? '0.35'),
      voiceRepliesEnabled: env['WECHAT_VOICE_REPLIES_ENABLED'] === 'true',
      voiceReplyDelivery: env['WECHAT_VOICE_REPLY_DELIVERY'] === 'native_voice' ? 'native_voice' : 'audio_file',
    },
    feishu: {
      enabled: env['FEISHU_ENABLED'] === 'true',
      appId: env['FEISHU_APP_ID'] ?? '',
      appSecret: env['FEISHU_APP_SECRET'] ?? '',
      allowedChatIds: env['FEISHU_ALLOWED_CHAT_IDS'] ?? '',
      voiceRepliesEnabled: env['FEISHU_VOICE_REPLIES_ENABLED'] === 'true',
    },
  };
}

function applyBridgeEnv(cfg: BridgeAppConfig): void {
  const env = process.env;
  env['DISCORD_ENABLED'] = String(cfg.discord.enabled);
  env['DISCORD_TOKEN'] = cfg.discord.token;
  env['DISCORD_ALLOWED_CHANNELS'] = cfg.discord.allowedChannels;
  env['DISCORD_PROXY'] = cfg.discord.proxyUrl;

  env['WECHAT_ENABLED'] = String(cfg.wechat.enabled);
  env['WECHAT_TOKEN'] = cfg.wechat.token;
  env['WECHAT_ACCOUNT_ID'] = cfg.wechat.accountId;
  env['WECHAT_BASE_URL'] = cfg.wechat.baseUrl;
  env['WECHAT_SEND_CHUNK_DELAY'] = String(cfg.wechat.sendChunkDelay);
  env['WECHAT_VOICE_REPLIES_ENABLED'] = String(cfg.wechat.voiceRepliesEnabled);
  env['WECHAT_VOICE_REPLY_DELIVERY'] = cfg.wechat.voiceReplyDelivery;

  env['FEISHU_ENABLED'] = String(cfg.feishu.enabled);
  env['FEISHU_APP_ID'] = cfg.feishu.appId;
  env['FEISHU_APP_SECRET'] = cfg.feishu.appSecret;
  env['FEISHU_ALLOWED_CHAT_IDS'] = cfg.feishu.allowedChatIds;
  env['FEISHU_VOICE_REPLIES_ENABLED'] = String(cfg.feishu.voiceRepliesEnabled);
}
