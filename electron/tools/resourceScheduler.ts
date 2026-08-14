import type { ToolResourceClaim } from './types';

interface ActiveResource {
  shared: number;
  exclusive: number;
}

interface PendingOperation {
  claims: ToolResourceClaim[];
  enqueuedAt: number;
  operation: (queueWaitMs: number) => Promise<unknown> | unknown;
  resolve: (result: { value: unknown; queueWaitMs: number }) => void;
  reject: (reason?: unknown) => void;
  signal?: AbortSignal;
  abortListener?: () => void;
}

export class ToolResourceScheduler {
  private readonly active = new Map<string, ActiveResource>();
  private readonly queue: PendingOperation[] = [];

  run<T>(
    claims: readonly ToolResourceClaim[],
    operation: (queueWaitMs: number) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<{ value: T; queueWaitMs: number }> {
    let normalized: ToolResourceClaim[];
    try {
      normalized = normalizeClaims(claims);
    } catch (error) {
      return Promise.reject(error);
    }

    if (signal?.aborted) return Promise.reject(createAbortError());

    return new Promise<{ value: T; queueWaitMs: number }>((resolve, reject) => {
      const pending: PendingOperation = {
        claims: normalized,
        enqueuedAt: Date.now(),
        operation,
        resolve: resolve as PendingOperation['resolve'],
        reject,
        signal,
      };

      if (signal) {
        pending.abortListener = () => {
          const index = this.queue.indexOf(pending);
          if (index < 0) return;
          this.queue.splice(index, 1);
          pending.reject(createAbortError());
          this.drain();
        };
        signal.addEventListener('abort', pending.abortListener, { once: true });
      }

      this.queue.push(pending);
      this.drain();
    });
  }

  private drain(): void {
    let index = 0;
    while (index < this.queue.length) {
      const pending = this.queue[index];
      if (!this.canStart(pending, index)) {
        index += 1;
        continue;
      }

      this.queue.splice(index, 1);
      if (pending.signal && pending.abortListener) {
        pending.signal.removeEventListener('abort', pending.abortListener);
      }
      this.acquire(pending.claims);
      const queueWaitMs = Date.now() - pending.enqueuedAt;

      Promise.resolve()
        .then(() => pending.operation(queueWaitMs))
        .then((value) => pending.resolve({ value, queueWaitMs }))
        .catch(pending.reject)
        .finally(() => {
          this.release(pending.claims);
          this.drain();
        });
    }
  }

  private canStart(pending: PendingOperation, index: number): boolean {
    if (pending.claims.some((claim) => conflictsWithActive(claim, this.active.get(claim.key)))) {
      return false;
    }

    for (let earlier = 0; earlier < index; earlier += 1) {
      if (claimSetsConflict(this.queue[earlier].claims, pending.claims)) return false;
    }
    return true;
  }

  private acquire(claims: readonly ToolResourceClaim[]): void {
    for (const claim of claims) {
      const state = this.active.get(claim.key) ?? { shared: 0, exclusive: 0 };
      state[claim.access] += 1;
      this.active.set(claim.key, state);
    }
  }

  private release(claims: readonly ToolResourceClaim[]): void {
    for (const claim of claims) {
      const state = this.active.get(claim.key);
      if (!state) continue;
      state[claim.access] -= 1;
      if (state.shared === 0 && state.exclusive === 0) this.active.delete(claim.key);
    }
  }
}

export const globalToolResourceScheduler = new ToolResourceScheduler();

function normalizeClaims(claims: readonly ToolResourceClaim[]): ToolResourceClaim[] {
  const byKey = new Map<string, ToolResourceClaim['access']>();
  for (const claim of claims) {
    const key = claim.key.trim();
    if (!key) throw new Error('Tool resource key cannot be empty');
    const current = byKey.get(key);
    byKey.set(key, current === 'exclusive' || claim.access === 'exclusive' ? 'exclusive' : 'shared');
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, access]) => ({ key, access }));
}

function conflictsWithActive(
  claim: ToolResourceClaim,
  active: ActiveResource | undefined,
): boolean {
  if (!active) return false;
  if (claim.access === 'exclusive') return active.shared > 0 || active.exclusive > 0;
  return active.exclusive > 0;
}

function claimSetsConflict(
  left: readonly ToolResourceClaim[],
  right: readonly ToolResourceClaim[],
): boolean {
  for (const first of left) {
    const second = right.find((claim) => claim.key === first.key);
    if (!second) continue;
    if (first.access === 'exclusive' || second.access === 'exclusive') return true;
  }
  return false;
}

function createAbortError(): Error {
  const error = new Error('Tool execution was cancelled while waiting for a resource');
  error.name = 'AbortError';
  return error;
}
