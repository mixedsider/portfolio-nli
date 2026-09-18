import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, symlink, chmod } from "node:fs/promises";
import { join } from "node:path";
import { evalFixture } from "./eval-fixture.mjs";
import { verificationEvidence } from "./eval-verification.mjs";
import { createEvaluationInputs } from "./eval-proof-inputs.mjs";
import { validLfmReport } from "./eval-proof-validation.mjs";
import { runBoundVerification, producerMatchesRuntime } from "./eval-bound-probe.mjs";
import { readProofFile } from "./eval-proof-files.mjs";
import { prepareProbeCases } from "./probe-request.mjs";
import { main } from "../nli-model-probe.mjs";
import { runChild } from "./eval-suites.mjs";

test("original forged reports are rejected even alongside a genuinely verified loopback receipt", async () => {
  const f = await evalFixture();
  try {
    const lfmInputs = await createEvaluationInputs("lfm", f.config.lfm, f.context);
    const lfmPath = join(f.directory, "forged-lfm.json");
    const qwenPath = join(f.directory, "forged-qwen.json");
    await writeFile(lfmPath, JSON.stringify({ verified: true, ok: true, exitStatus: 0, endpoint: "lfm", mode: "verify",
      checkedAt: new Date().toISOString(), selectedMode: f.config.lfm.outputMode, caseCount: 6,
      promptSha256: lfmInputs.binding.promptSha256, schemaSha256: "stale-schema", settings: { ...f.config.lfm, maxResponseBytes: 1 },
      results: Array.from({ length: 6 }, () => ({ caseId: "duplicate-not-current-case", outputMode: f.config.lfm.outputMode,
        ok: true, groundedSha256: "stale-grounded-case" })) }), { mode: 0o600 });
    await writeFile(qwenPath, JSON.stringify({ verified: true, ok: true, exitStatus: 0, receiptWritten: true,
      endpoint: "wrong-endpoint", mode: "baseline", checkedAt: "2000-01-01T00:00:00Z",
      binding: { promptSha256: "stale-prompt", settingsSha256: "stale-settings", matrixSha256: "stale-cases" },
      results: Array.from({ length: 18 }, () => ({ ok: true })) }), { mode: 0o600 });
    const result = await verificationEvidence({ "lfm-verification": lfmPath, "qwen-verification": qwenPath }, f.config, f.context);
    assert.equal(result.lfmVerified, false);
    assert.equal(result.qwenVerified, false);
    assert.equal(result.runtimeQwenGate.ok, true, "actual loopback receipt stays independently strict and valid");
    assert.equal(result.runtimeQwenGate.metadataCalls, 19);
    assert.equal(result.runtimeQwenGate.inferenceCalls, 0);
    assert.equal(result.receiptStable, true);
    const link = join(f.directory, "symlink.json");
    await symlink(lfmPath, link);
    assert.equal(await readProofFile(link), null);
    await chmod(lfmPath, 0o622);
    assert.equal(await readProofFile(lfmPath), null);
  } finally { await f.close(); }
});

test("fresh actual LFM loopback proof qualifies only with dispatched current prepared payload binding", async () => {
  const f = await evalFixture();
  try {
    f.state.runtime = false;
    const inputs = await createEvaluationInputs("lfm", f.config.lfm, f.context);
    const output = join(f.directory, "actual-lfm.json");
    const child = await runChild(["tools/nli/eval-bound-probe.mjs", "--endpoint", "lfm", "--mode", "verify", "--output", output],
      { env: { ...process.env, ...f.env } });
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(child.code, 0, JSON.stringify(report.blockers));
    assert.equal(validLfmReport(report, inputs, Date.now()), true);
    assert.equal(report.results.length, 12);
    assert.ok(report.results.every((row) => row.kind === "accepted" && row.validation.ok));
    const current = await verificationEvidence({ "lfm-verification": output }, f.config, f.context);
    assert.equal(current.lfmVerified, true);
    assert.equal(current.runtimeLfmGate.metadataCalls, 1);
    assert.equal(current.runtimeLfmGate.inferenceCalls, 0);
    const mismatched = join(f.directory, "stale-identity.json");
    await writeFile(mismatched, JSON.stringify({ ...report, metadata: { ...report.metadata, identitySha256: "0".repeat(64) } }), { mode: 0o600 });
    const staleIdentity = await verificationEvidence({ "lfm-verification": mismatched }, f.config, f.context);
    assert.equal(staleIdentity.lfmVerified, false);
    assert.equal(staleIdentity.runtimeLfmGate.reason, "metadata_identity_mismatch");
    assert.equal(staleIdentity.cleanup.active, 0);
    const stale = await createEvaluationInputs("lfm", f.config.lfm, { ...f.context, prompt: `${f.context.prompt}\nchanged` });
    assert.equal(validLfmReport(report, stale, Date.now()), false);
    for (const key of ["timeoutMs", "maxTokens", "maxResponseBytes", "maxConcurrentRequests"]) {
      const changed = await createEvaluationInputs("lfm", { ...f.config.lfm, [key]: f.config.lfm[key] + 1 }, f.context);
      assert.equal(validLfmReport(report, changed, Date.now()), false, key);
    }
  } finally { await f.close(); }
});

test("bound producer preflights current runtime parity; mismatched payloads cannot dispatch or mint proof", async () => {
  const f = await evalFixture();
  try {
    const inputs = await createEvaluationInputs("lfm", f.config.lfm, f.context);
    const cases = prepareProbeCases(inputs.fixtures, f.context);
    const options = { endpoint: "lfm", mode: "verify", context: f.context, cases, settings: f.config.lfm };
    const malformed = { ...options, cases: cases.map((item) => ({ ...item, grounded: {} })) };
    assert.equal(producerMatchesRuntime(malformed, inputs), false);
    let calls = 0;
    const report = await runBoundVerification(malformed, { runProbe: async () => { calls++; throw new Error("must not run"); } });
    assert.equal(calls, 0);
    assert.equal(report.verified, false);
    assert.deepEqual(report.blockers, ["producer_runtime_payload_mismatch"]);
  } finally { await f.close(); }
});

test("Qwen bound CLI either proves exact current payloads or fails before inference on producer mismatch", async () => {
  const f = await evalFixture();
  try {
    f.state.runtime = false;
    const inputs = await createEvaluationInputs("qwen", f.config.model, f.context);
    const options = { endpoint: "qwen", context: f.context };
    const compatible = producerMatchesRuntime(options, inputs);
    const before = f.state.calls.filter((row) => row.path.endsWith("chat/completions")).length;
    const output = join(f.directory, "actual-qwen.json");
    const code = await main(["--endpoint", "qwen", "--mode", "verify", "--output", output,
      "--receipt", f.config.cascade.qwenVerificationFile], {
      run: (request) => runBoundVerification({ ...request, settings: f.config.model })
    });
    const report = JSON.parse(await readFile(output, "utf8"));
    if (!compatible) {
      assert.equal(code, 1);
      assert.deepEqual(report.blockers, ["producer_runtime_payload_mismatch"]);
      assert.equal(f.state.calls.filter((row) => row.path.endsWith("chat/completions")).length, before);
    } else {
      assert.equal(code, 0, JSON.stringify(report.blockers));
      assert.equal(report.results.length, 18);
      assert.equal(f.state.calls.filter((row) => row.path.endsWith("chat/completions")).length - before, 18);
      const verdict = await verificationEvidence({ "qwen-verification": output }, f.config, f.context);
      assert.equal(verdict.qwenVerified, true);
      assert.equal(verdict.runtimeQwenGate.ok, true);
    }
  } finally { await f.close(); }
});
