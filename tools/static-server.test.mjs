import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";

import { createStaticServer, resolveStaticPath } from "./static-server.mjs";
import { listenForFetch } from "./test-server.mjs";

let root;
let sibling;
let server;
let baseUrl;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "portfolio-static-"));
  sibling = join(dirname(root), `${basename(root)}-sibling`);
  await mkdir(sibling);
  await Promise.all([
    writeFile(join(root, "index.html"), "<main>portfolio</main>"),
    writeFile(join(root, ".env"), "SECRET=do-not-serve"),
    writeFile(join(sibling, "secret.html"), "do-not-serve")
  ]);

  server = createStaticServer({ root });
  baseUrl = await listenForFetch(server);
});

after(async () => {
  await closeServer(server);
  await Promise.all([rm(root, { recursive: true, force: true }), rm(sibling, { recursive: true, force: true })]);
});

test("serves allowed static assets and supports HEAD", async () => {
  const response = await fetch(`${baseUrl}/`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/html; charset=utf-8");
  assert.equal(await response.text(), "<main>portfolio</main>");

  const headResponse = await fetch(`${baseUrl}/`, { method: "HEAD" });
  assert.equal(headResponse.status, 200);
  assert.equal(await headResponse.text(), "");
});

test("does not expose dotfiles, unsupported files, or paths outside the root", async () => {
  const dotfile = await fetch(`${baseUrl}/.env`);
  assert.equal(dotfile.status, 404);

  const unsupported = await fetch(`${baseUrl}/index.txt`);
  assert.equal(unsupported.status, 404);

  const escaped = resolveStaticPath(root, `/%2e%2e%2f${basename(sibling)}/secret.html`);
  assert.equal(escaped.ok, false);
});

test("rejects methods other than GET and HEAD", async () => {
  const response = await fetch(`${baseUrl}/`, { method: "POST" });
  assert.equal(response.status, 405);
  assert.equal(response.headers.get("allow"), "GET, HEAD");
});

function closeServer(serverToClose) {
  if (!serverToClose) return Promise.resolve();
  return new Promise((resolvePromise) => serverToClose.close(() => resolvePromise()));
}
