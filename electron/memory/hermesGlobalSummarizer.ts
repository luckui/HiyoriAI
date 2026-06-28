/**
 * Hermes 风格的全局记忆精炼器
 * 
 * 相比旧版单一字符串记忆，采用结构化分块：
 *   - USER (用户画像): 偏好、习惯、沟通风格
 *   - MEMORY (环境配置): 系统信息、工具特性、项目约定
 * 
 * 每个分块使用条目式管理（§ 分隔），而非流水账段落。
 */

import type { LLMProviderConfig } from '../ai.config';
import type { MemoryFragment } from '../db';
import type { GlobalMemoryConfig } from './types';
import { fetchCompletion } from '../llmClient';
import { stripThinkTags } from '../utils/textUtils';
import { toolRegistry } from '../tools';

// ── 工具名称验证 ────────────────────────────────────────────

/**
 * 检查记忆条目是否包含虚构的工具名
 * 
 * @param entry - 记忆条目
 * @returns true 表示条目有效（不包含虚构工具）
 */
function validateToolNamesInEntry(entry: string): boolean {
  // 运行时获取真实工具列表（无需手动运行脚本）
  const availableTools = toolRegistry.getToolNames();
  
  // 提取所有可能的工具名（形如 xxx_yyy 的标识符）
  const toolPattern = /\b([a-z_]+_[a-z_]+)\b/g;
  const matches = entry.match(toolPattern);
  
  if (!matches) return true; // 没有工具名引用，通过验证
  
  // 检查每个匹配的标识符是否在真实工具列表中
  for (const match of matches) {
    // 如果这个标识符看起来像工具名但不在列表中，标记为虚构
    if (!availableTools.has(match)) {
      // 常见虚构工具名模式
      const fakeToolPatterns = [
        'bilibili_', 'web_element_', 'web_page_', 'web_search_',
        'api_call', 'http_request', 'search_engine'
      ];
      
      if (fakeToolPatterns.some(pattern => match.startsWith(pattern))) {
        console.warn(`⚠️ [Hermes] 检测到虚构工具名："${match}" 在条目: ${entry.slice(0, 50)}...`);
        return false;
      }
    }
  }
  
  return true;
}

// ── Hermes 风格提示词 ────────────────────────────────────────

const HERMES_SYSTEM_PROMPT = `你是一个长期记忆整理助手。你的任务是维护关于用户的结构化记忆档案，分为两个部分：

1. **USER（用户画像）**：记录用户的身份、偏好、习惯、沟通风格
2. **MEMORY（环境配置）**：记录系统环境、工具特性、项目约定、经验教训

## 格式要求

输出 JSON 格式：
\`\`\`json
{
  "user": ["条目1", "条目2"],
  "memory": ["条目1", "条目2"]
}
\`\`\`

## 内容要求

### USER（用户画像）应包含：
- 用户的基本信息（昵称、角色、身份）
- 沟通渠道和联系方式
- 工作/学习习惯（活跃时间、偏好的工作方式）
- 用户偏好（喜欢简洁回复、认可助手能力等）
- 期望和反复纠正（"不要做XX"、"记得做YY"）

### MEMORY（环境配置）应包含：
- 当前使用的 LLM 提供商和模型
- 可用工具及其特性（限流、错误处理、已知问题）
  **⚠️ 工具名必须真实存在**：
  - 如果上下文中有 <function_calls> 标签，从中提取真实工具名（如 browser_open, memory）
  - 如果上下文中没有工具调用记录，不要推测或编造工具名
  - 禁止记录虚构工具（如 bilibili_search, web_element_operation 等不存在的工具）
- 系统配置和项目结构（路径、框架、命名规范）
- 程序化知识（调试经验、失败教训）

## 关键原则（来自 Hermes Agent MEMORY_GUIDANCE）

### ✅ 应该记录的（优先级从高到低）
1. **用户偏好和反复纠正**（"用户不喜欢冗长回复"）← 最有价值！
2. **环境事实和工具特性**（"npm 是首选包管理器"）
3. **程序化知识**（"B站搜索API有限流"）

### ❌ 禁止记录的
- 任务进度（"正在查询米哈游招聘"）
- 会话结果（"已完成XX查询"）
- 完成工作日志（"2026年4月14日查询了上海天气"）
- 临时 TODO 状态（"用户说要休息一下"）
- 临时情绪状态（"用户曾表示疲惫"）
- 实时环境快照（"助手当前桌面为..."）

**记忆的核心价值**：让用户不用再重复说的那些信息。

## 条目编写规范

### 好的条目（紧凑、信息密集）
- "Discord 昵称为 louis066505，频道 ID 1484202499320578170"
- "身份为学生，工作习惯：晚上 20:00-24:00 活跃"
- "当前 LLM 提供商：豆包 Seed (doubao-seed-2-0-pro-260215)"
- "B站搜索使用 browser_open + browser_find 工具组合"
- "浏览器工具：browser_open、browser_click、browser_screenshot 可用"

### 坏的条目（冗长、流水账、虚构）
- "用户曾在2026年4月14日查询了上海的天气情况"（会话日志）
- "用户表示疲惫，助手建议其休息放松"（临时状态）
- "助手当前桌面为火山方舟模型管理网页"（实时快照）
- ❌ "B站搜索API存在限流"（虚构工具，实际是 browser_open）
- ❌ "使用 bilibili_search 工具查询UP主"（不存在的工具名）

## 输出规则

1. **只输出 JSON**，不要任何前缀、后缀、解释
2. **去重**：不要重复已有的条目
3. **简洁**：每个条目 ≤ 80 字
4. **无变化时**：输出 \`{"user": [], "memory": []}\`（空数组）`;

