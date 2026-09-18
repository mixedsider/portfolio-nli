import { expect, test } from "@playwright/test";

import { startTestApp } from "../support/app-process.mjs";

const gatewayEndpoint = "https://portfolio-nli-gateway.mixedsider.cloud/api/nli";
const desktop = { width: 1280, height: 900 };
const mobile = { width: 390, height: 844 };

async function withApp(browser, { closeContext = (context) => context.close(), ...options }, verify) {
  const app = await startTestApp(options);
  let context;

  try {
    context = await browser.newContext({ viewport: options.viewport });
    const staticOrigin = new URL(app.staticUrl).origin;
    const localOrigins = new Set([staticOrigin, new URL(app.gatewayUrl).origin]);
    const forwarded = [];
    const blocked = [];
    await context.route("**/*", async (route) => {
      const request = route.request();
      const url = request.url();
      if (url === gatewayEndpoint) {
        const headers = await request.allHeaders();
        const response = await route.fetch({
          url: `${app.gatewayUrl}/api/nli`,
          method: request.method(),
          postData: request.postDataBuffer()
        });
        forwarded.push({
          method: request.method(),
          body: request.postData() ? JSON.parse(request.postData()) : null,
          origin: headers.origin || "",
          status: response.status()
        });
        await route.fulfill({ response });
        return;
      }

      const origin = new URL(url).origin;
      if (localOrigins.has(origin)) {
        await route.continue();
        return;
      }

      const font = request.resourceType() === "font" ||
        ["https://fonts.googleapis.com", "https://fonts.gstatic.com"].includes(origin);
      blocked.push({ url, font });
      await route.abort("blockedbyclient");
    });

    const page = await context.newPage();
    const result = await verify({ app, page, forwarded, staticOrigin });
    expect(blocked.filter((request) => !request.font)).toEqual([]);
    return result;
  } finally {
    try {
      if (context) await closeContext(context);
    } finally {
      await app.close();
    }
  }
}

async function openWidget(page) {
  await page.locator("[data-nli-open]").click();
  await expect(page.locator("[data-nli-panel]")).toBeVisible();
}

async function submit(page, message) {
  const assistantMessages = page.locator(".nli-message.is-assistant p");
  const responseIndex = await assistantMessages.count();
  await page.locator("[data-nli-input]").fill(message);
  await page.locator("[data-nli-form]").press("Enter");
  await expect(assistantMessages).toHaveCount(responseIndex + 1);
  await expect(page.locator(".nli-message.is-pending")).toHaveCount(0);
  return assistantMessages.nth(responseIndex);
}

function latestPost(forwarded, staticOrigin) {
  const request = forwarded.filter((entry) => entry.method === "POST").at(-1);
  expect(request).toBeDefined();
  expect(request.origin).toBe(staticOrigin);
  return request;
}

test("E2E: exact help takes the real gateway local path without model calls", async ({ browser }) => {
  await withApp(browser, { scenario: "healthy", viewport: desktop }, async ({ app, page, forwarded, staticOrigin }) => {
    await page.goto(app.staticUrl, { waitUntil: "load" });
    await openWidget(page);

    const reply = await submit(page, "도움말");
    const request = latestPost(forwarded, staticOrigin);
    await expect(reply).toContainText("저는 이 포트폴리오 안에서 전체 요약");
    expect(request).toMatchObject({ status: 200, body: { message: "도움말" } });
    expect(await app.stats()).toEqual({ lfm: 0, qwen: 0 });
  });
});

test("E2E: profile uses LFM, exposes a real source button, and navigates", async ({ browser }) => {
  await withApp(browser, { scenario: "healthy", viewport: desktop }, async ({ app, page, forwarded, staticOrigin }) => {
    await page.goto(app.staticUrl, { waitUntil: "load" });
    await openWidget(page);

    const reply = await submit(page, "자기소개해줘");
    const request = latestPost(forwarded, staticOrigin);
    const source = page.locator(".nli-message-sources button[data-scroll-target='about']");
    await expect(reply).toContainText("Backend & Infra Developer");
    await expect(source).toBeVisible();
    await source.click();
    await expect(page.locator("#about")).toBeInViewport();
    expect(request).toMatchObject({ status: 200, body: { message: "자기소개해줘" } });
    expect(await app.stats()).toEqual({ lfm: 1, qwen: 0 });
  });
});

