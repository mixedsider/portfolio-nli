import { expect, test } from "@playwright/test";
import { resolve } from "node:path";
import { createStaticServer } from "../../tools/static-server.mjs";
import { listenForFetch } from "../../tools/test-server.mjs";

// Include the scrollbar width that the real in-app browser reserves.
test.use({ launchOptions: {
  ...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH } : {}),
  ignoreDefaultArgs: ["--hide-scrollbars"]
} });

let server;
let baseUrl;
test.beforeAll(async () => {
  server = createStaticServer({ root: resolve(".") });
  baseUrl = await listenForFetch(server);
});
test.afterAll(async () => {
  await new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

const fixture = {
  profile: { name: "테스트", englishName: "Tester", role: "백엔드 개발자", headline: "개선 과정을 기록합니다", summary: "직접 검증한 내용을 소개합니다.", contacts: [{ label: "Email", value: "test@example.com", href: "mailto:test@example.com" }] },
  metrics: [{ label: "로컬 조회", value: "53 → 1회", caption: "일기 50건, 방식별 15회", tone: "blue", target: "project-sample-case" }],
  projects: [{ id: "sample", title: "샘플 프로젝트", period: "2026", description: "검증용 프로젝트", tags: ["Java"], focus: ["성능"], metadata: [{ label: "담당", value: "백엔드 구현" }], links: [{ label: "GitHub", href: "https://github.com/example/sample" }, { label: "잘못된 링크", href: "javascript:alert(1)" }], sections: [{ id: "project-sample-case", title: "개선 사례", result: "로컬 환경에서 조회 감소", problem: ["<em>문자 그대로</em>"], analyze: ["요청 흐름 분석"], action: ["조회 방식 수정"], resultDetails: ["운영 검증은 하지 않음"], measurementNotes: ["PostgreSQL 17, 일기 50건, 방식별 15회"], examples: ["공부한 내용을 설명해 주세요."], tables: [{ caption: "로컬 측정", headers: ["방식", "SQL", "조회·DTO 조립", "비고"], rows: [["개선 전", "53회", "7.785ms", "중앙값"], ["개선 후", "1회", "1.557ms", "중앙값"]] }], images: [{ src: "assets/profile.png", alt: "샘플 이미지" }] }] }],
  experience: { mentoring: { title: "백엔드 멘토링", period: "2025", summary: "학습 내용을 공유했습니다.", href: "https://github.com/example/mentoring" }, tools: [{ title: "개인 도구", summary: "필요한 작업 자동화", href: "https://github.com/example/tool" }], education: [{ title: "개발 교육", period: "2024" }], awards: [{ title: "프로젝트 수상", period: "2025" }], certifications: [{ title: "정보처리기사", period: "2026" }] }
};

async function openFixture(page, content = fixture) {
  await page.route("**/data/portfolio.js", (route) => route.fulfill({ contentType: "text/javascript", body: `window.PORTFOLIO_DATA = ${JSON.stringify(content)};` }));
  await page.goto(baseUrl);
}

test("프로젝트의 담당·링크·측정 조건·출력 예시와 추가 경험을 기본 화면에서 읽을 수 있다", async ({ page }) => {
  await openFixture(page);
  await expect(page.locator("#project-sample")).toContainText("백엔드 구현");
  await expect(page.locator("#project-sample a", { hasText: "GitHub" })).toHaveAttribute("href", "https://github.com/example/sample");
  await expect(page.locator("#project-sample-case")).toContainText("PostgreSQL 17, 일기 50건, 방식별 15회");
  await expect(page.locator("#project-sample-case")).toContainText("공부한 내용을 설명해 주세요.");
  await expect(page.locator("#project-sample-case .case-copy")).toBeVisible();
  await expect(page.locator("#about")).toContainText("백엔드 멘토링");
  await expect(page.locator("#about")).toContainText("정보처리기사");
});

test("핵심 결과에 이미 담긴 문장은 PAAR 결과에서 중복해 보여주지 않는다", async ({ page }) => {
  const repeated = structuredClone(fixture);
  repeated.projects[0].sections[0].resultDetails = ["로컬 환경에서 조회 감소"];
  await openFixture(page, repeated);
  const text = await page.locator("#project-sample-case").innerText();
  expect(text.split("로컬 환경에서 조회 감소").length - 1).toBe(1);
});

test("실제 데이터의 모든 프로젝트·사례와 개요·지표의 이동 대상이 존재한다", async ({ page }) => {
  await page.goto(baseUrl);
  await expect(page.locator("[data-project-card]")).toHaveCount(3);
  await expect(page.locator("[data-case-block]")).toHaveCount(7);
  await expect(page.locator("[data-project-overview] article")).toHaveCount(3);
  const missing = await page.locator("[data-scroll-target]").evaluateAll((elements) => elements.map((element) => element.dataset.scrollTarget).filter((id) => !document.getElementById(id)));
  expect(missing).toEqual([]);
});

test("텍스트를 HTML로 해석하거나 실행 가능한 URL을 링크로 렌더링하지 않는다", async ({ page }) => {
  await openFixture(page);
  await expect(page.locator("#project-sample-case")).toContainText("<em>문자 그대로</em>");
  await expect(page.locator("#project-sample-case em")).toHaveCount(0);
  await expect(page.locator("a[href^='javascript:']")).toHaveCount(0);
});

test("좁은 화면에서 표만 가로 스크롤하고 개요·지표 이동과 필터를 유지한다", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openFixture(page);
  const overview = page.locator("[data-project-overview] [data-scroll-target='project-sample']");
  await expect(overview).toBeVisible();
  await overview.click();
  await expect(page.locator("#project-sample")).toBeInViewport();
  await page.locator("[data-filter='성능']").click();
  await expect(page.locator("[data-filter='성능']")).toHaveAttribute("aria-pressed", "true");
  await page.locator("[data-metric-grid] [data-scroll-target]").click();
  await expect(page.locator("#project-sample-case")).toBeInViewport();
  const sizes = await page.evaluate(() => ({ viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth, table: document.querySelector(".table-scroll").scrollWidth, tableViewport: document.querySelector(".table-scroll").clientWidth }));
  expect(sizes.document).toBeLessThanOrEqual(sizes.viewport);
  expect(sizes.table).toBeGreaterThan(sizes.tableViewport);
  await expect(page.locator(".case-images figure")).toHaveJSProperty("scrollWidth", await page.locator(".case-images figure").evaluate((el) => el.clientWidth));
});

async function readLayout(page) {
  return page.evaluate(() => {
    const rect = (selector) => {
      const { x, right, width } = document.querySelector(selector).getBoundingClientRect();
      return { x, right, width };
    };
    return {
      main: rect("main"), hero: rect(".hero-section"), copy: rect(".hero-copy"),
      footer: rect(".site-footer"), panel: rect("[data-nli-panel]"),
      viewport: document.documentElement.clientWidth, document: document.documentElement.scrollWidth
    };
  });
}

for (const width of [1440, 1280, 1040, 1024, 791, 768, 390]) {
  test(`${width}px 창에서 도우미를 열고 닫아도 본문이 찌그러지거나 푸터가 밀리지 않는다`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(baseUrl);
    const closed = await readLayout(page);
    await page.locator("[data-nli-open]").click();
    const opened = await readLayout(page);
    expect(opened.document).toBeLessThanOrEqual(opened.viewport);
    expect(opened.copy.width).toBeGreaterThanOrEqual(250);
    if (opened.viewport >= 1040) {
      expect(opened.main.width).toBeGreaterThanOrEqual(720);
      expect(opened.main.right).toBeCloseTo(opened.panel.x, 0);
      expect(opened.footer.right).toBeLessThanOrEqual(opened.panel.x);
    } else {
      expect(opened.main).toEqual(closed.main);
      expect(opened.hero).toEqual(closed.hero);
      expect(opened.footer).toEqual(closed.footer);
    }
    await page.locator("[data-nli-close]").click();
    const restored = await readLayout(page);
    expect(restored.main).toEqual(closed.main);
    expect(restored.footer).toEqual(closed.footer);
  });
}

