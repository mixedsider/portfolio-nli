import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";

import { listenForFetch } from "./test-server.mjs";

test("Fetch test listener retries a colliding safe port", async () => {
  const server = new FakeServer([addressInUseError(), null]);

  const baseUrl = await listenForFetch(server);

  assert.match(baseUrl, /^http:\/\/127\.0\.0\.1:[2-5]\d{4}$/);
  assert.ok(server.requestedPorts.every((port) => port >= 20_000 && port < 60_000));
  assert.equal(server.closeCalls, 0);
  assert.equal(server.listenCalls, 2);
});

function addressInUseError() {
  return Object.assign(new Error("Address already in use"), { code: "EADDRINUSE" });
}

class FakeServer extends EventEmitter {
  constructor(outcomes) {
    super();
    this.outcomes = outcomes;
    this.listening = false;
    this.port = null;
    this.closeCalls = 0;
    this.listenCalls = 0;
    this.requestedPorts = [];
  }

  listen(port) {
    this.listenCalls += 1;
    this.requestedPorts.push(port);
    const outcome = this.outcomes.shift();
    if (outcome instanceof Error) {
      queueMicrotask(() => this.emit("error", outcome));
      return;
    }
    this.listening = true;
    this.port = port;
    queueMicrotask(() => this.emit("listening"));
  }

  address() {
    return { port: this.port };
  }

  close(callback) {
    this.listening = false;
    this.closeCalls += 1;
    callback();
  }
}
