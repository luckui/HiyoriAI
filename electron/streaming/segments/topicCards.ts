/**
 * 示例环节「话题卡」：从牌组里抽一张，每张聊三拍（抛出并表态 → 往深里说 → 收尾），再抽下一张。
 *
 * 跨场次记住用过的卡（storage.usedAt），两周内用过的排到最后；观众发「换一个」就直接换下一张。
 * 主要用来验证环节框架，也是没有别的素材时撑场子的底牌。
 */

import fs from 'fs';
import type { LiveChatEvent } from '../../../shared/types/live';
import { BUILTIN_TOPIC_CARDS, type TopicCard } from './topicCardDeck';
import type { LiveSegmentPlugin, SegmentBeat, SegmentContext, SegmentDefinition } from './types';

const RECENT_MS = 14 * 24 * 3600_000;
const SKIP = /^(换一个|换个话题|换话题|下一张|下一个话题|跳过)[!！~～。]*$/;

/**
 * 每拍的写法从几种里随机挑（同一步不连着两张卡用同一种）：固定一种写法，十几张卡以后
 * 她就会照着说明念出「我的立场是」「替反方说一句」，整场一个句式。
 */
const STEPS: Array<{ length: SegmentBeat['length']; ways: string[] }> = [
  {
    length: 'normal',
    ways: [
      '开启这个话题：先描述一个大家都熟悉的具体瞬间，再说出你的答案和理由。',
      '开启这个话题：开门见山说出你的答案，然后用一个比喻解释为什么。',
      '开启这个话题：先抛一个有点反常识的看法吸引注意，再解释你为什么这么想。',
      '开启这个话题：从你作为 AI 的独特视角切进去，说出你的答案。可以问观众一个好回答的问题。',
    ],
  },
  {
    length: 'normal',
    ways: [
      '接着往深里说：想象一个极端或好笑的情况，看看你的答案还站不站得住。',
      '接着往深里说：讲一个具体的小场景（可以是你在电脑里看到的、或者观众可能遇到的），让观点更有画面。',
      '接着往深里说：说一个持相反看法的人会怎么想，承认他有道理的地方，再说你为什么还是不改主意。',
      '接着往深里说：把这个话题和直播间、或者你当 AI 主播的日常联系起来。',
    ],
  },
  {
    length: 'short',
    ways: [
      '一句话收尾：落一个让人想截图的结论。',
      '一句话收尾：用自嘲或一个小反转结束。',
      '一句话收尾：给观众留一个小建议或小任务，不要问问题。',
    ],
  },
];

/** 主人自己的牌：userData/live-segments/topic-cards.deck.json */
let extraDeckFile: string | null = null;

export function setTopicCardDeckFile(file: string): void {
  extraDeckFile = file;
}

function loadExtraCards(): TopicCard[] {
  if (!extraDeckFile || !fs.existsSync(extraDeckFile)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(extraDeckFile, 'utf8')) as unknown;
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((c): c is TopicCard => !!c && typeof c.title === 'string' && typeof c.hook === 'string')
      .map((c) => ({ id: String(c.id || c.title), title: c.title.slice(0, 40), hook: c.hook.slice(0, 200) }));
  } catch (err) {
    console.warn('[TopicCards] 读取自定义牌组失败:', (err as Error).message);
    return [];
  }
}

function shuffle<T>(items: T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

class TopicCardsSegment implements LiveSegmentPlugin {
  readonly id = 'topic-cards';
  readonly title = '话题卡';
  readonly layout = 'chat' as const;

  private deck: TopicCard[] = [];
  private card = 0;
  private step = 0;
  /** 刚才是谁要求换卡 */
  private skippedBy: string | null = null;
  /** 这张卡每一步选的写法；lastWay 是上一张卡的，用来避开 */
  private way: Array<number | undefined> = [];
  private lastWay: Array<number | undefined> = [];

  start(ctx: SegmentContext, now: number): void {
    const usedAt = ctx.storage.get<Record<string, number>>('usedAt', {});
    const all = [...BUILTIN_TOPIC_CARDS, ...loadExtraCards()];
    const fresh = shuffle(all.filter((c) => !(now - (usedAt[c.id] ?? 0) < RECENT_MS)));
    // 最近用过的按用的时间先后排在后面
    const stale = all.filter((c) => now - (usedAt[c.id] ?? 0) < RECENT_MS).sort((a, b) => usedAt[a.id] - usedAt[b.id]);
    this.deck = [...fresh, ...stale];
    this.card = 0;
    this.step = 0;
  }

  nextBeat(): SegmentBeat | null {
    const card = this.deck[this.card];
    if (!card) return null;
    // 不放「第几拍」：给了她就会说出「最后一拍啦」
    const material: Record<string, unknown> = { 话题: card.title, 要聊的: card.hook };
    if (this.step === 0 && this.skippedBy) material.换卡的观众 = this.skippedBy;
    const step = STEPS[this.step];
    this.way[this.step] ??= Math.floor(Math.random() * step.ways.length);
    return { instruction: step.ways[this.way[this.step]!], material, length: step.length };
  }

  onSpoken(_beat: SegmentBeat, _text: string, ctx: SegmentContext, now: number): void {
    this.skippedBy = null;
    this.step += 1;
    if (this.step >= STEPS.length) this.finishCard(ctx, now);
  }

  onChat(event: LiveChatEvent, ctx: SegmentContext, now: number): boolean {
    if (!SKIP.test(event.text.trim()) || !this.deck[this.card]) return false;
    this.finishCard(ctx, now);
    this.skippedBy = event.user.masked ? null : event.user.name;
    return true;
  }

  panel() {
    const card = this.deck[this.card];
    return card ? { nowDoing: '话题卡', kind: 'topic-card', data: { title: card.title, step: this.step + 1, steps: STEPS.length } } : null;
  }

  isDone(): boolean {
    return this.card >= this.deck.length;
  }

  async stop(): Promise<void> {
    this.deck = [];
  }

  private finishCard(ctx: SegmentContext, now: number): void {
    const card = this.deck[this.card];
    if (card) ctx.storage.set('usedAt', { ...ctx.storage.get<Record<string, number>>('usedAt', {}), [card.id]: now });
    this.card += 1;
    this.step = 0;
    this.lastWay = this.way;
    // 下一张卡每一步换一种写法
    this.way = STEPS.map((step, i) => {
      const options = step.ways.map((_, k) => k).filter((k) => k !== this.lastWay[i]);
      return options[Math.floor(Math.random() * options.length)];
    });
  }
}

export const topicCardsSegment: SegmentDefinition = {
  id: 'topic-cards',
  title: '话题卡',
  description: '抽话题卡，每张聊三拍：表态、展开、收尾',
  create: () => new TopicCardsSegment(),
};
