/**
 * 每个表情的「表演」：一张脸 + 一个姿态 + 一种眼神 + 一股劲儿。
 *
 * 只换脸的表情看起来像贴图。人害羞时会低头、歪头、眼睛躲开、动作变小；
 * 惊讶时先往后一仰、眼睛睁大，说话也更冲。这里把这些写成数据，由灵动层叠加。
 *
 * 数值按灵动层的约定：1 = 从模型的默认值推到最大值，-1 = 推到最小值。
 * 所以「平常脸」本来就微笑的模型（Hiyori 的嘴型默认就在最大值），happy 的嘴不会再变，
 * sad 的嘴会一路撇下去 —— 这是对的。眉毛的数值沿用了原先在 Hiyori 上调过的表情预设。
 *
 * 在 Hiyori 上逐个参数推到极值实拍（参数图谱）得出的经验：
 * - 看得出来的只有脸红、眼睛开合、笑眼配半闭眼；眉毛被刘海挡住，嘴太小，变化都很弱；
 * - 笑眼（EyeSmile）只改变眼睛闭合时的弧度，眼睛全睁时几乎看不出来，要配合眼睛半闭；
 * - 所以情绪主要靠肢体语言传达：低头、扭头、歪头、视线躲开或斜瞥 —— 换任何模型都有效。
 */

import type { Expression } from '../../shared/expressions';

export type FaceParam =
  | 'ParamBrowLY' | 'ParamBrowRY' | 'ParamBrowLAngle' | 'ParamBrowRAngle' | 'ParamBrowLForm' | 'ParamBrowRForm'
  | 'ParamEyeLSmile' | 'ParamEyeRSmile' | 'ParamEyeLOpen' | 'ParamEyeROpen'
  | 'ParamMouthForm' | 'ParamCheek';

export interface Acting {
  /** 强度为 1 时叠加到脸上的量 */
  face: Partial<Record<FaceParam, number>>;
  /**
   * 头和身体的姿态：低头为负的 pitch；roll、yaw（以及身体的 bodyYaw、bodyRoll）的方向
   * 每次随机选一边，头和身体朝同一边
   */
  posture: { pitch?: number; roll?: number; yaw?: number; bodyYaw?: number; bodyRoll?: number };
  /** 眼神倾向：害羞往下往旁边躲，思考往斜上方看；x 的方向随 roll 同一边 */
  gaze?: { x: number; y: number };
  /** 说话动作的幅度倍数：兴奋时点头更大，难过时几乎不动 */
  energy: number;
  /** 表情刚出来时头的一下（惊讶往后一仰）；之后自己弹回来 */
  onset?: { pitch: number };
}

/** 左右两侧取同一个值 */
const both = (part: 'Brow' | 'Eye', axis: 'Y' | 'Angle' | 'Form' | 'Smile' | 'Open', value: number) =>
  ({ [`Param${part}L${axis}`]: value, [`Param${part}R${axis}`]: value }) as Partial<Record<FaceParam, number>>;

export const ACTING: Record<Expression, Acting> = {
  neutral: { face: {}, posture: {}, energy: 1 },
  happy: {
    face: { ...both('Brow', 'Y', 0.35), ...both('Brow', 'Form', 0.2), ...both('Eye', 'Smile', 1), ...both('Eye', 'Open', -0.5), ParamMouthForm: 0.9, ParamCheek: 0.5 },
    posture: { pitch: 0.08, roll: 0.08 },
    energy: 1.2,
  },
  excited: {
    face: { ...both('Brow', 'Y', 0.6), ...both('Eye', 'Open', 0.7), ...both('Eye', 'Smile', 0.25), ParamMouthForm: 1, ParamCheek: 0.4 },
    posture: { pitch: 0.12 },
    energy: 1.7,
    onset: { pitch: 0.25 },
  },
  surprised: {
    face: { ...both('Brow', 'Y', 1), ...both('Eye', 'Open', 1), ParamMouthForm: -0.6 },
    posture: { pitch: 0.2, bodyRoll: 0.15 },
    energy: 1.1,
    onset: { pitch: 0.6 },
  },
  // 脸红拉满、低头侧过脸、眼睛半闭往下躲，偶尔偷看一眼（见 conversation.ts）
  shy: {
    face: { ...both('Brow', 'Y', 0.15), ...both('Brow', 'Angle', -0.4), ...both('Brow', 'Form', -0.2), ...both('Eye', 'Smile', 0.8), ...both('Eye', 'Open', -0.45), ParamMouthForm: 0.4, ParamCheek: 1 },
    posture: { pitch: -0.35, roll: 0.2, yaw: 0.25, bodyYaw: 0.35 },
    gaze: { x: 0.5, y: -0.4 },
    energy: 0.5,
  },
  sad: {
    face: { ...both('Brow', 'Y', -0.25), ...both('Brow', 'Angle', -0.9), ...both('Brow', 'Form', -0.5), ...both('Eye', 'Open', -0.45), ParamMouthForm: -1 },
    posture: { pitch: -0.35, roll: 0.08 },
    gaze: { x: 0, y: -0.4 },
    energy: 0.4,
  },
  // 「哼」：把头扭向一边、下巴微抬、眼睛半闭，眼珠转回来斜瞥着你（gaze.x 与头的方向相反）
  angry: {
    face: { ...both('Brow', 'Y', -0.5), ...both('Brow', 'Angle', 0.9), ...both('Brow', 'Form', -0.7), ...both('Eye', 'Open', -0.45), ParamMouthForm: -1, ParamCheek: 0.7 },
    posture: { pitch: 0.12, roll: -0.1, yaw: 0.45, bodyYaw: 0.4 },
    gaze: { x: -0.6, y: 0 },
    energy: 1.2,
    onset: { pitch: -0.12 },
  },
  smug: {
    face: { ParamBrowLY: 0.25, ParamBrowRY: 0.05, ...both('Brow', 'Form', 0.2), ...both('Eye', 'Smile', 0.6), ...both('Eye', 'Open', -0.4), ParamMouthForm: 0.8 },
    posture: { pitch: 0.18, roll: 0.25, yaw: 0.12 },
    gaze: { x: -0.25, y: 0 },
    energy: 0.9,
  },
  thinking: {
    face: { ParamBrowLY: 0.3, ParamBrowRY: -0.2, ParamBrowLAngle: 0.4, ParamBrowRAngle: -0.3, ...both('Eye', 'Open', -0.15), ParamMouthForm: -0.4 },
    posture: { roll: 0.2, yaw: 0.15 },
    gaze: { x: 0.5, y: 0.55 },
    energy: 0.6,
  },
  // 疑问：头明显歪向一边，眼睛睁大
  curious: {
    face: { ...both('Brow', 'Y', 0.5), ...both('Eye', 'Open', 0.6), ParamMouthForm: 0.15 },
    posture: { pitch: 0.05, roll: 0.5, bodyRoll: 0.2 },
    energy: 1,
  },
};
