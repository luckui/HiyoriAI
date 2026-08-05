import type { MinecraftActionInstruction, MinecraftEnvironmentSnapshot } from './contracts';

export class MinecraftReflexEngine {
  private hungerActive = false;

  update(snapshot: MinecraftEnvironmentSnapshot): MinecraftActionInstruction[] {
    const body = snapshot.body;
    if (!body) return [];

    const hasFood = Object.keys(body.inventory).some((name) => foodNames.has(name));
    if (body.food <= 6 && hasFood && !this.hungerActive) {
      this.hungerActive = true;
      return [{ id: `reflex:eat:${snapshot.capturedAt}`, name: 'eat', args: {} }];
    }

    if (body.food > 12) this.hungerActive = false;
    return [];
  }
}

const foodNames = new Set([
  'apple',
  'baked_potato',
  'bread',
  'cooked_beef',
  'cooked_chicken',
  'cooked_mutton',
  'cooked_porkchop',
  'cooked_salmon',
  'cooked_cod',
  'carrot',
]);
