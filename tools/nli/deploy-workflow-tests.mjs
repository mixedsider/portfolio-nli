import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createWorkflowFixture } from "./deploy-workflow-fixture.mjs";
import { extractWorkflowLifecycle, extractWorkflowRemote } from "./deploy-workflow-extract.mjs";

export function execute(command, args, options) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { ...options, timeout: 30000, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

export function assertRedacted(result) {
  assert.doesNotMatch(result.stdout + result.stderr, /fake-private-sentinel|fake-ssh-sentinel|private-old-receipt/);
  assert.equal(result.signal, null);
}

export function registerWorkflowLifecycleTests(workflow, root) {
  const lifecycle = extractWorkflowLifecycle(workflow);
  const cleanup = extractWorkflowRemote(workflow, "Remove private host lifecycle snapshot");
  test("PM2 snapshot excludes internal metadata but still rejects registered environment drift",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createWorkflowFixture(root, false, false);
      const helper = join(f.directory, "lifecycle.mjs");
      const snapshotFile = join(f.directory, "snapshot.json");
      const invoke = async () => execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
        env: { ...f.ssh, GATEWAY_PID: String((await f.manager.state()).pid) } });
      try {
        await writeFile(helper, lifecycle);
        const metadataState = await f.manager.state();
        metadataState.pm2_env.env.h1 = {};
        await f.manager.setState(metadataState);
        const metadataResult = await invoke();
        assertRedacted(metadataResult);
        assert.equal(metadataResult.code, 0, "PM2 internal metadata must not block a valid snapshot");
        const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
        assert.equal(Object.hasOwn(snapshot.env, "h1"), false);

        await rm(snapshotFile);
        const driftState = await f.manager.state();
        driftState.pm2_env.env.GIT_COMMIT_SHA = "registered-only";
        await f.manager.setState(driftState);
        const driftResult = await invoke();
        assertRedacted(driftResult);
        assert.equal(driftResult.code, 1, "registered user environment drift must still fail closed");
        await assert.rejects(access(snapshotFile), { code: "ENOENT" });
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
        await assert.rejects(access(f.app), { code: "ENOENT" });
      }
    });
  const scenarios = ["success", "before-restart", "restart-fail", "qwen-fail", "lfm-fail", "eval-fail", "eval-false", "receipt-drift"];
  for (const bootstrap of [false, true]) for (const hadReceipt of [false, true]) for (const scenario of scenarios) {
    test(`PM2 environment lifecycle: bootstrap=${bootstrap} receipt=${hadReceipt} ${scenario}`,
      { skip: process.platform !== "linux", timeout: 60000 }, async () => {
        const f = await createWorkflowFixture(root, bootstrap, hadReceipt);
        const helper = join(f.directory, "lifecycle.mjs");
        const target = "b".repeat(40);
        async function invoke(action, revision = target, expected = 0) {
          const result = await execute(process.execPath, [helper, action, revision], { cwd: f.app,
            env: { ...f.ssh, GATEWAY_PID: String((await f.manager.state())?.pid ?? "") } });
          assertRedacted(result);
          assert.equal(result.code, expected, `${scenario}/${action}`);
        }
        try {
          await writeFile(helper, lifecycle);
          for (const key of ["NLI_ALLOWED_ORIGINS", "LM_STUDIO_MODEL", "LFM_MODEL", "NLI_QWEN_VERIFICATION_FILE"]) {
            assert.equal(new Set([f.service[key], f.dotenv[key], f.ssh[key]]).size, 3, key);
          }
          await invoke("snapshot");
          const snapshotFile = join(f.directory, "snapshot.json");
          const snapshot = JSON.parse(await readFile(snapshotFile, "utf8"));
          const original = bootstrap ? f.ssh : f.service;
          for (const key of Object.keys(f.service)) assert.equal(snapshot.env[key], original[key], key);
          assert.equal(snapshot.receipt, f.receipt);
          assert.equal(snapshot.env.DOTENV_ONLY, "dotenv-value");
          if (!bootstrap) assert.equal(snapshot.env.SSH_ONLY, undefined);
          assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
          assert.equal((await stat(snapshotFile)).mode & 0o777, 0o600);
          await f.scenario(scenario);
          if (scenario !== "before-restart") {
            await invoke("restart", target, scenario === "restart-fail" ? 1 : 0);
            if (scenario !== "restart-fail") {
              assert.deepEqual((await f.manager.state()).pm2_env.env, { ...snapshot.env, GIT_COMMIT_SHA: target });
              await invoke("identity");
              if (scenario === "receipt-drift") {
                const state = await f.manager.state();
                state.pm2_env.env.NLI_QWEN_VERIFICATION_FILE = join(f.app, ".nli/wrong.json");
                await f.manager.setState(state);
                await invoke("identity", target, 1);
              } else await invoke("preflight", target, scenario === "success" ? 0 : 1);
            }
          }
          const restart = bootstrap ? "start" : "restart";
          assert.deepEqual(f.manager.calls, scenario === "before-restart" ? [] :
            scenario === "restart-fail" ? [restart] : [restart, "save"]);
          assert.deepEqual(await f.producerCalls(), ["before-restart", "restart-fail", "receipt-drift"].includes(scenario) ? [] :
            scenario === "qwen-fail" ? ["qwen"] : scenario === "lfm-fail" ? ["qwen", "lfm"] : ["qwen", "lfm", "eval"]);
          await f.scenario("success");
          await invoke("restore");
          if (hadReceipt) assert.equal(await readFile(f.receipt, "utf8"), "private-old-receipt");
          else await assert.rejects(access(f.receipt), { code: "ENOENT" });
          assert.equal(await readFile(f.dotenv.NLI_QWEN_VERIFICATION_FILE, "utf8"), "untouched-dotenv-receipt");
          if (!bootstrap) assert.equal(await readFile(f.ssh.NLI_QWEN_VERIFICATION_FILE, "utf8"), "untouched-ssh-receipt");
          await invoke("restart", f.previousRevision);
          assert.deepEqual((await f.manager.state()).pm2_env.env, { ...snapshot.env, GIT_COMMIT_SHA: f.previousRevision });
          await invoke("identity", f.previousRevision);
          const cleaned = await execute("bash", ["-c", cleanup], { cwd: f.app, env: f.ssh });
          assertRedacted(cleaned);
          assert.equal(cleaned.code, 0);
          await assert.rejects(access(snapshotFile), { code: "ENOENT" });
          await assert.rejects(access(join(f.directory, "previous-receipt.json")), { code: "ENOENT" });
        } finally {
          assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
          await assert.rejects(access(f.app), { code: "ENOENT" });
        }
      });
  }
}
