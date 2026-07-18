import type { AIConfig } from '../ai.config';
import type { TTSConfig } from '../tts.config';
import type { SkillsConfig } from '../skillsConfig';

export interface DiscordConfig {
  enabled: boolean;
  token: string;
  allowedChannels: string;
  proxyUrl: string;
}

export interface WeChatConfig {
  enabled: boolean;
  token: string;
  accountId: string;
  baseUrl: string;
  sendChunkDelay: number;
}

export interface BridgeAppConfig {
  discord: DiscordConfig;
  wechat: WeChatConfig;
}

export interface AppConfig {
  version: 1;
  llm: AIConfig;
  tts: TTSConfig;
  skills: SkillsConfig;
  bridges: BridgeAppConfig;
}

export interface AppConfigDefaults {
  llm: AIConfig;
  tts: TTSConfig;
  skills: SkillsConfig;
  bridges: BridgeAppConfig;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function normalizeString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function normalizeNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

export function createDefaultAppConfig(defaults: AppConfigDefaults): AppConfig {
  return {
    version: 1,
    llm: sanitizeLlmConfig(clone(defaults.llm)),
    tts: clone(defaults.tts),
    skills: clone(defaults.skills),
    bridges: clone(defaults.bridges),
  };
}

export function normalizeAppConfig(raw: unknown, defaults: AppConfigDefaults): AppConfig {
  const base = createDefaultAppConfig(defaults);
  const input = isObject(raw) ? raw : {};

  const llmInput = isObject(input.llm) ? input.llm : {};
  const ttsInput = isObject(input.tts) ? input.tts : {};
  const skillsInput = isObject(input.skills) ? input.skills : {};
  const bridgesInput = isObject(input.bridges) ? input.bridges : {};
  const discordInput = isObject(bridgesInput.discord) ? bridgesInput.discord : {};
  const wechatInput = isObject(bridgesInput.wechat) ? bridgesInput.wechat : {};

  const llmProviders = sanitizeLlmProviders(isObject(llmInput.providers)
    ? llmInput.providers as AIConfig['providers']
    : base.llm.providers);
  const ttsProviders = isObject(ttsInput.providers)
    ? ttsInput.providers as TTSConfig['providers']
    : base.tts.providers;

  return {
    version: 1,
    llm: {
      ...base.llm,
      ...llmInput,
      activeProvider: normalizeString(llmInput.activeProvider, base.llm.activeProvider),
      contextWindowRounds: normalizeNumber(llmInput.contextWindowRounds, base.llm.contextWindowRounds),
      providers: llmProviders,
      deletedProviders: Array.isArray(llmInput.deletedProviders)
        ? llmInput.deletedProviders.filter((value): value is string => typeof value === 'string')
        : base.llm.deletedProviders,
    },
    tts: {
      ...base.tts,
      ...ttsInput,
      enabled: normalizeBoolean(ttsInput.enabled, base.tts.enabled),
      activeProvider: normalizeString(ttsInput.activeProvider, base.tts.activeProvider),
      providers: ttsProviders,
      deletedProviders: Array.isArray(ttsInput.deletedProviders)
        ? ttsInput.deletedProviders.filter((value): value is string => typeof value === 'string')
        : base.tts.deletedProviders,
    },
    skills: {
      ...base.skills,
      ...skillsInput,
      enabled: normalizeBoolean(skillsInput.enabled, base.skills.enabled),
      listingMode: normalizeString(skillsInput.listingMode, base.skills.listingMode) as SkillsConfig['listingMode'],
      disabledCollections: Array.isArray(skillsInput.disabledCollections)
        ? skillsInput.disabledCollections.filter((value): value is string => typeof value === 'string')
        : base.skills.disabledCollections,
      disabledSkills: Array.isArray(skillsInput.disabledSkills)
        ? skillsInput.disabledSkills.filter((value): value is string => typeof value === 'string')
        : base.skills.disabledSkills,
      collectionModes: isObject(skillsInput.collectionModes)
        ? skillsInput.collectionModes as SkillsConfig['collectionModes']
        : base.skills.collectionModes,
    },
    bridges: {
      discord: {
        enabled: normalizeBoolean(discordInput.enabled, base.bridges.discord.enabled),
        token: normalizeString(discordInput.token, base.bridges.discord.token),
        allowedChannels: normalizeString(discordInput.allowedChannels, base.bridges.discord.allowedChannels),
        proxyUrl: normalizeString(discordInput.proxyUrl, base.bridges.discord.proxyUrl),
      },
      wechat: {
        enabled: normalizeBoolean(wechatInput.enabled, base.bridges.wechat.enabled),
        token: normalizeString(wechatInput.token, base.bridges.wechat.token),
        accountId: normalizeString(wechatInput.accountId, base.bridges.wechat.accountId),
        baseUrl: normalizeString(wechatInput.baseUrl, base.bridges.wechat.baseUrl),
        sendChunkDelay: normalizeNumber(wechatInput.sendChunkDelay, base.bridges.wechat.sendChunkDelay),
      },
    },
  };
}

function sanitizeLlmConfig(config: AIConfig): AIConfig {
  return {
    ...config,
    providers: sanitizeLlmProviders(config.providers),
  };
}

function sanitizeLlmProviders(providers: AIConfig['providers']): AIConfig['providers'] {
  const sanitized: AIConfig['providers'] = {};
  for (const [key, provider] of Object.entries(providers)) {
    const copy = { ...provider };
    delete copy.systemPrompt;
    sanitized[key] = copy;
  }
  return sanitized;
}
