import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readNliHistory } from "./http.mjs";
import { isPromptInjectionAttempt, resolveLocally } from "./router.mjs";
import { resolveLocalFastPath } from "./local-fast-path.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { createModelCascade } from "./model-cascade.mjs";
import { rejectResponse } from "./responses.mjs";
import { resolveLegacyRequest } from "./legacy-request-resolution.mjs";
import { createRequestDeadline, UpstreamUnavailableError } from "./request-deadline.mjs";

export function createRequestResolver(config, dependencies = {}) {
  const { context, now = () => performance.now(), observer = () => {} } = dependencies;
  const requests = new AsyncLocalStorage();
  let cascade;
  const emit = (event) => {
    try { observer(Object.freeze({ ...event, requestId: requests.getStore() })); }
    catch { /* Trusted diagnostics must not affect service. */ }
  };
  const observeClient = (client, stage) => {
    if (!client) return undefined;
    return Object.assign(async (message, scopedContext, groundedRequest, stageOptions) => {
      const result = await client(message, scopedContext, groundedRequest,
        { ...stageOptions, requestId: requests.getStore() });
      const metadata = result?.metadata;
      // A stage attempt is not a dispatch. Only detailed transport owns this counter.
      if (metadata && [0, 1].includes(metadata.dispatchCount)) {
        emit({ type: "transport", stage, dispatchCount: metadata.dispatchCount });
      }
      return result;
    }, { settings: client.settings, url: client.url });
  };
  return async function resolveRequest(message, suppliedContext = context, options = {}) {
    const lifetime = createRequestDeadline(config, { signal: options.signal, now });
    return requests.run(randomUUID(), async () => {
      try {
        emit({ type: "request", stage: "gateway", reason: "started" });
        const rawMessage = String(message || "");
        const safeMessage = rawMessage.trim();
        let history;
        try { history = readNliHistory(options.history); }
        catch { emit({ type: "complete", stage: "security", reason: "invalid_history" }); return rejectResponse(); }
        if (!safeMessage || isPromptInjectionAttempt(safeMessage)) {
          emit({ type: "complete", stage: "security", reason: "rejected" });
          return rejectResponse();
        }
        const baseContext = await lifetime.wait(suppliedContext);
        lifetime.check();
        const scopedContext = { ...baseContext, history,
          currentTargetId: typeof options.currentTargetId === "string" && baseContext.targetById?.has(options.currentTargetId)
            ? options.currentTargetId : null };
        if (options.useModel === false) {
          const local = resolveLocally(safeMessage, scopedContext);
          emit({ type: "complete", stage: "offline", reason: "local" });
          return local.confidence > 0 ? local : rejectResponse();
        }
        if (options.modelClient) {
          const local = resolveLocally(safeMessage, scopedContext);
          const result = await lifetime.wait(resolveLegacyRequest(safeMessage, scopedContext, local,
            local.confidence > 0 ? local : rejectResponse(), options));
          lifetime.check();
          emit({ type: "complete", stage: "legacy", reason: "test_seam" });
          return result;
        }
        const fast = resolveLocalFastPath(rawMessage, scopedContext);
        if (fast) { lifetime.check(); emit({ type: "complete", stage: "fast_path", reason: "exact_command" }); return fast; }
        const prepared = prepareGroundedRequest(safeMessage, scopedContext);
        lifetime.check();
        cascade ??= createModelCascade(config, { context: baseContext, now, observer: emit,
          lfmClient: observeClient(dependencies.lfmClient, "lfm"),
          qwenClient: observeClient(dependencies.qwenClient, "qwen"), verifier: dependencies.verifier });
        const local = resolveLocally(safeMessage, scopedContext);
        const result = await cascade.resolve({ originalMessage: safeMessage, scopedContext, prepared,
          signal: lifetime.signal, deadlineAt: lifetime.deadlineAt,
          localFallback: local.confidence > 0 ? local : undefined });
        lifetime.check();
        if (result.response) return result.response;
        if (options.reportUpstreamFailure) throw new UpstreamUnavailableError();
        return rejectResponse();
      } finally { lifetime.dispose(); }
    });
  };
}
