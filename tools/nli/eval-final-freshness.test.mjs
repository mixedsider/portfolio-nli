import test from "node:test";
import assert from "node:assert/strict";
import { loadNliContext } from "../nli-gateway.mjs";
import { createGatewayConfig } from "./config.mjs";
import { evaluateCascade } from "./eval-runner.mjs";

// Trusted offline workload results isolate the real runner's FINAL proof decision.
// None of these vectors is a model qualification report or measured performance.
async function scenario(change = () => {}) {
  const context = await loadNliContext();
  const config = createGatewayConfig({});
  const issuedAt = Date.parse("2026-09-09T00:00:00Z");
  const state = { now: issuedAt + 86400000 - 100, prompt: context.prompt, model: true, metadata: true,
    missing: false, cleanup: true, throws: false, digests: { lfmReport: "a".repeat(64), qwenReport: "b".repeat(64), receipt: "c".repeat(64) } };
  let checks = 0;
  let contextLoads = 0;
  let networkCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = () => { networkCalls++; throw new Error("LAN forbidden in freshness regression"); };
  try {
    const report = await evaluateCascade({}, {
      loadContext: async () => { contextLoads++; return { ...context, prompt: state.prompt }; },
      loadConfig: () => config,
      wallNow: () => state.now,
      verify: async (_options, suppliedConfig, suppliedContext, { wallNow = () => state.now } = {}) => {
        checks++;
        if (state.throws) throw new Error("private upstream detail must not be persisted");
        const ok = wallNow() - issuedAt <= 86400000 && !state.missing && state.metadata && state.model &&
          suppliedContext.prompt === context.prompt && suppliedConfig.model.name === config.model.name;
        return { lfmVerified: ok, qwenVerified: ok, receiptStable: !state.missing,
          validUntil: issuedAt + 86400000,
          runtimeLfmGate: { ok, inferenceCalls: 0 }, runtimeQwenGate: { ok, inferenceCalls: 0 },
          proofDigests: state.missing ? { lfmReport: null, qwenReport: null, receipt: null } : { ...state.digests },
          cleanup: { ok: state.cleanup } };
      },
      fixtureSuite: async () => ({ ok: true, cleanup: { ok: true } }),
      workload: async (_config, _context, cases, options = {}) => {
        if (options.injectLfm) change(state);
        return { ok: true, results: cases.map((item) => ({ fixtureId: item.id, wallMs: 1 })),
          timings: { p50: 1, p95: 1 }, cleanup: { ok: true } };
      },
      qwenBaseline: async (_config, _context, cases) => ({ ok: true,
        results: cases.map((item) => ({ fixtureId: item.id, wallMs: 2 })), timings: { p50: 2, p95: 2 }, cleanup: { ok: true } })
    });
    assert.equal(networkCalls, 0);
    return { report, checks, contextLoads };
  } finally { globalThis.fetch = originalFetch; }
}

test("valid initial verification expires during workloads: final runner readiness must be false", async () => {
  const { report, checks } = await scenario((state) => { state.now += 101; });
  assert.equal(report.verification.lfmVerified, true);
  assert.equal(report.verification.qwenVerified, true);
  assert.equal(report.ready, false, "initial true flags cannot authorize expired final proof");
  assert.equal(report.gates.lfmVerified, false);
  assert.equal(report.gates.qwenVerified, false);
  assert.equal(report.gates.finalProofFreshness, false);
  for (const key of ["liveSuccess", "adversarial", "ordinary", "qwenBaseline", "faster", "concurrency1", "concurrency4",
    "difficultWorkload", "injectedEscalation", "cleanup"]) assert.equal(report.gates[key], true, key);
  assert.equal(checks, 2, "one initial and one final metadata-only verification");
});

test("unchanged current proof passes while replacements, disappearance, model/prompt and metadata changes fail", async () => {
  const unchanged = await scenario();
  assert.equal(unchanged.report.ready, true);
  assert.equal(unchanged.checks, 2);
  assert.equal(unchanged.contextLoads, 2);
  for (const change of [
    (state) => { state.digests.lfmReport = "d".repeat(64); },
    (state) => { state.digests.qwenReport = "d".repeat(64); },
    (state) => { state.digests.receipt = "d".repeat(64); },
    (state) => { state.missing = true; },
    (state) => { state.model = false; },
    (state) => { state.prompt += " changed"; },
    (state) => { state.metadata = false; },
    (state) => { state.cleanup = false; },
    (state) => { state.throws = true; }
  ]) {
    const { report, checks } = await scenario(change);
    assert.equal(report.ready, false, change.toString());
    assert.equal(checks, 2);
    assert.ok(!JSON.stringify(report).includes("private upstream detail"));
  }
});
