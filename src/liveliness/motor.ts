/**
 * 灵动层：把音乐、自己说话的声音、对话的进展变成头、身体、眼神和表情的动作。
 *
 * 三部分，各管各的，最后叠加：
 * - 音乐：节拍时钟驱动一条身体链（见 groove.ts）：躯干带头、头带眼睛，按时间差错开。
 *         强度随「确定是音乐」的把握和响度淡入淡出。
 * - 说话的声音：重读的音节点一下头、挑一下眉、眼睛睁大一点；句间停顿时歪头；
 *         说话越起劲，头的漂移越大。口型也在这里做平滑。
 * - 对话（见 conversation.ts）：在听 / 在想 / 在说时的神态和眼神，以及每句话的表情表演。
 *
 * 律动或对话进行时，程序从待机动画手里接过头和躯干的控制权（authority），结束后再还回去。
 *
 * 输出是归一化的偏移，只用 Cubism 标准参数名，由模型按各自的参数范围换算后叠加 ——
 * 换模型不用重新调。这里不碰 Cubism，全部是纯计算，可以单测。
 */

import type { Expression, ExpressionCue } from '../../shared/expressions';
import { GROOVE_SCALE, SPEECH_SCALE } from './amplitude';
import { BeatClock } from './beatClock';
import { Conversation, type ConversationState } from './conversation';
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
 * 律动、对话时由程序接管的参数：待机动画（以及开口时的 Tap 动作）在这些参数上的影响
 * 按 authority 淡出。动画里自带的表情（比如 Hiyori 的动作会眯眼、脸红）不淡出的话，
 * 惊讶的脸上也会挂着笑眯眼。
 * 不接管：手臂、手（程序还不管）、睁眼（眨眼靠它）。
 */
export const PROGRAM_OWNED_PARAMS = [
  'ParamAngleX', 'ParamAngleY', 'ParamAngleZ',
  'ParamBodyAngleX', 'ParamBodyAngleY', 'ParamBodyAngleZ',
  'ParamShoulderY',
  'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm',
  'ParamEyeLSmile', 'ParamEyeRSmile', 'ParamMouthForm', 'ParamCheek',
] as const;

/** 有些模型没按标准命名，模型里找不到标准名时依次试这些 */
export const PARAM_ALIASES: Partial<Record<string, readonly string[]>> = {
  ParamShoulderY: ['ParamShoulder'],
};

/** 眨眼、待机动画之后叠加：表情加在脸上，眨眼和动画里的细节照样保留 */
export const FACE_PARAMS = [
  'ParamBrowLY', 'ParamBrowRY', 'ParamBrowLAngle', 'ParamBrowRAngle', 'ParamBrowLForm', 'ParamBrowRForm',
  'ParamEyeLSmile', 'ParamEyeRSmile',
  'ParamEyeLOpen', 'ParamEyeROpen',
  'ParamMouthForm', 'ParamCheek',
] as const;

export type PoseParam = typeof BODY_PARAMS[number] | typeof FACE_PARAMS[number];

export interface Pose {
  /**
   * 参数偏移，模型按自己的参数换算：1 = 从默认值推到最大值，-1 = 推到最小值。
   * 以默认值为基准是因为各模型的「平常脸」不同：Hiyori 的嘴型默认就在最大值（微笑），
   * 对她来说「再笑一点」没有余地，「撇嘴」要往下推整个范围
   */
  params: Partial<Record<PoseParam, number>>;
  /**
   * 整个模型的平移（模型坐标）：随拍的起伏。只适合半身构图 ——
   * 全身时脚也跟着离地，看起来像在原地跳，所以由模型按当前构图决定用不用
   */
  offsetX: number;
  offsetY: number;
  /**
   * 上半身绕腰的倾斜（弧度，正 = 和 ParamBodyAngleZ 正方向同侧）：模型以腰为支点整体转一点。
   * 模型自己的身体参数幅度有限（Hiyori 只有 ±10°），头在画面里挪不了多远；绕腰转则腰不动、
   * 头走一段弧线，像人歪着上身说话。和平移一样只适合半身构图（全身时脚会跟着转）
   */
  lean: number;
  /** 程序对 PROGRAM_OWNED_PARAMS 的控制权 [0, 1]：0 完全交给动画，1 完全由程序驱动 */
  authority: number;
  /**
   * 目光跟随鼠标的权重 [0, 1]。待机时她盯着你的鼠标看；对话、律动时她看着你（正前方），
   * 鼠标只轻轻带一下 —— 否则鼠标离窗口远时，头会一直被拉到极限
   */
  cursorFollow: number;
  /** 说话时的口型开合 [0, 1]；不在说话时为 null，交还给模型自己的口型逻辑 */
  mouthOpen: number | null;
  /** 刚换上一个明显的表情：模型若有对应的手势动作就播一次（只在这一帧给出） */
  gesture: Expression | null;
}

