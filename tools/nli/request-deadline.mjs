import { APPLICATION_TIMEOUT_MS } from "./timeout-policy.mjs";

export class UpstreamUnavailableError extends Error {}

// The application clock excludes HTTP body receipt, but includes context and retrieval.
export function createRequestDeadline(config, { signal, now = () => performance.now() } = {}) {
  const deadlineAt = now() + Math.min(APPLICATION_TIMEOUT_MS, config.cascade?.timeoutMs ?? APPLICATION_TIMEOUT_MS);
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(abort, Math.max(0, deadlineAt - now()));
  const check = () => {
    if (controller.signal.aborted || now() >= deadlineAt) throw new UpstreamUnavailableError();
  };
  return {
    deadlineAt, signal: controller.signal, check,
    wait(value) {
      check();
      return new Promise((resolve, reject) => {
        const cancelled = () => {
          controller.signal.removeEventListener("abort", cancelled);
          reject(new UpstreamUnavailableError());
        };
        controller.signal.addEventListener("abort", cancelled, { once: true });
        Promise.resolve(value).then(resolve, reject).finally(() => {
          controller.signal.removeEventListener("abort", cancelled);
        });
      });
    },
    dispose() { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
  };
}

export function observeClientDisconnect(request, response, parentSignal) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  const onClose = () => { if (!response.writableFinished) abort(); };
  request.once("aborted", abort);
  response.once("close", onClose);
  parentSignal?.addEventListener("abort", abort, { once: true });
  if (request.aborted || response.destroyed || parentSignal?.aborted) abort();
  return {
    signal: controller.signal,
    dispose() {
      request.removeListener("aborted", abort);
      response.removeListener("close", onClose);
      parentSignal?.removeEventListener("abort", abort);
    }
  };
}

export function canWriteResponse(response) {
  return !response.destroyed && !response.writableEnded && !response.socket?.destroyed;
}
