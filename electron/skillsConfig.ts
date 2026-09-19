/**
 * Skills 配置管理
 *
 * 控制 agent 模式下 skill 目录注入系统提示词的行为：
 *   - 全局开关（enabled）
 *   - 展示模式（listingMode）：none / names / short / full
 *   - 集合级别禁用（disabledCollections）
 *   - 单技能禁用（disabledSkills）
 *   - 每个集合的展示模式覆盖（collectionModes）
 *
 * 集合（collection）= skills/ 下的子目录，例如：
 *   - "scientific"  →  skills/scientific/（所有科研技能）
 *   - "skills"      →  skills/ 根目录直属技能（如 bilibili-live）
 *
 * 配置持久化到 SQLite（key: 'skills_config'），通过 IPC 供渲染进程读写。
 */

import { getSetting, setSetting } from './db';

// ─── 类型 ─────────────────────────────────────────────────────────────────────

import type { SkillListingMode, SkillsConfig } from '../shared/types/config';
export type { SkillListingMode, SkillsConfig };

// ─── 默认值 ───────────────────────────────────────────────────────────────────

export const DEFAULT_SKILLS_CONFIG: SkillsConfig = {
  enabled: true,
  listingMode: 'full',
  disabledCollections: [],
  disabledSkills: [],
  collectionModes: {},
};

// ─── 运行时缓存 ───────────────────────────────────────────────────────────────

let _cachedConfig: SkillsConfig | null = null;

// ─── 读写 API ─────────────────────────────────────────────────────────────────

/**
 * 读取当前 Skills 配置（有内存缓存，多次调用不会重复读 SQLite）。
 */
export function getSkillsConfig(): SkillsConfig {
  if (_cachedConfig) return _cachedConfig;
  const stored = getSetting('skills_config');
  if (stored) {
    try {
      // 用 DEFAULT_SKILLS_CONFIG 作为底层保证新字段向后兼容
      const config: SkillsConfig = { ...DEFAULT_SKILLS_CONFIG, ...JSON.parse(stored) };
      _cachedConfig = config;
      return config;
    } catch {
      /* 解析失败 → 返回默认值 */
    }
  }
  _cachedConfig = { ...DEFAULT_SKILLS_CONFIG };
  return _cachedConfig;
}

/**
 * 保存 Skills 配置，同时更新内存缓存和 SQLite。
 */
export function saveSkillsConfig(cfg: SkillsConfig): void {
  _cachedConfig = cfg;
  setSetting('skills_config', JSON.stringify(cfg));
}

