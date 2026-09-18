import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";
import { execute, testEnvironment } from "./process.mjs";
import { readCounts, validateJunit } from "./junit.mjs";

const guard = new URL("./network-guard.mjs", import.meta.url).pathname;
const reporter = new URL("./summary-reporter.mjs", import.meta.url).pathname;
async function nonempty(path) {
  const content = await readFile(path, "utf8");
  if (!content.trim()) throw new Error(`Empty report: ${path}`);
  return content;
}
export async function inspectReports(directory, runner) {
  const junit = await nonempty(join(directory, "junit.xml"));
  if (runner === "node") {
    const report = JSON.parse(await nonempty(join(directory, "counts.json")));
    readCounts(report);
    const counts = validateJunit(junit, runner, report);
    const coverage = await nonempty(join(directory, "lcov.info"));
    if (!coverage.includes("SF:") || !coverage.includes("end_of_record")) throw new Error("Invalid LCOV report");
    return counts;
  }
  const report = JSON.parse(await nonempty(join(directory, "results.json")));
  await nonempty(join(directory, "html/index.html"));
  const stats = report.stats;
  for (const key of ["expected", "unexpected", "skipped", "flaky"]) {
    if (!Number.isInteger(stats?.[key]) || stats[key] < 0) throw new Error("Invalid Playwright counts");
  }
  if (report.errors?.length) throw new Error("Playwright infrastructure errors");
  return validateJunit(junit, runner, { tests: stats.expected + stats.unexpected + stats.skipped + stats.flaky,
    passed: stats.expected, failed: stats.unexpected + stats.flaky, skipped: stats.skipped, todo: 0, cancelled: 0 });
}
async function finish(directory, runner, processResult) {
  let counts = null;
  let reportError = null;
  try {
    counts = await inspectReports(directory, runner);
    if (runner === "node" && processResult.expectedFiles) {
      const report = JSON.parse(await nonempty(join(directory, "counts.json")));
      if (processResult.expectedFiles.some((file) => !report.files.some((entry) => entry.file === file && entry.counts.tests > 0))) {
        reportError = "Selected Node file registered zero tests";
      }
    }
  }
  catch (error) { reportError = error.message; }
  const violations = (await readFile(join(directory, "egress.jsonl"), "utf8")).trim().split("\n").filter(Boolean).length;
  const ok = processResult.code === 0 && !processResult.signal && !processResult.interrupted && !processResult.error
    && !reportError && violations === 0 && counts.tests > 0 && counts.passed > 0
    && counts.failed === 0 && counts.skipped === 0 && counts.todo === 0 && counts.cancelled === 0;
  const result = { runner, ok, directory, exitCode: processResult.code, signal: processResult.signal,
    interrupted: processResult.interrupted, infrastructureError: processResult.error ?? reportError,
    counts, violations };
  await writeFile(join(directory, "stdout.log"), processResult.stdout);
  await writeFile(join(directory, "stderr.log"), processResult.stderr);
  await writeFile(join(directory, "summary.json"), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}
async function prepare(outDir, runner) {
  await mkdir(outDir, { recursive: true });
  const base = await mkdtemp(join(resolve(outDir), `${runner}-`));
  const directory = runner === "playwright" ? join(base, "playwright") : base;
  await mkdir(directory, { recursive: true });
  const log = join(directory, "egress.jsonl");
  await writeFile(log, "");
  return { base, directory, env: testEnvironment({ HARNESS_EGRESS_LOG: log,
    NODE_OPTIONS: `--import=${JSON.stringify(guard)}`, HARNESS_REPORT_DIR: base }) };
}
export async function runNode(files, options) {
  const { directory, env } = await prepare(options.outDir, "node");
  const args = ["--test", "--test-concurrency=2", "--experimental-test-coverage",
    "--test-reporter=spec", "--test-reporter-destination=stdout",
    "--test-reporter=junit", `--test-reporter-destination=${join(directory, "junit.xml")}`,
    "--test-reporter=lcov", `--test-reporter-destination=${join(directory, "lcov.info")}`,
    `--test-reporter=${reporter}`, `--test-reporter-destination=${join(directory, "counts.json")}`, ...files];
  const result = await execute(process.execPath, args, { ...options, env });
  return finish(directory, "node", { ...result, expectedFiles: files.map((file) => resolve(options.cwd, file)) });
}
export async function runPlaywright(files, options) {
  const { directory, env } = await prepare(options.outDir, "playwright");
  try {
    const require = createRequire(join(options.cwd, "package.json"));
    const cli = require.resolve("@playwright/test/cli");
    const { chromium } = require("@playwright/test");
    await access(env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH || chromium.executablePath());
    await access(join(options.cwd, "playwright.config.mjs"));
    return await finish(directory, "playwright", await execute(process.execPath,
      [cli, "test", ...files, "--workers=1"], { ...options, env }));
  } catch (error) {
    return finish(directory, "playwright", { code: 1, signal: null, interrupted: false,
      error: `Playwright prerequisite/execution failed: ${error.code ?? error.message}`, stdout: "", stderr: "" });
  }
}
