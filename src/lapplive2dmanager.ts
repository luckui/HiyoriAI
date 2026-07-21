/**
 * Live2D Desktop Pet - Live2D Manager
 * 修改：固定加载 Hiyori（index 0），移除多模型切换逻辑
 */

import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { ACubismMotion } from '@framework/motion/acubismmotion';
import { csmVector } from '@framework/type/csmvector';

import * as LAppDefine from './lappdefine';
import { LAppModel } from './lappmodel';
import { LAppPal } from './lapppal';
import { LAppSubdelegate } from './lappsubdelegate';

export type AvatarMotionSlot = 'idle' | 'touch' | 'thinking' | 'speaking';
export interface AvatarRuntimeMapping {
  motions: Record<AvatarMotionSlot, string[]>;
  expressions?: Record<string, string>;
}

export class LAppLive2DManager {
  private releaseAllModel(): void {
    this._models.clear();
  }

  public onDrag(x: number, y: number): void {
    const model: LAppModel = this._models.at(0);
    if (model) {
      model.setDragging(x, y);
    }
  }

  public onTap(x: number, y: number): void {
    if (LAppDefine.DebugLogEnable) {
      LAppPal.printMessage(`[APP]tap point: {x: ${x.toFixed(2)} y: ${y.toFixed(2)}}`);
    }
    const model: LAppModel = this._models.at(0);
    if (!model) return;
    if (this.playMappedMotionSlot('touch')) return;
    const cfg = LAppDefine.Models[this._sceneIndex];

    if (cfg.hitHead && model.hitTest(cfg.hitHead, x, y)) {
      if (LAppDefine.DebugLogEnable) {
        LAppPal.printMessage(`[APP]hit area: [${cfg.hitHead}]`);
      }
      model.setRandomExpression();
      if (cfg.motionTap) {
        model.startRandomMotion(cfg.motionTap, LAppDefine.PriorityNormal,
          this.finishedMotion, this.beganMotion);
      }
    } else if (cfg.hitBody && model.hitTest(cfg.hitBody, x, y)) {
      if (LAppDefine.DebugLogEnable) {
        LAppPal.printMessage(`[APP]hit area: [${cfg.hitBody}]`);
      }
      if (cfg.motionTapBody) {
        model.startRandomMotion(cfg.motionTapBody, LAppDefine.PriorityNormal,
          this.finishedMotion, this.beganMotion);
      }
    } else {
      if (cfg.motionTap) {
        model.startRandomMotion(cfg.motionTap, LAppDefine.PriorityNormal,
          this.finishedMotion, this.beganMotion);
      }
    }
  }

  /**
   * 划动手势：根据方向和碰撞区域触发对应动作组
   * @param dx 视图空间水平位移（正=右）
   * @param dy 视图空间垂直位移（正=上）
   * @param x  抬起点视图 X
   * @param y  抬起点视图 Y
   */
  public onFlick(dx: number, dy: number, x: number, y: number): void {
    if (LAppDefine.DebugLogEnable) {
      LAppPal.printMessage(`[APP]flick dx:${dx.toFixed(2)} dy:${dy.toFixed(2)}`);
    }
    const model: LAppModel = this._models.at(0);
    if (!model) return;
    const cfg = LAppDefine.Models[this._sceneIndex];

    let motionGroup: string;
    if (cfg.hitBody && model.hitTest(cfg.hitBody, x, y)) {
      motionGroup = cfg.motionFlickBody;
    } else if (Math.abs(dx) >= Math.abs(dy)) {
      motionGroup = cfg.motionFlick;       // 横向划动
    } else if (dy > 0) {
      motionGroup = cfg.motionFlickUp;     // 向上划
    } else {
      motionGroup = cfg.motionFlickDown;   // 向下划
    }

    if (motionGroup) {
      model.startRandomMotion(motionGroup, LAppDefine.PriorityNormal,
        this.finishedMotion, this.beganMotion);
    }
  }

  /** 半身显示模式（放大聚焦上半身） */
  private _halfBodyMode = false;

  public setHalfBodyMode(half: boolean): void {
    this._halfBodyMode = half;
  }

