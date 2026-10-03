/**
 * Copyright(c) Live2D Inc. All rights reserved.
 *
 * Use of this source code is governed by the Live2D Open Software license
 * that can be found at https://www.live2d.com/eula/live2d-open-software-license-agreement_en.html.
 */

import { CubismDefaultParameterId } from '@framework/cubismdefaultparameterid';
import { CubismModelSettingJson } from '@framework/cubismmodelsettingjson';
import {
  BreathParameterData,
  CubismBreath
} from '@framework/effect/cubismbreath';
import { CubismEyeBlink } from '@framework/effect/cubismeyeblink';
import { ICubismModelSetting } from '@framework/icubismmodelsetting';
import { CubismIdHandle } from '@framework/id/cubismid';
import { CubismFramework } from '@framework/live2dcubismframework';
import { CubismMatrix44 } from '@framework/math/cubismmatrix44';
import { CubismUserModel } from '@framework/model/cubismusermodel';
import {
  ACubismMotion,
  BeganMotionCallback,
  FinishedMotionCallback
} from '@framework/motion/acubismmotion';
import { CubismMotion } from '@framework/motion/cubismmotion';
import {
  CubismMotionQueueEntryHandle,
  InvalidMotionQueueEntryHandleValue
} from '@framework/motion/cubismmotionqueuemanager';
import { csmMap } from '@framework/type/csmmap';
import { csmRect } from '@framework/type/csmrectf';
import { csmString } from '@framework/type/csmstring';
import { csmVector } from '@framework/type/csmvector';
import {
  CSM_ASSERT,
  CubismLogError,
  CubismLogInfo
} from '@framework/utils/cubismdebug';

import * as LAppDefine from './lappdefine';
import { LAppPal } from './lapppal';
import { TextureInfo } from './lapptexturemanager';
import { LAppWavFileHandler } from './lappwavfilehandler';
import { CubismMoc } from '@framework/model/cubismmoc';
import { LAppSubdelegate } from './lappsubdelegate';
import { BODY_PARAMS, FACE_PARAMS, PARAM_ALIASES, PROGRAM_OWNED_PARAMS, liveliness, type Pose, type PoseParam } from './liveliness/motor';
import type { Expression } from '../shared/expressions';

/** 画布像素坐标下的矩形 */
export interface AnchorRect { x: number; y: number; w: number; h: number }
/** 漫符的落点：脸、脸颊（两颊合在一个框里）、头顶 */
export interface ModelAnchors { face: AnchorRect; cheeks: AnchorRect | null; headTop: number }

// ── 动作状态机：只决定播哪组待机动画 ────────────────────────────────────────
// 表情、对话神态由灵动层（src/liveliness）负责，这里不再管
//
//   IDLE_CALM   →（超时 60 s）→  IDLE_BORED
//   IDLE_*      →（TTS 开始）  →  SPEAKING
//   SPEAKING    →（TTS 结束）  →  IDLE_CALM
//   任何状态    →（收到消息）  →  IDLE_CALM（重置 bored 计时器）
//
enum AvatarState {
  IDLE_CALM,    // 平静待机，随机 Idle 动作
  IDLE_BORED,   // 无聊，60 s 无交互后进入
  SPEAKING,     // TTS 播放中
}

enum LoadStep {
  LoadAssets,
  LoadModel,
  WaitLoadModel,
  LoadExpression,
  WaitLoadExpression,
  LoadPhysics,
  WaitLoadPhysics,
  LoadPose,
  WaitLoadPose,
  SetupEyeBlink,
  SetupBreath,
  LoadUserData,
  WaitLoadUserData,
  SetupEyeBlinkIds,
  SetupLipSyncIds,
  SetupLayout,
  LoadMotion,
  WaitLoadMotion,
  CompleteInitialize,
  CompleteSetupModel,
  LoadTexture,
  WaitLoadTexture,
  CompleteSetup
}

/**
 * ユーザーが実際に使用するモデルの実装クラス<br>
 * モデル生成、機能コンポーネント生成、更新処理とレンダリングの呼び出しを行う。
 */
export class LAppModel extends CubismUserModel {
  /**
   * model3.jsonが置かれたディレクトリとファイルパスからモデルを生成する
   * @param dir
   * @param fileName
   */
  public loadAssets(dir: string, fileName: string): void {
    this._modelHomeDir = dir;

    fetch(`${this._modelHomeDir}${fileName}`)
      .then(response => response.arrayBuffer())
      .then(arrayBuffer => {
        const setting: ICubismModelSetting = new CubismModelSettingJson(
          arrayBuffer,
          arrayBuffer.byteLength
        );

        // ステートを更新
        this._state = LoadStep.LoadModel;

        // 結果を保存
        this.setupModel(setting);
      })
      .catch(error => {
        // model3.json読み込みでエラーが発生した時点で描画は不可能なので、setupせずエラーをcatchして何もしない
        CubismLogError(`Failed to load file ${this._modelHomeDir}${fileName}`);
      });
  }

