import { readFile } from "node:fs/promises";
import { validateNliResponse } from "./validation.mjs";

const intents = JSON.parse(await readFile(new URL("../../nli/intents.json", import.meta.url), "utf8")).intents;
const textKeys = ["answerIncludes", "answerExcludes", "messageIncludes", "messageExcludes", "responseExcludes"];
const countKeys = ["modelCalls", "lfmCalls", "qwenCalls"];
const keys = ["intent", "targetId", "term", "sourceIds", "sourceGroups", "allowedSourceIds", "stage", "reason", ...textKeys, ...countKeys];
const strings = (value) => Array.isArray(value) && value.length > 0 && value.every((entry) => typeof entry === "string" && entry.length > 0);
const list = (value) => value === undefined ? [] : Array.isArray(value) ? value : [value];

export function validateExpectation(expectation) {
  if (!expectation || typeof expectation !== "object" || Array.isArray(expectation)) throw new Error("Expectation must be an object");
  const intent = intents.find((entry) => entry.name === expectation.intent);
  if (!intent) throw new Error("Expectation must declare a registered intent");
  for (const key of Object.keys(expectation)) if (!keys.includes(key)) throw new Error(`Unknown expectation key: ${key}`);
  for (const key of ["targetId", "term", "stage", "reason"]) {
    if (expectation[key] !== undefined && (typeof expectation[key] !== "string" || !expectation[key])) throw new Error(`Invalid ${key}`);
  }
  for (const slot of intent.requiredSlots.filter((key) => ["targetId", "term"].includes(key))) {
    if (!expectation[slot]) throw new Error(`Expectation ${intent.name} requires ${slot}`);
  }
  for (const key of countKeys) {
    if (expectation[key] !== undefined && (!Number.isSafeInteger(expectation[key]) || expectation[key] < 0)) throw new Error(`Invalid ${key}`);
  }
  for (const key of textKeys) if (expectation[key] !== undefined && !strings(list(expectation[key]))) throw new Error(`Invalid ${key}`);
  for (const key of ["sourceIds", "allowedSourceIds"]) {
    if (expectation[key] !== undefined && (!Array.isArray(expectation[key]) ||
      (expectation[key].length && !strings(expectation[key])) || new Set(expectation[key]).size !== expectation[key].length)) throw new Error(`Invalid ${key}`);
  }
  if (expectation.sourceGroups !== undefined && (!Array.isArray(expectation.sourceGroups) || !expectation.sourceGroups.length ||
    !expectation.sourceGroups.every(strings))) throw new Error("Invalid sourceGroups");
}

// Observations are trusted server-side facts, never fields read from a browser response.
export function validateResult(result, expectation, context, observations = {}) {
  validateExpectation(expectation);
  const sourceIds = Array.isArray(result?.sources) ? result.sources.map((source) => source.id) : [];
  const validation = validateNliResponse(result, context, {
    candidateSources: result?.intent === "answer_portfolio" ? sourceIds : undefined
  });
  const errors = [...validation.errors];
  if (!result || typeof result !== "object" || Array.isArray(result)) return errors;
  for (const key of ["intent", "targetId", "term"]) compare(key, result[key], expectation[key], errors);
  for (const key of [...countKeys, "stage", "reason"]) {
    if (expectation[key] === undefined) continue;
    const actual = observations[key];
    if (actual === undefined || actual === null || (countKeys.includes(key) && (!Number.isSafeInteger(actual) || actual < 0))) {
      errors.push(`${key} is unobserved`);
    } else compare(key, actual, expectation[key], errors);
  }
  if (expectation.sourceIds !== undefined && JSON.stringify(sourceIds) !== JSON.stringify(expectation.sourceIds)) {
    errors.push(`sourceIds expected "${expectation.sourceIds}", got "${sourceIds}"`);
  }
  for (const group of expectation.sourceGroups ?? []) {
    if (!group.some((id) => sourceIds.includes(id))) errors.push(`sourceGroups missing one of: ${group.join(", ")}`);
  }
  if (expectation.allowedSourceIds !== undefined) {
    for (const id of sourceIds) if (!expectation.allowedSourceIds.includes(id)) errors.push(`source ${id} is not allowed`);
  }
  for (const field of ["answer", "message", "response"]) {
    const text = field === "response" ? JSON.stringify(result) : String(result[field] ?? "");
    for (const required of list(expectation[`${field}Includes`])) if (!text.includes(required)) errors.push(`${field} does not include "${required}"`);
    for (const excluded of list(expectation[`${field}Excludes`])) if (text.includes(excluded)) errors.push(`${field} should not include "${excluded}"`);
  }
  return errors;
}

function compare(key, actual, expected, errors) {
  if (expected !== undefined && actual !== expected) errors.push(`${key} expected "${expected}", got "${actual}"`);
}
