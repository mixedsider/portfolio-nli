import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, chmod, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { createSystemdWorkflowFixture, createWorkflowFixture } from "./deploy-workflow-fixture.mjs";
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
  assert.doesNotMatch(result.stdout + result.stderr,
    /fake-private-sentinel|fake-ssh-sentinel|private-old-receipt|private-systemd-old-receipt|candidate-systemd-receipt/);
  assert.equal(result.signal, null);
}

function systemdLifecycle(source, fixture) {
  return source.replaceAll("/proc/", `${fixture.procRoot}/`)
    .replaceAll("/run/user/", `${fixture.runtimeRoot}/`);
}

function expectedManagerEnv(fixture, scope) {
  const env = { PATH: fixture.managerPath, LANG: "C", LC_ALL: "C" };
  if (scope === "user") {
    env.XDG_RUNTIME_DIR = fixture.runtimeDirectory;
    env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${fixture.runtimeDirectory}/bus`;
  }
  return env;
}

export function registerWorkflowLifecycleTests(workflow, root) {
  const lifecycle = extractWorkflowLifecycle(workflow);
  const cleanup = extractWorkflowRemote(workflow, "Remove private host lifecycle snapshot");
  for (const scope of ["system", "user"]) for (const hadReceipt of [false, true]) {
    test(`PM2-empty listener preserves its verified ${scope} systemd unit with receipt=${hadReceipt}`,
      { skip: process.platform !== "linux" }, async () => {
        const f = await createSystemdWorkflowFixture(root, scope, { hadReceipt });
        const helper = join(f.directory, "lifecycle.mjs");
        const target = "b".repeat(40);
        const invoke = async (action, revision = target) => {
          const state = await f.state();
          const result = await execute(process.execPath, [helper, action, revision], { cwd: f.app,
            env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
              PATH: `${f.app}:${f.ssh.PATH}`, SYSTEMCTL_BIN: f.systemctl } });
          assertRedacted(result);
          return result;
        };
        try {
          await writeFile(helper, systemdLifecycle(lifecycle, f));
          const snapshotResult = await invoke("snapshot");
          assert.equal(snapshotResult.code, 0, snapshotResult.stderr);
          const snapshot = JSON.parse(await readFile(join(f.directory, "snapshot.json"), "utf8"));
          const expectedManager = { type: "systemd", scope, unit: f.unit,
            controlGroup: (await f.state()).controlGroup, bin: f.systemctl };
          if (scope === "user") Object.assign(expectedManager, { uid: f.uid, runtimeDir: f.runtimeDirectory,
            busAddress: `unix:path=${f.runtimeDirectory}/bus` });
          assert.deepEqual(snapshot.manager, expectedManager);
          assert.equal(snapshot.name, undefined, "systemd ownership must not be inferred from PROCESS_NAME");
          assert.equal(snapshot.receipt, f.receipt);
          assert.equal(snapshot.rawEnv.NLI_DOTENV_ONLY, undefined);
          assert.equal(snapshot.env.NLI_DOTENV_ONLY, f.dotenv.NLI_DOTENV_ONLY);

          const restartResult = await invoke("restart");
          assert.equal(restartResult.code, 0, restartResult.stderr);
          const identityResult = await invoke("identity");
          assert.equal(identityResult.code, 0, identityResult.stderr);
          const preflightResult = await invoke("preflight");
          assert.equal(preflightResult.code, 0, preflightResult.stderr);
          assert.deepEqual(await f.producerCalls(), ["qwen", "lfm", "eval"]);
          assert.equal(await readFile(f.receipt, "utf8"), "new-private-stub-receipt");
          const restoreResult = await invoke("restore", f.previousRevision);
          assert.equal(restoreResult.code, 0, restoreResult.stderr);
          if (hadReceipt) assert.equal(await readFile(f.receipt, "utf8"), f.receiptBytes);
          else await assert.rejects(access(f.receipt), { code: "ENOENT" });
          const rollbackRestartResult = await invoke("restart", f.previousRevision);
          assert.equal(rollbackRestartResult.code, 0, rollbackRestartResult.stderr);
          const rollbackIdentityResult = await invoke("identity", f.previousRevision);
          assert.equal(rollbackIdentityResult.code, 0, rollbackIdentityResult.stderr);
          const calls = await f.systemdCalls();
          assert.deepEqual(calls.filter((call) => call.action === "restart")
            .map(({ action, scope: callScope, unit }) => ({ action, scope: callScope, unit })),
          [{ action: "restart", scope, unit: f.unit }, { action: "restart", scope, unit: f.unit }]);
          for (const call of calls) assert.deepEqual(call.env, expectedManagerEnv(f, call.scope));

          const restarted = await f.state();
          await writeFile(join(f.procRoot, String(restarted.pid), "cgroup"), "0::/system.slice/not-the-captured.service\n");
          const driftResult = await invoke("identity");
          assert.equal(driftResult.code, 1, "new PID must remain in the captured unit control group");
          assert.equal(driftResult.stderr.trim(),
            "Gateway lifecycle/preflight failed; private host checkpoint retained until cleanup.");
        } finally {
          assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
        }
      });
  }
  const rejectedSystemdSnapshots = [
    {
      name: "wrong gateway argv script identity",
      reason: "snapshot_listener_identity",
      mutate: (fixture) => fixture.setProcessArgv([process.execPath, join(fixture.app, "tools/not-nli-gateway.mjs")])
    },
    {
      name: "inactive non-running unit",
      reason: "snapshot_systemd_owner",
      mutate: (fixture) => fixture.setSystemdProperties({ activeState: "inactive", subState: "dead" })
    },
    {
      name: "MainPID mismatch",
      reason: "snapshot_systemd_owner",
      mutate: async (fixture) => {
        const state = await fixture.state();
        await fixture.setSystemdProperties({ mainPid: state.pid + 100 });
      }
    }
  ];
  for (const scenario of rejectedSystemdSnapshots) {
    test(`systemd snapshot rejects ${scenario.name}`,
      { skip: process.platform !== "linux" }, async () => {
        const f = await createSystemdWorkflowFixture(root);
        const helper = join(f.directory, "lifecycle.mjs");
        const snapshotFile = join(f.directory, "snapshot.json");
        try {
          await writeFile(helper, systemdLifecycle(lifecycle, f));
          await scenario.mutate(f);
          const state = await f.state();
          const result = await execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
            env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
              PATH: `${f.app}:${f.ssh.PATH}`, SYSTEMCTL_BIN: f.systemctl } });
          assertRedacted(result);
          assert.equal(result.code, 1);
          assert.equal(result.stdout, "");
          assert.equal(result.stderr.trim(),
            `Gateway lifecycle/preflight failed (reason=${scenario.reason}); private host checkpoint retained until cleanup.`);
          await assert.rejects(access(snapshotFile), { code: "ENOENT" });
        } finally {
          assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
        }
      });
  }
  test("systemd identity rejects a missing captured application environment key after restart",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root);
      const helper = join(f.directory, "lifecycle.mjs");
      const target = "b".repeat(40);
      const invoke = async (action) => {
        const state = await f.state();
        const result = await execute(process.execPath, [helper, action, target], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            PATH: `${f.app}:${f.ssh.PATH}`, SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        return result;
      };
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        assert.equal((await invoke("snapshot")).code, 0);
        assert.equal((await invoke("restart")).code, 0);
        await f.removeProcessEnvKey("NLI_ALLOWED_ORIGINS");
        const result = await invoke("identity");
        assert.equal(result.code, 1, "missing captured application environment must fail identity");
        assert.equal(result.stdout, "");
        assert.equal(result.stderr.trim(),
          "Gateway lifecycle/preflight failed; private host checkpoint retained until cleanup.");
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("systemd lifecycle uses the pinned external systemctl instead of an app-local executable",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root);
      const helper = join(f.directory, "lifecycle.mjs");
      const marker = join(f.app, "app-local-systemctl-used");
      const appLocalSystemctl = join(f.app, "systemctl");
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        await writeFile(appLocalSystemctl, `#!/usr/bin/env node\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "used"); process.exit(12);\n`);
        await chmod(appLocalSystemctl, 0o700);
        const state = await f.state();
        const result = await execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            PATH: `${f.app}:${f.ssh.PATH}`, SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        assert.equal(result.code, 0, result.stderr);
        await assert.rejects(access(marker), { code: "ENOENT" });
        const snapshot = JSON.parse(await readFile(join(f.directory, "snapshot.json"), "utf8"));
        assert.equal(snapshot.manager.bin, f.systemctl);
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("systemd snapshot rejects an explicitly selected systemctl inside APP_DIR",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root);
      const helper = join(f.directory, "lifecycle.mjs");
      const snapshotFile = join(f.directory, "snapshot.json");
      const appLocalSystemctl = join(f.app, "systemctl");
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        await writeFile(appLocalSystemctl, "#!/usr/bin/env node\nprocess.exit(0);\n");
        await chmod(appLocalSystemctl, 0o700);
        const state = await f.state();
        const result = await execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            PATH: `${f.app}:${f.ssh.PATH}`, SYSTEMCTL_BIN: appLocalSystemctl } });
        assertRedacted(result);
        assert.equal(result.code, 1);
        assert.equal(result.stderr.trim(),
          "Gateway lifecycle/preflight failed (reason=snapshot_systemctl_binary); private host checkpoint retained until cleanup.");
        await assert.rejects(access(snapshotFile), { code: "ENOENT" });
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("user systemd snapshot rejects a listener effective UID mismatch",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root, "user");
      const helper = join(f.directory, "lifecycle.mjs");
      const snapshotFile = join(f.directory, "snapshot.json");
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        await f.setProcessUid(f.uid + 1);
        const state = await f.state();
        const result = await execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /reason=snapshot_systemd_owner/);
        await assert.rejects(access(snapshotFile), { code: "ENOENT" });
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("user systemd snapshot rejects a group-writable derived runtime directory",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root, "user");
      const helper = join(f.directory, "lifecycle.mjs");
      const snapshotFile = join(f.directory, "snapshot.json");
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        await chmod(f.runtimeDirectory, 0o770);
        const state = await f.state();
        const result = await execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /reason=snapshot_systemd_owner/);
        await assert.rejects(access(snapshotFile), { code: "ENOENT" });
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("systemd snapshot rejects a group-writable pinned executable before manager discovery",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root);
      const helper = join(f.directory, "lifecycle.mjs");
      const snapshotFile = join(f.directory, "snapshot.json");
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        await chmod(f.systemctl, 0o770);
        const state = await f.state();
        const result = await execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        assert.equal(result.code, 1);
        assert.match(result.stderr, /reason=snapshot_systemctl_binary/);
        await assert.rejects(access(snapshotFile), { code: "ENOENT" });
        assert.deepEqual(await f.systemdCalls(), []);
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("systemd restart rejects a newly writable pinned executable parent before invocation",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root);
      const helper = join(f.directory, "lifecycle.mjs");
      const target = "b".repeat(40);
      const invoke = async (action) => {
        const state = await f.state();
        const result = await execute(process.execPath, [helper, action, target], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        return result;
      };
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        assert.equal((await invoke("snapshot")).code, 0);
        const callsBefore = await f.systemdCalls();
        await chmod(f.managerDirectory, 0o770);
        const result = await invoke("restart");
        assert.equal(result.code, 1);
        assert.equal(result.stderr.trim(),
          "Gateway lifecycle/preflight failed; private host checkpoint retained until cleanup.");
        assert.deepEqual(await f.systemdCalls(), callsBefore);
        assert.deepEqual(f.manager.calls, []);
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("user systemd restart rejects a newly unsafe runtime directory before invocation",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root, "user");
      const helper = join(f.directory, "lifecycle.mjs");
      const target = "b".repeat(40);
      const invoke = async (action) => {
        const state = await f.state();
        const result = await execute(process.execPath, [helper, action, target], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        return result;
      };
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        assert.equal((await invoke("snapshot")).code, 0);
        const restartCallsBefore = (await f.systemdCalls()).filter((call) => call.action === "restart").length;
        await chmod(f.runtimeDirectory, 0o770);
        const result = await invoke("restart");
        assert.equal(result.code, 1);
        assert.equal(result.stderr.trim(),
          "Gateway lifecycle/preflight failed; private host checkpoint retained until cleanup.");
        const restartCallsAfter = (await f.systemdCalls()).filter((call) => call.action === "restart").length;
        assert.equal(restartCallsAfter, restartCallsBefore, "unsafe runtime must fail before systemctl restart");
        assert.deepEqual(f.manager.calls, []);
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("snapshot rejects simultaneous PM2 and systemd ownership of the listener",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root, "system", { pm2Registered: true });
      const helper = join(f.directory, "lifecycle.mjs");
      const snapshotFile = join(f.directory, "snapshot.json");
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        const state = await f.state();
        const result = await execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "fixture", GATEWAY_PID: String(state.pid), SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        assert.equal(result.code, 1);
        assert.equal(result.stderr.trim(),
          "Gateway lifecycle/preflight failed (reason=snapshot_manager_conflict); private host checkpoint retained until cleanup.");
        await assert.rejects(access(snapshotFile), { code: "ENOENT" });
        assert.deepEqual(f.manager.calls, []);
        assert.deepEqual((await f.systemdCalls()).filter((call) => call.action === "restart"), []);
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  test("PM2 listener remains PM2-managed when a systemd unit MainPID is not the listener",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root, "system", { pm2Registered: true });
      const helper = join(f.directory, "lifecycle.mjs");
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        const state = await f.state();
        await f.setSystemdProperties({ mainPid: state.pid + 100 });
        const result = await execute(process.execPath, [helper, "snapshot"], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "fixture", GATEWAY_PID: String(state.pid), SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        assert.equal(result.code, 0, result.stderr);
        const snapshot = JSON.parse(await readFile(join(f.directory, "snapshot.json"), "utf8"));
        assert.deepEqual(snapshot.manager, { type: "pm2", bin: f.ssh.PM2_BIN, name: "fixture", existed: true });
        assert.deepEqual(f.manager.calls, []);
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
  for (const drift of ["removed", "added", "changed"]) {
    test(`systemd identity rejects ${drift} dotenv-effective application keys`,
      { skip: process.platform !== "linux" }, async () => {
        const f = await createSystemdWorkflowFixture(root);
        const helper = join(f.directory, "lifecycle.mjs");
        const target = "b".repeat(40);
        const invoke = async (action) => {
          const state = await f.state();
          const result = await execute(process.execPath, [helper, action, target], { cwd: f.app,
            env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
              SYSTEMCTL_BIN: f.systemctl } });
          assertRedacted(result);
          return result;
        };
        try {
          await writeFile(helper, systemdLifecycle(lifecycle, f));
          assert.equal((await invoke("snapshot")).code, 0);
          assert.equal((await invoke("restart")).code, 0);
          const dotenv = { ...f.dotenv };
          if (drift === "removed") delete dotenv.NLI_DOTENV_ONLY;
          if (drift === "added") dotenv.NLI_ADDED_AFTER_SNAPSHOT = "added-value";
          if (drift === "changed") dotenv.NLI_DOTENV_ONLY = "changed-value";
          await writeFile(join(f.app, ".env"), Object.entries(dotenv).map(([key, value]) => `${key}=${value}`).join("\n"));
          const result = await invoke("identity");
          assert.equal(result.code, 1, `${drift} effective application key must fail identity`);
          assert.equal(result.stderr.trim(),
            "Gateway lifecycle/preflight failed; private host checkpoint retained until cleanup.");
        } finally {
          assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
        }
      });
  }
  test("systemd restart failure rolls back receipt and the exact captured manager without fallback",
    { skip: process.platform !== "linux" }, async () => {
      const f = await createSystemdWorkflowFixture(root, "system", { hadReceipt: true });
      const helper = join(f.directory, "lifecycle.mjs");
      const target = "b".repeat(40);
      const invoke = async (action, revision = target) => {
        const state = await f.state();
        const result = await execute(process.execPath, [helper, action, revision], { cwd: f.app,
          env: { ...f.ssh, PROCESS_NAME: "portfolio-nli-gateway", GATEWAY_PID: String(state.pid),
            SYSTEMCTL_BIN: f.systemctl } });
        assertRedacted(result);
        return result;
      };
      try {
        await writeFile(helper, systemdLifecycle(lifecycle, f));
        assert.equal((await invoke("snapshot")).code, 0);
        await writeFile(f.receipt, "candidate-systemd-receipt", { mode: 0o600 });
        await f.scenario("systemd-restart-fail");
        const failedRestart = await invoke("restart");
        assert.equal(failedRestart.code, 1);
        assert.equal(failedRestart.stderr.trim(),
          "Gateway lifecycle/preflight failed; private host checkpoint retained until cleanup.");
        assert.deepEqual(f.manager.calls, []);

        assert.equal((await invoke("restore", f.previousRevision)).code, 0);
        assert.equal(await readFile(f.receipt, "utf8"), f.receiptBytes);
        await f.scenario("success");
        assert.equal((await invoke("restart", f.previousRevision)).code, 0);
        assert.equal((await invoke("identity", f.previousRevision)).code, 0);
        assert.equal((await f.processEnvironment()).GIT_COMMIT_SHA, f.previousRevision);
        assert.deepEqual((await f.systemdCalls()).filter((call) => call.action === "restart")
          .map(({ action, scope: callScope, unit }) => ({ action, scope: callScope, unit })), [
          { action: "restart", scope: "system", unit: f.unit },
          { action: "restart", scope: "system", unit: f.unit }
        ]);
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
      }
    });
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
        const invalidPathState = await f.manager.state();
        invalidPathState.pm2_env.pm_cwd = join(f.app, "fake-private-sentinel");
        await f.manager.setState(invalidPathState);
        const invalidPathResult = await invoke();
        assertRedacted(invalidPathResult);
        assert.equal(invalidPathResult.code, 1, "unexpected PM2 registration errors must fail closed");
        assert.match(invalidPathResult.stderr, /reason=snapshot_pm2_entry/);
        await assert.rejects(access(snapshotFile), { code: "ENOENT" });

        const driftState = await f.manager.state();
        driftState.pm2_env.pm_cwd = f.app;
        driftState.pm2_env.env.GIT_COMMIT_SHA = "registered-only";
        await f.manager.setState(driftState);
        const driftResult = await invoke();
        assertRedacted(driftResult);
        assert.equal(driftResult.code, 1, "registered user environment drift must still fail closed");
        assert.match(driftResult.stderr, /reason=snapshot_environment_drift/);
        await assert.rejects(access(snapshotFile), { code: "ENOENT" });
      } finally {
        assert.deepEqual(await f.close(), { listening: false, activeChildren: 0 });
        await assert.rejects(access(f.app), { code: "ENOENT" });
      }
    });
  const scenarios = ["success", "before-restart", "restart-fail", "qwen-fail", "lfm-fail", "eval-fail", "eval-false", "receipt-drift"];
  for (const bootstrap of [false, true]) for (const hadReceipt of [false, true]) for (const scenario of scenarios) {
    const registration = bootstrap ? "cold PM2 bootstrap accepts daemon banner" : "registered PM2 lifecycle";
    test(`${registration}: receipt=${hadReceipt} ${scenario}`,
      { skip: process.platform !== "linux", timeout: 60000 }, async () => {
        const f = await createWorkflowFixture(root, bootstrap, hadReceipt);
        const helper = join(f.directory, "lifecycle.mjs");
        const target = "b".repeat(40);
        async function invoke(action, revision = target, expected = 0) {
          const result = await execute(process.execPath, [helper, action, revision], { cwd: f.app,
            env: { ...f.ssh, GATEWAY_PID: String((await f.manager.state())?.pid ?? "") } });
          assertRedacted(result);
          assert.equal(result.code, expected, `${scenario}/${action}`);
          if (expected === 1 && action !== "snapshot") {
            assert.equal(result.stderr.trim(),
              "Gateway lifecycle/preflight failed; private host checkpoint retained until cleanup.");
          }
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
