# Labs and checkpoints (2026-09-24, roadmap W10 and W11)

W9 shipped the playground: vx's real planner, bundled from core's source
and held to the CLI by core's parity rows. W10 and W11 are what the site
plan (`design/site-teaches-2026-09.md`) builds on it. W10 is the labs, where
the reader breaks a build on purpose. W11 is the checkpoints, one question
per Learn page, checked against the live model. This note decides both.

## First: why a key moved (item 703, core and bundle)

A lab that says "the key moved" without naming what moved it teaches
half the lesson. `vx why` already names it. The key fold's `captureInto`
records each component a key folds as `{ kind, name, hash }`, one per
file, env value, upstream key and config part. `cacheKeyDiff` in
`orchestrator/metrics.ts` joins two runs' components into `changed`,
`added` and `removed`.

- **Core.** Lift the join out of `cacheKeyDiff` into a pure exported
  function, for example
  `diffKeyComponents(before, after): { entries, unchangedCount }`.
  `cacheKeyDiff` keeps its SQL and calls it. This is behaviour-neutral:
  `vx why`'s existing rows must stay green unchanged.
- **Bundle.** The playground's cache layer passes a `captureInto` array to
  `foldKey` for every key it computes. `PlaygroundTask` gains
  `components: { kind, name, hash }[]`. The page keeps each task's
  components from the previous Run and diffs them with the SAME core
  function. This gives one rule for "what changed", used by the CLI and
  by the page.
- **View.** The results table's "Key moved" cell names the change:
  `packages/ui/src/button.tsx changed`, `upstream ui#build moved`,
  `env API_URL changed`, `config changed`, `file added: …`. Name at most
  two, then "and N more".
- **Parity row.** For the playground workspace's `button.tsx` edit, the
  page's named changes for `ui#build` equal `vx why ui#build --json`'s
  `diff.entries` (kind, name, change) after the same edit with a real
  run. This ties the bundle's capture to the CLI's.

## W10: the labs (item 704)

Each lab is a section of a new page, `learn/labs.mdx`, that follows the
playground page in the sidebar. Every lab embeds its own
`<vx-playground>`, started from a named state: the toy workspace plus
one change, defined in `src/playground/labs.ts`. Each has three to five
numbered steps the reader does in that playground, and ends with two
paragraphs:

- **What stopped it:** the vx mechanism, and a link to the page that
  teaches it.
- **Would Turborepo, Nx or Bazel?** One sentence each, with a link to
  that tool's own docs. This is the W7 rule: no competitor claim without
  a citation.

The playground element gains one attribute, `data-lab="<id>"`, which
selects the starting state. With no attribute it keeps today's
behaviour.

The labs:

1. **A file no config mentions.** Add `packages/ui/notes.md` and run:
   nothing moves. Add `notes.md` to `ui#build`'s inputs and run:
   `ui#build` moves, named "file added", and so does everything
   downstream. This teaches explicit inputs. Turborepo hashes every git
   file in the package by default. Nx's default `inputs` are every file
   in the project. Bazel has no undeclared file at all, because the
   action cannot see it.
2. **An input the task reads but does not declare.** The lab's
   `api#build` command reads `config.json`, and its inputs do not list
   it. Edit `config.json` and run: no key moves, so a real run would
   replay the stored output, which is now stale. The playground plans and
   does not execute, so the lab says that in one sentence, then shows what
   catches it: `exec.sandbox` refuses the read. It links to W3's
   stale-hit demo, which simulates the violation. Then the reader
   declares the file, and the key moves on the next edit.
3. **Two tasks, one output.** Give `ui` a second task, `ui#bundle`, that
   also writes `dist/**`, with no edge to `ui#build`. Run it. Core's task
   graph refuses the pair (`detectOutputCollisions`), and the page shows
   core's own message. vx cleans a task's outputs before it runs and
   before a restore, so two owners of one path destroy each other's work
   in whichever order they run. Then the reader adds `dependsOn: ['build']`
   to `ui#bundle` and runs again. The pair is allowed as the addition
   shape: the order is now fixed, and the dependant's own set can be told
   apart. Turborepo restores additively, so it cannot hit this hazard,
   and it cannot tell which task wrote a path either. The lab says both.
4. **A bad order.** This lab lives on the scheduling page, as a guided
   exercise in its simulator: start with learned durations off and
   `docs#build` at 20 s, and watch the critical path grow. It adds no
   new widget, only numbered steps and the same two closing paragraphs.

The lab states are held to the CLI by the parity suite, the same way the
playground workspace is: labs 1 to 3, both before and after the reader's
fix, each plan what `vx run --dry=json` plans. For lab 3, the refusal
message equals the CLI's stderr.

## W11: the checkpoints (item 705)

Every Learn page already ends with a `## Checkpoint` in the
scheduling page's `<details>` form. W11 makes the questions that have
a planner answer checkable against the live model, and leaves the rest
as they are.

- `<vx-checkpoint>` shows a question about the toy workspace. The two
  forms are "you edit X, which tasks rerun?" and "which tasks does
  `vx run T` run, in what order on N workers?". The reader answers by
  ticking tasks. **Check** runs the planner, using `runPlayground`
  twice for the edit form, and shows which answers were right, which were
  missed and which were wrong, each with the reason from item 703's diff.
  Without JavaScript it shows the answer in `<details>`, as today.
- It goes on the pages where the model answers the question: what is
  task orchestration (edit → affected), caching (edit → key moves),
  correctness (an undeclared input → nothing moves), and playground. On
  scheduling, choosing, architecture and extending, the existing
  `<details>` stays, because their questions are not planner questions.
  The site plan said "one per Learn page", and those four already have one.
- Each checkpoint's expected answer is not hand-written. It is computed at
  build time by the same planner, from the same texts, so a checkpoint
  cannot disagree with the model. A site row checks every checkpoint's
  answer against a hand-written expected set. That keeps the model honest
  and keeps the rows from being a tautology.

## Order

703 first (core and bundle), then 704 and 705 in parallel. Both read
`components` from 703, 704 touches the playground element, and 705 adds
its own element.
