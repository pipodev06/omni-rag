import { defineConfig, devices } from "@playwright/test";

/**
 * Pruebas de extremo a extremo contra un sistema en marcha (docs/desarrollo.md → «Pruebas de extremo a extremo»).
 *
 *   E2E_USER=<superadmin> E2E_PASSWORD=<su contraseña> pnpm --filter @rag/web e2e
 *
 * Crean una organización temporal y la borran al terminar. Nada de credenciales en el repositorio: se pasan por entorno.
 * Los archivos se llaman *.e2e.ts para que Vitest no los recoja.
 */
export default defineConfig({
  testDir: "./e2e",
  testMatch: "**/*.e2e.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  reporter: process.env.CI ? "github" : [["list"], ["html", { open: "never" }]],
  globalSetup: "./e2e/global-setup.ts",
  globalTeardown: "./e2e/global-teardown.ts",
  use: {
    baseURL: process.env.E2E_BASE_URL ?? "http://localhost:8000",
    locale: "es-PE",
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
  },
  projects: [
    {
      name: "chromium",
      // E2E_BROWSER_CHANNEL=chrome usa el Chrome instalado; sin él, el Chromium de `npx playwright install chromium`.
      use: { ...devices["Desktop Chrome"], channel: process.env.E2E_BROWSER_CHANNEL || undefined },
    },
  ],
});
