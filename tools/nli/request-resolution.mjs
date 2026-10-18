import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { readNliHistory } from "./http.mjs";
import { isPromptInjectionAttempt, resolveLocally } from "./router.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { PreparedDecisionUnavailableError } from "./decision-schema.mjs";
import { createDetailedModelClient } from "./model-client.mjs";
import { acceptTransportProposal, isCompatibleLocalFallback } from "./proposal-acceptance.mjs";
import { rejectResponse } from "./responses.mjs";
import { resolveLegacyRequest } from "./legacy-request-resolution.mjs";
import { createRequestDeadline, UpstreamUnavailableError } from "./request-deadline.mjs";

export function createRequestResolver(config, dependencies = {}) {
  const { context, now = () => performance.now(), observer = () => {} } = dependencies;
  const requests = new AsyncLocalStorage();
  let defaultClient;
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
        let prepared;
        try { prepared = prepareGroundedRequest(safeMessage, scopedContext); }
        catch (error) {
          if (!(error instanceof PreparedDecisionUnavailableError)) throw error;
          lifetime.check();
          if (error.coverageImpossible) {
            emit({ type: "complete", stage: "clarification", reason: "coverage_impossible" });
            return rejectResponse("비교하거나 설명할 대상을 더 구체적으로 알려주세요.");
          }
          emit({ type: "complete", stage: "upstream_error", reason: "scope_mismatch" });
          if (options.reportUpstreamFailure) throw new UpstreamUnavailableError();
          return rejectResponse();
        }
        lifetime.check();
        const local = resolveLocally(safeMessage, scopedContext);
        const localFallback = local.confidence > 0 ? local : undefined;
        const fallback = (reason) => {
          if (["busy", "aborted"].includes(reason)) {
            emit({ type: "complete", stage: "upstream_error", reason });
            if (options.reportUpstreamFailure) throw new UpstreamUnavailableError();
            return rejectResponse();
          }
          if (!prepared.coveragePossible || prepared.obligations.kind === "ambiguity" || prepared.obligations.ambiguousTargetIds.length > 1) {
            emit({ type: "complete", stage: "clarification", reason: !prepared.coveragePossible ? "coverage_impossible" : "ambiguous_request" });
            return rejectResponse("비교하거나 설명할 대상을 더 구체적으로 알려주세요.");
          }
          if (localFallback && isCompatibleLocalFallback(localFallback, scopedContext, prepared, safeMessage)) {
            emit({ type: "complete", stage: "local_fallback", reason });
            return localFallback;
          }
          emit({ type: "complete", stage: "upstream_error", reason });
          if (options.reportUpstreamFailure) throw new UpstreamUnavailableError();
          return rejectResponse();
        };

        const qwenEnabled = config.cascade?.qwenEnabled !== false;
        const stage = qwenEnabled ? "qwen" : "lfm";
        const modelSettings = qwenEnabled ? config.model : (config.lfm ?? config.model);
        const rawClient = (qwenEnabled ? (dependencies.qwenClient ?? dependencies.lfmClient) : dependencies.lfmClient) ??
          (defaultClient ??= createDetailedModelClient(modelSettings, { endpoint: stage, now }));
        const client = observeClient(rawClient, stage);
        emit({ type: "attempt", stage, reason: "eligible" });
        const outcome = await client(safeMessage, scopedContext, prepared.groundedRequest, {
          signal: lifetime.signal,
          deadlineAt: lifetime.deadlineAt,
          budgetMs: lifetime.deadlineAt - now()
        });
        const workDeadline = lifetime.deadlineAt - 1000;
        if (lifetime.signal.aborted || now() >= workDeadline) {
          throw new UpstreamUnavailableError();
        }
        lifetime.check();
        if (outcome?.tag === "failure") {
          return fallback(outcome.kind || "failure");
        }

        const accepted = acceptTransportProposal(outcome, scopedContext, prepared, safeMessage);
        if (accepted.accepted) {
          emit({ type: "complete", stage, reason: "accepted" });
          return accepted.response;
        }

        return fallback(accepted.reason || "proposal_invalid");

      } finally { lifetime.dispose(); }
    });
  };
}