/**
 * 从声音出扬声器，到回环录到、分析窗口攒满、峰值确认、再画到屏幕上，整条链路约晚这么多。
 * 节拍时钟是预测的，所以动作可以往前提这么多，落在耳朵听到的拍点上。
 * 实测（真实回环 + 录屏对拍点，120 BPM）：提前 60 ms 时下沉最低点仍晚约 75 ms。
 */
export const AUDIO_LATENCY_MS = 130;

/**
 * 平常的腮红（相对模型默认值）。实拍：Hiyori 的脸红参数 -1 时腮红完全消失、0 是贴图自带的常驻腮红。
 * 没有负方向的模型这一项不起作用
 */
const BASE_CHEEK = -0.6;

/** 绕腰倾斜（弧度）：律动摆到一侧时、说话换重心到一侧时（各自的总开关已经乘在里面） */
const GROOVE_LEAN_RAD = 0.025;
const SPEECH_LEAN_RAD = 0.04;


const smoothstep = (edge0: number, edge1: number, x: number): number => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

export class LivelinessMotor {
  readonly beat = new BeatClock();
  private readonly random: () => number;
  private timeSec = 0;
  private lastNowMs: number | null = null;
  private pose: Pose = { params: {}, offsetX: 0, offsetY: 0, lean: 0, authority: 0, cursorFollow: 1, mouthOpen: null, gesture: null };

  // ── 音乐 ──
  private musicInput = 0;
  private readonly musicLevel = new Envelope(0.08, 0.8);
  /** 自适应满刻度：系统音量千差万别，用最近 8 秒的峰值归一化 */
  private musicPeak = 0;
  private readonly groove = new Envelope(0.8, 1.2);
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
  private readonly emphasisNod = new Spring(3, 0.6);
  /**
   * 重音时头换一个朝向并停在那儿（说话的「打拍子」手势）。不是偏出去再弹回来：
   * 那样一个重音就是一来一回，一秒几个重音，头看着在抖
   */
  private readonly strokeYaw = new Spring(1.4, 1);
  private readonly strokeRoll = new Spring(1.4, 1);
  private strokeSide = 1;
  private lastStrokeSec = -Infinity;
  /**
   * 说话时上半身的重心 [-1, 1]：绕着腰往一侧倾，停一会儿再换边（下半身不动，整个人不平移）。
   * 临界阻尼的慢弹簧：倾过去就停住，不来回弹
   */
  private readonly sway = new Spring(0.9, 1);
  private swaySide = 1;
  private lastSwaySec = -Infinity;
  private readonly browLift = new Spring(4, 0.5);
  private readonly eyeWiden = new Spring(5, 0.6);
  private readonly pauseTilt = new Spring(1.4, 0.8);
  /** 身体比头晚一点跟上说话的动作 */
  private readonly bodyFollowYaw = new Spring(1.3, 0.85);
  private readonly bodyFollowRoll = new Spring(1.3, 0.85);
  /** 漂移的「时间」：说得越起劲走得越快，头的游动跟着说话的劲头变快 */
  private driftTime = 0;
  /**
   * 说话的投入程度：音量包络再平滑到秒级。漂移按它放大 —— 直接用音量的话，
   * 幅度每个音节一起一落，头一秒抖四五下
   */
  private readonly engagement = new Envelope(0.5, 1.5);

