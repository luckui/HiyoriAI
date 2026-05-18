#!/usr/bin/env node
/**
 * verify-skills.js
 *
 * 验证 electron/skills/ 目录下所有 Skills 的格式合法性，
 * 并检查依赖的 CLI 工具是否已安装。
 *
 * 用法：node scripts/verify-skills.js
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const SKILLS_DIR = path.join(__dirname, '..', 'electron', 'skills');

// ── 颜色输出 ──────────────────────────────────────────────────────────────────
const green  = (s) => `\x1b[32m${s}\x1b[0m`;
const red    = (s) => `\x1b[31m${s}\x1b[0m`;
const yellow = (s) => `\x1b[33m${s}\x1b[0m`;
const bold   = (s) => `\x1b[1m${s}\x1b[0m`;

// ── Frontmatter 解析 ──────────────────────────────────────────────────────────
function parseFrontmatter(content) {
  if (!content.startsWith('---')) return {};
  const end = content.indexOf('\n---', 3);
  if (end === -1) return {};
  const yaml = content.slice(3, end);
  const result = {};
  for (const line of yaml.split('\n')) {
    const m = line.match(/^([\w-]+)\s*:\s*(.+)/);
    if (m) result[m[1].trim()] = m[2].trim().replace(/^['"]|['"]$/g, '');
  }
  return result;
}

// ── CLI 检查 ──────────────────────────────────────────────────────────────────
function isCliAvailable(cmd) {
  try {
    execSync(`where ${cmd}`, { stdio: 'ignore' });
    return true;
  } catch {
    try {
      execSync(`which ${cmd}`, { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

// ── Skill 扫描 ────────────────────────────────────────────────────────────────
function scanSkills(dir, prefix = '') {
  const results = [];
  if (!fs.existsSync(dir)) return results;

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.') || entry.name === 'README.md') continue;
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      const skillMdPath = path.join(fullPath, 'SKILL.md');
      if (fs.existsSync(skillMdPath)) {
        results.push({ skillMdPath, dirName: entry.name });
      } else {
        // 可能是 category 目录，递归扫描
        results.push(...scanSkills(fullPath, entry.name));
      }
    }
  }
  return results;
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────
function main() {
  console.log(bold('\n🔍 Hiyori Skills 验证工具\n'));
  console.log(`扫描目录: ${SKILLS_DIR}\n`);

  const skills = scanSkills(SKILLS_DIR);

  if (skills.length === 0) {
    console.log(yellow('⚠  未找到任何 Skills（skills/ 目录为空）'));
    return;
  }

  let passCount = 0;
  let failCount = 0;
  let warnCount = 0;

  const rows = [];

  for (const { skillMdPath, dirName } of skills) {
    const errors = [];
    const warnings = [];

    let content;
    try {
      content = fs.readFileSync(skillMdPath, 'utf-8');
    } catch (e) {
      errors.push('无法读取 SKILL.md');
      rows.push({ dirName, name: '?', description: '?', cliOk: '?', errors, warnings });
      failCount++;
      continue;
    }

    const fm = parseFrontmatter(content);

    // 必须字段检查
    if (!fm.name) errors.push('缺少 name 字段');
    if (!fm.description) errors.push('缺少 description 字段');

    // description 长度建议
    if (fm.description && fm.description.length > 150) {
      warnings.push(`description 过长（${fm.description.length} 字，建议 ≤100）`);
    }

    // CLI 依赖检查
    let cliStatus = '—';
    if (fm.requires_cli) {
      if (isCliAvailable(fm.requires_cli)) {
        cliStatus = `✅ ${fm.requires_cli}`;
      } else {
        cliStatus = `❌ ${fm.requires_cli}（未安装）`;
        warnings.push(`CLI 未安装: ${fm.requires_cli}`);
      }
    }

    const hasErrors = errors.length > 0;
    if (hasErrors) failCount++; else passCount++;
    if (warnings.length > 0) warnCount++;

    rows.push({
      dirName,
      name: fm.name || dirName,
      description: (fm.description || '').slice(0, 60),
      version: fm.version || '—',
      cliStatus,
      errors,
      warnings,
    });
  }

  // 输出表格
  console.log(bold('Skills 清单：\n'));
  for (const row of rows) {
    const icon = row.errors.length > 0 ? red('✗') : green('✓');
    console.log(`${icon}  ${bold(row.name)}  (${row.dirName})`);
    console.log(`   ${yellow('描述：')} ${row.description || red('（缺失）')}`);
    console.log(`   ${yellow('版本：')} ${row.version}`);
    if (row.cliStatus !== '—') {
      console.log(`   ${yellow('CLI：')} ${row.cliStatus}`);
    }
    for (const e of row.errors)   console.log(`   ${red('错误：')} ${e}`);
    for (const w of row.warnings) console.log(`   ${yellow('警告：')} ${w}`);
    console.log();
  }

  // 汇总
  console.log('─'.repeat(50));
  console.log(`共 ${skills.length} 个 Skills：${green(passCount + ' 通过')}  ${failCount > 0 ? red(failCount + ' 失败') : '0 失败'}  ${warnCount > 0 ? yellow(warnCount + ' 有警告') : '0 警告'}`);
  console.log();

  if (failCount > 0) process.exit(1);
}

main();
