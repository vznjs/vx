# @vzn/vx-docs

The documentation site for [`@vzn/vx`](../../README.md), built with
[Astro Starlight](https://starlight.astro.build/) and deployed to GitHub
Pages.

## Source of truth

The core package's [`packages/vx/docs/`](../../packages/vx/docs) tree is the single
source of truth for the reference pages. `scripts/import-docs.ts` copies
that Markdown into the Starlight content collection
(`src/content/docs/`), adding frontmatter and rewriting internal `.md`
links to clean URLs. The generated pages are git-ignored (see
`.gitignore` for the exact list) and regenerated before every build —
**edit the files in `packages/vx/docs/`, not the generated copies.**

Hand-authored pages live only in the site and ARE tracked:

- `src/pages/index.astro` — the landing page (its measurements come from
  `src/data/bench.json`, below)
- `src/pages/features/` — the feature hub and one page per feature (below)
- `src/content/docs/quickstart.md`, `compare.mdx`, `glossary.md`,
  `concepts/`, and `guides/` (the Docs: configure,
  sandboxing, ci, migrate, plugins)

## The landing page

`src/pages/index.astro` with `src/styles/landing.css` is a standalone
page (its own nav, footer and theme; the docs stay Starlight). It is the
whole story (design/site-short-2026-09.md): static, one script for the
install command's copy button, no paragraph longer than one sentence.
Sections, in order: the hero (one line, three of the chart's multiples, the install pill, Quickstart and
GitHub); `#one-run`, the one picture (`src/components/landing/one-run.ts`,
drawn by the diagram kit with its phone layout) and its six numbered
lines, each at the anchor an old Guide chapter redirects to (`#tasks`,
`#parallel`, `#cache`, `#changed`, `#sandbox`, `#plugins`); `#bench`, the
one benchmark; `#edge`, vx, Turborepo and Nx trait by trait (from the
choosing page's model); `#pillars`, four cards (correctness, sandbox,
extensibility, freedom), each an icon, a title, one sentence and its
Docs page; `#features`, eight feature cards; the footer. `tests/landing.test.ts` holds the order, the
hero's actions, the picture's data and lines against the design, the
pillars, the one-sentence rule and every internal link the page had.

The nav and footer are `src/components/landing/Nav.astro` and
`Footer.astro`, shared with the feature pages; the nav's places are
`SECTIONS` in `src/nav/sections.ts`, which the docs' header renders too.
The last section, `#features`, is a strip of eight feature cards and the
link to all of them.

- **The numbers** are measured, never typed: `bench.data` gathers the
  rows of `@vzn/vx-bench#site.numbers` into `src/data/bench.json`, and the
  chart, the kicker and every `%bench.…%` token on a page read it
  (`src/bench/format.ts`; `tests/bench-figures.test.ts` holds it).
- No cell says how much faster vx is (2026-10-12). The page draws the
  figures as bars (`renderBars` in `src/plugins/data-charts.ts`), each as
  long as its time against the slowest tool's.

To check it visually, drive the pre-installed Chromium from a scratch
directory (never from this package — `playwright-core` is not a
dependency of the site):

```sh
bun --bun astro build && bun --bun astro preview --port 4321 &
mkdir -p /tmp/pw && cd /tmp/pw && bun add playwright-core
# then: chromium.launch({ executablePath: '/opt/pw-browsers/chromium-<n>/chrome-linux/chrome' }),
# newPage({ viewport: { width: 390, height: 844 } }), goto('http://127.0.0.1:4321/vx/'),
# screenshot({ fullPage: true }); read document.documentElement.scrollWidth (must equal the
# viewport width at 1440 and at 390), document.querySelectorAll('canvas').length (0) and
# document.getAnimations().length (0).
```

## For AI agents

vx is AI first (2026-10-08): the site is markdown for agents
before it is HTML for people. `src/pages/[...slug].md.ts` serves every
docs and blog page raw beside its HTML (`quickstart.md`),
`src/pages/llms.txt.ts` indexes them by section, and
`src/pages/llms-full.txt.ts` is every Docs and Reference page in one
file (internals and the blog left out). `src/llms/pages.ts` decides
what is internal. The Docs page for agents is `docs/agents.mdx`.

## Features

`/features/` is a hub of every feature, grouped by category, and
`/features/<slug>/` is one page per feature: category, title, hook, the
image, two to four paragraphs, one example, and links to its Docs page
and a deep dive. Standalone pages in the landing's look
(`src/components/features/FeaturesPage.astro`, `src/styles/features.css`)
with a dark and a light theme, the one the docs store.

- The data is `src/features/features.ts`: `CATEGORIES` and `FEATURES`,
  in the order the hub lists them. Images are in
  `src/assets/features/` (1600×900 PNG, palette-quantized); the
  `build.images` task resizes them to WebP (`scripts/build-images.ts`),
  and `FeatureImage.astro` writes the srcset. A new layout width goes in
  that script's `SETS`.
- To add one: an entry in `FEATURES` under its category, its image in
  `src/assets/features/`, and its links under the base (`guides/ci/`)
  or `https://`. Verify every command, flag and config key against
  core's source first.
- `tests/features.test.ts` holds it: the copy rules (one-sentence hook,
  no `!`, no percentages, no "unchanged"), every `vx …` line against
  core's own verbs and flags, every config example
  type-checked against the packages it imports, and the built hub and
  pages against the data, images WebP only.
- Benchmark figures in it are `%bench.…%` tokens, filled from the data.

## Charts from tables

`src/plugins/data-charts.ts` is a remark plugin: a Markdown table whose
cells are durations (`476 ms`, `1.17s`, `3m 47s`) is drawn as bar charts
above it, the table kept under a "The table" toggle. Runners down the side
make one chart per column, runners across the top one per row; vx's bars
are the accent. A table inside a blockquote is sample output and is left
alone. Write the table; the chart follows.

## Writing a blog post

The blog (`/blog/`, RSS at `/blog/rss.xml`) holds stories and essays;
release notes have their own section (`/releases/`, RSS at
`/releases/rss.xml`). Both are the site's own: posts are tracked
Markdown files in `src/content/docs/blog/` and
`src/content/docs/releases/`, one per post, rendered
by Starlight (search, code frames, diagrams) without its sidebar or table
of contents; `src/components/blog/` draws the index (the newest post
large, filter chips, a grid of cover cards), the tag pages
(`src/pages/blog/tags/`), the Releases index (`src/pages/releases/`),
each post's hero and its related posts, and `src/blog/feed.ts` writes
both feeds. A post is:

```md
---
title: 'One binary, no daemon'
date: 2026-10-01
authors:
  - vzn # a key of AUTHORS in src/blog/posts.ts
tags:
  - dx
excerpt: 'One paragraph shown on the index and in the feed.'
# cover: { image: ../../../assets/blog/post.png, alt: '…' }   # optional
# draft: true                                              # optional: built only in dev
---

Body in Markdown. Internal links are relative to the post's own URL
(`/blog/<slug>/`), like every other page here: [the
quickstart](../../quickstart/).
```

`date` orders the index, newest first, and two posts on the same day
tie-break by title — so a series that should read in order carries a
time (`2026-09-10T23:59:00Z`, a YAML timestamp), later for the post
that should be read first; the page still shows only the day. The
launch series is timed that way: `what-vx-is` at 23:59, one minute
less per post. `excerpt` is required: the dek under the
headline, the card's line and the feed's description. Add an author once
to `AUTHORS` in `src/blog/posts.ts` and reference the key. A
post without a cover gets one drawn in CSS from its title and first tag;
the chips over the grid are `FILTERS` there. `bun packages/vx/src/bin.ts
run dev --filter @vzn/vx-docs` previews at `/vx/blog/`; a `draft: true`
post is visible there and skipped by the build.

### Release posts

Each release gets a post in `src/content/docs/releases/`, written before it
is cut (`.claude/skills/release/SKILL.md`); the first ten batch the
per-merge releases up to v0.0.625. A post is a release story, not a
changelog: an intro on what changed and why, one `##` per notable
feature (the problem it solves, what it does now, one example, a link
on), Other noteworthy changes, a short Breaking changes list (every
`old → new` rename and removal; the code keeps no aliases before 1.0)
and How to update. The title names what vx can now do overall, not
one feature, and is the cover's headline without its accent brackets
(`Any language, one lock, a cache PRs share`); the version is
metadata, shown as a `v0.0.637` chip beside the date, read from the
slug. Every post has a cover (`src/assets/blog/vx-0-0-<version>.png`,
1200×630). The slug is `vx-0-0-<version>`, the tag `release`, and the
date the release's day. The GitHub release's body is the post
(`release.sync`, in ci.yml's Linux run on main, keeps it current). Old `/blog/vx-0-0-*/` URLs
redirect (`astro.config.mjs`).

## Commands

Everything runs through vx from the repo root; this package has no
`package.json` scripts.

```sh
bun install                                   # from the repo root (Bun workspace)

bun packages/vx/src/bin.ts run import --filter @vzn/vx-docs   # packages/vx/docs → src/content/docs
bun packages/vx/src/bin.ts run build --filter @vzn/vx-docs    # astro build → dist/ (runs import first)
bun packages/vx/src/bin.ts run dev --filter @vzn/vx-docs      # astro dev server
bun packages/vx/src/bin.ts run preview --filter @vzn/vx-docs  # serve the built dist/
bun packages/vx/src/bin.ts run test --filter @vzn/vx-docs     # the pins below
bun packages/vx/src/bin.ts run lint --filter @vzn/vx-docs     # oxlint (type-checked) + oxfmt
```

The build depends on `bench.data`, which depends on the benchmark tasks
(`@vzn/vx-bench#bench.*`). Off CI they restore from main's remote cache.

Measured here they take about 20 minutes, one runner at a time:
`bun packages/vx/src/bin.ts run site.numbers --all --concurrency 1`.

## Tests

- `tests/plugins-guide-snippets.test.ts` — every `ts` block in the
  plugins guide type-checks against `@vzn/vx`, so a seam that moves
  turns the guide red before an author copies a stale block.
- `tests/sidebar-coverage.test.ts` — every page is reachable from the
  sidebar; an orphan page fails.
- `tests/features.test.ts` — the feature data and pages (above).
- `tests/landing.test.ts`, `tests/diagram-kit.test.ts` — the landing
  and its one picture (above); the kit's laws hold every picture kept as
  data to fit its boxes and to carry a phone layout that says the same.
- `tests/sidebar.test.ts`, `tests/redirects.test.ts` — the three places
  and two sidebars as built, and every URL the old sidebar or the Guide
  had landing on a page, at an id it has, in one redirect at most.
- `tests/compare.test.ts` — "vx, Turborepo, Nx, Bazel": the choosing
  model's cells and sources, the filter against hand-written truth, and
  the built page against both.
- `tests/site-links.test.ts` — every `href` and `src` in every built
  page that points inside the site lands on a built file, and on an id
  when it names a `#fragment`; the sitemaps and the blog feed name only
  built pages; the pages scanned are exactly the sitemap's and the 404
  page. External links are not fetched. What it excuses, and why, is at
  the top of the file.

## Interactive demos

A widget is an island in the plain-web sense: static HTML that a small
custom element enhances in place. No UI framework. "vx, Turborepo, Nx,
Bazel" (`compare.mdx`) hosts them.

- `src/components/Demo.astro` is the frame every widget uses:
  `<Demo name="x">…</Demo>` renders `<vx-x>` around its default slot,
  with an optional `caption` slot as the figure caption, and loads
  `src/components/demos/x.ts` only on pages that hold one. An unknown
  name fails the build.
- `src/components/demos/x.ts` is the element: plain TypeScript that
  ends in `customElements.define('vx-x', …)`. It enhances the markup it
  finds (roles, focus, listeners, classes) and does not re-render it.
- `src/components/demos/X.astro` is the widget a page imports. It
  renders the static state at build time and passes it to `Demo`.
  Data both halves read lives in `src/components/demos/model/`, so the
  static render and the enhanced one cannot disagree.
- A page that uses a widget is `.mdx` (Starlight renders components in
  MDX); `compare.mdx` is the example. Mermaid fences work in MDX too,
  and the site-wide laws read `.mdx` pages (item 680).

**The no-JavaScript rule.** The default slot must teach on its own: a
real diagram, table or state with a caption that says what the widget
would show, never a spinner or an empty box. Controls that only work
with JavaScript (buttons, live regions, hints) are added or unhidden by
the element. Colours come from Starlight's variables
(`--sl-color-*`, and `--vx-*` from `src/styles/theme.css`) so both
themes work. The test of the page that hosts a widget holds the rule
for it against the built HTML; a new widget adds its rows there.

## Deploy

Pushed to `main`, the Linux run of [`ci.yml`](../../.github/workflows/ci.yml)
builds the site with the rest and publishes `private/vx-docs/dist` to GitHub
Pages. Enable it once under **Settings → Pages → Source: "GitHub Actions"**.

The site is served from `https://vznjs.github.io/vx/`, so `base` is set
to `/vx` in `astro.config.mjs`. Override `BASE_PATH` / `SITE_URL` if you
move it (e.g. to a custom domain at `/`).

## Diagrams

Mermaid code fences are rendered client-side: `src/plugins/mermaid.ts`
turns them into `<pre class="mermaid">` nodes, and `src/components/Head.astro`
lazy-loads mermaid (only on pages that have a diagram) and re-renders on
theme toggle.
