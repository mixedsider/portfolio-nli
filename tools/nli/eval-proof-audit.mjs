import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createGatewayConfig } from "./config.mjs";
import { loadNliContext } from "../nli-gateway.mjs";
import { createEvaluationInputs } from "./eval-proof-inputs.mjs";
import { producerMatchesRuntime } from "./eval-bound-probe.mjs";
import { prepareProbeCases } from "./probe-request.mjs";

export async function auditProofInterfaces(config, context) {
  const rows = [];
  for (const endpoint of ["lfm", "qwen"]) {
    const inputs = await createEvaluationInputs(endpoint, endpoint === "lfm" ? config.lfm : config.model, context);
    rows.push({ endpoint, producerMatchesRuntime: producerMatchesRuntime({ endpoint, context,
      cases: prepareProbeCases(inputs.fixtures, context) }, inputs), evaluationBinding: inputs.binding,
      requests: inputs.matrix.map((row) => ({ caseId: row.item.id, repeat: row.repeat, outputMode: row.outputMode,
        requestBytes: row.requestBytes, groundedSha256: row.groundedSha256 })) });
  }
  return { label: "OFFLINE source-interface audit; no inference, metadata or receipt operations", rows,
    compatible: rows.every((row) => row.producerMatchesRuntime), networkCalls: 0 };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 2) throw new Error("No arguments accepted");
  const report = await auditProofInterfaces(createGatewayConfig(), await loadNliContext());
  console.log(JSON.stringify(report, null, 2));
  process.exitCode = report.compatible ? 0 : 1;
}
