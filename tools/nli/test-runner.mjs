import { resolveNliRequest } from "../nli-gateway.mjs";
import { createGatewayConfig } from "./config.mjs";
import { createRequestResolver } from "./request-resolution.mjs";
import { inspectModelCompletion, modelFailure } from "./model-outcome.mjs";
import { expectationFor } from "./test-fixtures.mjs";
import { validateResult } from "./test-expectations.mjs";
import { EVALUATION_HTTP_TIMEOUT_MS } from "./timeout-policy.mjs";

export async function runTestCase(testCase, context, options, endpoint, dependencies = {}) {
  const observations = {};
  const events = [];
  try {
    const expectation = expectationFor(testCase, options.mode);
    let result;
    if (options.mode === "live") {
      result = await requestLiveNli(testCase, endpoint, options.timeoutMs ?? EVALUATION_HTTP_TIMEOUT_MS, dependencies.fetch ?? fetch);
      // Task12 owns correlation and settlement of independent server-side observations.
      Object.assign(observations, await dependencies.observeCase?.(testCase));
    } else if (options.mode === "fake" && testCase.models) {
      const fake = createFakeResolver(testCase, context, events);
      try {
        result = await fake.resolve(testCase.message, context, {
          currentTargetId: testCase.currentTargetId, history: testCase.history, reportUpstreamFailure: true
        });
      } finally {
        Object.assign(observations, fake.counts);
        const completed = events.findLast((event) => event.type === "complete");
        Object.assign(observations, { stage: completed?.stage, reason: completed?.reason });
      }
    } else {
      let modelCalls = 0;
      const modelClient = async () => {
        modelCalls += 1;
        if (testCase.model?.behavior === "timeout") throw new Error("fixture model timeout");
        return testCase.model?.response ?? null;
      };
      result = await resolveNliRequest(testCase.message, context, {
        useModel: options.mode === "local" ? false : undefined, modelClient,
        currentTargetId: testCase.currentTargetId, history: testCase.history
      });
      observations.modelCalls = modelCalls;
      if (options.mode === "local") Object.assign(observations, { lfmCalls: 0, qwenCalls: 0 });
    }
    return { result, errors: validateResult(result, expectation, context, observations), observations, events };
  } catch (error) {
    return { result: null, errors: [`request failed: ${error instanceof Error ? error.message || error.constructor.name : String(error)}`], observations, events };
  }
}

export function createFakeResolver(testCase, context, events = []) {
  const config = createGatewayConfig({ NLI_QWEN_ENABLED: testCase.verification === "disabled" ? "false" : "true" });
  let time = 0;
  const counts = { lfmCalls: 0, qwenCalls: 0 };
  const client = (stage) => async () => {
    const spec = testCase.models[stage];
    // A busy/aborted adapter represents a pre-dispatch failure, not an inference.
    const dispatchCount = ["busy", "aborted"].includes(spec.failure) ? 0 : 1;
    counts[`${stage}Calls`] += dispatchCount;
    time += spec.elapsedMs ?? 0;
    const outcome = spec.failure ? modelFailure(spec.failure, {}) : inspectModelCompletion(spec.completion ?? {
      model: `fixture-${stage}`, choices: [{ finish_reason: "stop", message: {
        role: "assistant", content: JSON.stringify(spec.response)
      } }]
    }, stage);
    return { ...outcome, metadata: { ...outcome.metadata, endpoint: stage, dispatchCount } };
  };
  const dependencies = {
    context, now: () => time, observer: (event) => events.push(event),
    lfmClient: client("lfm"), qwenClient: client("qwen"),
    verifier: { verify: async () => ({ ok: testCase.verification === "verified", returnedModelId: "fixture-qwen" }), invalidate() {} }
  };
  const resolve = createRequestResolver(config, dependencies);
  return { resolve, counts, events, config, dependencies };
}

export async function requestLiveNli(testCase, endpoint, timeoutMs = EVALUATION_HTTP_TIMEOUT_MS, fetchImpl = fetch) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(endpoint, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ message: testCase.message, currentTargetId: testCase.currentTargetId, history: testCase.history }),
      signal: controller.signal
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally { clearTimeout(timeout); }
}
