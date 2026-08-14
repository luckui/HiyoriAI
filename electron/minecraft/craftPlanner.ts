import type { Bot } from 'mineflayer';
import {
  canonicalMinecraftMaterial,
} from './materialFamilies';

export interface CraftPlanStep {
  item: string;
  amount: number;
  kind: 'craft' | 'smelt';
  ingredients: Record<string, number>;
  requiresCraftingTable: boolean;
  outputPerCraft: number;
  craftCount?: number;
  recipeSignature?: string;
}

export interface CraftPlan {
  targetItem: string;
  targetAmount: number;
  steps: CraftPlanStep[];
  totalRequired: Record<string, number>;
  missing: Record<string, number>;
  sources: Record<string, string>;
  requiresCraftingTable: boolean;
  canCraftNow: boolean;
  recipeAvailable: boolean;
}

interface RecipeCandidate {
  kind: 'craft' | 'smelt';
  ingredients: Record<string, number>;
  outputPerCraft: number;
  requiresTable: boolean;
  smeltInputId?: number;
  preference: number;
  signature: string;
}

interface PlanningState {
  stock: Record<string, number>;
  initialStockRemaining: Record<string, number>;
  initialStockUsed: number;
  demand: Record<string, number>;
  steps: CraftPlanStep[];
  totalRequired: Record<string, number>;
  missing: Record<string, number>;
  sources: Record<string, string>;
  requiresCraftingTable: boolean;
  operationCount: number;
  preferenceCost: number;
}

interface PlanningContext {
  registry: any;
  recipesSource: any;
  nameById: Map<number, string>;
  candidateCache: Map<number, RecipeCandidate[]>;
  expandedBranches: number;
}

const MAX_EXPANDED_BRANCHES = 4096;
export const SMELT_ITEMS_PER_FUEL = 8;
export const SMELT_FUEL_ITEM = 'coal';

// minecraft-data does not expose a dedicated furnace recipe API. Keep the
// verified furnace mappings separate from the current-version craft graph.
const KNOWN_SMELT_INPUTS: Record<string, string[]> = {
  iron_ingot: ['raw_iron', 'iron_ore', 'deepslate_iron_ore'],
  gold_ingot: ['raw_gold', 'gold_ore', 'deepslate_gold_ore'],
  copper_ingot: ['raw_copper', 'copper_ore', 'deepslate_copper_ore'],
  glass: ['sand'],
  stone: ['cobblestone'],
  cooked_porkchop: ['porkchop'],
  cooked_beef: ['beef'],
  cooked_chicken: ['chicken'],
  cooked_mutton: ['mutton'],
  cooked_rabbit: ['rabbit'],
  cooked_cod: ['cod'],
  cooked_salmon: ['salmon'],
  cooked_fish: ['fish'],
  baked_potato: ['potato'],
  dried_kelp: ['kelp'],
};

