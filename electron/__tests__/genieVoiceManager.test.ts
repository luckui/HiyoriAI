import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import {
  buildGenieVoicePreset,
  createGenieImportPaths,
  detectUnsupportedSovitsModel,
  findGenieVoiceSource,
  mergeBuiltinTTSProviders,
  normalizeGenieVoiceId,
  referenceTextFromAudioName,
} from '../genieVoiceManager';
import defaultTTSConfig from '../tts.config';
import type { TTSConfig } from '../tts.config';

function makeVoiceDir(name = 'March 7th'): string {
  const dir = mkdtempSync(join(tmpdir(), 'genie-voice-'));
  const voiceDir = join(dir, name);
  mkdirSync(join(voiceDir, 'reference_audios'), { recursive: true });
  writeFileSync(join(voiceDir, 'voice-e10.ckpt'), 'ckpt');
  writeFileSync(join(voiceDir, 'voice_e10_s100.pth'), 'pth');
  writeFileSync(join(voiceDir, 'reference_audios', '\u3010\u5f00\u5fc3\u3011\u4f60\u597d\uff0c\u4eca\u5929\u4e5f\u5f88\u5f00\u5fc3.wav'), 'wav');
  return voiceDir;
}

describe('Genie voice manager', () => {
  it('finds a GPT-SoVITS v2/v2ProPlus source folder', () => {
    const source = findGenieVoiceSource(makeVoiceDir());

    expect(source.ok).toBe(true);
    if (!source.ok) return;
    expect(source.name).toBe('March 7th');
    expect(source.ckptPath.endsWith('.ckpt')).toBe(true);
    expect(source.pthPath.endsWith('.pth')).toBe(true);
    expect(source.referenceAudioPath.endsWith('.wav')).toBe(true);
  });

  it('rejects clearly unsupported v3/v4 or lora sources before conversion', () => {
    expect(detectUnsupportedSovitsModel('paimon-v4-lora.pth')).toContain('V3/V4');
    expect(detectUnsupportedSovitsModel('speaker-v2ProPlus.pth')).toBeNull();
  });

  it('builds stable speaker ids and readable prompt text', () => {
    expect(normalizeGenieVoiceId('March 7th')).toBe('march-7th');
    expect(normalizeGenieVoiceId('\u4e09\u6708\u4e03')).toMatch(/^voice-[a-f0-9]{8}$/);
    expect(referenceTextFromAudioName('\u3010\u5f00\u5fc3\u3011\u4f60\u597d\uff0c\u4eca\u5929\u4e5f\u5f88\u5f00\u5fc3.wav'))
      .toBe('\u4f60\u597d\uff0c\u4eca\u5929\u4e5f\u5f88\u5f00\u5fc3');
  });

  it('returns a preset for imported Genie voices', () => {
    const preset = buildGenieVoicePreset({ voiceId: 'march-7th', displayName: 'March 7th' });

    expect(preset).toEqual({
      id: 'march-7th',
      name: 'March 7th',
      description: 'Genie-TTS custom voice',
      refAudioFile: 'reference.wav',
    });
  });

  it('preserves imported Genie voice presets when built-in providers are refreshed', () => {
    const uiConfig: TTSConfig = JSON.parse(JSON.stringify(defaultTTSConfig));
    uiConfig.providers.local_genie_tts.name = 'Genie-TTS 本地（菲比）';
    uiConfig.providers.local_genie_tts.speaker = 'march-7th';
    uiConfig.providers.local_genie_tts.voicePresets = [
      ...(uiConfig.providers.local_genie_tts.voicePresets ?? []),
      buildGenieVoicePreset({ voiceId: 'march-7th', displayName: 'March 7th' }),
    ];

    const merged = mergeBuiltinTTSProviders(uiConfig, defaultTTSConfig);

    expect(merged.providers.local_genie_tts.speaker).toBe('march-7th');
    expect(merged.providers.local_genie_tts.name).toBe(defaultTTSConfig.providers.local_genie_tts.name);
    expect(merged.providers.local_genie_tts.voicePresets?.some(v => v.id === 'march-7th')).toBe(true);
  });

  it('places conversion temp folders under the Genie voices root to avoid cross-device rename', () => {
    const voicesRoot = join('D:\\app', 'tts-server-genie', 'CharacterModels', 'v2ProPlus');
    const paths = createGenieImportPaths(voicesRoot, 'march-7th', 123);

    expect(paths.tempRoot.startsWith(join(voicesRoot, '.import-tmp'))).toBe(true);
    expect(paths.tempModels).toBe(join(paths.tempRoot, 'tts_models'));
    expect(paths.installDir).toBe(join(voicesRoot, 'march-7th'));
  });
});
