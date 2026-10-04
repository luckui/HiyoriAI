/**
 * 律动的身体链：由一个节拍相位同时驱动躯干、肩、头、眼睛。
 *
 * 不是给每个部位各挂一个弹簧 —— 那样各动各的，看着散。人跟着音乐晃的规律是：
 *
 * 1. 重心左右换，走的是一条 U 形弧线：摆到两侧时最高，并在两侧多停留一会儿；
 *    经过中间时最低、最快，而且正好踩在拍子上（「左晃、右晃、中间沉一下」）。
 * 2. 由躯干带动，头跟在后面：躯干先倾，头晚几十毫秒才跟着歪过去；
 *    点头也落在躯干下沉之后。时间差按毫秒算，不随速度变。
 * 3. 眼睛反向补偿：头转向一侧时眼珠往回转，视线一直留在观众身上。
 * 4. 能量分层：音乐轻时只点头；够响、够确定时才加上左右摆。
 *
 * 输出是按「半个参数范围」归一化的量，正负号遵循 Cubism 标准参数的约定。
 */

import { clamp } from './dynamics';

/** 躯干之后，头部侧倾/转向晚多少：跟随感的来源 */
const HEAD_LAG_MS = 70;
/** 点头晚于躯干下沉多少 */
const NOD_LAG_MS = 45;
/** 两侧停留的程度：越大越「挂」在两侧，经过中间越快。太大像挂在弹簧上来回荡 */
const SIDE_HANG = 0.9;

export interface GrooveFrame {
  /** 重心左右 [-1, 1]，拍点上为 0 */
  side: number;
  /** 下沉 [-1, 0]，拍点上最低，两侧最高 */
  bob: number;
  torsoRoll: number;
  torsoYaw: number;
  torsoBend: number;
  shoulder: number;
  headRoll: number;
  headYaw: number;
  headNod: number;
  eyeX: number;
}

/** 左右摆：两侧停留、中间快速经过 */
function sideAt(beats: number, cycleBeats: number): number {
  return Math.tanh(SIDE_HANG * Math.sin((2 * Math.PI * beats) / cycleBeats)) / Math.tanh(SIDE_HANG);
}

/** 每拍一次下沉：拍点附近陡，拍间平 */
function bobAt(beats: number): number {
  return -(((1 + Math.cos(2 * Math.PI * beats)) / 2) ** 2);
}

/**
 * 摇滚式的一下：拍点前快速沉下去（最后 0.3 拍），拍点上最低，之后慢慢抬回来（0.7 拍）。
 * 对称的起伏像在水里浮，快下慢上才有「砸在拍子上」的劲儿
 */
function pumpAt(beats: number): number {
  const u = beats - Math.floor(beats);
  return u < 0.7
    ? -(Math.cos((Math.PI / 2) * (u / 0.7)) ** 2)
    : -(Math.sin((Math.PI / 2) * ((u - 0.7) / 0.3)) ** 2);
}

/**
 * @param beats   连续节拍位置（整数为拍点，已含延迟补偿）
 * @param periodMs 一拍多长
 * @param energy  律动强度 [0, 1]
 */
export function grooveFrame(beats: number, periodMs: number, energy: number): GrooveFrame {
  const e = clamp(energy, 0, 1);
  // 快歌四拍一个来回，免得晃得像抽搐；慢歌和中速两拍一个来回，每次经过中间正好踩拍
  const cycleBeats = periodMs < 430 ? 4 : 2;
  // 左右摆要等能量够了才出来：轻音乐只点头
  const swing = e * clamp((e - 0.2) / 0.5, 0, 1);
  const headLag = HEAD_LAG_MS / periodMs;
  const nodLag = NOD_LAG_MS / periodMs;

  const side = sideAt(beats, cycleBeats);
  const headSide = sideAt(beats - headLag, cycleBeats);
  const bob = bobAt(beats);

  return {
    side: swing * side,
    bob: e * bob,
    // 左右只是带一点，主轴是上下：上身每拍往前送，头晚一点更狠地点下去，再慢慢抬起
    torsoRoll: 0.4 * swing * side,
    torsoYaw: 0.12 * swing * side,
    torsoBend: 0.38 * e * pumpAt(beats),
    shoulder: 0.6 * e * bob,
    // 头比躯干多歪一点（跟随时的过冲），并且朝倾斜的一侧略转
    headRoll: 0.3 * swing * headSide,
    headYaw: 0.1 * swing * headSide,
    headNod: 0.45 * e * pumpAt(beats - nodLag),
    // 头往一边转，眼珠往回转，视线留在观众身上
    eyeX: -0.35 * swing * headSide,
  };
}
