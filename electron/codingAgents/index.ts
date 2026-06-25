import { runtimeHost } from '../runtimes';
import { CodingAgentSessionRouter } from './sessionRouter';

export const codingAgentSessionRouter = new CodingAgentSessionRouter(runtimeHost);

export function setCodingAgentNotifier(
  notifier: Parameters<CodingAgentSessionRouter['setNotifier']>[0]
): void {
  codingAgentSessionRouter.setNotifier(notifier);
}

export function setCodingAgentTerminalNotifier(
  notifier: Parameters<CodingAgentSessionRouter['setTerminalNotifier']>[0]
): void {
  codingAgentSessionRouter.setTerminalNotifier(notifier);
}

export * from './sessionRouter';
