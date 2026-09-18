import assert from "node:assert/strict";
import test from "node:test";
import { createModelAdmission } from "./model-admission.mjs";

test("shared admission is atomic, fail-fast, capped at four and releases idempotently", () => {
  const admission = createModelAdmission(20);
  const releases = ["a", "a", "b", "b"].map((key) => admission.acquire(key, 20));
  assert.equal(admission.active, 4);
  assert.equal(admission.acquire("c", 4), null);
  releases[0]();
  releases[0]();
  assert.equal(admission.active, 3);
  assert.equal(admission.acquire("b", 2), null);
  assert.equal(admission.active, 3);
  releases.slice(1).forEach((release) => release());
  assert.equal(admission.active, 0);
  assert.equal(admission.activeFor("a"), 0);
  const release = admission.acquire("b", 1);
  assert.equal(admission.acquire("b", 1), null);
  release();
});

test("invalid admission limits fail before counters change", () => {
  for (const limit of [0, -1, Infinity, NaN, 1.5]) assert.throws(() => createModelAdmission(limit));
  const admission = createModelAdmission();
  assert.throws(() => admission.acquire("a", 0));
  assert.equal(admission.active, 0);
});
