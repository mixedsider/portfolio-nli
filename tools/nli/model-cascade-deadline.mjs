// Also bounds trusted test adapters that ignore their signal. No upstream lease here.
export async function runCascadeOperation(operation, { signal, deadlineAt, now }) {
  const controller = new AbortController();
  let timer;
  let failure;
  let stop;
  const stopped = new Promise((resolve) => { stop = resolve; });
  const abort = (reason) => {
    if (failure) return;
    failure = reason;
    controller.abort();
    stop({ failure: reason });
  };
  const onAbort = () => abort("aborted");
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    if (signal?.aborted) abort("aborted");
    else if (now() >= deadlineAt) abort("timeout");
    if (failure) return { failure };
    timer = setTimeout(() => abort("timeout"), Math.max(0, deadlineAt - now()));
    const pending = Promise.resolve().then(() => {
      if (signal?.aborted) abort("aborted");
      else if (now() >= deadlineAt) abort("timeout");
      if (failure) return { failure };
      return Promise.resolve(operation(controller.signal)).then((value) => ({ value }));
    }).catch(() => ({ failure: "http_error" }));
    const result = await Promise.race([pending, stopped]);
    if (signal?.aborted) abort("aborted");
    else if (now() >= deadlineAt) abort("timeout");
    return failure ? { failure } : result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

export function assertCascadeRequest({ originalMessage, scopedContext, prepared, deadlineAt }) {
  if (typeof originalMessage !== "string" || !scopedContext || !Number.isFinite(deadlineAt) ||
    !prepared?.groundedRequest || !prepared.obligations || typeof prepared.coveragePossible !== "boolean" ||
    prepared.coveragePossible !== prepared.obligations.coveragePossible ||
    prepared.candidateSources !== prepared.groundedRequest.candidateSources || !deeplyFrozen(prepared)) {
    throw new TypeError("Cascade requires original message, scoped context, frozen preparation and absolute monotonic deadline");
  }
}

function deeplyFrozen(value) {
  return value === null || typeof value !== "object" ||
    (Object.isFrozen(value) && Object.values(value).every(deeplyFrozen));
}
