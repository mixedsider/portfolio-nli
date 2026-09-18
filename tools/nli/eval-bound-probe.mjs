import { isDeepStrictEqual as same } from "node:util";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { main, parseProbeArgs } from "../nli-model-probe.mjs";
import { createGatewayConfig, loadDotEnv } from "./config.mjs";
import { buildProbePayload } from "./probe-request.mjs";
import { runProbe } from "./probe-runner.mjs";
import { verificationInputs } from "./qwen-verification-proof.mjs";
import { createEvaluationInputs } from "./eval-proof-inputs.mjs";
import { VERIFICATION_POLICY } from "./verification-policy.mjs";

export function producerMatchesRuntime(options, inputs) {
  try {
    const actual = options.endpoint === "qwen" ? verificationInputs(inputs.settings, options.context, inputs.schemaBytes).matrix :
      ["json_schema", "plain"].flatMap((outputMode) => options.cases.map((item) => ({ item, repeat: 0,
        payload: buildProbePayload(item, options.context, JSON.parse(inputs.schemaBytes), inputs.settings, outputMode) })));
    return actual.length === inputs.matrix.length && actual.every((row, index) =>
      row.item.id === inputs.matrix[index].item.id && row.repeat === inputs.matrix[index].repeat &&
      same(row.item.expected, inputs.matrix[index].item.expected) && same(row.payload, inputs.matrix[index].payload));
  } catch { return false; }
}

// Invoke existing semantic/transport verification and atomic receipt issuance, never annotate old reports.
export async function runBoundVerification(options, dependencies = {}) {
  if (options.mode !== "verify") throw new Error("Bound verification requires verify mode");
  const config = createGatewayConfig();
  const settings = options.settings ?? (options.endpoint === "lfm" ? config.lfm : config.model);
  const inputs = await createEvaluationInputs(options.endpoint, settings, options.context);
  const blocked = (reason) => ({ version: 1, verificationPolicy: VERIFICATION_POLICY, endpoint: options.endpoint, mode: "verify", ok: false, verified: false,
    receiptWritten: false, status: "activation-blocked", blockers: [reason], results: [], selectedMode: settings.outputMode });
  if (!producerMatchesRuntime(options, inputs)) return blocked("producer_runtime_payload_mismatch");
  const report = await (dependencies.runProbe ?? runProbe)({ ...options, settings }, dependencies);
  const after = await createEvaluationInputs(options.endpoint, settings, options.context);
  if (!same(inputs.binding, after.binding)) return { ...report, ok: false, verified: false,
    status: "activation-blocked", blockers: [...(report.blockers ?? []), "verification_inputs_changed"] };
  if (report.verificationPolicy !== VERIFICATION_POLICY) return { ...report, ok: false, verified: false,
    status: "activation-blocked", blockers: [...(report.blockers ?? []), "verification_policy_mismatch"] };
  if (report.selectedMode !== settings.outputMode) return { ...report, ok: false, verified: false,
    status: "activation-blocked", blockers: [...(report.blockers ?? []), "configured_mode_not_verified"] };
  return { ...report, evaluationBinding: inputs.binding };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2);
  if (parseProbeArgs(args).mode !== "verify") throw new Error("Only verify mode is supported");
  await loadDotEnv(fileURLToPath(new URL("../../", import.meta.url)));
  process.exitCode = await main(args, { run: runBoundVerification });
}
