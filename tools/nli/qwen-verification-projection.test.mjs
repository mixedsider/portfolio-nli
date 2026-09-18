import assert from "node:assert/strict";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { buildDetailedModelPayload } from "./model-client.mjs";
import { sha256, verificationInputs } from "./qwen-verification-proof.mjs";

const context = await loadNliContext(new URL("../../", import.meta.url).pathname);

test("all 18 verification payloads equal actual runtime projection in both configured modes", () => {
  for (const outputMode of ["json_schema", "plain"]) {
    const settings = { ...createGatewayConfig({}).model, outputMode };
    const inputs = verificationInputs(settings, context);
    assert.equal(inputs.matrix.length, 18);
    for (const { item, repeat, payload } of inputs.matrix) {
      const prepared = prepareGroundedRequest(item.message, {
        ...context, currentTargetId: item.currentTargetId, history: item.history
      });
      const actual = buildDetailedModelPayload(settings, item.message, context, prepared.groundedRequest);
      assert.ok(JSON.stringify(payload) === JSON.stringify(actual), `${outputMode}/${item.id}/${repeat}: exact runtime bytes`);
      assert.equal(payload.messages[1].content, JSON.stringify(item.grounded));
      assert.equal(JSON.parse(payload.messages[1].content).conversation.length, [0, 2, 6][repeat]);
      assert.deepEqual(JSON.parse(payload.messages[1].content).candidateSources, item.candidateSources);
    }
  }
});

test("full-registry and history-omitting matrices cannot reuse the current receipt binding", () => {
  const settings = createGatewayConfig({}).model;
  const inputs = verificationInputs(settings, context);
  for (const restoreCatalogs of [true, false]) {
    const stale = inputs.matrix.map(({ item, repeat }) => ({ id: item.id, repeat,
      payload: buildDetailedModelPayload(settings, item.message, context, {
        candidateSources: item.candidateSources, currentTargetId: item.grounded.currentTargetId,
        history: restoreCatalogs ? item.grounded.conversation : [],
        targets: restoreCatalogs ? context.routes.targets : item.grounded.targets,
        terms: restoreCatalogs ? context.glossary.terms : item.grounded.terms
      }) }));
    assert.notEqual(inputs.binding.matrixSha256, sha256(stale));
  }
});
