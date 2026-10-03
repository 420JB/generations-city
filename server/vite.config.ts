import { defineConfig } from 'vite'

// Server bundle: `vite build --config server/vite.config.ts`, run from the repository root.
// Node dependencies (pg) stay external; shared engine code from src/ is bundled in.
export default defineConfig({
  publicDir: false,
  build: {
    ssr: true,
    target: 'node22',
    outDir: 'dist-server',
    emptyOutDir: true,
    rolldownOptions: {
      input: { main: 'server/src/main.ts', migrate: 'server/src/migrate-cli.ts', 'seed-demo': 'server/src/seed-demo-cli.ts', genesis: 'server/src/genesis-cli.ts', verify: 'server/src/verify-cli.ts' },
    },
  },
})