export function planCraft(bot: Bot, itemName: string, amount: number): CraftPlan {
  const registry = bot.registry as any;
  const itemsByName = registry?.itemsByName ?? {};
  const targetItem = normalizeItemName(itemName, itemsByName);
  const targetAmount = Math.max(1, Math.trunc(amount));
  const itemId = itemsByName[targetItem]?.id;
  const emptyPlan = createEmptyPlan(targetItem, targetAmount);
  if (itemId === undefined) return emptyPlan;

  const stock = inventoryCounts(bot);
  const nameById = itemNamesById(itemsByName);
  const context: PlanningContext = {
    registry,
    recipesSource: recipesSourceFor(bot),
    nameById,
    candidateCache: new Map(),
    expandedBranches: 0,
  };
  if (recipeCandidates(context, itemId).length === 0) return emptyPlan;

  const initial: PlanningState = {
    stock,
    initialStockRemaining: { ...stock },
    initialStockUsed: 0,
    demand: { [targetItem]: targetAmount },
    steps: [],
    totalRequired: {},
    missing: {},
    sources: {},
    requiresCraftingTable: false,
    operationCount: 0,
    preferenceCost: 0,
  };
  const requiredTargetStock = (stock[targetItem] ?? 0) + targetAmount;
  const planned = ensureStock(targetItem, requiredTargetStock, initial, new Set(), context);
  if (!planned) {
    return {
      ...emptyPlan,
      recipeAvailable: true,
      missing: { [targetItem]: targetAmount },
      sources: { [targetItem]: sourceHint(registry, targetItem, itemId) },
    };
  }

  const normalizedMissing = normalizeGatherableShortages(planned.missing);
  return {
    targetItem,
    targetAmount,
    steps: orderStepsDependencyFirst(planned.steps),
    totalRequired: planned.totalRequired,
    missing: normalizedMissing,
    sources: normalizeShortageSources(planned.sources, normalizedMissing),
    requiresCraftingTable: planned.requiresCraftingTable,
    canCraftNow: Object.keys(normalizedMissing).length === 0,
    recipeAvailable: true,
  };
}

function ensureStock(
  itemName: string,
  requiredStock: number,
  state: PlanningState,
  path: ReadonlySet<string>,
  context: PlanningContext,
): PlanningState | null {
  const have = availableStock(state.stock, itemName);
  if (have >= requiredStock) return state;
  if (path.has(itemName)) return null;

  const shortage = requiredStock - have;
  const itemId = context.registry?.itemsByName?.[itemName]?.id;
  const candidates = itemId === undefined ? [] : recipeCandidates(context, itemId);
  if (candidates.length === 0) {
    const raw = clonePlanningState(state);
    raw.missing[itemName] = (raw.missing[itemName] ?? 0) + shortage;
    raw.sources[itemName] = sourceHint(context.registry, itemName, itemId);
    raw.stock[itemName] = (raw.stock[itemName] ?? 0) + shortage;
    return raw;
  }

  const childPath = new Set(path);
  childPath.add(itemName);
  let best: PlanningState | null = null;

  for (const candidate of candidates) {
    context.expandedBranches += 1;
    if (context.expandedBranches > MAX_EXPANDED_BRANCHES) break;

    const craftCount = Math.ceil(shortage / candidate.outputPerCraft);
    const ingredients = scaledCandidateIngredients(candidate, craftCount, context.nameById);
    if (!ingredients) continue;

    let branch: PlanningState | null = clonePlanningState(state);
    const ingredientEntries = Object.entries(ingredients)
      .sort(([left], [right]) => left.localeCompare(right));
    for (const [ingredient, count] of ingredientEntries) {
      if (!branch) break;
      branch.demand[ingredient] = (branch.demand[ingredient] ?? 0) + count;
      branch.totalRequired[ingredient] = (branch.totalRequired[ingredient] ?? 0) + count;
      branch = ensureStock(ingredient, count, branch, childPath, context);
      if (!branch) break;
      consumeIngredientStock(branch, ingredient, count);
    }
    if (!branch) continue;

    branch.stock[itemName] = (branch.stock[itemName] ?? 0)
      + craftCount * candidate.outputPerCraft;
    branch.operationCount += craftCount;
    branch.preferenceCost += candidate.preference;
    branch.requiresCraftingTable ||= candidate.requiresTable;
    mergePlanStep(branch, {
      item: itemName,
      amount: branch.demand[itemName] ?? shortage,
      kind: candidate.kind,
      ingredients,
      requiresCraftingTable: candidate.requiresTable,
      outputPerCraft: candidate.outputPerCraft,
      craftCount,
      recipeSignature: candidate.signature,
    });

    if (!best || comparePlanningStates(branch, best) < 0) best = branch;
  }

  return best;
}

