import { loadNliContext } from "./nli-gateway.mjs";
import { loadTestCases, selectTestCases } from "./nli/test-fixtures.mjs";
import { runTestCase } from "./nli/test-runner.mjs";
import { EVALUATION_HTTP_TIMEOUT_MS } from "./nli/timeout-policy.mjs";

const options = parseOptions(process.argv.slice(2));
const testCases = selectTestCases(await loadTestCases(options.casesPath), options.caseKind);
const context = await loadNliContext();
const endpoint = options.mode === "live" ? buildNliEndpoint(options.baseUrl) : null;
const minimumPassRate = options.minimumPassRate ?? (options.mode === "live" ? 0.9 : 1);
const successCount = testCases.filter((testCase) => testCase.kind === "success").length;
console.log(`NLI ${options.mode} tests: ${testCases.length} cases ` +
  `(${successCount} success, ${testCases.length - successCount} failure), minimum pass rate ${formatRate(minimumPassRate)}`);
let failures = 0;
for (const testCase of testCases) {
  const { result, errors } = await runTestCase(testCase, context, options, endpoint);
  if (errors.length) {
    failures += 1;
    console.log(`[FAIL] [${testCase.kind}] ${testCase.message}`);
    if (result) console.log(`  result: ${JSON.stringify(result)}`);
    for (const error of errors) console.log(`  - ${error}`);
  } else {
    console.log(`[PASS] [${testCase.kind}] ${testCase.message} -> ${formatResult(result)}`);
  }
}
const passed = testCases.length - failures;
const passRate = passed / testCases.length;
if (passRate < minimumPassRate) {
  console.error(`NLI tests failed: ${passed}/${testCases.length} passed (${formatRate(passRate)})`);
  process.exitCode = 1;
} else console.log(`NLI tests passed: ${passed}/${testCases.length} passed (${formatRate(passRate)})`);

function parseOptions(args) {
  const parsed = {
    mode: ["live", "fake"].includes(process.env.NLI_TEST_MODE) ? process.env.NLI_TEST_MODE : "local",
    baseUrl: process.env.NLI_TEST_BASE_URL || "",
    minimumPassRate: parsePassRate(process.env.NLI_TEST_MIN_PASS_RATE),
    casesPath: process.env.NLI_TEST_CASES || null,
    caseKind: parseCaseKind(process.env.NLI_TEST_KIND),
    timeoutMs: parseTimeout(process.env.NLI_TEST_TIMEOUT_MS)
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (["--live", "--local", "--fake"].includes(arg)) parsed.mode = arg.slice(2);
    else if (arg === "--base-url") parsed.baseUrl = readOptionValue(args, index++, arg);
    else if (arg === "--min-pass-rate") parsed.minimumPassRate = parsePassRate(readOptionValue(args, index++, arg));
    else if (arg === "--cases") parsed.casesPath = readOptionValue(args, index++, arg);
    else if (arg === "--kind") parsed.caseKind = parseCaseKind(readOptionValue(args, index++, arg));
    else if (arg === "--timeout-ms") parsed.timeoutMs = parseTimeout(readOptionValue(args, index++, arg));
    else throw new Error(`Unknown option: ${arg}`);
  }
  if (!parsed.casesPath) parsed.casesPath = parsed.mode === "live" ? "nli/live-test-cases.json" : "nli/test-cases.json";
  return parsed;
}

function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

function parsePassRate(value) {
  if (value === undefined || value === null || value === "") return null;
  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) throw new Error(`Pass rate must be a number between 0 and 1: ${value}`);
  return rate;
}

function parseCaseKind(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value !== "success" && value !== "failure") throw new Error(`Case kind must be success or failure: ${value}`);
  return value;
}

function parseTimeout(value) {
  if (value === undefined || value === null || value === "") return EVALUATION_HTTP_TIMEOUT_MS;
  const timeout = Number(value);
  if (!Number.isInteger(timeout) || timeout <= 0) throw new Error(`Timeout must be a positive integer: ${value}`);
  return timeout;
}

function buildNliEndpoint(baseUrl) {
  if (!baseUrl) throw new Error("NLI_TEST_BASE_URL or --base-url is required in live mode");
  const url = new URL(baseUrl);
  const path = url.pathname.replace(/\/$/, "");
  url.pathname = path.endsWith("/api/nli") ? path : `${path}/api/nli`;
  return url.toString();
}

function formatResult(result) {
  return `${result.intent}${result.targetId ? `:${result.targetId}` : ""}${result.term ? `:${result.term}` : ""}`;
}
function formatRate(rate) { return `${(rate * 100).toFixed(1)}%`; }
