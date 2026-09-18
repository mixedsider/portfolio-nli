import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { distribution } from "./eval-report.mjs";

const countBy = (rows, key) => rows.reduce((result, row) => {
  const value = String(row[key] ?? "unavailable");
  result[value] = (result[value] ?? 0) + 1;
  return result;
}, {});

export function summarizeEvaluation(report) {
  if (!report?.gates || !report.success?.rows || !report.baseline?.results) throw new Error("Incomplete evaluation report");
  const summarize = (suite) => {
    const rows = suite.rows ?? suite.results;
    const transports = rows.flatMap((row) => row.transports ?? []);
    return { ok: suite.ok, count: rows.length, stages: countBy(rows, "stage"),
      http: countBy(suite.http ?? [], "status"), kinds: countBy(transports, "kind"),
      transportStatus: countBy(transports, "status"), requestBytes: distribution(transports.map((row) => row.requestBytes)),
      dispatches: { lfm: rows.reduce((sum, row) => sum + row.lfmCalls, 0), qwen: rows.reduce((sum, row) => sum + row.qwenCalls, 0) },
      timings: suite.timings ?? distribution(rows.map((row) => row.elapsedMs)), maxActive: suite.maxActive,
      childSummary: suite.child?.stderr || suite.child?.stdout.match(/NLI tests passed:.*$/m)?.[0], cleanup: suite.cleanup };
  };
  return { ready: report.ready, gates: report.gates, firstCall: summarize(report.firstCall),
    success: summarize(report.success), adversarial: summarize(report.adversarial), warm: summarize(report.warm),
    baseline: { ok: report.baseline.ok, kinds: countBy(report.baseline.results, "kind"), timings: report.baseline.timings,
      statuses: countBy(report.baseline.results.map((row) => row.metadata), "status"),
      requestBytes: distribution(report.baseline.results.map((row) => row.requestBytes)) },
    phases: report.phases.map(summarize), injected: report.injected, perCase: report.perCase };
}

export function summarizeCommand(report) {
  if (!Number.isInteger(report?.code) || typeof report.stdout !== "string") throw new Error("Invalid command report");
  let payloadSummary;
  try {
    const payload = JSON.parse(report.stdout);
    if (Array.isArray(payload.results)) payloadSummary = { ok: payload.ok, cleanup: payload.cleanup, gateChecks: payload.gateChecks,
      results: payload.results.map((row) => ({ fixtureId: row.fixtureId, stage: row.stage, reason: row.reason,
        lfmCalls: row.lfmCalls, qwenCalls: row.qwenCalls, wallMs: row.wallMs,
        transports: row.transports?.map((entry) => ({ kind: entry.kind, status: entry.status, dispatchCount: entry.dispatchCount })) })) };
  } catch { /* Ordinary test stdout is not a JSON payload. */ }
  return { command: report.command, code: report.code, elapsedMs: report.elapsedMs,
    tests: report.stdout.match(/^# (?:tests|pass|fail|skipped) \d+$/gm) ?? [],
    failingTests: report.stdout.match(/^not ok \d+[^\n]*/gm) ?? [],
    fixtureSummary: `${report.stdout}\n${report.stderr}`.match(/NLI tests (?:passed|failed):[^\n]*/g) ?? [], payloadSummary };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 3) throw new Error("Supply one evaluation report path");
  const report = JSON.parse(await readFile(resolve(process.argv[2]), "utf8"));
  console.log(JSON.stringify(report.command && Object.hasOwn(report, "code") ? summarizeCommand(report) : summarizeEvaluation(report), null, 2));
}
