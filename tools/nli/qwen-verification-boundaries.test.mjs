import assert from "node:assert/strict";
import { test } from "node:test";
import { createModelAdmission } from "./model-admission.mjs";
import { withVerificationBudget, verificationRequest } from "./qwen-verification-http.mjs";
import { inspectTemplate, validReceipt, MAX_RECEIPT_AGE_MS } from "./qwen-verification-proof.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

const inputs = { url: "http://127.0.0.1:1/v1/chat/completions", settings: { maxConcurrentRequests: 1, maxResponseBytes: 64 } };
const counters = () => ({ metadataCalls: 0, inferenceCalls: 0 });

test("metadata uses ONE capped deadline and no permit survives a signal-ignoring header stall", async () => {
  let now = 0;
  const admission = createModelAdmission(1);
  const count = counters();
  const fetchImpl = async () => { now += 501; return Response.json({}); };
  await assert.rejects(withVerificationBudget({ budgetMs: 1000, deadlineAt: 900, now: () => now }, async (scope) => {
    const request = verificationRequest(inputs, { admission, fetchImpl }, scope, count);
    await request("http://fixture/props");
    await request("http://fixture/apply-template", {});
  }), /timeout/);
  assert.equal(now, 1002);
  assert.equal(count.metadataCalls, 2);
  assert.equal(admission.active, 0);
  await assert.rejects(withVerificationBudget({ budgetMs: 20 }, (scope) =>
    verificationRequest(inputs, { admission, fetchImpl: () => new Promise(() => {}) }, scope, counters())("http://fixture/props")), /timeout/);
  assert.equal(admission.active, 0);
});

test("body abort, malformed JSON, non-2xx, oversized streams and late headers clean up", async () => {
  for (const makeResponse of [() => new Response("SECRET"), () => new Response("SECRET", { status: 500 }),
    () => new Response("x".repeat(65))]) {
    const admission = createModelAdmission(1);
    await assert.rejects(withVerificationBudget({ budgetMs: 1000 }, (scope) =>
      verificationRequest(inputs, { admission, fetchImpl: async () => makeResponse() }, scope, counters())("http://fixture/props")));
    assert.equal(admission.active, 0);
  }
  let cancelled = false;
  let bodyStarted;
  const started = new Promise((resolve) => { bodyStarted = resolve; });
  const controller = new AbortController();
  const admission = createModelAdmission(1);
  const fetchImpl = async () => new Response(new ReadableStream({ pull() { bodyStarted(); }, cancel() { cancelled = true; } }));
  const pending = withVerificationBudget({ budgetMs: 1000, signal: controller.signal }, (scope) =>
    verificationRequest(inputs, { admission, fetchImpl }, scope, counters())("http://fixture/props"));
  await started;
  controller.abort();
  await assert.rejects(pending, /aborted/);
  assert.equal(cancelled, true);
  assert.equal(admission.active, 0);
  let headers;
  const late = new Promise((resolve) => { headers = resolve; });
  await assert.rejects(withVerificationBudget({ budgetMs: 20 }, (scope) =>
    verificationRequest(inputs, { admission, fetchImpl: () => late }, scope, counters())("http://fixture/props")), /timeout/);
  cancelled = false;
  headers(new Response(new ReadableStream({ cancel() { cancelled = true; } })));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(cancelled, true);
  assert.equal(admission.active, 0);
});

test("closed empty assistant prefix is required, not just a closing marker", () => {
  for (const prompt of [null, "<think>\n</think>", "<|im_start|>assistant\n<think>",
    "<|im_start|>assistant\n<think>SECRET</think>", "<|im_start|>assistant\nThink step by step<think></think>",
    "<|im_start|>assistant\n<think></think>reasoning instructions"]) assert.throws(() => inspectTemplate(prompt));
  assert.equal(inspectTemplate("system text<|im_start|>assistant\n<think>\n\n</think>\n\n").emptyClosedThink, true);
});

test("24-hour boundary is inclusive; incomplete/duplicate matrices and false zero cannot pass", () => {
  const matrix = Array.from({ length: 18 }, (_, i) => ({ item: { id: `case-${i % 6}` }, repeat: Math.floor(i / 6) }));
  const inputs = { binding: { endpoint: "fixture" }, matrix };
  const receipt = { version: 1, verificationPolicy: VERIFICATION_POLICY, endpoint: "fixture", checkedAt: new Date(0).toISOString(), probeCount: 18,
    returnedModelId: "fixture", proof: { returnedModelId: "fixture", modelIdentitySha256: "a".repeat(64), buildInfoSha256: "b".repeat(64),
      chatTemplateSha256: "c".repeat(64), templates: Array(18).fill({ emptyClosedThink: true, renderedSha256: "d".repeat(64), suffixSha256: "e".repeat(64) }) }, reasoningAccounting: "unavailable",
    results: matrix.map(({ item, repeat }) => ({ caseId: item.id, repeat, ok: true, finishReason: "stop", returnedModelId: "fixture",
      reasoningPresent: false, reasoningBytes: 0, reasoningAccounting: "unavailable" })) };
  assert.equal(validReceipt(receipt, inputs, MAX_RECEIPT_AGE_MS), true);
  assert.equal(validReceipt(receipt, inputs, MAX_RECEIPT_AGE_MS + 1), false);
  assert.equal(validReceipt({ ...receipt, reasoningAccounting: "zero" }, inputs, 0), false);
  assert.equal(validReceipt({ ...receipt, results: receipt.results.slice(1) }, inputs, 0), false);
  receipt.results[1] = receipt.results[0];
  assert.equal(validReceipt(receipt, inputs, 0), false);
});
