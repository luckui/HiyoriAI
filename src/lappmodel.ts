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

// ── 情绪预设参数表（Hiyori_pro 无 exp3，用直接参数注入实现情绪）──────────────
// 参数来源：hiyori_pro_t11.cdi3.json 确认存在的参数 ID
// 分层原则（参考 airi-main expression-controller）：
//   · 此处参数均不含 ParamMouthOpenY —— 口型由 TTS 口型同步层独立控制
//   · 表情层在 motion 更新之后、model.update() 之前执行，用 setParameterValueById 覆写
export const EMOTION_PRESETS: Record<string, Record<string, number>> = {
  neutral: {
    ParamMouthForm:   0,
    ParamBrowLY:      0,    ParamBrowRY:      0,
    ParamBrowLAngle:  0,    ParamBrowRAngle:  0,
    ParamBrowLForm:   0,    ParamBrowRForm:   0,
    ParamEyeLSmile:   0,    ParamEyeRSmile:   0,
    ParamCheek:       0,
  },
  happy: {
    // 开心：嘴角上扬 + 眉毛上抬 + 眼睛笑形 + 淡淡腮红
    ParamMouthForm:   1.0,
    ParamBrowLY:      0.5,  ParamBrowRY:      0.5,
    ParamBrowLAngle:  0,    ParamBrowRAngle:  0,
    ParamBrowLForm:   0.3,  ParamBrowRForm:   0.3,
    ParamEyeLSmile:   1.0,  ParamEyeRSmile:   1.0,
    ParamCheek:       0.4,
  },
  sad: {
    // 悲伤：嘴角下垂 + 眉毛倾斜（八字眉）+ 眼睛无笑意
    ParamMouthForm:  -0.8,
    ParamBrowLY:     -0.3,  ParamBrowRY:     -0.3,
    ParamBrowLAngle: -1.0,  ParamBrowRAngle: -1.0,
    ParamBrowLForm:  -0.5,  ParamBrowRForm:  -0.5,
    ParamEyeLSmile:   0,    ParamEyeRSmile:   0,
    ParamCheek:       0,
  },
  angry: {
    // 愤怒：嘴角轻压 + 眉毛压下 + 眉形皱起
    ParamMouthForm:  -0.5,
    ParamBrowLY:     -0.6,  ParamBrowRY:     -0.6,
    ParamBrowLAngle:  1.0,  ParamBrowRAngle:  1.0,
    ParamBrowLForm:  -0.8,  ParamBrowRForm:  -0.8,
    ParamEyeLSmile:   0,    ParamEyeRSmile:   0,
    ParamCheek:       0,
  },
  surprised: {
    // 惊讶：嘴微张形 + 眉毛高扬 + 眼睛睁大（默认眼开量由 motion 控制，此处不重写）
    ParamMouthForm:   0.3,
    ParamBrowLY:      1.0,  ParamBrowRY:      1.0,
    ParamBrowLAngle:  0,    ParamBrowRAngle:  0,
    ParamBrowLForm:   0,    ParamBrowRForm:   0,
    ParamEyeLSmile:   0,    ParamEyeRSmile:   0,
    ParamCheek:       0,
  },
  thinking: {
    // 思考：嘴角轻压 + 左眉微蹙 + 右眉微降（不对称）
    ParamMouthForm:  -0.2,
    ParamBrowLY:      0.3,  ParamBrowRY:     -0.2,
    ParamBrowLAngle:  0.5,  ParamBrowRAngle: -0.3,
    ParamBrowLForm:   0.3,  ParamBrowRForm:  -0.2,
    ParamEyeLSmile:   0,    ParamEyeRSmile:   0,
    ParamCheek:       0,
  },
  shy: {
    // 害羞：嘴角微扬 + 眉毛上抬 + 眼睛半笑形 + 强腮红
    ParamMouthForm:   0.6,
    ParamBrowLY:      0.5,  ParamBrowRY:      0.5,
    ParamBrowLAngle:  0,    ParamBrowRAngle:  0,
    ParamBrowLForm:   0.2,  ParamBrowRForm:   0.2,
    ParamEyeLSmile:   0.5,  ParamEyeRSmile:   0.5,
    ParamCheek:       1.0,
  },
  embarrassed: {
    // 尴尬：嘴角轻扬 + 眉毛微压 + 腮红最强
    ParamMouthForm:   0.2,
    ParamBrowLY:      0.2,  ParamBrowRY:      0.2,
    ParamBrowLAngle: -0.5,  ParamBrowRAngle: -0.5,
    ParamBrowLForm:  -0.3,  ParamBrowRForm:  -0.3,
    ParamEyeLSmile:   0.3,  ParamEyeRSmile:   0.3,
    ParamCheek:       1.0,
  },
};

