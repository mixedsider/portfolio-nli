import { sha256 } from "./qwen-verification-proof.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

// Explicit offline parser vectors, NOT issued/live proof. Never write these as a production receipt.
const base = (inputs) => ({ version: 1, verificationPolicy: VERIFICATION_POLICY, endpoint: inputs.binding.endpoint, mode: "verify", ok: true, verified: true,
  exitStatus: 0, checkedAt: new Date().toISOString(), status: "live-verified", blockers: [], selectedMode: inputs.settings.outputMode,
  command: ["node", "tools/nli-model-probe.mjs", "--endpoint", inputs.binding.endpoint, "--mode", "verify", "--output", "offline-vector.json"],
  cleanup: { isolatedServers: 0, receiptWritten: inputs.binding.endpoint === "qwen", pendingRequests: 0 }, evaluationBinding: inputs.binding });

export function lfmReportFixture(inputs) {
  return { ...base(inputs), baseUrl: inputs.settings.baseUrl, requestedModel: inputs.settings.name, settings: structuredClone(inputs.settings),
    promptSha256: inputs.binding.promptSha256, schemaSha256: inputs.schemaSha256, promptBytes: inputs.promptBytes,
    schemaBytes: inputs.schemaLength, caseCount: inputs.fixtures.length, recommendation: inputs.settings.outputMode, limitations: ["OFFLINE PARSER VECTOR"],
    metadata: { ok: true, status: 200, bytes: 1000, elapsedMs: 10, identitySha256: sha256("offline-vector"), models: [
      { id: inputs.settings.name, state: "loaded", quantization: "Q4_0", loadedContextLength: 8192, maxContextLength: 131072 }] },
    results: inputs.matrix.map((row) => ({ caseId: row.item.id, outputMode: row.outputMode, ok: true, kind: "accepted",
      status: 200, bytes: 1000, elapsedMs: 10, requestBytes: row.requestBytes, groundedSha256: row.groundedSha256,
      returnedModel: inputs.settings.name, finishReason: "stop", visibleBytes: 100, choiceCount: 1, validation: { ok: true },
      ...(row.item.expected.intent === "answer_portfolio" ? { visibleAnswer: "OFFLINE PARSER VECTOR, NOT AN ACTUAL ANSWER" } : {}),
      reasoning: { present: false, bytes: 0, accounting: "unavailable" }, usage: { prompt_tokens: null, completion_tokens: null, total_tokens: null } })) };
}

export function qwenReportFixture(inputs) {
  const report = { ...base(inputs), receiptWritten: true, binding: inputs.runtimeBinding, reasoningAccounting: "unavailable",
    metadataCalls: 38, inferenceCalls: 18, proof: { returnedModelId: inputs.settings.name, modelIdentitySha256: sha256("offline-model"),
      buildInfoSha256: sha256("offline-build"), chatTemplateSha256: sha256("offline-template"), templates: inputs.matrix.map(() =>
        ({ emptyClosedThink: true, renderedSha256: sha256("offline-render"), suffixSha256: sha256("offline-suffix") })) },
    results: inputs.matrix.map(({ item, repeat }) => ({ caseId: item.id, repeat, ok: true, returnedModelId: inputs.settings.name,
      finishReason: "stop", reasoningPresent: false, reasoningBytes: 0, reasoningAccounting: "unavailable" })) };
  report.command.push("--receipt", "offline-vector-receipt.json");
  return { report, receipt: { version: 1, ...inputs.runtimeBinding, returnedModelId: inputs.settings.name, checkedAt: report.checkedAt,
    probeCount: 18, results: structuredClone(report.results), proof: structuredClone(report.proof), reasoningAccounting: report.reasoningAccounting } };
}