function recipeCandidates(context: PlanningContext, itemId: number): RecipeCandidate[] {
  const cached = context.candidateCache.get(itemId);
  if (cached) return cached;

  const unique = new Map<string, RecipeCandidate>();
  const recipes = context.recipesSource?.[itemId];
  for (const recipe of Array.isArray(recipes) ? recipes : []) {
    if (isFurnaceRecipe(context.recipesSource, recipe)) continue;
    const entries = parseRecipeEntries(recipe)
      .filter((entry) => entry !== null && entry !== undefined) as number[];
    const ingredients: Record<string, number> = {};
    let valid = true;
    for (const ingredientId of entries) {
      const name = context.nameById.get(ingredientId);
      if (!name) {
        valid = false;
        break;
      }
      ingredients[name] = (ingredients[name] ?? 0) + 1;
    }
    if (!valid || Object.keys(ingredients).length === 0) continue;

    const outputPerCraft = Math.max(1, recipe.result?.count ?? 1);
    const requiresTable = recipeRequiresCraftingTable(recipe);
    const signature = candidateSignature('craft', ingredients, outputPerCraft, requiresTable);
    unique.set(signature, {
      kind: 'craft',
      ingredients,
      outputPerCraft,
      requiresTable,
      preference: 0,
      signature,
    });
  }

  const smeltInputIds = smeltInputsFor(context.registry, itemId, context.recipesSource);
  for (const [preference, smeltInputId] of smeltInputIds.entries()) {
    const smeltInputName = context.nameById.get(smeltInputId);
    if (!smeltInputName) continue;
    const ingredients = { [smeltInputName]: 1 };
    const signature = candidateSignature('smelt', ingredients, 1, false);
    unique.set(signature, {
      kind: 'smelt',
      ingredients,
      outputPerCraft: 1,
      requiresTable: false,
      smeltInputId,
      preference,
      signature,
    });
  }

  const candidates = [...unique.values()]
    .sort((left, right) => left.signature.localeCompare(right.signature));
  context.candidateCache.set(itemId, candidates);
  return candidates;
}

function scaledCandidateIngredients(
  candidate: RecipeCandidate,
  craftCount: number,
  nameById: Map<number, string>,
): Record<string, number> | null {
  if (candidate.kind === 'craft') return scaleIngredients(candidate.ingredients, craftCount);
  const inputName = candidate.smeltInputId === undefined
    ? undefined
    : nameById.get(candidate.smeltInputId);
  if (!inputName) return null;
  return {
    [inputName]: craftCount,
    [SMELT_FUEL_ITEM]: Math.ceil(craftCount / SMELT_ITEMS_PER_FUEL),
  };
}

function mergePlanStep(state: PlanningState, incoming: CraftPlanStep): void {
  const existing = state.steps.find((step) => (
    step.item === incoming.item
    && step.recipeSignature === incoming.recipeSignature
  ));
  if (!existing) {
    state.steps.push(incoming);
    return;
  }

  existing.amount = Math.max(existing.amount, state.demand[incoming.item] ?? incoming.amount);
  existing.craftCount = (existing.craftCount ?? 0) + (incoming.craftCount ?? 0);
  for (const [name, count] of Object.entries(incoming.ingredients)) {
    existing.ingredients[name] = (existing.ingredients[name] ?? 0) + count;
  }
}

function comparePlanningStates(left: PlanningState, right: PlanningState): number {
  const leftRank = planningRank(left);
  const rightRank = planningRank(right);
  for (let index = 0; index < leftRank.length; index += 1) {
    const difference = leftRank[index] - rightRank[index];
    if (difference !== 0) return difference;
  }
  return planSignature(left).localeCompare(planSignature(right));
}

function planningRank(state: PlanningState): number[] {
  return [
    Object.keys(state.missing).length,
    Object.values(state.missing).reduce((sum, count) => sum + count, 0),
    -state.initialStockUsed,
    state.operationCount,
    state.preferenceCost,
    state.requiresCraftingTable ? 1 : 0,
  ];
}

