import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

const cli = (...args) => spawnSync(process.execPath, ["tools/nli-test.mjs", ...args], { encoding: "utf8" });

test("existing CLI defaults, path guards, options and empty selection", () => {
  assert.equal(cli().status, 0);
  for (const args of [["--unknown"], ["--cases"], ["--cases", "/tmp/cases.json"],
    ["--cases", "../cases.json"], ["--kind", "other"], ["--timeout-ms", "0"],
    ["--min-pass-rate", "1.1"], ["--live"]]) assert.notEqual(cli(...args).status, 0, args.join(" "));
});

test("mode overrides replace, never merge, and every supplied mode is validated", async () => {
  const { expectationFor, validateFixture, selectTestCases } = await import("./nli/test-fixtures.mjs");
  const item = { kind: "success", message: "summary", expect: { intent: "answer_portfolio", sourceIds: ["about"] },
    expectByMode: { local: { intent: "introduce_profile" }, fake: { intent: "navigate", targetId: "about" } } };
  assert.deepEqual(expectationFor(item, "local"), { intent: "introduce_profile" });
  assert.deepEqual(expectationFor(item, "fake"), item.expectByMode.fake);
  assert.deepEqual(expectationFor(item, "live"), item.expect);
  assert.throws(() => expectationFor(item, "unknown"));
  assert.throws(() => validateFixture({ cases: [item, item] }), /duplicate/);
  assert.throws(() => selectTestCases([item], "failure"), /No failure/);
  assert.throws(() => selectTestCases([], null), /No cases/);
  for (const override of [{}, null, [], { intent: ["navigate", "answer_portfolio"] },
    { intent: "navigate", lfmCalls: -1 }, { intent: "navigate", answerExcludes: [12] },
    { intent: "navigate", sourceGroups: [[]] }, { intent: "navigate", typo: true }]) {
    assert.throws(() => validateFixture({ cases: [{ ...item, expectByMode: { live: override } }] }));
  }
  assert.throws(() => validateFixture({ cases: [{ ...item, expectByMode: { typo: item.expect } }] }));
});

test("task11 modules remain within 250 physical lines and fixtures parse", async (t) => {
  const helpers = (await readdir("tools/nli")).filter((name) => name.startsWith("test-") && name.endsWith(".mjs"));
  for (const file of ["tools/nli-test.mjs", "tools/nli-test.test.mjs", ...helpers.map((name) => `tools/nli/${name}`)]) {
    const lines = (await readFile(file, "utf8")).trimEnd().split("\n").length;
    assert.ok(lines <= 250, `${file}: ${lines}`);
    t.diagnostic(`${file}: ${lines} physical lines`);
  }
  for (const file of ["nli/live-test-cases.json", "nli/cascade-test-cases.json"]) {
    assert.ok(JSON.parse(await readFile(file, "utf8")).cases.length > 0);
  }
});

test("unknown counters are not zero and exact source order remains strict", async () => {
  const { validateResult } = await import("./nli/test-expectations.mjs");
  const { loadNliContext, resolveNliRequest } = await import("./nli-gateway.mjs");
  const context = await loadNliContext();
  const result = await resolveNliRequest("도움말", context, { useModel: false });
  const expect = { intent: result.intent, lfmCalls: 0, qwenCalls: 0 };
  assert.match(validateResult(result, expect, context).join(), /unobserved/);
  assert.deepEqual(validateResult(result, expect, context, { lfmCalls: 0, qwenCalls: 0 }), []);
  assert.match(validateResult(result, expect, context, { lfmCalls: 1, qwenCalls: 0 }).join(), /lfmCalls/);
});
