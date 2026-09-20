import { inspectModelCompletion } from "./model-outcome.mjs";
import { acceptTransportProposal } from "./proposal-acceptance.mjs";

export function inspectProbeCompletion(data, item, context, endpoint) {
  const outcome = inspectModelCompletion(data, endpoint);
  const metadata = { ...outcome.metadata, endpoint };
  const content = data?.choices?.[0]?.message?.content;
  const facts = { returnedModel: metadata.modelId, finishReason: metadata.finishReason,
    visibleBytes: typeof content === "string" ? Buffer.byteLength(content) : 0,
    reasoning: { present: metadata.reasoningPresent, bytes: metadata.reasoningBytes, accounting: metadata.reasoningAccounting },
    choiceCount: Array.isArray(data?.choices) ? data.choices.length : 0,
    usage: { prompt_tokens: metadata.promptTokens, completion_tokens: metadata.completionTokens, total_tokens: metadata.totalTokens } };
  const fail = (kind) => ({ ...facts, ok: false, kind });
  if (outcome.tag !== "success") return fail(outcome.kind);
  if (!facts.returnedModel) return fail("invalid_envelope");
  const prepared = item.prepared;
  if (!prepared || !Object.isFrozen(prepared) || prepared.candidateSources !== item.candidateSources ||
      prepared.groundedRequestBlock !== JSON.stringify(item.grounded)) return fail("prepared_invalid");
  const scopedContext = { ...context, currentTargetId: prepared.groundedRequest.currentTargetId,
    history: prepared.groundedRequest.history };
  const acceptance = acceptTransportProposal({ ...outcome, metadata }, scopedContext, prepared, item.message);
  if (!acceptance.accepted) return { ...fail(acceptance.reason), validation: { ok: false } };
  if (!matchesProbeExpectation(outcome.candidate, item)) return fail("fixture_expectation");
  return { ...facts, ok: true, kind: "accepted", validation: { ok: true },
    visibleAnswer: outcome.candidate.intent === "answer_portfolio" ? outcome.candidate.answer : undefined };
}

// Fixture expectations are additional constraints, not an alternate semantic validator.
export function matchesProbeExpectation(candidate, item) {
  const expected = item.expected;
  if (candidate.intent !== expected.intent) return false;
  if (expected.targetId && candidate.targetId !== expected.targetId) return false;
  if (expected.term && candidate.term !== expected.term) return false;
  return (expected.groups || []).every((group) => candidate.sourceIds?.includes(group.sourceId) &&
    typeof candidate.answer === "string" && (group.label === undefined ||
      (typeof group.label === "string" && group.label.length > 0 && candidate.answer.toLowerCase().includes(group.label.toLowerCase()))) &&
    (!group.topic || candidate.answer.includes(group.topic)));
}
