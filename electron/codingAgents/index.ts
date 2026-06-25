import { runtimeHost } from '../runtimes';
import { CodingAgentSessionRouter } from './sessionRouter';

export const codingAgentSessionRouter = new CodingAgentSessionRouter(runtimeHost);

export * from './sessionRouter';
