import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNliContext, resolveNliRequest, validateNliResponse } from "./nli-gateway.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const options = parseOptions(process.argv.slice(2));
const testCases = selectTestCases(await loadTestCases(options.casesPath), options.caseKind);
const context = await loadNliContext();
const endpoint = options.mode === "live" ? buildNliEndpoint(options.baseUrl) : null;
const minimumPassRate = resolveMinimumPassRate(options);
const caseCounts = {
  success: testCases.filter((testCase) => testCase.kind === "success").length,
  failure: testCases.filter((testCase) => testCase.kind === "failure").length
};

console.log(
  `NLI ${options.mode} tests: ${testCases.length} cases ` +
    `(${caseCounts.success} success, ${caseCounts.failure} failure), ` +
    `minimum pass rate ${formatRate(minimumPassRate)}`
);

let failures = 0;

for (const testCase of testCases) {
  const { result, errors } = await runTestCase(testCase, context, options, endpoint);

  if (errors.length) {
    failures += 1;
    console.log(`[FAIL] [${testCase.kind || "case"}] ${testCase.message}`);
    if (result) console.log(`  result: ${JSON.stringify(result)}`);
    for (const error of errors) console.log(`  - ${error}`);
  } else {
    console.log(`[PASS] [${testCase.kind || "case"}] ${testCase.message} -> ${formatResult(result)}`);
  }
}

const passed = testCases.length - failures;
const passRate = testCases.length ? passed / testCases.length : 0;

if (passRate < minimumPassRate) {
  console.error(`NLI tests failed: ${passed}/${testCases.length} passed (${formatRate(passRate)})`);
  process.exitCode = 1;
} else {
  console.log(`NLI tests passed: ${passed}/${testCases.length} passed (${formatRate(passRate)})`);
}

async function runTestCase(testCase, nliContext, runOptions, liveEndpoint) {
  try {
    let modelCalls = 0;
    const modelClient = async () => {
      modelCalls += 1;
      if (testCase.model?.behavior === "timeout") throw new Error("fixture model timeout");
      return testCase.model?.response || null;
    };
    const result =
      runOptions.mode === "live"
        ? await requestLiveNli(testCase, liveEndpoint)
        : await resolveNliRequest(testCase.message, nliContext, {
            useModel: runOptions.mode === "fake" ? undefined : false,
            modelClient,
            currentTargetId: testCase.currentTargetId,
            history: testCase.history
          });
    return { result, errors: validateResult(result, testCase, nliContext, modelCalls) };
  } catch (error) {
    return { result: null, errors: [`request failed: ${formatError(error)}`] };
  }
}

async function requestLiveNli(testCase, endpointUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await fetch(endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: testCase.message,
          currentTargetId: testCase.currentTargetId,
          history: testCase.history
      }),
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timeout);
  }
}

function validateResult(result, testCase, nliContext, modelCalls) {
  const errors = [];
  const sourceIds = Array.isArray(result?.sources) ? result.sources.map((source) => source.id) : [];
  const validation = validateNliResponse(result, nliContext, {
    candidateSources: result?.intent === "answer_portfolio" ? sourceIds : undefined
  });

  if (!validation.ok) errors.push(...validation.errors);
  if (!result || typeof result !== "object" || Array.isArray(result)) return errors;

  assertEqual("intent", result.intent, testCase.expect.intent, errors);
  assertEqual("targetId", result.targetId, testCase.expect.targetId, errors);
  assertEqual("term", result.term, testCase.expect.term, errors);
  assertEqual("modelCalls", modelCalls, testCase.expect.modelCalls, errors);
  if (testCase.expect.sourceIds !== undefined && JSON.stringify(sourceIds) !== JSON.stringify(testCase.expect.sourceIds)) {
    errors.push(`sourceIds expected "${testCase.expect.sourceIds}", got "${sourceIds}"`);
  }

  for (const requiredText of readExpectedList(testCase.expect.answerIncludes)) {
    if (!String(result.answer || "").includes(requiredText)) errors.push(`answer does not include "${requiredText}"`);
  }

  for (const excludedText of readExpectedList(testCase.expect.answerExcludes)) {
    if (String(result.answer || "").includes(excludedText)) {
      errors.push(`answer should not include "${excludedText}"`);
    }
  }

  for (const requiredText of readExpectedList(testCase.expect.messageIncludes)) {
    if (!String(result.message || "").includes(requiredText)) {
      errors.push(`message does not include "${requiredText}"`);
    }
  }

  for (const excludedText of readExpectedList(testCase.expect.messageExcludes)) {
    if (String(result.message || "").includes(excludedText)) {
      errors.push(`message should not include "${excludedText}"`);
    }
  }

  const serializedResult = JSON.stringify(result);
  for (const excludedText of readExpectedList(testCase.expect.responseExcludes)) {
    if (serializedResult.includes(excludedText)) {
      errors.push(`response should not include "${excludedText}"`);
    }
  }

  return errors;
}

