import { fileURLToPath } from "node:url";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { inspectModelCompletion, modelFailure } from "./model-outcome.mjs";

export const context = await loadNliContext(fileURLToPath(new URL("../../", import.meta.url)));
export const config = createGatewayConfig({});
export const comparison = "CateQuest와 Bookking의 성능 개선을 비교해줘";
export const complete = "CateQuest는 SQL 실행 수를 53회에서 1회로 줄였습니다. Bookking은 Facade 적용 후 당시 로컬 테스트에서 재고 불일치가 발생하지 않았습니다.";
export const proposal = (answer = complete, confidence = 0.01) => ({ intent: "answer_portfolio", confidence,
  answer, sourceIds: ["project-catequest-n1", "project-bookking-lock"] });
export const partial = () => proposal(complete.split(". ")[0] + ".", 0.99);
export function envelope(candidate, model = "fixture-qwen", messageFields = {}) {
  return { model, choices: [{ finish_reason: "stop", message: {
    role: "assistant", content: JSON.stringify(candidate), ...messageFields
  } }] };
}
// Explicit task6 test adapter: strict envelope inspection, never a bare-candidate success.
export function inspected(endpoint, candidate, model, messageFields) {
  const outcome = inspectModelCompletion(envelope(candidate, model, messageFields), endpoint);
  return { ...outcome, metadata: { ...outcome.metadata, endpoint } };
}
export const failed = (endpoint, kind = "invalid_json") => modelFailure(kind, { endpoint });
export function request(originalMessage = comparison, extras = {}) {
  const scopedContext = { ...context, currentTargetId: "project-makertion-db" };
  return { originalMessage, scopedContext, prepared: prepareGroundedRequest(originalMessage, scopedContext),
    deadlineAt: 13000, ...extras };
}
export function harness(overrides = {}) {
  const calls = { lfm: [], qwen: [], verify: [], invalidations: 0, events: [] };
  let time = 0;
  const dependencies = { context, now: () => time, observer: (event) => calls.events.push(event),
    lfmClient: async (...args) => { calls.lfm.push(args); return inspected("lfm", partial()); },
    qwenClient: async (...args) => { calls.qwen.push(args); return inspected("qwen", proposal()); },
    verifier: { verify: async (options) => { calls.verify.push(options);
      return { ok: true, returnedModelId: "fixture-qwen" }; }, invalidate: () => { calls.invalidations += 1; } },
    ...overrides };
  return { calls, dependencies, setTime: (value) => { time = value; } };
}
