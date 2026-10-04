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
