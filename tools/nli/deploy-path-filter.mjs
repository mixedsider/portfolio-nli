import { spawnSync } from "node:child_process";
import { appendFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

// The former workflow push.paths list, not a broader production allowlist.
const exactPaths = new Set(["app.js", "index.html", "styles.css", "nli-history.js", "nli-widget.js",
  "tools/nli-gateway.mjs", "tools/nli-test.mjs", "data/portfolio.js", ".env.example",
  ".github/workflows/deploy-nli-gateway.yml"]);

export function matchesDeployPath(path) {
  return exactPaths.has(path) || path.startsWith("tools/nli/") || path.startsWith("nli/") || /^tools\/[^/]+\.mjs$/.test(path);
}

export function changedPaths(before, after, run = spawnSync) {
  if (![before, after].every((sha) => typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha)) || /^0+$/.test(after)) {
    throw new Error("invalid_push_range");
  }
  const initial = /^0+$/.test(before);
  const git = (args) => {
    const child = run("git", args, { env: { ...process.env, GIT_MASTER: "1" }, encoding: "utf8",
      timeout: 30000, maxBuffer: 16777216 });
    if (child.error || child.signal || child.status !== 0) throw new Error("history_unavailable");
    return child.stdout;
  };
  for (const sha of initial ? [after] : [before, after]) git(["cat-file", "-e", `${sha}^{commit}`]);
  // Disable rename detection so both the deleted old name and added new name count.
  const output = git(initial ? ["ls-tree", "-r", "--name-only", "-z", after] :
    ["diff", "--name-only", "-z", "--no-renames", before, after, "--"]);
  if (typeof output !== "string" || (output && !output.endsWith("\0"))) throw new Error("history_unavailable");
  return output.split("\0").filter(Boolean);
}

export function deploymentEligible(before, after, run) {
  return changedPaths(before, after, run).some(matchesDeployPath);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let eligible = false;
  try { eligible = deploymentEligible(process.env.PUSH_BEFORE, process.env.PUSH_AFTER); }
  catch { console.error("Main deploy path filter failed closed: history unavailable or invalid push range."); process.exitCode = 1; }
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `eligible=${eligible}\n`);
  console.log(`Main deploy path eligibility: ${eligible}`);
}
