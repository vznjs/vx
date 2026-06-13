# @vzn/vx-docs

The documentation site for [`@vzn/vx`](../../README.md), built with
[Astro Starlight](https://starlight.astro.build/) and deployed to GitHub
Pages.

## Source of truth

The repo's [`docs/`](../../docs) tree is the single source of truth.
`scripts/import-docs.ts` copies that Markdown into the Starlight content
collection (`src/content/docs/`), adding frontmatter and rewriting
internal `.md` links to clean URLs. That generated content is
git-ignored and regenerated before every dev/build — **edit the files in
`docs/`, not the generated copies.**

Hand-authored pages that live only in the site (not in `docs/`):

- `src/content/docs/index.mdx` — the landing page
- `src/content/docs/getting-started.md` — the getting-started guide

## Commands

```sh
bun install            # from the repo root (Bun workspace)

bun run dev            # import docs + start the dev server
bun run build          # import docs + build to dist/
bun run preview        # preview the production build
bun run import         # just regenerate the imported content
```

## Deploy

Pushed to `main`, the [`Deploy docs`](../../.github/workflows/docs.yml)
workflow builds the site and publishes `apps/docs/dist` to GitHub Pages.
Enable it once under **Settings → Pages → Source: "GitHub Actions"**.

The site is served from `https://vznjs.github.io/vx/`, so `base` is set
to `/vx` in `astro.config.mjs`. Override `BASE_PATH` / `SITE_URL` if you
move it (e.g. to a custom domain at `/`).

## Diagrams

Mermaid code fences are rendered client-side: `src/plugins/remark-mermaid.mjs`
turns them into `<pre class="mermaid">` nodes, and `src/components/Head.astro`
lazy-loads mermaid (only on pages that have a diagram) and re-renders on
theme toggle.
