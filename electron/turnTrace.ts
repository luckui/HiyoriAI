import { randomUUID } from 'node:crypto';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface TurnTrigger {
  actor: 'user' | 'system';
  source: 'desktop' | 'minecraft' | 'discord' | 'wechat' | 'feishu' |
    'scheduler' | 'background_task' | 'coding_agent' | 'runtime' | 'unknown';
  event: string;
  sourceId?: string;
  parentId?: string;
}

export interface TurnTraceEvent {
  type: string;
  turnId: string;
  conversationId: string;
  trigger?: TurnTrigger;
  [key: string]: unknown;
}

let tracePath: string | undefined;

export function configureTurnTrace(path: string): void {
  tracePath = path;
  console.info(`[Turn Trace] ${path}`);
}

export function resetTurnTraceForTest(): void {
  tracePath = undefined;
}

export function createTurnId(): string {
  return randomUUID();
}

export function traceTurnEvent(event: TurnTraceEvent): void {
  if (!tracePath) return;
  try {
    mkdirSync(dirname(tracePath), { recursive: true });
    const safe = redactValue({ at: new Date().toISOString(), ...event });
    appendFileSync(tracePath, `${JSON.stringify(safe)}\n`, 'utf8');
    logSummary(safe as Record<string, unknown>);
  } catch (error) {
    console.warn('[Turn Trace] failed to write trace:', (error as Error).message);
  }
}

export function traceReplyDelivery(
  turnId: string,
  conversationId: string,
  target: string,
  details: Record<string, unknown> = {},
): void {
  traceTurnEvent({
    type: 'reply-delivered',
    turnId,
    conversationId,
    target,
    ...details,
  });
}

function redactValue(value: unknown, key = ''): unknown {
  if (isSensitiveKey(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.map((item) => redactValue(item));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([nextKey, item]) => [nextKey, redactValue(item, nextKey)]),
    );
  }
  return value;
}

function isSensitiveKey(key: string): boolean {
  return /^(api[_-]?key|authorization|token|access[_-]?token|refresh[_-]?token|secret|password)$/i.test(key);
}

function redactString(value: string): string {
  const redacted = value
    .replace(/(Authorization\s*:\s*Bearer\s+)[^\s"']+/gi, '$1[REDACTED]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\s*[=:]\s*)[^\s,"']+/gi, '$1[REDACTED]');
  return redacted.length > 100_000
    ? `${redacted.slice(0, 100_000)}\n[TRACE TRUNCATED: ${redacted.length} chars]`
    : redacted;
}

function logSummary(event: Record<string, unknown>): void {
  const type = String(event.type ?? 'event');
  if (![
    'wakeup-issued',
    'turn-received',
    'internal-instruction',
    'tool-started',
    'tool-completed',
    'turn-error',
    'turn-completed',
    'reply-delivered',
    'agent-message-injected',
    'tool-queued',
    'child-task-started',
    'child-llm-response',
    'child-tool-started',
    'child-tool-queued',
    'child-tool-completed',
    'child-task-empty-retry',
    'child-task-completed',
    'child-task-cancelled',
    'child-task-error',
    'minecraft-slot-transition',
    'minecraft-slot-terminal',
    'minecraft-slot-stale-result',
  ].includes(type)) return;

  const childEvent = type.startsWith('child-');
  const minecraftSlotEvent = type.startsWith('minecraft-slot-');
  const turn = String(
    minecraftSlotEvent
      ? event.generation ?? '?'
      : childEvent
        ? event.taskId ?? event.turnId ?? ''
        : event.turnId ?? '',
  ).slice(0, 8);
  const trigger = event.trigger as Partial<TurnTrigger> | undefined;
  const origin = trigger
    ? `${trigger.actor ?? '?'}:${trigger.source ?? '?'}:${trigger.event ?? '?'}`
    : '-';
  const isToolEvent = type === 'tool-queued' || type === 'tool-started' || type === 'tool-completed' ||
    type === 'child-tool-queued' || type === 'child-tool-started' || type === 'child-tool-completed';
  const claims = Array.isArray(event.claims)
    ? event.claims.map((claim) => {
        const value = claim as { key?: unknown; access?: unknown };
        return `${String(value.key ?? '?')}:${String(value.access ?? '?')}`;
      }).join(',')
    : '';
  const detail = isToolEvent
    ? ` tool=${String(event.tool ?? '?')}${claims ? ` claims=${claims}` : ''}`
    : type === 'internal-instruction'
      ? ` reason=${String(event.reason ?? '?')}`
      : type === 'reply-delivered'
        ? ` target=${String(event.target ?? '?')}`
      : type === 'turn-completed'
          ? ` reply=${preview(event.reply)}`
          : minecraftSlotEvent
            ? ` phase=${String(event.phase ?? event.outcome ?? '?')} goal=${preview(event.title)}`
          : '';
  const label = minecraftSlotEvent ? 'Minecraft' : childEvent ? 'Task' : 'Turn';
  console.info(`[${label} ${turn}] ${type}${childEvent || minecraftSlotEvent ? '' : ` origin=${origin}`}${detail}`);
}

function preview(value: unknown): string {
  return JSON.stringify(String(value ?? '').replace(/\s+/g, ' ').slice(0, 100));
}
