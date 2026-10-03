/**
 * 表情词表：主进程（表情导演、manage_live2d 工具）和渲染层（表演）共用这一份。
 *
 * 每个表情在渲染层对应一套「表演」：脸、头的姿态、视线倾向、动作幅度（见
 * src/liveliness/acting.ts），不只是换一张脸。说明文字给表情导演看，让它知道每个
 * 表情什么时候用。
 */

export const EXPRESSIONS = [
  'neutral', 'happy', 'excited', 'surprised', 'shy',
  'sad', 'angry', 'smug', 'thinking', 'curious',
] as const;

export type Expression = typeof EXPRESSIONS[number];

export interface ExpressionCue {
  expression: Expression;
  /** 0–1：0.3 是淡淡的，0.6 是明显的，1 是夸张的 */
  intensity: number;
}

export const EXPRESSION_GUIDE: Record<Expression, string> = {
  neutral: '平常地陈述、解释、交代事情',
  happy: '开心、愉快、感谢、温柔地笑',
  excited: '兴奋、激动、跃跃欲试、强烈赞叹',
  surprised: '惊讶、意外、难以置信',
  shy: '害羞、不好意思、被夸、尴尬、撒娇',
  sad: '难过、失落、抱歉、心疼、遗憾',
  angry: '生气、不满、嫌弃、吐槽（可爱地鼓起脸，不是凶狠）',
  smug: '得意、调皮、坏笑、捉弄人、自信满满',
  thinking: '思考、犹豫、拿不准、回忆',
  curious: '好奇、发问、感兴趣地追问',
};

export function isExpression(value: unknown): value is Expression {
  return typeof value === 'string' && (EXPRESSIONS as readonly string[]).includes(value);
}
