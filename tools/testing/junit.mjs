import { SaxesParser } from "saxes";

const countKeys = ["tests", "passed", "failed", "skipped", "todo", "cancelled"];
export function readCounts(value) {
  const counts = Object.fromEntries(countKeys.map((key) => [key, value?.[key]]));
  if (Object.values(counts).some((count) => !Number.isInteger(count) || count < 0)
    || counts.tests !== counts.passed + counts.failed + counts.skipped + counts.todo + counts.cancelled) {
    throw new Error("Invalid or inconsistent test counts");
  }
  return counts;
}
function parseJunit(xml) {
  const parser = new SaxesParser();
  const stack = [];
  let root;
  const allowed = {
    testsuites: ["testsuite", "testcase"], testsuite: ["testsuite", "testcase", "properties", "system-out", "system-err"],
    testcase: ["failure", "error", "skipped", "properties", "system-out", "system-err"],
    properties: ["property"], property: [], failure: [], error: [], skipped: [], "system-out": [], "system-err": []
  };
  parser.on("doctype", () => { throw new Error("JUnit must not contain a DOCTYPE"); });
  parser.on("opentag", (tag) => {
    const parent = stack.at(-1);
    if (!Object.hasOwn(allowed, tag.name) || (!parent && tag.name !== "testsuites")
      || (parent && !allowed[parent.tag].includes(tag.name))) throw new Error("Invalid native JUnit structure");
    const node = { tag: tag.name, attributes: tag.attributes, children: [] };
    if (parent) parent.children.push(node);
    else root = node;
    stack.push(node);
  });
  const text = (value) => {
    if (value.trim() && !["failure", "error", "skipped", "system-out", "system-err", "property"].includes(stack.at(-1)?.tag)) {
      throw new Error("Unexpected text in native JUnit structure");
    }
  };
  parser.on("text", text);
  parser.on("cdata", text);
  parser.on("closetag", () => stack.pop());
  // Saxes throws on malformed nesting, entities, attributes and truncated input.
  parser.write(xml).close();
  if (!root) throw new Error("Missing native JUnit root");
  return root;
}
function numericAttribute(node, key, expected) {
  const value = node.attributes[key];
  if (typeof value !== "string" || !/^\d+$/.test(value) || Number(value) !== expected) {
    throw new Error(`Inconsistent JUnit ${key} count`);
  }
}
export function validateJunit(xml, runner, report) {
  const root = parseJunit(xml);
  const counts = readCounts(report);
  const records = [];
  let expectedIndex = 0;
  const visit = (node, nesting) => {
    const items = node.children.filter((child) => ["testcase", "testsuite"].includes(child.tag));
    const children = items.map((child) => visit(child, nesting + 1));
    if (typeof node.attributes.name !== "string") throw new Error("Unnamed JUnit test or suite");
    const outcomes = node.children.filter((child) => ["failure", "error", "skipped"].includes(child.tag));
    if (outcomes.length > 1) throw new Error("Conflicting JUnit outcomes");
    const marker = outcomes[0];
    const outcome = marker?.tag === "skipped" ? (marker.attributes.type === "todo" ? "todo" : "skipped")
      : marker ? "failed" : "passed";
    const record = { tag: node.tag, name: node.attributes.name, nesting, children: items.length, outcome };
    if (runner === "node") {
      const expected = report.junit?.[expectedIndex++];
      if (!expected || expected.name !== record.name || expected.nesting !== nesting || expected.children !== items.length
        || (node.tag === "testcase" && expected.outcome !== outcome)
        || (node.tag === "testsuite") !== (expected.children > 0)) throw new Error("JUnit/native event outcome or structure mismatch");
      // Node JUnit encodes a parent test's children, not the parent's own failure.
      record.outcome = expected.outcome;
    }
    if (node.tag === "testsuite") {
      numericAttribute(node, "tests", children.length);
      numericAttribute(node, "failures", children.filter((child) => child.outcome === "failed").length);
      numericAttribute(node, "skipped", children.filter((child) => ["skipped", "todo"].includes(child.outcome)).length);
      numericAttribute(node, "errors", 0);
    }
    records.push(record);
    return record;
  };
  root.children.forEach((node) => visit(node, 0));
  if (runner === "node") {
    if (Object.keys(root.attributes).length) throw new Error("Unexpected native Node JUnit root attributes");
    if (!Array.isArray(report.junit) || expectedIndex !== report.junit.length || !Array.isArray(report.files)) {
      throw new Error("Missing native report event counts");
    }
    const totals = Object.fromEntries(countKeys.map((key) => [key, 0]));
    for (const file of report.files) {
      const registered = readCounts(file.counts);
      for (const key of countKeys) totals[key] += registered[key];
    }
    if (countKeys.some((key) => totals[key] !== counts[key])) throw new Error("JUnit/native summary counts mismatch");
  } else {
    if (root.children.some((node) => node.tag !== "testsuite")) throw new Error("Playwright JUnit requires suites");
    const leaves = records.filter((node) => node.tag === "testcase");
    const failed = leaves.filter((node) => node.outcome === "failed").length;
    const skipped = leaves.filter((node) => ["skipped", "todo"].includes(node.outcome)).length;
    numericAttribute(root, "tests", leaves.length);
    numericAttribute(root, "failures", failed);
    numericAttribute(root, "skipped", skipped);
    numericAttribute(root, "errors", 0);
    if (counts.tests !== leaves.length || counts.failed !== failed || counts.skipped !== skipped
      || counts.passed !== leaves.length - failed - skipped) throw new Error("Playwright JUnit/JSON outcome counts mismatch");
  }
  return counts;
}