function planSignature(state: PlanningState): string {
  return state.steps
    .map((step) => `${step.item}:${step.recipeSignature ?? ''}:${step.craftCount ?? 0}`)
    .sort()
    .join('|');
}

function candidateSignature(
  kind: RecipeCandidate['kind'],
  ingredients: Record<string, number>,
  outputPerCraft: number,
  requiresTable: boolean,
): string {
  const ingredientText = Object.entries(ingredients)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, count]) => `${name}=${count}`)
    .join(',');
  return `${kind}|${ingredientText}|out=${outputPerCraft}|table=${requiresTable ? 1 : 0}`;
}

function clonePlanningState(state: PlanningState): PlanningState {
  return {
    stock: { ...state.stock },
    initialStockRemaining: { ...state.initialStockRemaining },
    initialStockUsed: state.initialStockUsed,
    demand: { ...state.demand },
    steps: state.steps.map((step) => ({ ...step, ingredients: { ...step.ingredients } })),
    totalRequired: { ...state.totalRequired },
    missing: { ...state.missing },
    sources: { ...state.sources },
    requiresCraftingTable: state.requiresCraftingTable,
    operationCount: state.operationCount,
    preferenceCost: state.preferenceCost,
  };
}

function normalizeGatherableShortages(missing: Record<string, number>): Record<string, number> {
  const normalized: Record<string, number> = {};
  for (const [name, count] of Object.entries(missing)) {
    const key = canonicalMinecraftMaterial(name);
    normalized[key] = (normalized[key] ?? 0) + count;
  }
  return normalized;
}

function normalizeShortageSources(
  sources: Record<string, string>,
  missing: Record<string, number>,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const name of Object.keys(missing)) {
    normalized[name] = name === 'log'
      ? 'collect logs from trees'
      : sources[name] ?? 'unknown source';
  }
  return normalized;
}

function availableStock(
  stock: Record<string, number>,
  itemName: string,
): number {
  return stock[itemName] ?? 0;
}

function consumeIngredientStock(state: PlanningState, itemName: string, count: number): void {
  const available = Math.max(0, state.stock[itemName] ?? 0);
  const used = Math.min(available, count);
  state.stock[itemName] = available - count;

  const initialAvailable = Math.max(0, state.initialStockRemaining[itemName] ?? 0);
  const initialUsed = Math.min(initialAvailable, used);
  state.initialStockRemaining[itemName] = initialAvailable - initialUsed;
  state.initialStockUsed += initialUsed;
}

function orderStepsDependencyFirst(steps: CraftPlanStep[]): CraftPlanStep[] {
  const byItem = new Map<string, CraftPlanStep[]>();
  for (const step of steps) {
    const itemSteps = byItem.get(step.item) ?? [];
    itemSteps.push(step);
    byItem.set(step.item, itemSteps);
  }

  const ordered: CraftPlanStep[] = [];
  const visiting = new Set<CraftPlanStep>();
  const visited = new Set<CraftPlanStep>();
  const visit = (step: CraftPlanStep): void => {
    if (visited.has(step) || visiting.has(step)) return;
    visiting.add(step);
    for (const ingredient of Object.keys(step.ingredients).sort()) {
      for (const dependency of byItem.get(ingredient) ?? []) visit(dependency);
    }
    visiting.delete(step);
    visited.add(step);
    ordered.push(step);
  };

  for (const step of [...steps].sort((left, right) => left.item.localeCompare(right.item))) {
    visit(step);
  }
  return ordered;
}

function parseRecipeEntries(recipe: any): Array<number | null | undefined> {
  if (Array.isArray(recipe.inShape)) {
    return recipe.inShape.flat().map((entry: any) => (
      typeof entry === 'number' ? entry : (entry?.id ?? null)
    ));
  }
  if (Array.isArray(recipe.ingredients)) {
    return recipe.ingredients.map((entry: any) => (
      typeof entry === 'number' ? entry : (entry?.id ?? null)
    ));
  }
  return [];
}

