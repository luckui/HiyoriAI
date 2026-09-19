/**
 * 结果格式（result_schema）— 批量子任务的结构化输出约定
 *
 * 字段由发起批量任务的 LLM 按任务声明，系统不预设任何字段。系统负责：
 *   1. 创建时校验声明本身（normalizeResultSchema）：类型、取值范围、可选值等写错直接拒绝并给出修正提示；
 *      同时接受简写 {"score": "integer"}、标准 JSON Schema 的 properties/required 写法与常见类型别名
 *   2. 子任务完成时校验输出（validateResult）：从回复中提取 JSON 并逐字段检查，常见宽松写法会被规范化
 *   3. 汇总（resultsToCsv / summarizeResults）：生成 CSV 表与数值、可选值统计，主智能体不必自己数和算
 *
 * 只支持扁平字段（每个字段对应 CSV 的一列）：string / number / integer / boolean / array（文本列表）。
 * 声明是否符合任务意图（例如分数范围写成 0–10）无法事先判断：这类问题会表现为大量子任务格式不符，
 * 由批量任务的熔断在少量调用后停下，并提示检查 result_schema。
 */

export type ResultFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array';

export interface ResultField {
  type: ResultFieldType;
  description?: string;
  /** 可选值（array 类型约束每个元素） */
  enum?: Array<string | number>;
  minimum?: number;
  maximum?: number;
  /** 默认必填 */
  optional?: boolean;
}

export type ResultSchema = Record<string, ResultField>;

export type NormalizedSchema = { schema: ResultSchema; errors?: undefined } | { schema?: undefined; errors: string[] };
export type ValidationResult = { ok: true; value: Record<string, unknown> } | { ok: false; errors: string[] };

/** 子任务因输出格式不符而失败时，错误信息的固定前缀（批量任务据此识别并给出提示） */
export const FORMAT_ERROR_PREFIX = '结果不符合格式要求';

const MAX_FIELDS = 30;
const MAX_FIELD_NAME_LENGTH = 40;
/** 结果表的固定列 */
const RESERVED_COLUMNS = new Set(['序号', '数据项', '状态', '失败原因']);

const TYPE_ALIASES: Record<string, ResultFieldType> = {
  string: 'string', str: 'string', text: 'string', 文本: 'string', 字符串: 'string',
  number: 'number', float: 'number', double: 'number', decimal: 'number', 数字: 'number', 数值: 'number', 小数: 'number',
  integer: 'integer', int: 'integer', 整数: 'integer',
  boolean: 'boolean', bool: 'boolean', 布尔: 'boolean', 是否: 'boolean',
  array: 'array', list: 'array', 'string[]': 'array', 列表: 'array', 数组: 'array',
};

const TYPE_LABELS: Record<ResultFieldType, string> = {
  string: '文本',
  number: '数字',
  integer: '整数',
  boolean: '是/否',
  array: '文本列表',
};

// ── 1. 校验声明 ───────────────────────────────────────────

