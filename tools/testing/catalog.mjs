import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const levels = ["unit", "integration", "e2e"];
const techniques = ["blackbox", "whitebox"];
const runners = ["node", "playwright"];
const ignored = new Set(["node_modules", ".git", ".omo", ".nli", "test-results", "reports", "coverage", "playwright-report"]);
export async function discoverFiles(root, prefix = "") {
  const files = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await discoverFiles(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}
export const isTestFile = (path) => /(?:\.(?:test|spec)|\.browser-test)\.[cm]?[jt]sx?$/.test(path);

export function validateCatalog(catalog, discovered) {
  if (catalog.version !== 1 || !Array.isArray(catalog.tests) || !Array.isArray(catalog.delegates)) {
    throw new Error("Invalid catalog structure");
  }
  const owned = new Set();
  for (const entry of catalog.tests) {
    if (!levels.includes(entry.level) || !runners.includes(entry.runner) || !Array.isArray(entry.techniques)
      || !entry.techniques.length || entry.techniques.some((tag) => !techniques.includes(tag))
      || new Set(entry.techniques).size !== entry.techniques.length) throw new Error("Invalid catalog classification");
    if (typeof entry.path !== "string" || !isTestFile(entry.path) || entry.path.includes("..") || entry.path.startsWith("/")) {
      throw new Error("Invalid catalog path");
    }
    if (owned.has(entry.path)) throw new Error(`Overlapping catalog entry: ${entry.path}`);
    owned.add(entry.path);
  }
  for (const entry of catalog.delegates) {
    const target = catalog.tests.find((test) => test.path === entry.to);
    if (!target || target.runner !== "playwright" || !entry.reason || owned.has(entry.path)) {
      throw new Error("Invalid or overlapping delegation");
    }
    owned.add(entry.path);
  }
  for (const path of discovered) if (!owned.has(path)) throw new Error(`Unclassified test: ${path}`);
  for (const path of owned) if (!discovered.includes(path)) throw new Error(`Stale catalog entry: ${path}`);
  return catalog.tests;
}
export async function loadCatalog(root) {
  const catalog = JSON.parse(await readFile(join(root, "tests/catalog.json"), "utf8"));
  return validateCatalog(catalog, (await discoverFiles(root)).filter(isTestFile));
}
export function selectTests(entries, options) {
  const selected = entries.filter((entry) => (!options.level || entry.level === options.level)
    && (!options.runner || entry.runner === options.runner)
    && (!options.technique || entry.techniques.includes(options.technique)));
  if (!selected.length) throw new Error("Empty test selection");
  return selected;
}
export function parseArguments(args) {
  const [command, ...flags] = args;
  if (!["list", "check", "run"].includes(command)) throw new Error("Usage: test-harness.mjs list|check|run [--all | filters] [--out-dir path]");
  const options = { command };
  const seen = new Set();
  for (let index = 0; index < flags.length; index += 1) {
    const flag = flags[index];
    if (seen.has(flag)) throw new Error(`Duplicate option: ${flag}`);
    seen.add(flag);
    if (flag === "--all") { options.all = true; continue; }
    const choices = { "--level": levels, "--technique": techniques, "--runner": runners, "--out-dir": null };
    if (!Object.hasOwn(choices, flag)) throw new Error(`Unknown option: ${flag}`);
    const value = flags[++index];
    if (!value || value.startsWith("--") || (choices[flag] && !choices[flag].includes(value))) throw new Error(`Invalid value for ${flag}`);
    options[flag === "--out-dir" ? "outDir" : flag.slice(2)] = value;
  }
  const filtered = options.level || options.technique || options.runner;
  if (options.all && filtered) throw new Error("--all cannot be mixed with filters");
  if (command === "run" && !options.all && !filtered) throw new Error("run requires --all or a filter");
  if (command === "check" && flags.length) throw new Error("check accepts no options");
  if (command !== "run" && options.outDir) throw new Error("--out-dir is only valid for run");
  return options;
}
