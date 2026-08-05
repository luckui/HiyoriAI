import type {
  MinecraftActionInstruction,
  MinecraftActionName,
  MinecraftActionResult,
  MinecraftEnvironmentSnapshot,
  MinecraftPlannerDecision,
} from './contracts';

export interface MinecraftPlannerPrompt {
  userInstruction: string;
  snapshot: MinecraftEnvironmentSnapshot;
  recentResults: MinecraftActionResult[];
}

export interface MinecraftPlannerModel {
  decide(input: MinecraftPlannerPrompt): Promise<MinecraftPlannerDecision>;
}

export function createMinecraftPlannerModel(options: {
  complete: (messages: Array<{ role: 'system' | 'user'; content: string }>) => Promise<string>;
}): MinecraftPlannerModel {
  return {
    async decide(input) {
      const raw = await options.complete([
        { role: 'system', content: plannerSystemPrompt() },
        { role: 'user', content: JSON.stringify(input) },
      ]);
      return parsePlannerDecision(raw);
    },
  };
}

function plannerSystemPrompt(): string {
  return [
    'You are Hiyori Minecraft planner. Convert the user goal and current Minecraft snapshot into exactly one JSON decision.',
    'Do not answer in natural language outside JSON.',
    'Available decision kinds:',
    '{"kind":"act","rationale":"short reason","action":{"id":"act-id","name":"collect_block","args":{}}}',
    '{"kind":"complete","result":"message for user"}',
    '{"kind":"ask-user","question":"question for user","reason":"short reason"}',
    '{"kind":"wait","condition":{"kind":"action","value":"condition"}}',
    '{"kind":"revise-plan","plan":[{"title":"step","expected":"observable result"}]}',
    `Available action names: ${[...validActionNames].join(', ')}.`,
    'Prefer act only when the snapshot contains enough evidence for a concrete runtime action.',
  ].join('\n');
}

function parsePlannerDecision(raw: string): MinecraftPlannerDecision {
  const value = parseJsonObject(raw);
  if (!value) return invalidDecision();

  switch (value.kind) {
    case 'act':
      return parseActDecision(value);
    case 'complete':
      return typeof value.result === 'string'
        ? { kind: 'complete', result: value.result }
        : invalidDecision();
    case 'ask-user':
      return typeof value.question === 'string' && typeof value.reason === 'string'
        ? { kind: 'ask-user', question: value.question, reason: value.reason }
        : invalidDecision();
    case 'wait':
      return parseWaitDecision(value);
    case 'revise-plan':
      return parsePlanDecision(value);
    default:
      return invalidDecision();
  }
}

function parseActDecision(value: Record<string, unknown>): MinecraftPlannerDecision {
  const action = isRecord(value.action) ? value.action : undefined;
  if (!action) return invalidDecision();
  const name = action.name;
  if (typeof name !== 'string' || !isActionName(name)) return invalidDecision();
  const id = typeof action.id === 'string' && action.id.trim() ? action.id : `act:${Date.now()}`;
  const args = isRecord(action.args) ? action.args : {};
  const instruction: MinecraftActionInstruction = { id, name, args };
  return {
    kind: 'act',
    rationale: typeof value.rationale === 'string' ? value.rationale : '',
    action: instruction,
  };
}

function parseWaitDecision(value: Record<string, unknown>): MinecraftPlannerDecision {
  const condition = isRecord(value.condition) ? value.condition : undefined;
  if (!condition) return invalidDecision();
  const kind = condition.kind;
  const waitValue = condition.value;
  if ((kind !== 'action' && kind !== 'player' && kind !== 'time') || typeof waitValue !== 'string') {
    return invalidDecision();
  }
  return { kind: 'wait', condition: { kind, value: waitValue } };
}

function parsePlanDecision(value: Record<string, unknown>): MinecraftPlannerDecision {
  if (!Array.isArray(value.plan)) return invalidDecision();
  const plan = value.plan
    .map((step) => (isRecord(step) ? step : undefined))
    .filter((step): step is Record<string, unknown> => Boolean(step))
    .map((step) => ({
      title: typeof step.title === 'string' ? step.title : '',
      expected: typeof step.expected === 'string' ? step.expected : '',
    }))
    .filter((step) => step.title && step.expected);
  if (!plan.length) return invalidDecision();
  return { kind: 'revise-plan', plan };
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(extractJson(raw));
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractJson(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) return trimmed;
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced) return fenced[1].trim();
  return trimmed;
}

function invalidDecision(): MinecraftPlannerDecision {
  return {
    kind: 'ask-user',
    question: '我需要确认一下 Minecraft 里的下一步要做什么。',
    reason: 'planner-output-invalid',
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isActionName(value: string): value is MinecraftActionName {
  return validActionNames.has(value as MinecraftActionName);
}

const validActionNames = new Set<MinecraftActionName>([
  'navigate_to_player',
  'follow_player',
  'wait',
  'inspect',
  'collect_block',
  'pickup_drops',
  'craft_item',
  'smelt_item',
  'use_container',
  'eat',
  'equip',
  'defend',
  'retreat',
  'sleep',
  'harvest_crop',
  'till_soil',
  'sow_crop',
  'place_block',
  'break_block',
  'execute_blueprint',
]);