function buildHermesUserPrompt(
  current: { user: string[]; memory: string[] },
  newFragments: MemoryFragment[],
  maxEntriesPerBlock: number
): string {
  const currentUserSection = current.user.length > 0
    ? `【当前 USER（用户画像）】\n${current.user.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : `【当前 USER（用户画像）】\n（尚无用户画像条目）`;

  const currentMemorySection = current.memory.length > 0
    ? `【当前 MEMORY（环境配置）】\n${current.memory.map((e, i) => `${i + 1}. ${e}`).join('\n')}`
    : `【当前 MEMORY（环境配置）】\n（尚无环境配置条目）`;

  const fragmentsSection = newFragments
    .map((f, i) => `片段 ${i + 1}：${f.content}`)
    .join('\n\n');

  return `${currentUserSection}

${currentMemorySection}

【需要整合的新对话记忆片段】
${fragmentsSection}

【任务】
请将新片段中有价值的信息合并进记忆档案。根据内容性质分类：
- 关于用户身份/偏好/习惯 → 加入 USER
- 关于系统/工具/环境 → 加入 MEMORY

【输出格式】
\`\`\`json
{
  "user": ["新增或更新的用户画像条目"],
  "memory": ["新增或更新的环境配置条目"]
}
\`\`\`

注意：
- 每个分块最多 ${maxEntriesPerBlock} 条，超出需合并旧条目
- 已存在的条目无需重复
- 新片段无价值内容时返回空数组
- 只输出 JSON，不要解释`;
}

// ── 污染检测和清理 ────────────────────────────────────────

interface HermesMemoryOutput {
  user: string[];
  memory: string[];
}

