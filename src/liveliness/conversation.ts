/**
 * 对话里的神态：在听、在想、在说，以及每句话的表情表演。
 *
 * 对话感来自几件小事：
 * - 在听：看着你，头微微歪；你说话停顿时轻轻点头附和。
 * - 在想：眼睛移向斜上方并停在那儿，眉头微皱。
 * - 在说：大部分时间看着你，句子开头偶尔移开视线，句子结束时看回来；
 *        每句换一个头部姿态（人说话时头不会一直摆在同一个位置）。
 * - 表情是一整套表演（见 acting.ts）：脸、姿态、眼神、动作幅度一起变。
 *
 * 在听 / 在想 / 在说时由程序接管头部（authority），待机动画那种
 * 「自顾自东张西望」的神态就不会混进对话里；回到待机再交还给动画。
 */

import type { Expression, ExpressionCue } from '../../shared/expressions';
import { ACTING, type Acting, type FaceParam } from './acting';
import { SPEECH_SCALE } from './amplitude';
import { Envelope, Spring, clamp } from './dynamics';

export type ConversationState = 'idle' | 'listening' | 'thinking' | 'speaking';

/** 各状态下程序对头部的控制权：说话时最高，待机时完全交给动画 */
const STATE_AUTHORITY: Record<ConversationState, number> = {
  idle: 0,
  listening: 0.6,
  thinking: 0.7,
  speaking: 0.85,
};

/** 没有指定表情时，各状态自带的神态 */
const STATE_EXPRESSION: Record<ConversationState, ExpressionCue | null> = {
  idle: null,
  listening: { expression: 'curious', intensity: 0.25 },
  thinking: { expression: 'thinking', intensity: 0.6 },
  speaking: null,
};

/** 没人说话、也没人打字这么久之后，「在听」回到待机 */
const LISTEN_TIMEOUT_SEC = 3;

export interface ConversationFrame {
  face: Partial<Record<FaceParam, number>>;
  /** 头部偏移：表情姿态 + 每句的姿态 + 附和点头 + 表情刚出来的那一下 */
  pitch: number;
  roll: number;
  yaw: number;
  bodyYaw: number;
  bodyRoll: number;
  gazeX: number;
  gazeY: number;
  /** 说话动作幅度倍数 */
  energy: number;
  authority: number;
  /** 刚换上的明显表情（只在换的那一帧给出），用来配手势 */
  gesture: Expression | null;
}

export class Conversation {
  state: ConversationState = 'idle';
  private readonly random: () => number;
  private timeSec = 0;

  // ── 表情 ──
  private explicit: { cue: ExpressionCue; untilSec: number } | null = null;
  private acting: Acting = ACTING.neutral;
  private actingName: Expression = 'neutral';
  private expressionSince = 0;
  private intensity = 0;
  /** 歪头、侧视朝哪边：每次换表情随机选，否则永远歪向同一边很假 */
  private side = 1;
  private readonly face = new Map<FaceParam, Spring>();
  private pendingGesture: Expression | null = null;
  private readonly posturePitch = new Spring(1.6, 0.75);
  private readonly postureRoll = new Spring(1.6, 0.75);
  private readonly postureYaw = new Spring(1.6, 0.75);
  /** 身体比头慢一点跟上 */
  private readonly bodyYaw = new Spring(1.2, 0.8);
  private readonly bodyRoll = new Spring(1.2, 0.8);
  private readonly onset = new Spring(3, 0.4);
  private readonly energy = new Envelope(0.3, 0.6);

  // ── 说话：每句的姿态 ──
  private readonly phrasePitch = new Spring(1.2, 0.8);
  private readonly phraseRoll = new Spring(1.2, 0.8);
  private readonly phraseYaw = new Spring(1.2, 0.8);

  // ── 在听 ──
  private lastListenSignalSec = -Infinity;
  private micLevel = 0;
  private micFloor = 0.01;
  private micVoicedSec = 0;
  private lastNodSec = -Infinity;
  private readonly nod = new Spring(3.5, 0.5);

  // ── 视线 ──
  private readonly gazeX = new Spring(7, 0.85);
  private readonly gazeY = new Spring(7, 0.85);
  private nextGazeSec = 0;
  /** 句子开头移开视线时，到这个时刻再看回来 */
  private glanceUntilSec = -Infinity;
  /** lookAt 指定的视线保持到这个时刻 */
  private lookUntilSec = -Infinity;

  private readonly authority = new Envelope(0.4, 1.5);

  constructor(random: () => number) {
    this.random = random;
  }

