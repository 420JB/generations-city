// The entry sits inside the Vite root for the same reason as proofy-city-preview/main.ts:
// the dev server cannot serve a `../` script from index.html, but serves a module import via /@fs/.
import '../src/brand/play/main'
