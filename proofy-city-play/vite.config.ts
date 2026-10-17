import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// LOCAL PROOFY PLAY LAUNCH PAGE: Rare City's launch URL for a local Proofy Play. A separate page,
// not part of the Rare City build. It shares the preview's /brand-media/ set (the only media a
// configuration may name) and forwards /v1/play to a local Rare City server, so the browser
// talks to one origin, exactly as it would to a deployed Rare City.
//   npm run dev:city-play      http://localhost:4352/   (Rare City server on RARE_CITY_SERVER, default http://127.0.0.1:4351)
//   npm run build:city-play    -> test-artifacts/proofy-city-play-app
const here = import.meta.dirname
const server = process.env.RARE_CITY_SERVER ?? 'http://127.0.0.1:4351'
// Origin is passed through untouched: the Rare City server checks it against its PUBLIC_ORIGIN.
const proxy = { '/v1/play': { target: server, changeOrigin: false } }

export default defineConfig({
  root: here,
  publicDir: resolve(here, '../proofy-city-preview/public'),
  plugins: [react()],
  server: { port: 4352, strictPort: true, fs: { allow: [resolve(here, '..')] }, proxy },
  preview: { port: 4352, strictPort: true, proxy },
  build: { outDir: resolve(here, '../test-artifacts/proofy-city-play-app'), emptyOutDir: true },
})
