export async function requestProbeJson(url, options, dependencies = {}) {
  const { timeoutMs, maxResponseBytes, payload } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || !Number.isSafeInteger(maxResponseBytes) || maxResponseBytes <= 0) {
    throw new Error("Probe bounds must be positive integers");
  }
  const fetchImpl = dependencies.fetchImpl || fetch;
  const controller = new AbortController();
  const started = performance.now();
  let timer;
  let reader;
  let status = null;
  let bytes = 0;
  const deadline = new Promise((_, reject) => {
    timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, timeoutMs);
  });
  const operation = async () => {
    const response = await fetchImpl(url, {
      method: payload === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
      headers: { "Content-Type": "application/json" },
      ...(payload === undefined ? {} : { body: JSON.stringify(payload) })
    });
    status = response.status;
    reader = response.body?.getReader();
    const chunks = [];
    if (reader) while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxResponseBytes) throw new Error("body_limit");
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!response.ok) return { ok: false, kind: "http_error",
      schemaUnsupported: [400, 422, 501].includes(status) && /schema|response_format|grammar/i.test(text) && /unsupported|not supported|invalid|error|failed/i.test(text) };
    try { return { ok: true, data: JSON.parse(text) }; }
    catch { return { ok: false, kind: "invalid_json" }; }
  };
  try {
    return { ...await Promise.race([operation(), deadline]), status, bytes, elapsedMs: performance.now() - started };
  } catch (error) {
    const kind = controller.signal.aborted ? "timeout" : error.message === "body_limit" ? "body_limit" : "network_error";
    return { ok: false, kind, status, bytes, elapsedMs: performance.now() - started };
  } finally {
    clearTimeout(timer);
    controller.abort();
    if (reader) await reader.cancel().catch(() => {});
  }
}