// Older minecraft-data versions encode furnace recipes as 3x3 identical
// inputs. A reverse 1x1 decomposition recipe distinguishes compressed blocks.
function isFurnaceRecipe(recipesSource: any, recipe: any): boolean {
  const entries = parseRecipeEntries(recipe);
  if (entries.length !== 9) return false;
  const inputId = entries[0];
  if (inputId === null || inputId === undefined) return false;
  if (!entries.every((entry) => entry === inputId)) return false;
  const resultId = recipe.result?.id;
  if (resultId === undefined) return false;

  const inputRecipes = recipesSource?.[inputId];
  if (Array.isArray(inputRecipes)) {
    for (const inputRecipe of inputRecipes) {
      const inputEntries = parseRecipeEntries(inputRecipe);
      const inputResult = inputRecipe.result;
      if (
        inputEntries.length === 1
        && inputEntries[0] === resultId
        && inputResult?.id === inputId
        && (inputResult?.count ?? 1) >= 9
      ) {
        return false;
      }
    }
  }
  return true;
}

export function smeltInputsFor(
  registry: any,
  itemId: number,
  recipesSource?: any,
): number[] {
  const nameById = itemNamesById(registry.itemsByName ?? {});
  const outputName = nameById.get(itemId);
  const candidates: number[] = [];
  for (const inputName of outputName ? KNOWN_SMELT_INPUTS[outputName] ?? [] : []) {
    const inputId = registry.itemsByName?.[inputName]?.id;
    if (typeof inputId === 'number' && !candidates.includes(inputId)) candidates.push(inputId);
  }

  const source = recipesSource ?? registry?.recipes;
  const recipes = source?.[itemId];
  if (Array.isArray(recipes)) {
    for (const recipe of recipes) {
      if (!isFurnaceRecipe(source, recipe)) continue;
      const inputId = parseRecipeEntries(recipe)[0];
      if (
        inputId !== null
        && inputId !== undefined
        && nameById.has(inputId)
        && !candidates.includes(inputId)
      ) {
        candidates.push(inputId);
      }
    }
  }
  return candidates;
}

export function smeltInputFor(
  registry: any,
  itemId: number,
  recipesSource?: any,
  availableItems: ReadonlyMap<string, number> = new Map(),
  requiredAmount = 1,
): number | undefined {
  const nameById = itemNamesById(registry.itemsByName ?? {});
  const candidates = smeltInputsFor(registry, itemId, recipesSource);
  return candidates.find((inputId) => {
    const inputName = nameById.get(inputId);
    return inputName !== undefined && (availableItems.get(inputName) ?? 0) >= requiredAmount;
  }) ?? candidates
    .filter((inputId) => (availableItems.get(nameById.get(inputId) ?? '') ?? 0) > 0)
    .sort((left, right) => (
      (availableItems.get(nameById.get(right) ?? '') ?? 0)
      - (availableItems.get(nameById.get(left) ?? '') ?? 0)
    ))[0]
    ?? candidates[0];
}

export function smeltOutputFor(
  registry: any,
  inputId: number,
  recipesSource?: any,
): number | undefined {
  const nameById = itemNamesById(registry.itemsByName ?? {});
  const inputName = nameById.get(inputId);
  if (inputName) {
    for (const [outputName, sourceNames] of Object.entries(KNOWN_SMELT_INPUTS)) {
      if (sourceNames.includes(inputName)) return registry.itemsByName?.[outputName]?.id;
    }
  }

  const recipes = recipesSource ?? registry?.recipes ?? {};
  for (const [outputIdText, list] of Object.entries(recipes)) {
    if (!Array.isArray(list)) continue;
    for (const recipe of list) {
      if (!isFurnaceRecipe(recipes, recipe)) continue;
      const outputId = Number(outputIdText);
      if (parseRecipeEntries(recipe)[0] === inputId && nameById.has(outputId)) return outputId;
    }
  }
  return undefined;
}