  setState(state: ConversationState): void {
    if (state === this.state) return;
    this.state = state;
    if (state === 'listening') this.lastListenSignalSec = this.timeSec;
    if (state !== 'speaking') {
      this.phrasePitch.target = 0;
      this.phraseRoll.target = 0;
      this.phraseYaw.target = 0;
    }
    this.nextGazeSec = this.timeSec; // 状态一变，眼神马上跟着变
    this.applyExpression();
  }

  /**
   * 指定表情（表情导演、即时线索、manage_live2d 工具）。holdMs 之后回到状态自带的神态；
   * 不给 holdMs 就一直保持到下一次指定。传 null 清除。
   *
   * 强度会往上抬：导演给的 0.5 已经是「明显」，按原值演在脸上几乎看不出来，
   * 用户察觉不到表情变了，等于没演
   */
  setExpression(cue: ExpressionCue | null, holdMs?: number): void {
    const shown = cue && cue.expression !== 'neutral'
      ? { expression: cue.expression, intensity: Math.min(1, 0.35 + 0.75 * cue.intensity) }
      : cue;
    this.explicit = shown ? { cue: shown, untilSec: holdMs === undefined ? Infinity : this.timeSec + holdMs / 1000 } : null;
    this.applyExpression();
  }

  get expression(): Expression {
    return this.actingName;
  }

  /** 当前表情、强度，以及换上它多久了（秒）：漫符按它弹出、淡出 */
  get expressionState(): { expression: Expression; intensity: number; ageSec: number } {
    return { expression: this.actingName, intensity: this.intensity, ageSec: this.timeSec - this.expressionSince };
  }

  /** 说到新的一句：换一个头部姿态；有时先移开视线（像在组织语言），再看回来 */
  beginSentence(): void {
    const r = this.random;
    this.phraseYaw.target = (r() < 0.5 ? -1 : 1) * (0.06 + 0.16 * r()) * SPEECH_SCALE;
    this.phraseRoll.target = (r() < 0.5 ? -1 : 1) * (0.05 + 0.1 * r()) * SPEECH_SCALE;
    this.phrasePitch.target = (-0.06 + 0.14 * r()) * SPEECH_SCALE;
    if (r() < 0.4) {
      this.glanceUntilSec = this.timeSec + 0.5 + 0.5 * r();
      this.gazeX.target = (r() < 0.5 ? -1 : 1) * (0.3 + 0.25 * r());
      this.gazeY.target = 0.1 + 0.3 * r();
      this.nextGazeSec = this.glanceUntilSec;
    }
  }

  /** 看向某处一会儿（直播时看弹幕栏），到时再按状态找视线；这段时间视线不跟鼠标 */
  lookAt(x: number, y: number, holdMs: number): void {
    this.gazeX.target = x;
    this.gazeY.target = y;
    this.nextGazeSec = this.timeSec + holdMs / 1000;
    this.glanceUntilSec = this.nextGazeSec;
    this.lookUntilSec = this.nextGazeSec;
  }

  /** 麦克风音量（听觉模块采集时送来，几次每秒）。停止收听时送 0 */
  setListenLevel(rms: number): void {
    this.micLevel = rms;
  }

  /** 对方在打字：同样是在听 */
  noteTyping(): void {
    this.lastListenSignalSec = this.timeSec;
    if (this.state === 'idle') this.setState('listening');
  }

  update(dt: number): ConversationFrame {
    this.timeSec += dt;
    this.updateListening(dt);
    if (this.state === 'listening' && this.timeSec - this.lastListenSignalSec > LISTEN_TIMEOUT_SEC) this.setState('idle');
    if (this.explicit && this.timeSec >= this.explicit.untilSec) {
      this.explicit = null;
      this.applyExpression();
    }

    const face: ConversationFrame['face'] = {};
    for (const [param, spring] of this.face) {
      spring.target = (this.acting.face[param] ?? 0) * this.intensity;
      face[param] = spring.step(dt);
    }
    for (const [param, value] of Object.entries(this.acting.face) as Array<[FaceParam, number]>) {
      if (this.face.has(param)) continue;
      // 欠阻尼：换表情时略微过冲再回来，变化更容易被注意到
      const spring = new Spring(3.5, 0.6);
      spring.target = value * this.intensity;
      this.face.set(param, spring);
      face[param] = spring.step(dt);
    }

    this.posturePitch.target = (this.acting.posture.pitch ?? 0) * this.intensity;
    this.postureRoll.target = (this.acting.posture.roll ?? 0) * this.intensity * this.side;
    this.postureYaw.target = (this.acting.posture.yaw ?? 0) * this.intensity * this.side;
    this.bodyYaw.target = (this.acting.posture.bodyYaw ?? 0) * this.intensity * this.side;
    this.bodyRoll.target = (this.acting.posture.bodyRoll ?? 0) * this.intensity * this.side;
    const gaze = this.updateGaze(dt);

    return {
      face,
      pitch: this.posturePitch.step(dt) + this.onset.step(dt) + this.phrasePitch.step(dt) + this.nod.step(dt),
      roll: this.postureRoll.step(dt) + this.phraseRoll.step(dt),
      yaw: this.postureYaw.step(dt) + this.phraseYaw.step(dt),
      bodyYaw: this.bodyYaw.step(dt),
      bodyRoll: this.bodyRoll.step(dt),
      gazeX: gaze.x,
      gazeY: gaze.y,
      energy: this.energy.step(1 + (this.acting.energy - 1) * this.intensity, dt),
      authority: this.authority.step(this.timeSec < this.lookUntilSec ? Math.max(0.9, STATE_AUTHORITY[this.state]) : STATE_AUTHORITY[this.state], dt),
      gesture: this.takeGesture(),
    };
  }

