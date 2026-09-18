import { join } from "node:path";

import { defineConfig } from "@playwright/test";

const reportBase = process.env.HARNESS_REPORT_DIR || "test-results";
const reportDirectory = join(reportBase, "playwright");
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;

export default defineConfig({
  testDir: "tests",
  testMatch: /[/\\](?:browser|e2e)[/\\].*\.spec\.mjs$/,
  outputDir: join(reportDirectory, "artifacts"),
  forbidOnly: true,
  retries: 0,
  reporter: [
    ["list"],
    ["junit", { outputFile: join(reportDirectory, "junit.xml") }],
    ["json", { outputFile: join(reportDirectory, "results.json") }],
    ["html", { outputFolder: join(reportDirectory, "html"), open: "never" }]
  ],
  use: {
    headless: true,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    launchOptions: executablePath ? { executablePath } : {}
  },
  projects: [{ name: "chromium", use: { browserName: "chromium" } }]
});
