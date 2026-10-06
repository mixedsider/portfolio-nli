import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { matchesJsonSchema } from "./testing/json-schema.mjs";

const fixtureBytes = await readFile(new URL("../tests/fixtures/model-decision.original.schema.json", import.meta.url));
const original = JSON.parse(fixtureBytes);
const candidate = JSON.parse(await readFile(new URL("../nli/model-decision.schema.json", import.meta.url)));
const examples = [
  { intent: "navigate", confidence: 0.9, targetId: "projects" },
  { intent: "define_term", confidence: 0.9, term: "P95" },
  { intent: "answer_portfolio", confidence: 0.9, answer: "Supported answer.", sourceIds: ["project-catequest"] },
  { intent: "reject_out_of_scope", confidence: 0.9 }
];

function equivalent(value, expected, label) {
  const baseline = matchesJsonSchema(original, value);
  assert.equal(matchesJsonSchema(candidate, value), baseline, label);
  if (expected !== undefined) assert.equal(baseline, expected, label);
}

test("generation schema is exactly four closed intent-const branches with unchanged bounds", () => {
  assert.equal(candidate.type, "object");
  assert.equal(Object.hasOwn(candidate, "additionalProperties"), false);
  assert.equal(Object.hasOwn(candidate, "properties"), false);
  assert.equal(candidate.oneOf?.length, 4);
  assert.deepEqual(candidate.oneOf.map((branch) => branch.properties.intent.const), examples.map((entry) => entry.intent));
  for (const [index, branch] of candidate.oneOf.entries()) {
    const keys = Object.keys(examples[index]).sort();
    assert.equal(branch.type, "object");
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(Object.keys(branch.properties).sort(), keys);
    assert.deepEqual([...branch.required].sort(), keys);
    assert.deepEqual(branch.properties.intent, { type: "string", const: examples[index].intent });
    for (const key of keys.filter((key) => key !== "intent")) {
      assert.deepEqual(branch.properties[key], original.properties[key], key);
    }
  }
  function noLegacy(node) {
    if (!node || typeof node !== "object") return;
    for (const [key, value] of Object.entries(node)) {
      assert.equal(["allOf", "if", "then", "not"].includes(key), false, key);
      noLegacy(value);
    }
  }
  noLegacy(candidate);
});

test("original JSON fixture is immutable and byte-identical to the pre-union schema", () => {
  assert.equal(createHash("sha256").update(fixtureBytes).digest("hex"), "874e0c9e124dbf366cfb4e085b8648ffa70db77f7c838968c96e30575be31a98");
});

test("observed missing answer and navigate extra fields remain rejected", () => {
  equivalent({ intent: "answer_portfolio", confidence: 0.9, sourceIds: ["project-catequest"] }, false, "missing answer");
  equivalent({ ...examples[0], answer: "Unexpected answer.", sourceIds: ["project-catequest"] }, false, "navigate extra");
});

test("all 64 field-presence combinations for each of four intents preserve the accepted set", () => {
  const fields = { intent: "", confidence: 0.9, targetId: "projects", term: "P95", answer: "Supported.", sourceIds: ["project-catequest"] };
  const keys = Object.keys(fields);
  for (const example of examples) {
    for (let mask = 0; mask < 64; mask += 1) {
      const value = Object.fromEntries(keys.filter((_, bit) => mask & (1 << bit))
        .map((key) => [key, key === "intent" ? example.intent : fields[key]]));
      equivalent(value, Object.keys(value).sort().join() === Object.keys(example).sort().join(), `${example.intent}:${mask}`);
    }
  }
});

test("valid examples and invalid types, bounds, confidence, sources, roots and extras are equivalent", () => {
  for (const example of examples) {
    equivalent(example, true, example.intent);
    for (const confidence of [0, 1]) equivalent({ ...example, confidence }, true, "confidence boundary");
    for (const confidence of [-0.001, 1.001, "0.9", null, true, [], {}]) {
      equivalent({ ...example, confidence }, false, "invalid confidence");
    }
    for (const intent of ["summarize_project", "", null, 1, [], {}]) equivalent({ ...example, intent }, false, "invalid intent");
    equivalent({ ...example, extra: null }, false, "extra property");
    for (const key of Object.keys(example)) {
      for (const value of [null, false, 3, {}, []]) {
        if (key === "confidence" && value === 3) continue;
        equivalent({ ...example, [key]: value }, false, `invalid ${key}`);
      }
    }
  }
  for (const value of [null, true, false, 0, 1, "", "{}", [], [examples[0]]]) equivalent(value, false, "nonobject");
  for (const [index, key, limit] of [[0, "targetId", 128], [1, "term", 128], [2, "answer", 4000]]) {
    for (const length of [0, 1, limit, limit + 1]) {
      equivalent({ ...examples[index], [key]: "x".repeat(length) }, length > 0 && length <= limit, `${key}:${length}`);
    }
  }
  for (const sources of [[], Array.from({ length: 7 }, (_, i) => `source-${i}`), ["duplicate", "duplicate"], [""], ["x".repeat(129)], [null], [1], [[]], [{}], "source"]) {
    equivalent({ ...examples[2], sourceIds: sources }, false, "invalid sources");
  }
  for (const sources of [["x"], ["x".repeat(128)], Array.from({ length: 6 }, (_, i) => `source-${i}`)]) {
    equivalent({ ...examples[2], sourceIds: sources }, true, "source boundary");
  }
});

test("schema lengths count Unicode code points, not UTF-16 units or graphemes", () => {
  assert.equal(matchesJsonSchema({ type: "string", maxLength: 1 }, "\u{1f600}"), true);
  assert.equal(matchesJsonSchema({ type: "string", maxLength: 1 }, "e\u0301"), false);
  for (const [index, key, limit] of [[0, "targetId", 128], [1, "term", 128], [2, "answer", 4000]]) {
    equivalent({ ...examples[index], [key]: "\u{1f600}".repeat(limit) }, true, `${key}:astral boundary`);
    equivalent({ ...examples[index], [key]: "\u{1f600}".repeat(limit + 1) }, false, `${key}:astral overflow`);
  }
  equivalent({ ...examples[2], sourceIds: ["\u{1f600}".repeat(128)] }, true, "astral source boundary");
  equivalent({ ...examples[2], sourceIds: ["\u{1f600}".repeat(129)] }, false, "astral source overflow");
});
