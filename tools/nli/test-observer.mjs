// Correlate trusted resolver events. The caller owns fixture/request association and
// waits for transport settlement before snapshotting; attempts are not dispatches.
export function createStageObserver() {
  const requests = new Map();
  function observer(event) {
    if (typeof event.requestId !== "string") throw new Error("Observer event requires server requestId");
    if (event.type === "request") {
      if (requests.has(event.requestId)) throw new Error("Duplicate request start");
      requests.set(event.requestId, { attempts: { lfm: 0, qwen: 0 }, transports: { lfm: [], qwen: [] }, complete: null });
      return;
    }
    const record = requests.get(event.requestId);
    if (!record) throw new Error("Unknown observer requestId");
    if (["lfm", "qwen"].includes(event.stage)) {
      if (event.type === "attempt") record.attempts[event.stage] += 1;
      if (event.type === "transport") {
        if (![0, 1].includes(event.dispatchCount)) throw new Error("Invalid dispatchCount");
        record.transports[event.stage].push(event.dispatchCount);
      }
    }
    if (event.type === "complete") record.complete = { stage: event.stage, reason: event.reason };
  }
  function snapshot(requestId) {
    const record = requests.get(requestId);
    if (!record) throw new Error("Unknown observer requestId");
    const result = { ...record.complete };
    for (const stage of ["lfm", "qwen"]) {
      const transports = record.transports[stage];
      const known = record.complete && record.complete.stage !== "legacy" && transports.length === record.attempts[stage];
      result[`${stage}Calls`] = known ? transports.reduce((sum, count) => sum + count, 0) : undefined;
    }
    return result;
  }
  return { observer, snapshot, requestIds: () => [...requests.keys()], clear: () => requests.clear() };
}
