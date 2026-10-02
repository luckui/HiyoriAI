/**
 * 程序化动画的三个基本件：弹簧、包络、平滑噪声。
 * 都是纯计算，不依赖 Cubism，便于单测和换模型复用。
 */

/**
 * 二阶弹簧。用频率和阻尼比来调，比直接调刚度/阻尼直观：
 * - frequencyHz 越大跟得越紧
 * - dampingRatio < 1 会过冲回弹（「活」的关键），= 1 刚好不回弹
 */
export class Spring {
  value = 0;
  velocity = 0;
  target = 0;
  private readonly stiffness: number;
  private readonly damping: number;
  /** 单位初速度能把弹簧推出多远：用来把「想要的幅度」换算成冲量 */
  private readonly reachPerVelocity: number;

  constructor(frequencyHz: number, dampingRatio: number) {
    const omega = 2 * Math.PI * frequencyHz;
    this.stiffness = omega * omega;
    this.damping = 2 * dampingRatio * omega;
    const zeta = Math.min(dampingRatio, 0.99);
    const root = Math.sqrt(1 - zeta * zeta);
    this.reachPerVelocity = Math.exp(-zeta * Math.atan2(root, zeta) / root) / omega;
  }

  /**
   * 一次性动作（点头、挑眉）：给一个冲量，让弹簧大约偏到 amplitude 再自己弹回来。
   * 用幅度而不是速度来表达，调参时不用管弹簧频率。
   */
  impulse(amplitude: number): void {
    this.velocity += amplitude / this.reachPerVelocity;
  }

  step(dtSec: number): number {
    // 掉帧时 dt 可能很大，分成小步积分，避免数值爆炸
    const steps = Math.max(1, Math.ceil(dtSec * 240));
    const h = dtSec / steps;
    for (let i = 0; i < steps; i++) {
      const accel = this.stiffness * (this.target - this.value) - this.damping * this.velocity;
      this.velocity += accel * h;
      this.value += this.velocity * h;
    }
    return this.value;
  }
}

/** 包络跟随：上升快、下降慢（或反过来），把逐帧抖动的音量变成平滑曲线 */
export class Envelope {
  value = 0;

  constructor(private readonly attackSec: number, private readonly releaseSec: number) {}

  step(input: number, dtSec: number): number {
    const tau = input > this.value ? this.attackSec : this.releaseSec;
    this.value += (input - this.value) * (1 - Math.exp(-dtSec / tau));
    return this.value;
  }
}

/**
 * 确定性的平滑噪声：几条频率互不成整数比的正弦叠加，看起来不重复。
 * 输出约在 [-1, 1]。seed 决定相位，不同通道用不同 seed 就不会同步晃。
 */
export function smoothNoise(timeSec: number, seed: number): number {
  const a = Math.sin(timeSec * 0.31 + seed * 1.7);
  const b = Math.sin(timeSec * 0.73 + seed * 4.1);
  const c = Math.sin(timeSec * 1.37 + seed * 2.3);
  return (a * 0.5 + b * 0.3 + c * 0.2);
}

/** 时域 PCM（Uint8，128 为零点）的均方根，范围 [0, 1] */
export function rmsOfByteTimeDomain(data: Uint8Array): number {
  if (!data.length) return 0;
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    const v = (data[i] - 128) / 128;
    sum += v * v;
  }
  return Math.sqrt(sum / data.length);
}

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, value));
