import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// LOCAL PREVIEW of the configurable city (simulated brands). A separate page with its own
// public directory: nothing here is part of the Rare City build (`vite build` at the repo root).
//   npm run dev:city-preview      http://localhost:5180/
//   npm run build:city-preview    -> test-artifacts/proofy-city-preview-app
const here = import.meta.dirname

export default defineConfig({
  root: here,
  publicDir: resolve(here, 'public'),
  plugins: [react()],
  server: { port: 5180, strictPort: true, fs: { allow: [resolve(here, '..')] } },
  preview: { port: 5181, strictPort: true },
  build: { outDir: resolve(here, '../test-artifacts/proofy-city-preview-app'), emptyOutDir: true },
})