test("도우미를 최대로 넓혀도 본문 폭을 확보하고 창 크기를 바꿔도 선택한 너비를 복원한다", async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(baseUrl);
  await page.locator("[data-nli-open]").click();
  const initial = await readLayout(page);
  const handle = page.locator("[data-nli-resize]");
  await handle.press("ArrowLeft");
  const resized = await readLayout(page);
  expect(resized.panel.width).toBe(initial.panel.width + 24);
  await handle.press("End");
  const largest = await readLayout(page);
  expect(largest.main.width).toBeGreaterThanOrEqual(720);
  expect(largest.copy.width).toBeGreaterThanOrEqual(250);
  expect(largest.footer.right).toBeLessThanOrEqual(largest.panel.x);
  await handle.press("Home");
  await handle.press("ArrowLeft");
  const preferred = await readLayout(page);
  for (const width of [1040, 760, 390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    await expect.poll(async () => (await readLayout(page)).document).toBeLessThanOrEqual(width);
  }
  await expect.poll(async () => (await readLayout(page)).panel.width).toBe(preferred.panel.width);
  await page.locator("[data-nli-close]").click();
  await page.setViewportSize({ width: 1040, height: 900 });
  await page.locator("[data-nli-open]").click();
  const reopened = await readLayout(page);
  expect(reopened.main.width).toBeGreaterThanOrEqual(720);
  await page.setViewportSize({ width: 1440, height: 900 });
  await expect.poll(async () => (await readLayout(page)).panel.width).toBe(preferred.panel.width);
});

