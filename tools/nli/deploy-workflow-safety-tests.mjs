import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { extractWorkflowLifecycle } from "./deploy-workflow-extract.mjs";
import { createWorkflowFixture } from "./deploy-workflow-fixture.mjs";
import { execute } from "./deploy-workflow-tests.mjs";

export function registerWorkflowSafetyTests(workflow, root) {
  test("long workflow run blocks avoid GitHub expression expansion beyond 21000 characters", () => {
    const blocks = [...workflow.matchAll(/^        run: \|\n((?:          .*\n|\n)*)/gm)]
      .map((match) => match[1].replace(/^          /gm, ""));
    assert.ok(blocks.some((block) => block.length > 21000), "must inspect the oversized deployment script");
    for (const block of blocks) {
      if (block.length > 21000) assert.doesNotMatch(block, /\$\{\{/, `oversized run block (${block.length} characters) must use step env`);
      assert.doesNotMatch(block, /\$\{\{\s*github\.(?:sha|run_id|run_attempt)\b/, "revision and run identity belong in step env");
    }
  });

  test("SSH lifecycle steps bind pinned revision and run identity through step env without changing quoted assignments", async () => {
    const names = ["Deploy exact triggering revision", "Roll back failed deployment", "Remove private host lifecycle snapshot"];
    for (const name of names) {
      const start = workflow.indexOf(`      - name: ${name}\n`);
      assert.ok(start >= 0, name);
      const end = workflow.indexOf("\n      - name:", start + 1);
      const step = workflow.slice(start, end < 0 ? undefined : end);
      const run = step.indexOf("        run: |\n");
      assert.ok(run > 0, name);
      const env = step.slice(0, run), script = step.slice(run);
      assert.match(env, /PREFLIGHT_ID: \$\{\{ github.run_id \}\}-\$\{\{ github.run_attempt \}\}/);
      assert.match(script, /PREFLIGHT_ID='\$\{PREFLIGHT_ID\}' bash -s" <<'REMOTE'/);
      assert.match(script, /"\$\{NLI_GATEWAY_USER\}@\$\{NLI_GATEWAY_HOST\}" \\/);
      if (name === names[0]) {
        assert.match(env, /DEPLOY_SHA: \$\{\{ github.sha \}\}/);
        assert.match(script, /DEPLOY_SHA='\$\{DEPLOY_SHA\}' GIT_COMMIT_SHA='\$\{DEPLOY_SHA\}'/);
        assert.match(env, /DEPLOY_REF: \$\{\{ github.ref \}\}/);
        assert.match(script, /git merge-base --is-ancestor "\$\{DEPLOY_SHA\}" "refs\/remotes\/origin\/\$\{DEPLOY_BRANCH\}"/);
        assert.match(script, /git checkout --detach "\$\{DEPLOY_SHA\}"/);
      } else if (name === names[1]) {
        assert.match(env, /PREVIOUS_SHA: \$\{\{ steps.previous.outputs.sha \}\}/);
        assert.match(script, /PREVIOUS_SHA='\$\{PREVIOUS_SHA\}' GIT_COMMIT_SHA='\$\{PREVIOUS_SHA\}'/);
      }
      const command = script.slice("        run: |\n".length).replace(/^          /gm, "").split("\nset -euo pipefail")[0];
      const result = await execute("bash", ["-ceu", `ssh() { printf '%s\\0' "$@"; }\n${command}\nREMOTE\n`], {
        env: { ...process.env, NLI_GATEWAY_USER: "offline-user", NLI_GATEWAY_HOST: "offline-host", NLI_GATEWAY_SSH_PORT: "22",
          NLI_GATEWAY_APP_DIR: "/offline/app with spaces", NLI_GATEWAY_PROCESS: "offline-process", NLI_GATEWAY_PORT: "8787",
           DEPLOY_REF: "refs/heads/main", DEPLOY_SHA: "b".repeat(40), PREVIOUS_SHA: "a".repeat(40), PREFLIGHT_ID: "123-2" }
      });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.signal, null);
      const args = result.stdout.split("\0").filter(Boolean);
      assert.equal(args.at(-2), "offline-user@offline-host", "SSH destination must remain one positional argument");
      const assignments = "APP_DIR='/offline/app with spaces' " + (name === names[2] ? "" :
        "PROCESS_NAME='offline-process' NLI_GATEWAY_PORT='8787' " + (name === names[0] ?
          `DEPLOY_SHA='${"b".repeat(40)}' GIT_COMMIT_SHA='${"b".repeat(40)}' DEPLOY_BRANCH='main' ` :
          `PREVIOUS_SHA='${"a".repeat(40)}' GIT_COMMIT_SHA='${"a".repeat(40)}' `));
      assert.equal(args.at(-1), assignments + "PREFLIGHT_ID='123-2' bash -s", "remote assignments must remain one quoted argument");
    }
  });

  test("every cd/test push runs hosted offline diagnostics before the authorized real deploy", () => {
    const header = workflow.slice(0, workflow.indexOf("jobs:"));
    assert.match(header, /branches:\n      - main\n      - cd\/test\n/);
    assert.doesNotMatch(header, /paths(?:-ignore)?:/);
    assert.match(workflow, /main-paths:\n    if: github.ref == 'refs\/heads\/main'\n    runs-on: ubuntu-latest/);
    assert.match(workflow, /deploy:\n    needs: \[main-paths, cd-test-diagnostics\]\n    if: \$\{\{ always\(\) && !cancelled\(\)/);
    const start = workflow.indexOf("  cd-test-diagnostics:");
    assert.ok(start > 0);
    const diagnostic = workflow.slice(start, workflow.indexOf("\n  deploy:", start));
    assert.match(diagnostic, /if: github.ref == 'refs\/heads\/cd\/test'/);
    assert.match(diagnostic, /runs-on: ubuntu-latest/);
    assert.match(diagnostic, /uses: actions\/checkout@v4\n        with:\n          ref: \$\{\{ github.sha \}\}\n          persist-credentials: false/);
    assert.doesNotMatch(diagnostic, /secrets\.|self-hosted|--live|--endpoint|ssh /);
    assert.match(diagnostic, /subsequent REAL deployment from cd\/test/);
    assert.match(diagnostic, /Every cd\/test push may restart the actual configured Gateway/);
    assert.match(diagnostic, /node --test tools\/deploy-nli-gateway.test.mjs/);
    assert.match(diagnostic, /CONTRACT_RESULT: \$\{\{ steps.contract.outcome \}\}/);
    assert.match(workflow, /DEPLOY_OUTCOME: \$\{\{ steps.deploy.outcome \}\}/);
    assert.match(workflow, /ROLLBACK_OUTCOME: \$\{\{ steps.rollback.outcome \}\}/);
    assert.match(workflow, /git merge-base --is-ancestor "\$\{DEPLOY_SHA\}" "refs\/remotes\/origin\/\$\{DEPLOY_BRANCH\}"/);
  });

  test("only eligible production jobs acquire the deploy lock; global, filter and debug jobs have no shared lock", () => {
    const header = workflow.slice(0, workflow.indexOf("jobs:"));
    assert.doesNotMatch(header, /^concurrency:/m, "docs-only main runs must not replace pending eligible deploys");
    const filter = workflow.slice(workflow.indexOf("  main-paths:"), workflow.indexOf("  cd-test-diagnostics:"));
    const diagnostic = workflow.slice(workflow.indexOf("  cd-test-diagnostics:"), workflow.indexOf("  deploy:"));
    assert.doesNotMatch(filter + diagnostic, /^\s+concurrency:/m, "each offline diagnostic push must execute without a shared pending slot");
    const deploy = workflow.slice(workflow.indexOf("  deploy:"), workflow.indexOf("    steps:", workflow.indexOf("  deploy:")));
    assert.match(deploy, /needs: \[main-paths, cd-test-diagnostics\]\n    if: \$\{\{ always\(\) && !cancelled\(\)/);
    assert.match(deploy, /    concurrency:\n      group: deploy-nli-gateway\n      cancel-in-progress: false\n/);
    assert.equal((workflow.match(/^\s*concurrency:/gm) ?? []).length, 1, "production job owns the only lock");
  });

  test("detailed failure projection excludes arbitrary strings and preserves partial counters", async () => {
    const lifecycle = extractWorkflowLifecycle(workflow);
    const start = lifecycle.indexOf("// SAFE_DIAGNOSTICS_START");
    const end = lifecycle.indexOf("// SAFE_DIAGNOSTICS_END");
    assert.ok(start >= 0 && end > start, "safe diagnostics projection must exist");
    const dir = await mkdtemp(join(tmpdir(), "deploy-projection-"));
    try {
      const helper = join(dir, "projection.mjs");
      await writeFile(helper, `import { readFileSync } from 'node:fs';\n${lifecycle.slice(start, end)}\nexport { projectReport, childProjection, failureCategory };`);
      const { projectReport, childProjection, failureCategory } = await import(helper);
      const sentinel = "private-url-path-env-prompt-template-receipt-model-sentinel";
      const report = { status: "activation-blocked", ready: false, detail: "timeout",
        blockers: ["qwen_unverified", sentinel], metadataCalls: 2, inferenceCalls: 7,
        settings: { timeoutMs: 16000, name: sentinel }, results: [{ ok: true }, { ok: false, kind: "invalid_json", caseId: sentinel }],
        stdout: sentinel, stderr: sentinel, proof: sentinel };
      assert.deepEqual(projectReport(report), { status: "activation-blocked", ready: false, detail: "timeout",
        blockers: ["qwen_unverified", "unclassified"], metadataCalls: 2, inferenceCalls: 7,
        timeoutMs: 16000, results: { total: 2, passed: 1, failed: 1, invalid_json: 1 } });
      assert.deepEqual(projectReport({ settings: { lfm: { timeoutMs: 6500 }, qwen: { timeoutMs: 16000 }, cascade: { timeoutMs: 23500 } },
        success: { rows: [{ stage: "lfm", lfmCalls: 1, qwenCalls: 0 }], http: [{ status: 200 }], ok: false, child: { code: 1 } } }),
      { success: { total: 1, httpSuccess: 1, ok: false, child: { exit: 1, signal: null, spawnCode: null } },
        lfmTimeoutMs: 6500, qwenTimeoutMs: 16000, cascadeTimeoutMs: 23500 });
      assert.deepEqual(projectReport({ gates: { policyCaps: true, ordinary: false, [sentinel]: true },
        warm: { ok: false, expectedCount: 3, concurrency: 1, repeats: 1, cleanup: { ok: true }, results: [
          { errors: [], stage: "lfm", reason: "accepted" }, { errors: [sentinel] }, { errors: [] } ] },
        phases: [{ ok: false, results: [{ errors: [sentinel] }], faults: [sentinel] }] }),
      { gates: { policyCaps: true, ordinary: false }, warm: { total: 3, errorFree: 2, withErrors: 1, ok: false,
        expectedCount: 3, concurrency: 1, repeats: 1, cleanupOk: true },
        phases: [{ total: 1, errorFree: 0, withErrors: 1, ok: false, faultCount: 1 }] });
      assert.doesNotMatch(JSON.stringify(projectReport({ ...report, status: sentinel, detail: sentinel })), new RegExp(sentinel));
      assert.deepEqual(childProjection({ status: 9, signal: "SIGTERM", error: { code: "ETIMEDOUT", message: sentinel } }),
        { exit: 9, signal: "SIGTERM", spawnCode: "ETIMEDOUT" });
      assert.deepEqual(childProjection({ status: sentinel, signal: sentinel, error: { code: sentinel } }),
        { exit: null, signal: "unclassified", spawnCode: "unclassified" });
      assert.deepEqual(childProjection({ status: null, error: { code: "ENOENT", message: sentinel } }),
        { exit: null, signal: null, spawnCode: "ENOENT" });
      for (const [error, category] of [[{ code: "ENOENT" }, "read"], [{ code: "ERR_MODULE_NOT_FOUND" }, "source"],
        [{ code: "ECONNREFUSED" }, "network"], [new SyntaxError(sentinel), "parse"],
        [{ code: "ETIMEDOUT" }, "timeout"], [new Error(sentinel), "unclassified"]]) {
        assert.equal(failureCategory(error), category);
      }
    } finally { await rm(dir, { recursive: true, force: true }); }
  });

  for (const stage of ["qwen", "lfm", "eval"]) test(`${stage} child failure keeps its stage, exit and available private report redacted`, async () => {
    const f = await createWorkflowFixture(root, false, false);
    const helper = join(f.directory, "lifecycle.mjs");
    const invoke = async (action) => execute(process.execPath, [helper, action, "b".repeat(40)], {
      cwd: f.app, env: { ...f.ssh, GATEWAY_PID: String((await f.manager.state()).pid) }
    });
    try {
      await writeFile(helper, extractWorkflowLifecycle(workflow));
      assert.equal((await invoke("snapshot")).code, 0);
      assert.equal((await invoke("restart")).code, 0);
      const producerPath = join(f.app, stage === "eval" ? "tools/nli-cascade-eval.mjs" : "tools/nli/eval-bound-probe.mjs");
      const source = await readFile(producerPath, "utf8");
      await writeFile(producerPath, source.replace('if (scenario === endpoint + "-fail") process.exit(1);',
        `if (scenario === endpoint + "-fail") { writeFileSync(args.output, JSON.stringify({ status: "activation-blocked", detail: "timeout", blockers: ["qwen_unverified", "fake-private-sentinel"], inferenceCalls: 3 })); process.exit(7); }`));
      await f.scenario(stage + "-fail");
      const result = await invoke("preflight");
      assert.equal(result.code, 1);
      assert.match(result.stderr, new RegExp(`action=preflight stage=${stage} category=child`));
      assert.match(result.stderr, /"exit":7/);
      assert.match(result.stderr, /"inferenceCalls":3/);
      assert.match(result.stdout, new RegExp(`::group::NLI lifecycle ${stage}`));
      assert.doesNotMatch(result.stdout + result.stderr, /fake-private-sentinel|fake-ssh-sentinel|prior-model|prior-lfm/);
    } finally { await f.close(); }
  });

  for (const fault of ["signal", "malformed-report", "missing-report", "source", "read", "parse"]) {
    test(`lifecycle ${fault} diagnostic remains fixed and redacted`, async () => {
      const f = await createWorkflowFixture(root, false, false);
      const helper = join(f.directory, "lifecycle.mjs");
      const invoke = async (action) => execute(process.execPath, [helper, action, "b".repeat(40)], {
        cwd: f.app, env: { ...f.ssh, GATEWAY_PID: String((await f.manager.state()).pid) }
      });
      try {
        await writeFile(helper, extractWorkflowLifecycle(workflow));
        if (fault === "source") {
          await rm(join(f.app, "tools/nli/config.mjs"));
          const result = await invoke("snapshot");
          assert.equal(result.code, 1);
          assert.match(result.stderr, /action=snapshot stage=snapshot_configuration category=source/);
          assert.doesNotMatch(result.stderr, /Cannot find|deploy-workflow-|config.mjs/);
          return;
        }
        assert.equal((await invoke("snapshot")).code, 0);
        if (["read", "parse"].includes(fault)) {
          const snapshot = join(f.directory, "snapshot.json");
          if (fault === "read") await rm(snapshot);
          else await writeFile(snapshot, "fake-private-sentinel");
          const result = await invoke("restart");
          assert.equal(result.code, 1);
          assert.match(result.stderr, new RegExp(`action=restart stage=state_read category=${fault}`));
          assert.doesNotMatch(result.stderr, /fake-private-sentinel|snapshot.json/);
          return;
        }
        assert.equal((await invoke("restart")).code, 0);
        const producer = join(f.app, "tools/nli/eval-bound-probe.mjs");
        const output = join(f.directory, "qwen-verify.json");
        if (fault === "malformed-report") await writeFile(output, "fake-private-sentinel");
        await writeFile(producer, fault === "signal" ? 'process.kill(process.pid, "SIGTERM");' : 'process.exit(5);');
        const result = await invoke("preflight");
        assert.equal(result.code, 1);
        assert.match(result.stderr, /action=preflight stage=qwen category=child/);
        assert.match(result.stderr, fault === "signal" ? /"signal":"SIGTERM"/ : /"exit":5/);
        assert.match(result.stderr, fault === "malformed-report" ? /"availability":"parse"/ : /"availability":"missing"/);
        assert.doesNotMatch(result.stdout + result.stderr, /fake-private-sentinel|fake-ssh-sentinel|qwen-verify.json/);
      } finally { await f.close(); }
    });
  }
}
