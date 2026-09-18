import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { execute } from "./deploy-workflow-tests.mjs";
import { extractWorkflowRemote } from "./deploy-workflow-extract.mjs";

export function registerWorkflowDiagnosticTests(workflow) {
  for (const step of ["Deploy exact triggering revision", "Roll back failed deployment"]) {
    for (const diagnostic of ["stop_stale_nli_listeners", "wait_for_nli_listener_identity"]) {
      test(`cmdline redaction: ${step} ${diagnostic}`, { skip: process.platform !== "linux" }, async () => {
        const dir = await mkdtemp(join(tmpdir(), "deploy-diagnostic-"));
        try {
          const proc = join(dir, "proc/7777");
          await mkdir(proc, { recursive: true });
          await symlink(dir, join(proc, "cwd"));
          const sentinel = "fixture-commandline-secret-do-not-log";
          await writeFile(join(proc, "cmdline"), ["node", "--eval", sentinel, join(dir, "tools/nli-gateway.mjs"), ""].join("\0"));
          const remote = extractWorkflowRemote(workflow, step);
          const boundary = remote.indexOf("\nAPP_DIR=");
          assert.ok(boundary > 0);
          const helpers = remote.slice(0, boundary).replaceAll("/proc/", dir + "/proc/");
          const shell = `${helpers}
            APP_DIR=${JSON.stringify(dir)}
            NLI_GATEWAY_PORT=8787
            nli_listener_pids() { printf '7777\\n'; }
            kill() { printf 'UNEXPECTED_KILL\\n'; return 1; }
            sleep() { :; }
            ${diagnostic}
          `;
          const result = await execute("bash", ["-c", shell], { cwd: dir, env: { PATH: process.env.PATH } });
          assert.equal(result.code, 1);
          assert.match(result.stdout, /Listener PID: 7777/);
          assert.doesNotMatch(result.stdout + result.stderr, new RegExp(sentinel + "|UNEXPECTED_KILL"));
          assert.doesNotMatch(remote, /echo[^\n]*(?:cmdline|listener_cmdline)/);
        } finally { await rm(dir, { recursive: true, force: true }); }
      });
    }
  }
}
