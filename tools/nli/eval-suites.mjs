import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { createEvalSession } from "./eval-session.mjs";
import { assessSuite } from "./eval-report.mjs";
import { assessRouting } from "./eval-routing.mjs";
import { EVALUATION_HTTP_TIMEOUT_MS } from "./timeout-policy.mjs";

export async function runChild(args, { timeout = 420000, env = process.env } = {}) {
  try {
    const result = await promisify(execFile)(process.execPath, args, {
      cwd: fileURLToPath(new URL("../../", import.meta.url)), timeout, killSignal: "SIGKILL", maxBuffer: 2 * 1024 * 1024, env
    });
    return { code: 0, signal: null, ...result };
  } catch (error) {
    return { code: Number.isInteger(error.code) ? error.code : 1, signal: error.signal ?? null,
      stdout: error.stdout ?? "", stderr: error.stderr ?? "", killed: error.killed === true };
  }
}

export async function runFixtureSuite(config, context, cases, path, kind, dependencies = {}) {
  const session = await (dependencies.createSession ?? createEvalSession)(config, context, cases, { ordered: true });
  const args = ["tools/nli-test.mjs", "--live", "--base-url", session.url, "--cases", path,
    "--min-pass-rate", "1", "--timeout-ms", String(EVALUATION_HTTP_TIMEOUT_MS)];
  if (kind) args.push("--kind", kind);
  let report;
  try {
    const child = await (dependencies.runChild ?? runChild)(args, { timeout: cases.length * EVALUATION_HTTP_TIMEOUT_MS + 30000 });
    await session.settle();
    const rows = session.rows();
    const cli = assessSuite(child, rows, cases.length);
    const routing = assessRouting(cases, rows, context);
    report = { path, kind, url: session.url, command: ["node", ...args], child, rows,
      http: session.http, gateChecks: session.gateChecks, maxActive: session.maxActive,
      cliOk: cli.ok, routing, ok: cli.ok && routing.ok, errors: [...cli.errors, ...routing.errors] };
    if (session.faults.length || session.http.length !== cases.length || session.http.some((row) => row.status !== 200)) {
      report.ok = false;
      report.errors.push("http_or_observer_failure");
    }
  } finally {
    const cleanup = await session.close();
    if (report) report.cleanup = cleanup;
    if (cleanup?.ok !== true) throw new Error("Cleanup failed");
  }
  return report;
}
