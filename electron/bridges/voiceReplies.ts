import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import ffmpeg from '@ffmpeg-installer/ffmpeg';
import type { TTSProviderConfig } from '../tts.config';

export type WeChatVoiceDeliveryMode = 'audio_file' | 'native_voice';

export interface WeChatVoiceReplyDeps {
  userId: string;
  text: string;
  voiceEnabled: boolean;
  voiceDeliveryMode?: WeChatVoiceDeliveryMode;
  provider: TTSProviderConfig | null | undefined;
  tempDir?: string;
  synthesize?: (text: string, provider: TTSProviderConfig) => Promise<ArrayBuffer | Buffer>;
  encodeVoice?: (wav: ArrayBuffer | Buffer) => Promise<WeChatVoiceEncoding>;
  sendAudioFile: (userId: string, filePath: string, meta?: WeChatVoiceFileMeta) => Promise<void>;
  sendText: (userId: string, text: string) => Promise<void>;
}

export interface WeChatVoiceEncoding {
  data: Uint8Array | Buffer;
  durationMs: number;
  sampleRate?: number;
  bitsPerSample?: number;
}

export interface WeChatVoiceFileMeta {
  playtimeMs?: number;
  sampleRate?: number;
  bitsPerSample?: number;
}

export interface WeChatVoiceReplyResult {
  voiceAttempted: boolean;
  voiceSent: number;
  voiceError?: string;
}

export interface FeishuVoiceReplyDeps {
  chatId: string;
  text: string;
  voiceEnabled: boolean;
  provider: TTSProviderConfig | null | undefined;
  tempDir?: string;
  synthesize?: (text: string, provider: TTSProviderConfig) => Promise<ArrayBuffer | Buffer>;
  encodeOpus?: (wav: ArrayBuffer | Buffer) => Promise<Buffer>;
  sendAudio: (chatId: string, opus: Buffer, fileName: string, meta?: FeishuVoiceMeta) => Promise<void>;
  sendText: (chatId: string, text: string) => Promise<void>;
}

export interface FeishuVoiceMeta {
  durationMs?: number;
}

export interface FeishuVoiceReplyResult {
  voiceAttempted: boolean;
  voiceSent: number;
  voiceError?: string;
}

interface BridgeVoiceRuntime {
  getProvider: () => TTSProviderConfig | null | undefined;
  ensureProviderReady?: (provider: TTSProviderConfig) => Promise<void>;
}

const MAX_VOICE_SENTENCES = 8;
const MAX_SENTENCE_LENGTH = 180;
const WAV_HEADER_BYTES = 44;
const RE_EMOJI = /\p{Extended_Pictographic}[\u{FE0F}\u{FE0E}\u{200D}\u{20E3}\p{Extended_Pictographic}]*/gu;
let runtime: BridgeVoiceRuntime = {
  getProvider: () => null,
};

export function configureBridgeVoiceRuntime(nextRuntime: BridgeVoiceRuntime): void {
  runtime = nextRuntime;
}

export async function getReadyBridgeVoiceProvider(): Promise<TTSProviderConfig | null> {
  const provider = runtime.getProvider();
  if (!provider) return null;
  await runtime.ensureProviderReady?.(provider);
  return provider;
}

export function splitBridgeVoiceSentences(text: string): string[] {
  const normalized = cleanBridgeVoiceText(text);
  if (!normalized) return [];
  const readableSentences = normalized.match(/[^。！？!?；;.!?]+[。！？!?；;.!?]?/g) ?? [normalized];
  const readableChunks: string[] = [];
  for (const sentence of readableSentences.map(s => s.trim()).filter(Boolean)) {
    if (sentence.length <= MAX_SENTENCE_LENGTH) {
      readableChunks.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += MAX_SENTENCE_LENGTH) {
      readableChunks.push(sentence.slice(i, i + MAX_SENTENCE_LENGTH));
    }
  }
  return readableChunks.slice(0, MAX_VOICE_SENTENCES);

  const sentences = normalized.match(/[^。！？!?；;]+[。！？!?；;]?/g) ?? [normalized];
  const chunks: string[] = [];
  for (const sentence of sentences.map(s => s.trim()).filter(Boolean)) {
    if (sentence.length <= MAX_SENTENCE_LENGTH) {
      chunks.push(sentence);
      continue;
    }
    for (let i = 0; i < sentence.length; i += MAX_SENTENCE_LENGTH) {
      chunks.push(sentence.slice(i, i + MAX_SENTENCE_LENGTH));
    }
  }
  return chunks.slice(0, MAX_VOICE_SENTENCES);
}

