# The teaching kit and the juniors handbook

Every Docs page is written for a junior developer meeting vx for the first
time, and still complete for an expert who digs. This file is the how; the
rules every docs change also passes are the docs guide
(`/mnt/project-files/org/docs-site/docs-research.md`, section 7 checklist and
`check-docs.ts`). Exemplar: `src/content/docs/docs/caching.mdx`.

## M's rules for the redo (2026-11-23, verbatim intent)

1. **Show, don't tell.** "As much show as possible, as less tell as possible."
   A picture, a run's real output, a walkthrough or a side-by-side replaces a
   paragraph whenever it can.
2. **A story to explore, fun like a game, but no gamification.** No points,
   badges, streaks, progress bars, scores or "level up". The fun is
   discovery: each section reveals one thing and the reader sees it work.
3. **A payoff after every section.** Every `##` section ends with a
   `<Takeaway>`: what the reader can now do or see. If you cannot write one,
   the section has no point: cut or merge it.
4. **Levels.** The page's basics are always shown; patterns and details
   open on demand (`<Levels>`, `<Deeper>`). Simple first, complete underneath.
5. **Teach as you go, fewest words, complete.** Define each new word the
   first time (`<Concept>`). Every option is still on the page, at its level.
6. **Every config field is documented and explained** (what it does, its
   default, a short example), on the page of its area and in the config
   reference.

## Page shape

~~~mdx
---
title: Caching                 # M's term (docs guide section 3)
description: One plain sentence: what the reader gets.
---

import { Levels, Deeper, Concept, Quiz, Walkthrough, Frame, Compare, Chart, Takeaway, NextStep } from '../../../components/learn'

One sentence: what this gives you.

```sh
vx run build                   # a command in the first five lines
```

<Levels />                      {/* the depth switch, right under the opening */}

