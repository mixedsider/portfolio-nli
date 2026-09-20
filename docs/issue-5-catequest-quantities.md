# Issue #5: CateQuest quantity investigation

Investigated on 2026-09-20 from `fce2f44674b5c34fce91b9eb202408400da589a9`,
using Node v22.22.1 in the isolated issue worktree. No deployment, model/server
configuration, prompt, receipt, timeout policy or shared acceptance gate changed.

## Historical versus current evidence

The issue's 2026-09-17 results (4.637s and 4.614s, HTTP 200/stop followed by
`quantity_unsupported`) are historical. Their visible answers and selected IDs
were not supplied, so their exact cause cannot be established retrospectively.
The following results are **new live calls**, not reuse of that evidence.

`loadNliContext()` and `prepareGroundedRequest("CateQuest 프로젝트를 요약해줘", context)`
produced four candidate cards. The real `createDetailedModelClient()` sent
`buildDetailedModelPayload()` with the production prompt/schema, temperature 0,
512-token limit and configured `lfm2.5-2.6b` ID. The serialized grounded message
was asserted equal to `prepared.groundedRequestBlock`. There was no current
target or history. No `.env` or process environment overrides were present.

The same bounded request was used for every attempt. The 30-second diagnostic
wait used only a temporary client-settings copy, as in the issue's diagnostic;
it did **not** change the payload or the four-second production deadline.

| Phase / UTC start | Wait budget | Elapsed ms, two sequential attempts | Transport completion | Shared acceptance |
| --- | --- | --- | --- | --- |
| Before fix / 12:59:38 | production 4s | 4009, 4002 | 0/2; timeout, no HTTP headers | 0/2; `transport_invalid` |
| Before fix / 13:00:56 | diagnostic 30s | 5012, 4751 | 2/2; HTTP 200, `stop`, valid JSON | 0/2; `quantity_unsupported` |
| After fix / 13:05:31 | diagnostic 30s | 5025, 4672 | 2/2; HTTP 200, `stop`, valid JSON | 2/2 accepted |
| After fix / 13:15:11 | production 4s | 4008, 4002 | 0/2; timeout, no HTTP headers | 0/2; `transport_invalid` |

Both configured `/v1/models` endpoints answered HTTP 200 (LFM 194ms, Qwen 31ms).
Qwen generation was not invoked and no verification receipt was issued.
LFM acceptance here is the local patched validator checking real server
completions, **not** proof of a deployed Gateway change or full readiness.
The four-second failure remains; two identical diagnostic generations are not
a reliability estimate. Do not close the broader operational problem on these
results or claim the historical cause is proven.

## Confirmed current cause

All four completed calls returned identical visible answers and selected IDs:
`project-catequest`, `project-catequest-ci`, `project-catequest-ai`,
`project-catequest-n1`. The full safe answer and IDs are retained in
`tools/nli/catequest-quantities.test.mjs`; its completion envelope and confidence
are synthetic test scaffolding, not a retained raw server envelope.

The failing clause includes `2025.06~2025.11 기간에` and later
`DB 접근 횟수를 54회에서 1회로 최적화했습니다`.
The selected root, CI and AI evidence all contain:

```text
2025.06 ~ 2025.11
사용자 맞춤 카테고리별 질문 생성 애플리케이션
```

Tracing `inspectModelCompletion` -> `acceptTransportProposal` ->
`checkAnswerObligations` -> `quantitiesSupported` showed transport success and
this numeric mismatch before the fix:

| Text | Parsed number | Parsed unit |
| --- | --- | --- |
| Answer's range endpoint plus prose | `2025.11` | `기간에` |
| Evidence's endpoint plus next line | `2025.11` | `사용자` |

Whitespace normalization erased the line boundary, and the optional Hangul unit
scanner consumed ordinary prose. `54회에서 1회로` was already supported; the model
identifier's `-1.3b` was also present in the AI evidence and supported. Thus these
live failures were neither invented quantities nor incorrect source selection.
The N+1 card is clipped from 3,871 to 3,000 bytes, but its core counts and latency
results survive. The date-bearing root/AI/CI cards are not clipped (395/2689/2883
bytes). Clipping is not the cause of this captured failure.

A separate local `54회가` suffix false positive was observable, but was absent
from the live answers. The existing Korean suffix stripping remains unchanged.

## Minimal fix and regressions

