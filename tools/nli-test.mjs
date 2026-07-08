import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadNliContext, resolveNliRequest, validateNliResponse } from "./nli-gateway.mjs";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const testCases = JSON.parse(await readFile(resolve(root, "nli/test-cases.json"), "utf8")).cases;
const context = await loadNliContext();

let failures = 0;

for (const testCase of testCases) {
  const result = await resolveNliRequest(testCase.message, context, { useModel: false });
  const validation = validateNliResponse(result, context);
  const errors = [];

  if (!validation.ok) errors.push(...validation.errors);
  assertEqual("intent", result.intent, testCase.expect.intent, errors);
  assertEqual("targetId", result.targetId, testCase.expect.targetId, errors);
  assertEqual("term", result.term, testCase.expect.term, errors);

  if (testCase.expect.answerIncludes && !String(result.answer || "").includes(testCase.expect.answerIncludes)) {
    errors.push(`answer does not include "${testCase.expect.answerIncludes}"`);
  }

  if (errors.length) {
    failures += 1;
    console.log(`[FAIL] ${testCase.message}`);
    console.log(`  result: ${JSON.stringify(result)}`);
    for (const error of errors) console.log(`  - ${error}`);
  } else {
    console.log(`[PASS] ${testCase.message} -> ${result.intent}${result.targetId ? `:${result.targetId}` : ""}`);
  }
}

if (failures) {
  console.error(`NLI tests failed: ${failures}/${testCases.length}`);
  process.exitCode = 1;
} else {
  console.log(`NLI tests passed: ${testCases.length}/${testCases.length}`);
}

function assertEqual(label, actual, expected, errors) {
  if (expected === undefined) return;
  if (actual !== expected) errors.push(`${label} expected "${expected}", got "${actual}"`);
}