/** neutral 复位参数 */
const EMOTION_NEUTRAL_PARAMS = EMOTION_PRESETS.neutral;

// ── 行为状态机 ──────────────────────────────────────────────────────────────
// 参考 airi-main 的 motion-manager 插件分层思路，但针对原生 SDK 实现
//
//   IDLE_CALM   →（超时 60 s）→  IDLE_BORED
//   IDLE_*      →（情绪触发）  →  REACTING
//   IDLE_*      →（TTS 开始）  →  SPEAKING
//   REACTING    →（动作播完）  →  IDLE_CALM
//   SPEAKING    →（TTS 结束）  →  POST_SPEAK（保持当前表情 2 s 再淡出）
//   POST_SPEAK  →（计时器到）  →  IDLE_CALM
//   任何状态    →（收到消息）  →  IDLE_CALM（重置 bored 计时器）
//
enum AvatarState {
  IDLE_CALM,    // 平静待机，随机 Idle 动作
  IDLE_BORED,   // 无聊，60 s 无交互后进入
  REACTING,     // 情绪响应，播一次情绪动作后回到 IDLE_CALM
  SPEAKING,     // TTS 播放中，循环 Tap/Flick
  POST_SPEAK,   // TTS 刚结束，保持表情余韵
}

// ── 情绪对应的动作组（Hiyori_pro 语义映射）────────────────────────────────
const EMOTION_TO_MOTION_GROUP: Record<string, string> = {
  happy:       'Tap',
  surprised:   'Flick',
  sad:         'FlickDown',
  angry:       'FlickUp',
  shy:         'Tap@Body',
  embarrassed: 'Tap@Body',
  thinking:    'Idle',
  neutral:     'Idle',
};

