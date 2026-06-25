import { describe, expect, it } from 'vitest';
import { RuntimeRegistry } from '../runtimeRegistry';

describe('RuntimeRegistry', () => {
  it('starts empty', () => {
    const registry = new RuntimeRegistry();
    expect(registry.listProviders()).toEqual([]);
  });
});