  private takeGesture(): Expression | null {
    const gesture = this.pendingGesture;
    this.pendingGesture = null;
    return gesture;
  }

  /** 对方在说话时看着对方，对方停顿时点头附和 */
  private updateListening(dt: number): void {
    const rms = this.micLevel;
    // 底噪：降得快、升得慢，跟住安静时的水平
    this.micFloor = rms < this.micFloor ? Math.max(rms, 1e-4) : this.micFloor + (rms - this.micFloor) * Math.min(1, dt * 0.05);
    const voiced = rms > Math.max(0.01, this.micFloor * 3);
    if (voiced) {
      this.micVoicedSec += dt;
      this.lastListenSignalSec = this.timeSec;
      if (this.state === 'idle') this.setState('listening');
      return;
    }
    // 对方说了一阵、刚停下：附和地点一下头（不是每次都点）
    if (this.micVoicedSec > 0.7 && this.state === 'listening' && this.timeSec - this.lastNodSec > 1.2 && this.random() < 0.7) {
      this.nod.impulse(-0.35);
      this.lastNodSec = this.timeSec;
    }
    this.micVoicedSec = 0;
  }

  /** 当前该演哪个表情：显式指定的优先，否则用状态自带的 */
  private applyExpression(): void {
    const cue = this.explicit?.cue ?? STATE_EXPRESSION[this.state] ?? { expression: 'neutral', intensity: 0 };
    const changed = cue.expression !== this.actingName;
    this.actingName = cue.expression;
    this.acting = ACTING[cue.expression];
    this.intensity = clamp(cue.intensity, 0, 1);
    if (!changed) return;
    this.expressionSince = this.timeSec;
    this.side = this.random() < 0.5 ? -1 : 1;
    if (this.acting.onset) this.onset.impulse(this.acting.onset.pitch * this.intensity);
    // 只给显式指定、足够明显的表情配手势；状态自带的淡淡神态不配
    if (this.explicit && this.intensity >= 0.6) this.pendingGesture = cue.expression;
    this.nextGazeSec = this.timeSec;
  }

  private updateGaze(dt: number) {
    const r = this.random;
    if (this.timeSec >= this.nextGazeSec) {
      const bias = this.acting.gaze;
      if (bias && this.intensity > 0.2) {
        // 害羞、思考时眼神有固定的去处；害羞时偶尔偷看你一眼
        const peek = this.actingName === 'shy' && r() < 0.25;
        this.gazeX.target = peek ? 0 : bias.x * this.side * this.intensity + 0.1 * (r() - 0.5);
        this.gazeY.target = peek ? 0 : bias.y * this.intensity + 0.1 * (r() - 0.5);
        this.nextGazeSec = this.timeSec + (peek ? 0.4 + 0.3 * r() : 1.2 + 1.8 * r());
      } else if (this.state === 'idle') {
        this.gazeX.target = 0.5 * (r() - 0.5);
        this.gazeY.target = 0.3 * (r() - 0.5);
        this.nextGazeSec = this.timeSec + 1.5 + 3 * r();
      } else {
        // 在听、在说：看着对方，只有很小的眼神跳动
        this.gazeX.target = 0.12 * (r() - 0.5);
        this.gazeY.target = 0.08 * (r() - 0.5);
        this.nextGazeSec = this.timeSec + 0.8 + 1.6 * r();
      }
    }
    return { x: this.gazeX.step(dt), y: this.gazeY.step(dt) };
  }
}
