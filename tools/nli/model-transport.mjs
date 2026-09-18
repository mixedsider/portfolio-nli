import { readFileSync } from "node:fs";
import { buildGroundedRequestBlock } from "./context.mjs";
import { createModelAdmission } from "./model-admission.mjs";
import { inspectModelCompletion, modelFailure } from "./model-outcome.mjs";

let schema;
export function getModelDecisionSchema() {
  if (!schema) schema = freezeTree(JSON.parse(readFileSync(new URL("../../nli/model-decision.schema.json", import.meta.url), "utf8")));
  return schema;
}

export function buildLmStudioChatCompletionsUrl(baseUrl) {
  const url = new URL(baseUrl);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("LM Studio URL must use HTTP or HTTPS");
  if (url.username || url.password || url.search || url.hash) throw new Error("LM Studio URL must not include credentials, query, or fragment");
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/v1") ? `${path}/chat/completions` : `${path}/v1/chat/completions`;
  return url.toString();
}

export function buildDetailedModelPayload(settings, message, context, groundedRequest = {}) {
  if (!["json_schema", "plain"].includes(settings.outputMode)) throw new Error("Invalid model output mode");
  const payload = {
    model: settings.name, temperature: 0, max_tokens: settings.maxTokens,
    reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: "system", content: context.prompt },
      { role: "system", content: buildGroundedRequestBlock(groundedRequest) },
      { role: "user", content: message }
    ]
  };
  if (settings.outputMode === "json_schema") payload.response_format = { type: "json_schema", json_schema: {
      name: "portfolio_nli_model_decision", strict: true, schema: getModelDecisionSchema()
    } };
  return payload;
}

export function createDetailedModelClient(settings, {
  endpoint, admission = createModelAdmission(), fetchImpl = globalThis.fetch,
  now = () => performance.now(), setTimer = setTimeout, clearTimer = clearTimeout
} = {}) {
  if (!["lfm", "qwen"].includes(endpoint)) throw new Error("Detailed client requires endpoint lfm or qwen");
  const snapshot = freezeTree(structuredClone(settings));
  const url = buildLmStudioChatCompletionsUrl(snapshot.baseUrl);
  for (const key of ["timeoutMs", "maxTokens", "maxResponseBytes", "maxConcurrentRequests"]) {
    if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] <= 0) throw new Error(`Invalid model setting: ${key}`);
  }
  if (!["json_schema", "plain"].includes(snapshot.outputMode)) throw new Error("Invalid model output mode");
  if (!snapshot.name || typeof snapshot.name !== "string") throw new Error("Invalid model name");
  if (endpoint === "qwen" && (snapshot.reasoningEffort !== undefined && snapshot.reasoningEffort !== "none" ||
    snapshot.chatTemplateKwargs !== undefined && snapshot.chatTemplateKwargs.enable_thinking !== false)) {
    throw new Error("Qwen reasoning settings must be fixed off");
  }
  getModelDecisionSchema();
  async function askDetailed(message, context, groundedRequest = {}, options = {}) {
    const startedAt = now();
    const { signal, budgetMs = snapshot.timeoutMs, deadlineAt = startedAt + budgetMs } = options;
    if (!Number.isFinite(budgetMs) || !Number.isFinite(deadlineAt)) throw new Error("Invalid stage budget");
    const effectiveBudget = Math.max(0, Math.min(snapshot.timeoutMs, budgetMs, deadlineAt - startedAt));
    const metadata = { endpoint, requestedModelId: snapshot.name, budgetMs: effectiveBudget,
      deadlineAt: startedAt + effectiveBudget, elapsedMs: 0, dispatchCount: 0, readCount: 0, bytes: 0, status: null };
    const finish = (result) => ({ ...result, metadata: { ...result.metadata, ...metadata, elapsedMs: Math.max(0, now() - startedAt) } });
    if (signal?.aborted) return finish(modelFailure("aborted"));
    if (effectiveBudget <= 0) return finish(modelFailure("timeout"));
    const release = admission.acquire(url, snapshot.maxConcurrentRequests);
    if (!release) return finish(modelFailure("busy"));
    const controller = new AbortController();
    let abortKind = null;
    let timer;
    let reader;
    let response;
    const abort = (kind) => { if (!abortKind) { abortKind = kind; controller.abort(); } };
    const parentAbort = () => abort("aborted");
    const check = () => {
      if (signal?.aborted) abort("aborted");
      if (now() >= metadata.deadlineAt) abort("timeout");
      if (abortKind) throw new TransportFailure(abortKind);
    };
    try {
      signal?.addEventListener("abort", parentAbort, { once: true });
      timer = setTimer(() => abort("timeout"), Math.min(effectiveBudget, 2_147_483_647));
      check();
      const body = JSON.stringify(buildDetailedModelPayload(snapshot, message, context, groundedRequest));
      check();
      metadata.dispatchCount = 1;
      const pending = Promise.resolve(fetchImpl(url, { method: "POST", headers: { "Content-Type": "application/json" },
        body, signal: controller.signal, redirect: "error" }));
      // An injected fetch may ignore AbortSignal: discard/cancel even its late response.
      pending.then((late) => { if (controller.signal.aborted) cancelBody(late.body); }, () => {});
      response = await abortable(pending, controller.signal);
      check();
      metadata.status = response.status;
      if (!response.ok) throw new TransportFailure("http_error");
      if (!response.body) throw new TransportFailure("invalid_json");
      reader = response.body.getReader();
      const chunks = [];
      while (true) {
        check();
        metadata.readCount += 1;
        const { done, value } = await abortable(reader.read(), controller.signal);
        check();
        if (done) break;
        metadata.bytes += value.byteLength;
        if (metadata.bytes > snapshot.maxResponseBytes) throw new TransportFailure("body_limit");
        chunks.push(value);
      }
      let data;
      try { data = JSON.parse(Buffer.concat(chunks, metadata.bytes).toString("utf8")); }
      catch { throw new TransportFailure("invalid_json"); }
      const result = inspectModelCompletion(data, endpoint);
      check();
      return finish(result);
    } catch (error) {
      return finish(modelFailure(abortKind || (error instanceof TransportFailure ? error.kind : "http_error")));
    } finally {
      clearTimer(timer);
      signal?.removeEventListener("abort", parentAbort);
      controller.abort();
      if (reader) {
        reader.cancel().catch(() => {});
        reader.releaseLock();
      } else cancelBody(response?.body);
      release();
    }
  }
  return Object.freeze(Object.assign(askDetailed, { settings: snapshot, endpoint, url }));
}

function abortable(promise, signal) {
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(new TransportFailure("aborted"));
    if (signal.aborted) { onAbort(); return; }
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

function cancelBody(body) { if (body && !body.locked) body.cancel().catch(() => {}); }
class TransportFailure extends Error {
  constructor(kind) { super(kind); this.kind = kind; }
}
function freezeTree(value) {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeTree(child);
    Object.freeze(value);
  }
  return value;
}
