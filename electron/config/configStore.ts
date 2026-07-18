import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import { app } from 'electron';
import type { AIConfig } from '../ai.config';
import type { TTSConfig } from '../tts.config';
import type { SkillsConfig } from '../skillsConfig';
import type { BridgeAppConfig, AppConfig, AppConfigDefaults } from './appConfig';
import { createDefaultAppConfig, normalizeAppConfig } from './appConfig';

export const APP_CONFIG_FILE = 'config.json';

export interface SettingsStore {
  getSetting(key: string): string | null;
  setSetting(key: string, value: string): void;
}

export interface ConfigStoreDefaults {
  llm: AIConfig;
  tts: TTSConfig;
  skills: SkillsConfig;
  bridges: BridgeAppConfig;
}

export function getAppConfigPath(): string {
  return join(app.getPath('userData'), APP_CONFIG_FILE);
}

export function readConfigFile(defaults: ConfigStoreDefaults, filePath = getAppConfigPath()): AppConfig {
  const normalizedDefaults = toDefaults(defaults);
  if (!existsSync(filePath)) {
    const created = createDefaultAppConfig(normalizedDefaults);
    writeConfigFile(created, filePath);
    console.info(`[Config] created default config: ${filePath}`);
    return created;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(filePath, 'utf-8'));
  } catch (error) {
    console.error(`[Config] failed to parse config.json, using defaults without overwriting SQLite: ${(error as Error).message}`);
    throw error;
  }

  const normalized = normalizeAppConfig(parsed, normalizedDefaults);
  writeConfigFile(normalized, filePath);
  return normalized;
}

export function writeConfigFile(config: AppConfig, filePath = getAppConfigPath()): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify(config, null, 2)}\n`, 'utf-8');
}

export function syncAppConfigToSqlite(config: AppConfig, store: SettingsStore): void {
  store.setSetting('llm_config', JSON.stringify(config.llm));
  store.setSetting('tts_config', JSON.stringify(config.tts));
  store.setSetting('skills_config', JSON.stringify(config.skills));
  store.setSetting('bridge_config', JSON.stringify(config.bridges));
}

export function loadAppConfigFromFile(
  defaults: ConfigStoreDefaults,
  store: SettingsStore,
  filePath = getAppConfigPath()
): AppConfig {
  const config = readConfigFile(defaults, filePath);
  syncAppConfigToSqlite(config, store);
  console.info('[Config] synchronized config.json -> SQLite');
  return config;
}

export function saveAppConfig(config: AppConfig, store: SettingsStore, filePath = getAppConfigPath()): AppConfig {
  const normalized = normalizeAppConfig(config, toDefaults(config));
  writeConfigFile(normalized, filePath);
  syncAppConfigToSqlite(normalized, store);
  console.info('[Config] saved config.json and SQLite settings');
  return normalized;
}

function toDefaults(defaults: ConfigStoreDefaults): AppConfigDefaults {
  return {
    llm: defaults.llm,
    tts: defaults.tts,
    skills: defaults.skills,
    bridges: defaults.bridges,
  };
}
