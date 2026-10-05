/**
 * 巡逻的「看图」：把封面、弹幕最多那一刻的画面交给能看图的模型，描述成一小段文字，
 * 再作为素材交给她说话用的模型（说话的模型不用换，也不用支持图片）。
 *
 * 用哪个模型：设置里指定的（live.patrol.visionProvider）；没指定就从已配置的模型里挑一个名字像视觉模型的
 * （deepseek-flash、doubao-seed、*-vision、*-vl、gpt-4o …）。调用失败一次就本次运行不再用它，没有可用的就跳过看图。
 */

import aiConfig from '../ai.config';
import { fetchCompletion } from '../llmClient';
import type { LLMProviderConfig } from '../ai.config';
import type { ContentPart } from '../tools/types';
import { cleanText } from '../streaming/danmuSafety';

const VISION_HINT = /deepseek-flash|seed|vision|[-_]vl|vl[-_]|gpt-4o|gpt-4\.1|gpt-5|gemini|claude|qwen.*vl|glm-4v|4v/i;

/** 这次运行里调用失败过的模型 */
const broken = new Set<string>();

export interface VisionImage {
  label: string;
  /** data:image/jpeg;base64,... */
  dataUrl: string;
}

function pickProvider(preferred?: string): { key: string; provider: LLMProviderConfig } | null {
  const providers = aiConfig.providers as Record<string, LLMProviderConfig>;
  const usable = (key: string) => {
    const p = providers[key];
    return p && p.apiKey && !broken.has(key) ? { key, provider: p } : null;
  };
  if (preferred) return usable(preferred);
  const active = usable(aiConfig.activeProvider);
  if (active && VISION_HINT.test(active.provider.model)) return active;
  for (const key of Object.keys(providers)) {
    const found = usable(key);
    if (found && VISION_HINT.test(found.provider.model)) return found;
  }
  return null;
}

/** 有没有能看图的模型（控制台显示用） */
export function visionModelName(preferred?: string): string | null {
  const picked = pickProvider(preferred);
  return picked ? `${picked.provider.name ?? picked.key}（${picked.provider.model}）` : null;
}

/** 描述几张图；没有可用的视觉模型或失败时返回 null */
export async function describeImages(images: VisionImage[], context: string, preferred?: string): Promise<string | null> {
  if (!images.length) return null;
  const picked = pickProvider(preferred);
  if (!picked) return null;
  const content: ContentPart[] = [
    {
      type: 'text',
      text: [
        `这是 B 站视频《${cleanText(context).slice(0, 60)}》的几张图，依次是：${images.map((i) => i.label).join('、')}。`,
        '用中文客观描述每张图里看得到的东西：场景、人物在做什么、画面上的文字、风格。不要猜真实人物是谁，不要评价好坏。',
        '一共不超过 150 字，直接输出描述。',
      ].join('\n'),
    },
    ...images.map((img) => ({ type: 'image_url' as const, image_url: { url: img.dataUrl, detail: 'low' as const } })),
  ];
  try {
    const data = await fetchCompletion(picked.provider, [{ role: 'user', content }], undefined, AbortSignal.timeout(30_000), { disableThinking: true, maxTokens: 400 });
    const text = data.choices[0]?.message.content?.trim() ?? '';
    return text ? cleanText(text).slice(0, 220) : null;
  } catch (err) {
    console.warn(`[PatrolVision] ${picked.key} 看图失败，这次运行不再用它:`, (err as Error).message);
    broken.add(picked.key);
    return null;
  }
}
