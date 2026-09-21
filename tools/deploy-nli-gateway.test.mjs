import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { reserveFetchSafePort } from "./test-server.mjs";
import { extractWorkflowLifecycle } from "./nli/deploy-workflow-extract.mjs";
import { registerWorkflowLifecycleTests } from "./nli/deploy-workflow-tests.mjs";
import { registerFirstUpgradeTests } from "./nli/deploy-workflow-upgrade-tests.mjs";
import { registerWorkflowDiagnosticTests } from "./nli/deploy-workflow-diagnostic-tests.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workflowPath = resolve(root, ".github/workflows/deploy-nli-gateway.yml");
const workflow = process.env.NLI_DEPLOY_WORKFLOW_TEXT || (await readFile(workflowPath, "utf8"));
const deployScript = extractDeploymentRemoteScript(workflow);

test("deployment checkpoints the verified process before a non-destructive environment-preserving restart", () => {
  assert.match(deployScript, /stop_stale_nli_listeners\(\)/);
  assert.match(deployScript, /wait_for_nli_listener_identity\(\)/);
  assert.match(deployScript, /is_expected_nli_gateway_listener\(\)/);
  assert.match(deployScript, /listener_argv\[1\]/);
  assert.doesNotMatch(deployScript, /wait_for_pm2_nli_listener_identity\(\)/);
  assert.doesNotMatch(deployScript, /gateway_pm2_pid\(\)/);
  assert.doesNotMatch(deployScript, /match\(\$0,/);

  const snapshotIndex = deployScript.indexOf('lifecycle.mjs" snapshot');
  const checkoutIndex = deployScript.indexOf('git checkout --detach "${DEPLOY_SHA}"');
  const restartIndex = deployScript.indexOf('lifecycle.mjs" restart "${DEPLOY_SHA}"');
  const listenerCheckIndex = deployScript.indexOf("\nwait_for_nli_listener_identity\n");
  assert.ok(snapshotIndex >= 0 && checkoutIndex > snapshotIndex);
  assert.ok(restartIndex > checkoutIndex && listenerCheckIndex > restartIndex);
  assert.ok(deployScript.indexOf('lifecycle.mjs" preflight "${DEPLOY_SHA}"') > listenerCheckIndex);
  assert.doesNotMatch(deployScript, /pm2 delete/);
  const lifecycle = extractWorkflowLifecycle(workflow);
  assert.match(lifecycle, /\["restart", state\.name, "--update-env"\]/);
  assert.match(lifecycle, /const env = \{ \.\.\.state\.env, GIT_COMMIT_SHA: revision \}/);
  assert.match(lifecycle, /tools\/nli\/eval-bound-probe\.mjs/);
  assert.doesNotMatch(lifecycle, /tools\/nli-model-probe\.mjs/);
  assert.match(lifecycle, /run\("systemctl", \["--user", "restart", state\.name \+ "\.service"\], state\.env\)/);
});

test("rollback restores the pre-restart receipt and captured environment with the previous revision", () => {
  const rollbackStart = workflow.indexOf("      - name: Roll back failed deployment");
  const rollbackScriptStart = workflow.indexOf("          set -euo pipefail", rollbackStart);
  const rollbackScriptEnd = workflow.indexOf("\n          REMOTE", rollbackScriptStart);

  assert.ok(rollbackStart >= 0, "rollback job must exist");
  assert.ok(rollbackScriptStart >= 0, "rollback remote script must exist");
  assert.ok(rollbackScriptEnd >= 0, "rollback remote script must terminate");

  const rollbackScript = workflow.slice(rollbackScriptStart, rollbackScriptEnd).replace(/^          /gm, "");
  assert.match(rollbackScript, /stop_stale_nli_listeners\(\)/);
  assert.match(rollbackScript, /wait_for_nli_listener_identity\(\)/);
  assert.match(rollbackScript, /is_expected_nli_gateway_listener\(\)/);
  assert.match(rollbackScript, /listener_argv\[1\]/);
  assert.doesNotMatch(rollbackScript, /wait_for_pm2_nli_listener_identity\(\)/);
  assert.doesNotMatch(rollbackScript, /gateway_pm2_pid\(\)/);
  assert.doesNotMatch(rollbackScript, /match\(\$0,/);
  assert.match(rollbackScript, /snapshot\.json" \] \|\| exit 0/);
  assert.doesNotMatch(rollbackScript, /pm2 delete/);
  const restoreIndex = rollbackScript.indexOf('lifecycle.mjs" restore');
  const checkoutIndex = rollbackScript.indexOf('git checkout --detach "${PREVIOUS_SHA}"');
  const restartIndex = rollbackScript.indexOf('lifecycle.mjs" restart "${PREVIOUS_SHA}"');
  assert.ok(restoreIndex >= 0 && checkoutIndex > restoreIndex && restartIndex > checkoutIndex);
  assert.ok(rollbackScript.indexOf("\nwait_for_nli_listener_identity", restartIndex) > restartIndex);
  assert.match(workflow, /name: Remove private host lifecycle snapshot\n\s+if: \$\{\{ always\(\) && steps\.previous\.outputs\.sha != '' \}\}/);
});

test("manual snapshot diagnostics stop before lifecycle mutation", () => {
  assert.match(workflow, /workflow_dispatch:\n\s+inputs:\n\s+snapshot_only:/);
  assert.match(workflow, /NLI_SNAPSHOT_ONLY: \$\{\{ inputs\.snapshot_only && 'true' \|\| 'false' \}\}/);
  assert.match(deployScript, /GATEWAY_PID="\$\(nli_listener_pids\)" node "\$\{PREFLIGHT_DIR\}\/lifecycle\.mjs" snapshot\nif \[ "\$\{SNAPSHOT_ONLY\}" = "true" \]; then\n\s+echo "Snapshot diagnostic completed without lifecycle mutation\."\n\s+exit 0\nfi\ngit fetch/);
  for (const step of [
    "Process health and revision check (not model readiness)",
    "Run live NLI functional tests",
    "Run live NLI adversarial tests"
  ]) {
    assert.match(workflow, new RegExp(`name: ${step.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\n\\s+if: \\$\\{\\{ env\\.NLI_SNAPSHOT_ONLY != 'true' \\}\\}`));
  }
  assert.match(workflow, /name: Roll back failed deployment\n\s+if: \$\{\{ failure\(\) && env\.NLI_SNAPSHOT_ONLY != 'true' && steps\.previous\.outputs\.sha != '' \}\}/);
});

registerWorkflowLifecycleTests(workflow, root);
registerFirstUpgradeTests(workflow, root);
registerWorkflowDiagnosticTests(workflow);

test("deployment preflight covers grounded fixtures and maintained tests without a browser dependency", () => {
  const preflight = extractPreflightScript(workflow);

  assert.match(preflight, /for file in app\.js nli-history\.js nli-widget\.js data\/portfolio\.js tools\/\*\.mjs/);
  assert.match(preflight, /node --check "\$file"/);
  assert.match(preflight, /grounded-category-test-cases\.json/);
  assert.match(
    preflight,
    /node tools\/nli-test\.mjs --fake --cases nli\/grounded-category-test-cases\.json --min-pass-rate 1/
  );
  assert.match(preflight, /node --test tools\/\*\.test\.mjs/);
  assert.match(preflight, /node --test tools\/nli\/\*\.test\.mjs/);
  assert.match(preflight, /node --test tools\/nli-widget\.browser-test\.mjs/);
  assert.doesNotMatch(preflight, /NLI_WIDGET_BROWSER_MODULE|playwright/i);
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

function extractPreflightScript(source) {
  const stepStart = source.indexOf("      - name: Verify Gateway source before deployment");
  const scriptStart = source.indexOf("        run: |", stepStart);
  const nextStep = source.indexOf("\n      - name:", scriptStart);

  assert.ok(stepStart >= 0, "preflight job must exist");
  assert.ok(scriptStart >= 0, "preflight script must exist");
  assert.ok(nextStep > scriptStart, "preflight script must end before the next step");
  return source.slice(scriptStart, nextStep);
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
