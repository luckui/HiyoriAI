
import type { AvatarConfig } from '../../shared/types/config';
export type { AvatarConfig };

export const BUILTIN_HIYORI_MODEL_ID = 'builtin:hiyori_pro';

export const DEFAULT_AVATAR_CONFIG: AvatarConfig = {
  activeModelId: BUILTIN_HIYORI_MODEL_ID,
  models: [],
};