  // ── 对话 ──
  private readonly conversation: Conversation;
  /** 上一帧的动作幅度倍数（表情决定）：重读点头的力度要在算点头之前就知道 */
  private energy = 1;

  constructor(options: { random?: () => number } = {}) {
    this.random = options.random ?? Math.random;
    this.conversation = new Conversation(this.random);
  }

  /**
   * 系统音频的一帧：起音强度（见 SpectralFlux）和音量（RMS）。停止监听时送 (0, 0)。
   * 说话时不交给节拍时钟：系统回环会录到自己的声音，把说话的节奏当拍子会让节拍乱掉。
   * 时钟暂停收听（按原速继续走、把握冻结），说完接着听 —— 歌没停的话，律动不断
   */
  setMusicFrame(flux: number, rms: number, timeMs: number): void {
    this.musicInput = rms;
    if (this.speaking) {
      this.beat.pause();
      return;
    }
    this.beat.resume(timeMs);
    this.beat.pushFrame(flux, rms, timeMs);
  }

  setSpeaking(speaking: boolean): void {
    this.speaking = speaking;
    this.conversation.setState(speaking ? 'speaking' : 'idle');
    if (!speaking) {
      this.speechInput = 0;
      this.pauseTilt.target = 0;
      this.sway.target = 0;
      this.strokeYaw.target = 0;
      this.strokeRoll.target = 0;
    }
  }

  /** 对话进展：用户发出消息后是 thinking；说话由 setSpeaking 管 */
  setConversationState(state: ConversationState): void {
    this.conversation.setState(state);
  }

  /** 指定表情；holdMs 之后回到当前状态自带的神态，不给就一直保持。传 null 清除 */
  setExpression(cue: ExpressionCue | null, holdMs?: number): void {
    this.conversation.setExpression(cue, holdMs);
  }

  /** 视线跟不跟鼠标（直播间画面里关掉：观众看不到鼠标，她该看镜头和弹幕） */
  followCursor = true;

  /** 看向画面上某处（x 正为她自己的左边、观众的右边）一会儿，再回到平常的视线 */
  lookAt(x: number, y: number, holdMs: number): void {
    this.conversation.lookAt(x, y, holdMs);
  }

  /**
   * 给直播间背景做律动用：音乐的拍点相位（0–1，拍点在 0）、律动强度，以及她说话的音量。
   * 没有稳定节拍时 beatPhase 为 null
   */
  get stagePulse(): { beatPhase: number | null; groove: number; voice: number } {
    const beats = this.lastClockBeats;
    return {
      beatPhase: beats === null || this.beat.bpm === null ? null : beats - Math.floor(beats),
      groove: this.groove.value,
      voice: this.speaking ? this.speechEnv.value : 0,
    };
  }

  /** TTS 开始说新的一句 */
  beginSentence(): void {
    this.conversation.beginSentence();
  }

  /** 麦克风音量（用户在说话），停止收听时送 0 */
  setListenLevel(rms: number): void {
    this.conversation.setListenLevel(rms);
  }

  /** 用户在输入框里打字 */
  noteTyping(): void {
    this.conversation.noteTyping();
  }

  /** 当前表情、强度和持续时间，供漫符层使用 */
  get expressionState() {
    return this.conversation.expressionState;
  }

  /**
   * 诊断用：把某些参数钉在给定的偏移上（±1 = 推到极值），用来给新模型做参数图谱。
   * 传 null 取消。只经调试开关（debugHooks）调用
   */
  setDebugOverride(params: Partial<Record<PoseParam, number>> | null): void {
    this.debugOverride = params;
  }
  private debugOverride: Partial<Record<PoseParam, number>> | null = null;

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
      bpm: this.beat.bpm === null ? null : Math.round(this.beat.bpm),
      confidence: Number(this.beat.confidence(nowMs).toFixed(2)),
      ...this.beat.diagnostics(),
      groove: Number(this.groove.value.toFixed(2)),
      musicPeak: Number(this.musicPeak.toFixed(3)),
      speaking: this.speaking,
      state: this.conversation.state,
      expression: this.conversation.expression,
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
    const talk = this.conversation.update(dt);
    this.energy = talk.energy;

