import assert from "node:assert/strict";
import { readFile, cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadNliContext } from "./context.mjs";
import { createGatewayConfig } from "./config.mjs";
import { prepareGroundedRequest } from "./evidence-selection.mjs";
import { acceptProposal } from "./proposal-acceptance.mjs";
import { buildDetailedModelPayload, getModelDecisionSchema } from "./model-client.mjs";
import { matchesJsonSchema } from "../testing/json-schema.mjs";

const root = new URL("../../", import.meta.url);
const context = await loadNliContext(root.pathname);
const fixtures = JSON.parse(await readFile(new URL("nli/model-probe-cases.json", root), "utf8"));
const settings = createGatewayConfig({}).lfm;
const prepare = (message, extra = {}) => prepareGroundedRequest(message, { ...context, ...extra });
const schemaFor = (message, prepared = prepare(message)) =>
  buildDetailedModelPayload(settings, message, context, prepared.groundedRequest).response_format.json_schema.schema;

test("characterization: weather's prepared intent gate rejects registered navigation and accepts rejection", () => {
  const { message } = fixtures.find((row) => row.id === "out-of-scope");
  const prepared = prepare(message);
  assert.deepEqual(prepared.obligations.expectedIntents, ["reject_out_of_scope"]);
  assert.deepEqual(acceptProposal({ intent: "navigate", confidence: 1, targetId: "top" }, context, prepared, message),
    { accepted: false, reason: "intent_mismatch" });
  assert.equal(acceptProposal({ intent: "reject_out_of_scope", confidence: 1 }, context, prepared, message).accepted, true);
});

test("prepared weather generation exposes only the authoritative reject branch", () => {
  const { message } = fixtures.find((row) => row.id === "out-of-scope");
  const schema = schemaFor(message);
  assert.deepEqual(schema.oneOf.map((branch) => branch.properties.intent.const), ["reject_out_of_scope"]);
  assert.equal(matchesJsonSchema(schema, { intent: "navigate", confidence: 1, targetId: "top" }), false);
  assert.equal(matchesJsonSchema(schema, { intent: "reject_out_of_scope", confidence: 1 }), true);
  assert.equal(matchesJsonSchema(schema, { intent: "reject_out_of_scope", confidence: 1, targetId: "top" }), false);
});

test("prepared navigation and answer ID enums reject unknown and out-of-pool IDs", () => {
  const navigation = schemaFor("CateQuest로 이동");
  const candidate = { intent: "navigate", confidence: 1, targetId: "project-catequest" };
  assert.equal(matchesJsonSchema(navigation, candidate), true);
  for (const targetId of ["unregistered-target", "about"]) {
    assert.equal(matchesJsonSchema(navigation, { ...candidate, targetId }), false, targetId);
  }
  const answer = schemaFor("CateQuest N+1 해결 방법을 설명해줘");
  const proposal = { intent: "answer_portfolio", confidence: 1,
    answer: context.targetById.get("project-catequest-n1").label, sourceIds: ["project-catequest-n1"] };
  assert.equal(matchesJsonSchema(answer, proposal), true);
  for (const sourceId of ["unregistered-source", "project-catequest", "project-bookking-https"]) {
    assert.equal(matchesJsonSchema(answer, { ...proposal, sourceIds: [sourceId] }), false, sourceId);
  }
});

test("each supported intent specializes exactly existing branch fields and limits without mutation", () => {
  const before = JSON.stringify(getModelDecisionSchema());
  for (const item of fixtures) {
    const prepared = prepare(item.message, { currentTargetId: item.currentTargetId });
    const beforePrepared = JSON.stringify(prepared);
    const schema = schemaFor(item.message, prepared);
    assert.deepEqual(schema.oneOf.map((branch) => branch.properties.intent.const), prepared.obligations.expectedIntents, item.id);
    const labels = prepared.obligations.requiredSubjectIds.map((id) => context.targetById.get(id)?.label ||
      context.glossary.terms.find((term) => `glossary:${term.term}` === id).term);
    const valid = { intent: item.expected.intent, confidence: 1,
      ...(item.expected.intent === "navigate" ? { targetId: item.expected.targetId } : {}),
      ...(item.expected.intent === "define_term" ? { term: item.expected.term } : {}),
      ...(item.expected.intent === "answer_portfolio" ? { answer: labels.join(" ") || "Schema-valid text", sourceIds: item.sourceIds } : {}) };
    assert.equal(matchesJsonSchema(schema, valid), true, item.id);
    for (const branch of schema.oneOf) {
      const base = getModelDecisionSchema().oneOf.find((entry) => entry.properties.intent.const === branch.properties.intent.const);
      const withoutEnums = structuredClone(branch);
      for (const key of ["targetId", "term"]) if (withoutEnums.properties[key]) delete withoutEnums.properties[key].enum;
      if (withoutEnums.properties.sourceIds) delete withoutEnums.properties.sourceIds.items.enum;
      if (withoutEnums.properties.answer) delete withoutEnums.properties.answer.pattern;
      assert.deepEqual(withoutEnums, base, item.id);
      assert.ok(Object.isFrozen(branch));
    }
    assert.equal(JSON.stringify(prepared), beforePrepared);
  }
  assert.equal(JSON.stringify(getModelDecisionSchema()), before);
});

