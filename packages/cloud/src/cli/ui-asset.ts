// The dashboard SPA, embedded into the binary.
//
// The dashboard lives INSIDE this package (`packages/cloud/ui`) and builds to a
// single self-contained `ui/dist/index.html` (JS + CSS inlined — see
// `ui/vite.config.ts`). That dist is a BUILD ARTIFACT, not committed: the
// vx-cloud build produces it (`vx run build.ui` locally; the npm package +
// Docker image build the SPA before packaging/compiling). Importing it with
// `{ type: 'file' }` makes `bun build --compile` embed the bytes inside the
// standalone binary; the import resolves to a path (a `/$bunfs/...` path in a
// compiled binary, a real fs path under `bun run`) that `Bun.file()` reads. So
// `vx-cloud serve` serves the dashboard from a bare binary with nothing else on
// disk — the cloud package is self-contained (no separate `@vzn/vx-ui`).
//
// This module is imported dynamically (only when the UI is served) so a source
// checkout that hasn't built the SPA yet degrades to an API-only serve
// (loadUiHtmlPath returns null) instead of failing.

// `with { type: 'file' }` makes this resolve to a path string at runtime, but
// @types/bun types a `.html` import as `HTMLBundle` (its HTML-loader shape) —
// the file-attribute override isn't modelled. Cast at this one seam. The path
// is relative (../../ui/dist) — within the package, no external resolution.
import indexHtml from '../../ui/dist/index.html' with { type: 'file' }

/** Absolute (or bunfs) path to the embedded single-file dashboard. */
export const UI_HTML_PATH = indexHtml as unknown as string
