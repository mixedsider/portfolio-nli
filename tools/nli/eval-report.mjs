export function distribution(values) {
  const sorted = values.filter((value) => Number.isFinite(value) && value >= 0).sort((a, b) => a - b);
  const percentile = (fraction) => sorted.length ? sorted[Math.ceil(sorted.length * fraction) - 1] : null;
  return { count: sorted.length, p50: percentile(0.5), p95: percentile(0.95) };
}

export function observed(row) {
  return typeof row.stage === "string" && [0, 1].includes(row.lfmCalls) && [0, 1].includes(row.qwenCalls);
}

export function assessSuite(child, rows, count) {
  const match = `${child.stdout}\n${child.stderr}`.match(/NLI tests passed: (\d+)\/(\d+) passed \(100\.0%\)/);
  const errors = [];
  if (!Number.isSafeInteger(count) || count <= 0) errors.push("empty_suite");
  if (child.code !== 0 || child.signal) errors.push("subprocess_failed");
  if (!match || Number(match[1]) !== count || Number(match[2]) !== count) errors.push("incomplete_or_failed_cli_results");
  if (rows.length !== count || rows.some((row) => !observed(row))) errors.push("unobserved_requests");
  return { ok: errors.length === 0, errors };
}

export const REQUIRED_GATES = Object.freeze(["policyCaps", "lfmVerified", "qwenVerified", "liveSuccess", "adversarial",
  "ordinary", "qwenBaseline", "faster", "concurrency1", "concurrency4", "difficultWorkload", "injectedEscalation", "finalProofFreshness", "cleanup"]);

export function readyVerdict(gates) {
  const blockers = REQUIRED_GATES.filter((gate) => gates[gate] !== true);
  return { ready: blockers.length === 0, status: blockers.length ? "activation-blocked" : "live-verified", blockers };
}