export function normalizeResultSchema(input: unknown): NormalizedSchema {
  let raw = input;
  if (typeof raw === 'string') {
    try {
      raw = JSON.parse(raw);
    } catch {
      return { errors: ['result_schema 不是合法的 JSON'] };
    }
  }
  if (!isPlainObject(raw)) {
    return { errors: ['result_schema 必须是对象：{"字段名": "类型"} 或 {"字段名": {"type": "类型", ...}}'] };
  }

  let fields: Record<string, unknown> = raw;
  let requiredList: string[] | undefined;
  // 兼容标准 JSON Schema 写法：{"type": "object", "properties": {...}, "required": [...]}
  if (isPlainObject(raw.properties) && (raw.type === undefined || raw.type === 'object')) {
    fields = raw.properties;
    requiredList = Array.isArray(raw.required) ? raw.required.map(String) : undefined;
  }

  const names = Object.keys(fields);
  const errors: string[] = [];
  if (names.length === 0) errors.push('至少声明一个字段');
  if (names.length > MAX_FIELDS) errors.push(`字段过多（${names.length} 个），最多 ${MAX_FIELDS} 个`);

  const schema: ResultSchema = {};
  for (const name of names) {
    const label = `字段「${name}」`;
    if (!name.trim()) {
      errors.push('字段名不能为空');
      continue;
    }
    if (name.length > MAX_FIELD_NAME_LENGTH) {
      errors.push(`${label}名称过长（最多 ${MAX_FIELD_NAME_LENGTH} 个字符）`);
      continue;
    }
    if (RESERVED_COLUMNS.has(name)) {
      errors.push(`${label}与结果表的固定列重名，请换一个名字`);
      continue;
    }

    const spec = fields[name];
    const def: Record<string, unknown> | undefined = typeof spec === 'string' ? { type: spec } : isPlainObject(spec) ? spec : undefined;
    if (!def) {
      errors.push(`${label}的定义应为类型名，或 {"type": "类型", ...}`);
      continue;
    }
    const rawType = String(def.type ?? '').trim();
    if (rawType.toLowerCase() === 'object' || rawType === '对象') {
      errors.push(`${label}：不支持嵌套对象，请拆成多个字段`);
      continue;
    }
    const type = TYPE_ALIASES[rawType.toLowerCase()] ?? TYPE_ALIASES[rawType];
    if (!type) {
      errors.push(`${label}：未知类型 "${rawType}"，可用类型：string / number / integer / boolean / array`);
      continue;
    }

    const field: ResultField = { type };
    if (def.description !== undefined) field.description = String(def.description);

    if (def.enum !== undefined) {
      if (!Array.isArray(def.enum) || def.enum.length === 0) {
        errors.push(`${label}：enum 应为非空数组`);
      } else if (type === 'string' || type === 'array') {
        field.enum = def.enum.map((option) => String(option));
      } else if (type === 'number' || type === 'integer') {
        const options = def.enum.map(Number);
        if (options.some((option) => !Number.isFinite(option))) errors.push(`${label}：enum 中的值必须都是数字`);
        else field.enum = options;
      } else {
        errors.push(`${label}：${TYPE_LABELS[type]}类型不能设置 enum`);
      }
    }

    for (const key of ['minimum', 'maximum'] as const) {
      if (def[key] === undefined) continue;
      if (type !== 'number' && type !== 'integer') {
        errors.push(`${label}：只有数字 / 整数字段可以设置 ${key}`);
        continue;
      }
      const bound = Number(def[key]);
      if (Number.isFinite(bound)) field[key] = bound;
      else errors.push(`${label}：${key} 必须是数字`);
    }
    if (field.minimum !== undefined && field.maximum !== undefined && field.minimum > field.maximum) {
      errors.push(`${label}：minimum（${field.minimum}）大于 maximum（${field.maximum}）`);
    }

    // 默认必填；JSON Schema 写法里带了 required 列表时以它为准
    if (def.optional === true || def.required === false || (requiredList && !requiredList.includes(name))) {
      field.optional = true;
    }
    schema[name] = field;
  }

  return errors.length > 0 ? { errors } : { schema };
}

/** 给子任务 / 主智能体看的字段说明 */
export function describeResultSchema(schema: ResultSchema): string {
  return Object.entries(schema).map(([name, field]) => {
    const parts = [TYPE_LABELS[field.type]];
    if (field.minimum !== undefined || field.maximum !== undefined) {
      parts.push(`${field.minimum ?? '不限'}–${field.maximum ?? '不限'}`);
    }
    if (field.enum) parts.push(`只能是：${field.enum.join(' / ')}`);
    parts.push(field.optional ? '可选' : '必填');
    return `- ${name}（${parts.join('，')}）${field.description ? `：${field.description}` : ''}`;
  }).join('\n');
}

/** 符合声明的示例 JSON（值仅示意格式） */
export function exampleResult(schema: ResultSchema): string {
  const example: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(schema)) {
    switch (field.type) {
      case 'integer':
      case 'number':
        example[name] = field.enum?.[0] ?? field.minimum ?? 0;
        break;
      case 'boolean':
        example[name] = true;
        break;
      case 'array':
        example[name] = [field.enum?.[0] ?? '…'];
        break;
      default:
        example[name] = field.enum?.[0] ?? '…';
    }
  }
  return JSON.stringify(example);
}

// ── 2. 校验输出 ───────────────────────────────────────────

/** 从子任务回复中提取 JSON 并按声明逐字段校验；通过时返回只含声明字段、已规范化的值 */
export function validateResult(text: string, schema: ResultSchema): ValidationResult {
  const candidate = extractJsonObject(text);
  if (!candidate) return { ok: false, errors: ['回复中没有找到 JSON 对象'] };

  const value: Record<string, unknown> = {};
  const errors: string[] = [];
  for (const [name, field] of Object.entries(schema)) {
    const raw = candidate[name];
    if (raw === undefined || raw === null || raw === '') {
      if (!field.optional) errors.push(`缺少字段「${name}」`);
      continue;
    }
    const coerced = coerceValue(raw, field);
    if ('error' in coerced) errors.push(`字段「${name}」${coerced.error}`);
    else value[name] = coerced.value;
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value };
}

/** 依次尝试：整段回复、```json 代码块、文本中每个顶层 {...}；返回第一个能解析成对象的 */
export function extractJsonObject(text: string): Record<string, unknown> | undefined {
  const candidates = [text.trim()];
  for (const match of text.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) candidates.push(match[1].trim());

  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"' && depth > 0) {
      inString = true;
    } else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}' && depth > 0) {
      depth -= 1;
      if (depth === 0) candidates.push(text.slice(start, i + 1));
    }
  }

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate);
      if (isPlainObject(parsed)) return parsed;
    } catch {
      // 继续尝试下一个候选
    }
  }
  return undefined;
}

