export function runAbortableOperation<T>(
  operation: Promise<T>,
  signal?: AbortSignal,
  cancel?: () => void | Promise<void>,
): Promise<T> {
  if (!signal) return operation;

  return new Promise<T>((resolve, reject) => {
    let settled = false;

    const cleanup = () => signal.removeEventListener('abort', onAbort);
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback();
    };
    const onAbort = () => {
      finish(() => {
        try {
          Promise.resolve(cancel?.()).catch(() => undefined);
        } catch {
          // Cancellation is best effort; the caller must still regain control.
        }
        reject(createAbortError());
      });
    };

    signal.addEventListener('abort', onAbort, { once: true });
    operation.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) onAbort();
  });
}

function createAbortError(): Error {
  const error = new Error('Operation aborted');
  error.name = 'AbortError';
  return error;
}
