import assert from "node:assert/strict";
import { access, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createGatewayConfig as priorConfig } from "./deploy-workflow-legacy-config.mjs";
import { createWorkflowFixture } from "./deploy-workflow-fixture.mjs";
import { execute, assertRedacted } from "./deploy-workflow-tests.mjs";
import { extractWorkflowLifecycle, extractWorkflowRemote } from "./deploy-workflow-extract.mjs";

export function registerFirstUpgradeTests(workflow, root) {
  const lifecycle = extractWorkflowLifecycle(workflow);
  const cleanup = extractWorkflowRemote(workflow, "Remove private host lifecycle snapshot");
  for (const bootstrap of [false, true]) for (const defaultReceipt of [false, true]) for (const hadReceipt of [false, true]) {
    test(`first upgrade from pre-cascade release: bootstrap=${bootstrap} defaultReceipt=${defaultReceipt} receipt=${hadReceipt}`,
      { skip: process.platform !== "linux", timeout: 60000 }, async () => {
        const f = await createWorkflowFixture(root, bootstrap, hadReceipt, { legacyConfig: true, defaultReceipt });
        const helper = join(f.directory, "lifecycle.mjs");
        const target = "b".repeat(40);
        async function invoke(action, revision = target, expected = 0) {
          const result = await execute(process.execPath, [helper, action, revision], { cwd: f.app,
            env: { ...f.ssh, GATEWAY_PID: String((await f.manager.state())?.pid ?? "") } });
          assertRedacted(result);
          assert.equal(result.code, expected, `prior/candidate upgrade ${action}`);
        }
        try {
          const config = priorConfig(f.service);
          assert.equal(Object.hasOwn(config, "cascade"), false);
          assert.equal(Object.hasOwn(config, "lfm"), false);
          assert.equal(config.model.name, "prior-model");
          assert.equal(new Set([f.service.LM_STUDIO_MODEL, f.ssh.LM_STUDIO_MODEL, f.dotenv.LM_STUDIO_MODEL]).size, 3);
          await writeFile(helper, lifecycle);
          await invoke("snapshot");
          assert.deepEqual(f.manager.calls, [], "Old-config checkpoint must not restart a process");
          const snapshot = JSON.parse(await readFile(join(f.directory, "snapshot.json"), "utf8"));
          assert.equal(snapshot.receipt, f.receipt);
          assert.equal(snapshot.hadReceipt, hadReceipt);
          assert.equal(snapshot.env.NLI_ALLOWED_ORIGINS, bootstrap ? f.ssh.NLI_ALLOWED_ORIGINS : f.service.NLI_ALLOWED_ORIGINS);
          assert.equal(snapshot.env.LM_STUDIO_MODEL, bootstrap ? "ssh-model" : "prior-model");
          if (!bootstrap) assert.equal(snapshot.env.SSH_ONLY, undefined);
          if (defaultReceipt) assert.equal(snapshot.env.NLI_QWEN_VERIFICATION_FILE, undefined);
          await f.selectConfig("candidate");
          await invoke("restart");
          assert.deepEqual((await f.manager.state()).pm2_env.env, { ...snapshot.env, GIT_COMMIT_SHA: target });
          await invoke("identity");
          await f.scenario("qwen-fail");
          await invoke("preflight", target, 1);
          assert.deepEqual(await f.producerCalls(), ["qwen"], "Legacy checkpoint cannot waive new proof");
          if (!hadReceipt) await assert.rejects(access(f.receipt), { code: "ENOENT" });
          await f.scenario("success");
          await invoke("preflight");
          assert.deepEqual(await f.producerCalls(), ["qwen", "qwen", "lfm", "eval"]);
          assert.equal(await readFile(f.receipt, "utf8"), "new-private-stub-receipt");
          await invoke("restore");
          await f.selectConfig("prior");
          await invoke("restart", f.previousRevision);
          await invoke("identity", f.previousRevision);
          assert.deepEqual((await f.manager.state()).pm2_env.env, { ...snapshot.env, GIT_COMMIT_SHA: f.previousRevision });
          if (hadReceipt) assert.equal(await readFile(f.receipt, "utf8"), "private-old-receipt");
          else await assert.rejects(access(f.receipt), { code: "ENOENT" });
          const before = await f.producerCalls();
          await invoke("preflight", f.previousRevision, 1);
          assert.deepEqual(await f.producerCalls(), before, "Old model-only config is not candidate readiness");
          const clean = await execute("bash", ["-c", cleanup], { cwd: f.app, env: f.ssh });
          assertRedacted(clean);
          assert.equal(clean.code, 0);
          await assert.rejects(access(join(f.directory, "snapshot.json")), { code: "ENOENT" });
          await assert.rejects(access(join(f.directory, "previous-receipt.json")), { code: "ENOENT" });
        } finally {
          assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
          await assert.rejects(access(f.app), { code: "ENOENT" });
        }
      });
  }
}
