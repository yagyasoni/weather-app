import { defineConfig } from '@playwright/test'

const PORT = 5174
const URL = `http://127.0.0.1:${PORT}/weather-app/`

// Browser tests run against the dev server, which serves the checked-in sample run.
export default defineConfig({
  testDir: 'e2e',
  timeout: 60_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: URL,
    viewport: { width: 1280, height: 800 },
    // software WebGL so MapLibre renders in headless Chromium
    launchOptions: { args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] },
  },
  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort --host 127.0.0.1`,
    url: URL,
    reuseExistingServer: !process.env.CI,
  },
})
