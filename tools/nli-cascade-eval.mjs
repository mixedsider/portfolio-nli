import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { evaluateCascade } from "./nli/eval-runner.mjs";
import { readyVerdict } from "./nli/eval-report.mjs";

export function parseEvalArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index]?.slice(2);
    const value = args[index + 1];
    if (!args[index]?.startsWith("--") || !["output", "lfm-verification", "qwen-verification"].includes(key) ||
      Object.hasOwn(options, key) || !value?.trim() || value.startsWith("--")) throw new Error("Invalid evaluator arguments");
    options[key] = resolve(value);
  }
  if (!options.output) throw new Error("Required: --output <exclusive path>");
  if (new Set(Object.values(options)).size !== Object.values(options).length) throw new Error("Evidence paths must differ");
  return options;
}

export async function main(args, dependencies = {}) {
  const options = parseEvalArgs(args);
  if (!(await stat(dirname(options.output))).isDirectory()) throw new Error("Output parent must exist");
  const handle = await open(options.output, "wx", 0o600);
  try {
    let report;
    try { report = await (dependencies.evaluate ?? evaluateCascade)(options); }
    catch { report = { ready: false, status: "activation-blocked", blockers: ["evaluation_or_cleanup_exception"] }; }
    const verdict = readyVerdict(report?.gates ?? {});
    const exitStatus = report?.ready === true && verdict.ready ? 0 : 1;
    report = { ...report, blockers: [...new Set([...(report?.blockers ?? []), ...verdict.blockers])] };
    await handle.writeFile(`${JSON.stringify({ ...report, ready: exitStatus === 0,
      status: exitStatus === 0 ? "live-verified" : "activation-blocked", exitStatus,
      command: ["node", "tools/nli-cascade-eval.mjs", ...args], checkedAt: new Date().toISOString() }, null, 2)}\n`);
    await handle.sync();
    console.log(JSON.stringify({ output: options.output, ready: exitStatus === 0, blockers: report?.blockers ?? [] }));
    return exitStatus;
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then((code) => { process.exitCode = code; }).catch(() => {
    console.error("Evaluation failed: invalid input or exclusive output unavailable.");
    process.exitCode = 1;
  });
}
