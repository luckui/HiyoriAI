import { randomUUID } from 'node:crypto';
import { fork, type ChildProcess } from 'node:child_process';
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { ReplyTarget } from '../bridges/asyncDelivery';
import type {
  MinecraftAction,
  MinecraftCommand,
  MinecraftRuntimeEvent,
  MinecraftWorkerMessage,
} from './protocol';

interface PendingRequest {
  action: MinecraftAction;
  startedAt: number;
  resolve(value: unknown): void;
  reject(error: Error): void;
  timer?: NodeJS.Timeout;
}

export interface MinecraftCommandOrigin {
  conversationId: string;
  replyTarget?: ReplyTarget;
}

export type MinecraftNotifier = (
  origin: MinecraftCommandOrigin,
  event: MinecraftRuntimeEvent,
) => void | Promise<void>;

export interface MinecraftRuntimeManagerOptions {
  spawnWorker?: () => ChildProcess;
  debugLogPath?: string;
  workerLogPath?: string;
}

export class MinecraftRuntimeManager {
  private child?: ChildProcess;
  private readonly pending = new Map<string, PendingRequest>();
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
    console.log(`[Minecraft Runtime] command sent: ${action} (${id})`);
    this.trace({ type: 'command-sent', commandId: id, action, payload });

    return new Promise<T>((resolve, reject) => {
      const timer = timeoutMs > 0
        ? setTimeout(() => this.handleCommandTimeout(id, action, child), timeoutMs)
        : undefined;
      this.pending.set(id, {
        action,
        startedAt: Date.now(),
        resolve: (value) => resolve(value as T),
        reject,
        timer,
      });
      child.send?.(message, (error) => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        if (pending.timer) clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(error);
      });
    });
  }

  pendingRequestCount(): number {
    return this.pending.size;
  }

  hasActiveWorker(): boolean {
    return Boolean(this.child);
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
    const child = this.options.spawnWorker?.() ?? spawnMinecraftWorker(this.options.debugLogPath);
    this.child = child;
    console.log(`[Minecraft Runtime] worker spawned${child.pid ? ` pid=${child.pid}` : ''}`);
    child.stdout?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.log(`[Minecraft Worker stdout] ${text}`);
      appendWorkerLog(this.options.workerLogPath, `[stdout] ${text}`);
    });
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trim();
      if (text) console.warn(`[Minecraft Worker stderr] ${text}`);
      appendWorkerLog(this.options.workerLogPath, `[stderr] ${text}`);
    });
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
      if (pending.timer) clearTimeout(pending.timer);
      this.pending.delete(message.id);
      const duration = Date.now() - pending.startedAt;
      if (message.ok) {
        console.log(`[Minecraft Runtime] command ok: ${pending.action} (${message.id}) ${duration}ms`);
        this.trace({ type: 'command-response', commandId: message.id, action: pending.action, ok: true, durationMs: duration });
        pending.resolve(message.data);
      } else {
        console.warn(`[Minecraft Runtime] command failed: ${pending.action} (${message.id}) ${duration}ms: ${message.error}`);
        this.trace({ type: 'command-response', commandId: message.id, action: pending.action, ok: false, durationMs: duration, error: message.error });
        pending.reject(new Error(message.error));
      }
      return;
    }

    this.trace({ type: 'runtime-event', event: message.event });
    this.logRuntimeEvent(message.event);
    for (const listener of this.listeners) listener(message.event);
    this.handleNotification(message.event);
  }

  private logRuntimeEvent(event: MinecraftRuntimeEvent): void {
    if (event.kind === 'log') {
      const text = `[Minecraft Runtime Event] ${event.message}`;
      if (event.level === 'info') console.log(text);
      else console.warn(text);
      return;
    }
    if (event.kind === 'disconnected') {
      console.warn(`[Minecraft Runtime Event] disconnected: ${event.reason}`);
      return;
    }
  }

  private handleCommandTimeout(id: string, action: MinecraftAction, child: ChildProcess): void {
    const pending = this.pending.get(id);
    if (!pending) return;
    if (pending.timer) clearTimeout(pending.timer);
    this.pending.delete(id);
    const error = new Error(`Minecraft command timed out: ${action}`);
    const resetWorker = shouldResetWorkerOnTimeout(action);
    console.warn(
      `[Minecraft Runtime] ${error.message} (${id}); ${resetWorker ? 'resetting worker' : 'worker kept alive'}`,
    );
    this.trace({ type: 'command-timeout', commandId: id, action, resetWorker });
    pending.reject(error);

    if (!resetWorker || this.child !== child) return;
    this.child = undefined;
    this.rejectAll(new Error('Minecraft runtime reset after command timeout'));
    if (child.connected) child.disconnect();
    else child.kill?.();
  }

  private handleNotification(event: MinecraftRuntimeEvent): void {
    if (
      this.lastOrigin &&
      (event.kind === 'food-shortage'
        || event.kind === 'disconnected'
        || event.kind === 'movement-blocked'
        || event.kind === 'oxygen-danger')
    ) {
      void this.notifier?.(this.lastOrigin, event);
    }
  }

  private handleWorkerExit(error: Error): void {
    if (!this.child) return;
    console.warn(`[Minecraft Runtime] worker closed: ${error.message}`);
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
      if (pending.timer) clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private trace(entry: Record<string, unknown>): void {
    const path = this.options.debugLogPath;
    if (!path) return;
    try {
      mkdirSync(dirname(path), { recursive: true });
      appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...entry })}\n`, 'utf8');
    } catch (error) {
      console.warn(`[Minecraft Runtime] failed to write debug trace: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}

function appendWorkerLog(path: string | undefined, text: string): void {
  if (!path) return;
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${new Date().toISOString()} ${text}\n`, 'utf8');
  } catch (error) {
    console.warn(`[Minecraft Runtime] failed to write worker log: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function spawnMinecraftWorker(debugLogPath?: string): ChildProcess {
  const logDir = debugLogPath ? dirname(debugLogPath) : process.cwd();
  return fork(join(__dirname, 'minecraftWorker.js'), [], {
    cwd: logDir,
    execArgv: [
      // 接近堆上限时自动写 heap snapshot（用于定位 OOM 时的分配来源），并限制堆上限避免拖垮系统
      '--heapsnapshot-near-heap-limit=1',
      '--max-old-space-size=2048',
    ],
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      HIYORI_MINECRAFT_WORKER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
}

function shouldResetWorkerOnTimeout(action: MinecraftAction): boolean {
  return action === 'connect';
}
