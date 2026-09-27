# README and site: what drives adoption (2026-09-27)

Stream K's study of 15 dev-tool READMEs and four landing pages, and what
vx takes from it. Raw READMEs read on 2026-09-27; landing pages read from
their repos' source (the sites and github.com/trending were unreachable
from the container, 403, so a stars-sorted search of repos created since
2026-08-27 stood in for trending).

## Findings

1. **One hero sentence, 8–15 words, naming the category.** uv: "An
   extremely fast Python package and project manager, written in Rust."
   Ruff the same shape. Hono "ultrafast", Tauri "blazingly fast". Newer
   heroes lead with position over speed (Turborepo: "the build system for
   coding agents").
2. **Dark/light assets through `<picture>`**: 9 of 15 (Vite, Oxc, Biome,
   Nx, Turborepo, Excalidraw, uv and Ruff's charts; Drizzle via
   `#gh-dark-mode-only`).
3. **The benchmark chart is the second thing seen when speed is the
   thesis.** uv and Ruff: a bar chart, dark and light SVGs, a one-line
   caption naming the workload; uv links its claim to BENCHMARKS.md
   (caveats, "lower is better", a reproduction script). Biome's site
   animates bars with the hardware and file count in the caption.
4. **Migration reads as parity, not a guide.** uv: "drop-in replacement
   … without changing your existing workflows". Ruff: "drop-in parity
   with Flake8, isort, and Black". Biome: "97% compatibility with
   Prettier". Nx: "`npx nx init` … no changes to your setup required".
5. **Install within ~50 lines, one copyable line.** uv 44, Bun 44,
   Biome 49, Ollama 16. Projects that defer install to the site
   (Turborepo, Nx, Zed) are company-backed and already known.
6. **Social proof, strongest first:** named testimonials with numbers
   (Ruff), named adopters (Oxc, Vite, Biome), live metrics (Nx, Turborepo),
   sponsor walls, a stars badge.
7. **Landing template** (Vite, Oxc, Biome, Turborepo): headline + one-line
   subhead, Get started + GitHub, a copyable install box, one visual
   proof, a logo strip, 3–7 feature cards, a footer CTA.
8. **Transcript demos with timings** (uv's "Resolved 2 packages in
   170ms") put the speed proof inside the quick start. A playground link
   (Biome, Oxc, Ruff).
9. **Short READMEs that defer to the site work only once famous.** uv,
   Ruff, Bun and Ollama grew through a README that stands alone.

## Applied to vx

- Root README (also the `@vzn/vx` npm page): centred logo, the site's
  hero line, four badges, a dark/light benchmark chart generated from
  `packages/vx-bench/results.json` by `update-site.ts` (so it cannot
  drift from the numbers; `check.site` holds it), install on one line,
  a quick start run end to end (init, a cache block, miss → up-to-date
  → restored), "Already on Turborepo or Nx?" as parity (`turbo()` /
  `nx()` with nothing rewritten, then `bunx @vzn/vx-migrate`), six why
  bullets, the comparison table, a plugin table. Architecture, lock and
  mapping details moved to the docs they repeated.
- Not taken: testimonials and adopter logos (vx has none to cite yet); a
  stars badge (no signal at this size).

## Sources

- `https://raw.githubusercontent.com/<repo>/HEAD/README.md` for
  oven-sh/bun, vitejs/vite, biomejs/biome (and
  `packages/@biomejs/biome/README.md`), oxc-project/oxc, astral-sh/uv (and
  `BENCHMARKS.md`), astral-sh/ruff, vercel/turborepo, nrwl/nx,
  tauri-apps/tauri, zed-industries/zed, shadcn-ui/ui,
  excalidraw/excalidraw, ollama/ollama, honojs/hono,
  drizzle-team/drizzle-orm.
- Landing source: vitejs/vite `docs/.vitepress/theme/landing/`,
  oxc-project/website `.vitepress/theme/landing/`, biomejs/website
  `src/content/docs/en/index.mdx`, vercel/turborepo
  `apps/docs/app/[lang]/(home)/page.tsx`.
- Not reached (403): bun.sh, vite.dev, biomejs.dev, oxc.rs,
  turborepo.com, nx.dev, github.com/trending.