export function recipesSourceFor(bot: Bot): any {
  const version = (bot as any)?.version;
  if (version) {
    try {
      return require('minecraft-data')(version).recipes;
    } catch {
      // The negotiated registry is the only safe fallback; never guess a version.
    }
  }
  return (bot as any)?.registry?.recipes;
}

function recipeRequiresCraftingTable(recipe: any): boolean {
  if (Array.isArray(recipe.inShape)) {
    return recipe.inShape.length > 2 || (recipe.inShape[0]?.length ?? 0) > 2;
  }
  return Array.isArray(recipe.ingredients) && recipe.ingredients.length > 4;
}

function scaleIngredients(ingredients: Record<string, number>, times: number): Record<string, number> {
  if (times <= 0) return {};
  return Object.fromEntries(
    Object.entries(ingredients)
      .map(([name, count]) => [name, count * times] as const)
      .filter(([, count]) => count > 0),
  );
}

function inventoryCounts(bot: Bot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of bot.inventory?.items?.() ?? []) {
    const name = item.name ?? String(item.type);
    counts[name] = (counts[name] ?? 0) + (item.count ?? 1);
  }
  return counts;
}

function itemNamesById(itemsByName: Record<string, unknown>): Map<number, string> {
  const names = new Map<number, string>();
  for (const [name, item] of Object.entries(itemsByName)) {
    if (typeof (item as any)?.id === 'number') names.set((item as any).id, name);
  }
  return names;
}

function createEmptyPlan(targetItem: string, targetAmount: number): CraftPlan {
  return {
    targetItem,
    targetAmount,
    steps: [],
    totalRequired: {},
    missing: {},
    sources: {},
    requiresCraftingTable: false,
    canCraftNow: false,
    recipeAvailable: false,
  };
}

function normalizeItemName(name: string, itemsByName: Record<string, unknown>): string {
  const normalized = name.trim().toLowerCase()
    .replace(/^minecraft\s*[: ]\s*/, '')
    .replace(/[\s-]+/g, '_');
  if (itemsByName[normalized]) return normalized;
  if (normalized === 'plank' && itemsByName.planks) return 'planks';
  if (normalized.endsWith('_planks') && itemsByName.planks) return 'planks';
  if (normalized.endsWith('_plank') && itemsByName.planks) return 'planks';
  if (normalized.endsWith('_log') && itemsByName.log) return 'log';
  if (normalized.endsWith('_stem') && itemsByName.stem) return 'stem';
  return normalized;
}

function sourceHint(registry: any, itemName: string, itemId: number | undefined): string {
  if (itemId !== undefined) {
    const blocks = Object.entries(registry?.blocksByName ?? {})
      .filter(([, block]: [string, any]) => recipeDropIds(block).includes(itemId))
      .map(([name]) => name);
    if (blocks.length > 0) return `mine ${blocks.slice(0, 3).join('/')}`;
  }
  const known: Record<string, string> = {
    log: 'collect logs from trees',
    log2: 'collect logs from trees',
    cobblestone: 'mine stone',
    coal: 'mine coal_ore',
    iron_ingot: 'smelt iron_ore',
    gold_ingot: 'smelt gold_ore',
    diamond: 'mine diamond_ore',
    stick: 'craft from planks',
    planks: 'craft from logs',
  };
  return known[itemName] ?? 'unknown source';
}

function recipeDropIds(block: any): number[] {
  const ids: number[] = [];
  for (const entry of Array.isArray(block?.drops) ? block.drops : []) {
    if (typeof entry === 'number') ids.push(entry);
    else if (typeof entry?.drop === 'number') ids.push(entry.drop);
    else if (typeof entry?.drop?.id === 'number') ids.push(entry.drop.id);
    else if (typeof entry?.id === 'number') ids.push(entry.id);
  }
  return ids;
}
