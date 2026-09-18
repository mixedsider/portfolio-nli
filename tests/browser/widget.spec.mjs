import { createServer } from "node:http";

import { chromium, expect, test } from "@playwright/test";

import { installWidgetBrowserNetwork } from "../../tools/nli/widget-browser-network.mjs";
import { runNliWidgetBrowserTest } from "../../tools/nli-widget.browser-test.mjs";
import { listenForFetch } from "../../tools/test-server.mjs";

const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
const launchOptions = executablePath ? { executablePath } : {};

test("BROWSERINTEGRATION: legacy NLI widget regression uses canned gateway responses", async () => {
  const result = await runNliWidgetBrowserTest({ chromium, launchOptions });

  expect(result.primary.historyEntries).toBe(6);
  expect(result.persistence.sourceButtonsAfterReload).toBe(4);
  expect(Math.round(result.mobile.width)).toBe(390);
});

test("BROWSERINTEGRATION: context policy blocks and reports an unallowlisted loopback probe", async () => {
  const origin = createServer((_request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<main>fixture origin</main>");
  });
  let originUrl = "";
  let probeHits = 0;
  const probe = createServer((_request, response) => {
    probeHits += 1;
    response.writeHead(200, { "access-control-allow-origin": originUrl });
    response.end("probe reached");
  });
  let browser;
  let context;

  try {
    originUrl = await listenForFetch(origin);
    const probeUrl = await listenForFetch(probe);
    const normalizedProbeUrl = new URL(probeUrl).href;
    browser = await chromium.launch({ headless: true, ...launchOptions });
    context = await browser.newContext();
    const policy = await installWidgetBrowserNetwork(context, {
      staticUrl: originUrl,
      onGatewayRequest: (route) => route.fulfill({ status: 200, contentType: "application/json", body: "{}" })
    });
    const page = await context.newPage();
    await page.goto(originUrl, { waitUntil: "load" });

    await expect(page.evaluate((url) => fetch(url).then(() => "reached").catch(() => "blocked"), normalizedProbeUrl)).resolves.toBe("blocked");
    expect(probeHits).toBe(0);
    expect(policy.unexpectedRequests).toEqual([{ url: normalizedProbeUrl, resourceType: "fetch" }]);
    expect(() => policy.assertNoUnexpectedRequests()).toThrow(`Unexpected browser destination: ${normalizedProbeUrl}`);
  } finally {
    try {
      await context?.close();
    } finally {
      try {
        await browser?.close();
      } finally {
        await Promise.all([closeServer(origin), closeServer(probe)]);
      }
    }
  }
});

function closeServer(server) {
  if (!server.listening) return Promise.resolve();
  return new Promise((resolvePromise, reject) => server.close((error) => (error ? reject(error) : resolvePromise())));
}