  public onUpdate(): void {
    const { width, height } = this._subdelegate.getCanvas();
    const projection: CubismMatrix44 = new CubismMatrix44();
    const model: LAppModel = this._models.at(0);

    if (model && model.getModel()) {
      if (model.getModel().getCanvasWidth() > 1.0 && width < height) {
        model.getModelMatrix().setWidth(2.0);
        projection.scale(1.0, width / height);
      } else {
        projection.scale(height / width, 1.0);
      }

      if (this._halfBodyMode) {
        // 半身模式：放大 1.75 倍，向下偏移让上半身（脸/胸）居中
        projection.scaleRelative(1.75, 1.75);
        projection.translateRelative(0.0, -0.55);
      }

      if (this._viewMatrix != null) {
        projection.multiplyByMatrix(this._viewMatrix);
      }
    }

    if (model) {
      model.update();
      model.draw(projection);
    }
  }

  public setViewMatrix(m: CubismMatrix44): void {
    for (let i = 0; i < 16; i++) {
      this._viewMatrix.getArray()[i] = m.getArray()[i];
    }
  }

  /** 返回当前加载的第一个模型（供 live2dController 使用） */
  public getFirstModel(): LAppModel | null {
    if (this._models && this._models.getSize() > 0) {
      return this._models.at(0) ?? null;
    }
    return null;
  }

  public addModel(sceneIndex: number = 0): void {
    this._sceneIndex = sceneIndex;
    this.changeScene(this._sceneIndex);
  }

  public loadAvatarModel(modelPath: string, jsonName: string, mapping?: AvatarRuntimeMapping): void {
    this._slotMapping = mapping ?? null;
    this.releaseAllModel();
    const instance = new LAppModel();
    instance.setSubdelegate(this._subdelegate);
    const idleGroup = firstGroupFromMotionIds(mapping?.motions.idle) || LAppDefine.MotionGroupIdle;
    instance.setIdleGroup(idleGroup);
    instance.loadAssets(modelPath, jsonName);
    this._models.pushBack(instance);
  }

  public previewMotion(motionId: string): boolean {
    return this.playMotionId(motionId, LAppDefine.PriorityNormal);
  }

  public previewExpression(expressionId: string): boolean {
    const model = this.getFirstModel();
    if (!model || !expressionId) return false;
    model.setExpression(expressionId);
    return true;
  }

  private changeScene(index: number): void {
    this._sceneIndex = index;
    const cfg = LAppDefine.Models[index];
    const modelPath: string = LAppDefine.ResourcesPath + cfg.dir + '/';

    this._slotMapping = null;
    this.releaseAllModel();
    const instance = new LAppModel();
    instance.setSubdelegate(this._subdelegate);
    instance.setIdleGroup(cfg.motionIdle);
    instance.loadAssets(modelPath, cfg.jsonName);
    this._models.pushBack(instance);
  }

  public constructor() {
    this._subdelegate = null;
    this._viewMatrix = new CubismMatrix44();
    this._models = new csmVector<LAppModel>();
    this._sceneIndex = 0;
  }

  public release(): void {}

  public initialize(subdelegate: LAppSubdelegate): void {
    this._subdelegate = subdelegate;
    this.changeScene(this._sceneIndex);
  }

  private _subdelegate: LAppSubdelegate;
  _viewMatrix: CubismMatrix44;
  _models: csmVector<LAppModel>;
  private _sceneIndex: number;
  private _slotMapping: AvatarRuntimeMapping | null = null;

  beganMotion = (_self: ACubismMotion): void => {};
  finishedMotion = (_self: ACubismMotion): void => {};

  private playMappedMotionSlot(slot: AvatarMotionSlot): boolean {
    const ids = this._slotMapping?.motions[slot] ?? [];
    if (ids.length === 0) return false;
    const id = ids[Math.floor(Math.random() * ids.length)];
    return this.playMotionId(id, LAppDefine.PriorityNormal);
  }

  private playMotionId(motionId: string, priority: number): boolean {
    const model = this.getFirstModel();
    const parsed = parseMotionId(motionId);
    if (!model || !parsed) return false;
    model.startMotion(parsed.group, parsed.index, priority, this.finishedMotion, this.beganMotion);
    return true;
  }
}

function parseMotionId(motionId: string): { group: string; index: number } | null {
  const idx = motionId.lastIndexOf(':');
  if (idx <= 0) return null;
  const group = motionId.slice(0, idx);
  const index = Number.parseInt(motionId.slice(idx + 1), 10);
  if (!group || !Number.isFinite(index) || index < 0) return null;
  return { group, index };
}

function firstGroupFromMotionIds(ids: string[] | undefined): string {
  const parsed = ids?.map(parseMotionId).find(Boolean);
  return parsed?.group ?? '';
}
