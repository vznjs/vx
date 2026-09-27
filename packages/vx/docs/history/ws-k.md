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

## Leads for other streams

- **I**: `update-site.ts` gained the chart (K-1); it is stream I's file.
