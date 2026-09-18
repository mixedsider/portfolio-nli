import { readNliHistory } from "./http.mjs";
import { isPromptInjectionAttempt } from "./router.mjs";
import { resolveLocalFastPath } from "./local-fast-path.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";

export function expectedRouting(item, context) {
  let history;
  try { history = readNliHistory(item.history); }
  catch { return [{ stage: "security", reason: "invalid_history", lfmCalls: 0, qwenCalls: 0 }]; }
  const rawMessage = String(item.message ?? "");
  const message = rawMessage.trim();
  if (!message || isPromptInjectionAttempt(message)) return [{ stage: "security", reason: "rejected", lfmCalls: 0, qwenCalls: 0 }];
  const scoped = { ...context, history, currentTargetId: context.targetById.has(item.currentTargetId) ? item.currentTargetId : null };
  if (resolveLocalFastPath(rawMessage, scoped)) return [{ stage: "fast_path", reason: "exact_command", lfmCalls: 0, qwenCalls: 0 }];
  const prepared = prepareGroundedRequest(message, scoped);
  const lfm = { stage: "lfm", reason: "accepted", lfmCalls: 1, qwenCalls: 0 };
  return prepared.obligations.kind === "ordinary" ? [lfm] : [lfm, { stage: "qwen", reason: "accepted", lfmCalls: 1, qwenCalls: 1 }];
}

export function assessRouting(cases, rows, context) {
  const errors = [];
  const expected = [];
  if (!cases.length || cases.some((item) => typeof item.id !== "string" || !item.id) ||
    new Set(cases.map((item) => item.id)).size !== cases.length) errors.push("invalid_routing_fixture_ids");
  if (rows.length !== cases.length || rows.some((row) => !cases.some((item) => item.id === row.fixtureId))) errors.push("routing_coverage_mismatch");
  for (const item of cases) {
    const alternatives = expectedRouting(item, context);
    expected.push({ fixtureId: item.id, alternatives });
    const observations = rows.filter((row) => row.fixtureId === item.id);
    if (observations.length !== 1 || !alternatives.some((expectation) =>
      Object.entries(expectation).every(([key, value]) => observations[0][key] === value))) errors.push(`${item.id}:model_classification_failed`);
  }
  return { ok: errors.length === 0, errors, expected };
}
