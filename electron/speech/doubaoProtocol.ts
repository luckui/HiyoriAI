/**
 * 豆包语音 WebSocket 双向流式 V3 的二进制帧编解码（纯函数，便于测试）。
 * 协议：https://www.volcengine.com/docs/6561/1329505
 *
 *   [0x11][消息类型<<4 | flags][序列化<<4 | 压缩][0x00] [event int32]? [id 长度 + id]? [payload 长度 + payload]
 * 整数均为大端。连接类事件带 connect id，会话和数据类事件带 session id。
 */

export const DoubaoEvent = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
} as const;

const MSG_FULL_CLIENT = 0b0001;
const MSG_FULL_SERVER = 0b1001;
const MSG_AUDIO_ONLY_SERVER = 0b1011;
const MSG_ERROR = 0b1111;
const FLAG_WITH_EVENT = 0b0100;
const SERIAL_JSON = 0b0001;
const COMPRESS_GZIP = 0b0001;

/** 不带 session id 的事件（连接级的上行事件） */
const CONNECTION_REQUESTS = new Set<number>([DoubaoEvent.StartConnection, DoubaoEvent.FinishConnection]);
/** 带 connect id 的下行事件 */
const CONNECTION_RESPONSES = new Set<number>([DoubaoEvent.ConnectionStarted, DoubaoEvent.ConnectionFailed, DoubaoEvent.ConnectionFinished]);

function int32(value: number): Buffer {
  const b = Buffer.alloc(4);
  b.writeInt32BE(value);
  return b;
}

/** 上行 JSON 帧；连接级事件不带 session id */
export function encodeRequest(event: number, sessionId: string | null, payload: unknown): Buffer {
  const parts = [Buffer.from([0x11, (MSG_FULL_CLIENT << 4) | FLAG_WITH_EVENT, SERIAL_JSON << 4, 0x00]), int32(event)];
  if (!CONNECTION_REQUESTS.has(event)) {
    const id = Buffer.from(sessionId ?? '', 'utf8');
    parts.push(int32(id.length), id);
  }
  const body = Buffer.from(JSON.stringify(payload ?? {}), 'utf8');
  parts.push(int32(body.length), body);
  return Buffer.concat(parts);
}

export interface DoubaoFrame {
  /** 错误帧的错误码；正常帧为 undefined */
  errorCode?: number;
  event?: number;
  /** connect id 或 session id */
  id?: string;
  /** 音频帧为二进制，其余为解析后的 JSON（解析失败时为原始字符串） */
  audio?: Buffer;
  json?: unknown;
}

export function decodeFrame(data: Buffer, gunzip?: (b: Buffer) => Buffer): DoubaoFrame {
  if (data.length < 4) throw new Error(`帧太短：${data.length} 字节`);
  const headerSize = (data[0] & 0x0f) * 4;
  const type = data[1] >> 4;
  const flags = data[1] & 0x0f;
  const serialization = data[2] >> 4;
  const compression = data[2] & 0x0f;
  let offset = headerSize;
  const readBytes = (): Buffer => {
    const len = data.readUInt32BE(offset);
    offset += 4;
    const bytes = data.subarray(offset, offset + len);
    offset += len;
    return compression === COMPRESS_GZIP && gunzip ? gunzip(bytes) : bytes;
  };
  const toJson = (bytes: Buffer): unknown => {
    const text = bytes.toString('utf8');
    try { return text ? JSON.parse(text) : {}; } catch { return text; }
  };

  if (type === MSG_ERROR) {
    const errorCode = data.readUInt32BE(offset);
    offset += 4;
    return { errorCode, json: toJson(readBytes()) };
  }
  if (type !== MSG_FULL_SERVER && type !== MSG_AUDIO_ONLY_SERVER) throw new Error(`未知消息类型 ${type}`);

  const frame: DoubaoFrame = {};
  if (flags & FLAG_WITH_EVENT) {
    frame.event = data.readInt32BE(offset);
    offset += 4;
    // 连接类事件带 connect id，会话、数据类事件带 session id
    if (CONNECTION_RESPONSES.has(frame.event) || frame.event >= DoubaoEvent.StartSession) {
      frame.id = data.subarray(offset + 4, offset + 4 + data.readUInt32BE(offset)).toString('utf8');
      offset += 4 + data.readUInt32BE(offset);
    }
  }
  const payload = readBytes();
  if (type === MSG_AUDIO_ONLY_SERVER || serialization !== SERIAL_JSON) frame.audio = payload;
  else frame.json = toJson(payload);
  return frame;
}

