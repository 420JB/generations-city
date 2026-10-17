// The page's entry must sit inside the Vite root: the dev server cannot serve a `../` script
// from index.html (the browser asks for /src/..., which is outside this root and 404s), while
// a module import of a file outside the root is served through /@fs/ (allowed in vite.config).
import '../src/brand/preview/main'
