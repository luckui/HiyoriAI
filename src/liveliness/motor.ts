/**
 * 灵动层：把「正在放的音乐」和「自己说话的声音」变成头、身体、眼神和眉眼的细小动作。
 *
 * 三条通道，各管各的，最后叠加：
 * - 音乐：节拍时钟驱动一条身体链（见 groove.ts）：躯干带头、头带眼睛，按时间差错开。
 *         律动起来时从待机动画手里接过头和躯干的控制权（authority），停下来再还回去。
 *         强度随「确定是音乐」的把握和响度淡入淡出。
 * - 说话：重读的音节点一下头、挑一下眉、眼睛睁大一点；句间停顿时歪头；
 *         说话越起劲，头的漂移越大。口型也在这里做平滑。
 * - 视线：待机时眼神小幅游移；说话时偶尔看向别处再看回来，头跟着转一点。
 *
 * 输出是按「半个参数范围」归一化的偏移，只用 Cubism 标准参数名，
 * 由模型按各自的参数范围换算后叠加 —— 换模型不用重新调。
 * 这里不碰 Cubism，全部是纯计算，可以单测。
 */

import { BeatClock } from './beatClock';
import { Envelope, Spring, clamp, smoothNoise } from './dynamics';
import { grooveFrame } from './groove';

/** 物理之前叠加：头发、衣服、饰品会被头和身体的动作带着甩起来 */
export const BODY_PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamShoulderY',
  'ParamEyeBallX', 'ParamEyeBallY',
] as const;

/**
 * 律动时由程序接管的参数：待机动画在这些参数上的影响按 authority 淡出。
 * 手臂、手这些程序还不管的部位不在里面，继续由动画驱动。
 */
export const PROGRAM_OWNED_PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamShoulderY',
] as const;

/** 有些模型没按标准命名，模型里找不到标准名时依次试这些 */
export const PARAM_ALIASES: Partial<Record<string, readonly string[]>> = {
  ParamShoulderY: ['ParamShoulder'],
};

/** 表情层之后叠加：表情定住的脸上也还有细微变化 */
export const FACE_PARAMS = [
  'ParamBrowLY', 'ParamBrowRY',
  'ParamEyeLSmile', 'ParamEyeRSmile',
  'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamMouthForm',
] as const;

export type PoseParam = typeof BODY_PARAMS[number] | typeof FACE_PARAMS[number];

export interface Pose {
  /** 参数偏移：1 表示从中点推到极值，模型按自己的参数范围换算 */
  params: Partial<Record<PoseParam, number>>;
  /**
   * 整个模型的平移（模型坐标）：随拍的起伏。只适合半身构图 ——
   * 全身时脚也跟着离地，看起来像在原地跳，所以由模型按当前构图决定用不用
   */
  offsetX: number;
  offsetY: number;
  /** 程序对 PROGRAM_OWNED_PARAMS 的控制权 [0, 1]：0 完全交给动画，1 完全由程序驱动 */
  authority: number;
  /** 说话时的口型开合 [0, 1]；不在说话时为 null，交还给模型自己的口型逻辑 */
  mouthOpen: number | null;
}

/**
 * 从声音出扬声器，到回环录到、分析窗口攒满、峰值确认、再画到屏幕上，整条链路约晚这么多。
 * 节拍时钟是预测的，所以动作可以往前提这么多，落在耳朵听到的拍点上。
 * 实测（真实回环 + 录屏对拍点，120 BPM）：提前 60 ms 时下沉最低点仍晚约 75 ms。
 */
export const AUDIO_LATENCY_MS = 130;

