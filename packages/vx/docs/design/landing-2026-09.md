# The landing page (2026-09-24, roadmap W8, item 709)

The site plan (`design/site-teaches-2026-09.md`) orders W8 last,
because it summarizes the rest. The landing page, `src/pages/index.astro`,
opens today with "The fastest task runner. Measured on real repos." and
three benchmark sections, and only then explains anything. The plan asks
for the reverse: lead with the problem and the three ideas, and show
the numbers after. The Learn section (W1–W7), the playground (W9), the
labs (W10) and the checkpoints (W11) now exist to link to.

## Decisions

- **The hero states the problem, not the result.** A monorepo runs
  hundreds of commands. The questions are which must run, in what
  order, and which can be skipped because their result is already
  known. One sentence says what vx is: a task runner that answers those
  questions from what each task declares, and caches the answer by
  content. The first action is **"Learn how it works"**, which goes to
  `learn/what-is-task-orchestration/`. The second is **"Plan a monorepo
  in your browser"**, which goes to `learn/playground/`. The quickstart
  link stays, third.
- **Three ideas, one section each, in this order:**
  1. **Explicit inputs.** A cache key is only as honest as what it
     folds. vx folds what the task declares, and the sandbox proves the
     declaration. Links go to `learn/caching/`, `learn/correctness/` and
     the labs. The one guarantee the section states links to the test
     that holds it (plan rule: "every guarantee links to its test").
  2. **A pipeline with seams.** Core schedules and keys. Where a task
     runs, where artifacts live and who observes are plugins. The local
     floor means a workspace with no plugins still runs and caches.
     Links go to `learn/architecture/` and `learn/extending/`.
  3. **Bun-native speed.** One short paragraph on why: one process,
     `bun:sqlite`, git blob OIDs for tracked files. It links to
     `benchmarks.md` and leads into the numbers below.

  Each idea has one small inline SVG drawn in the Learn pages' style,
  with no JavaScript. The page stays static.

- **The numbers come after the ideas, unchanged in substance.**
  - The benchmark sections (`bench`, `real`, `scale`) move below the
    ideas.
  - `const benchRows = [...]` and the three stat tiles keep the exact
    shape `packages/vx-bench/update-site.ts` rewrites. The generator is
    not changed, and `@vzn/vx-bench#check.site` stays green, which proves
    it.
  - The headline "First in every row." stays next to its table. It is a
    measured claim with its source.
- **The rest of today's sections stay.** "What sets it apart", "Open.
  All of it.", the pipeline, "Config is TypeScript" and "Bring the repo
  you have" keep their places after the numbers. Where one of them
  repeats an idea section, the idea section wins and the duplicate goes.
  The commit message names each section removed.
- **Honesty rules carry over.** Every number comes from
  `benchmarks.md` through the generator. Every comparison names a case
  where another tool is the better pick: the landing links to
  `learn/choosing/`, which carries those rows.

## Rows

- **Built-page order.** The `h1` comes first, then the three idea
  sections, then `#bench`. The row asserts the `id` order, and each idea
  links to its Learn page.
- **Guarantee links.** The guarantee in idea 1 links to a test file that
  exists (under `packages/vx/tests/`).
- **Numbers unchanged.** `check.site` passes: the generator's anchors
  are still found and its output equals the committed page.
- **Nothing lost.** Every internal link on the old page resolves on the
  new one, or is named in the commit as removed.

## Not in this step

- A new visual identity. The page keeps its current styles and adds
  the three idea sections in them.
- Any JavaScript on the landing page.

## Shipped (item 709)

The page, top to bottom: the hero, the three ideas (`#inputs`,
`#seams`, `#speed`), the numbers (`#bench`, `#real`, `#scale`), then
today's later sections in their places (`#why`, `#open`, `#plugins`,
`#config`, `#migrate`).