    // 一直存在的漂移：完全静止的头最显得假。说话越起劲漂得越多、越快，表情决定劲儿有多大
    const engaged = this.engagement.step(speech.activity, dt);
    const drift = (0.04 + 0.12 * SPEECH_SCALE * engaged) * talk.energy;
    this.driftTime += dt * (1 + 1.2 * engaged);
    const n = this.driftTime;
    // 说话带出来的头部动作（每句的姿态 + 重音时的偏转 + 漂移），身体晚一点跟着走一部分：
    // 只动头、身子僵着，看着像脖子上装了轴
    const talkYaw = talk.yaw + speech.strokeYaw + drift * smoothNoise(n, 1);
    const talkRoll = talk.roll + speech.tilt + speech.strokeRoll + drift * smoothNoise(n, 3);
    this.bodyFollowYaw.target = 0.8 * talkYaw;
    this.bodyFollowRoll.target = 0.6 * talkRoll;
    const g = music.frame;
    const f = talk.face;
    const params: Pose['params'] = {
      ParamAngleX: g.headYaw + talkYaw + 0.25 * talk.gazeX,
      ParamAngleY: g.headNod + talk.pitch + 0.4 * SPEECH_SCALE * speech.nod + 0.6 * drift * smoothNoise(n, 2) + 0.15 * talk.gazeY,
      // 上半身倾过去时头往回找正一点：人歪着身子说话，头不会跟着歪那么多
      ParamAngleZ: g.headRoll + talkRoll - 0.04 * speech.sway,
      ParamBodyAngleX: g.torsoYaw + talk.bodyYaw + this.bodyFollowYaw.step(dt) + 0.25 * speech.sway + 0.3 * drift * smoothNoise(n, 4),
      // 重音时上身也顺势往前送一点
      ParamBodyAngleY: g.torsoBend + 0.2 * SPEECH_SCALE * speech.nod,
      ParamBodyAngleZ: g.torsoRoll + talk.bodyRoll + this.bodyFollowRoll.step(dt) + 0.6 * speech.sway + 0.3 * drift * smoothNoise(n, 5),
      ParamShoulderY: g.shoulder,
      ParamEyeBallX: talk.gazeX + g.eyeX,
      ParamEyeBallY: talk.gazeY,
      ParamBrowLY: (f.ParamBrowLY ?? 0) + 0.35 * speech.brow,
      ParamBrowRY: (f.ParamBrowRY ?? 0) + 0.35 * speech.brow,
      ParamBrowLAngle: f.ParamBrowLAngle ?? 0,
      ParamBrowRAngle: f.ParamBrowRAngle ?? 0,
      ParamBrowLForm: f.ParamBrowLForm ?? 0,
      ParamBrowRForm: f.ParamBrowRForm ?? 0,
      // 听歌听得投入时眯眼微笑
      ParamEyeLSmile: (f.ParamEyeLSmile ?? 0) + 0.7 * music.groove,
      ParamEyeRSmile: (f.ParamEyeRSmile ?? 0) + 0.7 * music.groove,
      ParamEyeLOpen: (f.ParamEyeLOpen ?? 0) + 0.6 * speech.widen,
      ParamEyeROpen: (f.ParamEyeROpen ?? 0) + 0.6 * speech.widen,
      ParamMouthForm: (f.ParamMouthForm ?? 0) + 0.2 * music.groove,
      // 平常只留一点腮红，害羞时才红起来：Hiyori 的贴图自带腮红，不压下去的话害羞前后差别很小
      ParamCheek: BASE_CHEEK + (f.ParamCheek ?? 0) * (1 - BASE_CHEEK),
    };
    for (const key of Object.keys(params) as PoseParam[]) params[key] = clamp(params[key] ?? 0, -1, 1);
    if (this.debugOverride) Object.assign(params, this.debugOverride);