function readExpectedList(value) { return value === undefined ? [] : Array.isArray(value) ? value : [value]; }

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

    if (arg === "--live") {
      parsed.mode = "live";
    } else if (arg === "--local") {
      parsed.mode = "local";
    } else if (arg === "--fake") {
      parsed.mode = "fake";
    } else if (arg === "--base-url") {
      parsed.baseUrl = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--min-pass-rate") {
      parsed.minimumPassRate = parsePassRate(readOptionValue(args, index, arg));
      index += 1;
    } else if (arg === "--cases") {
      parsed.casesPath = readOptionValue(args, index, arg);
      index += 1;
    } else if (arg === "--kind") {
      parsed.caseKind = parseCaseKind(readOptionValue(args, index, arg));
      index += 1;
    } else if (arg === "--timeout-ms") {
      parsed.timeoutMs = parseTimeout(readOptionValue(args, index, arg));
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  if (!parsed.casesPath) parsed.casesPath = parsed.mode === "live" ? "nli/live-test-cases.json" : "nli/test-cases.json";

  return parsed;
}

async function loadTestCases(casesPath) {
  const fixturePath = resolveCasePath(casesPath);
  const fixture = JSON.parse(await readFile(fixturePath, "utf8"));
  if (!isPlainObject(fixture) || !Array.isArray(fixture.cases) || fixture.cases.length === 0) {
    throw new Error(`${casesPath} must contain a non-empty cases array`);
  }

  const messages = new Set();
  for (const [index, testCase] of fixture.cases.entries()) {
    if (!isPlainObject(testCase) || !["success", "failure"].includes(testCase.kind)) {
      throw new Error(`${casesPath} case ${index + 1} must have kind success or failure`);
    }
    if (typeof testCase.message !== "string" || !testCase.message.trim()) {
      throw new Error(`${casesPath} case ${index + 1} must have a non-empty message`);
    }
    if (!isPlainObject(testCase.expect) || typeof testCase.expect.intent !== "string") {
      throw new Error(`${casesPath} case ${index + 1} must declare expect.intent`);
    }
    if (messages.has(testCase.message)) throw new Error(`${casesPath} has duplicate message: ${testCase.message}`);
    messages.add(testCase.message);
  }

  return fixture.cases;
}

function resolveCasePath(casesPath) {
  if (isAbsolute(casesPath)) throw new Error(`Cases path must be workspace relative: ${casesPath}`);

  const resolved = resolve(root, casesPath);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) {
    throw new Error(`Cases path must stay inside the workspace: ${casesPath}`);
  }
  return resolved;
}

function selectTestCases(testCases, caseKind) {
  if (!caseKind) return testCases;
  const selected = testCases.filter((testCase) => testCase.kind === caseKind);
  if (selected.length === 0) throw new Error(`No ${caseKind} cases found in fixture`);
  return selected;
}

function readOptionValue(args, index, optionName) {
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${optionName} requires a value`);
  return value;
}

function resolveMinimumPassRate(runOptions) {
  if (runOptions.minimumPassRate !== null) return runOptions.minimumPassRate;
  return runOptions.mode === "live" ? 0.9 : 1;
}

function parsePassRate(value) {
  if (value === undefined || value === null || value === "") return null;

  const rate = Number(value);
  if (!Number.isFinite(rate) || rate < 0 || rate > 1) {
    throw new Error(`Pass rate must be a number between 0 and 1: ${value}`);
  }

  return rate;
}

function parseCaseKind(value) {
  if (value === undefined || value === null || value === "") return null;
  if (value !== "success" && value !== "failure") {
    throw new Error(`Case kind must be success or failure: ${value}`);
  }
  return value;
}

function parseTimeout(value) {
  if (value === undefined || value === null || value === "") return 10000;

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

function assertEqual(label, actual, expected, errors) {
  if (expected !== undefined && actual !== expected) errors.push(`${label} expected "${expected}", got "${actual}"`);
}

function formatResult(result) {
  return `${result.intent}${result.targetId ? `:${result.targetId}` : ""}${result.term ? `:${result.term}` : ""}`;
}

function formatRate(rate) { return `${(rate * 100).toFixed(1)}%`; }

function formatError(error) {
  return error instanceof Error ? error.message : String(error);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