<Walkthrough> or <Diagram> or real ```ansi output   {/* show it working */}

<Concept term="…">…</Concept>   {/* the one new word, where it first matters */}

## Do the thing                 {/* Basics: 2-4 sections, each one idea */}
…example, real output, one line on what to look at…
<Takeaway>…</Takeaway>

<Deeper level="patterns" title="Common setups">   {/* Level 2 */}
### One real setup per heading, each a short example
<Takeaway>…</Takeaway>
</Deeper>

<Deeper level="details" title="Every option">     {/* Level 3: complete */}
Option tables, edge rules, how it works inside, every message vx prints.
</Deeper>

<NextStep href="…" title="…">Why go there next.</NextStep>
~~~

### The three levels

| Level | Shown | Holds | Reader |
| --- | --- | --- | --- |
| **Basics** | always | what it is, the smallest working example, real output, one picture | "I want it working" |
| **Patterns** | `<Deeper level="patterns">` | common real setups, each a short example | "I have this case" |
| **Details** | `<Deeper level="details">` | every option, default, edge rule, error, how it works inside | "I need to know exactly" |

A heading inside a `<Deeper>` still lands: a link to it opens the block.
Keep its id stable or fix every link to it (`tests/site-links.test.ts`
fails on a dead anchor).

## The story

The pages follow one workspace, the demo every sample already uses:
`@demo/web` (a Vite app) depends on `@demo/ui` (a component library);
later chapters add `@demo/admin` (a second app on `ui`) and `@demo/api`
(stands alone). One spelling everywhere: `packages/<name>/`,
`src/index.ts`, `vite.config.ts`; each project has `build`, `test`
(`dependsOn: ['^build']`) and `lint`, so a `ui` edit reaches web's and
admin's `build` and `test`.
Samples run `vite build`, `vitest run`, `oxlint` — never `tsc`, and never
a package-manager script or another task runner. Each page picks up where the learning
path left the reader (start, define tasks, run, cache, CI, Distributed task
execution, plugins) and ends with `<NextStep>` to the next chapter.

## Components (`src/components/learn/`)

| Component | Use it for | Rule |
| --- | --- | --- |
| `<Levels />` | the depth switch | once per page, right after the opening code block |
| `<Deeper level title>` | a Patterns or Details block | closed by default; Markdown inside |
| `<Concept term>` | a new word, defined in 1-2 sentences | first use only; at most 3 per page; terms from the docs guide's list |
| `<Walkthrough title>` + `<Frame title>` | a sequence the reader steps through (first run → second run → edit) | 2-5 frames; each frame shows real output or a picture |
| `<Compare leftTitle rightTitle>` + `<div slot="left">` / `<div slot="right">` | two things side by side (miss vs hit, before vs after) | short content: config, a few lines |
| `<Chart groups caption>` | numbers as bars (`BarGroup[]`, `plugins/data-charts.ts`) | measured numbers only, never invented |
| `<Diagram {...picture} />` | a picture of how something works | pictures in `src/components/docs/pictures/<area>.ts`, with a `narrow` phone layout; kit: `../guide/diagram/README.md` |
| `<Quiz q>` | "Check yourself": one question, answer behind a click | at most 2 per page; tests understanding, not trivia |
| `<Takeaway>` | the payoff closing a section | every `##` section; "You can now …" is printed for you, write the rest |
| `<NextStep href title>` | the page's last element | one per page, next chapter of the story |
| Starlight `<Aside>` | `tip` shortcut, `note` fact, `caution` trap, `danger` data loss | one fact per aside |
| Starlight `<Steps>`, `<Tabs>` | a sequence to follow; alternatives (bun / pnpm) | |
| `GraphExplorer` (`../demos/`) | the interactive task graph | the graph pages |
| `<CacheSim task?>` (`../play/`) | change a file, config or env, run, see hit / miss / up to date and why | caching pages; `import { CacheSim } from '../../../components/play'` |
| `<TaskGraph task? mode?>` (`../play/`) | the story's tasks as a picture: click one to see what runs first, in waves; edit a file to see what reruns | `mode="order"` (default) or `"rerun"`; `import { TaskGraph } from '../../../components/play'` |
| `<GlobTester mode? project? patterns?>` (`../play/`) | type `inputs.files` / `outputs.files` globs over the story tree: what matches, what is git-ignored, what is out of reach; outputs: literal required, wildcard optional | `mode="inputs"` (default) or `"outputs"`; `import { GlobTester } from '../../../components/play'` |
| `<RunTimeline concurrency? fail?>` (`../play/`) | one `vx run build test lint` as lanes: slots, what waits, a failure skipping only its dependents vs `--fail-fast` | `fail="@demo/ui#build"`; `import { RunTimeline } from '../../../components/play'` |
| `<ConfigExplorer area? field?>` (`../play/`) | every config field as a clickable file: what it does, type, default, example, link to the reference; words come from schema.md | `area="task"` (default), `"project"`, `"workspace"`; `field="exec.timeout"`; `import { ConfigExplorer } from '../../../components/play'` |

Real output stays ` ```ansi ` pasted from a real run (docs guide M4, M10).
A Walkthrough frame is the place to put two outputs the reader compares.

## Writing for juniors

- One idea per sentence, under about 15 words. Paragraphs at most 200
  characters (`check-docs.ts`).
- Say what the reader sees before why it works.
- Name concrete things: `@demo/web`, `dist/`, `src/**`.
- After a code block, one line on what to look at ("Read the last line:
  **up-to-date**").
- No filler words or marketing words (the docs guide lists them).
- Second person, present tense; never first person plural.

## Checks before a push (local only; no CI, no PR)

From `private/vx-docs`:

```sh
bun scripts/import-docs.ts && bun scripts/build-images.ts
mkdir -p .astro/bin && ln -sf "$(command -v bun)" .astro/bin/node && PATH="$PWD/.astro/bin:$PATH" bun --bun astro build
bun test tests/                      # site laws: links, pictures, a11y, ansi, sidebar
bun /mnt/project-files/org/docs-site/check-docs.ts <your pages>
../../node_modules/.bin/oxfmt <your files>
```

From `packages/vx` (pins that quote the site):

```sh
GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1 bun test tests/site-*.unsafe.test.ts tests/doc-references*.test.ts tests/schema-doc*.test.ts tests/config-levels-doc.test.ts
```

A pin that quotes text you moved into a `<Deeper>` still passes: the
text is on the page. A pin that quotes text you rewrote fails: update the pin
only if the new text says the same true thing.
