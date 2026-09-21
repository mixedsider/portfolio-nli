import { createHash } from "node:crypto";
import { requestProbeJson } from "./probe-http.mjs";

export function probeSha256(value) {
  return createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value ?? null)).digest("hex");
}

export async function collectProbeMetadata(endpoint, settings, payload, dependencies = {}) {
  const request = dependencies.request || requestProbeJson;
  const origin = new URL(settings.baseUrl).origin;
  const timeoutMs = endpoint === "qwen" ? settings.timeoutMs : Math.min(settings.timeoutMs, 1000);
  const options = { timeoutMs, maxResponseBytes: settings.maxResponseBytes };
  const describe = ({ ok, kind, status, bytes, elapsedMs }) => ({ ok, kind, status, bytes, elapsedMs });
  if (endpoint === "lfm") {
    const response = await request(`${origin}/api/v0/models`, options);
    const models = response.data?.data;
    const loaded = Array.isArray(models) && models.some((model) => model.state === "loaded" &&
      [settings.name, settings.name.split("@")[0]].includes(model.id));
    return { ...describe(response), ok: response.ok && loaded, identitySha256: response.ok ? probeSha256(models) : null,
      models: Array.isArray(models) ? models.map((model) => ({ id: model.id, state: model.state,
        quantization: model.quantization, loadedContextLength: model.loaded_context_length, maxContextLength: model.max_context_length })) : [] };
  }
  const props = await request(`${origin}/props`, options);
  const rendered = await request(`${origin}/apply-template`, { ...options, payload: {
    messages: payload.messages, reasoning_effort: "none", chat_template_kwargs: { enable_thinking: false }
  } });
  const template = rendered.data?.prompt;
  const suffix = typeof template === "string" ? template.match(/<think>\s*<\/think>\s*$/)?.[0] : null;
  return {
    ok: props.ok && rendered.ok && Boolean(suffix), props: describe(props), applyTemplate: describe(rendered),
    modelIdentitySha256: props.ok ? probeSha256({ alias: props.data?.model_alias, path: props.data?.model_path }) : null,
    buildInfoSha256: props.ok ? probeSha256(props.data?.build_info) : null,
    chatTemplateSha256: props.ok ? probeSha256(props.data?.chat_template) : null,
    renderedTemplateSha256: rendered.ok ? probeSha256(template) : null,
    renderedTemplateBytes: typeof template === "string" ? Buffer.byteLength(template) : 0,
    emptyClosedThinkSuffix: Boolean(suffix), renderedTemplateTestSuffix: suffix || null,
    verification: "characterization_only"
  };
}