test("subject pattern escapes regex literals, quotes, backslashes and Korean; optional guard is all-or-nothing", async () => {
  const { buildRequiredSubjectPattern: build } = await import("./decision-schema.mjs");
  const subjects = (labels) => labels.map((label) => ({ label }));
  const labels = ['한글.*+?^${}()|[]\\ "quote"', '둘째\\끝'];
  const pattern = build(subjects(labels));
  assert.equal(pattern, '^.*한글\\.\\*\\+\\?\\^\\$\\{\\}\\(\\)\\|\\[\\]\\\\ "quote".*둘째\\\\끝.*$');
  const schema = JSON.parse(JSON.stringify({ type: "string", pattern }));
  assert.equal(matchesJsonSchema(schema, labels.join(" then ")), true);
  assert.equal(matchesJsonSchema(schema, labels.join("\n")), false);
  assert.equal(matchesJsonSchema(schema, labels.join(" ").replace(".*+?", "anything")), false);
  assert.equal(build(subjects(["A", "A", "B"])), "^.*A.*B.*$");
  assert.equal(build(subjects(["B", "A"])), "^.*B.*A.*$");
  for (const invalid of [null, {}, "A", [], [null], [{ label: 1 }], [{ label: {} }],
    subjects(["A", ""]), subjects(["A", " "]), subjects(["A", "B", "C"]), subjects(["A", "B\nC"])]) {
    assert.equal(build(invalid), undefined, JSON.stringify(invalid));
  }
  assert.equal(build(subjects(["*".repeat(1021)])).length, 2048);
  assert.equal(build(subjects(["*".repeat(1019), "?"])).length, 2048);
  assert.equal(build(subjects(["*".repeat(1022)])), undefined);
  assert.equal(build(subjects(["*".repeat(1020), "?"])), undefined, "never impose a partial pattern");
});

test("zero or more than two subjects disable only the optional pattern, not intent/source authorization", () => {
  for (const message of ["자기소개해줘", "P95와 RPS와 N+1을 종합해 설명해줘"]) {
    const prepared = prepare(message);
    const schema = schemaFor(message, prepared);
    assert.deepEqual(schema.oneOf.map((branch) => branch.properties.intent.const), ["answer_portfolio"]);
    assert.equal(Object.hasOwn(schema.oneOf[0].properties.answer, "pattern"), false);
    assert.deepEqual(schema.oneOf[0].properties.sourceIds.items.enum, prepared.candidateSources.map((card) => card.id));
    assert.notStrictEqual(schema, getModelDecisionSchema());
  }
});

test("canonical term enums and unchanged closed fieldsets reject invalid proposals", () => {
  const definition = schemaFor("P95가 뭐야?");
  const valid = { intent: "define_term", confidence: 1, term: "P95" };
  assert.equal(matchesJsonSchema(definition, valid), true);
  for (const proposal of [{ ...valid, term: "p95" }, { ...valid, term: "unknown" }, { ...valid, extra: true },
    { ...valid, answer: "ignored" }, { ...valid, confidence: 1.1 }]) assert.equal(matchesJsonSchema(definition, proposal), false);
  const schema = schemaFor("AWS 경험 있어?");
  const ids = schema.oneOf[0].properties.sourceIds.items.enum;
  const answer = { intent: "answer_portfolio", confidence: 0, answer: "x", sourceIds: [ids[0]] };
  assert.equal(matchesJsonSchema(schema, answer), true);
  for (const proposal of [{ ...answer, answer: "" }, { ...answer, answer: "x".repeat(4001) },
    { ...answer, sourceIds: [] }, { ...answer, sourceIds: [ids[0], ids[0]] },
    { ...answer, sourceIds: Array(7).fill(ids[0]) }, { ...answer, extra: null }]) {
    assert.equal(matchesJsonSchema(schema, proposal), false);
  }
});

test("category, profile, contextual term and navigation pools remain eligible", () => {
  for (const message of ["자기소개해줘", "이은성 이메일 알려줘", "AWS 경험 있어?", "Redis 경험 있어?",
    "비용 최적화 경험 있어?", "P95를 어떻게 줄였어?", "이 포트폴리오에서 뭘 할 수 있어?"]) {
    const prepared = prepare(message);
    const schema = schemaFor(message, prepared);
    assert.deepEqual(schema.oneOf.map((branch) => branch.properties.intent.const), ["answer_portfolio"], message);
    assert.deepEqual(schema.oneOf[0].properties.sourceIds.items.enum, prepared.candidateSources.map((card) => card.id), message);
  }
  for (const message of ["N+1 보여줘", "Bookking ALB로 이동", "About으로 이동"]) {
    const prepared = prepare(message);
    assert.deepEqual(schemaFor(message, prepared).oneOf[0].properties.targetId.enum,
      prepared.groundedRequest.targets.map((target) => target.id), message);
  }
});

