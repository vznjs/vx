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

## Shipped (item 705): the checkpoints

`<vx-checkpoint>` is `Checkpoint.astro` and `demos/checkpoint.ts`, in the
W0 island pattern. A page places one with `<Checkpoint id="…" />`. The
questions are `demos/model/checkpoint.ts`. Each is an edit of the toy
workspace ("you run `vx run build test` once, then you edit X and run
it again: which tasks rerun?") or a run ("you run `vx run T` on an
empty cache: which tasks run?"). The run form above also asked the
order on N workers; ticking boxes cannot answer an order, so it asks
for the set. An edit may add or replace files
before the first run (a variant) and changes one file or one env value
between the runs. The question's sentence is built from the change or
the task specs, and a hand-written intro gives context before it. So a
question cannot name one file while the answer is computed for another.
The only prose in a question is its intro, and a row holds every
question's full text.

**The answer is the planner's.** `answerCheckpoint` runs `runPlayground`
twice for the edit form. A task is in the answer when its key moved, and
its reason is what `diffRuns` and `describeChange` name for it (item 703),
for example "packages/utils/src/index.ts changed, upstream utils#build
moved". A task outside the answer reads "key unchanged". For the run
form, it plans `vx run build test` for the list of tasks and
`vx run T` for the answer, and names each planned task for the task that
waits for it, or "you asked for it". `Checkpoint.astro` computes the
answer as the page renders, with the planner the site ships
(`public/playground/planner.js`, written by `build.playground` before
`build` and now before `dev`), and prints it in the `<details>`. On
Check, the element imports the same file and computes the same answer.
Then `markAnswer` marks each task right (ticked and in the answer, or
left out and out of it), missed or wrong. The live region gets a
sentence ("5 of 9 right. Missed: ui#test, app#build, app#test. Wrong:
utils#build.") and a line per task in words ("Missed: ui#test reruns
(upstream ui#build moved)."), and colour is only a second channel.

**Under Node.** The build's prerender runs under Node on Linux CI
(item 700). The bundle is plain browser ESM with no import left. Node
22 imports it by its `file:` URL, and it plans with the same keys as
under Bun: a probe planned one project under both and got
`fbdcd63ba21636f0` both times. Configs are evaluated by
`evaluateConfigInProcess`, as `Playground.astro` does. From
`packages/vx-docs`, `ASTRO_TELEMETRY_DISABLED=1 node
node_modules/.bin/astro build` exits 0, and the checkpoint rows pass
against what it built.

**Found: the planner holds one workspace at a time.** Its VFS and env
are module state, set when a plan starts and read across its awaits.
Two plans at once read each other's files. A probe planned the toy
workspace and an edited copy concurrently: the first plan's keys were
the second's. A page renders sibling components concurrently, so
`answerCheckpoint` queues its computations. The row "answers every
checkpoint asked at once as it answers each alone" is red with the
queue removed (six answers mixed up) and green with it. The queue
covers checkpoints only. A checkpoint's Check and a `<vx-playground>`
Run on the same page share the bundle and are not serialized against
each other; nor are two playgrounds (the labs page, item 704). A reader
cannot realistically click both within one plan's few milliseconds, but
the fix belongs in the bundle (a queue in `entry.ts` around
`listPlaygroundProjects` and `planPlayground`). It is a follow-up,
because it touches the file 704 is changing.

**The questions, page by page.**

- **What is task orchestration.** It used to ask about
  `packages/ui/src/button.ts` with `--affected`, and which tasks can
  run at the same time. Rewritten to be checkable: it now asks about an
  edit to `packages/utils/src/index.ts` (eight tasks rerun, all but
  `docs#build`). The playground models no git diff, so `--affected`
  went, and "at the same time" is not a ticking question. The page's
  "which tasks run" became a second checkpoint in the run form:
  `vx run app#build` runs `utils#build`, `ui#build`, `api#build` and
  `app#build`. The run form is on this page because the page teaches
  the graph a task pulls in, and no other page's question uses it.
- **Caching.** It used to ask two runs: stop declaring
  `ui/tsconfig.json`, then edit it. The first run is a planner question
  and stays, reworded to the edit form. A variant declares the file
  (`files: ['src/**', 'tsconfig.json']`) and the edit removes it. Four
  tasks rerun, and `ui#build`'s reason is "config changed, file removed:
  packages/ui/tsconfig.json". The second run went to Correctness.
- **Correctness.** It used to ask about the stale-hit demo's own model
  (step 5, the sandbox off, then undeclared). That is not a planner
  question. Replaced by the undeclared input the toy workspace answers
  truthfully: `ui#build` runs `vite build`, which reads
  `packages/ui/tsconfig.json`, but its inputs declare only `src/**`.
  The variant adds the file, and the question edits it. No task reruns,
  and the note says what that means: every hit replays output built from
  the old file, and `exec.sandbox` fails the undeclared read instead.
  The file and the story are the caching page's own (its key
  calculator's stale scenario), so the two checkpoints are the two
  halves of the old caching question, checked against the real planner.
  The demo's toggles keep that scenario as model rows, renamed from
  "the checkpoint" in `learn-correctness.test.ts`.
- **Playground.** Both parts kept, as two checkpoints: the test-file
  edit (`utils#test` alone) and `API_URL` (the four above `api`). An
  env change is the edit form's second kind of change. "Which keys
  move?" became "which tasks rerun?", and the env question starts from
  Reset instead of from the first question's third run. The answer is
  the same.

The old page rows that parsed each hand-written answer went with the
answers (`demo-islands`' what-is and caching rows,
`learn-correctness`'s, and `learn-playground`'s). The toy key model's
declare-then-edit row stays, renamed.

**Rows** (`tests/learn-checkpoints.test.ts`, 32):

- The truth, written out by hand: every question's text, and every task
  of each answer with its reason. The other tasks' reason is fixed per
  form.
- The pages that place checkpoints, read from the MDX, equal a
  hand-written map, and that map, the truth and `CHECKPOINTS` have the
  same ids.
- The planner the site ships gives each checkpoint exactly its rows,
  and gives them again when all six are asked at once.
- Each built page places its checkpoints in order. The question's text
  and the no-JavaScript answer are held to the truth, not to the model:
  the summary, one line per task with its reason, the rest, and the
  note.
- The markup contract: the form is hidden with its id and planner URL;
  there is a labelled box per task in order; the legend is set; the
  live region is present and empty; each selector the element reads is
  there once; the element is reached from the page's scripts; and no
  chunk it reaches carries the planner.
- Pure rows with exact output: `markAnswer` (all four cases),
  `markLine` in both forms, `verdictSentence`, `answerText` (with
  answers, without, singular), `answerFromRuns` (unchanged, moved with
  two named changes, moved with none named, new), `answerFromPlan`
  (by id and by bare name) and `codeSpans`.
- A note names no task, so no answer can hide in one.

Differentials, each reversed by the reverse edit:

| Change                                                                        | Result                                                    |
| ----------------------------------------------------------------------------- | --------------------------------------------------------- |
| `markAnswer` swaps missed and wrong                                           | 3 red: the marking, the lines, the sentence               |
| `what-is-edit` edits `packages/api/src/server.ts` instead (rebuilt)           | 3 red: the question, the planner's answer, the built page |
| Correctness's intro names `packages/api/tsconfig.json` (rebuilt)              | 2 red: the question, the built page's question            |
| The build-time answer replaced by the correct answers as a constant (rebuilt) | green: the row holds values, and a correct value passes   |
| The same constant with `ui#test` out of caching's answer (rebuilt)            | 1 red: the caching page's no-JavaScript answer            |
| The queue in `answerCheckpoint` removed                                       | 1 red: the concurrent row                                 |

The architect's second differential cannot be built as stated: a
page's question and its no-JavaScript answer come from one spec, so the
question's file cannot change while the answer is left alone. The spec's
file change (row two) re-computes the answer, and the hand-written truth
catches both halves. Prose that names the wrong file (row three) is
caught by the question row. The constant pair shows the built-page row
holds the page to the hand-written set, whatever produced the page.

**Chromium probe** (Playwright's, headless, over `astro preview` of the
Node build). On all four pages, no `planner.js` was requested before
Check, and it was requested once per page after. With JavaScript on, the
boxes and Check were visible and the answer was hidden. A partial answer
on each checkpoint gave:

- `what-is-run`, ticking `app#build`, `ui#build` and `docs#build`: "6 of
  9 right. Missed: utils#build, api#build. Wrong: docs#build."
- `what-is-edit`, ticking `utils#build`, `ui#build` and `app#build`: "4
  of 9 right. Missed: utils#test, ui#test, api#build, api#test,
  app#test." `app#build`'s line read "Right: app#build reruns
  (upstream api#build moved, upstream ui#build moved)."
- Caching, ticking `ui#build` and `utils#build`: "5 of 9 right. Missed:
  ui#test, app#build, app#test. Wrong: utils#build." `ui#build`'s line
  read "(config changed, file removed: packages/ui/tsconfig.json)", and
  the note followed.
- Correctness, ticking `ui#build`: "8 of 9 right. Wrong: ui#build.",
  with every line "key unchanged".
- `playground-edit`, ticking `utils#test` and `utils#build`: "8 of 9
  right. Wrong: utils#build."
- `playground-env`, ticking `api#build`: "6 of 9 right. Missed:
  api#test, app#build, app#test." `api#build`'s line read "(env API_URL
  changed)".

Each mark was coloured by its `data-verdict`. The live region was
`aria-live="polite"`. There was no page error and no console error.
