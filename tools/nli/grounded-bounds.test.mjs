import assert from "node:assert/strict";
import test from "node:test";
import { buildGroundedRequestBlock } from "./context.mjs";
import { boundedCandidateSources, boundedConversation, boundedUtf8String } from "./grounded-bounds.mjs";

test("UTF8 bounds never split Unicode scalars and stay idempotent", () => {
  for (const bytes of [0, 1, 2, 3, 4, 479, 480, 2999, 3000]) {
    const text = boundedUtf8String("한😀".repeat(1000), bytes);
    assert.ok(Buffer.byteLength(text) <= bytes);
    assert.equal(text, Buffer.from(text).toString());
    assert.equal(text, boundedUtf8String(text, bytes));
    assert.ok(!text.includes("�"));
  }
});

test("candidate and history limits remain eight/3000 and six/480/2400", () => {
  const candidates = boundedCandidateSources(Array.from({ length: 20 }, (_, i) => ({
    id: `id-${i}`, evidence: "한".repeat(1000) + "REMOVED_SECRET", label: "😀".repeat(200)
  })));
  assert.equal(candidates.length, 8);
  assert.ok(candidates.every((card) => Buffer.byteLength(card.evidence) === 3000));
  assert.ok(candidates.every((card) => !card.evidence.includes("REMOVED_SECRET")));
  const history = boundedConversation(Array.from({ length: 10 }, () => ({ role: "user", text: "한".repeat(1000) })));
  assert.ok(history.length <= 6);
  assert.equal(history.reduce((sum, entry) => sum + Buffer.byteLength(entry.text), 0), 2400);
  assert.ok(history.every((entry) => Buffer.byteLength(entry.text) <= 480));
  const block = JSON.parse(buildGroundedRequestBlock({ candidateSources: candidates, history }));
  assert.deepEqual(block.candidateSources, candidates);
  assert.deepEqual(block.conversation, history);
});