function parseHermesOutput(text: string): HermesMemoryOutput | null {
  // 移除思考标签
  let cleaned = stripThinkTags(text);
  
  // 提取 JSON（支持 markdown 代码块包裹）
  const jsonMatch = cleaned.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) || 
                    cleaned.match(/(\{[\s\S]*\})/);
  
  if (!jsonMatch) return null;
  
  try {
    const parsed = JSON.parse(jsonMatch[1]);
    
    // 验证结构
    if (!parsed || typeof parsed !== 'object') return null;
    if (!Array.isArray(parsed.user) || !Array.isArray(parsed.memory)) return null;
    
    // 清理条目（去除空白、过长条目、虚构工具名）
    const cleanEntries = (arr: unknown[]): string[] => 
      arr
        .filter((e): e is string => typeof e === 'string')
        .map(e => e.trim())
        .filter(e => e.length > 0 && e.length <= 200) // 单条目最多 200 字
        .filter(e => !/^(无变化|无新内容|No\s*change)/i.test(e)) // 过滤无效标记
        .filter(e => validateToolNamesInEntry(e)); // 🔥 过滤虚构工具名
    
    return {
      user: cleanEntries(parsed.user),
      memory: cleanEntries(parsed.memory),
    };
  } catch {
    return null;
  }
}

function isValidHermesOutput(output: HermesMemoryOutput): boolean {
  // 至少有一个分块有内容
  if (output.user.length === 0 && output.memory.length === 0) return false;
  
  // 检查是否是提示词回显（英文比例过高）
  const allText = [...output.user, ...output.memory].join(' ');
  const cjk = (allText.match(/[\u4e00-\u9fff]/g) || []).length;
  const ascii = (allText.match(/[A-Za-z]/g) || []).length;
  
  if (cjk < 10) return false; // 中文太少
  if (ascii > 0 && cjk > 0 && ascii / (ascii + cjk) > 0.4) return false; // 英文比例过高
  
  return true;
}

// ── 核心函数 ──────────────────────────────────────────────

/**
 * Hermes 风格的全局记忆精炼（返回结构化条目数组）
 * 
 * @param provider     - LLM 配置
 * @param current      - 当前结构化记忆
 * @param newFragments - 新对话片段
 * @param config       - 配置
 * @returns            - 更新后的结构化记忆，或 null（无变化）
 */
export async function refineStructuredGlobalMemory(
  provider: LLMProviderConfig,
  current: { user: string[]; memory: string[] },
  newFragments: MemoryFragment[],
  config: GlobalMemoryConfig
): Promise<HermesMemoryOutput | null> {
  const maxEntriesPerBlock = 10; // 每个分块最多 10 条（约 800 字）

  const messages = [
    { role: 'system' as const, content: HERMES_SYSTEM_PROMPT },
    { 
      role: 'user' as const, 
      content: buildHermesUserPrompt(current, newFragments, maxEntriesPerBlock) 
    },
  ];

  const TIMEOUT_MS = 60_000; // 60 秒超时（推理模型需要更久）
  const data = await fetchCompletion(
    provider,
    messages,
    undefined,
    AbortSignal.timeout(TIMEOUT_MS),
    {
      maxTokens: config.refinementMaxTokens,
      temperature: 0.3,
    },
  );
  const rawText = data.choices?.[0]?.message?.content || '';
  
  if (!rawText.trim()) return null;

  // 解析输出
  const parsed = parseHermesOutput(rawText);
  if (!parsed) {
    console.warn('[HermesMemory] LLM 输出无法解析为 JSON，原始输出:', rawText.slice(0, 200));
    return null;
  }

  // 验证输出
  if (!isValidHermesOutput(parsed)) {
    console.warn('[HermesMemory] LLM 输出未通过验证（可能是提示词回显）');
    return null;
  }

  // 合并逻辑：新条目追加，旧条目保留（去重）
  const mergedUser = Array.from(new Set([...current.user, ...parsed.user]));
  const mergedMemory = Array.from(new Set([...current.memory, ...parsed.memory]));

  // 容量控制：超出最大条目数时，保留最新的
  const finalUser = mergedUser.slice(-maxEntriesPerBlock);
  const finalMemory = mergedMemory.slice(-maxEntriesPerBlock);

  // 检查是否有实际变化
  const hasChange = 
    finalUser.length !== current.user.length ||
    finalMemory.length !== current.memory.length ||
    finalUser.some((e, i) => e !== current.user[i]) ||
    finalMemory.some((e, i) => e !== current.memory[i]);

  if (!hasChange) return null;

  return {
    user: finalUser,
    memory: finalMemory,
  };
}
