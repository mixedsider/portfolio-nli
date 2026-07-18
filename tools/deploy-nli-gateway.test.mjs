import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { reserveFetchSafePort } from "./test-server.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowPath = resolve(root, ".github/workflows/deploy-nli-gateway.yml");
const workflow = process.env.NLI_DEPLOY_WORKFLOW_TEXT || (await readFile(workflowPath, "utf8"));
const deployScript = extractDeploymentRemoteScript(workflow);

test("deployment trusts the verified Gateway listener when PM2 reports a separate launcher PID", () => {
  assert.match(deployScript, /stop_stale_nli_listeners\(\)/);
  assert.match(deployScript, /wait_for_nli_listener_identity\(\)/);
  assert.match(deployScript, /is_expected_nli_gateway_listener\(\)/);
  assert.match(deployScript, /listener_argv\[1\]/);
  assert.doesNotMatch(deployScript, /wait_for_pm2_nli_listener_identity\(\)/);
  assert.doesNotMatch(deployScript, /gateway_pm2_pid\(\)/);
  assert.doesNotMatch(deployScript, /match\(\$0,/);

  const pm2Block = deployScript.slice(
    deployScript.indexOf("if command -v pm2"),
    deployScript.indexOf("elif command -v systemctl")
  );
  const deleteIndex = pm2Block.indexOf("pm2 delete");
  const cleanupIndex = pm2Block.indexOf("stop_stale_nli_listeners");
  const startIndex = pm2Block.indexOf("pm2 start");
  const listenerCheckIndex = pm2Block.indexOf("wait_for_nli_listener_identity");

  assert.ok(deleteIndex >= 0, "PM2 process must be removed before reconciliation");
  assert.ok(cleanupIndex > deleteIndex, "orphaned listener cleanup must follow PM2 deletion");
  assert.ok(startIndex > cleanupIndex, "PM2 must start only after the old listener releases the port");
  assert.ok(listenerCheckIndex > startIndex, "the actual Gateway listener must be verified after PM2 starts");
});

test("rollback reconciles a stale Gateway listener before restoring the previous revision", () => {
  const rollbackStart = workflow.indexOf("      - name: Roll back failed deployment");
  const rollbackScriptStart = workflow.indexOf("          set -euo pipefail", rollbackStart);
  const rollbackScriptEnd = workflow.indexOf("\n          REMOTE", rollbackScriptStart);

  assert.ok(rollbackStart >= 0, "rollback job must exist");
  assert.ok(rollbackScriptStart >= 0, "rollback remote script must exist");
  assert.ok(rollbackScriptEnd >= 0, "rollback remote script must terminate");

  const rollbackScript = workflow.slice(rollbackScriptStart, rollbackScriptEnd).replace(/^          /gm, "");
  const pm2Start = rollbackScript.indexOf("if command -v pm2");
  const fallbackStart = rollbackScript.indexOf("\nelse\n", pm2Start);
  assert.ok(pm2Start >= 0, "rollback PM2 branch must exist");
  assert.ok(fallbackStart > pm2Start, "rollback systemd fallback must follow the PM2 branch");
  const pm2Block = rollbackScript.slice(pm2Start, fallbackStart);

  assert.match(rollbackScript, /stop_stale_nli_listeners\(\)/);
  assert.match(rollbackScript, /wait_for_nli_listener_identity\(\)/);
  assert.match(rollbackScript, /is_expected_nli_gateway_listener\(\)/);
  assert.match(rollbackScript, /listener_argv\[1\]/);
  assert.doesNotMatch(rollbackScript, /wait_for_pm2_nli_listener_identity\(\)/);
  assert.doesNotMatch(rollbackScript, /gateway_pm2_pid\(\)/);
  assert.doesNotMatch(rollbackScript, /match\(\$0,/);
  assert.ok(pm2Block.indexOf("pm2 delete") >= 0, "PM2 process must be removed before rollback reconciliation");
  assert.ok(pm2Block.indexOf("stop_stale_nli_listeners") > pm2Block.indexOf("pm2 delete"));
  assert.ok(pm2Block.indexOf("pm2 start") > pm2Block.indexOf("stop_stale_nli_listeners"));
  assert.ok(pm2Block.indexOf("wait_for_nli_listener_identity") > pm2Block.indexOf("pm2 start"));
});

test(
  "deployment lifecycle terminates an orphaned listener with the expected script and cwd",
  { skip: process.platform !== "linux" },
  async () => {
    const port = await reserveFetchSafePort();
    const gatewayPath = resolve(root, "tools/nli-gateway.mjs");
    const gateway = spawn(process.execPath, [gatewayPath], {
      cwd: root,
      env: {
        ...process.env,
        NLI_HOST: "127.0.0.1",
        NLI_PORT: String(port),
        NLI_ALLOWED_ORIGINS: "https://portfolio.example",
        GIT_COMMIT_SHA: "test-revision"
      },
      stdio: "ignore"
    });

    try {
      await waitForGateway(port, gateway);
      const helpers = extractLifecycleHelpers(deployScript);
      const cleanup = await runLifecycleCleanup(helpers, port);

      assert.equal(cleanup.status, 0, cleanup.stderr);
      assert.match(cleanup.stdout, /Stopping stale Gateway listener PID/);
      await waitForExit(gateway);
    } finally {
      if (gateway.exitCode === null && gateway.signalCode === null) gateway.kill("SIGTERM");
    }
  }
);

test(
  "deployment lifecycle refuses a listener that only mentions the Gateway path as a later argument",
  { skip: process.platform !== "linux" },
  async () => {
    const port = await reserveFetchSafePort();
    const gatewayPath = resolve(root, "tools/nli-gateway.mjs");
    const dummy = spawn(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import { createServer } from "node:http"; createServer((request, response) => response.end("dummy")).listen(Number(process.env.NLI_PORT), "127.0.0.1");',
        gatewayPath
      ],
      { cwd: root, env: { ...process.env, NLI_PORT: String(port) }, stdio: "ignore" }
    );

    try {
      await waitForGateway(port, dummy);
      const cleanup = await runLifecycleCleanup(extractLifecycleHelpers(deployScript), port);

      assert.notEqual(cleanup.status, 0, "non-Gateway listener cleanup must fail safely");
      assert.match(cleanup.stdout, /Refusing to stop a non-Gateway listener/);
      assert.equal(dummy.exitCode, null, "non-Gateway listener must remain running");
      assert.equal(dummy.signalCode, null, "non-Gateway listener must not receive a signal");
    } finally {
      if (dummy.exitCode === null && dummy.signalCode === null) dummy.kill("SIGTERM");
    }
  }
);

function extractDeploymentRemoteScript(source) {
  const jobStart = source.indexOf("      - name: Deploy exact triggering revision");
  const scriptStart = source.indexOf("          set -euo pipefail", jobStart);
  const scriptEnd = source.indexOf("\n          REMOTE", scriptStart);
  assert.ok(jobStart >= 0, "deployment job must exist");
  assert.ok(scriptStart >= 0, "deployment remote script must exist");
  assert.ok(scriptEnd >= 0, "deployment remote script must terminate");
  return source.slice(scriptStart, scriptEnd).replace(/^          /gm, "");
}

function extractLifecycleHelpers(script) {
  const end = script.indexOf("\nAPP_DIR=");
  assert.ok(end >= 0, "deployment lifecycle helpers must precede checkout");
  return script.slice(0, end);
}

async function waitForGateway(port, gateway) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (gateway.exitCode !== null || gateway.signalCode !== null) {
      throw new Error("Gateway exited before it started listening");
    }

    try {
      const response = await fetch("http://127.0.0.1:" + String(port) + "/api/nli/health");
      if (response.ok) return;
    } catch {
      // The server is still starting.
    }
    await sleep(100);
  }
  throw new Error("Gateway did not start listening within 5 seconds");
}

async function waitForExit(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    once(child, "exit"),
    sleep(5_000).then(() => {
      throw new Error("Gateway did not stop after stale-listener cleanup");
    })
  ]);
}

function runBash(script) {
  return new Promise((resolveResult, reject) => {
    const child = spawn("bash", ["-ceu", script], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (status) => resolveResult({ status, stdout, stderr }));
  });
}

function runLifecycleCleanup(helpers, port) {
  return runBash(
    helpers +
      "\nAPP_DIR=" +
      shellQuote(root) +
      "\nNLI_GATEWAY_PORT=" +
      String(port) +
      "\nstop_stale_nli_listeners\n"
  );
}

function shellQuote(value) {
  return "'" + value.replaceAll("'", "'\"'\"'") + "'";
}

function sleep(milliseconds) {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, milliseconds));
}
