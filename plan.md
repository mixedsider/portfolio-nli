# Grounded Portfolio NLI — Handoff Plan

Updated: 2026-07-22 (Asia/Seoul)

## Current snapshot

The working tree contains the grounded portfolio-assistant implementation. It extends the existing NLI widget and gateway so that the assistant can:

- navigate to known portfolio sections deterministically;
- define registered terms deterministically;
- answer profile, whole-portfolio, project, section, and category questions using retrieved portfolio evidence;
- generate Korean free prose only when selected evidence supports it;
- show source buttons that move to the corresponding portfolio sections;
- use at most six finalized browser-side conversation turns plus the current visible target for follow-up questions.

The implementation is **not yet final-acceptance complete**. The latest three boundary repairs have passed their focused and broad local regression suites, but the final independent five-lane audit still needs to be rerun and recorded.

## Completed implementation

1. Derived evidence cards and deterministic candidate retrieval from portfolio data, routes, and glossary.
2. Strict `answer_portfolio` response protocol: canonical source IDs only, plain text only, and no model-provided labels, URLs, or HTML.
3. Grounded gateway routing with bounded validated history, safe fallback, prompt-injection rejection, and no server-side session storage.
4. Category coverage for performance, AWS, observability, concurrency, Redis, CI/CD, cost, AI/LLM, and data modelling.
5. NLI UI source buttons, reduced-motion navigation, safe text rendering, and client history that keeps the welcome message visible without sending it as conversation context.
6. Deployment/CI preflight coverage and explicit optional browser-test handling.
7. Final boundary repairs:
   - concise unsupported technical claims are rejected instead of being treated as grounded;
   - the generated welcome message is UI-only and excluded from persisted/request history;
   - local glossary definitions such as `P95가 뭐야?` return before any model call.

## Verified before handoff

The latest repair pass recorded these successful local checks. They do not call the LAN LM Studio or a deployed gateway.

```powershell
node --test tools/nli/portfolio-answer-validation.test.mjs
node --test tools/nli-history-boundary.test.mjs
node --test tools/nli-gateway-boundaries.test.mjs
node tools/nli-test.mjs --local --cases nli/live-test-cases.json --min-pass-rate 1
node tools/nli-test.mjs --local --cases nli/adversarial-test-cases.json --min-pass-rate 1
node tools/nli-test.mjs --fake --cases nli/grounded-category-test-cases.json --min-pass-rate 1
node --test tools/*.test.mjs
node --test tools/nli/*.test.mjs
```

Recorded results at the handoff point:

- focused support/history/gateway tests: 30 passing;
- local fixture: 37/37;
- adversarial fixture: 8/8;
- grounded fake category fixture: 17/17;
- root suite: 66 passing, 0 failing, 2 explicit platform skips;
- nested NLI suite: 21 passing;
- browser CDP evidence confirms the welcome remains visible while the first request sends `history: []`.

## Required continuation on the other computer

1. Clone or pull this commit on `main`, then confirm a clean working tree.
2. Run the verification commands above. Do not point tests at production or `LM_STUDIO_BASE_URL`.
3. Re-run the final independent review lanes and write fresh evidence:
   - goal/constraint review;
   - hands-on QA, including loopback HTTP and browser evidence where available;
   - code-quality review;
   - security review;
   - context/docs/CI review.
4. The final audit must specifically prove all of the following:
   - `P95 shared_buffers Kubernetes` cannot be accepted as an evidence-grounded answer;
   - a concise supported Korean answer remains accepted;
   - the visible default welcome does not appear in the first API request history;
   - `P95가 뭐야?` returns `define_term` with zero model calls;
   - direct `CloudWatch 모니터링 보여줘` navigation remains model-free;
   - `CloudWatch` experience questions can still produce grounded synthesis;
   - performance answers include DB/cache/N+1/HTTPS evidence and exclude monitoring and distributed-lock examples unless explicitly requested.
5. Only after all five lanes pass, mark the final gates complete in `.omo/plans/grounded-portfolio-nli.md` and append the evidence ledger. Do not deploy automatically as part of this handoff.

## Important boundaries

- Never expose or commit `.env` values, SSH keys, gateway host details, or LAN model endpoints.
- Model output is untrusted. Keep source IDs validated against retrieved candidates and render answer text with `textContent`, not HTML.
- Preserve deterministic navigation and glossary answers. Do not broaden model calls merely to make answers sound more conversational.
- Keep history browser-owned, capped at six finalized entries, and avoid server-side conversation persistence.
- Do not add external search, embeddings, a vector database, caching, or a manually maintained category-to-section map.
- The browser test can skip explicitly when no Chrome-capable Playwright module is supplied. It must not install a browser dependency during CI.

## Main files to inspect

- Gateway and policy: `tools/nli-gateway.mjs`, `tools/nli/router.mjs`, `tools/nli/model-routing-policy.mjs`.
- Evidence and grounding guard: `tools/nli/evidence*.mjs`, `tools/nli/portfolio-answer-validation.mjs`, `tools/nli/answer-evidence-support.mjs`.
- Browser behavior: `app.js`, `nli-widget.js`, `nli-history.js`, `styles.css`.
- Contracts and fixtures: `nli/*.json`, `nli/system-prompt.md`, `tools/*nli*.test.mjs`.
- Prior detailed plan and evidence: `.omo/plans/grounded-portfolio-nli.md` and `.omo/evidence/` (these may be ignored by Git, so retain them locally if needed).