/**
 * 豆包会把推进去的文本重新断句（连着推进去的几句常被合成一句返回），返回的每句只带文本。
 * 按「可读字符」的累计位置把服务端的句子对回我们 push 的句子：
 * 服务端开始一句时，找出起点落在这句里的我们的句子，以及起点在这句中的相对位置（0~1）。
 * 这句的音频时长要等它结束才知道，届时按相对位置换算成秒 —— 字数和时长大致成正比。
 */
export class SentenceAligner {
  private readonly starts: number[] = [];
  private readonly ends: number[] = [];
  private total = 0;
  private cursor = 0;

  static measure(text: string): number {
    return text.match(/[\p{L}\p{N}]/gu)?.length ?? 0;
  }

  /** 记下我们推进去的一句 */
  add(text: string): void {
    this.starts.push(this.total);
    this.total += SentenceAligner.measure(text);
    this.ends.push(this.total);
  }

  /** 推进来的句子数 */
  get size(): number {
    return this.ends.length;
  }

  /** 服务端开始一句：返回起点落在这句里的我们的句子，并把位置移到这句末尾 */
  start(serverText: string): Array<{ sentence: number; fraction: number }> {
    const from = this.cursor;
    const length = SentenceAligner.measure(serverText);
    this.cursor += length;
    const found: Array<{ sentence: number; fraction: number }> = [];
    for (let i = 0; i < this.starts.length; i++) {
      const start = this.starts[i];
      if (start >= from && (start < from + length || (length === 0 && start === from))) {
        found.push({ sentence: i, fraction: length ? (start - from) / length : 0 });
      }
    }
    return found;
  }

  /** 下一段会从哪一句开始：开头还没被走过的第一句 */
  get next(): number {
    let n = 0;
    while (n < this.starts.length && this.starts[n] < this.cursor) n++;
    return n;
  }

  /** 已经完整读完的句子数（位置走过了它的结尾） */
  get completed(): number {
    let n = 0;
    while (n < this.ends.length && this.ends[n] <= this.cursor) n++;
    return n;
  }
}


const PAUSE_FRAME_SEC = 0.01;
/** 停顿至少这么长（80 ms） */
const MIN_PAUSE_FRAMES = 8;
/** 句末标点后几乎一定有停顿，跳过它代价高；逗号后可能一口气连下去 */
const SKIP_FINAL_BOUNDARY = 1.0;
const SKIP_COMMA_BOUNDARY = 0.3;
/** 停顿越长越不该跳过：0.6 秒以上的停顿几乎一定落在标点上 */
const SKIP_PAUSE_PER_SEC = 2;
const SKIP_PAUSE_MAX = 1.2;

/**
 * 豆包把连着推进去的几句合成一段，只给整段的文本。我们的每句从这段音频的哪儿开始？
 *
 * 按字数比例分整段时长会偏早：停顿、问句尾音、拖长的语气词都不按字数分布，一串短句时
 * 能早大半秒（实测 16 句平均早 0.5 秒，最多 1.25 秒）。这里改为把文本里的标点和音频里的
 * 停顿按顺序对上：标点处多半有停顿，停顿多半在标点处。用动态规划求代价最小的对应 ——
 * 对上一对的代价是两者在「有声时间」上的距离（去掉停顿后按字数估的位置，语速不匀也不会
 * 累积误差），跳过句末标点、跳过长停顿都很贵。我们某句的开头对上了哪段停顿，起点就是那段
 * 停顿结束、重新开口的时刻；没对上就用有声时间上的估计。实测同样 16 句平均误差 0.02 秒。
 *
 * @param pcm     这一段的 16-bit 单声道 PCM
 * @param text    服务端给的这一段文本（带标点）
 * @param offsets 我们各句开头在这段文本里的位置（第几个可读字符），递增，都大于 0
 * @returns 各句起点（秒，相对这一段开头）
 */
