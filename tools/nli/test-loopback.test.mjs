import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { createNliServer, loadNliContext } from "../nli-gateway.mjs";
import { loadTestCases } from "./test-fixtures.mjs";
import { createFakeResolver } from "./test-runner.mjs";
import { createStageObserver } from "./test-observer.mjs";

test("real CLI live mode evaluates all 26 successes against loopback cascade only", async () => {
  const context = await loadNliContext();
  const cases = (await loadTestCases("nli/live-test-cases.json")).filter((item) => item.kind === "success");
  const adapters = new Map(cases.map((item) => [item.message, createFakeResolver(item, context)]));
  const observer = createStageObserver();
  const first = adapters.values().next().value;
  const server = await createNliServer({ config: first.config, context, observer: observer.observer,
    lfmClient: (...args) => adapters.get(args[0]).dependencies.lfmClient(...args),
    qwenClient: (...args) => adapters.get(args[0]).dependencies.qwenClient(...args),
    verifier: first.dependencies.verifier
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const { stdout, stderr } = await promisify(execFile)(process.execPath, ["tools/nli-test.mjs", "--live",
      "--base-url", `http://127.0.0.1:${server.address().port}`, "--cases", "nli/live-test-cases.json",
      "--kind", "success", "--min-pass-rate", "1"], { timeout: 30000 });
    assert.equal(stderr, "");
    assert.match(stdout, /26\/26 passed \(100.0%\)/);
    const snapshots = observer.requestIds().map(observer.snapshot);
    assert.equal(snapshots.length, 26);
    const actual = [...adapters.values()].reduce((sum, adapter) => sum + adapter.counts.lfmCalls, 0);
    assert.equal(snapshots.reduce((sum, observation) => sum + observation.lfmCalls, 0), actual);
    assert.ok(actual > 0);
    assert.ok(snapshots.every((item) => ["lfm", "fast_path"].includes(item.stage) && item.qwenCalls === 0));
  } finally {
    await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    assert.equal(server.listening, false);
    observer.clear();
    assert.deepEqual(observer.requestIds(), []);
  }
});