const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export class LivelinessMotor {
  readonly beat = new BeatClock();
  private readonly random: () => number;
  private timeSec = 0;
  private lastNowMs: number | null = null;
  private pose: Pose = { params: {}, offsetX: 0, offsetY: 0, authority: 0, mouthOpen: null };

  // ── 音乐 ──
  private musicInput = 0;
  private readonly musicLevel = new Envelope(0.08, 0.8);
  /** 自适应满刻度：系统音量千差万别，用最近 8 秒的峰值归一化 */
  private musicPeak = 0;
  private readonly groove = new Envelope(0.8, 1.2);
  private onsetCount = 0;
  private accentCount = 0;
  private pendingAccent = 0;
  /** 重拍时额外的一下：比规律律动更「冲」，交给弹簧自己弹回来 */
  private readonly accent = new Spring(4, 0.45);
  /**
   * 画面相位相对节拍时钟的偏移。时钟每收到一个鼓点都可能校正相位（刚锁定时尤其多），
   * 直接用会让动作突然快进一下，看着像发抖。所以时钟一跳，画面先保持连续，
   * 再由临界阻尼弹簧在半秒左右追平：不过冲、速度连续，稳定后与时钟完全重合
   */
  private readonly phaseOffset = new Spring(1.2, 1);
  private lastClockBeats: number | null = null;
  /** 诊断用：上次 status() 以来时钟最大的一次相位跳变（拍） */
  private largestJump = 0;
  private lastPeriodMs: number | null = null;

  // ── 说话 ──
  private speaking = false;
  private speechInput = 0;
  private readonly speechEnv = new Envelope(0.015, 0.09);
  private readonly speechAvg = new Envelope(0.4, 1.2);
  /** 口型直接跟原始音量，只做一层很短的平滑：音节之间要能合上嘴，不然看着像含着东西 */
  private readonly mouth = new Envelope(0.02, 0.045);
  private wasAccented = false;
  private lastEmphasisSec = -Infinity;
  private silenceSec = 0;
  private voicedSec = 0;
  private readonly emphasisNod = new Spring(4.5, 0.4);
  private readonly browLift = new Spring(4, 0.5);
  private readonly eyeWiden = new Spring(5, 0.6);
  private readonly pauseTilt = new Spring(1.4, 0.8);

  // ── 视线 ──
  private readonly gazeX = new Spring(7, 0.85);
  private readonly gazeY = new Spring(7, 0.85);
  private nextGazeSec = 0;

  constructor(options: { random?: () => number } = {}) {
    this.random = options.random ?? Math.random;
  }

  /** 正在放的音乐的音量（RMS），由系统音频监听每帧送进来；停止监听时送 0 */
  setMusicLevel(rms: number): void {
    this.musicInput = rms;
  }

  /**
   * 音乐里检测到一个 onset。strength 是相对平均鼓点的响度倍数（普通拍约 1）。
   * 说话时忽略：系统回环会录到自己的声音，把说话的音节当鼓点会让节拍乱掉。
   * 时钟按原速继续走，不受影响。
   */
  onMusicOnset(timeMs: number, strength = 1): void {
    if (this.speaking) return;
    this.onsetCount++;
    this.beat.onOnset(timeMs, strength);
    // 明显比平时响的一下（重拍、drop，约 +6 dB）：额外加一个点头。
    // 门槛不能太低：onset 落在分析帧里的位置不同，同样的鼓也会差出几 dB
    if (strength > 2) {
      this.pendingAccent = Math.min(1, (strength - 1) / 3);
      this.accentCount++;
    }
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    if (!speaking) {
      this.speechInput = 0;
      this.pauseTilt.target = 0;
    }
  }

  /** 自己说话的音量（RMS），由 TTS 播放器每帧送进来 */
  setSpeechLevel(rms: number): void {
    this.speechInput = rms;
  }

  get isSpeaking(): boolean {
    return this.speaking;
  }

  /** 诊断用：「为什么她没跟着晃」先看这里 */
  status(nowMs: number) {
    const phaseJump = Number(this.largestJump.toFixed(3));
    this.largestJump = 0;
    return {
      phaseJump,
      onsets: this.onsetCount,
      accents: this.accentCount,
      bpm: this.beat.bpm === null ? null : Math.round(this.beat.bpm),
      confidence: Number(this.beat.confidence(nowMs).toFixed(2)),
      groove: Number(this.groove.value.toFixed(2)),
      musicPeak: Number(this.musicPeak.toFixed(3)),
      speaking: this.speaking,
    };
  }

  update(dtSec: number, nowMs: number): Pose {
    // 同一帧被多次调用（比如两个视图）时只算一次
    if (nowMs === this.lastNowMs) return this.pose;
    this.lastNowMs = nowMs;
    const dt = clamp(dtSec, 0, 0.1);
    this.timeSec += dt;
    this.beat.advance(nowMs);

    const music = this.updateMusic(dt, nowMs);
    const speech = this.updateSpeech(dt);
    const gaze = this.updateGaze(dt);
    const t = this.timeSec;

    // 一直存在的细微漂移：完全静止的头最显得假。说话越起劲漂得越多
    const drift = 0.04 + 0.12 * speech.activity;
    const g = music.frame;
    const params: Pose['params'] = {
      ParamAngleX: g.headYaw + drift * smoothNoise(t, 1) + 0.25 * gaze.x,
      ParamAngleY: g.headNod + 0.3 * music.accent + 0.22 * speech.nod + 0.6 * drift * smoothNoise(t, 2) + 0.15 * gaze.y,
      ParamAngleZ: g.headRoll + speech.tilt + drift * smoothNoise(t, 3),
      ParamBodyAngleX: g.torsoYaw + 0.3 * drift * smoothNoise(t, 4),
      ParamBodyAngleY: g.torsoBend + 0.3 * music.accent,
      ParamBodyAngleZ: g.torsoRoll + 0.3 * drift * smoothNoise(t, 5),
      ParamShoulderY: g.shoulder,
      ParamEyeBallX: gaze.x + g.eyeX,
      ParamEyeBallY: gaze.y,
      ParamBrowLY: 0.35 * speech.brow,
      ParamBrowRY: 0.35 * speech.brow,
      // 听歌听得投入时眯眼微笑
      ParamEyeLSmile: 0.7 * music.groove,
      ParamEyeRSmile: 0.7 * music.groove,
      ParamEyeLOpen: 0.2 * speech.widen,
      ParamEyeROpen: 0.2 * speech.widen,
      ParamMouthForm: 0.2 * music.groove,
    };
    for (const key of Object.keys(params) as PoseParam[]) params[key] = clamp(params[key] ?? 0, -1, 1);

    this.pose = {
      params,
      offsetX: 0.004 * g.side,
      offsetY: 0.012 * (g.bob + music.accent),
      authority: music.authority,
      mouthOpen: speech.mouth,
    };
    return this.pose;
  }

  private updateMusic(dt: number, nowMs: number) {
    const level = this.musicInput;
    this.musicPeak = Math.max(level, this.musicPeak * Math.exp(-dt / 8));
    const loudness = this.musicPeak > 0.005 ? clamp(this.musicLevel.step(level, dt) / this.musicPeak, 0, 1) : 0;
    const sure = smoothstep(0.3, 0.6, this.beat.confidence(nowMs));
    // 说话时还跟着轻轻晃，但收一半：主角是说话
    const groove = this.groove.step(sure * (0.35 + 0.65 * loudness) * (this.speaking ? 0.5 : 1), dt);

    const periodMs = 60000 / (this.beat.bpm ?? 120);
    const clockBeats = this.beat.position;
    if (this.lastClockBeats !== null && this.lastPeriodMs !== null && this.beat.bpm !== null) {
      const jump = clockBeats - (this.lastClockBeats + (dt * 1000) / this.lastPeriodMs);
      if (Math.abs(jump) > 1e-6) {
        this.largestJump = Math.max(this.largestJump, Math.abs(jump));
        this.phaseOffset.value -= jump;
        // 追平到最近的整拍即可：差整数拍只是换了一下先往哪边摆，节拍上没区别
        this.phaseOffset.target = Math.round(this.phaseOffset.value);
      }
    }
    this.lastClockBeats = clockBeats;
    this.lastPeriodMs = this.beat.bpm !== null ? periodMs : null;
    const beats = clockBeats + this.phaseOffset.step(dt);
    const frame = grooveFrame(beats + AUDIO_LATENCY_MS / periodMs, periodMs, groove);
    if (this.pendingAccent) {
      this.accent.impulse(-0.6 * this.pendingAccent * groove);
      this.pendingAccent = 0;
    }
    return {
      groove,
      frame,
      accent: this.accent.step(dt),
      // 律动明显时才接管：刚开始淡入、快要停下时，让待机动画自然接回来
      authority: smoothstep(0.1, 0.5, groove),
    };
  }

  private updateSpeech(dt: number) {
    const env = this.speechEnv.step(this.speaking ? this.speechInput : 0, dt);
    const avg = this.speechAvg.step(env, dt);
    const activity = this.speaking ? clamp(env * 8, 0, 1) : 0;

    // 重读：快包络从下方越过慢均值的 1.25 倍。慢均值跟着整句的音量走，
    // 所以小声说话和大声说话都能找出各自的重音
    const accented = this.speaking && env > Math.max(0.01, avg * 1.25);
    if (accented && !this.wasAccented && this.timeSec - this.lastEmphasisSec > 0.28) {
      const strength = clamp(env / Math.max(avg, 0.005) - 1, 0.2, 1);
      this.emphasisNod.impulse(-0.8 * strength);
      this.browLift.impulse(0.9 * strength);
      if (strength > 0.6) this.eyeWiden.impulse(0.8 * strength);
      this.lastEmphasisSec = this.timeSec;
    }
    this.wasAccented = accented;

    // 句间停顿时歪一下头，下一句开口后慢慢回正
    const voiced = env > Math.max(0.008, avg * 0.3);
    this.silenceSec = this.speaking && !voiced ? this.silenceSec + dt : 0;
    this.voicedSec = this.speaking && voiced ? this.voicedSec + dt : 0;
    if (this.silenceSec > 0.35 && this.pauseTilt.target === 0) {
      this.pauseTilt.target = (this.random() < 0.5 ? -1 : 1) * (0.1 + 0.12 * this.random());
    } else if (this.voicedSec > 0.4) {
      this.pauseTilt.target = 0;
    }

    const mouth = this.mouth.step(this.speaking ? clamp(this.speechInput * 10, 0, 1) ** 0.8 : 0, dt);
    return {
      activity,
      nod: this.emphasisNod.step(dt),
      brow: this.browLift.step(dt) + 0.4 * activity,
      widen: this.eyeWiden.step(dt),
      tilt: this.pauseTilt.step(dt),
      mouth: this.speaking ? mouth : null,
    };
  }

  private updateGaze(dt: number) {
    if (this.timeSec >= this.nextGazeSec) {
      const r = this.random;
      if (this.speaking && r() < 0.45) {
        // 说着说着看向一边（像在想词），很快再看回来
        this.gazeX.target = (r() < 0.5 ? -1 : 1) * (0.3 + 0.3 * r());
        this.gazeY.target = -0.1 + 0.45 * r();
        this.nextGazeSec = this.timeSec + 0.4 + 0.7 * r();
      } else if (this.speaking) {
        this.gazeX.target = 0.1 * (r() - 0.5);
        this.gazeY.target = 0.1 * (r() - 0.5);
        this.nextGazeSec = this.timeSec + 1.2 + 1.8 * r();
      } else {
        this.gazeX.target = 0.5 * (r() - 0.5);
        this.gazeY.target = 0.3 * (r() - 0.5);
        this.nextGazeSec = this.timeSec + 1.5 + 3 * r();
      }
    }
    return { x: this.gazeX.step(dt), y: this.gazeY.step(dt) };
  }
}

/** 全应用一个：TTS 播放器、音乐检测和模型都通过它交换数据 */
export const liveliness = new LivelinessMotor();
