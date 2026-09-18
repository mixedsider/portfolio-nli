import test from "node:test";
import assert from "node:assert/strict";
import { validateCatalog, selectTests, parseArguments } from "../../tools/testing/catalog.mjs";

const entry = { path: "a.test.mjs", level: "unit", techniques: ["whitebox"], runner: "node" };
test("accepts an exact partition when every discovered test is classified", () => {
  // Given / When / Then
  assert.deepEqual(validateCatalog({ version: 1, tests: [entry], delegates: [] }, [entry.path]), [entry]);
});
for (const [name, entries, files] of [
  ["unclassified", [], [entry.path]],
  ["stale", [entry], []],
  ["overlap", [entry, entry], [entry.path]],
  ["invalid level", [{ ...entry, level: "smoke" }], [entry.path]],
  ["invalid technique", [{ ...entry, techniques: ["smoke"] }], [entry.path]]
]) test(`rejects catalog when ${name}`, () => {
  // Given / When / Then
  assert.throws(() => validateCatalog({ version: 1, tests: entries, delegates: [] }, files));
});
test("selects intersection when multiple filter axes are supplied", () => {
  // Given
  const entries = [entry, { ...entry, path: "b.test.mjs", level: "integration" }];
  // When
  const result = selectTests(entries, { level: "unit", runner: "node", technique: "whitebox" });
  // Then
  assert.deepEqual(result, [entry]);
});
for (const args of [["run"], ["run", "--all", "--level", "unit"], ["run", "--unknown"],
  ["run", "--level", "smoke"], ["run", "--runner", "node", "--runner", "node"]]) {
  test(`rejects invalid arguments ${args.join(" ")}`, () => {
    // Given / When / Then
    assert.throws(() => parseArguments(args));
  });
}
test("rejects an empty selection when filters do not match", () => {
  // Given / When / Then
  assert.throws(() => selectTests([entry], { level: "e2e" }));
});
test("parses run filters when supplied with output directory", () => {
  // Given / When / Then
  assert.deepEqual(parseArguments(["run", "--runner", "node", "--out-dir", "test-results/lane"]),
    { command: "run", runner: "node", outDir: "test-results/lane" });
});
test("counts a legacy test once when explicitly delegated to a browser entry", () => {
  // Given
  const browser = { path: "tests/browser/widget.spec.mjs", level: "integration", techniques: ["blackbox"], runner: "playwright" };
  const legacy = "tools/nli-widget.browser-test.mjs";
  // When
  const result = validateCatalog({ version: 1, tests: [browser], delegates: [{ path: legacy, to: browser.path, reason: "legacy wrapper" }] }, [legacy, browser.path]);
  // Then
  assert.deepEqual(result, [browser]);
});
