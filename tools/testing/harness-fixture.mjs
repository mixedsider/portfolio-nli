import { mkdtemp, mkdir, cp, symlink, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { testEnvironment } from "./process.mjs";

export async function fixtureDirectory(t) {
  const root = await mkdtemp(join(tmpdir(), "harness-fix1-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
export async function fixtureCli(t, source) {
  const root = await fixtureDirectory(t);
  await mkdir(join(root, "tools"));
  await mkdir(join(root, "tests"));
  await cp(new URL("../test-harness.mjs", import.meta.url), join(root, "tools/test-harness.mjs"));
  await cp(new URL("./", import.meta.url), join(root, "tools/testing"), { recursive: true });
  await symlink(new URL("../../node_modules", import.meta.url).pathname, join(root, "node_modules"), "dir");
  await writeFile(join(root, "tests/fixture.test.mjs"), source);
  await writeFile(join(root, "tests/catalog.json"), JSON.stringify({ version: 1, delegates: [], tests: [
    { path: "tests/fixture.test.mjs", level: "unit", runner: "node", techniques: ["blackbox"] }
  ] }));
  const result = spawnSync(process.execPath, ["tools/test-harness.mjs", "run", "--all"], {
    cwd: root, env: testEnvironment(), encoding: "utf8", timeout: 15000
  });
  const [run] = await readdir(join(root, "test-results"));
  return { result, summary: JSON.parse(await readFile(join(root, "test-results", run, "summary.json"), "utf8")) };
}
export async function syntheticReports(t, xml, runner) {
  const root = await fixtureDirectory(t);
  await writeFile(join(root, "junit.xml"), xml);
  await writeFile(join(root, "lcov.info"), "SF:fixture.mjs\nend_of_record\n");
  await writeFile(join(root, "counts.json"), JSON.stringify({ tests: 1, passed: 1, failed: 0, skipped: 0, todo: 0, cancelled: 0 }));
  if (runner === "playwright") {
    await mkdir(join(root, "html"));
    await writeFile(join(root, "html/index.html"), "<html>native report fixture</html>");
    await writeFile(join(root, "results.json"), JSON.stringify({ stats: { expected: 1, unexpected: 0, skipped: 0, flaky: 0 }, errors: [] }));
  }
  return root;
}