    this.pose = {
      params,
      offsetX: 0.004 * g.side,
      offsetY: 0.016 * g.bob,
      lean: GROOVE_LEAN_RAD * g.side + SPEECH_LEAN_RAD * speech.sway,
      authority: Math.max(music.authority, talk.authority),
      // 正在和你说话的人看着你，不会一直盯着你的鼠标
      cursorFollow: this.followCursor ? 1 - 0.9 * Math.max(music.authority, talk.authority) : 0,
      mouthOpen: speech.mouth,
      gesture: talk.gesture,
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
    const raw = grooveFrame(beats + AUDIO_LATENCY_MS / periodMs, periodMs, groove);
    const frame = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, v * GROOVE_SCALE])) as unknown as typeof raw;
    return {
      groove,
      frame,
      // 律动明显时才接管：刚开始淡入、快要停下时，让待机动画自然接回来
      authority: smoothstep(0.1, 0.5, groove),
    };
  }

  private updateSpeech(dt: number) {
    const env = this.speechEnv.step(this.speaking ? this.speechInput : 0, dt);
    const avg = this.speechAvg.step(env, dt);
    const activity = this.speaking ? clamp(env * 8, 0, 1) : 0;

    // 重读：快包络从下方越过慢均值的 1.2 倍。慢均值跟着整句的音量走，
    // 所以小声说话和大声说话都能找出各自的重音
    const accented = this.speaking && env > Math.max(0.01, avg * 1.2);
    if (accented && !this.wasAccented && this.timeSec - this.lastEmphasisSec > 0.25) {
      const strength = clamp(env / Math.max(avg, 0.005) - 1, 0.2, 1) * this.energy;
      // 点头只给明显的重音：每个音节都点，就成了啄米
      if (strength > 0.45) this.emphasisNod.impulse(-0.6 * strength);
      if (this.timeSec - this.lastStrokeSec > 0.5) {
        // 多数时候换一边，偶尔同一边连着来：完全交替像钟摆
        if (this.random() < 0.7) this.strokeSide = -this.strokeSide;
        const stroke = this.strokeSide * (0.5 * this.energy + 0.5 * strength);
        this.strokeYaw.target = 0.12 * SPEECH_SCALE * stroke;
        this.strokeRoll.target = 0.06 * SPEECH_SCALE * stroke;
        this.lastStrokeSec = this.timeSec;
      }
      // 上半身换边：至少停留 0.9 秒，免得一句话里左右来回晃
      if (this.timeSec - this.lastSwaySec > 0.9) {
        this.swaySide = -this.swaySide;
        this.sway.target = this.swaySide * (0.5 + 0.5 * strength) * this.energy * SPEECH_SCALE;
        this.lastSwaySec = this.timeSec;
      }
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
      this.pauseTilt.target = (this.random() < 0.5 ? -1 : 1) * (0.1 + 0.12 * this.random()) * SPEECH_SCALE;
    } else if (this.voicedSec > 0.4) {
      this.pauseTilt.target = 0;
    }

    const mouth = this.mouth.step(this.speaking ? clamp(this.speechInput * 10, 0, 1) ** 0.8 : 0, dt);
    return {
      activity,
      nod: this.emphasisNod.step(dt),
      strokeYaw: this.strokeYaw.step(dt),
      strokeRoll: this.strokeRoll.step(dt),
      sway: this.sway.step(dt),
      brow: this.browLift.step(dt) + 0.4 * activity,
      widen: this.eyeWiden.step(dt),
      tilt: this.pauseTilt.step(dt),
      mouth: this.speaking ? mouth : null,
    };
  }
}

/** 全应用一个：TTS 播放器、音乐检测和模型都通过它交换数据 */
export const liveliness = new LivelinessMotor();
