import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { EventEmitter } from 'events';
import { createRequire } from 'module';

export interface CodexAppServerClientOptions {
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  spawnProcess?: (command: string, args: string[], env: NodeJS.ProcessEnv) => ChildProcessWithoutNullStreams;
}

export interface CodexJsonRpcNotification {
  method: string;
  params?: any;
}

interface PendingRequest {
  resolve(value: any): void;
  reject(error: Error): void;
  timeout: NodeJS.Timeout;
}

const requireFromHere = createRequire(__filename);

export class CodexAppServerClient {
  private process?: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private buffer = '';
  private initialized = false;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly emitter = new EventEmitter();

  constructor(private readonly options: CodexAppServerClientOptions = {}) {}

  async start(): Promise<void> {
    if (this.initialized) return;
    this.process = this.createProcess();
    this.process.stdout.on('data', (chunk) => this.handleStdout(chunk.toString('utf8')));
    this.process.stderr.on('data', (chunk) => this.emitter.emit('stderr', chunk.toString('utf8')));
    this.process.on('exit', (code, signal) => this.rejectAll(new Error(`Codex app-server exited: ${code ?? signal ?? 'unknown'}`)));

    await this.request('initialize', {
      clientInfo: { name: 'hiyori', version: '0.0.0' },
      capabilities: null,
    });
    this.initialized = true;
  }

  async request(method: string, params?: any, timeoutMs = 30000): Promise<any> {
    if (!this.process) throw new Error('Codex app-server is not running');
    const id = this.nextId++;
    const message = params === undefined ? { id, method } : { id, method, params };
    this.process.stdin.write(`${JSON.stringify(message)}\n`);

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
    });
  }

  onNotification(listener: (notification: CodexJsonRpcNotification) => void): () => void {
    this.emitter.on('notification', listener);
    return () => this.emitter.off('notification', listener);
  }

  onStderr(listener: (message: string) => void): () => void {
    this.emitter.on('stderr', listener);
    return () => this.emitter.off('stderr', listener);
  }

  stop(): void {
    this.process?.kill();
    this.process = undefined;
    this.initialized = false;
  }

  private createProcess(): ChildProcessWithoutNullStreams {
    const command = this.options.command ?? process.execPath;
    const args = this.options.args ?? [requireFromHere.resolve('@openai/codex/bin/codex.js'), 'app-server', '--stdio'];
    const env = { ...process.env, ...(this.options.env ?? {}) };
    return this.options.spawnProcess?.(command, args, env) ?? spawn(command, args, { env, stdio: 'pipe' });
  }

  private handleStdout(chunk: string): void {
    this.buffer += chunk;
    let newlineIndex = this.buffer.indexOf('\n');
    while (newlineIndex >= 0) {
      const line = this.buffer.slice(0, newlineIndex).trim();
      this.buffer = this.buffer.slice(newlineIndex + 1);
      if (line) this.handleLine(line);
      newlineIndex = this.buffer.indexOf('\n');
    }
  }

  private handleLine(line: string): void {
    let message: any;
    try {
      message = JSON.parse(line);
    } catch {
      this.emitter.emit('stderr', `Unparseable Codex app-server output: ${line}`);
      return;
    }

    if (typeof message.id === 'number' && typeof message.method === 'string') {
      this.emitter.emit('notification', message);
      return;
    }

    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timeout);
      if (message.error) pending.reject(new Error(message.error.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }

    if (typeof message.method === 'string') {
      this.emitter.emit('notification', message);
    }
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
    this.pending.clear();
  }
}
