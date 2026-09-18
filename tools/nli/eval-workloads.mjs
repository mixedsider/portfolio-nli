import { createEvalSession } from "./eval-session.mjs";
import { runTestCase } from "./test-runner.mjs";
import { createDetailedModelClient, buildDetailedModelPayload } from "./model-client.mjs";
import { createModelAdmission } from "./model-admission.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { acceptTransportProposal } from "./proposal-acceptance.mjs";
import { expectationFor } from "./test-fixtures.mjs";
import { validateResult } from "./test-expectations.mjs";
import { distribution, observed } from "./eval-report.mjs";
import { EVALUATION_HTTP_TIMEOUT_MS, QWEN_TIMEOUT_MS } from "./timeout-policy.mjs";

const ordinaryMessages = ["CateQuest 요약해줘", "CateQuest N+1 해결 요약해줘", "자기소개해줘",
  "연락처를 알고 싶어.", "P95가 뭐야?", "이 프로젝트에서 비용은 어떻게 줄였어?"];

export function ordinaryCases(cases) {
  return ordinaryMessages.map((message) => {
    const item = cases.find((entry) => entry.message === message);
    if (!item) throw new Error("Missing ordinary fixture");
    return item;
  });
}

export function difficultCase(context) {
  return { id: "comparison", kind: "success", message: "CateQuest와 Bookking의 성능 개선을 비교해줘",
    expect: { intent: "answer_portfolio", sourceGroups: ["project-catequest", "project-bookking"].map((project) =>
      [...context.targetById.keys()].filter((id) => id === project || id.startsWith(`${project}-`))) } };
}

export async function runWorkload(config, context, cases, { repeats = 3, concurrency = 1, injectLfm = false, difficult = false } = {}) {
  const session = await createEvalSession(config, context, cases, { injectLfm });
  const results = [];
  const consumed = new Set();
  let report;
  async function run(item, repeat) {
    const start = performance.now();
    const checked = await runTestCase(item, context, { mode: "live", timeoutMs: EVALUATION_HTTP_TIMEOUT_MS }, `${session.url}/api/nli`);
    await session.settle();
    const row = session.rows().find((entry) => entry.fixtureId === item.id && !consumed.has(entry.requestId));
    if (row) consumed.add(row.requestId);
    const errors = [...checked.errors];
    if (!row || !observed(row)) errors.push("unobserved_request");
    if (checked.result && row) errors.push(...validateResult(checked.result, expectationFor(item, "live"), context, row));
    results.push({ fixtureId: item.id, repeat, wallMs: performance.now() - start, errors, ...row });
  }
  try {
    for (let repeat = 0; repeat < repeats; repeat++) {
      for (let index = 0; index < cases.length; index += concurrency) {
        await Promise.all(cases.slice(index, index + concurrency).map((item) => run(item, repeat)));
      }
    }
    report = { results, concurrency, repeats, expectedCount: cases.length * repeats,
      timings: distribution(results.map((row) => row.wallMs)), maxActive: session.maxActive,
      gateChecks: session.gateChecks, http: session.http, faults: [...session.faults], injection: injectLfm,
      ok: results.length === cases.length * repeats && results.length > 0 && results.every((row) =>
        row.errors.length === 0 && (injectLfm ? row.stage === "qwen" :
          difficult ? ["lfm", "qwen"].includes(row.stage) : row.stage === "lfm") && row.reason === "accepted" &&
        row.lfmCalls === 1 && row.qwenCalls === (row.stage === "qwen" ? 1 : 0)) && session.faults.length === 0 &&
        session.maxActive <= Math.min(4, config.cascade.maxConcurrentRequests) };
  } finally {
    const cleanup = await session.close();
    if (report) report.cleanup = cleanup;
    if (!cleanup.ok) throw new Error("Cleanup failed");
  }
  return report;
}

// Diagnostic only. Never injected into Gateway as an initial/direct-Qwen route.
// Without verification these transport facts cannot authorize or count as accepted Qwen service.
export async function runQwenBaseline(config, context, cases, { repeats = 3, verified = false } = {}) {
  const admission = createModelAdmission(config.cascade.maxConcurrentRequests);
  const client = createDetailedModelClient(config.model, { endpoint: "qwen", admission });
  const results = [];
  for (let repeat = 0; repeat < repeats; repeat++) {
    for (const item of cases) {
      const scoped = { ...context, currentTargetId: item.currentTargetId ?? null, history: item.history ?? [] };
      const prepared = prepareGroundedRequest(item.message, scoped);
      const payload = buildDetailedModelPayload(client.settings, item.message, scoped, prepared.groundedRequest);
      const start = performance.now();
      const budgetMs = Math.min(QWEN_TIMEOUT_MS, config.model.timeoutMs);
      const outcome = await client(item.message, scoped, prepared.groundedRequest, { deadlineAt: start + budgetMs, budgetMs });
      const accepted = acceptTransportProposal(outcome, scoped, prepared, item.message);
      const errors = accepted.accepted ? validateResult(accepted.response, expectationFor(item, "live"), context) : [accepted.reason];
      results.push({ fixtureId: item.id, repeat, wallMs: performance.now() - start, tag: outcome.tag, kind: outcome.kind ?? null,
        accepted: verified && accepted.accepted && errors.length === 0, semanticAccepted: accepted.accepted, errors,
        requestBytes: Buffer.byteLength(JSON.stringify(payload)), messageBytes: payload.messages.map((entry) => Buffer.byteLength(entry.content)),
        metadata: outcome.metadata });
    }
  }
  if (admission.active !== 0) throw new Error("Diagnostic admission leak");
  return { label: "Qwen-only test diagnostic; not production routing", verified, results,
    timings: distribution(results.map((row) => row.wallMs)),
    ok: verified && results.length === cases.length * repeats && results.length > 0 && results.every((row) => row.accepted),
    cleanup: { ok: true, active: admission.active } };
}
