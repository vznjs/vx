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

## Leads for other streams

- **I**: `update-site.ts` gained the chart (K-1); it is stream I's file.
