import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  deliverFeishuVoiceReply,
  deliverWeChatVoiceReply,
  splitBridgeVoiceSentences,
} from '../voiceReplies';
import type { TTSProviderConfig } from '../../tts.config';

const provider: TTSProviderConfig = {
  type: 'http-tts',
  name: 'Test TTS',
  baseUrl: 'http://127.0.0.1:9880',
  apiKey: '',
  speaker: 'test',
  language: 'Auto',
};

let tempDirs: string[] = [];

function makeWavBuffer(label: string): Buffer {
  const sampleRate = 16000;
  const samples = 160;
  const dataSize = samples * 2;
  const buf = Buffer.alloc(44 + dataSize);
  buf.write('RIFF', 0);
  buf.writeUInt32LE(36 + dataSize, 4);
  buf.write('WAVE', 8);
  buf.write('fmt ', 12);
  buf.writeUInt32LE(16, 16);
  buf.writeUInt16LE(1, 20);
  buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(sampleRate, 24);
  buf.writeUInt32LE(sampleRate * 2, 28);
  buf.writeUInt16LE(2, 32);
  buf.writeUInt16LE(16, 34);
  buf.write('data', 36);
  buf.writeUInt32LE(dataSize, 40);
  for (let i = 0; i < samples; i++) {
    buf.writeInt16LE((label.charCodeAt(i % label.length) % 32) * 200, 44 + i * 2);
  }
  return buf;
}

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hiyori-bridge-voice-test-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
  tempDirs = [];
});

