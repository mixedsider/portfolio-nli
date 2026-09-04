# NLI Gateway Routing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (\`- [ ]\`) syntax for tracking.

**Goal:** Restore deterministic project-scoped NLI summary, explanation, and navigation without weakening Gateway validation and prompt-safety controls.

**Architecture:** Keep \`summarize_project\` as a local-router response. Route selection retains match provenance and ranks direct section/project matches above generic pages. The model remains limited to validated grounded answers. Evidence ranking normalizes mixed Korean/Latin references and reserves current-project scope before its global cutoff.

**Tech Stack:** Node.js ESM, \`node:test\`, JSON fixtures and schemas, optional Playwright browser test.

**Spec:** \`docs/superpowers/specs/2026-09-03-nli-gateway-routing-design.md\`

## Global Constraints

- Do not modify portfolio content, images, or unrelated UI.
- Do not add \`summarize_project\` to model-proposal schema or prompt.
- Preserve model proposal validation and prevent it from replacing a known local target.
- Use \`C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe\` for Node commands.
- Begin every production behavior change with a focused failing test.

---

### Task 1: Deterministic named-project route precedence

**Files:**

- Modify: \`tools/nli-router.test.mjs\`
- Modify: \`tools/nli/router.mjs\`
- Modify: \`tools/nli/routing-vocabulary.mjs\`

**Interfaces:**

- Consumes: route target \`type\`, \`label\`, \`aliases\`, \`project\`.
- Produces: \`resolveLocally(message, context)\` with existing \`summarize_project\`, \`summarize_section\`, or \`navigate\` responses.

- [ ] **Step 1: Add the failing router cases.**

~~~js
test("explicit project and section phrases retain their targets", () => {
  for (const [message, intent, targetId] of [
    ["CateQuest 프로젝트 요약해줘", "summarize_project", "project-catequest"],
    ["Bookking 프로젝트로 이동해줘", "navigate", "project-bookking"],
    ["오늘의 OTT 프로젝트 요약해줘", "summarize_project", "project-ott"],
    ["오늘의 OTT 통합 API 사례 설명해줘", "summarize_section", "project-ott-api"]
  ]) {
    const result = resolveLocally(message, fullContext);
    assert.equal(result.intent, intent);
    assert.equal(result.targetId, targetId);
  }
});
~~~

- [ ] **Step 2: Verify that the regression test fails.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/nli-router.test.mjs
~~~

Expected: current results include a generic-page navigation, an out-of-scope rejection, and a project-root request collapsed into a child section.

- [ ] **Step 3: Make route candidates match-aware.**

In \`tools/nli/router.mjs\`, replace the one-value \`findBestRoute()\` result with candidates carrying direct label/alias score, project-association score, type, and source order. Select candidates by match rank before score:

~~~js
function compareRouteCandidates(left, right) {
  return right.matchRank - left.matchRank || right.score - left.score || left.order - right.order;
}
~~~

Give direct section matches rank 4, direct project matches rank 3, project-associated sections rank 2, and pages rank 1. For a project-root wording such as \`오늘의 OTT 프로젝트\`, ignore child sections matched only through \`target.project\`. Process explicit named-project summary/navigation before skill-experience handling.

- [ ] **Step 4: Add only the requested phrase variants.**

Add \`설명\`, \`소개\`, \`핵심\`, \`간추려\` to the project-summary path and \`데려가\`, \`이동시켜\` to explicit named-project navigation. Do not broaden generic page or skill vocabularies.

- [ ] **Step 5: Verify focused behavior.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/nli-router.test.mjs
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tools/nli-test.mjs --mode local
~~~

Expected: all router tests and local fixtures pass.

- [ ] **Step 6: Commit this focused change.**

~~~powershell
git add tools/nli-router.test.mjs tools/nli/router.mjs tools/nli/routing-vocabulary.mjs
git commit -m "fix: prioritize explicit project routes"
~~~

### Task 2: Alias coverage and local/model contract alignment

**Files:**

- Modify: \`nli/routes.json\`
- Modify: \`nli/test-cases.json\`
- Modify: \`nli/live-test-cases.json\`
- Modify: \`nli/intents.json\`
- Modify: \`nli/system-prompt.md\`
- Modify: \`tools/nli-schema-contract.test.mjs\`
- Modify: \`tools/nli-gateway-boundaries.test.mjs\`

**Interfaces:**

- Consumes: \`tools/nli-test.mjs\` fixtures and model proposal schema.
- Produces: local-only \`summarize_project\` behavior; the model only proposes \`navigate\`, \`define_term\`, \`answer_portfolio\`, or \`reject_out_of_scope\`.

- [ ] **Step 1: Add failing alias and contract tests.**

Add fixture coverage for the project summary/navigation patterns and aliases \`Cate Quest\`, \`케이트퀘스트\`, \`북킹\`, \`부킹\`, \`오늘의OTT\`, \`오늘의 오티티\`, \`오티티\`, and \`메이커션\`. Assert schema rejection of a model \`summarize_project\` proposal while preserving it in local intent documentation.

~~~js
assert.equal(matchesJsonSchema(modelDecisionSchema, {
  intent: "summarize_project", confidence: 0.9, targetId: "project-catequest"
}), false);
~~~

- [ ] **Step 2: Verify the added coverage fails.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/nli-schema-contract.test.mjs tools/nli-gateway-boundaries.test.mjs
~~~

Expected: aliases and direct-project fixture cases are absent.

- [ ] **Step 3: Add aliases and deterministic fixtures.**

Update each matching \`aliases\` array in \`nli/routes.json\`; add exact expected \`intent\` and \`targetId\` cases to both fixture files. Keep \`nli/model-decision.schema.json\` unchanged: it already correctly excludes \`summarize_project\`. Clarify \`nli/intents.json\` and \`nli/system-prompt.md\` so they cannot imply that the model owns local project summaries.

- [ ] **Step 4: Prove a conflicting model cannot override a named local route.**

~~~js
const result = await resolveNliRequest("CateQuest 프로젝트로 이동해줘", context, {
  modelClient: async () => ({ intent: "navigate", confidence: 0.99, targetId: "projects" })
});
assert.equal(result.targetId, "project-catequest");
~~~

- [ ] **Step 5: Run the contract and fake-model suites.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/nli-schema-contract.test.mjs tools/nli-gateway-boundaries.test.mjs
& 'C:\Users\CodexAgent\.cache\codex-primary-runtime\dependencies\node\bin\node.exe' tools/nli-test.mjs --mode fake
~~~

Expected: 100% pass rate.

- [ ] **Step 6: Commit aliases and contract fixtures.**

~~~powershell
git add nli/routes.json nli/test-cases.json nli/live-test-cases.json nli/intents.json nli/system-prompt.md tools/nli-schema-contract.test.mjs tools/nli-gateway-boundaries.test.mjs
git commit -m "test: cover explicit project NLI contract"
~~~

### Task 3: Named and current-project evidence retrieval

**Files:**

- Modify: \`tools/nli/evidence.test.mjs\`
- Modify: \`tools/nli/evidence-cards.mjs\`
- Modify: \`tools/nli/evidence-ranking.mjs\`

**Interfaces:**

- Consumes: \`retrieveEvidenceCandidates(index, { message, history, currentTargetId })\`.
- Produces: no more than eight public candidates, preserving a named project or valid current-project scope.

- [ ] **Step 1: Add failing evidence tests.**

~~~js
const catequest = candidateIds(retrieveEvidenceCandidates(index, { message: "CateQuest를 요약해줘" }));
assert.ok(catequest.some((id) => id.startsWith("project-catequest")));

const scoped = candidateIds(retrieveEvidenceCandidates(index, {
  message: "이 프로젝트에서 비용은 어떻게 줄였어?",
  currentTargetId: "project-makertion"
}));
assert.ok(scoped.includes("project-makertion-cost"));
~~~

Repeat the named-target assertion for \`Bookking의\`, \`Cate Quest\`, and \`오늘의OTT\`.

- [ ] **Step 2: Verify the evidence test is red.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/nli/evidence.test.mjs
~~~

Expected: particle-attached Latin names or a project-root follow-up omit the required candidate.

- [ ] **Step 3: Normalize the query tokens without fuzzy matching.**

In \`tokenizeEvidence\` / \`searchTerms\`, retain existing terms, add compact equivalents, and split a leading Latin word from attached Korean particles:

~~~js
const latinPrefix = token.match(/^([a-z0-9+#.]+)[\uAC00-\uD7A3]+$/iu)?.[1];
if (latinPrefix) terms.add(latinPrefix.toLowerCase());
~~~

Do not reduce the two-character minimum and do not add edit-distance matching.

- [ ] **Step 4: Reserve current target scope before global cutoff.**

Use each card’s existing \`scopeKey\`: for a project, prioritize all cards in that scope; for a section, prioritize the exact section plus its scope. Preserve technical-anchor and optimization-evidence filters and only then slice to \`MAX_EVIDENCE_CANDIDATES\`.

- [ ] **Step 5: Verify evidence and grounded-Gateway safety.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/nli/evidence.test.mjs tools/nli-grounded-gateway.test.mjs
~~~

Expected: new candidate tests pass and existing candidate-source validation remains green.

- [ ] **Step 6: Commit retrieval changes.**

~~~powershell
git add tools/nli/evidence.test.mjs tools/nli/evidence-cards.mjs tools/nli/evidence-ranking.mjs
git commit -m "fix: retain scoped NLI evidence candidates"
~~~

### Task 4: Stable Gateway errors and accurate widget messages

**Files:**

- Modify: \`tools/nli-gateway.test.mjs\`
- Modify: \`tools/nli-gateway.mjs\`
- Modify: \`tools/nli/response-contract-validation.mjs\`
- Modify: \`nli-widget.js\`
- Modify: \`tools/nli-widget.browser-test.mjs\`

**Interfaces:**

- Consumes: HTTP validation errors and upstream model failures.
- Produces: Gateway-owned \`errorCode\` and \`requestId\` on rejection responses; widget messages that distinguish a temporary upstream response from a connection failure.

- [ ] **Step 1: Add failing HTTP and widget cases.**

Assert \`INVALID_REQUEST\`, \`UNSUPPORTED_MEDIA_TYPE\`, \`REQUEST_TOO_LARGE\`, \`RATE_LIMITED\`, \`ORIGIN_NOT_ALLOWED\`, and \`UPSTREAM_UNAVAILABLE\` on their matching responses. In the browser test route, return HTTP 503 with \`{ intent: \"reject_out_of_scope\", confidence: 1, errorCode: \"UPSTREAM_UNAVAILABLE\", requestId: \"test\", message: \"잠시 후 다시 시도해주세요.\" }\` and assert that exact user message renders.

- [ ] **Step 2: Verify the Gateway test fails.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/nli-gateway.test.mjs
~~~

Expected: current responses have no \`errorCode\` or \`requestId\`.

- [ ] **Step 3: Build Gateway-owned failure responses.**

In \`tools/nli-gateway.mjs\`, add a private helper that uses \`crypto.randomUUID()\` and never accepts model-controlled error metadata:

~~~js
function gatewayErrorResponse(errorCode, message) {
  return { ...rejectResponse(message), errorCode, requestId: randomUUID() };
}
~~~

Map request-boundary failures to the listed codes. When a model failure has no deterministic fallback, return \`UPSTREAM_UNAVAILABLE\`; otherwise retain the existing trusted local fallback. Extend canonical validation only to allow these two fields on Gateway-generated rejections.

- [ ] **Step 4: Parse safe JSON error bodies for any status.**

In \`nli-widget.js\`, always attempt \`response.json()\` for non-2xx responses; display a nonempty returned message, including 5xx. Show “Gateway에 연결할 수 없습니다” only if no valid JSON error body exists.

- [ ] **Step 5: Run protocol and browser coverage.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/nli-gateway.test.mjs tools/nli-protocol.test.mjs tools/nli-widget.browser-test.mjs
~~~

Expected: Gateway and protocol tests pass; browser coverage passes when configured or remains an explicit skip when Playwright is unavailable.

- [ ] **Step 6: Commit the error-boundary change.**

~~~powershell
git add tools/nli-gateway.test.mjs tools/nli-gateway.mjs tools/nli/response-contract-validation.mjs nli-widget.js tools/nli-widget.browser-test.mjs
git commit -m "fix: distinguish NLI gateway failures"
~~~

### Task 5: Final fixture, test, and deployment verification

**Files:**

- Modify: \`nli/live-test-cases.json\`
- Modify: \`docs/deployment.md\`

**Interfaces:**

- Consumes: the deployed Gateway endpoint and the fixture runner.
- Produces: repeatable 100% named-project regression verification after deployment.

- [ ] **Step 1: Add final live fixture coverage.**

Ensure live fixtures include \`CateQuest 프로젝트 요약해줘\`, \`Bookking 프로젝트 요약해줘\`, \`Makertion 프로젝트 설명해줘\`, \`CateQuest 프로젝트로 이동해 주세요\`, \`오늘의 OTT 프로젝트 요약해줘\`, and a Makertion cost follow-up with \`currentTargetId: \"project-makertion\"\`. Every direct named target declares exact expected \`intent\` and \`targetId\`.

- [ ] **Step 2: Verify local and fake-model fixtures.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tools/nli-test.mjs --mode local
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tools/nli-test.mjs --mode fake
~~~

Expected: 100% pass rate for both suites.

- [ ] **Step 3: Document the production check.**

Add this command to \`docs/deployment.md\` and require 100% named-project success after each deployment:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' tools/nli-test.mjs --mode live --base-url https://portfolio-nli-gateway.mixedsider.cloud/api/nli --cases nli/live-test-cases.json --minimum-pass-rate 1
~~~

- [ ] **Step 4: Run the complete maintained test suite.**

Run:

~~~powershell
& 'C:\Users\CodexAgent\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe' --test tools/*.test.mjs
~~~

Expected: every non-browser test passes; browser coverage is a documented skip only when the browser module is unavailable.

- [ ] **Step 5: Run live verification only after deployment approval.**

Run the documented command after deployment with an allowed origin. Report its exact pass rate; if deployment or network access is unavailable, state that live verification remains pending rather than claiming it passed.

- [ ] **Step 6: Commit fixtures and deployment docs.**

~~~powershell
git add nli/live-test-cases.json docs/deployment.md
git commit -m "test: document NLI gateway regression checks"
~~~