  /**
   * model3.jsonからモデルを生成する。
   * model3.jsonの記述に従ってモデル生成、モーション、物理演算などのコンポーネント生成を行う。
   *
   * @param setting ICubismModelSettingのインスタンス
   */
  private setupModel(setting: ICubismModelSetting): void {
    this._updating = true;
    this._initialized = false;

    this._modelSetting = setting;

    // CubismModel
    if (this._modelSetting.getModelFileName() != '') {
      const modelFileName = this._modelSetting.getModelFileName();

      fetch(`${this._modelHomeDir}${modelFileName}`)
        .then(response => {
          if (response.ok) {
            return response.arrayBuffer();
          } else if (response.status >= 400) {
            CubismLogError(
              `Failed to load file ${this._modelHomeDir}${modelFileName}`
            );
            return new ArrayBuffer(0);
          }
        })
        .then(arrayBuffer => {
          this.loadModel(arrayBuffer, this._mocConsistency);
          this._state = LoadStep.LoadExpression;

          // callback
          loadCubismExpression();
        });

      this._state = LoadStep.WaitLoadModel;
    } else {
      LAppPal.printMessage('Model data does not exist.');
    }

    // Expression
    const loadCubismExpression = (): void => {
      if (this._modelSetting.getExpressionCount() > 0) {
        const count: number = this._modelSetting.getExpressionCount();

        for (let i = 0; i < count; i++) {
          const expressionName = this._modelSetting.getExpressionName(i);
          const expressionFileName =
            this._modelSetting.getExpressionFileName(i);

          fetch(`${this._modelHomeDir}${expressionFileName}`)
            .then(response => {
              if (response.ok) {
                return response.arrayBuffer();
              } else if (response.status >= 400) {
                CubismLogError(
                  `Failed to load file ${this._modelHomeDir}${expressionFileName}`
                );
                // ファイルが存在しなくてもresponseはnullを返却しないため、空のArrayBufferで対応する
                return new ArrayBuffer(0);
              }
            })
            .then(arrayBuffer => {
              const motion: ACubismMotion = this.loadExpression(
                arrayBuffer,
                arrayBuffer.byteLength,
                expressionName
              );

              if (this._expressions.getValue(expressionName) != null) {
                ACubismMotion.delete(
                  this._expressions.getValue(expressionName)
                );
                this._expressions.setValue(expressionName, null);
              }

              this._expressions.setValue(expressionName, motion);

              this._expressionCount++;

              if (this._expressionCount >= count) {
                this._state = LoadStep.LoadPhysics;

                // callback
                loadCubismPhysics();
              }
            });
        }
        this._state = LoadStep.WaitLoadExpression;
      } else {
        this._state = LoadStep.LoadPhysics;

        // callback
        loadCubismPhysics();
      }
    };

    // Physics
    const loadCubismPhysics = (): void => {
      if (this._modelSetting.getPhysicsFileName() != '') {
        const physicsFileName = this._modelSetting.getPhysicsFileName();

        fetch(`${this._modelHomeDir}${physicsFileName}`)
          .then(response => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${physicsFileName}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then(arrayBuffer => {
            this.loadPhysics(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.LoadPose;

            // callback
            loadCubismPose();
          });
        this._state = LoadStep.WaitLoadPhysics;
      } else {
        this._state = LoadStep.LoadPose;

        // callback
        loadCubismPose();
      }
    };

    // Pose
    const loadCubismPose = (): void => {
      if (this._modelSetting.getPoseFileName() != '') {
        const poseFileName = this._modelSetting.getPoseFileName();

        fetch(`${this._modelHomeDir}${poseFileName}`)
          .then(response => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${poseFileName}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then(arrayBuffer => {
            this.loadPose(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.SetupEyeBlink;

            // callback
            setupEyeBlink();
          });
        this._state = LoadStep.WaitLoadPose;
      } else {
        this._state = LoadStep.SetupEyeBlink;

        // callback
        setupEyeBlink();
      }
    };

    // EyeBlink
    const setupEyeBlink = (): void => {
      if (this._modelSetting.getEyeBlinkParameterCount() > 0) {
        this._eyeBlink = CubismEyeBlink.create(this._modelSetting);
        this._state = LoadStep.SetupBreath;
      }

      // callback
      setupBreath();
    };

    // Breath
    const setupBreath = (): void => {
      this._breath = CubismBreath.create();

      const breathParameters: csmVector<BreathParameterData> = new csmVector();
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleX, 0.0, 15.0, 6.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleY, 0.0, 8.0, 3.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamAngleZ, 0.0, 10.0, 5.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(this._idParamBodyAngleX, 0.0, 4.0, 15.5345, 0.5)
      );
      breathParameters.pushBack(
        new BreathParameterData(
          CubismFramework.getIdManager().getId(
            CubismDefaultParameterId.ParamBreath
          ),
          0.5,
          0.5,
          3.2345,
          1
        )
      );

      this._breath.setParameters(breathParameters);
      this._state = LoadStep.LoadUserData;

      // callback
      loadUserData();
    };

    // UserData
    const loadUserData = (): void => {
      if (this._modelSetting.getUserDataFile() != '') {
        const userDataFile = this._modelSetting.getUserDataFile();

        fetch(`${this._modelHomeDir}${userDataFile}`)
          .then(response => {
            if (response.ok) {
              return response.arrayBuffer();
            } else if (response.status >= 400) {
              CubismLogError(
                `Failed to load file ${this._modelHomeDir}${userDataFile}`
              );
              return new ArrayBuffer(0);
            }
          })
          .then(arrayBuffer => {
            this.loadUserData(arrayBuffer, arrayBuffer.byteLength);

            this._state = LoadStep.SetupEyeBlinkIds;

            // callback
            setupEyeBlinkIds();
          });

        this._state = LoadStep.WaitLoadUserData;
      } else {
        this._state = LoadStep.SetupEyeBlinkIds;

        // callback
        setupEyeBlinkIds();
      }
    };

    // EyeBlinkIds
    const setupEyeBlinkIds = (): void => {
      const eyeBlinkIdCount: number =
        this._modelSetting.getEyeBlinkParameterCount();

      for (let i = 0; i < eyeBlinkIdCount; ++i) {
        this._eyeBlinkIds.pushBack(
          this._modelSetting.getEyeBlinkParameterId(i)
        );
      }

      this._state = LoadStep.SetupLipSyncIds;

      // callback
      setupLipSyncIds();
    };

    // LipSyncIds
    const setupLipSyncIds = (): void => {
      const lipSyncIdCount = this._modelSetting.getLipSyncParameterCount();

      for (let i = 0; i < lipSyncIdCount; ++i) {
        this._lipSyncIds.pushBack(this._modelSetting.getLipSyncParameterId(i));
      }
      this._state = LoadStep.SetupLayout;

      // callback
      setupLayout();
    };

    // Layout
    const setupLayout = (): void => {
      const layout: csmMap<string, number> = new csmMap<string, number>();

      if (this._modelSetting == null || this._modelMatrix == null) {
        CubismLogError('Failed to setupLayout().');
        return;
      }

      this._modelSetting.getLayoutMap(layout);
      this._modelMatrix.setupFromLayout(layout);
      this._state = LoadStep.LoadMotion;

      // callback
      loadCubismMotion();
    };

    // Motion
    const loadCubismMotion = (): void => {
      this._state = LoadStep.WaitLoadMotion;
      this._model.saveParameters();
      this._allMotionCount = 0;
      this._motionCount = 0;
      const group: string[] = [];

      const motionGroupCount: number = this._modelSetting.getMotionGroupCount();

      // モーションの総数を求める
      for (let i = 0; i < motionGroupCount; i++) {
        group[i] = this._modelSetting.getMotionGroupName(i);
        this._allMotionCount += this._modelSetting.getMotionCount(group[i]);
      }

      // モーションの読み込み
      for (let i = 0; i < motionGroupCount; i++) {
        this.preLoadMotionGroup(group[i]);
      }

      // モーションがない場合
      if (motionGroupCount == 0) {
        this._state = LoadStep.LoadTexture;

        // 全てのモーションを停止する
        this._motionManager.stopAllMotions();

        this._updating = false;
        this._initialized = true;

        this.createRenderer();
        this.setupTextures();
        this.getRenderer().startUp(this._subdelegate.getGlManager().getGl());
      }
    };
  }

  /**
   * テクスチャユニットにテクスチャをロードする
   */
  private setupTextures(): void {
    // iPhoneでのアルファ品質向上のためTypescriptではpremultipliedAlphaを採用
    const usePremultiply = true;

    if (this._state == LoadStep.LoadTexture) {
      // テクスチャ読み込み用
      const textureCount: number = this._modelSetting.getTextureCount();

      for (
        let modelTextureNumber = 0;
        modelTextureNumber < textureCount;
        modelTextureNumber++
      ) {
        // テクスチャ名が空文字だった場合はロード・バインド処理をスキップ
        if (this._modelSetting.getTextureFileName(modelTextureNumber) == '') {
          console.log('getTextureFileName null');
          continue;
        }

        // WebGLのテクスチャユニットにテクスチャをロードする
        let texturePath =
          this._modelSetting.getTextureFileName(modelTextureNumber);
        texturePath = this._modelHomeDir + texturePath;

        // ロード完了時に呼び出すコールバック関数
        const onLoad = (textureInfo: TextureInfo): void => {
          this.getRenderer().bindTexture(modelTextureNumber, textureInfo.id);

          this._textureCount++;

          if (this._textureCount >= textureCount) {
            // ロード完了
            this._state = LoadStep.CompleteSetup;
          }
        };

        // 読み込み
        this._subdelegate
          .getTextureManager()
          .createTextureFromPngFile(texturePath, usePremultiply, onLoad);
        this.getRenderer().setIsPremultipliedAlpha(usePremultiply);
      }

      this._state = LoadStep.WaitLoadTexture;
    }
  }

  /**
   * レンダラを再構築する
   */
  public reloadRenderer(): void {
    this.deleteRenderer();
    this.createRenderer();
    this.setupTextures();
  }

  /**
   * 更新
   */
  public update(): void {
    if (this._state != LoadStep.CompleteSetup) return;

    const deltaTimeSeconds: number = LAppPal.getDeltaTime();
    this._userTimeSeconds += deltaTimeSeconds;

    this._dragManager.update(deltaTimeSeconds);
    this._dragX = this._dragManager.getX();
    this._dragY = this._dragManager.getY();

    // モーションによるパラメータ更新の有無
    let motionUpdated = false;

    //--------------------------------------------------------------------------
    // ── 行为状态机：更新计时器 ──────────────────────────────────────────────
    this._avatarIdleElapsedSec += deltaTimeSeconds;

    // BORED 判断：60 s 无任何交互
    if (
      this._avatarState === AvatarState.IDLE_CALM &&
      this._avatarIdleElapsedSec > LAppModel.BORED_THRESHOLD_SEC
    ) {
      this._avatarState = AvatarState.IDLE_BORED;
    }

    this._model.loadParameters(); // 前回セーブされた状態をロード

    if (this._motionManager.isFinished()) {
      // ── 各状态下选择下一个动作 ─────────────────────────────────────────
      switch (this._avatarState) {
        case AvatarState.SPEAKING: {
          // 说话时继续循环 Idle 作为身体的动态基线，说话的细节动作由灵动层叠加
          this.startRandomMotion(this._idleGroup, LAppDefine.PriorityIdle);
          break;
        }
        case AvatarState.IDLE_BORED: {
          // 无聊：偶尔做一个 FlickDown（叹气感），更多时候还是 Idle
          const boredRoll = Math.random();
          if (boredRoll < 0.25) {
            this.startRandomMotion('FlickDown', LAppDefine.PriorityIdle);
          } else {
            this.startRandomMotion(this._idleGroup, LAppDefine.PriorityIdle);
          }
          break;
        }
        case AvatarState.IDLE_CALM:
        default:
          this.startRandomMotion(this._idleGroup, LAppDefine.PriorityIdle);
          break;
      }
    } else {
      motionUpdated = this._motionManager.updateMotion(
        this._model,
        deltaTimeSeconds
      ); // モーションを更新
    }
    this._model.saveParameters(); // 状態を保存
    //--------------------------------------------------------------------------

    // 灵动层（音乐律动、说话动作、视线）。律动起来时先从待机动画手里接过头和躯干，
    // 之后眨眼、表情、鼠标跟随、呼吸照常叠加
    const pose = liveliness.update(deltaTimeSeconds, performance.now());
    this._yieldToProgram(pose.authority);
    // 表情明显时配一个手势（手臂、身体）；头和脸已经交给灵动层，动作里的那部分不会生效
    const gesture = pose.gesture ? this._gestures[pose.gesture] : undefined;
    if (gesture) this.startRandomMotion(gesture, LAppDefine.PriorityNormal);

    // まばたき
    if (!motionUpdated) {
      if (this._eyeBlink != null) {
        // メインモーションの更新がないとき
        this._eyeBlink.updateParameters(this._model, deltaTimeSeconds); // 目パチ
      }
    }

    if (this._expressionManager != null) {
      this._expressionManager.updateMotion(this._model, deltaTimeSeconds); // 表情でパラメータ更新（相対変化）
    }

    // 目光跟随鼠标（拖拽 / 全屏光标）。对话、律动时由灵动层减弱：那时她看着你，不是盯着鼠标
    const followX = this._dragX * pose.cursorFollow;
    const followY = this._dragY * pose.cursorFollow;
    this._model.addParameterValueById(this._idParamAngleX, followX * 30); // -30から30の値を加える
    this._model.addParameterValueById(this._idParamAngleY, followY * 30);
    this._model.addParameterValueById(this._idParamAngleZ, followX * followY * -30);
    this._model.addParameterValueById(this._idParamBodyAngleX, followX * 10); // -10から10の値を加える
    this._model.addParameterValueById(this._idParamEyeBallX, followX); // -1から1の値を加える
    this._model.addParameterValueById(this._idParamEyeBallY, followY);

    // 呼吸など
    if (this._breath != null) {
      this._breath.updateParameters(this._model, deltaTimeSeconds);
    }

    // 灵动层的头和身体在物理之前叠加：头发、衣服会被带着甩起来
    this._applyPose(pose, BODY_PARAMS);
    this._poseOffsetX = pose.offsetX;
    this._poseOffsetY = pose.offsetY;

    // 物理演算の設定
    if (this._physics != null) {
      this._physics.evaluate(this._model, deltaTimeSeconds);
    }

    // リップシンクの設定
    if (this._lipsync) {
      let value = 0.0;

      if (pose.mouthOpen !== null) {
        value = pose.mouthOpen;
        // TTS 播放时用 set（覆盖）：说话完全接管嘴巴，动作曲线里的口型不再叠加
        for (let i = 0; i < this._lipSyncIds.getSize(); ++i) {
          this._model.setParameterValueById(this._lipSyncIds.at(i), value);
        }
      } else {
        this._wavFileHandler.update(deltaTimeSeconds);
        value = this._wavFileHandler.getRms();
        // 非 TTS 时用 add（叠加）：与待机动作自然混合
        for (let i = 0; i < this._lipSyncIds.getSize(); ++i) {
          this._model.addParameterValueById(this._lipSyncIds.at(i), value, 0.8);
        }
      }
    }

    // ポーズの設定
    if (this._pose != null) {
      this._pose.updateParameters(this._model, deltaTimeSeconds);
    }

    // 灵动层的表情最后叠加：眨眼、动画里的面部细节都保留，表情加在上面
    this._applyPose(pose, FACE_PARAMS);

    this._model.update();
  }

  /**
   * 引数で指定したモーションの再生を開始する
   * @param group モーショングループ名
   * @param no グループ内の番号
   * @param priority 優先度
   * @param onFinishedMotionHandler モーション再生終了時に呼び出されるコールバック関数
   * @return 開始したモーションの識別番号を返す。個別のモーションが終了したか否かを判定するisFinished()の引数で使用する。開始できない時は[-1]
   */
  public startMotion(
    group: string,
    no: number,
    priority: number,
    onFinishedMotionHandler?: FinishedMotionCallback,
    onBeganMotionHandler?: BeganMotionCallback
  ): CubismMotionQueueEntryHandle {
    if (priority == LAppDefine.PriorityForce) {
      this._motionManager.setReservePriority(priority);
    } else if (!this._motionManager.reserveMotion(priority)) {
      if (this._debugMode) {
        LAppPal.printMessage("[APP]can't start motion.");
      }
      return InvalidMotionQueueEntryHandleValue;
    }

    const motionFileName = this._modelSetting.getMotionFileName(group, no);

    // ex) idle_0
    const name = `${group}_${no}`;
    let motion: CubismMotion = this._motions.getValue(name) as CubismMotion;
    let autoDelete = false;

    if (motion == null) {
      fetch(`${this._modelHomeDir}${motionFileName}`)
        .then(response => {
          if (response.ok) {
            return response.arrayBuffer();
          } else if (response.status >= 400) {
            CubismLogError(
              `Failed to load file ${this._modelHomeDir}${motionFileName}`
            );
            return new ArrayBuffer(0);
          }
        })
        .then(arrayBuffer => {
          motion = this.loadMotion(
            arrayBuffer,
            arrayBuffer.byteLength,
            null,
            onFinishedMotionHandler,
            onBeganMotionHandler,
            this._modelSetting,
            group,
            no,
            this._motionConsistency
          );
        });

      if (motion) {
        motion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds);
        autoDelete = true; // 終了時にメモリから削除
      } else {
        CubismLogError("Can't start motion {0} .", motionFileName);
        // ロードできなかったモーションのReservePriorityをリセットする
        this._motionManager.setReservePriority(LAppDefine.PriorityNone);
        return InvalidMotionQueueEntryHandleValue;
      }
    } else {
      motion.setBeganMotionHandler(onBeganMotionHandler);
      motion.setFinishedMotionHandler(onFinishedMotionHandler);
    }

    //voice
    const voice = this._modelSetting.getMotionSoundFileName(group, no);
    if (voice.localeCompare('') != 0) {
      let path = voice;
      path = this._modelHomeDir + path;
      this._wavFileHandler.start(path);
    }

    if (this._debugMode) {
      LAppPal.printMessage(`[APP]start motion: [${group}_${no}]`);
    }
    return this._motionManager.startMotionPriority(
      motion,
      autoDelete,
      priority
    );
  }

  /**
   * ランダムに選ばれたモーションの再生を開始する。
   * @param group モーショングループ名
   * @param priority 優先度
   * @param onFinishedMotionHandler モーション再生終了時に呼び出されるコールバック関数
   * @return 開始したモーションの識別番号を返す。個別のモーションが終了したか否かを判定するisFinished()の引数で使用する。開始できない時は[-1]
   */
  public startRandomMotion(
    group: string,
    priority: number,
    onFinishedMotionHandler?: FinishedMotionCallback,
    onBeganMotionHandler?: BeganMotionCallback
  ): CubismMotionQueueEntryHandle {
    if (this._modelSetting.getMotionCount(group) == 0) {
      return InvalidMotionQueueEntryHandleValue;
    }

    const no: number = Math.floor(
      Math.random() * this._modelSetting.getMotionCount(group)
    );

    return this.startMotion(
      group,
      no,
      priority,
      onFinishedMotionHandler,
      onBeganMotionHandler
    );
  }

  // ── 行为状态机字段 ─────────────────────────────────────────────────────────

  /** 当前行为状态 */
  private _avatarState: AvatarState = AvatarState.IDLE_CALM;
  /** 无交互计时（秒），用于判断进入 BORED */
  private _avatarIdleElapsedSec = 0;

  /** 无聊阈值：60 秒无交互 */
  private static readonly BORED_THRESHOLD_SEC = 60;
  // ── 灵动层的落地：把归一化偏移换算成本模型的参数值 ─────────────────────

  private _poseParamInfo = new Map<PoseParam, { index: number; up: number; down: number; defaultValue: number } | null>();
  private _poseOffsetX = 0;
  private _poseOffsetY = 0;
  /** 随拍的整体平移只在半身构图用：全身时脚也离地，像在原地跳 */
  private _poseTranslation = false;

  public setPoseTranslation(enabled: boolean): void {
    this._poseTranslation = enabled;
  }

  /**
   * 本模型对应参数的下标、默认值，以及默认值到最大 / 最小值的距离（偏移 ±1 的换算）。
   * 先找标准名再找别名，都没有就是 null（跳过）
   */
  private _poseParam(id: PoseParam) {
    let info = this._poseParamInfo.get(id);
    if (info !== undefined) return info;
    info = null;
    for (const name of [id, ...(PARAM_ALIASES[id] ?? [])]) {
      const index = this._model.getParameterIndex(CubismFramework.getIdManager().getId(name));
      if (index >= this._model.getParameterCount()) continue;
      const min = this._model.getParameterMinimumValue(index);
      const max = this._model.getParameterMaximumValue(index);
      const defaultValue = this._model.getParameterDefaultValue(index);
      info = { index, up: max - defaultValue, down: defaultValue - min, defaultValue };
      break;
    }
    this._poseParamInfo.set(id, info);
    return info;
  }

  private _applyPose(pose: Pose, ids: readonly PoseParam[]): void {
    for (const id of ids) {
      const value = pose.params[id];
      if (!value) continue;
      const info = this._poseParam(id);
      if (info) this._model.addParameterValueByIndex(info.index, value * (value > 0 ? info.up : info.down));
    }
  }

  /**
   * 控制权交接：待机动画在头和躯干上的偏移按 authority 收回到默认姿势，
   * 律动由程序完整驱动，不再和动画里节奏无关的转头、晃身打架。
   * 在 saveParameters 之后做，不写回动画的状态，音乐停了动画原样接回来
   */
  private _yieldToProgram(authority: number): void {
    if (authority <= 0) return;
    for (const id of PROGRAM_OWNED_PARAMS) {
      const info = this._poseParam(id);
      if (!info) continue;
      const value = this._model.getParameterValueByIndex(info.index);
      this._model.setParameterValueByIndex(info.index, info.defaultValue + (value - info.defaultValue) * (1 - authority));
    }
  }

  /**
   * 设置 TTS 讲话状态。
   * - true  → 进入 SPEAKING
   * - false → 回到 IDLE_CALM；表情的余韵由灵动层负责
   * 开口时不再固定播一个 Tap 动作：它自带的眯眼、脸红曲线会和表情打架，
   * 手势改为按表情触发（见 setGestures）
   */
  public setSpeaking(speaking: boolean): void {
    if (speaking) {
      if (this._avatarState === AvatarState.SPEAKING) return;
      this._avatarState = AvatarState.SPEAKING;
      this._avatarIdleElapsedSec = 0; // 重置 bored 计时器
    } else {
      if (this._avatarState === AvatarState.SPEAKING) this._avatarState = AvatarState.IDLE_CALM;
    }
  }

  /**
   * 任何外部交互（发送消息、接收消息等）时调用，重置 bored 计时器。
   */
  public notifyInteraction(): void {
    this._avatarIdleElapsedSec = 0;
    if (this._avatarState === AvatarState.IDLE_BORED) {
      this._avatarState = AvatarState.IDLE_CALM;
    }
  }

  /**
   * 直接以立即方式设置单个模型参数（供 manage_live2d set_param 使用）。
   *
   * @param parameterId Live2D 参数ID
   * @param value       目标值
   */
  public setParameterDirect(parameterId: string, value: number): void {
    if (!this._model) return;
    const handle = CubismFramework.getIdManager().getId(parameterId);
    this._model.setParameterValueById(handle, value);
  }

  /**
   * 引数で指定した表情モーションをセットする
   *
   * @param expressionId 表情モーションのID
   */
  public setExpression(expressionId: string): void {
    const motion: ACubismMotion = this._expressions.getValue(expressionId);

    if (this._debugMode) {
      LAppPal.printMessage(`[APP]expression: [${expressionId}]`);
    }

    if (motion != null) {
      this._expressionManager.startMotion(motion, false);
    } else {
      if (this._debugMode) {
        LAppPal.printMessage(`[APP]expression[${expressionId}] is null`);
      }
    }
  }

  /**
   * ランダムに選ばれた表情モーションをセットする
   */
  public setRandomExpression(): void {
    if (this._expressions.getSize() == 0) {
      return;
    }

    const no: number = Math.floor(Math.random() * this._expressions.getSize());

    for (let i = 0; i < this._expressions.getSize(); i++) {
      if (i == no) {
        const name: string = this._expressions._keyValues[i].first;
        this.setExpression(name);
        return;
      }
    }
  }

  /**
   * イベントの発火を受け取る
   */
  public motionEventFired(eventValue: csmString): void {
    CubismLogInfo('{0} is fired on LAppModel!!', eventValue.s);
  }

  /**
   * 当たり判定テスト
   * 指定ＩＤの頂点リストから矩形を計算し、座標をが矩形範囲内か判定する。
   *
   * @param hitArenaName  当たり判定をテストする対象のID
   * @param x             判定を行うX座標
   * @param y             判定を行うY座標
   */
  public hitTest(hitArenaName: string, x: number, y: number): boolean {
    // 透明時は当たり判定無し。
    if (this._opacity < 1) {
      return false;
    }

    const count: number = this._modelSetting.getHitAreasCount();

    for (let i = 0; i < count; i++) {
      if (this._modelSetting.getHitAreaName(i) == hitArenaName) {
        const drawId: CubismIdHandle = this._modelSetting.getHitAreaId(i);
        return this.isHit(drawId, x, y);
      }
    }

    return false;
  }

  /**
   * モーションデータをグループ名から一括でロードする。
   * モーションデータの名前は内部でModelSettingから取得する。
   *
   * @param group モーションデータのグループ名
   */
  public preLoadMotionGroup(group: string): void {
    for (let i = 0; i < this._modelSetting.getMotionCount(group); i++) {
      const motionFileName = this._modelSetting.getMotionFileName(group, i);

      // ex) idle_0
      const name = `${group}_${i}`;
      if (this._debugMode) {
        LAppPal.printMessage(
          `[APP]load motion: ${motionFileName} => [${name}]`
        );
      }

      fetch(`${this._modelHomeDir}${motionFileName}`)
        .then(response => {
          if (response.ok) {
            return response.arrayBuffer();
          } else if (response.status >= 400) {
            CubismLogError(
              `Failed to load file ${this._modelHomeDir}${motionFileName}`
            );
            return new ArrayBuffer(0);
          }
        })
        .then(arrayBuffer => {
          const tmpMotion: CubismMotion = this.loadMotion(
            arrayBuffer,
            arrayBuffer.byteLength,
            name,
            null,
            null,
            this._modelSetting,
            group,
            i,
            this._motionConsistency
          );

          if (tmpMotion != null) {
            tmpMotion.setEffectIds(this._eyeBlinkIds, this._lipSyncIds);

            if (this._motions.getValue(name) != null) {
              ACubismMotion.delete(this._motions.getValue(name));
            }

            this._motions.setValue(name, tmpMotion);

            this._motionCount++;
          } else {
            // loadMotionできなかった場合はモーションの総数がずれるので1つ減らす
            this._allMotionCount--;
          }

          if (this._motionCount >= this._allMotionCount) {
            this._state = LoadStep.LoadTexture;

            // 全てのモーションを停止する
            this._motionManager.stopAllMotions();

            this._updating = false;
            this._initialized = true;

            this.createRenderer();
            this.setupTextures();
            this.getRenderer().startUp(
              this._subdelegate.getGlManager().getGl()
            );
          }
        });
    }
  }

  /**
   * すべてのモーションデータを解放する。
   */
  public releaseMotions(): void {
    this._motions.clear();
  }

  /**
   * 全ての表情データを解放する。
   */
  public releaseExpressions(): void {
    this._expressions.clear();
  }

  /**
   * モデルを描画する処理。モデルを描画する空間のView-Projection行列を渡す。
   */
  public doDraw(): void {
    if (this._model == null) return;

    // キャンバスサイズを渡す
    const canvas = this._subdelegate.getCanvas();
    const viewport: number[] = [0, 0, canvas.width, canvas.height];

    this.getRenderer().setRenderState(
      this._subdelegate.getFrameBuffer(),
      viewport
    );
    this.getRenderer().drawModel();
  }

  /**
   * モデルを描画する処理。モデルを描画する空間のView-Projection行列を渡す。
   */
  public draw(matrix: CubismMatrix44): void {
    if (this._model == null) {
      return;
    }

    // 各読み込み終了後
    if (this._state == LoadStep.CompleteSetup) {
      matrix.multiplyByMatrix(this._modelMatrix);
      // 随拍起伏：平移整个模型，不依赖模型有没有对应参数（只在半身构图）
      if (this._poseTranslation && (this._poseOffsetX || this._poseOffsetY)) {
        matrix.translateRelative(this._poseOffsetX, this._poseOffsetY);
      }
      this._updateAnchors(matrix);

      this.getRenderer().setMvpMatrix(matrix);

      this.doDraw();
    }
  }

  public async hasMocConsistencyFromFile() {
    CSM_ASSERT(this._modelSetting.getModelFileName().localeCompare(``));

    // CubismModel
    if (this._modelSetting.getModelFileName() != '') {
      const modelFileName = this._modelSetting.getModelFileName();

      const response = await fetch(`${this._modelHomeDir}${modelFileName}`);
      const arrayBuffer = await response.arrayBuffer();

      this._consistency = CubismMoc.hasMocConsistency(arrayBuffer);

      if (!this._consistency) {
        CubismLogInfo('Inconsistent MOC3.');
      } else {
        CubismLogInfo('Consistent MOC3.');
      }

      return this._consistency;
    } else {
      LAppPal.printMessage('Model data does not exist.');
    }
  }

  public setSubdelegate(subdelegate: LAppSubdelegate): void {
    this._subdelegate = subdelegate;
  }

  /**
   * コンストラクタ
   */
  /** 待机动作组名，由 LAppLive2DManager 根据 ModelConfig 设置 */
  private _idleGroup: string = LAppDefine.MotionGroupIdle;

  public setIdleGroup(group: string): void {
    this._idleGroup = group;
  }

  /** 表情 → 手势动作组，由 LAppLive2DManager 根据 ModelConfig 设置 */
  private _gestures: Partial<Record<Expression, string>> = {};

  public setGestures(gestures: Partial<Record<Expression, string>>): void {
    this._gestures = gestures;
  }

  // ── 漫符定位：脸、脸颊、头顶此刻在画布上的位置 ──────────────────────

  /**
   * 按部件名找到的网格。用的是 Cubism 官方样例的命名（PartFace、PartCheek、PartHair…），
   * 多数模型沿用；找不到脸就退回到整个模型上部的估计
   */
  private _anchorDrawables: { face: number[]; cheek: number[]; hair: number[]; all: number[] } | null = null;
  private _anchors: ModelAnchors | null = null;

  /** 设备像素坐标（与 Live2D 画布的 width/height 一致）；模型未加载时为 null */
  public getAnchors(): ModelAnchors | null {
    return this._anchors;
  }

  private _findAnchorDrawables() {
    const model = this._model;
    const partIndex = new Map<string, number>();
    for (let i = 0; i < model.getPartCount(); i++) partIndex.set(model.getPartId(i).getString().s, i);
    const parents = model.getPartParentPartIndices();
    const under = (names: string[]): number[] => {
      const roots = new Set(names.map((n) => partIndex.get(n)).filter((i): i is number => i !== undefined));
      if (!roots.size) return [];
      const list: number[] = [];
      for (let d = 0; d < model.getDrawableCount(); d++) {
        for (let p = model.getDrawableParentPartIndex(d); p >= 0; p = parents[p]) {
          if (roots.has(p)) { list.push(d); break; }
        }
      }
      return list;
    };
    const all = Array.from({ length: model.getDrawableCount() }, (_, i) => i);
    return { face: under(['PartFace']), cheek: under(['PartCheek']), hair: under(['PartHairFront', 'PartHairBack', 'PartHairSide']), all };
  }

  /** 网格顶点在模型空间的包围盒，经 MVP 变换到画布像素 */
  private _projectBounds(drawables: number[], mvp: Float32Array, width: number, height: number): AnchorRect | null {
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const d of drawables) {
      if (this._model.getDrawableOpacity(d) <= 0) continue;
      const v = this._model.getDrawableVertices(d);
      for (let i = 0; i < v.length; i += 2) {
        if (v[i] < minX) minX = v[i];
        if (v[i] > maxX) maxX = v[i];
        if (v[i + 1] < minY) minY = v[i + 1];
        if (v[i + 1] > maxY) maxY = v[i + 1];
      }
    }
    if (minX === Infinity) return null;
    // 只有缩放和平移（正交投影），变换角点即可
    const px = (x: number) => ((mvp[0] * x + mvp[12] + 1) / 2) * width;
    const py = (y: number) => ((1 - (mvp[5] * y + mvp[13])) / 2) * height;
    const x0 = px(minX), x1 = px(maxX), y0 = py(maxY), y1 = py(minY);
    return { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  }

  private _updateAnchors(mvpMatrix: CubismMatrix44): void {
    const canvas = this._subdelegate?.getCanvas();
    if (!canvas || !this._model) return;
    this._anchorDrawables ??= this._findAnchorDrawables();
    const mvp = mvpMatrix.getArray();
    const { width, height } = canvas;
    const groups = this._anchorDrawables;
    let face = this._projectBounds(groups.face, mvp, width, height);
    const hair = this._projectBounds(groups.hair, mvp, width, height);
    if (!face) {
      // 没有标准命名的模型：取整个模型的上部，按头约占身高的 1/7 估计
      const body = this._projectBounds(groups.all, mvp, width, height);
      if (!body) { this._anchors = null; return; }
      const size = body.h / 7;
      face = { x: body.x + body.w / 2 - size / 2, y: body.y + size * 0.4, w: size, h: size };
    }
    this._anchors = {
      face,
      cheeks: this._projectBounds(groups.cheek, mvp, width, height),
      headTop: hair ? Math.min(hair.y, face.y) : face.y - face.h * 0.35,
    };
  }

  public constructor() {
    super();

    this._modelSetting = null;
    this._modelHomeDir = null;
    this._userTimeSeconds = 0.0;

    this._eyeBlinkIds = new csmVector<CubismIdHandle>();
    this._lipSyncIds = new csmVector<CubismIdHandle>();

    this._motions = new csmMap<string, ACubismMotion>();
    this._expressions = new csmMap<string, ACubismMotion>();

    this._hitArea = new csmVector<csmRect>();
    this._userArea = new csmVector<csmRect>();

    this._idParamAngleX = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamAngleX
    );
    this._idParamAngleY = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamAngleY
    );
    this._idParamAngleZ = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamAngleZ
    );
    this._idParamEyeBallX = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamEyeBallX
    );
    this._idParamEyeBallY = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamEyeBallY
    );
    this._idParamBodyAngleX = CubismFramework.getIdManager().getId(
      CubismDefaultParameterId.ParamBodyAngleX
    );

    if (LAppDefine.MOCConsistencyValidationEnable) {
      this._mocConsistency = true;
    }

    if (LAppDefine.MotionConsistencyValidationEnable) {
      this._motionConsistency = true;
    }

    this._state = LoadStep.LoadAssets;
    this._expressionCount = 0;
    this._textureCount = 0;
    this._motionCount = 0;
    this._allMotionCount = 0;
    this._wavFileHandler = new LAppWavFileHandler();
    this._consistency = false;
  }

  private _subdelegate: LAppSubdelegate;

  _modelSetting: ICubismModelSetting; // モデルセッティング情報
  _modelHomeDir: string; // モデルセッティングが置かれたディレクトリ
  _userTimeSeconds: number; // デルタ時間の積算値[秒]

  _eyeBlinkIds: csmVector<CubismIdHandle>; // モデルに設定された瞬き機能用パラメータID
  _lipSyncIds: csmVector<CubismIdHandle>; // モデルに設定されたリップシンク機能用パラメータID

  _motions: csmMap<string, ACubismMotion>; // 読み込まれているモーションのリスト
  _expressions: csmMap<string, ACubismMotion>; // 読み込まれている表情のリスト

  _hitArea: csmVector<csmRect>;
  _userArea: csmVector<csmRect>;

  _idParamAngleX: CubismIdHandle; // パラメータID: ParamAngleX
  _idParamAngleY: CubismIdHandle; // パラメータID: ParamAngleY
  _idParamAngleZ: CubismIdHandle; // パラメータID: ParamAngleZ
  _idParamEyeBallX: CubismIdHandle; // パラメータID: ParamEyeBallX
  _idParamEyeBallY: CubismIdHandle; // パラメータID: ParamEyeBAllY
  _idParamBodyAngleX: CubismIdHandle; // パラメータID: ParamBodyAngleX

  _state: LoadStep; // 現在のステータス管理用
  _expressionCount: number; // 表情データカウント
  _textureCount: number; // テクスチャカウント
  _motionCount: number; // モーションデータカウント
  _allMotionCount: number; // モーション総数
  _wavFileHandler: LAppWavFileHandler; //wavファイルハンドラ
  _consistency: boolean; // MOC3整合性チェック管理用
}
