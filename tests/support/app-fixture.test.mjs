import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, mkdir, writeFile, rm, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchAppChild } from "./app-child.mjs";
import { evalFixture } from "../../tools/nli/eval-fixture.mjs";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";

test("CLI and HTTP fake fixtures work with only a clean standard temporary parent", { timeout: 90_000 }, async (t) => {
  // Given a fresh os.tmpdir() directory and a child filesystem denying outside mkdtemp parents.
  const directory = await mkdtemp(join(tmpdir(), "fixture-portability-"));
  try {
    const preload = new URL("./temp-root-guard.mjs", import.meta.url).href;
    const env = { ...process.env, TMPDIR: directory, TEMP: directory, TMP: directory,
      NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${preload}`.trim() };
    // This is an independent test runner, not another worker in the parent's runner.
    delete env.NODE_TEST_CONTEXT;
    const files = ["tools/nli-cascade-eval.test.mjs", "tools/nli/eval-boundaries.test.mjs",
      "tools/nli/model-cascade-loopback.test.mjs", "tools/nli/eval-loopback.test.mjs"];
    const result = await new Promise((resolve) => {
      execFile(process.execPath, ["--test", "--test-reporter=tap", ...files], {
        cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout: 75_000,
        env
      }, (error, stdout, stderr) => resolve({ error, stdout, stderr }));
    });
    // When the actual CLI tests and loopback models run, no pre-created agent path is available.
    assert.equal(result.error, null, `${result.stdout}\n${result.stderr}`);
    assert.doesNotMatch(result.stdout, /^not ok /m);
    assert.match(result.stdout, /^# tests [1-9]\d*$/m);
    assert.match(result.stdout, /^# fail 0$/m);
    assert.match(result.stdout, /^# skipped 0$/m);
    // Then all real fixture directories/receipts have been removed by their owners.
    assert.deepEqual(await readdir(directory), []);
    t.diagnostic(result.stdout.match(/^# (tests|pass|fail|skipped) \d+$/gm).join("; "));
    t.diagnostic("Owned CLI/eval/loopback child suites passed; controlled standard temp parent empty.");
  } finally {
    await rm(directory, { recursive: true, force: true });
    t.diagnostic("Removed only this test's fixture-portability-* temporary directory.");
  }
});

test("builds a real 18-completion proof without changing production model budgets", async () => {
  // Given the existing HTTP-backed evaluator fixture.
  const fixture = await evalFixture();
  try {
    // When startup performs the actual verifier protocol.
    const completions = fixture.state.calls.filter((call) => !call.runtime && call.path === "/v1/chat/completions");
    // Then evidence is real HTTP traffic and default budgets/caps remain intact.
    assert.equal(completions.length, 18);
    assert.ok(completions.every((call) => call.endpoint === "qwen"));
    assert.equal(fixture.proof.verified, true);
    assert.equal(fixture.config.lfm.timeoutMs, 6500);
    assert.equal(fixture.config.model.timeoutMs, 16000);
    for (const settings of [fixture.config.lfm, fixture.config.model]) {
      assert.equal(settings.maxConcurrentRequests, 4);
      assert.equal(settings.maxResponseBytes, 65_536);
    }
    assert.equal(fixture.config.cascade.timeoutMs, 23_500);
    assert.equal(fixture.config.rateLimitMax, 30);
  } finally { await fixture.close(); }
});

test("rejects an unknown scenario before starting resources", async () => {
  // Given a caller with an unsupported scenario.
  const { startTestApp } = await import("./app-process.mjs");
  // When starting it, then fail explicitly.
  await assert.rejects(startTestApp({ scenario: "unknown" }), /scenario/);
});

test("rejects startup failure and reaps a child that never becomes ready", async () => {
  // Given an isolated child script directory.
  const directory = await mkdtemp(join(tmpdir(), "app-startup-test-"));
  try {
    const entry = join(directory, "stuck.mjs");
    await writeFile(entry, "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);");
    // When entry is missing or readiness never arrives, then startup is bounded.
    await assert.rejects(launchAppChild(join(directory, "missing.mjs")), /before readiness/);
    await assert.rejects(launchAppChild(entry, { startupMs: 200, exitMs: 100 }), /startup timed out/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("rejects malformed readiness and forces exit when SIGTERM is ignored", async () => {
  // Given a child with a deliberately hostile shutdown implementation.
  const directory = await mkdtemp(join(tmpdir(), "app-kill-test-"));
  try {
    const entry = join(directory, "child.mjs");
    await writeFile(entry, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);
      console.log(JSON.stringify({type:'test-app-ready',staticUrl:'http://127.0.0.1:1',
      gatewayUrl:'http://127.0.0.1:2',controlUrl:'http://127.0.0.1:3'}));`);
    const app = await launchAppChild(entry, { exitMs: 100 });
    // When closing, then escalation to SIGKILL actually reaps it.
    await app.close();
    assert.equal((await app.exit).signal, "SIGKILL");
    await writeFile(entry, "console.log(JSON.stringify({type:'test-app-ready',staticUrl:'https://example.org'}));");
    await assert.rejects(launchAppChild(entry), /readiness URL/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("isolates instances and removes receipts after an unexpected child kill", async () => {
  // Given a private temp root so cleanup assertions cannot race other suites.
  const directory = await mkdtemp(join(tmpdir(), "app-cleanup-test-"));
  const previous = process.env.TMPDIR;
  const apps = [];
  try {
    process.env.TMPDIR = directory;
    const { startTestApp } = await import("./app-process.mjs");
    apps.push(await startTestApp(), await startTestApp());
    assert.notEqual(apps[0].gatewayUrl, apps[1].gatewayUrl);
    assert.notEqual(apps[0].staticUrl, apps[1].staticUrl);
    assert.equal((await readdir(directory)).length, 2);
    const health = await (await fetch(`${apps[0].gatewayUrl}/api/nli/health`)).json();
    // When the child dies outside the graceful path, then parent close still owns cleanup.
    process.kill(health.processId, "SIGKILL");
    await Promise.all(apps.map((app) => app.close()));
    assert.deepEqual(await readdir(directory), []);
  } finally {
    if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
    await Promise.all(apps.map((app) => app.close()));
    await rm(directory, { recursive: true, force: true });
  }
});

test("publishes ready URLs and zero runtime counts when a real child starts", async () => {
  // Given the default application fixture.
  const { startTestApp } = await import("./app-process.mjs");
  const app = await startTestApp();
  try {
    // When readiness resolves, both production servers are reachable.
    const health = await (await fetch(`${app.gatewayUrl}/api/nli/health`)).json();
    const page = await fetch(app.staticUrl);
    // Then the child is distinct and proof calls are excluded.
    assert.notEqual(health.processId, process.pid);
    assert.equal(health.ok, true);
    assert.equal(page.status, 200);
    assert.deepEqual(await app.stats(), { lfm: 0, qwen: 0 });
  } finally { await app.close(); }
  await app.close();
  await assert.rejects(fetch(`${app.gatewayUrl}/api/nli/health`));
  await assert.rejects(fetch(app.staticUrl));
});

test("cleans the parent temporary root when the application child fails at startup", async () => {
  // Given an invalid Node CLI option, without replacing any inherited egress preload.
  const directory = await mkdtemp(join(tmpdir(), "app-failed-start-"));
  const previous = { TMPDIR: process.env.TMPDIR, NODE_OPTIONS: process.env.NODE_OPTIONS };
  try {
    process.env.TMPDIR = directory;
    process.env.NODE_OPTIONS = `${previous.NODE_OPTIONS || ""} --fixture-invalid-option`;
    const { startTestApp } = await import("./app-process.mjs");
    // When Node rejects startup, then the parent still removes its resource directory.
    await assert.rejects(startTestApp(), /before readiness/);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await rm(directory, { recursive: true, force: true });
  }
});

test("closes the application and removes receipts when its owning parent receives SIGTERM", async () => {
  // Given an intermediate owner process with a private fixture temp root.
  const directory = await mkdtemp(join(tmpdir(), "app-owner-signal-"));
  const resources = join(directory, "resources");
  await mkdir(resources);
  let owner;
  try {
    const entry = join(directory, "owner.mjs");
    await writeFile(entry, `import { startTestApp } from ${JSON.stringify(new URL("./app-process.mjs", import.meta.url).href)};
      const app = await startTestApp(); await startTestApp();
      console.log(JSON.stringify({type:'test-app-ready',staticUrl:app.staticUrl,
        gatewayUrl:app.gatewayUrl,controlUrl:app.staticUrl}));`);
    owner = await launchAppChild(entry, { env: { ...process.env, TMPDIR: resources } });
    assert.equal((await readdir(resources)).length, 2);
    // When the owner receives its normal termination signal.
    await owner.close();
    // Then its child and parent-owned receipt directory do not outlive it.
    assert.deepEqual(await readdir(resources), []);
    await assert.rejects(fetch(`${owner.gatewayUrl}/api/nli/health`));
  } finally { await owner?.close(); await rm(directory, { recursive: true, force: true }); }
});
