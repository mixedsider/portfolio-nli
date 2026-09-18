import { open, readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { loadNliContext } from "./nli/context.mjs";
import { prepareProbeCases } from "./nli/probe-request.mjs";
import { runProbe } from "./nli/probe-runner.mjs";
import { loadDotEnv } from "./nli/config.mjs";

export function parseProbeArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.replace(/^--/, "");
    const value = args[index + 1];
    if (!args[index]?.startsWith("--") || !["endpoint", "mode", "output", "receipt"].includes(key) ||
      Object.hasOwn(options, key) || !value?.trim() || value.startsWith("--")) throw new Error("Invalid or duplicate probe argument");
    options[key] = value;
  }
  if (!["lfm", "qwen"].includes(options.endpoint) || !["baseline", "verify"].includes(options.mode) || !options.output) {
    throw new Error("Required: --endpoint lfm|qwen --mode baseline|verify --output <path>");
  }
  if (options.receipt && options.endpoint !== "qwen") throw new Error("Receipt is Qwen-only");
  if (options.receipt && resolve(options.receipt) === resolve(options.output)) throw new Error("Report and receipt must differ");
  return options;
}

export async function main(args, dependencies = {}) {
  const options = parseProbeArgs(args);
  const output = resolve(options.output);
  if (!(await stat(dirname(output))).isDirectory()) throw new Error("Output parent must exist");
  const root = fileURLToPath(new URL("../", import.meta.url));
  if (options.endpoint === "qwen" && options.mode === "verify") await loadDotEnv(root);
  const context = await loadNliContext(root);
  const fixtures = JSON.parse(await readFile(resolve(root, "nli/model-probe-cases.json"), "utf8"));
  const schemaBytes = await readFile(resolve(root, "nli/model-decision.schema.json"), "utf8");
  const schema = JSON.parse(schemaBytes);
  const handle = await open(output, "wx", 0o600);
  try {
    const report = await (dependencies.run || runProbe)({ ...options, context, schema, schemaBytes, cases: prepareProbeCases(fixtures, context) }, dependencies);
    const exitStatus = report.ok ? 0 : 1;
    await handle.writeFile(`${JSON.stringify({ ...report, command: ["node", "tools/nli-model-probe.mjs", ...args], exitStatus,
      cleanup: { isolatedServers: 0, receiptWritten: report.receiptWritten === true, pendingRequests: 0 } }, null, 2)}\n`);
    return exitStatus;
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Probe failed: invalid arguments, unreadable inputs, or output cannot be created.");
    process.exitCode = 1;
  });
}
