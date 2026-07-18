import { randomInt } from "node:crypto";
import { createServer } from "node:net";

const firstFetchSafePort = 20_000;
const firstPortAfterFetchSafeRange = 60_000;
const maximumPortAttempts = 10;

export async function listenForFetch(server, host = "127.0.0.1") {
  for (let attempt = 0; attempt < maximumPortAttempts; attempt += 1) {
    try {
      await listenOnPort(server, host, randomInt(firstFetchSafePort, firstPortAfterFetchSafeRange));
    } catch (error) {
      if (error?.code === "EADDRINUSE") continue;
      throw error;
    }
    const address = server.address();
    if (address && typeof address !== "string") {
      return `http://${host}:${address.port}`;
    }
    await closeServer(server);
    throw new Error("Test server did not expose a TCP address");
  }

  throw new Error(`Could not allocate a Fetch-safe port after ${maximumPortAttempts} attempts`);
}

export async function reserveFetchSafePort(host = "127.0.0.1") {
  const server = createServer();
  try {
    return Number(new URL(await listenForFetch(server, host)).port);
  } finally {
    await closeServer(server);
  }
}

function listenOnPort(server, host, port) {
  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      server.off("error", onError);
      server.off("listening", onListening);
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const onListening = () => {
      cleanup();
      resolvePromise();
    };

    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, host);
  });
}

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    server.close((error) => (error ? reject(error) : resolvePromise()));
  });
}
