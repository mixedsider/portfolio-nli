import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { buildLmStudioChatCompletionsUrl, buildDetailedModelPayload, getModelDecisionSchema } from "./model-client.mjs";
import { prepareProbeCases } from "./probe-request.mjs";
import { REASONING_ACCOUNTING_POLICY } from "./reasoning-metadata.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

export const sha256 = (value) => createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) ? value : JSON.stringify(value)).digest("hex");
export const MAX_RECEIPT_AGE_MS = 86400000;
const fixtureBytes = readFileSync(new URL("../../nli/model-probe-cases.json", import.meta.url), "utf8");

export function verificationInputs(settings, context, schemaBytes = readFileSync(new URL("../../nli/model-decision.schema.json", import.meta.url))) {
  const snapshot = structuredClone(settings);
  if (!context?.prompt || !["json_schema", "plain"].includes(snapshot.outputMode) || !snapshot.name ||
      (snapshot.reasoningEffort !== undefined && snapshot.reasoningEffort !== "none") ||
      (snapshot.chatTemplateKwargs !== undefined && JSON.stringify(snapshot.chatTemplateKwargs) !== '{"enable_thinking":false}')) throw new Error("Invalid verification settings");
  for (const key of ["timeoutMs", "maxTokens", "maxResponseBytes", "maxConcurrentRequests"]) {
    if (!Number.isSafeInteger(snapshot[key]) || snapshot[key] <= 0) throw new Error("Invalid verification bounds");
  }
  const schema = JSON.parse(schemaBytes.toString());
  if (sha256(schema) !== sha256(getModelDecisionSchema())) throw new Error("Schema must match production");
  const matrix = [0, 2, 6].flatMap((historyLength, repeat) => {
    const history = Array.from({ length: historyLength }, (_, i) => ({ role: i % 2 ? "assistant" : "user", text: "CateQuest" }));
    return prepareProbeCases(JSON.parse(fixtureBytes).map((item) => ({ ...item, history })), context)
      .map((item) => ({ item, repeat, payload: buildDetailedModelPayload(snapshot, item.message, context, {
        candidateSources: item.candidateSources, history: item.grounded.conversation, currentTargetId: item.grounded.currentTargetId,
        targets: item.grounded.targets, terms: item.grounded.terms
      }) }));
  });
  const url = buildLmStudioChatCompletionsUrl(snapshot.baseUrl);
  const { messages, ...requestSettings } = matrix[0].payload;
  const binding = { verificationPolicy: VERIFICATION_POLICY, endpoint: url, requestedModelId: snapshot.name, outputMode: snapshot.outputMode,
    reasoningPolicy: REASONING_ACCOUNTING_POLICY, promptSha256: sha256(context.prompt),
    schemaSha256: sha256(schemaBytes), settingsSha256: sha256({ settings: snapshot, requestSettings }),
    matrixSha256: sha256(matrix.map(({ item, repeat, payload }) => ({ id: item.id, repeat, payload }))) };
  return { settings: snapshot, matrix, binding, url };
}

export function inspectTemplate(prompt) {
  if (typeof prompt !== "string") throw new Error("template");
  const suffix = prompt.slice(prompt.lastIndexOf("<|im_start|>assistant"));
  if (!/^<\|im_start\|>assistant\s*<think>\s*<\/think>\s*$/.test(suffix)) throw new Error("template");
  return { renderedSha256: sha256(prompt), suffixSha256: sha256(suffix), emptyClosedThink: true };
}

export async function collectQwenProof(inputs, request) {
  const origin = new URL(inputs.url).origin;
  const props = await request(`${origin}/props`);
  const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
  if (!nonempty(props?.model_alias) || !nonempty(props.model_path) || !nonempty(props.chat_template) ||
      !(nonempty(props.build_info) || (props.build_info && typeof props.build_info === "object" && !Array.isArray(props.build_info) && Object.keys(props.build_info).length))) throw new Error("identity");
  const templates = [];
  for (const { payload } of inputs.matrix) {
    const rendered = await request(`${origin}/apply-template`, { messages: payload.messages,
      reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } });
    templates.push(inspectTemplate(rendered?.prompt));
  }
  return { returnedModelId: props.model_alias, modelIdentitySha256: sha256({ alias: props.model_alias, path: props.model_path }),
    buildInfoSha256: sha256(props.build_info), chatTemplateSha256: sha256(props.chat_template), templates };
}

export function validReceipt(receipt, inputs, wallNow) {
  if (!receipt || receipt.verificationPolicy !== VERIFICATION_POLICY || receipt.version !== 1 || receipt.probeCount !== 18 || !Array.isArray(receipt.results) || receipt.results.length !== 18 ||
      !["zero", "unavailable"].includes(receipt.reasoningAccounting)) return false;
  const timestamp = typeof receipt.checkedAt === "string" ? Date.parse(receipt.checkedAt) : NaN;
  if (!Number.isFinite(timestamp) || wallNow < timestamp || wallNow - timestamp > MAX_RECEIPT_AGE_MS) return false;
  if (Object.entries(inputs.binding).some(([key, value]) => receipt[key] !== value)) return false;
  if (!receipt.proof || receipt.returnedModelId !== receipt.proof.returnedModelId ||
      !Array.isArray(receipt.proof.templates) || receipt.proof.templates.length !== 18) return false;
  const hash = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
  if (!["modelIdentitySha256", "buildInfoSha256", "chatTemplateSha256"].every((key) => hash(receipt.proof[key])) ||
      !receipt.proof.templates.every((row) => row?.emptyClosedThink === true && hash(row.renderedSha256) && hash(row.suffixSha256))) return false;
  return receipt.results.every((row, index) => row.caseId === inputs.matrix[index].item.id && row.repeat === inputs.matrix[index].repeat &&
    row.ok === true && row.finishReason === "stop" && row.returnedModelId === receipt.returnedModelId &&
    row.reasoningPresent === false && row.reasoningBytes === 0 && ["zero", "unavailable"].includes(row.reasoningAccounting)) &&
    receipt.reasoningAccounting === (receipt.results.every((row) => row.reasoningAccounting === "zero") ? "zero" : "unavailable");
}
