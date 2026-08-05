import type { MinecraftCommand, MinecraftWorkerMessage } from './protocol';

export interface WorkerController {
  connect(payload: any): Promise<unknown>;
  disconnect(): Promise<unknown>;
  status(): unknown;
  say(payload: any): Promise<unknown>;
  follow(payload: any): Promise<unknown>;
  collect(payload: any): Promise<unknown>;
  stop(): Promise<unknown>;
}

export type WorkerDispatch = ((command: MinecraftCommand) => Promise<void>) & {
  parentDisconnected(): Promise<void>;
};

export function createWorkerDispatcher(
  controller: WorkerController,
  send: (message: MinecraftWorkerMessage) => void,
): WorkerDispatch {
  let parentClosed = false;

  const dispatch = async (command: MinecraftCommand): Promise<void> => {
    try {
      const data = await runCommand(controller, command);
      send({ type: 'response', id: command.id, ok: true, data });
    } catch (error) {
      send({
        type: 'response',
        id: command.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return Object.assign(dispatch, {
    async parentDisconnected(): Promise<void> {
      if (parentClosed) return;
      parentClosed = true;
      await controller.disconnect();
    },
  });
}

async function runCommand(
  controller: WorkerController,
  command: MinecraftCommand,
): Promise<unknown> {
  switch (command.action) {
    case 'connect':
      return controller.connect(command.payload);
    case 'disconnect':
      return controller.disconnect();
    case 'status':
      return controller.status();
    case 'say':
      return controller.say((command.payload as { message: string }).message);
    case 'follow':
      return controller.follow(command.payload);
    case 'collect':
      return controller.collect(command.payload);
    case 'stop':
      return controller.stop();
    default:
      throw new Error(`Unsupported Minecraft worker action: ${command.action}`);
  }
}

async function startWorker(): Promise<void> {
  const [{ MinecraftBodyController }, { createMineflayerAdapter }] =
    await Promise.all([import('./bodyController'), import('./mineflayerAdapter')]);
  const send = (message: MinecraftWorkerMessage) => process.send?.(message);
  const adapter = createMineflayerAdapter((event) =>
    send({ type: 'event', event }),
  );
  const controller = new MinecraftBodyController(adapter, (event) =>
    send({ type: 'event', event }),
  );
  const dispatch = createWorkerDispatcher(controller, send);

  process.on('message', (message: MinecraftCommand) => void dispatch(message));
  process.once('disconnect', () => {
    void dispatch.parentDisconnected().finally(() => process.exit(0));
  });
}

if (process.env.HIYORI_MINECRAFT_WORKER === '1') {
  void startWorker();
}
