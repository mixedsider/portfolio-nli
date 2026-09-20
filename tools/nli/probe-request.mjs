import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { LFM_TIMEOUT_MS, QWEN_TIMEOUT_MS } from "./timeout-policy.mjs";

export const PROBE_ENDPOINTS = Object.freeze({
  lfm: Object.freeze({ baseUrl: "http://192.168.0.106:1234/v1", name: "lfm2.5-2.6b", timeoutMs: LFM_TIMEOUT_MS, maxTokens: 512, maxResponseBytes: 65536 }),
  qwen: Object.freeze({ baseUrl: "http://192.168.0.57:1234/v1", name: "Qwen3.8-27B-UD-Q4_K_M", timeoutMs: QWEN_TIMEOUT_MS, maxTokens: 768, maxResponseBytes: 65536 })
});

export function prepareProbeCases(fixtures, context) {
  if (!Array.isArray(fixtures) || fixtures.length !== 6 || new Set(fixtures.map((item) => item.id)).size !== 6) {
    throw new Error("Probe requires the six distinct representative cases");
  }
  const registered = new Set(context.routes.targets.map((target) => target.id));
  return fixtures.map((item) => {
    if (!item.message?.trim() || !item.expected?.intent || !Array.isArray(item.sourceIds)) throw new Error("Invalid probe case");
    for (const id of item.sourceIds) {
      if (!registered.has(id)) throw new Error(`Unregistered probe source: ${id}`);
    }
    const prepared = prepareGroundedRequest(item.message, {
      ...context, currentTargetId: item.currentTargetId, history: item.history
    });
    // Source expectations stay fixture metadata, never a separate retrieval pool.
    const grounded = Object.freeze({ untrustedData: true,
      currentTargetId: prepared.groundedRequest.currentTargetId,
      conversation: prepared.groundedRequest.history,
      candidateSources: prepared.candidateSources,
      targets: prepared.groundedRequest.targets, terms: prepared.groundedRequest.terms });
    return { ...item, prepared, grounded, candidateSources: grounded.candidateSources };
  });
}

export function buildProbePayload(item, context, schema, settings, outputMode) {
  if (!["json_schema", "plain"].includes(outputMode)) throw new Error("Invalid output mode");
  const payload = {
    model: settings.name, temperature: 0, max_tokens: settings.maxTokens,
    reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false },
    messages: [
      { role: "system", content: context.prompt },
      { role: "system", content: JSON.stringify(item.grounded) },
      { role: "user", content: item.message }
    ]
  };
  if (outputMode === "json_schema") payload.response_format = {
    type: "json_schema", json_schema: { name: "portfolio_nli_model_decision", strict: true, schema }
  };
  return payload;
}
