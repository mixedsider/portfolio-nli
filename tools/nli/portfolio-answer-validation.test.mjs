import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { buildEvidenceIndex } from "./evidence.mjs";
import { loadNliContext } from "./context.mjs";
import { canonicalizeModelResponse, validateNliResponse, validatePortfolioAnswerCandidate } from "./validation.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
const context = await loadNliContext(root);
const evidenceIndex = buildEvidenceIndex(context);

test("answer_portfolio rejects unsupported prose even when source IDs are valid candidates", () => {
  const candidateSources = selectedSources(["project-makertion-db", "project-makertion-cache"]);
  const candidate = {
    intent: "answer_portfolio",
    confidence: 0.91,
    answer: "NASA, Go, Kubernetes leadership claims are the strongest portfolio evidence.",
    sourceIds: ["project-makertion-db"]
  };

  const validation = validatePortfolioAnswerCandidate(candidate, context, candidateSources);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /answer must be supported by selected sources/);
  assert.equal(canonicalizeModelResponse(candidate, context, { candidateSources }), null);
});

test("answer_portfolio rejects mixed grounded and hallucinated claims", () => {
  const candidateSources = selectedSources(["project-makertion-cache"]);
  const candidate = {
    intent: "answer_portfolio",
    confidence: 0.91,
    answer:
      "Makertion cache reduced DB load and P95 from 47.28ms to 8.32ms. NASA Kubernetes Go leadership is also proven.",
    sourceIds: ["project-makertion-cache"]
  };

  const validation = validatePortfolioAnswerCandidate(candidate, context, candidateSources);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /answer must be supported by selected sources/);
  assert.equal(canonicalizeModelResponse(candidate, context, { candidateSources }), null);
});

test("answer_portfolio rejects mixed grounded and hallucinated clauses joined by and", () => {
  assertRejectsJoinedMixedClaim(
    "Makertion cache reduced DB load and P95 from 47.28ms to 8.32ms and NASA Kubernetes Go leadership is also proven."
  );
});

test("answer_portfolio rejects mixed grounded and hallucinated clauses joined by semicolon", () => {
  assertRejectsJoinedMixedClaim(
    "Makertion cache reduced DB load and P95 from 47.28ms to 8.32ms; NASA Kubernetes Go leadership is also proven."
  );
});

test("answer_portfolio rejects mixed grounded and hallucinated clauses joined by comma", () => {
  assertRejectsJoinedMixedClaim(
    "Makertion cache reduced DB load and P95 from 47.28ms to 8.32ms, NASA Kubernetes Go leadership is also proven."
  );
});

test("answer_portfolio rejects unsupported anchor islands after grounded clauses", () => {
  for (const joiner of ["그리고", "하지만", "또한", "plus", "while", "but", "+", " "]) {
    assertRejectsJoinedMixedClaim(
      `Makertion cache reduced DB load and P95 from 47.28ms to 8.32ms ${joiner} NASA Kubernetes Go leadership is also proven.`
    );
  }
});

test("canonical answer_portfolio rejects joined mixed grounded and hallucinated clauses", () => {
  const candidateSources = selectedSources(["project-makertion-cache"]);
  const canonical = {
    intent: "answer_portfolio",
    confidence: 0.91,
    answer: "Makertion cache reduced DB load and P95 from 47.28ms to 8.32ms and NASA Kubernetes Go leadership is also proven.",
    sources: [{ id: "project-makertion-cache", label: context.targetById.get("project-makertion-cache").label }]
  };

  const validation = validateNliResponse(canonical, context, { candidateSources });

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /answer must be supported by selected sources/);
});

test("answer_portfolio rejects short latin substring support", () => {
  const candidateSources = [{ id: "project-makertion-db", evidence: "shared_buffers memory" }];
  const candidate = {
    intent: "answer_portfolio",
    confidence: 0.91,
    answer: "are memory",
    sourceIds: ["project-makertion-db"]
  };

  const validation = validatePortfolioAnswerCandidate(candidate, context, candidateSources);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /answer must be supported by selected sources/);
});

test("answer_portfolio rejects concise mixed technical anchors that selected evidence does not support", () => {
  const candidateSources = [{ id: "project-makertion-db", evidence: "P95 shared_buffers memory" }];
  const candidate = {
    intent: "answer_portfolio",
    confidence: 0.91,
    answer: "P95 shared_buffers Kubernetes",
    sourceIds: ["project-makertion-db"]
  };

  const validation = validatePortfolioAnswerCandidate(candidate, context, candidateSources);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /answer must be supported by selected sources/);
});

test("answer_portfolio accepts concise technical anchors when selected evidence supports them", () => {
  const candidateSources = [{ id: "project-makertion-db", evidence: "P95 shared_buffers memory" }];
  const candidate = {
    intent: "answer_portfolio",
    confidence: 0.91,
    answer: "P95 shared_buffers",
    sourceIds: ["project-makertion-db"]
  };

  assert.deepEqual(validatePortfolioAnswerCandidate(candidate, context, candidateSources), { ok: true, errors: [] });
});

test("answer_portfolio does not expand explicit empty candidate evidence", () => {
  const candidateSources = [{ id: "project-makertion-db", evidence: "" }];
  const candidate = {
    intent: "answer_portfolio",
    confidence: 0.91,
    answer: "P95 179.10ms",
    sourceIds: ["project-makertion-db"]
  };

  const validation = validatePortfolioAnswerCandidate(candidate, context, candidateSources);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /answer must be supported by selected sources/);
});

test("answer_portfolio accepts grounded Korean free prose without exact evidence prose", () => {
  const candidateSources = selectedSources(["project-makertion-cache"]);
  const candidate = {
    intent: "answer_portfolio",
    confidence: 0.88,
    answer: "Main 홈페이지 캐싱은 P95 응답 시간을 47.28ms에서 8.32ms로 줄이고 DB 부하를 낮춘 경험입니다.",
    sourceIds: ["project-makertion-cache"]
  };

  assert.deepEqual(validatePortfolioAnswerCandidate(candidate, context, candidateSources), { ok: true, errors: [] });
});

function selectedSources(sourceIds) {
  const sourceIdSet = new Set(sourceIds);
  return evidenceIndex.filter((candidate) => sourceIdSet.has(candidate.id));
}

function assertRejectsJoinedMixedClaim(answer) {
  const candidateSources = selectedSources(["project-makertion-cache"]);
  const candidate = {
    intent: "answer_portfolio",
    confidence: 0.91,
    answer,
    sourceIds: ["project-makertion-cache"]
  };

  const validation = validatePortfolioAnswerCandidate(candidate, context, candidateSources);

  assert.equal(validation.ok, false);
  assert.match(validation.errors.join("\n"), /answer must be supported by selected sources/);
  assert.equal(canonicalizeModelResponse(candidate, context, { candidateSources }), null);
}
