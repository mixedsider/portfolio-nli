import { readFile } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExpectation } from "./test-expectations.mjs";
import { MODEL_FAILURE_KINDS } from "./model-outcome.mjs";

const root = fileURLToPath(new URL("../../", import.meta.url));
export const modes = Object.freeze(["local", "fake", "live"]);
export const isPlainObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

export function expectationFor(testCase, mode) {
  if (!modes.includes(mode)) throw new Error(`Unknown fixture mode: ${mode}`);
  validateCaseExpectations(testCase);
  return structuredClone(testCase.expectByMode?.[mode] ?? testCase.expect);
}

function validateCaseExpectations(testCase) {
  validateExpectation(testCase.expect);
  if (testCase.expectByMode !== undefined) {
    if (!isPlainObject(testCase.expectByMode)) throw new Error("expectByMode must be an object");
    for (const [mode, expectation] of Object.entries(testCase.expectByMode)) {
      if (!modes.includes(mode)) throw new Error(`Unknown expectation mode: ${mode}`);
      validateExpectation(expectation);
    }
  }
}

export function validateFixture(fixture, label = "fixture") {
  if (!isPlainObject(fixture) || !Array.isArray(fixture.cases) || !fixture.cases.length) {
    throw new Error(`${label} must contain a non-empty cases array`);
  }
  const messages = new Set();
  const ids = new Set();
  for (const [index, item] of fixture.cases.entries()) {
    if (!isPlainObject(item) || !["success", "failure"].includes(item.kind)) {
      throw new Error(`${label} case ${index + 1} must have kind success or failure`);
    }
    if (typeof item.message !== "string" || !item.message.trim()) throw new Error("Case must have a non-empty message");
    if (messages.has(item.message)) throw new Error(`${label} has duplicate message: ${item.message}`);
    messages.add(item.message);
    if (item.id !== undefined) {
      if (typeof item.id !== "string" || !item.id.trim() || ids.has(item.id)) throw new Error("Invalid or duplicate case id");
      ids.add(item.id);
    }
    validateCaseExpectations(item);
    if (item.models !== undefined) validateModels(item);
    for (const expectation of [item.expect, ...Object.values(item.expectByMode ?? {})]) {
      if (expectation.modelCalls !== undefined && item.models !== undefined) {
        throw new Error("modelCalls requires a legacy model fixture");
      }
    }
  }
  return fixture.cases;
}

function validateModels(item) {
  if (item.model !== undefined || !isPlainObject(item.models) || Object.keys(item.models).some((key) => !["lfm", "qwen"].includes(key))) {
    throw new Error("models must contain only lfm/qwen and cannot use legacy model");
  }
  for (const stage of ["lfm", "qwen"]) {
    const spec = item.models[stage];
    if (!isPlainObject(spec)) throw new Error(`models.${stage} must be explicit`);
    const forms = ["response", "completion", "failure"].filter((key) => spec[key] !== undefined);
    if (forms.length !== 1 || Object.keys(spec).some((key) => !["response", "completion", "failure", "elapsedMs"].includes(key))) {
      throw new Error(`models.${stage} requires exactly one response/completion/failure`);
    }
    if (spec.failure !== undefined && !MODEL_FAILURE_KINDS.includes(spec.failure)) throw new Error("Invalid fake failure");
    if (spec.response !== undefined && !isPlainObject(spec.response)) throw new Error("Invalid fake response");
    if (spec.elapsedMs !== undefined && (!Number.isSafeInteger(spec.elapsedMs) || spec.elapsedMs < 0)) throw new Error("Invalid fake elapsedMs");
  }
  if (item.verification !== undefined && !["verified", "unverified", "disabled"].includes(item.verification)) throw new Error("Invalid verification fixture state");
}

export async function loadTestCases(casesPath) {
  return validateFixture(JSON.parse(await readFile(resolveCasePath(casesPath), "utf8")), casesPath);
}

export function resolveCasePath(casesPath) {
  if (isAbsolute(casesPath)) throw new Error(`Cases path must be workspace relative: ${casesPath}`);
  const resolved = resolve(root, casesPath);
  const relativePath = relative(root, resolved);
  if (relativePath.startsWith("..") || isAbsolute(relativePath)) throw new Error(`Cases path must stay inside the workspace: ${casesPath}`);
  return resolved;
}

export function selectTestCases(testCases, caseKind) {
  if (!testCases.length) throw new Error("No cases found in fixture");
  if (!caseKind) return testCases;
  if (!["success", "failure"].includes(caseKind)) throw new Error("Invalid case kind");
  const selected = testCases.filter((testCase) => testCase.kind === caseKind);
  if (!selected.length) throw new Error(`No ${caseKind} cases found in fixture`);
  return selected;
}
