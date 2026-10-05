/**
 * 弹幕文本特征：只看文字本身，不看是谁发的、什么时候发的。
 * 规则都很粗，目的是把「有话可接」的弹幕和「哈哈哈 / 666 / 表情」分开，具体怎么接交给 LLM。
 */

export interface ChatFeatures {
  /** 问句：在问主播或者问大家 */
  question: boolean;
  /** 叫了她的名字 */
  mentionsHer: boolean;
  /** 对着主播说（「你」「主播」），没点名但是在跟她说话 */
  addressesHer: boolean;
  greeting: boolean;
  /** 没有可接的内容：笑声、666、问号、+1、单字 */
  lowContent: boolean;
  /** 刷屏归类用的键：去掉标点空白、合并重复字，「哈哈哈哈」与「哈哈」相同 */
  trendKey: string;
  /** 去掉 [表情] 后的有效字数 */
  length: number;
  /** 发了 B 站视频（BV 号或 b23 短链）：任何环节里都会排进研究队列 */
  videoLink: boolean;
  /** 想让她看 / 搜某个视频，但没给 BV 号或链接（要引导他发） */
  videoAsk: boolean;
}

const HER_NAMES = /hiyori|ひより|日和/i;
const ADDRESS = /你|主播|老婆|宝宝|姐姐|妹妹/;
const QUESTION = /[?？]\s*$|吗\s*[。!！~～]*$|呢\s*[?？。]*$|什么|怎么|为什么|为啥|咋|多少|哪[里儿个些位]|是不是|能不能|会不会|有没有|要不要|可不可以|好不好|几[点个岁号次]|how|what|why|when|where|who/i;
const GREETING = /^(晚上好|早上好|中午好|下午好|早安|午安|晚安|你好|您好|大家好|hello(?![a-z])|hi(?![a-z])|嗨|哈喽|来了|来啦|我来了|打卡|报道|报到|初见|第一次来)/i;
/** 整条都是这些字符时算没有内容 */
const LOW_CONTENT_CHARS = /^[哈呵嘿嘻h6草艹w？?!！。.…,，~～+＋=0-9啊哦噢嗯额呃呜唔哇诶欸]+$/i;
const LOW_CONTENT_PHRASES = /^(好耶|牛|牛逼|nb|yyds|绝了|笑死|乐|典|确实|对对对|是的|真的|好家伙|可爱|好可爱|awsl|tql|233+|hhh+|xswl|吗喽|啊这)$/i;

const EMOTE = /\[[^\]\s]{1,16}\]/g;
/** 想让她看 / 搜某个视频的说法（没带 BV 号时要引导他发） */
const VIDEO_ASK = [
  /(搜|查|找)(一下|一搜|一查|下|搜|查)/,
  /(看看|看一下|看下|研究|分析|解析|讲讲|锐评|聊聊).{0,14}(视频|这期|那期|新作|投稿|MV|mv|番|up主|UP主|的新)/,
  /(有没有|知道|看过).{0,14}(视频|up主|UP主)/,
  /(帮我|给我|替我).{0,6}(看|搜|查|研究|分析)/,
];

export function stripEmotes(text: string): string {
  return text.replace(EMOTE, '').trim();
}

export function trendKeyOf(text: string): string {
  const stripped = stripEmotes(text);
  // 纯表情的刷屏按表情本身归类
  const base = stripped || text;
  return base
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .replace(/(.)\1+/gu, '$1')
    .slice(0, 24);
}

export function chatFeatures(text: string): ChatFeatures {
  const body = stripEmotes(text);
  const compact = body.replace(/\s+/g, '');
  // 判断有没有内容时连标点符号一起去掉：「&哈哈哈」「！！」也是没内容
  const bare = compact.replace(/[\p{P}\p{S}]+/gu, '');
  const lowContent = bare.length <= 1 || LOW_CONTENT_CHARS.test(bare) || LOW_CONTENT_PHRASES.test(bare);
  return {
    question: !lowContent && QUESTION.test(body),
    mentionsHer: HER_NAMES.test(body),
    addressesHer: ADDRESS.test(body),
    greeting: GREETING.test(compact),
    lowContent,
    videoLink: /BV[0-9A-Za-z]{10}|b23\.tv\//.test(body),
    videoAsk: !/BV[0-9A-Za-z]{10}|b23\.tv\//.test(body) && VIDEO_ASK.some((re) => re.test(body)),
    trendKey: trendKeyOf(text),
    length: [...compact].length,
  };
}