// ── 情绪持续时长建议表（毫秒）──────────────────────────────────────────────
// 原则：惊讶短（瞬间性），快乐/思考中等，悲伤/害羞长（余味绵长）
export const EMOTION_DURATION_MS: Record<string, number> = {
  happy:       4000,
  surprised:   1800,
  sad:         8000,
  angry:       3000,
  thinking:    0,     // 持续到下一个情绪（TTS 回复前整段思考期）
  shy:         6000,
  embarrassed: 6000,
  neutral:     0,     // 永久
};

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

    // POST_SPEAK 计时器
    if (this._avatarState === AvatarState.POST_SPEAK) {
      this._postSpeakElapsedSec += deltaTimeSeconds;
      if (this._postSpeakElapsedSec >= LAppModel.POST_SPEAK_LINGER_SEC) {
        this._avatarState = AvatarState.IDLE_CALM;
        this._postSpeakElapsedSec = 0;
        // 表情淡出到 neutral
        this.setEmotionParams(EMOTION_NEUTRAL_PARAMS, 500, 0);
      }
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
        case AvatarState.REACTING: {
          // 情绪动作已播完 → 回到平静待机
          this._avatarState = AvatarState.IDLE_CALM;
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
        case AvatarState.POST_SPEAK:
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

    // ドラッグによる変化
    // ドラッグによる顔の向きの調整
    this._model.addParameterValueById(this._idParamAngleX, this._dragX * 30); // -30から30の値を加える
    this._model.addParameterValueById(this._idParamAngleY, this._dragY * 30);
    this._model.addParameterValueById(
      this._idParamAngleZ,
      this._dragX * this._dragY * -30
    );

    // ドラッグによる体の向きの調整
    this._model.addParameterValueById(
      this._idParamBodyAngleX,
      this._dragX * 10
    ); // -10から10の値を加える

    // ドラッグによる目の向きの調整
    this._model.addParameterValueById(this._idParamEyeBallX, this._dragX); // -1から1の値を加える
    this._model.addParameterValueById(this._idParamEyeBallY, this._dragY);

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

    // 情绪参数过渡（直接参数控制，用于无 exp3 文件的模型）
    this._updateEmotionTransition(deltaTimeSeconds);

    // 灵动层的眉眼在表情之后叠加：表情定住的脸上也还有挑眉、眯眼这些细节
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
  /** POST_SPEAK 余韵计时（秒） */
  private _postSpeakElapsedSec = 0;

  /** 无聊阈值：60 秒无交互 */
  private static readonly BORED_THRESHOLD_SEC = 60;
  /** POST_SPEAK 余韵时长：2 秒 */
  private static readonly POST_SPEAK_LINGER_SEC = 2;
  // ── 灵动层的落地：把归一化偏移换算成本模型的参数值 ─────────────────────

  private _poseParamInfo = new Map<PoseParam, { index: number; halfRange: number; defaultValue: number } | null>();
  private _poseOffsetX = 0;
  private _poseOffsetY = 0;
  /** 随拍的整体平移只在半身构图用：全身时脚也离地，像在原地跳 */
  private _poseTranslation = false;

  public setPoseTranslation(enabled: boolean): void {
    this._poseTranslation = enabled;
  }

  /** 本模型对应参数的下标、半幅和默认值；先找标准名再找别名，都没有就是 null（跳过） */
  private _poseParam(id: PoseParam) {
    let info = this._poseParamInfo.get(id);
    if (info !== undefined) return info;
    info = null;
    for (const name of [id, ...(PARAM_ALIASES[id] ?? [])]) {
      const index = this._model.getParameterIndex(CubismFramework.getIdManager().getId(name));
      if (index >= this._model.getParameterCount()) continue;
      const min = this._model.getParameterMinimumValue(index);
      const max = this._model.getParameterMaximumValue(index);
      info = { index, halfRange: (max - min) / 2, defaultValue: this._model.getParameterDefaultValue(index) };
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
      if (info) this._model.addParameterValueByIndex(info.index, value * info.halfRange);
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
   * 设置 TTS 讲话状态（状态机版本）。
   * - true  → 进入 SPEAKING，立即打断 Idle 播放 Tap 动作
   * - false → 进入 POST_SPEAK，2 s 后自动回 IDLE_CALM，表情淡出
   */
  public setSpeaking(speaking: boolean): void {
    if (speaking) {
      if (this._avatarState === AvatarState.SPEAKING) return;
      this._avatarState = AvatarState.SPEAKING;
      this._avatarIdleElapsedSec = 0; // 重置 bored 计时器
      // 立即打断 Idle，产生「开口说话」的视觉信号（直接用 Tap 开场）
      this.startRandomMotion('Tap', LAppDefine.PriorityNormal);
    } else {
      if (
        this._avatarState !== AvatarState.SPEAKING &&
        this._avatarState !== AvatarState.POST_SPEAK
      ) return;
      this._avatarState = AvatarState.POST_SPEAK;
      this._postSpeakElapsedSec = 0;
    }
  }

  /**
   * 触发情绪反应（状态机版本）。
   * 会：① 设置表情参数过渡 ② 进入 REACTING 状态播放一次对应动作
   * 动作播完后状态机自动回到 IDLE_CALM。
   *
   * @param emotionName 情绪名（需在 EMOTION_PRESETS 中存在）
   * @param durationMs  表情持续时长（ms），默认 0 = 永久
   * @param transitionMs 表情过渡时长（ms），默认 300
   */
  public triggerReaction(emotionName: string, durationMs = 0, transitionMs = 300): void {
    const params = EMOTION_PRESETS[emotionName] ?? EMOTION_PRESETS.neutral;
    this.setEmotionParams(params, transitionMs, durationMs);
    this._avatarIdleElapsedSec = 0; // 任何交互都重置 bored 计时器

    // 若正在说话，不打断（表情生效，动作继续 SPEAKING 循环）
    if (this._avatarState === AvatarState.SPEAKING) return;

    const group = EMOTION_TO_MOTION_GROUP[emotionName] ?? 'Idle';
    this._avatarState = AvatarState.REACTING;
    this.startRandomMotion(group, LAppDefine.PriorityNormal);
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

  // ── Live2D 情绪参数直控（Hiyori 无 exp3，用参数映射代替）──────────────

  /** 当前情绪过渡目标值（参数ID → 目标值） */
  private _emotionTarget: Map<string, number> = new Map();
  /** 过渡起点值（参数ID → 触发时的快照值），避免从 motion 动态值开始插值导致抖动 */
  private _emotionStart: Map<string, number> = new Map();
  /** 情绪过渡剩余时间（ms） */
  private _emotionTransitionMs = 0;
  /** 情绪过渡总时间（ms） */
  private _emotionTransitionTotal = 300;
  /** 情绪持续定时器（ms），0 = 永久 */
  private _emotionDurationMs = 0;
  /** 情绪持续已过时间（ms） */
  private _emotionElapsedMs = 0;

  /**
   * 设置情绪参数（直接操作 Live2D 参数，用于无 exp3 文件的模型）。
   * 情绪会在 transitionMs 内平滑插值，若 durationMs > 0 则自动复位到 neutral。
   *
   * @param params      参数ID → 目标值映射
   * @param transitionMs 过渡时间（ms），默认 300
   * @param durationMs  持续时间（ms），0 = 永久，默认 0
   */
  public setEmotionParams(
    params: Record<string, number>,
    transitionMs = 300,
    durationMs = 0,
  ): void {
    // 快照当前模型参数值作为过渡起点。
    // 关键：在 motion 更新之后读取（即在 update() 中调用时已经有 motion 值了），
    // 但 setEmotionParams 是从 IPC 命令触发的，此时 model 可能刚更新过一帧。
    // 用快照而非每帧读取 current，保证过渡曲线稳定，不受 motion 曲线抖动影响。
    this._emotionStart = new Map();
    if (this._model) {
      for (const paramId of Object.keys(params)) {
        const handle = CubismFramework.getIdManager().getId(paramId);
        this._emotionStart.set(paramId, this._model.getParameterValueById(handle) as number);
      }
    }
    this._emotionTarget = new Map(Object.entries(params));
    this._emotionTransitionMs = transitionMs;
    this._emotionTransitionTotal = transitionMs;
    this._emotionDurationMs = durationMs;
    this._emotionElapsedMs = 0;
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

  /** 每帧推进情绪过渡（由 update() 调用，在 motion/物理之后、model.update() 之前执行） */
  private _updateEmotionTransition(deltaTimeSeconds: number): void {
    if (this._emotionTarget.size === 0) return;
    if (!this._model) return;

    const dtMs = deltaTimeSeconds * 1000;

    if (this._emotionTransitionMs > 0) {
      // 用已过时间计算 alpha（0→1），从快照起点线性插值到目标值。
      // 参考 airi-main expression-controller：表情参数在 final 阶段用 setParameterValueById
      // 覆盖 motion 曲线，保证表情层不受待机动画扰动影响。
      const elapsed = this._emotionTransitionTotal - this._emotionTransitionMs;
      const alpha = Math.min(1, elapsed / this._emotionTransitionTotal);
      this._emotionTarget.forEach((targetVal, paramId) => {
        const handle = CubismFramework.getIdManager().getId(paramId);
        const startVal = this._emotionStart.get(paramId) ?? 0;
        const blended = startVal + (targetVal - startVal) * alpha;
        this._model.setParameterValueById(handle, blended);
      });
      this._emotionTransitionMs -= dtMs;
    } else {
      // 过渡完成，每帧覆写目标值（确保 motion 曲线不会把表情参数拉回）
      this._emotionTarget.forEach((targetVal, paramId) => {
        const handle = CubismFramework.getIdManager().getId(paramId);
        this._model.setParameterValueById(handle, targetVal);
      });

      // 持续时间倒计时
      if (this._emotionDurationMs > 0) {
        this._emotionElapsedMs += dtMs;
        if (this._emotionElapsedMs >= this._emotionDurationMs) {
          // 自动复位到 neutral
          this.setEmotionParams(EMOTION_NEUTRAL_PARAMS, 500, 0);
        }
      }
    }
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
