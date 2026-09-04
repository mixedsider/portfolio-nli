# NLI Gateway Project Routing Design

## Goal

Make named portfolio-project requests resolve deterministically to the intended project or section, while preserving the Gateway's existing security boundary and grounded-answer validation.

## Scope

This design covers the requirements in `FIX.md`: named-project summary and navigation, route precedence, aliases and Korean particle handling, current-project follow-up evidence, model-contract alignment, and distinguishable Gateway failures. It does not change portfolio content, visual design, or expand the assistant into a general-purpose chatbot.

## Routing contract

The local router owns explicit project and section commands. It returns these existing intents without consulting the model:

- Named project + a summary expression (`요약`, `정리`, `설명`, `소개`, `핵심`, `간추려`) returns `summarize_project` for the named project root.
- Named project + a navigation expression (`이동`, `보여`, `열어`, `가줘`, `데려가`, `이동시켜`) returns `navigate` for that project root.
- A named section returns `summarize_section` or `navigate` for that section, except where the message explicitly asks for the encompassing project; the project root then wins.
- A generic `projects` page match cannot win when the same message contains a resolved project or section and asks to summarize, explain, or navigate.

Route selection will retain all positive candidates instead of discarding them at the first highest score. It will apply this ordering when scores are tied or close: explicit section, explicit project label or alias, project association, then page label or alias. This makes `CateQuest 프로젝트 …` and similar wording unambiguous without changing unrelated page navigation.

## Intent and model contract

`summarize_project` remains the canonical project-summary intent across the local router, response schema, fixtures, intent examples, model-decision schema, and system prompt. The model-decision schema will not advertise it as a model-generated decision: explicit project summary and navigation have already been resolved locally.

`answer_portfolio` remains available only for broad, grounded portfolio questions. The Gateway continues to send the model a bounded candidate-source pool, canonicalizes any model proposal, and falls back to trusted local behavior if the proposal is absent, invalid, or unsupported. A model proposal can never replace a known local navigation target with another target.

## Evidence retrieval and conversation context

Evidence tokenization will normalize Latin project names before Korean particles, and will compare compacted aliases as well as ordinary normalized terms. Thus `CateQuest를`, `Bookking의`, `Cate Quest`, and `오늘의OTT` retain the named project as a searchable anchor.

When `currentTargetId` is a valid project or section, the retrieval pool will include that target's project scope before the global ranking cutoff. A follow-up question that explicitly matches a section may still route to that section. Otherwise, the Gateway supplies the scoped evidence to an `answer_portfolio` proposal; it does not reject an in-scope follow-up merely because the message uses a pronoun.

## Error boundary

HTTP responses will preserve their existing status codes and add stable, Gateway-owned `errorCode` values for malformed input, oversized input, rate limits, unavailable upstream/model service, and out-of-scope requests. If an upstream proposal fails but a deterministic local result exists, the Gateway returns that local result. If no safe fallback exists, it returns a JSON rejection with `UPSTREAM_UNAVAILABLE` and a request ID. The widget will present this as a temporary response problem rather than claiming the Gateway is down.

## Testing

Tests will first reproduce each defect at the narrowest layer:

- Router tests cover every project’s direct summary and navigation patterns, generic-page collisions, root-versus-section precedence, and aliases.
- Gateway tests cover local deterministic results despite invalid, legacy, timed-out, or conflicting model proposals, as well as error-code behavior.
- Evidence tests cover Korean particles, spacing variants, aliases, and `currentTargetId`-scoped follow-ups.
- Contract tests ensure that intent examples, prompts, schemas, fixtures, and response validation express one consistent intent set.

The full Node test suite, the maintained NLI fixtures, and the browser regression test will run after the focused tests pass. Live Gateway calls remain a deployment verification step because they require a running deployed service and allowed origin.

## Success criteria

The documented `FIX.md` examples resolve to their named project or section, named-project requests never degrade to `projects` or an out-of-scope rejection, current-project follow-ups receive scoped evidence, and all existing security and boundary tests remain green.
