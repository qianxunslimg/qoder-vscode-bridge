export const DEFAULT_SDK_IDLE_TIMEOUT_MS = 300_000;

/** Limit one silent wait for SDK output, not the duration of an active turn. */
export async function waitForSdkMessage<T>(
  next: () => Promise<T>,
  timeoutMs: number,
  onTimeout: (error: Error) => void,
  signal?: AbortSignal,
): Promise<T> {
  if (signal?.aborted) {
    const error = new Error('Qoder SDK wait cancelled.');
    error.name = 'AbortError';
    throw error;
  }

  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => {
      const seconds = Math.ceil(timeoutMs / 1000);
      const error = new Error(
        `Qoder SDK did not produce a message within ${seconds} ${seconds === 1 ? 'second' : 'seconds'}. ` +
        'The upstream model or connection may be stalled; retry the request. ' +
        'Increase qoderBridge.sdkIdleTimeoutMs if long reasoning is expected.',
      );
      reject(error);
      try {
        onTimeout(error);
      } catch {
        // Cleanup is best-effort; the idle timeout itself must still reject.
      }
    }, timeoutMs);
  });
  let onAbort: (() => void) | undefined;
  const abortPromise = new Promise<never>((_, reject) => {
    if (!signal) {
      return;
    }
    onAbort = () => {
      const error = new Error('Qoder SDK wait cancelled.');
      error.name = 'AbortError';
      reject(error);
    };
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) {
      onAbort();
    }
  });
  try {
    return await Promise.race([next(), timeoutPromise, abortPromise]);
  } finally {
    if (timeout) {
      clearTimeout(timeout);
    }
    if (signal && onAbort) {
      signal.removeEventListener('abort', onAbort);
    }
  }
}
