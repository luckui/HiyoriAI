export interface FeishuVoiceStateReader {
  getVoiceRepliesEnabled(): boolean;
}

export function resolveFeishuVoiceRepliesEnabled(
  fallbackEnabled: boolean,
  control: FeishuVoiceStateReader | null | undefined,
): boolean {
  if (!control) return fallbackEnabled;
  try {
    return Boolean(control.getVoiceRepliesEnabled());
  } catch {
    return fallbackEnabled;
  }
}

export function buildFeishuAudioUploadData(
  fileName: string,
  opus: Buffer,
  durationMs?: number,
): { file_type: 'opus'; file_name: string; file: Buffer; duration?: number } {
  const data: { file_type: 'opus'; file_name: string; file: Buffer; duration?: number } = {
    file_type: 'opus',
    file_name: fileName,
    file: opus,
  };
  if (durationMs != null && Number.isFinite(durationMs) && durationMs > 0) {
    data.duration = Math.max(1, Math.round(durationMs));
  }
  return data;
}