describe('bridge voice replies', () => {
  it('splits final replies into voice-sized sentences', () => {
    expect(splitBridgeVoiceSentences('你好呀！我已经完成了。下面是结果：一切正常')).toEqual([
      '你好呀！',
      '我已经完成了。',
      '下面是结果：一切正常',
    ]);
  });

  it('sends one merged WeChat audio file before the final text reply by default', async () => {
    const calls: string[] = [];
    const synthesize = vi.fn(async (text: string) => makeWavBuffer(text));
    const encodeVoice = vi.fn(async (wav: Buffer | ArrayBuffer) => ({
      data: Buffer.from(`silk:${Buffer.from(wav).toString('utf-8')}`),
      durationMs: 1234,
      sampleRate: 24000,
      bitsPerSample: 16,
    }));
    const sendAudioFile = vi.fn(async (_userId: string, filePath: string, meta?: { playtimeMs?: number; sampleRate?: number; bitsPerSample?: number }) => {
      calls.push(`audio:${filePath.endsWith('.wav')}:${meta?.playtimeMs}:${meta?.sampleRate}:${meta?.bitsPerSample}`);
    });
    const sendText = vi.fn(async (_userId: string, text: string) => {
      calls.push(`text:${text}`);
    });

    const delivered = await deliverWeChatVoiceReply({
      userId: 'wx-user',
      text: '第一句。第二句。',
      voiceEnabled: true,
      provider,
      tempDir: makeTempDir(),
      synthesize,
      encodeVoice,
      sendAudioFile,
      sendText,
    });

    expect(delivered.voiceAttempted).toBe(true);
    expect(delivered.voiceSent).toBe(1);
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith('第一句。第二句。', provider);
    expect(encodeVoice).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('wx-user', '第一句。第二句。');
    expect(calls).toEqual(['audio:true:undefined:undefined:undefined', 'text:第一句。第二句。']);
  });

  it('sends native Feishu audio bubbles sentence by sentence before the final text reply', async () => {
    const calls: string[] = [];
    const synthesize = vi.fn(async (text: string) => makeWavBuffer(text));
    const encodeOpus = vi.fn(async () => Buffer.from('opus'));
    const sendAudio = vi.fn(async (_chatId: string, opus: Buffer, fileName: string, meta?: { durationMs?: number }) => {
      calls.push(`audio:${opus.toString('utf-8')}:${fileName.endsWith('.opus')}:${meta?.durationMs}`);
    });
    const sendText = vi.fn(async (_chatId: string, text: string) => {
      calls.push(`text:${text}`);
    });

    const delivered = await deliverFeishuVoiceReply({
      chatId: 'oc_chat',
      text: 'First sentence. Second sentence!',
      voiceEnabled: true,
      provider,
      synthesize,
      encodeOpus,
      sendAudio,
      sendText,
    });

    expect(delivered.voiceAttempted).toBe(true);
    expect(delivered.voiceSent).toBe(2);
    expect(synthesize).toHaveBeenNthCalledWith(1, 'First sentence.', provider);
    expect(synthesize).toHaveBeenNthCalledWith(2, 'Second sentence!', provider);
    expect(calls).toEqual([
      'audio:opus:true:10',
      'audio:opus:true:10',
      'text:First sentence. Second sentence!',
    ]);
  });

  it('falls back to Feishu text when native audio delivery fails', async () => {
    const sendAudio = vi.fn(async () => {});
    const sendText = vi.fn(async () => {});

    const delivered = await deliverFeishuVoiceReply({
      chatId: 'oc_chat',
      text: 'audio unavailable',
      voiceEnabled: true,
      provider,
      synthesize: async () => Buffer.from('wav'),
      encodeOpus: async () => {
        throw new Error('ffmpeg missing');
      },
      sendAudio,
      sendText,
    });

    expect(delivered.voiceAttempted).toBe(true);
    expect(delivered.voiceSent).toBe(0);
    expect(delivered.voiceError).toContain('ffmpeg missing');
    expect(sendAudio).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('oc_chat', 'audio unavailable');
  });

  it('keeps a native WeChat voice mode for future platform support', async () => {
    const calls: string[] = [];
    const synthesize = vi.fn(async (text: string) => Buffer.from(`wav:${text}`));
    const encodeVoice = vi.fn(async (wav: Buffer | ArrayBuffer) => ({
      data: Buffer.from(`silk:${Buffer.from(wav).toString('utf-8')}`),
      durationMs: 1234,
      sampleRate: 24000,
      bitsPerSample: 16,
    }));
    const sendAudioFile = vi.fn(async (_userId: string, filePath: string, meta?: { playtimeMs?: number; sampleRate?: number; bitsPerSample?: number }) => {
      calls.push(`audio:${filePath.endsWith('.silk')}:${meta?.playtimeMs}:${meta?.sampleRate}:${meta?.bitsPerSample}`);
    });
    const sendText = vi.fn(async (_userId: string, text: string) => {
      calls.push(`text:${text}`);
    });

    const delivered = await deliverWeChatVoiceReply({
      userId: 'wx-user',
      text: '第一句。',
      voiceEnabled: true,
      voiceDeliveryMode: 'native_voice',
      provider,
      tempDir: makeTempDir(),
      synthesize,
      encodeVoice,
      sendAudioFile,
      sendText,
    });

    expect(delivered.voiceSent).toBe(1);
    expect(encodeVoice).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(['audio:true:1234:24000:16', 'text:第一句。']);
  });

  it('falls back to text when voice synthesis fails', async () => {
    const sendAudioFile = vi.fn(async () => {});
    const sendText = vi.fn(async () => {});

    const delivered = await deliverWeChatVoiceReply({
      userId: 'wx-user',
      text: '语音失败也要发文字。',
      voiceEnabled: true,
      provider,
      tempDir: makeTempDir(),
      synthesize: async () => {
        throw new Error('tts down');
      },
      sendAudioFile,
      sendText,
    });

    expect(delivered.voiceAttempted).toBe(true);
    expect(delivered.voiceSent).toBe(0);
    expect(delivered.voiceError).toContain('tts down');
    expect(sendAudioFile).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('wx-user', '语音失败也要发文字。');
  });

  it('does not send audio files when synthesized audio is not WAV', async () => {
    const sendAudioFile = vi.fn(async () => {});
    const sendText = vi.fn(async () => {});

    const delivered = await deliverWeChatVoiceReply({
      userId: 'wx-user',
      text: '这次音频格式异常。',
      voiceEnabled: true,
      provider,
      tempDir: makeTempDir(),
      synthesize: async () => Buffer.from('not wav'),
      sendAudioFile,
      sendText,
    });

    expect(delivered.voiceAttempted).toBe(true);
    expect(delivered.voiceSent).toBe(0);
    expect(delivered.voiceError).toContain('non-WAV');
    expect(sendAudioFile).not.toHaveBeenCalled();
    expect(sendText).toHaveBeenCalledWith('wx-user', '这次音频格式异常。');
  });

  it('cleans the full text once for WeChat audio file delivery', async () => {
    const synthesize = vi.fn(async () => makeWavBuffer('cleaned'));
    const sendAudioFile = vi.fn(async () => {});
    const sendText = vi.fn(async () => {});

    await deliverWeChatVoiceReply({
      userId: 'wx-user',
      text: '你好呀！（挥手）**重点**：《项目》`done` 已经完成啦 🎉',
      voiceEnabled: true,
      provider,
      tempDir: makeTempDir(),
      synthesize,
      sendAudioFile,
      sendText,
    });

    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(synthesize).toHaveBeenCalledWith('你好呀！重点：项目 done 已经完成啦', provider);
  });
});
