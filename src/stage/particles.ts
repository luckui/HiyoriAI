/**
 * 直播间的粒子：花瓣、星星、音符、爱心、像素、彩带、光斑。一块 canvas 一个实例，
 * 背景层用它下花瓣、飘音符，前景层用它在开场和大事件时炸一把彩带爱心。
 */

export type ParticleKind = 'petal' | 'sparkle' | 'note' | 'heart' | 'pixel' | 'confetti' | 'bokeh' | 'star';

interface Particle {
  kind: ParticleKind;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** 重力（像素/秒²） */
  g: number;
  size: number;
  rot: number;
  vrot: number;
  /** 翻转相位：花瓣、彩带在空中翻面 */
  flip: number;
  vflip: number;
  /** 左右飘的幅度与相位 */
  sway: number;
  swayPhase: number;
  life: number;
  maxLife: number;
  color: string;
  alpha: number;
  glyph?: string;
}

export interface EmitterSpec {
  kind: ParticleKind;
  /** 每秒生成多少个 */
  rate: number;
  colors: string[];
  size: [number, number];
  /** 从哪里出来：top 从上往下落，bottom 往上飘，anywhere 原地出现 */
  from: 'top' | 'bottom' | 'anywhere';
  speed: [number, number];
  life: [number, number];
  alpha?: [number, number];
  sway?: number;
  /** 横向偏移：花瓣斜着落 */
  drift?: number;
}

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(list: T[]) => list[Math.floor(Math.random() * list.length)];
const NOTES = ['♪', '♫', '♬', '♩'];

export class ParticleField {
  private readonly ctx: CanvasRenderingContext2D;
  private particles: Particle[] = [];
  private emitters: EmitterSpec[] = [];
  private carry = new Map<EmitterSpec, number>();
  private width = 0;
  private height = 0;
  private dpr = 1;
  /** 背景律动：>1 时粒子生成变多、飘得更快 */
  intensity = 1;

  constructor(private readonly canvas: HTMLCanvasElement, private readonly max = 220) {
    this.ctx = canvas.getContext('2d')!;
  }

  setEmitters(emitters: EmitterSpec[]): void {
    this.emitters = emitters;
    this.carry.clear();
  }

  clear(): void {
    this.particles = [];
  }

  /** 从一点炸开一把（大事件、开场） */
  burst(x: number, y: number, count: number, kinds: ParticleKind[], colors: string[], power = 420): void {
    for (let i = 0; i < count; i++) {
      const angle = rand(-Math.PI, 0) + rand(-0.4, 0.4);
      const speed = rand(power * 0.4, power);
      this.spawn({
        kind: pick(kinds),
        x,
        y,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed,
        g: 380,
        size: rand(8, 18),
        color: pick(colors),
        maxLife: rand(1.6, 2.8),
        alpha: 1,
      });
    }
  }

  frame(dt: number): void {
    this.resize();
    const { ctx } = this;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.width, this.height);
    for (const spec of this.emitters) this.emit(spec, dt);

