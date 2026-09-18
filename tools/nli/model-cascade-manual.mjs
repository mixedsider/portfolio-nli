import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { createModelCascade } from "./model-cascade.mjs";
import { context, comparison, request } from "./model-cascade-fixtures.mjs";
import { loopbackFixture } from "./model-cascade-loopback.mjs";

const f = await loopbackFixture();
const events = [];
const cascade = createModelCascade(f.config, { context, observer: (event) => events.push(event) });
const results = [];
try {
  for (const [id, message, complete, expected] of [
    ["ordinary-low-confidence", "P95가 뭐야?", false, "lfm"],
    ["difficult-complete-lfm", comparison, true, "lfm"],
    ["difficult-partial-escalates", comparison, false, "qwen"]
  ]) {
    f.state.lfmComplete = complete;
    const before = [f.calls("lfm").length, f.calls("qwen").length, f.calls("qwen", "/apply-template").length];
    const input = request(message, { deadlineAt: performance.now() + 13000 });
    const result = await cascade.resolve(input);
    assert.equal(result.stage, expected);
    assert.equal(f.calls("lfm").at(-1).payload.messages[1].content, input.prepared.groundedRequestBlock);
    const counts = { lfm: f.calls("lfm").length - before[0], qwen: f.calls("qwen").length - before[1],
      renders: f.calls("qwen", "/apply-template").length - before[2] };
    assert.deepEqual(counts, { lfm: 1, qwen: expected === "qwen" ? 1 : 0, renders: expected === "qwen" ? 18 : 0 });
    results.push({ fixtureId: id, stage: result.stage, counts });
  }
  f.state.reasoning = true;
  assert.equal((await cascade.resolve(request(comparison, { deadlineAt: performance.now() + 13000 }))).reason, "reasoning_violation");
  const before = f.calls("qwen").length;
  assert.equal((await cascade.resolve(request(comparison, { deadlineAt: performance.now() + 13000 }))).reason, "qwen_unverified");
  assert.equal(f.calls("qwen").length, before);
  assert.equal(cascade.admission.active, 0);
  assert.ok(!JSON.stringify(events).includes("NEVER_LOG_THIS"));
  assert.ok(!JSON.stringify(events).includes("CateQuest"));
  results.push({ fixtureId: "reasoning-invalidates-process", invalidated: true, active: cascade.admission.active });
} finally {
  await f.close();
}
await assert.rejects(access(f.directory));
console.log(JSON.stringify({ status: "offline-complete", endpoints: "two ephemeral loopback HTTP servers",
  receipt: "temporary fixture-only; removed", results, cleanup: "servers closed; directory removed; permits zero" }, null, 2));
