// The dashboard SPA, embedded into the binary.
//
// `@vzn/vx-ui` (apps/ui) builds to a single self-contained `dist/index.html`
// (JS + CSS inlined — see apps/ui/vite.config.ts). Importing it with
// `{ type: 'file' }` makes `bun build --compile` embed the bytes inside the
// standalone binary; the import resolves to a path (a `/$bunfs/...` path in a
// compiled binary, a real fs path under `bun run`) that `Bun.file()` reads. So
// `vx-cloud serve --ui` works from a bare binary with nothing else on disk.
//
// This module is imported dynamically (only when `--ui` is requested) so a
// source checkout that hasn't run `apps/ui build` doesn't break a serve.

// `with { type: 'file' }` makes this resolve to a path string at runtime, but
// @types/bun types a `.html` import as `HTMLBundle` (its HTML-loader shape) —
// the file-attribute override isn't modelled. Cast at this one seam.
import indexHtml from '@vzn/vx-ui/dist/index.html' with { type: 'file' }

/** Absolute (or bunfs) path to the embedded single-file dashboard. */
export const UI_HTML_PATH = indexHtml as unknown as string
