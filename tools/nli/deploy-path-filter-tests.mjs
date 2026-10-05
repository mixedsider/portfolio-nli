import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("./deploy-path-filter.mjs", import.meta.url));

async function withGitFixture(operation) {
  const directory = await mkdtemp(join(tmpdir(), "deploy-filter-git-"));
  const repo = join(directory, "repo");
  const env = { ...process.env, GIT_MASTER: "1", GIT_AUTHOR_NAME: "Offline fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid",
    GIT_COMMITTER_NAME: "Offline fixture", GIT_COMMITTER_EMAIL: "fixture@example.invalid" };
  try {
    await mkdir(repo);
    const git = (args, input) => {
      const result = spawnSync("git", args, { cwd: repo, env, input, encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.signal, null);
      return result.stdout.trim();
    };
    git(["init", "--quiet"]);
    await mkdir(join(repo, "docs"));
    await writeFile(join(repo, "app.js"), "baseline app\n");
    await writeFile(join(repo, "docs/guide.md"), "baseline docs\n");
    // Build real commit objects only in this disposable repo; never commit the worktree patch.
    const revision = (parent) => {
      git(["add", "-A"]);
      const tree = git(["write-tree"]);
      return git(["commit-tree", tree, ...(parent ? ["-p", parent] : [])], "offline test fixture\n");
    };
    const before = revision();
    let outputOrdinal = 0;
    const filter = async (start, end, eligible, exit = 0) => {
      const output = join(directory, `output-${outputOrdinal++}.txt`);
      const result = spawnSync(process.execPath, [cli], { cwd: repo,
        env: { ...env, PUSH_BEFORE: start, PUSH_AFTER: end, GITHUB_OUTPUT: output }, encoding: "utf8", timeout: 30000 });
      assert.equal(result.status, exit, result.stderr);
      assert.equal(result.signal, null);
      assert.equal(await readFile(output, "utf8"), `eligible=${eligible}\n`);
      assert.equal(result.stdout.trim(), `Main deploy path eligibility: ${eligible}`);
      if (exit) assert.equal(result.stderr.trim(), "Main deploy path filter failed closed: history unavailable or invalid push range.");
      else assert.equal(result.stderr, "");
    };
    await operation({ repo, before, revision, filter, git });
  } finally { await rm(directory, { recursive: true, force: true }); }
}

export function registerDeployPathFilterTests() {
  test("main path filter retains the exact old allowlist, including deletions and both rename sides", async () => {
    const { matchesDeployPath, changedPaths, deploymentEligible } = await import("./deploy-path-filter.mjs");
    for (const path of ["app.js", "index.html", "styles.css", "nli-history.js", "nli-widget.js", "tools/nli-gateway.mjs",
      "tools/nli/deep/test.mjs", "tools/nli-test.mjs", "tools/any.mjs", "nli/deep/file.json", "data/portfolio.js",
      ".env.example", ".github/workflows/deploy-nli-gateway.yml"]) assert.equal(matchesDeployPath(path), true, path);
    for (const path of ["docs/guide.md", "README.md", "package.json", "tools/other/deep.mjs", "data/other.js",
      ".env", ".github/workflows/ci.yml", "tools/file.mjs.txt"]) assert.equal(matchesDeployPath(path), false, path);
    const before = "a".repeat(40), after = "b".repeat(40);
    const calls = [];
    const run = (command, args, options) => {
      calls.push({ command, args, options });
      return { status: 0, stdout: args[0] === "diff" ? "docs/renamed.md\0tools/deleted.mjs\0" : "" };
    };
    assert.deepEqual(changedPaths(before, after, run), ["docs/renamed.md", "tools/deleted.mjs"]);
    assert.equal(deploymentEligible(before, after, run), true);
    assert.ok(calls.some(({ args }) => args.includes("--no-renames") && args.includes(before) && args.includes(after)));
    assert.ok(calls.every(({ options }) => options.env.GIT_MASTER === "1"));
    assert.equal(deploymentEligible(before, after, (_cmd, args) => ({ status: 0, stdout: args[0] === "diff" ? "docs/only.md\0" : "" })), false);
  });
  test("main path filter handles initial push and fails closed on missing or malformed history", async () => {
    const { changedPaths } = await import("./deploy-path-filter.mjs");
    const after = "b".repeat(40), calls = [];
    assert.deepEqual(changedPaths("0".repeat(40), after, (_cmd, args) => {
      calls.push(args); return { status: 0, stdout: args[0] === "ls-tree" ? "app.js\0docs/guide.md\0" : "" };
    }), ["app.js", "docs/guide.md"]);
    assert.ok(calls.some((args) => args[0] === "ls-tree" && args.includes(after)));
    assert.throws(() => changedPaths("a".repeat(40), after, () => ({ status: 128, stderr: "private-sentinel" })), /history_unavailable/);
    assert.throws(() => changedPaths("not-a-sha", after), /invalid_push_range/);
    assert.throws(() => changedPaths("a".repeat(40), after, (_cmd, args) => ({ status: 0, stdout: args[0] === "diff" ? "truncated" : "" })), /history_unavailable/);
  });
  test("real Git filter CLI includes an allowed change before the last commit of a multi-commit push", async () => {
    await withGitFixture(async ({ repo, before, revision, filter }) => {
      await writeFile(join(repo, "app.js"), "changed app\n");
      const middle = revision(before);
      await writeFile(join(repo, "docs/guide.md"), "changed docs\n");
      const after = revision(middle);
      await filter(before, after, true);
      await filter(middle, after, false);
    });
  });
  test("real Git filter CLI includes a deleted allowed file", async () => {
    await withGitFixture(async ({ repo, before, revision, filter }) => {
      await rm(join(repo, "app.js"));
      await filter(before, revision(before), true);
    });
  });
  test("real Git filter CLI includes a renamed allowed old path even when the new path is docs-only", async () => {
    await withGitFixture(async ({ repo, before, revision, filter, git }) => {
      await rename(join(repo, "app.js"), join(repo, "docs/app.md"));
      const after = revision(before);
      assert.equal(git(["diff", "--name-status", "-M", before, after]), "R100\tapp.js\tdocs/app.md");
      await filter(before, after, true);
    });
  });
  test("real Git filter CLI excludes docs-only pushes", async () => {
    await withGitFixture(async ({ repo, before, revision, filter }) => {
      await writeFile(join(repo, "docs/guide.md"), "docs-only change\n");
      await filter(before, revision(before), false);
    });
  });
  test("real Git filter CLI handles the initial all-zero before revision", async () => {
    await withGitFixture(async ({ before, filter }) => { await filter("0".repeat(40), before, true); });
  });
  for (const start of ["not-a-sha", "f".repeat(40)]) {
    test(`real Git filter CLI fails closed for ${start === "not-a-sha" ? "invalid range" : "missing history"}`, async () => {
      await withGitFixture(async ({ before, filter }) => { await filter(start, before, false, 1); });
    });
  }
}
