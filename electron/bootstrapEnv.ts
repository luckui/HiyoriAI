/**
 * 启动时加载 .env —— 必须是 main.ts 的第一个 import。
 *
 * 打包后各模块的顶层代码按 import 顺序执行，ai.config / runtimeConfig 等模块在加载时就读取 process.env，
 * 所以 .env 必须在它们之前、以独立模块的形式加载（写在 main.ts 函数体里会晚于所有被 import 的模块）。
 */

import * as dotenv from 'dotenv';
import { app } from 'electron';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

/**
 * 持久化 .env 文件路径：
 *   dev  → 项目根目录（便于直接编辑）
 *   打包 → app.getPath('userData')（系统用户数据目录，跨版本升级不丢失）
 *          Windows: %AppData%\<AppName>\.env
 */
function getEnvFilePath(): string {
  return app.isPackaged
    ? join(app.getPath('userData'), '.env')
    : join(app.getAppPath(), '.env');
}

/**
 * 启动时环境变量合并：
 *   1. 优先读取 userData/.env（用户自定义值）
 *   2. 对 userData/.env 里缺失的键，从 resources/.env.defaults（打包时的项目 .env）补充
 *   这样升级后新增的配置项能自动填入默认值，同时不覆盖用户已有配置。
 */
function migrateEnvFile(): void {
  if (!app.isPackaged) return;
  const userDataEnv = getEnvFilePath();
  const defaultsPath = join(process.resourcesPath, '.env.defaults');

  // 读取默认值（打包时的 .env）
  const defaults: Record<string, string> = {};
  if (existsSync(defaultsPath)) {
    try {
      for (const line of readFileSync(defaultsPath, 'utf-8').split('\n')) {
        const m = line.match(/^([^#=\s][^=]*)=(.*)$/);
        if (m) defaults[m[1].trim()] = m[2].trim();
      }
    } catch { /* 读取失败忽略 */ }
  }

  // 读取用户配置（可能不存在）
  let userLines: string[] = [];
  const userKeys = new Set<string>();
  if (existsSync(userDataEnv)) {
    try {
      userLines = readFileSync(userDataEnv, 'utf-8').split('\n');
      for (const line of userLines) {
        const m = line.match(/^([^#=\s][^=]*)=/);
        if (m) userKeys.add(m[1].trim());
      }
    } catch { /* 读取失败从空开始 */ }
  }

  // 把 defaults 里有但 userData/.env 里缺的键追加进去
  const missing = Object.entries(defaults).filter(([k]) => !userKeys.has(k));
  if (missing.length > 0 || userLines.length === 0) {
    for (const [k, v] of missing) userLines.push(`${k}=${v}`);
    try {
      mkdirSync(app.getPath('userData'), { recursive: true });
      writeFileSync(userDataEnv, userLines.filter(l => l !== '').join('\n') + '\n', 'utf-8');
      if (missing.length > 0) {
        console.info(`[Config] 补充了 ${missing.length} 个缺失配置项:`, missing.map(([k]) => k).join(', '));
      }
    } catch (e) {
      console.warn('[Config] 写入 userData/.env 失败:', (e as Error).message);
    }
  }
}

// 迁移必须在 dotenv.config 之前
migrateEnvFile();
dotenv.config({ path: getEnvFilePath() });
