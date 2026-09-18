// Node owns execution and JUnit/coverage. This reporter only records test counts.
export default async function* summaryReporter(source) {
  const counts = { passed: 0, failed: 0, skipped: 0, todo: 0, cancelled: 0, tests: 0 };
  const files = [];
  const junit = [];
  const plans = new Map();
  const location = (data) => `${data.file}:${data.line}:${data.column}`;
  for await (const event of source) {
    const { data } = event;
    // Only an actual node:test registration emits a per-file summary. The global
    // summary includes synthetic file wrappers, even for zero-byte test files.
    if (event.type === "test:summary" && data.file) {
      const registered = Object.fromEntries(Object.keys(counts).map((key) => [key, data.counts[key]]));
      files.push({ file: data.file, counts: registered });
      for (const key of Object.keys(counts)) counts[key] += registered[key];
    }
    if (event.type === "test:plan" && data.file) plans.set(location(data), data.count);
    if (!["test:pass", "test:fail"].includes(event.type)) continue;
    const children = plans.get(location(data)) ?? 0;
    plans.delete(location(data));
    // These native event facts cross-check JUnit, whose parent tests are suites.
    // No test names, file contents or source text decide whether tests exist.
    junit.push({ name: data.name, nesting: data.nesting, children,
      outcome: data.skip ? "skipped" : data.todo ? "todo" : event.type === "test:fail" ? "failed" : "passed" });
  }
  yield `${JSON.stringify({ ...counts, files, junit })}\n`;
}