test.describe("일반 세로 스크롤바가 있는 브라우저", () => {
  test("스크롤바 폭을 제외해 도킹하고 패널을 드래그할 때 너비가 튀지 않는다", async ({ page }) => {
    await page.setViewportSize({ width: 1040, height: 900 });
    await page.goto(baseUrl);
    const closed = await readLayout(page);
    await page.locator("[data-nli-open]").click();
    const opened = await readLayout(page);
    if (opened.viewport < 1040) expect(opened.main).toEqual(closed.main);
    await page.setViewportSize({ width: 1440, height: 900 });
    const handle = page.locator("[data-nli-resize]");
    await handle.press("End");
    const largest = await readLayout(page);
    expect(largest.main.width).toBeGreaterThanOrEqual(720);
    expect(largest.main.right).toBeCloseTo(largest.panel.x, 0);
    expect(largest.document).toBeLessThanOrEqual(largest.viewport);
    const handleBox = await handle.boundingBox();
    await page.mouse.move(largest.panel.x, handleBox.y + handleBox.height / 2);
    await page.mouse.down();
    await page.mouse.move(largest.panel.x + 24, handleBox.y + handleBox.height / 2);
    await page.mouse.up();
    expect((await readLayout(page)).panel.width).toBe(largest.panel.width - 24);
    await page.setViewportSize({ width: 390, height: 900 });
    await expect.poll(async () => {
      const layout = await readLayout(page);
      return layout.panel.right - layout.viewport;
    }).toBe(0);
  });
});

for (const viewport of [{ width: 320, height: 568 }, { width: 390, height: 844 }, { width: 1440, height: 900 }]) {
  test(`${viewport.width}px 터치 화면에서 최소화한 도우미가 본문 조작을 막지 않는다`, async ({ browser }) => {
    const context = await browser.newContext({ viewport, hasTouch: true, isMobile: viewport.width < 760, reducedMotion: "reduce" });
    try {
      const page = await context.newPage();
      await page.goto(baseUrl);
      await page.locator("[data-nli-open]").tap();
      await page.locator("[data-nli-input]").fill("입력 보존 확인");
      await page.locator("[data-nli-minimize]").tap();
      expect((await page.locator("[data-nli-widget]").boundingBox()).height).toBeLessThan(160);
      await expect(page.locator("[data-nli-form]")).toBeHidden();
      await page.locator(".nav-links a[href='#about']").tap();
      await expect(page.locator("#about")).toBeInViewport();
      if (viewport.width < 760) {
        await page.setViewportSize({ width: 844, height: 390 });
        expect((await page.locator("[data-nli-widget]").boundingBox()).height).toBeLessThan(160);
      }
      await page.locator("[data-nli-minimize]").tap();
      await expect(page.locator("[data-nli-input]")).toBeVisible();
      await expect(page.locator("[data-nli-input]")).toHaveValue("입력 보존 확인");
      await page.locator("[data-nli-close]").tap();
      await expect(page.locator("[data-nli-panel]")).toBeHidden();
    } finally {
      await context.close();
    }
  });
}
