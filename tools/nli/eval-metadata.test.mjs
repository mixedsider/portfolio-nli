import test from "node:test";
import assert from "node:assert/strict";
import { evalFixture } from "./eval-fixture.mjs";
import { runChild } from "./eval-suites.mjs";
import { inspectPromptSizes } from "./eval-metadata.mjs";
import { ordinaryCases } from "./eval-workloads.mjs";

test("metadata CLI loads context and never sends inference", async () => {
  const f = await evalFixture();
  try {
    const before = f.state.calls.filter((row) => row.path.endsWith("chat/completions")).length;
    const child = await runChild(["tools/nli/eval-metadata.mjs"], { env: { ...process.env, ...f.env } });
    assert.equal(child.code, 0, child.stderr);
    const report = JSON.parse(child.stdout);
    assert.equal(report.rows.length, 6);
    assert.equal(report.inferenceCalls, 0);
    assert.equal(f.state.calls.filter((row) => row.path.endsWith("chat/completions")).length, before);
  } finally { await f.close(); }
});

test("tokenizer reports token count or explicit unavailable, never guessed counts", async () => {
  const f = await evalFixture();
  try {
    const calls = [];
    const report = await inspectPromptSizes(f.config, f.context, ordinaryCases(f.cases), async (url) => {
      calls.push(url);
      return { ok: true, status: 200, data: url.endsWith("/props") ? { default_generation_settings: { n_ctx: 12345 } } :
        url.endsWith("/apply-template") ? { prompt: "fixture-render" } : { tokens: [10, 20, 30] } };
    });
    assert.equal(report.loadedContextLength, 12345);
    assert.ok(report.rows.every((row) => row.renderedPromptTokens === 3));
    assert.equal(calls.length, 13);
    assert.ok(calls.every((url) => !url.includes("chat/completions")));
  } finally { await f.close(); }
});