    const alive: Particle[] = [];
    for (const p of this.particles) {
      p.life += dt;
      if (p.life >= p.maxLife) continue;
      p.vy += p.g * dt;
      p.x += (p.vx + Math.sin(p.swayPhase + p.life * 1.6) * p.sway) * dt * this.speedScale();
      p.y += p.vy * dt * this.speedScale();
      p.rot += p.vrot * dt;
      p.flip += p.vflip * dt;
      if (p.y < -80 || p.y > this.height + 80 || p.x < -120 || p.x > this.width + 120) continue;
      this.draw(p);
      alive.push(p);
    }
    this.particles = alive;
  }

  private speedScale(): number {
    return 0.75 + 0.25 * this.intensity;
  }

  private resize(): void {
    const w = this.canvas.clientWidth;
    const h = this.canvas.clientHeight;
    const dpr = window.devicePixelRatio || 1;
    if (w === this.width && h === this.height && dpr === this.dpr) return;
    this.width = w;
    this.height = h;
    this.dpr = dpr;
    this.canvas.width = Math.round(w * dpr);
    this.canvas.height = Math.round(h * dpr);
  }

  private emit(spec: EmitterSpec, dt: number): void {
    if (!this.width) return;
    let due = (this.carry.get(spec) ?? 0) + spec.rate * dt * this.intensity;
    while (due >= 1 && this.particles.length < this.max) {
      due -= 1;
      const speed = rand(...spec.speed);
      const x = rand(-40, this.width + 40);
      const y = spec.from === 'top' ? -30 : spec.from === 'bottom' ? this.height + 30 : rand(0, this.height);
      this.spawn({
        kind: spec.kind,
        x,
        y,
        vx: spec.drift ?? 0,
        vy: spec.from === 'top' ? speed : spec.from === 'bottom' ? -speed : rand(-speed, speed) * 0.3,
        g: 0,
        size: rand(...spec.size),
        color: pick(spec.colors),
        maxLife: rand(...spec.life),
        alpha: rand(...(spec.alpha ?? [0.6, 1])),
        sway: spec.sway ?? 0,
      });
    }
    this.carry.set(spec, Math.min(due, 3));
  }

  private spawn(p: Partial<Particle> & Pick<Particle, 'kind' | 'x' | 'y' | 'vx' | 'vy' | 'g' | 'size' | 'color' | 'maxLife' | 'alpha'>): void {
    if (this.particles.length >= this.max) return;
    this.particles.push({
      rot: rand(0, Math.PI * 2),
      vrot: rand(-2, 2),
      flip: rand(0, Math.PI * 2),
      vflip: rand(2, 5),
      sway: 0,
      swayPhase: rand(0, Math.PI * 2),
      life: 0,
      glyph: p.kind === 'note' ? pick(NOTES) : undefined,
      ...p,
    });
  }

  private draw(p: Particle): void {
    const { ctx } = this;
    // 淡入淡出
    const t = p.life / p.maxLife;
    const fade = Math.min(1, t * 6, (1 - t) * 3);
    ctx.save();
    ctx.globalAlpha = p.alpha * fade;
    ctx.translate(p.x, p.y);
    ctx.rotate(p.rot);
    const s = p.size;
    switch (p.kind) {
      case 'petal': {
        ctx.scale(Math.cos(p.flip) * 0.8 + 0.2, 1);
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(0, -s * 0.6);
        ctx.bezierCurveTo(s * 0.7, -s * 0.5, s * 0.6, s * 0.4, 0, s * 0.6);
        ctx.bezierCurveTo(-s * 0.6, s * 0.4, -s * 0.7, -s * 0.5, 0, -s * 0.6);
        ctx.fill();
        // 花瓣尖的小缺口
        ctx.globalCompositeOperation = 'destination-out';
        ctx.beginPath();
        ctx.moveTo(-s * 0.12, -s * 0.62);
        ctx.lineTo(0, -s * 0.42);
        ctx.lineTo(s * 0.12, -s * 0.62);
        ctx.fill();
        break;
      }
      case 'sparkle':
      case 'star': {
        const twinkle = p.kind === 'star' ? 0.5 + 0.5 * Math.sin(p.life * 5 + p.swayPhase) : 1;
        ctx.globalAlpha *= twinkle;
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = s;
        ctx.beginPath();
        for (let i = 0; i < 4; i++) {
          const a = (i * Math.PI) / 2;
          ctx.lineTo(Math.cos(a) * s, Math.sin(a) * s);
          ctx.lineTo(Math.cos(a + Math.PI / 4) * s * 0.28, Math.sin(a + Math.PI / 4) * s * 0.28);
        }
        ctx.closePath();
        ctx.fill();
        break;
      }
      case 'note':
        ctx.rotate(-p.rot * 0.8);
        ctx.fillStyle = p.color;
        ctx.shadowColor = p.color;
        ctx.shadowBlur = 10;
        ctx.font = `700 ${s * 1.6}px system-ui, sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(p.glyph ?? '♪', 0, 0);
        break;
      case 'heart':
        ctx.fillStyle = p.color;
        ctx.beginPath();
        ctx.moveTo(0, s * 0.35);
        ctx.bezierCurveTo(-s, -s * 0.3, -s * 0.45, -s * 0.95, 0, -s * 0.4);
        ctx.bezierCurveTo(s * 0.45, -s * 0.95, s, -s * 0.3, 0, s * 0.35);
        ctx.fill();
        break;
      case 'pixel':
        ctx.rotate(-p.rot);
        ctx.fillStyle = p.color;
        ctx.fillRect(-s / 2, -s / 2, s, s);
        ctx.fillStyle = 'rgba(255,255,255,0.45)';
        ctx.fillRect(-s / 2, -s / 2, s / 3, s / 3);
        break;
      case 'confetti':
        ctx.scale(1, Math.cos(p.flip));
        ctx.fillStyle = p.color;
        ctx.fillRect(-s / 2, -s / 4, s, s / 2);
        break;
      case 'bokeh': {
        const g = ctx.createRadialGradient(0, 0, 0, 0, 0, s);
        g.addColorStop(0, p.color);
        g.addColorStop(1, 'rgba(255,255,255,0)');
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(0, 0, s, 0, Math.PI * 2);
        ctx.fill();
        break;
      }
    }
    ctx.restore();
  }
}
