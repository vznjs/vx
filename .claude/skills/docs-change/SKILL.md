---
name: docs-change
description: Write or change user docs, guides, the quickstart or other site text (private/vx-docs, packages/vx/docs). Applies M's docs rules, the terms list, page shapes and the pre-merge checklist and checker.
metadata:
  internal: true
---

# Docs change

The one docs guide is `/mnt/project-files/org/docs-site/docs-research.md`
(project files). Read it before the first edit; it wins over this
summary. Rules change there first, then pages follow.

## Where docs live

- `packages/vx/docs/` is the source of truth (architecture, caching, cli,
  schema, modules, design). `private/vx-docs/scripts/import-docs.ts`
  imports it into the site.
- Site pages: `private/vx-docs/src/content/docs/` (`docs/` one feature per
  page, how-to pages beside them as `docs/<area>/<task>.md`, `quickstart.mdx`).
- A user-facing feature (verb, flag, config key, env var, plugin) also
  updates `packages/vx/docs/features.md`. Any behaviour change updates
  every text it makes stale (docs, blog, site) in the same PR.

## M's rules (never bend)

- **M's terms only.** "Distributed task execution", never "distributed
  runs". No internal words in user docs: seam, floor, chain, claim, admit,
  admission, taint, placement, fold, staged, memo, fingerprint (outside the
  plugin reference). The term table is in the guide, section 3; a new term
  needs M's yes.
- **The finished, perfect experience.** No "not on npm yet", "coming
  soon", "until", "currently", "now", "new", "since v…", no checkout,
  `bun link` or local-path steps. What is needed to make a page true goes
  to M as a to-do in the PR body.
- **No paragraph over 5 lines on mobile**: at most 200 characters of
  prose. Every sentence earns its place.
- **Colour and formatting**: asides by meaning (`tip`, `note`, `caution`,
  `danger`), `<Badge>`, `ins`/`del`/`mark` on config lines, code font for
  every command, flag, key, file and task, tables for options, `<Steps>`
  for sequences.
- **Never plain white output**: every output block is ` ```ansi ` pasted
  from a real run with vx's escape codes; every fence has a language; no
  `text`, `txt`, `plain` or bare fences.
- Never `npx` (`bunx @vzn/vx init`, then `vx`); tasks call the real tool,
  never `npm run`, `pnpm run`, `nx`, `turbo`. No speed multiples or
  percentages in prose. No attacks on other tools.
- Plugins section holds everything not in core.

## Page shapes

- Docs page: title = feature name; first sentence says what the reader
  gets; a code block within the first five lines, then its real output;
  one `##` per sub-feature; options as a complete table; ends with one
  next link. 100-250 lines.
- Guide: title = the user's task, verb first; one sentence, code, output,
  up to three variants, last line `See [Page](link).` 10-60 lines.
- Plain words, second person, present tense, active voice; no "we",
  "let's", "simply", "just", "easily", "powerful", "seamless".
- Each fact on one page; others link to it with descriptive link text.

## Check before the PR

From `private/vx-docs`:

```sh
bun /mnt/project-files/org/docs-site/check-docs.ts <changed pages or dirs>
```

From `packages/vx`, the law tests:

```sh
bun test tests/doc-references*.test.ts tests/site-upgrading.unsafe.test.ts tests/module-page-claims.test.ts tests/contract-*.test.ts
```

plus `bun test tests/features-inventory.unsafe.test.ts` when features
change, and `bunx oxfmt --check` on the files.

Paste the guide's section 7 checklist into the PR body, tick every line,
and list the to-dos for M. A PR with an unticked line does not merge.
Marketing signs off changed site text.
