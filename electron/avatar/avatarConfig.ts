import type { Live2DModelProfile } from './live2dAvatar';

export interface AvatarConfig {
  activeModelId: string;
  models: Live2DModelProfile[];
}

export const BUILTIN_HIYORI_MODEL_ID = 'builtin:hiyori_pro';

export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  activeModelId: BUILTIN_HIYORI_MODEL_ID,
  models: [],
};