test("absent internal preparation stays base; JSON obligations or cloned preparation cannot authorize restrictions", () => {
  const message = "오늘 서울 날씨를 알려줘";
  const prepared = prepare(message);
  for (const request of [{}, { ...prepared.groundedRequest }, structuredClone(prepared.groundedRequest),
    { obligations: { expectedIntents: ["navigate"] }, trustedDecision: { targetIds: ["injected"] } }]) {
    const schema = buildDetailedModelPayload(settings, message, context, request).response_format.json_schema.schema;
    assert.strictEqual(schema, getModelDecisionSchema());
  }
});

test("empty/malformed internal preparation fails closed instead of falling back to base, in either mode", async () => {
  const { registerPreparedDecision } = await import("./decision-schema.mjs");
  const prepared = prepare("CateQuest로 이동");
  const obligations = prepared.obligations;
  for (const expectedIntents of [[], ["unknown_intent"], null, "navigate", [null], ["navigate", "navigate"]]) {
    assert.throws(() => registerPreparedDecision(structuredClone(prepared.groundedRequest),
      { ...obligations, expectedIntents }, context), /prepared|authorized/i);
  }
  for (const intent of ["navigate", "define_term", "answer_portfolio"]) {
    const request = { targets: [], terms: [], candidateSources: [] };
    assert.throws(() => registerPreparedDecision(request, { ...obligations, expectedIntents: [intent] }, context), /authorized/i);
    for (const outputMode of ["plain", "json_schema"]) {
      assert.throws(() => buildDetailedModelPayload({ ...settings, outputMode }, "input", context, request), /prepared|authorized/i);
    }
  }
  for (const patch of [{ allowedSourceIds: null }, { allowedSourceIds: ["unregistered"] },
    { requiredProjectIds: ["about"] }, { requiredSubjectIds: ["glossary:unregistered"] }]) {
    assert.throws(() => registerPreparedDecision(structuredClone(prepared.groundedRequest), { ...obligations, ...patch }, context), /prepared/i);
  }
  for (const request of [null, [], {}, { ...prepared.groundedRequest, targets: null }]) {
    assert.throws(() => registerPreparedDecision(request, obligations, context), /prepared/i);
  }
});

test("specialization follows dynamically ordered/subset base branches, not duplicated generation schemas", async () => {
  const { registerPreparedDecision, specializeDecisionSchema } = await import("./decision-schema.mjs");
  const request = { targets: [{ id: "about" }], terms: [{ term: "P95" }], candidateSources: [{ id: "about" }] };
  registerPreparedDecision(request, { expectedIntents: ["navigate", "define_term", "answer_portfolio", "reject_out_of_scope"],
    allowedSourceIds: ["about"], requiredProjectIds: [], requiredSubjectIds: [], kind: "ordinary" }, context);
  const branches = getModelDecisionSchema().oneOf;
  for (const oneOf of [[branches[3], branches[0]], [branches[2], branches[1]], [...branches].reverse()]) {
    const base = { ...structuredClone(getModelDecisionSchema()), oneOf: structuredClone(oneOf) };
    const before = JSON.stringify(base);
    const specialized = specializeDecisionSchema(base, request);
    assert.deepEqual(specialized.oneOf.map((branch) => branch.properties.intent.const), oneOf.map((branch) => branch.properties.intent.const));
    assert.equal(JSON.stringify(base), before);
  }
  assert.throws(() => specializeDecisionSchema({ type: "object", oneOf: [] }, request), /authorized/i);
});

test("base schema cache is process-local, immutable, and refreshed only by a fresh process", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "decision-schema-cache-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(join(dir, "tools", "nli"), { recursive: true });
  await mkdir(join(dir, "nli"));
  for (const file of ["decision-schema.mjs", "obligation-sources.mjs", "grounded-bounds.mjs"]) {
    await cp(new URL(file, import.meta.url), join(dir, "tools", "nli", file));
  }
  const schemaPath = join(dir, "nli", "model-decision.schema.json");
  await writeFile(schemaPath, JSON.stringify(getModelDecisionSchema()));
  const modulePath = join(dir, "tools", "nli", "decision-schema.mjs");
  const script = `import assert from "node:assert/strict"; import {writeFileSync} from "node:fs";
    import {getModelDecisionSchema} from ${JSON.stringify(modulePath)};
    const first=getModelDecisionSchema(); assert.ok(Object.isFrozen(first.oneOf[0].properties));
    writeFileSync(${JSON.stringify(schemaPath)}, JSON.stringify({...first,title:"fresh process only"}));
    assert.strictEqual(getModelDecisionSchema(),first); console.log(first.title);`;
  const old = spawnSync(process.execPath, ["--input-type=module", "-e", script], { cwd: dir, encoding: "utf8" });
  assert.equal(old.status, 0, old.stderr);
  assert.equal(old.stdout.trim(), getModelDecisionSchema().title);
  const fresh = spawnSync(process.execPath, ["--input-type=module", "-e",
    `import {getModelDecisionSchema} from ${JSON.stringify(modulePath)}; console.log(getModelDecisionSchema().title);`],
  { cwd: dir, encoding: "utf8" });
  assert.equal(fresh.status, 0, fresh.stderr);
  assert.equal(fresh.stdout.trim(), "fresh process only");
});
