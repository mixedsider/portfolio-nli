import { setImmediate as tick, setTimeout as delay } from "node:timers/promises";
import { createNliServer } from "../nli-gateway.mjs";
import { createDetailedModelClient, buildDetailedModelPayload } from "./model-client.mjs";
import { createModelAdmission } from "./model-admission.mjs";
import { createQwenVerifier } from "./qwen-verification.mjs";
import { createStageObserver } from "./test-observer.mjs";
import { modelFailure } from "./model-outcome.mjs";

export async function createEvalSession(config, context, cases, { ordered = false, injectLfm = false } = {}) {
  if (!cases.length || new Set(cases.map((item) => item.message)).size !== cases.length) throw new Error("Empty/duplicate session cases");
  const admission = createModelAdmission(config.cascade.maxConcurrentRequests);
  const observer = createStageObserver();
  const controller = new AbortController();
  const pending = new Set();
  const records = new Map();
  const faults = [];
  const http = [];
  let maxActive = 0;
  let ordinal = 0;
  const trackedAdmission = Object.freeze({
    get active() { return admission.active; }, activeFor: admission.activeFor,
    acquire(...args) {
      const release = admission.acquire(...args);
      maxActive = Math.max(maxActive, admission.active);
      return release;
    }
  });
  const client = (endpoint) => {
    const real = createDetailedModelClient(endpoint === "lfm" ? config.lfm : config.model, { endpoint, admission: trackedAdmission });
    const wrapped = (message, scoped, grounded, options) => {
      const operation = (async () => {
        const record = records.get(options.requestId);
        const item = cases.find((entry) => entry.message === message);
        if (!record || !item || (record.fixtureId && record.fixtureId !== item.id)) {
          faults.push("client_correlation_failed");
          throw new Error("Fixture correlation failed");
        }
        record.fixtureId = item.id;
        const payload = buildDetailedModelPayload(real.settings, message, scoped, grounded);
        const result = await real(message, scoped, grounded, options);
        record.transports.push({ endpoint, tag: result.tag, kind: result.kind ?? null,
          ...result.metadata, requestBytes: Buffer.byteLength(JSON.stringify(payload)),
          messageBytes: payload.messages.map((entry) => Buffer.byteLength(entry.content)) });
        // Fault injection preserves the REAL dispatch and transport facts; only the proposal is suppressed.
        if (injectLfm && endpoint === "lfm" && !["busy", "aborted"].includes(result.kind)) {
          record.injection = "synthetic-first-stage: discard actual LFM result as invalid_json";
          return modelFailure("invalid_json", result.metadata);
        }
        return result;
      })();
      pending.add(operation);
      operation.then(() => pending.delete(operation), () => pending.delete(operation));
      return operation;
    };
    return Object.assign(wrapped, { settings: real.settings, url: real.url });
  };
  const lfmClient = client("lfm");
  const qwenClient = client("qwen");
  const verifier = createQwenVerifier(qwenClient.settings, config.cascade, { context, admission: trackedAdmission });
  const gateChecks = [];
  const trackedVerifier = { invalidate: verifier.invalidate, async verify(options) {
    const gate = await verifier.verify(options);
    gateChecks.push(gate);
    return gate;
  } };
  const server = await createNliServer({ config, context, lfmClient, qwenClient, verifier: trackedVerifier,
    signal: controller.signal, observer(event) {
      try {
        if (!/^[0-9a-f-]{36}$/.test(event.requestId)) throw new Error("invalid UUID");
        observer.observer(event);
        if (event.type === "request") records.set(event.requestId, { requestId: event.requestId,
          fixtureId: ordered ? cases[ordinal++]?.id : null, startedAt: performance.now(), transports: [], events: [] });
        const record = records.get(event.requestId);
        record.events.push(event);
        if (event.type === "complete") record.elapsedMs = performance.now() - record.startedAt;
      } catch { faults.push("observer_failed"); }
    }
  });
  server.on("request", (req, res) => {
    const row = { ordinal: http.length, status: null, elapsedMs: null };
    const start = performance.now();
    http.push(row);
    res.once("finish", () => { row.status = res.statusCode; row.elapsedMs = performance.now() - start; });
  });
  async function settle() {
    const end = performance.now() + 2000;
    while (pending.size) {
      if (performance.now() >= end) throw new Error("Transport cleanup timeout");
      await delay(5);
    }
    await tick();
  }
  const rows = () => [...records.values()].map(({ startedAt, ...row }) => ({ ...row, ...observer.snapshot(row.requestId) }));
  async function close() {
    controller.abort();
    let failure;
    try {
      await new Promise((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        server.closeAllConnections();
      });
      await settle();
      if (server.listening || admission.active !== 0 || pending.size) throw new Error("Resources remain active");
    } catch (error) { failure = error; }
    finally { observer.clear(); records.clear(); }
    if (failure) throw failure;
    return { ok: true, listening: server.listening, active: admission.active, pending: pending.size,
      observerRecords: observer.requestIds().length };
  }
  try {
    await new Promise((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
    });
  } catch (error) { controller.abort(); server.closeAllConnections(); observer.clear(); throw error; }
  return { url: `http://127.0.0.1:${server.address().port}`, rows, settle, close, faults, http, gateChecks,
    verifier: trackedVerifier, get maxActive() { return maxActive; }, get active() { return admission.active; } };
}