test("E2E: comparison follows the fixture proof through LFM and Qwen", async ({ browser }) => {
  await withApp(browser, { scenario: "escalation", viewport: desktop }, async ({ app, page, forwarded, staticOrigin }) => {
    await page.goto(app.staticUrl, { waitUntil: "load" });
    await openWidget(page);

    const reply = await submit(page, "CateQuest와 Bookking의 성능 개선을 비교해줘");
    const request = latestPost(forwarded, staticOrigin);
    await expect(reply).toContainText("54회에서 1회");
    await expect(reply).toContainText("200ms에서 30ms");
    await expect(page.locator(".nli-message-sources button")).toHaveCount(2);
    expect(request).toMatchObject({ status: 200, body: { message: "CateQuest와 Bookking의 성능 개선을 비교해줘" } });
    expect(await app.stats()).toEqual({ lfm: 1, qwen: 1 });
  });
});

test("E2E: real upstream 503 reports an error and re-enables the form", async ({ browser }) => {
  await withApp(browser, { scenario: "upstream-error", viewport: desktop }, async ({ app, page, forwarded, staticOrigin }) => {
    await page.goto(app.staticUrl, { waitUntil: "load" });
    await openWidget(page);

    const reply = await submit(page, "포트폴리오 정보의 색상은?");
    const request = latestPost(forwarded, staticOrigin);
    await expect(reply).toContainText("일시적으로 가져오지 못했습니다");
    await expect(page.locator("[data-nli-input]")).toBeEnabled();
    await expect(page.locator("[data-nli-submit]")).toBeEnabled();
    expect(request).toMatchObject({ status: 503, body: { message: "포트폴리오 정보의 색상은?" } });
    expect(await app.stats()).toEqual({ lfm: 1, qwen: 0 });
  });
});

test("E2E: fixture teardown survives a controlled context-close failure", async ({ browser }) => {
  let app;
  await expect(withApp(browser, {
    scenario: "healthy",
    viewport: desktop,
    closeContext: async (context) => {
      await context.close();
      throw new Error("controlled context close failure");
    }
  }, async ({ app: startedApp, page }) => {
    app = startedApp;
    await page.goto(app.staticUrl, { waitUntil: "load" });
  })).rejects.toThrow("controlled context close failure");

  expect(app).toBeDefined();
  await expect(fetch(`${app.staticUrl}/`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
  await expect(fetch(`${app.gatewayUrl}/api/nli/health`, { signal: AbortSignal.timeout(3000) })).rejects.toThrow();
});

test("E2E: mobile history is bounded, includes the current target, and persists", async ({ browser }) => {
  await withApp(browser, { scenario: "healthy", viewport: mobile }, async ({ app, page, forwarded, staticOrigin }) => {
    await page.goto(app.staticUrl, { waitUntil: "load" });
    await page.locator("#project-catequest").scrollIntoViewIfNeeded();
    await openWidget(page);
    const panel = await page.locator("[data-nli-panel]").boundingBox();
    expect(Math.round(panel.width)).toBe(mobile.width);

    for (let index = 0; index < 7; index += 1) await submit(page, "도움말");
    const request = latestPost(forwarded, staticOrigin);
    expect(request).toMatchObject({ status: 200, body: { message: "도움말", currentTargetId: "project-catequest" } });
    expect(request.body.history).toHaveLength(6);
    expect(request.body.history.every((entry) => ["user", "assistant"].includes(entry.role) && typeof entry.text === "string")).toBe(true);
    expect(Math.max(...request.body.history.map((entry) => Buffer.byteLength(entry.text)))).toBeLessThanOrEqual(480);
    expect(await app.stats()).toEqual({ lfm: 0, qwen: 0 });

    await page.reload({ waitUntil: "load" });
    await openWidget(page);
    await expect(page.locator(".nli-message.is-user p").last()).toHaveText("도움말");
  });
});
