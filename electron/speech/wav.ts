/** WAV ↔ 16-bit PCM。本地 TTS 服务返回 WAV，流式播放统一传 PCM */

export interface DecodedWav {
  sampleRate: number;
  pcm: Buffer;
}

/**
 * 解析 PCM WAV（16-bit；多声道取第一个声道）。按 chunk 遍历，不假设头部固定 44 字节
 * （有的服务会在 fmt 和 data 之间插 LIST 等块）
 */
export function decodeWav(data: Buffer): DecodedWav {
  if (data.length < 12 || data.toString('ascii', 0, 4) !== 'RIFF' || data.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('不是 WAV 数据');
  }
  let sampleRate = 0;
  let channels = 1;
  let bits = 16;
  let format = 1;
  let offset = 12;
  while (offset + 8 <= data.length) {
    const id = data.toString('ascii', offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === 'fmt ') {
      format = data.readUInt16LE(body);
      channels = data.readUInt16LE(body + 2);
      sampleRate = data.readUInt32LE(body + 4);
      bits = data.readUInt16LE(body + 14);
    } else if (id === 'data') {
      if (!sampleRate) throw new Error('WAV 缺少 fmt 块');
      if (format !== 1 || bits !== 16) throw new Error(`只支持 16-bit PCM WAV（format=${format}, bits=${bits}）`);
      // 流式写出的 WAV 常把 data 长度填成 0 或 0xFFFFFFFF：以实际剩余字节为准
      const end = size > 0 && size !== 0xffffffff ? Math.min(data.length, body + size) : data.length;
      const pcm = data.subarray(body, end - ((end - body) % (2 * channels)));
      return { sampleRate, pcm: channels === 1 ? Buffer.from(pcm) : firstChannel(pcm, channels) };
    }
    offset = body + size + (size % 2);
  }
  throw new Error('WAV 缺少 data 块');
}

function firstChannel(pcm: Buffer, channels: number): Buffer {
  const frames = pcm.length / (2 * channels);
  const out = Buffer.alloc(frames * 2);
  for (let i = 0; i < frames; i++) out.writeInt16LE(pcm.readInt16LE(i * 2 * channels), i * 2);
  return out;
}

export function encodeWav(pcm: Buffer, sampleRate: number): Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write('WAVEfmt ', 8, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}
