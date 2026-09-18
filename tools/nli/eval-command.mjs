import { open, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { runChild } from "./eval-suites.mjs";

// Evidence capture for explicit Node commands; does not interpret a shell or retry failures.
export async function captureCommand(output, args) {
  if (!output || !args.length) throw new Error("Output and Node command required");
  const path = resolve(output);
  if (!(await stat(dirname(path))).isDirectory()) throw new Error("Output parent must exist");
  const handle = await open(path, "wx", 0o600);
  try {
    const start = performance.now();
    const result = await runChild(args, { timeout: 600000 });
    const report = { command: ["node", ...args], checkedAt: new Date().toISOString(),
      elapsedMs: performance.now() - start, ...result };
    await handle.writeFile(`${JSON.stringify(report, null, 2)}\n`);
    await handle.sync();
    console.log(JSON.stringify({ output: path, code: result.code, elapsedMs: report.elapsedMs }));
    return result.code;
  } finally { await handle.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [flag, output, separator, ...args] = process.argv.slice(2);
  if (flag !== "--output" || separator !== "--") throw new Error("--output <path> -- <Node arguments>");
  process.exitCode = await captureCommand(output, args);
}
