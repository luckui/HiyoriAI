# Skills 目录

此目录遵循 [Agent Skills 开放标准](https://agentskills.io)，是 Hiyori agent 的 skill 扩展系统。

---

## 核心概念

**Skill = 一份结构化的 Markdown 技能说明**，AI 在需要时按需加载，获得使用某工具或遵循某流程的完整指导。

Hiyori 的 skill 系统与以下外部 Agent 平台使用相同标准：

| 外部平台 | Skills 目录 |
|---|---|
| Claude Code | `~/.claude/skills/` |
| Hermes Agent | `~/.hermes/skills/` |
| Gemini CLI | 自动扫描 |
| Copilot CLI | 插件安装 |
| **Hiyori** | `electron/skills/`（本目录） |

只需把 SKILL.md 放入本目录，Hiyori 的 AI 即可自动识别并使用。

---

## 目录结构

```
skills/
  skill-name/
    SKILL.md          ← 必须。YAML frontmatter + Markdown 正文
    scripts/          ← 可选。辅助脚本
    assets/           ← 可选。图片、示例数据等
  category/
    skill-name/
      SKILL.md        ← 支持嵌套分类
```

## SKILL.md 格式

```markdown
---
name: skill-name          # 必须，小写 + 连字符
description: 一句话描述   # 必须，≤100 字，显示在系统提示目录中
version: 1.0.0            # 可选
requires_cli: command     # 可选，需要预装的 CLI 工具名（用于验证）
---

# Skill 标题

正文内容（Markdown 格式）。
这部分只在 AI 调用 read_skill(topic="skill-name") 时才加载（渐进式披露）。
```

---

## 已安装 Skills 注册表

| Skill 名称 | 类型 | 来源 | 需要 CLI | 状态 |
|---|---|---|---|---|
| bilibili-live | 工作流 | 内置 | 无 | ✅ |

> 添加新 skill 后，请在此表更新一行。

---

## 安装外部 Skills（操作指南）

### 方式一：CLI-Anything 类 Skill（需安装 CLI 工具）

以 `cli-anything-chromadb` 为例：

```bash
# 1. 安装 CLI 工具
pip install cli-anything-chromadb

# 2. 复制 SKILL.md（从 CLI-Anything 仓库）
# 源：CLI-Anything-main/chromadb/agent-harness/cli_anything/chromadb/skills/SKILL.md
# 目标：electron/skills/cli-anything-chromadb/SKILL.md
```

安装后 Hiyori 的 AI 即可通过 `run_command` 工具调用 `cli-anything-chromadb --json ...`。

### 方式二：纯文档类 Skill（scientific-agent-skills、superpowers 等）

直接复制 SKILL.md 文件夹即可，无需安装额外软件：

```bash
# 示例：添加 superpowers 中的写作技巧 skill
cp -r superpowers-main/skills/writing-skills/ electron/skills/writing-skills/
```

### 方式三：npx 自动安装（CLI-Anything 官方支持）

```bash
npx skills add HKUDS/CLI-Anything --skill chromadb -g -y
# 注：-g 会安装到全局 ~/.claude/skills/，需手动复制到本目录
```

---

## 兼容性

- **本目录**（skills/）：Agent Skills 标准格式，`SKILL.md` 文件

`read_skill` 只扫描 Agent Skills 标准格式。

---

## 验证已安装的 Skills

在项目根目录运行：

```bash
node scripts/verify-skills.js
```

验证内容：
- SKILL.md 存在且格式合法（有 name + description）
- 如有 `requires_cli` 字段，检查该命令是否可执行
- 输出所有 skill 的摘要目录
