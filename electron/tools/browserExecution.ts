import type { ToolExecutionPolicy, ToolResourceAccess } from './types';

const BROWSER_SESSION_RESOURCE = 'browser:session';

export function browserExecution<TParams>(
  access: ToolResourceAccess,
): ToolExecutionPolicy<TParams> {
  return {
    resources: () => [{ key: BROWSER_SESSION_RESOURCE, access }],
  };
}