export function locateSentenceStarts(pcm: Int16Array, sampleRate: number, text: string, offsets: number[]): number[] {
  const frame = Math.max(1, Math.round(sampleRate * PAUSE_FRAME_SEC));
  const frames = Math.floor(pcm.length / frame);
  const duration = pcm.length / sampleRate;
  const total = SentenceAligner.measure(text);
  const proportional = offsets.map((o) => (total ? (o / total) * duration : 0));
  const levels = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += pcm[i] * pcm[i];
    levels[f] = Math.sqrt(sum / frame);
  }
  const loud = [...levels].sort((a, b) => a - b)[Math.floor(frames * 0.9)] ?? 0;
  if (!loud || !total) return proportional;
  // 比说话时的音量低 20 dB 以上算没声音
  const quiet = loud * 0.1;
  // voicedBefore[f]：第 f 帧之前一共有多少有声时间
  const voicedBefore = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) voicedBefore[f + 1] = voicedBefore[f] + (levels[f] >= quiet ? PAUSE_FRAME_SEC : 0);
  const totalVoiced = voicedBefore[frames];
  if (!totalVoiced) return proportional;
  const timeAtVoiced = (v: number): number => {
    let f = 0;
    while (f < frames && voicedBefore[f + 1] < v) f++;
    return Math.min(duration, f * PAUSE_FRAME_SEC);
  };

  const pauses: Array<{ voiced: number; end: number; length: number }> = [];
  for (let f = 0; f < frames;) {
    if (levels[f] >= quiet) { f++; continue; }
    const start = f;
    while (f < frames && levels[f] < quiet) f++;
    // 开头结尾的静音不是句间停顿
    if (start > 0 && f < frames && f - start >= MIN_PAUSE_FRAMES) {
      pauses.push({ voiced: voicedBefore[start], end: f * PAUSE_FRAME_SEC, length: (f - start) * PAUSE_FRAME_SEC });
    }
  }

  // 文本里的分句点：每个标点之后重新开始的位置，以及那是不是句末标点
  const boundaries: Array<{ offset: number; final: boolean }> = [];
  let count = 0;
  let after: '' | 'comma' | 'final' = '';
  for (const ch of text) {
    if (/[\p{L}\p{N}]/u.test(ch)) {
      if (after && count > 0) boundaries.push({ offset: count, final: after === 'final' });
      after = '';
      count++;
    } else if (/[。！？.!?…]/u.test(ch)) {
      after = 'final';
    } else if (/[，、；：,;:]/u.test(ch) && after !== 'final') {
      after = 'comma';
    }
  }
  // 我们的句子边界一定算分句点（服务端改写了标点也一样）
  for (const offset of offsets) {
    if (!boundaries.some((b) => b.offset === offset)) boundaries.push({ offset, final: true });
  }
  boundaries.sort((a, b) => a.offset - b.offset);

  // 分句点 ↔ 停顿，按顺序的最小代价对应
  const n = boundaries.length;
  const m = pauses.length;
  const cost = Array.from({ length: n + 1 }, () => new Float64Array(m + 1).fill(Infinity));
  const step = Array.from({ length: n + 1 }, () => new Uint8Array(m + 1));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      if (i > 0 && j > 0) {
        const c = cost[i - 1][j - 1] + Math.abs((boundaries[i - 1].offset / total) * totalVoiced - pauses[j - 1].voiced);
        if (c < cost[i][j]) { cost[i][j] = c; step[i][j] = 1; }
      }
      if (i > 0) {
        const c = cost[i - 1][j] + (boundaries[i - 1].final ? SKIP_FINAL_BOUNDARY : SKIP_COMMA_BOUNDARY);
        if (c < cost[i][j]) { cost[i][j] = c; step[i][j] = 2; }
      }
      if (j > 0) {
        const c = cost[i][j - 1] + Math.min(SKIP_PAUSE_MAX, SKIP_PAUSE_PER_SEC * pauses[j - 1].length);
        if (c < cost[i][j]) { cost[i][j] = c; step[i][j] = 3; }
      }
    }
  }
  const matched = new Map<number, number>();
  for (let i = n, j = m; i > 0 || j > 0;) {
    if (step[i][j] === 1) { matched.set(boundaries[i - 1].offset, pauses[j - 1].end); i--; j--; }
    else if (step[i][j] === 2) i--;
    else j--;
  }
  return offsets.map((o) => matched.get(o) ?? timeAtVoiced((o / total) * totalVoiced));
}
