/**
 * 最小 protobuf 读取器：B 站把进场（INTERACT_WORD_V2）和礼物（SEND_GIFT_V2）改成了
 * base64 的 protobuf，没有公开 .proto。这里只按字段号取值，字段含义见 biliDecode.ts。
 */

/** 一条消息里各字段号出现的原始值：varint 为 bigint，长度分隔为 Buffer */
export type PbMessage = Map<number, Array<bigint | Buffer>>;

export function readPb(buf: Buffer): PbMessage {
  const fields: PbMessage = new Map();
  let offset = 0;
  const varint = (): bigint => {
    let result = 0n;
    let shift = 0n;
    for (;;) {
      if (offset >= buf.length) throw new Error('truncated varint');
      const byte = buf[offset++];
      result |= BigInt(byte & 0x7f) << shift;
      if (!(byte & 0x80)) return result;
      shift += 7n;
    }
  };
  while (offset < buf.length) {
    const tag = Number(varint());
    const field = tag >> 3;
    let value: bigint | Buffer;
    switch (tag & 7) {
      case 0: value = varint(); break;
      case 1: value = buf.readBigUInt64LE(offset); offset += 8; break;
      case 2: {
        const len = Number(varint());
        if (offset + len > buf.length) throw new Error('truncated field');
        value = buf.subarray(offset, offset + len);
        offset += len;
        break;
      }
      case 5: value = BigInt(buf.readUInt32LE(offset)); offset += 4; break;
      default: throw new Error(`unsupported wire type ${tag & 7}`);
    }
    const list = fields.get(field);
    if (list) list.push(value);
    else fields.set(field, [value]);
  }
  return fields;
}

export function pbNumber(msg: PbMessage | undefined, field: number): number {
  const value = msg?.get(field)?.[0];
  return typeof value === 'bigint' ? Number(value) : 0;
}

/** uid 可能超过 2^53，按字符串取 */
export function pbId(msg: PbMessage | undefined, field: number): string {
  const value = msg?.get(field)?.[0];
  return typeof value === 'bigint' && value !== 0n ? value.toString() : '';
}

export function pbString(msg: PbMessage | undefined, field: number): string {
  const value = msg?.get(field)?.[0];
  return Buffer.isBuffer(value) ? value.toString('utf8') : '';
}

export function pbChild(msg: PbMessage | undefined, field: number): PbMessage | undefined {
  const value = msg?.get(field)?.[0];
  if (!Buffer.isBuffer(value)) return undefined;
  try {
    return readPb(value);
  } catch {
    return undefined;
  }
}
