import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildDetailedModelPayload, buildLmStudioChatCompletionsUrl, getModelDecisionSchema } from "./model-client.mjs";
import { REASONING_ACCOUNTING_POLICY } from "./reasoning-metadata.mjs";
import { sha256 } from "./qwen-verification-proof.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

// Always derive from current authoritative preparation, never a copied probe layout or old digest.
export async function createEvaluationInputs(endpoint, settings, context) {
  if (!["lfm", "qwen"].includes(endpoint)) throw new Error("Invalid endpoint");
  const schemaBytes = await readFile(new URL("../../nli/model-decision.schema.json", import.meta.url));
  const fixtureBytes = await readFile(new URL("../../nli/model-probe-cases.json", import.meta.url));
  const fixtures = JSON.parse(fixtureBytes);
  const schema = JSON.parse(schemaBytes);
  if (!isDeepStrictEqual(schema, getModelDecisionSchema())) throw new Error("Current schema/runtime mismatch");
  if (!Array.isArray(fixtures) || fixtures.length !== 6 ||
    fixtures.some((item) => !item || typeof item.id !== "string" || !item.id || !item.message || !item.expected?.intent) ||
    new Set(fixtures.map((item) => item.id)).size !== 6) throw new Error("Invalid current verification fixtures");
  const snapshot = structuredClone(settings);
  const modes = endpoint === "lfm" ? ["json_schema", "plain"] : [snapshot.outputMode];
  const histories = endpoint === "qwen" ? [0, 2, 6] : [null];
  const matrix = modes.flatMap((outputMode) => histories.flatMap((historyLength, repeat) => fixtures.map((fixture) => {
    const item = { ...fixture, ...(historyLength === null ? {} : { history: Array.from({ length: historyLength }, (_, i) =>
      ({ role: i % 2 ? "assistant" : "user", text: "CateQuest" })) }) };
    const scoped = { ...context, history: item.history ?? [], currentTargetId: item.currentTargetId ?? null };
    const prepared = prepareGroundedRequest(item.message, scoped);
    const payload = buildDetailedModelPayload({ ...snapshot, outputMode }, item.message, scoped, prepared.groundedRequest);
    return { item, repeat, outputMode, payload, groundedSha256: sha256(JSON.parse(prepared.groundedRequestBlock)),
      requestBytes: Buffer.byteLength(JSON.stringify(payload)) };
  })));
  const { messages, ...requestSettings } = matrix.find((row) => row.outputMode === snapshot.outputMode).payload;
  const url = buildLmStudioChatCompletionsUrl(snapshot.baseUrl);
  const runtimeBinding = { verificationPolicy: VERIFICATION_POLICY, endpoint: url, requestedModelId: snapshot.name, outputMode: snapshot.outputMode,
    reasoningPolicy: REASONING_ACCOUNTING_POLICY, promptSha256: sha256(context.prompt), schemaSha256: sha256(schemaBytes),
    settingsSha256: sha256({ settings: snapshot, requestSettings }),
    matrixSha256: sha256(matrix.map(({ item, repeat, payload }) => ({ id: item.id, repeat, payload }))) };
  const binding = { version: 1, verificationPolicy: VERIFICATION_POLICY, endpoint, completionUrl: url, requestedModelId: snapshot.name, outputMode: snapshot.outputMode,
    reasoningPolicy: REASONING_ACCOUNTING_POLICY, settingsSha256: runtimeBinding.settingsSha256,
    promptSha256: runtimeBinding.promptSha256, schemaSha256: runtimeBinding.schemaSha256, fixtureSha256: sha256(fixtureBytes),
    matrixSha256: sha256(matrix.map(({ item, repeat, outputMode, payload }) =>
      ({ id: item.id, repeat, outputMode, payload, expected: item.expected, sourceIds: item.sourceIds }))) };
  return { binding, runtimeBinding, matrix, settings: snapshot, schemaBytes, fixtures,
    schemaSha256: sha256(schema), schemaLength: Buffer.byteLength(JSON.stringify(schema)), promptBytes: Buffer.byteLength(context.prompt) };
}