- **Hero.** The `h1` is "Hundreds of commands. Which must run?". The
  lede asks the three questions and says what vx is in one sentence.
  The actions are "Learn how it works"
  (`learn/what-is-task-orchestration/`), "Plan a monorepo in your
  browser" (`learn/playground/`) and "Quickstart", in that order. The
  install pill sits on its own row below them.
- **Idea 1** links `learn/caching/`, `learn/correctness/` and
  `learn/labs/`. Its one guarantee cites core's
  `tests/sandbox-runtime.unsafe.test.ts`, row "the undeclared read fails
  with one line naming banner.txt; declaring it passes". That row runs
  Learn's stale-hit demo for real in the sandbox. It asserts that the
  task fails with exactly one violation line, naming `banner.txt`, and
  that declaring the file lets the same task pass with the file's bytes
  in its output. It is Linux-only (`describe.skipIf`); CI's Linux jobs
  run it with `VX_REQUIRE_SANDBOX=1`. The site's `test` task already
  granted and keyed that file, because the choosing page cites it too.
- **Idea 2** links `learn/architecture/` and `learn/extending/`.
  **Idea 3** links `concepts/why-vx-is-fast/` (its mechanisms; a page
  this design did not name), `benchmarks/`, and `#bench` below. Idea 3
  states no number.
- **The numbers.** `benchRows` and the three stat tiles are untouched,
  and `update-site.ts` is unchanged; `@vzn/vx-bench#check.site` exits 0.
  The benchmark panel gained a link to `learn/choosing/` ("When another
  tool is the better pick").
- **Removed as repeats of an idea section.** No whole section merely
  repeated one, so no section went. Cards did. From `#why`: "Sandboxed,
  per task" (idea 1), "A plugin at every stage" and "Modular to the
  core" (idea 2). From `#plugins`: "Nothing applied by default" (idea
  2's floor). `#plugins`' heading was idea 2's own ("A pipeline with a
  seam at every stage."), so it is now "What fills the seams." Every
  page those cards linked is still linked from the page.
- **Found.** Two links in the benchmark panels were written as quoted
  `href="{href(…)}"` in the source. They shipped as that literal text
  and never resolved. Both now render as links.
- **JavaScript.** The idea sections carry none. The page keeps the one
  script it had, the install pill's copy button, and astro's site-wide
  prefetch module. "No JavaScript" was read as "this step adds none".

Rows (`packages/vx-docs/tests/landing.test.ts`, reading `dist/`):

- the `h1`, then the exact order of the section ids;
- the hero's three actions, in order;
- each idea's links, each resolving to a built page;
- idea 1's one GitHub link points under `packages/vx/tests/`, the file
  exists, and it holds the linked text as a quoted row title;
- each idea has one `role="img"` SVG with an `aria-label`, and no
  script or `on*=` handler;
- every internal `href` the page had at f565ec5f is still on it, or on
  a removed-on-purpose list (empty), and every internal `href` resolves
  to a built file and anchor.

Differentials. Each was rebuilt through `@vzn/vx-docs#build` and
restored by copying the saved page back (`cmp` equal):

| Mutation                         | Row that went red                              | Tally          |
| -------------------------------- | ---------------------------------------------- | -------------- |
| `#bench` moved above idea 1      | the h1, then the three ideas, then the numbers | 5 pass, 1 fail |
| guarantee path without `.unsafe` | idea 1's guarantee to the core test row        | 5 pass, 1 fail |
| the nav's `blog/` link dropped   | every internal link the page had               | 5 pass, 1 fail |

Chromium at 1440 px and at 390 px: `document.documentElement.scrollWidth`
equals the viewport width at both, and no element's box ends past the
viewport outside a scroll container. The second check is the one that
decides. `landing.css` sets `overflow-x: clip` on `html` and `body`, so
`scrollWidth` stays at the viewport width whatever overflows: with the
idea 2 SVG forced to 900 px at 390, `scrollWidth` still read 390, while
the element check named the `svg`.
