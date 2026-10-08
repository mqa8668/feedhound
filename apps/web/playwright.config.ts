import { defineConfig, devices } from "@playwright/test";

const PORT = Number(process.env.WEB_PORT ?? 4823);

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  reporter: [["html", { outputFolder: "test-results/html", open: "never" }]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "on-first-retry",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
