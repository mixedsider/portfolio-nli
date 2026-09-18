import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createGatewayConfig, loadDotEnv } from "./config.mjs";
import { loadNliContext } from "../nli-gateway.mjs";
import { loadTestCases } from "./test-fixtures.mjs";
import { ordinaryCases } from "./eval-workloads.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildDetailedModelPayload } from "./model-client.mjs";
import { requestProbeJson } from "./probe-http.mjs";

// Read-only template rendering/tokenization: never generation, settings mutation or model loading.
export async function inspectPromptSizes(config, context, cases, request = requestProbeJson) {
  const origin = new URL(config.model.baseUrl).origin;
  const options = { timeoutMs: 1000, maxResponseBytes: 262144 };
  const props = await request(`${origin}/props`, options);
  const rows = [];
  for (const item of cases) {
    const scoped = { ...context, currentTargetId: item.currentTargetId ?? null, history: item.history ?? [] };
    const prepared = prepareGroundedRequest(item.message, scoped);
    const payload = buildDetailedModelPayload(config.model, item.message, scoped, prepared.groundedRequest);
    const rendered = await request(`${origin}/apply-template`, { ...options, payload: { messages: payload.messages,
      reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false } } });
    const prompt = rendered.data?.prompt;
    const tokens = rendered.ok && typeof prompt === "string" ? await request(`${origin}/tokenize`, {
      ...options, payload: { content: prompt, add_special: false }
    }) : null;
    rows.push({ fixtureId: item.id, requestBytes: Buffer.byteLength(JSON.stringify(payload)),
      renderedBytes: typeof prompt === "string" ? Buffer.byteLength(prompt) : null,
      templateStatus: rendered.status, tokenizationStatus: tokens?.status ?? null,
      renderedPromptTokens: tokens?.ok && Array.isArray(tokens.data?.tokens) ? tokens.data.tokens.length : null });
  }
  return { label: "Read-only Qwen rendered-prompt tokenizer diagnostic; not completion usage or verification",
    modelAlias: props.data?.model_alias ?? null, loadedContextLength: props.data?.default_generation_settings?.n_ctx ?? null,
    totalSlots: props.data?.total_slots ?? null, metadataStatus: props.status, rows, inferenceCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("This diagnostic takes no arguments");
  await loadDotEnv(fileURLToPath(new URL("../../", import.meta.url)));
  const context = await loadNliContext();
  const cases = (await loadTestCases("nli/live-test-cases.json")).map((item, index) => ({ ...item, id: `live-${index + 1}` }));
  console.log(JSON.stringify(await inspectPromptSizes(createGatewayConfig(), context, ordinaryCases(cases)), null, 2));
}
