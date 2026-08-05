import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import type { ReplyTarget } from '../bridges/asyncDelivery';
import type {
  MinecraftAction,
  MinecraftCommand,
  MinecraftRuntimeEvent,
  MinecraftTerminalEvent,
  MinecraftWorkerMessage,
} from './protocol';

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer: NodeJS.Timeout;
}

export interface MinecraftCommandOrigin {
  conversationId: string;
  replyTarget?: ReplyTarget;
}

export interface AcceptedCollection {
  state: 'running';
  jobId: string;
  block?: string;
  quantity?: number;
  radius?: number;
}

export type MinecraftNotifier = (
  origin: MinecraftCommandOrigin,
  event: MinecraftRuntimeEvent,
) => void | Promise<void>;

export interface MinecraftRuntimeManagerOptions {
  spawnWorker?: () => ChildProcess;
}

export class MinecraftRuntimeManager {
  private child?: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly collectionOrigins = new Map<string, MinecraftCommandOrigin>();
  private readonly listeners = new Set<(event: MinecraftRuntimeEvent) => void>();
  private notifier?: MinecraftNotifier;
  private lastOrigin?: MinecraftCommandOrigin;
  private shuttingDown = false;

  constructor(private readonly options: MinecraftRuntimeManagerOptions = {}) {}

  setNotifier(notifier: MinecraftNotifier): void {
    this.notifier = notifier;
  }

  rememberOrigin(origin: MinecraftCommandOrigin): void {
    this.lastOrigin = origin;
  }

  currentOrigin(): MinecraftCommandOrigin | undefined {
    return this.lastOrigin;
  }

  onEvent(listener: (event: MinecraftRuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async command<T = unknown>(
    action: MinecraftAction,
    payload: unknown,
    timeoutMs = 15_000,
  ): Promise<T> {
    const child = this.ensureWorker();
    const id = randomUUID();
    const message: MinecraftCommand = { type: 'command', id, action, payload };

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Minecraft command timed out: ${action}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.send?.(message, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  async startCollection(
    payload: { block: string; quantity: number; radius?: number },
    origin: MinecraftCommandOrigin,
  ): Promise<AcceptedCollection> {
    this.rememberOrigin(origin);
    const accepted = await this.command<AcceptedCollection>('collect', payload);
    this.collectionOrigins.set(accepted.jobId, origin);
    return accepted;
  }

  pendingRequestCount(): number {
    return this.pending.size;
  }

  async shutdown(): Promise<void> {
    if (this.shuttingDown) return;
    this.shuttingDown = true;
    const child = this.child;
    this.child = undefined;
    this.rejectAll(new Error('Minecraft runtime shut down'));
    if (child?.connected) child.disconnect();
  }

  private ensureWorker(): ChildProcess {
    if (this.child) return this.child;
    this.shuttingDown = false;
    const child = this.options.spawnWorker?.() ?? spawnMinecraftWorker();
    this.child = child;
    child.on('message', (message: MinecraftWorkerMessage) => this.handleMessage(message));
    child.once('error', (error) => this.handleWorkerExit(error));
    child.once('exit', (code, signal) => {
      this.handleWorkerExit(
        new Error(`Minecraft worker exited (code=${code ?? 'none'}, signal=${signal ?? 'none'})`),
      );
    });
    return child;
  }

  private handleMessage(message: MinecraftWorkerMessage): void {
    if (message.type === 'response') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(message.id);
      if (message.ok) pending.resolve(message.data);
      else pending.reject(new Error(message.error));
      return;
    }

    for (const listener of this.listeners) listener(message.event);
    this.handleNotification(message.event);
  }

  private handleNotification(event: MinecraftRuntimeEvent): void {
    if (event.kind === 'collection-terminal') {
      const origin = this.collectionOrigins.get(event.jobId);
      if (!origin) return;
      this.collectionOrigins.delete(event.jobId);
      void this.notifier?.(origin, event);
      return;
    }
    if (
      this.lastOrigin &&
      (event.kind === 'food-shortage' || event.kind === 'disconnected')
    ) {
      void this.notifier?.(this.lastOrigin, event);
    }
  }

  private handleWorkerExit(error: Error): void {
    if (!this.child) return;
    this.child = undefined;
    this.rejectAll(error);
    if (!this.shuttingDown && this.lastOrigin) {
      void this.notifier?.(this.lastOrigin, {
        kind: 'disconnected',
        reason: error.message,
      });
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }
}

function spawnMinecraftWorker(): ChildProcess {
  return fork(join(__dirname, 'minecraftWorker.js'), [], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HIYORI_MINECRAFT_WORKER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
}

export function describeMinecraftTerminalEvent(event: MinecraftTerminalEvent): string {
  return `${event.block}: ${event.collected}/${event.requested} (${event.outcome})`;
}