Recognize a bounded lexical calendar form (`YYYY.MM ~ YYYY.MM`, months 01-12)
as one exact `calendar-month-range` obligation before whitespace normalization.
Only standalone/punctuated ranges or explicit Korean temporal `기간` wording
qualify. Other continuations stay on the existing strict quantity scanner, so
attached or space-separated `ms`/`초` cannot disappear. Whitespace may differ,
but both date endpoints and their pairing must occur in selected evidence;
unrelated endpoint dates cannot be recombined. No project/question/date value
is special-cased. Ordinary number/unit/sign validation is unchanged.
An additional RED/GREEN boundary regression ensures whitespace-separated signs
before a range cannot be discarded by the date recognizer.

The new tests cover the captured answer through LFM, Qwen and probe gates,
payload/preparation equality, fabricated and Bookking-borrowed numbers, signs,
changed units, Korean-adjacent unsupported numbers, changed dates, and bounded
evidence removal while full context retains the facts. Both the canonical gate
and direct obligation check reject removed dates; neither reloads evidence.

Validation commands/results before the closing-delimiter review correction:

- `node --test tools/nli/catequest-quantities.test.mjs`: RED before implementation,
  4 passed / 3 failed; both adapters reported `quantity_unsupported` for the
  supported answer, and the date/prose primitive failed. GREEN: 7/7.
- `node --test tools/nli/catequest-quantities.test.mjs tools/nli/answer-obligations-numeric.test.mjs tools/nli/probe-acceptance.test.mjs`: 32/32.
- `node --test tools/nli/*.test.mjs`: 266/266, zero skipped, exit 0.
- `node --test tools/*.test.mjs`: 178/178, zero skipped, exit 0.
- `node tools/test-harness.mjs check`: 68 registered test files; syntax/JSON/catalog passed.
- `node --check` on both changed `.mjs` files and `git diff --check`: passed.

The initial overlapping full runs were not clean: the root run hit the tool's
120s execution cap; the NLI run passed 265/266 with a fixture assertion in
`eval-final-proof.test.mjs`. That file passed in isolation; the exact full globs
then passed when not overlapped. This is a contention-compatible observation,
not a proven diagnosis or a test-timeout fix. A later overlapping harness check
also hit its execution limit; the standalone check passed. Dependencies were installed from
the existing cache with `pnpm install --offline --frozen-lockfile --ignore-scripts`
(six reused, zero downloaded). No build/typecheck script exists. LSP attempts
were blocked by the tool's original-checkout cwd boundary; no clean LSP result
is claimed. Temporary diagnostic exports/scripts were removed. No raw
envelopes, hidden reasoning or authentication data were persisted.

## Review correction: closing delimiters

Review found that the initial date recognizer omitted `)` and `]` as closing
boundaries. A wrapped range fell back to separate numeric atoms while the
unwrapped evidence became one calendar-range atom. This regressed the grounded
answer `CateQuest는 사용자 맞춤 카테고리별 질문 생성 애플리케이션입니다 (2025.06~2025.11).`
with selected `project-catequest` evidence: `checkAnswerObligations` returned
`quantity_unsupported` rather than `null`. The bracketed form failed likewise.

Added tests first: a 3-by-3 table of bare/parenthesized/bracketed claim and
evidence forms, both grounded summaries through the obligation and LFM/Qwen
acceptance gates, and wrapped sign/unit/endpoint-pairing rejection in both
directions. `node --test tools/nli/catequest-quantities.test.mjs` was RED with
12 passed / 8 failed. The correction adds only `)` and `]` to the calendar
range's closing-boundary character class; generic numeric validation is untouched.
The focused command below then passed **45/45**, including all 20 CateQuest tests:

```sh
node --test tools/nli/catequest-quantities.test.mjs tools/nli/answer-obligations-numeric.test.mjs tools/nli/probe-acceptance.test.mjs
```

Independent verification history supplied by the parent before this correction:
the parent's sequential full globs passed **178/178** and **266/266**, and the
harness checked **68** test files. Separately, the goal reviewer's full NLI run,
concurrent with other work, failed at `eval-proof-integration.test.mjs:112` with
`qwen_unverified`. Its cause is **unproven**; concurrency alone is not a diagnosis.
Those earlier full-suite results do not certify this correction. After the
correction, the parent ran both full globs sequentially with no sibling test
jobs: **178/178** root tests and **279/279** NLI tests passed (exit 0), followed
by the **68-file** harness check and `git diff --check`, both successful.
A fresh independent review also reran the focused command (**45/45**) and
cleared the boundary, verification and security-impact blockers. No further
live model calls were made; the live results above remain limited to the
captured unwrapped answer and do not establish operational readiness.
