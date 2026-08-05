import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { MinecraftRuntimeManager } from '../runtimeManager';
import type { MinecraftCommand, MinecraftWorkerMessage } from '../protocol';

class FakeChild extends EventEmitter {
  connected = true;
  sent: MinecraftCommand[] = [];
  send = vi.fn((message: MinecraftCommand) => {
    this.sent.push(message);
    return true;
  });
  disconnect = vi.fn(() => {
    this.connected = false;
  });
  kill = vi.fn();

  reply(index: number, data: unknown) {
    const command = this.sent[index];
    this.emit('message', {
      type: 'response',
      id: command.id,
      ok: true,
      data,
    } satisfies MinecraftWorkerMessage);
  }
}

describe('MinecraftRuntimeManager', () => {
  it('correlates worker responses and cleans pending requests', async () => {
    const child = new FakeChild();
    const manager = new MinecraftRuntimeManager({ spawnWorker: () => child as any });

    const pending = manager.command('status', {});
    child.reply(0, { connected: true });

    await expect(pending).resolves.toEqual({ connected: true });
    expect(manager.pendingRequestCount()).toBe(0);
  });

  it('rejects timed out requests and worker crashes', async () => {
    vi.useFakeTimers();
    const child = new FakeChild();
    const manager = new MinecraftRuntimeManager({ spawnWorker: () => child as any });
    const timedOut = manager.command('status', {}, 20);
    const timedOutExpectation = expect(timedOut).rejects.toThrow('timed out');
    await vi.advanceTimersByTimeAsync(21);
    await timedOutExpectation;
    vi.useRealTimers();

    const pending = manager.command('status', {});
    child.emit('exit', 1, null);
    await expect(pending).rejects.toThrow('exited');
  });

  it('notifies one collection terminal event and ignores progress logs', async () => {
    const child = new FakeChild();
    const notifier = vi.fn();
    const manager = new MinecraftRuntimeManager({ spawnWorker: () => child as any });
    manager.setNotifier(notifier);
    const origin = {
      conversationId: 'conversation-1',
      replyTarget: { kind: 'desktop' as const },
    };

    const accepted = manager.startCollection(
      { block: 'oak_log', quantity: 4, radius: 16 },
      origin,
    );
    child.reply(0, { state: 'running', jobId: 'job-1' });
    await accepted;
    child.emit('message', {
      type: 'event',
      event: { kind: 'log', level: 'info', message: 'walking' },
    } satisfies MinecraftWorkerMessage);
    const terminal: MinecraftWorkerMessage = {
      type: 'event',
      event: {
        kind: 'collection-terminal',
        jobId: 'job-1',
        outcome: 'completed',
        block: 'oak_log',
        requested: 4,
        collected: 4,
      },
    };
    child.emit('message', terminal);
    child.emit('message', terminal);

    expect(notifier).toHaveBeenCalledTimes(1);
    expect(notifier).toHaveBeenCalledWith(
      origin,
      expect.objectContaining({ kind: 'collection-terminal', jobId: 'job-1' }),
    );
  });

  it('stores action origins by goal instead of collection-only state', async () => {
    const manager = new MinecraftRuntimeManager();

    await manager.startGoal({
      id: 'goal-1',
      title: 'collect nearby sugar cane',
      origin: { source: 'minecraft', conversationId: 'conversation-1' },
    });

    expect(manager.getGoal('goal-1')?.origin.source).toBe('minecraft');
    expect(manager.getGoal('goal-1')?.status).toBe('running');
  });

  it('dedupes significant terminal events before notifying main integration', () => {
    const notify = vi.fn();
    const manager = new MinecraftRuntimeManager({ notify });

    manager.startGoal({
      id: 'goal-1',
      title: 'collect nearby sugar cane',
      origin: { source: 'desktop', conversationId: 'conversation-1' },
    });
    manager.recordSignificantEvent('goal-1', { kind: 'completed', text: 'done' });
    manager.recordSignificantEvent('goal-1', { kind: 'completed', text: 'done' });

    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('shuts down the worker cleanly', async () => {
    const child = new FakeChild();
    const manager = new MinecraftRuntimeManager({ spawnWorker: () => child as any });
    const pending = manager.command('status', {});
    child.reply(0, {});
    await pending;

    await manager.shutdown();

    expect(child.disconnect).toHaveBeenCalledOnce();
  });
});
