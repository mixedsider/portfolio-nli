import { buildLmStudioChatCompletionsUrl } from "./model-client.mjs";
import { buildProbePayload, PROBE_ENDPOINTS } from "./probe-request.mjs";
import { requestProbeJson } from "./probe-http.mjs";
import { inspectProbeCompletion } from "./probe-result.mjs";
import { collectProbeMetadata, probeSha256 } from "./probe-metadata.mjs";
import { runQwenVerification } from "./probe-verification.mjs";
import { createGatewayConfig } from "./config.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

export function selectProbeMode(results, caseCount) {
  if (!Number.isSafeInteger(caseCount) || caseCount <= 0) return null;
  const rows = (mode) => results.filter((row) => row.outputMode === mode);
  const complete = (group) => group.length === caseCount && new Set(group.map((row) => row.caseId)).size === caseCount;
  const schema = rows("json_schema");
  const plain = rows("plain");
  if (!complete(schema) || !complete(plain)) return null;
  if (schema.some((row) => !plain.some((other) => other.caseId === row.caseId))) return null;
  if (schema.every((row) => row.ok)) return "json_schema";
  if (schema.some((row) => row.schemaUnsupported) && plain.every((row) => row.ok)) return "plain";
  return null;
}

export async function runProbe(options, dependencies = {}) {
  const { endpoint, mode, cases, context, schema } = options;
  if (!Object.hasOwn(PROBE_ENDPOINTS, endpoint) || !["baseline", "verify"].includes(mode)) throw new Error("Invalid probe options");
  if (!Array.isArray(cases) || cases.length !== 6 || new Set(cases.map((item) => item.id)).size !== 6) throw new Error("Incomplete probe matrix");
  if (endpoint === "qwen" && mode === "verify") return runQwenVerification({ ...options,
    settings: options.settings || createGatewayConfig().model }, dependencies);
  const settings = options.settings || PROBE_ENDPOINTS[endpoint];
  const request = dependencies.request || requestProbeJson;
  const metadata = await (dependencies.collectMetadata || collectProbeMetadata)(endpoint, settings,
    buildProbePayload(cases[0], context, schema, settings, "json_schema"), { request });
  const results = [];
  for (const outputMode of ["json_schema", "plain"]) {
    for (const item of cases) {
      const payload = buildProbePayload(item, context, schema, settings, outputMode);
      const timeoutMs = Math.min(settings.timeoutMs, PROBE_ENDPOINTS[endpoint].timeoutMs);
      const response = await request(buildLmStudioChatCompletionsUrl(settings.baseUrl), { ...settings, timeoutMs, payload });
      const { data, ...transport } = response;
      results.push({ caseId: item.id, outputMode, ...transport,
        ...(response.ok ? inspectProbeCompletion(data, item, context, endpoint) : {}),
        requestBytes: Buffer.byteLength(JSON.stringify(payload)), groundedSha256: probeSha256(item.grounded) });
    }
  }
  const selectedMode = selectProbeMode(results, cases.length);
  const blockers = [];
  if (!selectedMode) blockers.push("no_compatible_output_mode");
  if (!metadata.ok) blockers.push("metadata_unavailable_or_incomplete");
  if (endpoint === "qwen") blockers.push("qwen_verifier_unavailable");
  const compatible = Boolean(selectedMode) && metadata.ok;
  const verified = mode === "verify" && endpoint === "lfm" && compatible;
  return { version: 1, verificationPolicy: VERIFICATION_POLICY, endpoint, baseUrl: settings.baseUrl, requestedModel: settings.name, mode,
    checkedAt: new Date().toISOString(), settings, promptSha256: probeSha256(context.prompt),
    schemaSha256: probeSha256(schema), promptBytes: Buffer.byteLength(context.prompt), schemaBytes: Buffer.byteLength(JSON.stringify(schema)),
    caseCount: cases.length, results, metadata, selectedMode, verified,
    ok: mode === "verify" ? verified : compatible,
    status: verified ? "live-verified" : "activation-blocked", blockers,
    recommendation: selectedMode || "retain_json_schema_default_activation_blocked",
    limitations: ["Baseline is not a no-thinking receipt", "Production acceptance plus fixture constraints is not general semantic entailment", "Client cancellation does not prove GPU cancellation"] };
}
