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
- **K-10** Issue and PR templates (coordinator backlog 2-2): a bug form
  that asks for `vx info` (the doctor `cli.md` names "for bug reports")
  and a repro, a feature form that asks whether it could be a plugin,
  contact links to the docs and private vulnerability reporting
  (SECURITY.md), and a PR template with the gate. CONTRIBUTING named
  imperative commits where the repo uses Conventional Commits.
- **K-12** moon on the front pages (coordinator backlog 3-3): stream N
  shipped `moon()` and `vx-migrate --from moon`, and the README's
  adoption section, plugin table and the landing's freedom card still
  named only Turborepo and Nx. Backlog 3-1 (a vx GitHub Action that
  caches `.vx`) declined: "CI-provider features" is on CLAUDE.md's
  rejected list, and this repo's own CI keeps no `.vx`, so a recipe
  could not be walked here. Backlog 3-2 (recipe pages) held: the owner's
  short-site design caps the Docs at six pages.
- **K-13** moon in the README's comparison table (coordinator backlog
  3-4): each cell from moon's own docs at master (ddd8c035), linked in
  a footnote; the cached-run row reads "not measured", no number
  invented. Where the docs say nothing (a per-task sandbox, OTel), the
  cell reads "No" and the footnote says the docs describe none.
- **K-14** "Tried on real repos" (coordinator backlog 4): the README
  quoted one real repo (solid); benchmarks.md holds eleven, six against
  Turbo and five against Nx. The README now lists all eleven, vx /
  theirs for cold, restore and no-op, bold where the other tool wins
  (payload's no-op, n8n's cold). `readme-real-repos.unsafe.test.ts`
  holds each pair to one benchmarks.md row, red with one digit changed.
  The rest of the backlog had shipped: demo SVG (K-6), chart (K-1),
  CONTRIBUTING (K-7), social card and meta (K-3), and the site's code
  blocks already carry copy buttons.
- **K-15** The landing's `<title>` and `og:title`, the headline of a
  search result and of a shared link's card, read "vx — Bend time. Not
  the rules.", the slogan of the cinematic landing site-short replaced;
  they now say what vx is, as the hero does. Coordinator backlog 5's
  other asks exist: the terminal demo SVG from a real run (K-6, in the
  quick start so install stays on the first screen), CONTRIBUTING with
  the gate and Conventional Commits (K-7, K-10; the stream protocol is
  the maintainers' plan, not a contributor's), the social card and
  meta on every page (K-3, held for the landing and a docs page), the
  chart from results.json (K-1, held by `check.site`). The first
  screens of vite.dev, biomejs.dev and uv share headline, install copy,
  two CTAs and a visual, which the landing has; their subhead and logo
  strip are not added: the site-short design fixes the hero at one line
  and vx has adopters to name only as benched repos (K-14).
- **K-16** README's real-repo table gains kindspells/astro-shield against
  moon (N-6's `moon()` run), so it names all three adopted tools.
- **K-17** And FormidableLabs/spectacle against wireit and microsoft/lage
  against lage (N's `wireit()` and `lage()` runs; lage wins cold, bold).
- **K-18** The ten-pattern checklist (backlog 6) against vx, rolldown
  added to the study. Each pattern already shipped but the animated demo
  (K-19). vuejs/pinia stays out of the real-repo table: neither side
  caches, so it has no restore or no-op cell.
- **K-19** `demo.svg` prints line by line (0.12 s a line, 0.6 s after a
  command). A line is hidden only during its own delay (`backwards` fill),
  so no animation or reduced motion still shows the whole run; the landing
  test holds that.
- **K-20** README top rewritten for a Turbo or Nx user (owner, 2026-09-28:
  "hard to parse … remove moon"): the hero says what vx is for them, a
  vx / Turborepo / Nx table `update-site.ts` generates (time added, CPU,
  fully cached, per package; a unit in every cell) replaces the chart and
  the paragraph of numbers, then "Try it on your repo" (`turbo()` /
  `nx()`, one file and three commands; the plugin is not on npm yet, said
  so), three reasons it is faster, the rest below. moon, wireit and lage
  cut from the README (N removes the adapters); the chart SVGs and their
  generator went with the chart.
- **K-21** The landing, the same way: hero "A faster runner for your
  Turborepo or Nx repo." with its sub, the bars become the README's table
  (`update-site.ts` writes one `benchTable` for both, so they cannot
  disagree), three reasons under it, a "Try it on your repo" section, then
  the picture and pillars; the Freedom card drops moon. Title and
  description follow. Checked on a phone: cells stay on one line.

## Leads for other streams

- **I**: `update-site.ts` gained the chart (K-1); it is stream I's file.
