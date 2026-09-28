# Stream K — README and site (plan 2026-09-27): one entry per merged PR

## Entries

- **K-1** Root README rewritten from a study of 15 READMEs
  (`design/readme-site-2026-09.md`): logo, hero, badges, a dark/light
  benchmark chart `update-site.ts` renders from `results.json` into
  `packages/vx-docs/public/bench-{light,dark}.svg` (`check.site` reads
  both), one-line install, a quick start run end to end, Turbo/Nx
  adoption as parity, a plugin table. Wrong claims fixed on the way:
  "no Node needed" held for the release binary, not the npm install (its
  `vx` is a Node launcher); the plugin packages are not on npm yet, and
  the README said `bunx @vzn/vx-migrate` with no word of it.
- **K-2** An install line on every plugin page: five of seven plugin
  READMEs, each its package's npm page, showed a config importing the
  package and no command to install it.
- **K-3** A social card: no page named an `og:image`, so a shared link
  showed no preview. `public/og.png` (1200×630, from `og.svg`); the
  landing gains og and `twitter:card` tags, every docs page the image
  through Starlight's `head`. `landing.test.ts` holds both and the size.
- **K-4** `examples/basic`: a two-package starter (lib, app; build,
  test, a `ci` group) the README links. `tests/examples.unsafe.test.ts`
  copies it into a fresh repo and drives cold (3 miss), warm (cache
  hits) and an edit to lib (all three re-run); red with app's `^build`
  dropped.
- **K-5** npm discoverability (coordinator backlog 4): `@vzn/vx` shipped
  as "An open, extensible monorepo task runner." with its homepage on the
  GitHub README; no plugin had keywords. Core's `package.json` now holds
  the site's hero line, the docs site as homepage and keywords, which
  `build-npm.ts` publishes instead of its own hard-coded list; each
  plugin carries `vx`, `vx-plugin`, `monorepo` and its subject.
  `build-npm.unsafe.test.ts` holds it for every published package.
- **K-6** A terminal demo on the README and the landing hero
  (coordinator backlog 1): `vx-docs/scripts/terminal-demo.ts` runs
  `examples/basic` under the checkout's vx, cold then warm, and draws the
  real colored output as `public/demo.svg`. `examples.unsafe.test.ts`
  runs its `--check`, which fails when anything but a timing or the
  worker count differs from a fresh run (red with one word changed).
- **K-8** `examples/turbo` (coordinator backlog 3): a Turbo repo plus a
  `vx.workspace.ts` with `turbo()`. `examples.unsafe.test.ts` runs it
  unchanged (cold, then all cache hits), deletes the workspace file, runs
  the `vx-migrate` CLI (3 clean, 0 TODOs) and runs again: all three hit
  the cache `turbo()` filled, the README's migration claim end to end
  (red when the two derive different keys).
- Backlog 2 (vs Turbo / vs Nx pages) not built: `compare.mdx` names each
  choice per tool with sources, `parity.md` maps every Turbo and Nx
  feature to a test, and the owner's short-site design caps the Docs;
  two more pages would restate them.
- **K-7** CONTRIBUTING opens with three commands (coordinator backlog
  5). A newcomer on Linux met "sandbox not available" from the gate: the
  page never named bubblewrap, socat and ripgrep, nor the git-config
  refusal's escape (`GIT_CONFIG_GLOBAL=/dev/null`, item A-18), both hit
  in this stream's own first gate.
- **K-9** Search (coordinator backlog 2-1): of the 230 pages the sitemap
  lists, only the landing named no canonical URL and no sitemap link
  (Starlight writes both on the docs pages; the 40 pages without a
  description are redirect stubs, `noindex` and out of the sitemap).
  `landing.test.ts` now holds canonical, description and sitemap link
  for every page the sitemap lists.
- **K-11** A five-minute migration tutorial (coordinator backlog 2-4):
  the migrate guide walks `examples/turbo` from `turbo()` to written
  configs to no `turbo()` at all, each step's output the one
  `examples.unsafe.test.ts` asserts. The test now follows the guide as
  written: the workspace file stays through the CLI (K-8 had deleted it
  first, a path the guide does not take), and the configs then hit
  alone. The README links the playground (K-1's study: Biome, Oxc and
  Ruff link theirs). Backlog 2-3, a "Why vx" post, not written: the
  blog's `what-vx-is`, `why-vx-is-fast` and `honest-benchmarks` say it.

## Leads for other streams

- **I**: `update-site.ts` gained the chart (K-1); it is stream I's file.
