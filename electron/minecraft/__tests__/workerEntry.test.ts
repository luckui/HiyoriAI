import { describe, expect, it, vi } from 'vitest';
import { createWorkerDispatcher, type WorkerController } from '../workerEntry';
import type { MinecraftCommand, MinecraftWorkerMessage } from '../protocol';

function createController(): WorkerController {
  return {
    connect: vi.fn(async (payload) => ({ connected: true, ...payload })),
    disconnect: vi.fn(async () => undefined),
    status: vi.fn(() => ({ connected: true })),
    say: vi.fn(async () => undefined),
    follow: vi.fn(async (payload) => ({ state: 'following', ...payload })),
    collect: vi.fn(async () => ({ state: 'running', jobId: 'job-1' })),
    stop: vi.fn(async () => undefined),
  };
}

describe('Minecraft worker dispatcher', () => {
  it('correlates command responses by request id', async () => {
    const sent: MinecraftWorkerMessage[] = [];
    const controller = createController();
    const dispatch = createWorkerDispatcher(controller, (message) => sent.push(message));
    const command: MinecraftCommand = {
      type: 'command',
      id: 'request-1',
      action: 'follow',
      payload: { player: 'GeoLingua' },
    };

    await dispatch(command);

    expect(controller.follow).toHaveBeenCalledWith({ player: 'GeoLingua' });
    expect(sent).toEqual([
      {
        type: 'response',
        id: 'request-1',
        ok: true,
        data: { state: 'following', player: 'GeoLingua' },
      },
    ]);
  });

  it('turns controller failures into serializable responses', async () => {
    const sent: MinecraftWorkerMessage[] = [];
    const controller = createController();
    vi.mocked(controller.say).mockRejectedValueOnce(new Error('not connected'));
    const dispatch = createWorkerDispatcher(controller, (message) => sent.push(message));

    await dispatch({
      type: 'command',
      id: 'request-2',
      action: 'say',
      payload: { message: 'hello' },
    });

    expect(sent).toEqual([
      {
        type: 'response',
        id: 'request-2',
        ok: false,
        error: 'not connected',
      },
    ]);
  });

  it('disconnects cleanly when the parent IPC channel closes', async () => {
    const controller = createController();
    const dispatch = createWorkerDispatcher(controller, vi.fn());

    await dispatch.parentDisconnected();
    await dispatch.parentDisconnected();

    expect(controller.disconnect).toHaveBeenCalledTimes(1);
  });
});
