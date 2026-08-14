import { Vec3 } from 'vec3';

interface VectorLike {
  x: number;
  y: number;
  z: number;
}

interface GazeEntity {
  position?: VectorLike;
  yaw?: number;
  pitch?: number;
  height?: number;
  eyeHeight?: number;
  width?: number;
}

interface RaycastWorld {
  raycast?(origin: Vec3, direction: Vec3, maxDistance: number): {
    intersect?: VectorLike;
  } | null;
}

export interface PlayerGazeSample {
  player: string;
  distance: number;
}

export interface PlayerGazeTrigger extends PlayerGazeSample {
  durationMs: number;
}

export class PlayerGazeTracker {
  private holdPlayer?: string;
  private holdStartedAt?: number;
  private latched = false;
  private awayStartedAt?: number;

  constructor(private readonly options: { holdMs: number; rearmMs: number }) {}

  update(sample: PlayerGazeSample | null, now: number): PlayerGazeTrigger | null {
    if (!sample) {
      this.holdPlayer = undefined;
      this.holdStartedAt = undefined;
      if (!this.latched) return null;
      this.awayStartedAt ??= now;
      if (now - this.awayStartedAt >= this.options.rearmMs) {
        this.latched = false;
        this.awayStartedAt = undefined;
      }
      return null;
    }

    this.awayStartedAt = undefined;
    if (this.latched) return null;
    if (this.holdPlayer !== sample.player || this.holdStartedAt === undefined) {
      this.holdPlayer = sample.player;
      this.holdStartedAt = now;
      return null;
    }

    const durationMs = now - this.holdStartedAt;
    if (durationMs < this.options.holdMs) return null;
    this.latched = true;
    return { ...sample, durationMs };
  }

  reset(): void {
    this.holdPlayer = undefined;
    this.holdStartedAt = undefined;
    this.latched = false;
    this.awayStartedAt = undefined;
  }
}

export function measurePlayerGaze(
  viewer: GazeEntity,
  target: GazeEntity,
  world: RaycastWorld | undefined,
  maxDistance: number,
): number | null {
  if (!viewer.position || !target.position) return null;
  if (!Number.isFinite(viewer.yaw) || !Number.isFinite(viewer.pitch)) return null;

  const eyeHeight = finitePositive(viewer.eyeHeight)
    ?? finitePositive(viewer.height)
    ?? 1.62;
  const targetHeight = finitePositive(target.height) ?? 1.8;
  const halfWidth = (finitePositive(target.width) ?? 0.6) / 2;
  const origin = vec(viewer.position).offset(0, eyeHeight, 0);
  const direction = viewDirection(viewer.pitch!, viewer.yaw!);
  const targetPosition = vec(target.position);
  const hitDistance = rayBoxDistance(
    origin,
    direction,
    targetPosition.offset(-halfWidth, 0, -halfWidth),
    targetPosition.offset(halfWidth, targetHeight, halfWidth),
    maxDistance,
  );
  if (hitDistance === null) return null;

  const blockHit = world?.raycast?.(origin, direction, hitDistance);
  if (blockHit?.intersect) {
    const blockDistance = origin.distanceTo(vec(blockHit.intersect));
    if (blockDistance < hitDistance - 0.05) return null;
  }
  return hitDistance;
}

function viewDirection(pitch: number, yaw: number): Vec3 {
  const cosPitch = Math.cos(pitch);
  return new Vec3(
    -Math.sin(yaw) * cosPitch,
    Math.sin(pitch),
    -Math.cos(yaw) * cosPitch,
  ).normalize();
}

function rayBoxDistance(
  origin: Vec3,
  direction: Vec3,
  min: Vec3,
  max: Vec3,
  maxDistance: number,
): number | null {
  let near = 0;
  let far = maxDistance;
  for (const axis of ['x', 'y', 'z'] as const) {
    const delta = direction[axis];
    if (Math.abs(delta) < 1e-9) {
      if (origin[axis] < min[axis] || origin[axis] > max[axis]) return null;
      continue;
    }
    const inverse = 1 / delta;
    let axisNear = (min[axis] - origin[axis]) * inverse;
    let axisFar = (max[axis] - origin[axis]) * inverse;
    if (axisNear > axisFar) [axisNear, axisFar] = [axisFar, axisNear];
    near = Math.max(near, axisNear);
    far = Math.min(far, axisFar);
    if (near > far) return null;
  }
  return near <= maxDistance && far >= 0 ? Math.max(0, near) : null;
}

function finitePositive(value: number | undefined): number | undefined {
  return Number.isFinite(value) && value! > 0 ? value : undefined;
}

function vec(value: VectorLike): Vec3 {
  return value instanceof Vec3 ? value : new Vec3(value.x, value.y, value.z);
}