export function cleanBridgeVoiceText(text: string): string {
  return text
    .replace(/（[^（）]*）/g, '')
    .replace(/\([^()]*\)/g, '')
    .replace(/【([^【】]*)】/g, '$1')
    .replace(/「([^「」]*)」/g, '$1')
    .replace(/『([^『』]*)』/g, '$1')
    .replace(/《([^《》]*)》/g, '$1')
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/\*(.+?)\*/g, '$1')
    .replace(/\*[^*\n]{1,30}\*/g, '')
    .replace(/```([\s\S]*?)```/g, ' $1 ')
    .replace(/`([^`\n]+)`/g, ' $1 ')
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
    .replace(/^#{1,6}\s/gm, '')
    .replace(/^[-*+]\s/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/[_~|]/g, '')
    .replace(RE_EMOJI, '，')
    .replace(/[，,]{2,}/g, '，')
    .replace(/([。！？!?…])，/g, '$1')
    .replace(/，[。！？!?…]/g, match => match.slice(1))
    .replace(/^\s*[，,]\s*/g, '')
    .replace(/\s*[，,]\s*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export async function synthesizeBridgeVoice(
  text: string,
  provider: TTSProviderConfig,
): Promise<ArrayBuffer> {
  const baseUrl = provider.baseUrl.replace(/\/+$/, '');
  const resp = await fetch(`${baseUrl}/tts/generate`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}),
    },
    body: JSON.stringify({
      text,
      speaker: provider.speaker,
      language: provider.language,
    }),
  });

  if (!resp.ok) {
    const detail = await resp.text().catch(() => '');
    throw new Error(`TTS ${resp.status}: ${detail.slice(0, 160)}`);
  }
  return resp.arrayBuffer();
}

export async function encodeWeChatSilkVoice(
  wav: ArrayBuffer | Buffer,
): Promise<WeChatVoiceEncoding> {
  const silk = await import('silk-wasm');
  const wavBuffer = Buffer.from(wav);
  const wavInfo = silk.isWav(wavBuffer) ? silk.getWavFileInfo(wavBuffer) : null;
  const encoded = await silk.encode(wavBuffer, 0);
  return {
    data: encoded.data,
    durationMs: encoded.duration,
    sampleRate: wavInfo?.fmt.sampleRate,
    bitsPerSample: wavInfo?.fmt.bitsPerSample,
  };
}

interface WavInfo {
  audioFormat: number;
  channels: number;
  sampleRate: number;
  byteRate: number;
  blockAlign: number;
  bitsPerSample: number;
  dataOffset: number;
  dataSize: number;
}

function parseSimplePcmWav(wav: Buffer): WavInfo {
  if (
    wav.length < WAV_HEADER_BYTES ||
    wav.toString('ascii', 0, 4) !== 'RIFF' ||
    wav.toString('ascii', 8, 12) !== 'WAVE' ||
    wav.toString('ascii', 12, 16) !== 'fmt '
  ) {
    throw new Error('TTS returned non-WAV audio');
  }

  const fmtSize = wav.readUInt32LE(16);
  const audioFormat = wav.readUInt16LE(20);
  const channels = wav.readUInt16LE(22);
  const sampleRate = wav.readUInt32LE(24);
  const byteRate = wav.readUInt32LE(28);
  const blockAlign = wav.readUInt16LE(32);
  const bitsPerSample = wav.readUInt16LE(34);
  let offset = 20 + fmtSize;
  while (offset + 8 <= wav.length) {
    const chunkId = wav.toString('ascii', offset, offset + 4);
    const chunkSize = wav.readUInt32LE(offset + 4);
    if (chunkId === 'data') {
      return {
        audioFormat,
        channels,
        sampleRate,
        byteRate,
        blockAlign,
        bitsPerSample,
        dataOffset: offset + 8,
        dataSize: chunkSize,
      };
    }
    offset += 8 + chunkSize + (chunkSize % 2);
  }
  throw new Error('TTS WAV audio has no data chunk');
}

function getPcmWavDurationMs(wav: Buffer | ArrayBuffer): number | undefined {
  try {
    const info = parseSimplePcmWav(Buffer.from(wav));
    return Math.max(1, Math.round((info.dataSize / info.byteRate) * 1000));
  } catch {
    return undefined;
  }
}

export function mergePcmWavBuffers(wavs: Array<Buffer | ArrayBuffer>): Buffer {
  if (wavs.length === 0) throw new Error('No WAV audio to merge');
  const buffers = wavs.map(wav => Buffer.from(wav));
  const firstInfo = parseSimplePcmWav(buffers[0]);
  if (firstInfo.audioFormat !== 1) {
    throw new Error(`Unsupported WAV format: ${firstInfo.audioFormat}`);
  }

  const dataChunks: Buffer[] = [];
  let totalDataSize = 0;
  for (const buffer of buffers) {
    const info = parseSimplePcmWav(buffer);
    const compatible =
      info.audioFormat === firstInfo.audioFormat &&
      info.channels === firstInfo.channels &&
      info.sampleRate === firstInfo.sampleRate &&
      info.bitsPerSample === firstInfo.bitsPerSample &&
      info.blockAlign === firstInfo.blockAlign;
    if (!compatible) {
      throw new Error('TTS WAV chunks have incompatible formats');
    }
    const data = buffer.subarray(info.dataOffset, info.dataOffset + info.dataSize);
    dataChunks.push(data);
    totalDataSize += data.length;
  }

  const out = Buffer.alloc(WAV_HEADER_BYTES + totalDataSize);
  out.write('RIFF', 0);
  out.writeUInt32LE(36 + totalDataSize, 4);
  out.write('WAVE', 8);
  out.write('fmt ', 12);
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(firstInfo.audioFormat, 20);
  out.writeUInt16LE(firstInfo.channels, 22);
  out.writeUInt32LE(firstInfo.sampleRate, 24);
  out.writeUInt32LE(firstInfo.byteRate, 28);
  out.writeUInt16LE(firstInfo.blockAlign, 32);
  out.writeUInt16LE(firstInfo.bitsPerSample, 34);
  out.write('data', 36);
  out.writeUInt32LE(totalDataSize, 40);
  Buffer.concat(dataChunks).copy(out, WAV_HEADER_BYTES);
  return out;
}

export async function deliverWeChatVoiceReply(
  deps: WeChatVoiceReplyDeps,
): Promise<WeChatVoiceReplyResult> {
  const result: WeChatVoiceReplyResult = {
    voiceAttempted: false,
    voiceSent: 0,
  };

  if (deps.voiceEnabled && deps.provider) {
    result.voiceAttempted = true;
    const synthesize = deps.synthesize ?? synthesizeBridgeVoice;
    const deliveryMode = deps.voiceDeliveryMode ?? 'audio_file';
    const tempDir = deps.tempDir ?? join(tmpdir(), 'hiyori-bridge-voice');
    await mkdir(tempDir, { recursive: true });

    try {
      if (deliveryMode === 'audio_file') {
        const cleaned = cleanBridgeVoiceText(deps.text);
        if (!cleaned) throw new Error('Voice reply text is empty after cleanup');
        console.log(`[BridgeVoice] WeChat audio_file synthesize full text (${cleaned.length} chars): ${cleaned.slice(0, 120)}`);
        const mergedWav = Buffer.from(await synthesize(cleaned, deps.provider));
        parseSimplePcmWav(mergedWav);
        const filePath = join(tempDir, `wechat-${Date.now()}-merged.wav`);
        await writeFile(filePath, mergedWav);
        try {
          await deps.sendAudioFile(deps.userId, filePath);
          result.voiceSent++;
        } finally {
          await rm(filePath, { force: true }).catch(() => {});
        }
      } else {
        const sentences = splitBridgeVoiceSentences(deps.text);
        const wavs: Array<Buffer | ArrayBuffer> = [];
        for (let i = 0; i < sentences.length; i++) {
          wavs.push(await synthesize(sentences[i], deps.provider));
        }
        for (let i = 0; i < wavs.length; i++) {
          const wav = wavs[i];
          const encodeVoice = deps.encodeVoice ?? encodeWeChatSilkVoice;
          const voice = await encodeVoice(wav);
          const filePath = join(tempDir, `wechat-${Date.now()}-${i}.silk`);
          await writeFile(filePath, Buffer.from(voice.data));
          try {
            await deps.sendAudioFile(deps.userId, filePath, {
              playtimeMs: voice.durationMs,
              sampleRate: voice.sampleRate,
              bitsPerSample: voice.bitsPerSample,
            });
            result.voiceSent++;
          } finally {
            await rm(filePath, { force: true }).catch(() => {});
          }
        }
      }
    } catch (error) {
      result.voiceError = (error as Error).message ?? String(error);
      console.warn('[BridgeVoice] WeChat voice delivery skipped:', result.voiceError);
    }
  }

  await deps.sendText(deps.userId, deps.text);
  return result;
}

function resolveFfmpegCommand(): string {
  const configured = process.env['FFMPEG_PATH'] || process.env['FFMPEG_BIN'];
  if (configured) return configured;

  const packaged = process.resourcesPath
    ? join(process.resourcesPath, 'tools', process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
    : '';
  if (packaged && existsSync(packaged)) return packaged;

  if (ffmpeg.path && existsSync(ffmpeg.path)) return ffmpeg.path;
  return 'ffmpeg';
}

function runFfmpeg(args: string[]): Promise<void> {
  const command = resolveFfmpegCommand();

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stderr = '';
    child.stderr?.on('data', chunk => {
      stderr += Buffer.from(chunk).toString('utf-8');
    });
    child.on('error', (error) => {
      reject(new Error(`Feishu audio needs ffmpeg: ${error.message}`));
    });
    child.on('close', code => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`ffmpeg exited with code ${code}: ${stderr.slice(0, 300)}`));
    });
  });
}

async function mkBridgeVoiceTempDir(): Promise<string> {
  const dir = join(tmpdir(), `hiyori-bridge-voice-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function encodeFeishuOpusVoice(
  wav: ArrayBuffer | Buffer,
): Promise<Buffer> {
  const tempDir = await mkBridgeVoiceTempDir();
  const inputPath = join(tempDir, 'input.wav');
  const outputPath = join(tempDir, 'output.opus');
  await writeFile(inputPath, Buffer.from(wav));
  try {
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-loglevel',
      'error',
      '-i',
      inputPath,
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libopus',
      '-b:a',
      '24k',
      outputPath,
    ]);
    return await readFile(outputPath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function deliverFeishuVoiceReply(
  deps: FeishuVoiceReplyDeps,
): Promise<FeishuVoiceReplyResult> {
  const result: FeishuVoiceReplyResult = {
    voiceAttempted: false,
    voiceSent: 0,
  };

  if (deps.voiceEnabled && deps.provider) {
    result.voiceAttempted = true;
    const synthesize = deps.synthesize ?? synthesizeBridgeVoice;
    const encodeOpus = deps.encodeOpus ?? encodeFeishuOpusVoice;

    try {
      const sentences = splitBridgeVoiceSentences(deps.text);
      if (sentences.length === 0) throw new Error('Voice reply text is empty after cleanup');
      for (let i = 0; i < sentences.length; i++) {
        const wav = await synthesize(sentences[i], deps.provider);
        const opus = await encodeOpus(wav);
        await deps.sendAudio(deps.chatId, opus, `feishu-${Date.now()}-${i}.opus`, {
          durationMs: getPcmWavDurationMs(wav),
        });
        result.voiceSent++;
      }
    } catch (error) {
      result.voiceError = (error as Error).message ?? String(error);
      console.warn('[BridgeVoice] Feishu voice delivery skipped:', result.voiceError);
    }
  }

  await deps.sendText(deps.chatId, deps.text);
  return result;
}
