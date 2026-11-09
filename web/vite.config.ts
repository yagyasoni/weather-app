import { defineConfig } from 'vite'

// GitHub Pages serves the site under /weather-app/. Dev, build and preview all use
// the same base so asset paths behave identically everywhere. Override with
// BASE_PATH=/ for a host that serves the site at the root.
export default defineConfig({
  base: process.env.BASE_PATH ?? '/weather-app/',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
})
