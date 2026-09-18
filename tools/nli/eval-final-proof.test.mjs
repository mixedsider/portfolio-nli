import test from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { main } from "../nli-model-probe.mjs";
import { evalFixture } from "./eval-fixture.mjs";
import { runBoundVerification } from "./eval-bound-probe.mjs";
import { verificationEvidence } from "./eval-verification.mjs";
import { revalidateFinalProof, finalProofDecision, FINAL_PROOF_REASONS } from "./eval-final-verification.mjs";

test("final checks reread real loopback proof files, receipt, bindings and live metadata without new inference", async () => {
  const f = await evalFixture();
  try {
    f.state.runtime = false;
    const lfmPath = join(f.directory, "lfm-current.json");
    const qwenPath = join(f.directory, "qwen-current.json");
    const receiptPath = f.config.cascade.qwenVerificationFile;
    for (const [endpoint, output, settings] of [["lfm", lfmPath, f.config.lfm], ["qwen", qwenPath, f.config.model]]) {
      const args = ["--endpoint", endpoint, "--mode", "verify", "--output", output];
      if (endpoint === "qwen") args.push("--receipt", receiptPath);
      assert.equal(await main(args, { run: (options) => runBoundVerification({ ...options, settings }) }), 0);
    }
    f.state.runtime = true;
    const paths = [lfmPath, qwenPath, receiptPath];
    const original = await Promise.all(paths.map((path) => readFile(path, "utf8")));
    const earliest = Math.min(...original.map((source) => Date.parse(JSON.parse(source).checkedAt)));
    let clock = earliest + 86400000 - 1;
    let currentContext = f.context;
    let currentConfig = f.config;
    const options = { "lfm-verification": lfmPath, "qwen-verification": qwenPath };
    const wallNow = () => clock;
    const initial = await verificationEvidence(options, f.config, f.context, { wallNow });
    assert.equal(initial.lfmVerified, true);
    assert.equal(initial.qwenVerified, true);
    const generationCount = () => f.state.calls.filter((row) => row.path.endsWith("chat/completions")).length;
    const before = generationCount();
    const dependencies = { wallNow, loadConfig: () => currentConfig, loadContext: async () => currentContext };
    const unchanged = await revalidateFinalProof(initial, options, dependencies);
    assert.equal(unchanged.ok, true);
    assert.equal(unchanged.reason, "unchanged_current_proof");
    assert.equal(unchanged.verification.runtimeQwenGate.metadataCalls, 19);
    assert.equal(unchanged.verification.runtimeLfmGate.metadataCalls, 1);
    assert.equal(generationCount(), before, "final freshness is metadata-only, never another inference proof");
    const cases = [
      ["expired", async () => { clock += 2; }],
      ["lfm report bytes changed", () => writeFile(lfmPath, `${original[0]}\n`)],
      ["qwen report bytes changed", () => writeFile(qwenPath, `${original[1]}\n`)],
      ["receipt bytes changed", () => writeFile(receiptPath, `${original[2]}\n`)],
      ["lfm report disappeared", () => rm(lfmPath)],
      ["qwen report disappeared", () => rm(qwenPath)],
      ["receipt disappeared", () => rm(receiptPath)],
      ["live model identity changed", async () => { f.state.metadataModel = "different-loaded-model"; }],
      ["current prompt changed", async () => { currentContext = { ...f.context, prompt: `${f.context.prompt}\nnew policy text` }; }],
      ["current model setting changed", async () => { currentConfig = { ...f.config, model: { ...f.config.model, name: "different-requested-model" } }; }],
      ["live metadata failed", async () => { f.state.status = 503; }]
    ];
    for (const [name, mutate] of cases) {
      await mutate();
      const final = await revalidateFinalProof(initial, options, dependencies);
      assert.equal(final.ok, false, name);
      assert.ok(final.reasons.length > 0, name);
      assert.ok(final.reasons.every((reason) => FINAL_PROOF_REASONS.includes(reason)), name);
      assert.equal(final.verification.cleanup.ok, true, name);
      assert.equal(final.verification.cleanup.active, 0, name);
      assert.equal(generationCount(), before, name);
      for (let index = 0; index < paths.length; index++) await writeFile(paths[index], original[index], { mode: 0o600 });
      clock = earliest + 86400000 - 1;
      currentContext = f.context;
      currentConfig = f.config;
      f.state.metadataModel = "fixture-qwen";
      f.state.status = 200;
    }
    const restored = await revalidateFinalProof(initial, options, dependencies);
    assert.equal(restored.ok, true);
    assert.equal(generationCount(), before);
    assert.equal(finalProofDecision(initial, restored.verification, earliest + 86400000 + 1).ok, false,
      "even a previously positive metadata result cannot survive expiry at decision time");
  } finally { await f.close(); }
});
