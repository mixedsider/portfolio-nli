import { readFile, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverFiles, loadCatalog, parseArguments, selectTests } from "./testing/catalog.mjs";
import { execute, testEnvironment } from "./testing/process.mjs";
import { runNode, runPlaywright } from "./testing/runner.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
async function main() {
  const options = parseArguments(process.argv.slice(2));
  const entries = await loadCatalog(root);
  if (options.command === "check") {
    const files = await discoverFiles(root);
    for (const path of files) {
      if (path.endsWith(".json")) JSON.parse(await readFile(join(root, path), "utf8"));
      if (/\.[cm]?js$/.test(path)) {
        const result = await execute(process.execPath, ["--check", join(root, path)], { env: testEnvironment(), cwd: root });
        if (result.code !== 0) throw new Error(`Syntax check failed: ${path}\n${result.stderr}`);
      }
    }
    console.log(`Catalog, JavaScript syntax and JSON checked: ${entries.length} test files`);
    return;
  }
  const selected = selectTests(entries, options);
  if (options.command === "list") {
    console.log(JSON.stringify(selected, null, 2));
    return;
  }
  const base = resolve(root, options.outDir ?? "test-results");
  await mkdir(base, { recursive: true });
  const directory = await mkdtemp(join(base, "run-"));
  const results = [];
  for (const runner of ["node", "playwright"]) {
    const files = selected.filter((entry) => entry.runner === runner).map((entry) => entry.path);
    if (!files.length) continue;
    const run = runner === "node" ? runNode : runPlaywright;
    results.push(await run(files, { cwd: root, outDir: directory, stream: true }));
    if (results.at(-1).interrupted) break;
  }
  const summary = { version: 1, ok: results.length > 0 && results.every((result) => result.ok),
    selected: selected.map((entry) => entry.path), results };
  await writeFile(join(directory, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Harness ${summary.ok ? "passed" : "failed"}: ${join(directory, "summary.json")}`);
  if (!summary.ok) process.exitCode = 1;
}
main().catch((error) => {
  console.error(`Test harness: ${error.message}`);
  process.exitCode = 1;
});
