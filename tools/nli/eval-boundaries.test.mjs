import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureCommand } from "./eval-command.mjs";
import { runChild } from "./eval-suites.mjs";
import { evalFixture } from "./eval-fixture.mjs";
import { createEvalSession } from "./eval-session.mjs";
import { requestLiveNli } from "./test-runner.mjs";
import { verificationEvidence } from "./eval-verification.mjs";

test("real child exit failure, empty output and killed timeout remain failures with no children left", async () => {
  const directory = await mkdtemp(join(tmpdir(), "eval-command-"));
  try {
    const output = join(directory, "command.json");
    assert.equal(await captureCommand(output, ["-e", "process.exitCode=7"]), 7);
    const report = JSON.parse(await readFile(output, "utf8"));
    assert.equal(report.code, 7);
    assert.equal(report.stdout, "");
    await assert.rejects(captureCommand(output, ["-e", "process.exitCode=0"]));
    const killed = await runChild(["-e", "setInterval(()=>{},1000)"], { timeout: 100 });
    assert.notEqual(killed.code, 0);
    assert.equal(killed.signal, "SIGKILL");
    assert.equal(killed.killed, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("missing proof never passes and disconnect/early cleanup settles actual transports", async () => {
  const f = await evalFixture();
  try {
    const proof = await verificationEvidence({}, f.config, f.context);
    assert.equal(proof.lfmVerified, false);
    assert.equal(proof.qwenVerified, false);
    const item = f.cases.find((entry) => entry.message === "P95가 뭐야?");
    f.state.delayMs = 500;
    const session = await createEvalSession(f.config, f.context, [item]);
    const request = requestLiveNli(item, `${session.url}/api/nli`).catch(() => null);
    const deadline = performance.now() + 2000;
    while (!session.active) {
      assert.ok(performance.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const cleanup = await session.close();
    await request;
    assert.deepEqual(cleanup, { ok: true, listening: false, active: 0, pending: 0, observerRecords: 0 });
  } finally { await f.close(); }
});