function coerceValue(raw: unknown, field: ResultField): { value: unknown } | { error: string } {
  switch (field.type) {
    case 'string':
      if (typeof raw === 'object') return { error: `应为文本，得到 ${JSON.stringify(raw)}` };
      return checkEnum(String(raw).trim(), field);

    case 'number':
    case 'integer': {
      // 常见的宽松写法："85" → 85
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw.trim()) : NaN;
      if (!Number.isFinite(n)) return { error: `应为${TYPE_LABELS[field.type]}，得到 ${JSON.stringify(raw)}` };
      if (field.type === 'integer' && !Number.isInteger(n)) return { error: `应为整数，得到 ${n}` };
      if (field.minimum !== undefined && n < field.minimum) return { error: `不能小于 ${field.minimum}，得到 ${n}` };
      if (field.maximum !== undefined && n > field.maximum) return { error: `不能大于 ${field.maximum}，得到 ${n}` };
      if (field.enum && !field.enum.includes(n)) return { error: `只能是 ${field.enum.join(' / ')}，得到 ${n}` };
      return { value: n };
    }

    case 'boolean': {
      if (typeof raw === 'boolean') return { value: raw };
      const text = String(raw).trim().toLowerCase();
      if (['true', 'yes', '是', '1'].includes(text)) return { value: true };
      if (['false', 'no', '否', '0'].includes(text)) return { value: false };
      return { error: `应为 true / false，得到 ${JSON.stringify(raw)}` };
    }

    case 'array': {
      const list = Array.isArray(raw) ? raw : [raw];
      if (list.some((item) => item !== null && typeof item === 'object')) return { error: '应为文本列表' };
      const values: string[] = [];
      for (const item of list.map((entry) => String(entry ?? '').trim()).filter(Boolean)) {
        const checked = checkEnum(item, field);
        if ('error' in checked) return checked;
        values.push(checked.value);
      }
      if (values.length === 0 && !field.optional) return { error: '不能是空列表' };
      return { value: values };
    }
  }
}

/** 可选值匹配：先精确匹配，再忽略大小写；统一成声明里的写法 */
function checkEnum(value: string, field: ResultField): { value: string } | { error: string } {
  if (!field.enum) return { value };
  const match = field.enum.find((option) => String(option) === value)
    ?? field.enum.find((option) => String(option).toLowerCase() === value.toLowerCase());
  return match !== undefined
    ? { value: String(match) }
    : { error: `只能是 ${field.enum.join(' / ')}，得到 "${value}"` };
}

// ── 3. 汇总 ───────────────────────────────────────────────

export interface ResultRow {
  /** 从 1 开始的序号 */
  index: number;
  item: string;
  status: string;
  value?: Record<string, unknown>;
  error?: string;
}

/** UTF-8 BOM + CRLF，Excel 直接打开中文不乱码 */
export function resultsToCsv(schema: ResultSchema, rows: ResultRow[]): string {
  const fields = Object.keys(schema);
  const table = [
    ['序号', '数据项', ...fields, '状态', '失败原因'],
    ...rows.map((row) => [
      String(row.index),
      row.item,
      ...fields.map((field) => formatCell(row.value?.[field])),
      row.status,
      row.error ?? '',
    ]),
  ];
  return `﻿${table.map((cells) => cells.map(csvEscape).join(',')).join('\r\n')}\r\n`;
}

/** 数字字段给平均 / 最低 / 最高；是否字段给计数；有可选值的字段给分布 */
export function summarizeResults(schema: ResultSchema, values: Array<Record<string, unknown>>): string[] {
  const lines: string[] = [];
  for (const [name, field] of Object.entries(schema)) {
    const present = values.map((value) => value[name]).filter((value) => value !== undefined);
    if (present.length === 0) continue;
    if (field.type === 'number' || field.type === 'integer') {
      const numbers = present as number[];
      const mean = numbers.reduce((sum, n) => sum + n, 0) / numbers.length;
      lines.push(`- ${name}：平均 ${Math.round(mean * 100) / 100}，最低 ${Math.min(...numbers)}，最高 ${Math.max(...numbers)}（${numbers.length} 项）`);
    } else if (field.type === 'boolean') {
      const yes = present.filter((value) => value === true).length;
      lines.push(`- ${name}：是 ${yes}，否 ${present.length - yes}`);
    } else if (field.enum) {
      const counts = new Map<string, number>();
      for (const value of present.flatMap((entry) => (Array.isArray(entry) ? entry : [entry]))) {
        counts.set(String(value), (counts.get(String(value)) ?? 0) + 1);
      }
      const distribution = [...counts].sort((a, b) => b[1] - a[1]).map(([option, n]) => `${option}×${n}`).join('、');
      lines.push(`- ${name}：${distribution}`);
    }
  }
  return lines;
}

function formatCell(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (Array.isArray(value)) return value.join('; ');
  if (typeof value === 'boolean') return value ? '是' : '否';
  return String(value);
}

function csvEscape(cell: string): string {
  return /[",\r\n]/.test(cell) ? `"${cell.replace(/"/g, '""')}"` : cell;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
