import { loadNliContext } from "../nli-gateway.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { loadTestCases } from "./test-fixtures.mjs";
import { runTestCase } from "./test-runner.mjs";

// Owner handoff: keep the approved rejection expectations. Exit nonzero until
// runtime acceptance can satisfy them; this is not an expected-failure test.
const context = await loadNliContext();
const cases = await loadTestCases("nli/live-test-cases.json");
let networkCalls = 0;
globalThis.fetch = async () => { networkCalls += 1; throw new Error("Network forbidden in owner repro"); };
let failures = 0;
for (const item of cases.filter((entry) => entry.kind === "failure")) {
  const run = await runTestCase(item, context, { mode: "fake" });
  if (!run.errors.length) continue;
  failures += 1;
  const prepared = prepareGroundedRequest(item.message, context);
  console.log(JSON.stringify({ message: item.message, expected: item.expect,
    proposed: item.models.lfm.response, actual: run.result, errors: run.errors,
    observations: run.observations,
    acceptance: run.events.filter((event) => event.type === "acceptance").map(({ stage, reason }) => ({ stage, reason })),
    obligations: prepared.obligations, candidateIds: prepared.candidateSources.map((source) => source.id)
  }, null, 2));
}
console.log(JSON.stringify({ cases: cases.filter((item) => item.kind === "failure").length,
  failures, networkCalls, mode: "fake-cascade-owner-repro" }));
if (failures) process.exitCode = 1;
