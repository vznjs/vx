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
