export function createModelAdmission(limit = 4) {
  const sharedLimit = boundedLimit(limit);
  const endpoints = new Map();
  let active = 0;
  return Object.freeze({
    get active() { return active; },
    activeFor(endpoint) { return endpoints.get(endpoint) || 0; },
    acquire(endpoint, limit = 4) {
      const endpointLimit = boundedLimit(limit);
      const count = endpoints.get(endpoint) || 0;
      if (active >= sharedLimit || count >= endpointLimit) return null;
      active += 1;
      endpoints.set(endpoint, count + 1);
      let released = false;
      return () => {
        if (released) return;
        released = true;
        active -= 1;
        const remaining = endpoints.get(endpoint) - 1;
        if (remaining) endpoints.set(endpoint, remaining);
        else endpoints.delete(endpoint);
      };
    }
  });
}

function boundedLimit(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error("Invalid model admission limit");
  return Math.min(value, 4);
}
