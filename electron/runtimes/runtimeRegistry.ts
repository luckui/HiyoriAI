import type { AgentRuntimeProvider, RuntimeProviderSummary } from './types';

export class RuntimeRegistry {
  private readonly providers = new Map<string, AgentRuntimeProvider>();

  register(provider: AgentRuntimeProvider): this {
    if (this.providers.has(provider.id)) {
      throw new Error(`Runtime provider already registered: ${provider.id}`);
    }
    this.providers.set(provider.id, provider);
    return this;
  }

  getProvider(id: string): AgentRuntimeProvider | undefined {
    return this.providers.get(id);
  }

  requireProvider(id: string): AgentRuntimeProvider {
    const provider = this.providers.get(id);
    if (!provider) {
      throw new Error(`Runtime provider not found: ${id}`);
    }
    return provider;
  }

  listProviders(): RuntimeProviderSummary[] {
    return [...this.providers.values()].map((provider) => ({
      id: provider.id,
      displayName: provider.displayName,
    }));
  }
}
