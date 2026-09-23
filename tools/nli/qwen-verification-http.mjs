export async function withVerificationBudget(options, operation) {
  const { signal, now = () => performance.now() } = options;
  const deadlineAt = Math.min(options.deadlineAt ?? Infinity, now() + options.budgetMs);
  const controller = new AbortController();
  let timer;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const abort = () => { controller.abort(); rejectAbort(new Error(signal?.aborted ? "aborted" : "timeout")); };
  signal?.addEventListener("abort", abort, { once: true });
  const check = () => {
    if (signal?.aborted) throw new Error("aborted");
    if (controller.signal.aborted || now() >= deadlineAt) throw new Error("timeout");
  };
  try {
    check();
    timer = setTimeout(abort, Math.max(0, deadlineAt - now()));
    const result = await Promise.race([operation({ signal: controller.signal, check, deadlineAt }), aborted]);
    check();
    return result;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
    controller.abort();
  }
}

export function verificationRequest(inputs, dependencies, scope, counters) {
  const { admission, fetchImpl = fetch } = dependencies;
  return async (url, payload) => {
    scope.check();
    const release = admission.acquire(inputs.url, inputs.settings.maxConcurrentRequests);
    if (!release) throw new Error("busy");
    let reader;
    let rejectAbort;
    const aborted = new Promise((_, reject) => { rejectAbort = reject; });
    const cancel = () => { if (reader) void reader.cancel().catch(() => {}); };
    const onAbort = () => { cancel(); release(); rejectAbort(new Error("aborted")); };
    scope.signal.addEventListener("abort", onAbort, { once: true });
    try {
      const operation = async () => {
        counters.metadataCalls += url.endsWith("/chat/completions") ? 0 : 1;
        counters.inferenceCalls += url.endsWith("/chat/completions") ? 1 : 0;
        const response = await fetchImpl(url, { method: payload === undefined ? "GET" : "POST", redirect: "error", signal: scope.signal,
          headers: { "Content-Type": "application/json" }, ...(payload === undefined ? {} : { body: JSON.stringify(payload) }) });
        try { scope.check(); }
        catch (error) { void response.body?.cancel().catch(() => {}); throw error; }
        if (!response.ok) { void response.body?.cancel().catch(() => {}); throw new Error("http_error"); }
        reader = response.body?.getReader();
        if (!reader) throw new Error("invalid_json");
        const chunks = [];
        let bytes = 0;
        while (true) {
          scope.check();
          const part = await reader.read();
          scope.check();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > inputs.settings.maxResponseBytes) throw new Error("body_limit");
          chunks.push(part.value);
        }
        try { return JSON.parse(Buffer.concat(chunks).toString("utf8")); }
        catch { throw new Error("invalid_json"); }
      };
      return await Promise.race([operation(), aborted]);
    } finally {
      scope.signal.removeEventListener("abort", onAbort);
      cancel();
      reader?.releaseLock();
      release();
    }
  };
}
