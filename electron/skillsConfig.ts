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

/**
 * skill 目录注入系统提示词时每个条目的展示详细程度：
 *   'none'  → 不注入该集合 / 技能（模型不会在目录中看到它）
 *   'names' → 仅注入技能名称（无描述，最省 token）
 *   'short' → 名称 + 截断到 40 字的描述
 *   'full'  → 名称 + 截断到 100 字的描述（默认行为）
 */
export type SkillListingMode = 'none' | 'names' | 'short' | 'full';

export interface SkillsConfig {
  /**
   * 是否在 agent 模式下将 skills 目录注入系统提示词。
   * false = 完全不注入任何 skill 条目。
   */
  enabled: boolean;

  /**
   * 全局默认展示模式，作用于所有未被 collectionModes 覆盖的集合。
   */
  listingMode: SkillListingMode;

  /**
   * 被整体禁用的集合名称列表。
   * 集合名 = skills/ 子目录名，如 "scientific"。
   * 根目录直属技能的集合名固定为 "skills"。
   */
  disabledCollections: string[];

  /**
   * 被单独禁用的技能列表。
   * - 集合内技能格式："{collection}/{skill-name}"，如 "scientific/matplotlib"
   * - 根目录技能格式："{skill-name}"，如 "bilibili-live"
   */
  disabledSkills: string[];

  /**
   * 每个集合的展示模式覆盖。
   * key = 集合名（'skills' 表示根目录直属技能）
   * value = 该集合的展示模式，优先级高于全局 listingMode
   */
  collectionModes: Record<string, SkillListingMode>;
}

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
      _cachedConfig = { ...DEFAULT_SKILLS_CONFIG, ...JSON.parse(stored) };
      return _cachedConfig;
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

/**
 * 使缓存失效（用于测试或需要强制重新读取的场景）。
 */
export function invalidateSkillsConfigCache(): void {
  _cachedConfig = null;
}
