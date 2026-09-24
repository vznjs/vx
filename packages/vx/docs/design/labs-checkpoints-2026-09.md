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
`answerCheckpoint` first queued its own computations; item 704 then serialized the planner itself (`oneAtATime` in `entry.ts`), which covers a checkpoint's Check, a `<vx-playground>` Run and the labs page's three playgrounds alike, so the checkpoint's queue went (item 710). The row "answers every checkpoint asked at once as it answers each alone" now holds the planner's queue: red with `oneAtATime` running its argument at once, green with it.

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

| Change                                                                                                                                             | Result                                                    |
| -------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `markAnswer` swaps missed and wrong                                                                                                                | 3 red: the marking, the lines, the sentence               |
| `what-is-edit` edits `packages/api/src/server.ts` instead (rebuilt)                                                                                | 3 red: the question, the planner's answer, the built page |
| Correctness's intro names `packages/api/tsconfig.json` (rebuilt)                                                                                   | 2 red: the question, the built page's question            |
| The build-time answer replaced by the correct answers as a constant (rebuilt)                                                                      | green: the row holds values, and a correct value passes   |
| The same constant with `ui#test` out of caching's answer (rebuilt)                                                                                 | 1 red: the caching page's no-JavaScript answer            |
| The queue in `answerCheckpoint` removed (it went for good in item 710; `entry.ts`'s `oneAtATime` running its argument at once is the mutation now) | 1 red: the concurrent row                                 |

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

## Shipped (item 704): the labs

`learn/labs` follows the playground page in the sidebar, before the
glossary. Labs 1 to 3 each embed a `<vx-playground data-lab="<id>">`;
lab 4 is a section of `learn/scheduling`, and the labs page links to it.
The page ends with a Checkpoint in the `<details>` form.

- **Where things are.** `src/playground/labs.ts` holds `LABS`, the
  three start states (`unlisted-file`, `undeclared-read`,
  `shared-output`; each `{ files, env, tasks }`, the workspace plus one
  change), and `LAB_STEPS`, the edits each step asks for (replace a text
  once, or append), which the site's rows and core's parity rows apply
  with `applyEdits`. An edit whose text is not in its file throws, so a
  lab that drifts from the workspace fails its rows instead of planning
  something else. `startState(lab)` is the state an element opens on:
  the lab's, or the workspace's with no attribute; an unknown id throws.
- **The element.** `Playground.astro` takes `lab` and passes it through
  `Demo.astro`'s new `data` prop (`data-*` attributes on the element), and
  its static render is that state's: the file list, each config and the
  task table, from `configTextsOf(files)` (each package's config text
  under its `package.json` name) evaluated in-process at build time, as
  before. `<vx-playground>` reads `data-lab` in `connectedCallback`, and
  Reset restores that state, env and task specs included. With no
  attribute it opens and resets on the workspace, as the playground page
  does.
- **Lab 1, a file no config mentions:** `packages/ui/notes.md`, named by
  no config. Run; edit it (nothing moves, nine hits); declare it in
  `ui#build`'s inputs (`ui#build` moves, "config changed, file added:
  packages/ui/notes.md", and `ui#test`, `app#build`, `app#test` by
  upstream); edit it again ("packages/ui/notes.md changed"). The key
  folds the task's config, so declaring a file names two changes, not
  "file added" alone; the page says both.
- **Lab 2, an undeclared read:** `api#build` runs
  `mkdir -p dist && cp src/server.ts config.json dist/`, the shape of the
  correctness page's stale-hit demo, and declares `src/**` and `API_URL`.
  Run; edit `config.json` (nothing moves: a real run replays a stale
  `dist/`); add `sandbox: { allow: { read: ['src/**'], write: ['dist/'] } }`
  ("config changed": the next real run runs, in the sandbox, which denies
  the read); declare the file in the inputs and the grant ("config
  changed, file added: packages/api/config.json"); edit it again
  ("packages/api/config.json changed"). The page says in one sentence
  that the playground runs nothing, and links to the correctness page's
  demo and its section on the sandbox.
- **Lab 3, two tasks and one output:** `ui#bundle` writes `dist/**` with
  no edge, and the task field asks for `build test bundle`. The first Run
  is refused with core's `detectOutputCollisions` message, shown in a
  code block, since Starlight's typography turns a quoted `"dist/**"`
  into curly quotes. `dependsOn: ['build']` makes the pair the addition
  shape: ten tasks, all miss, then all hit, and a `button.tsx` edit
  moves `ui#bundle` too, with "packages/ui/src/button.tsx changed,
  upstream ui#build moved". The prose follows the code: a refusal only
  for an overlap the check can prove (equal paths, a path the other's
  glob matches, the same glob twice), between two tasks neither of which
  reaches the other (of one project for `outputs.files`, of any for
  `outputs.workspaceFiles`; a `remote: 'only'` task is left out); with
  the edge, the dependant's output is what its run added or changed, and
  its restore cleans only that.
- **Lab 4, a bad order,** on the scheduling page, uses only the
  simulator's knobs (the Workers menu, the chart menus, the Takes fields
  and Reset): Reset (27 s against 24), `docs#build` at 20 s (the work
  sets the bound, 29; tasks waiting 30, learned durations 29), at 30 s
  (the critical path is `docs#build` alone, 30 s; bound 34; tasks waiting
  starts it at 8 s and ends at 38, learned durations at 34), and three
  workers (32 against 30).
- **One workspace at a time in the bundle.** The shim's file system and
  env are module state (`useVfs`, `setEnv`), and a plan awaits many
  times, so two plans in flight read each other's state: item 705's
  implementer found it, and the labs page is the first with several
  playgrounds. `listPlaygroundProjects` and `planPlayground`, the two
  entry points that install them, now run through one module-level queue
  in `entry.ts` (`oneAtATime`: each starts after the one before has
  settled, a failure included). `evaluateConfig` installs neither and is
  not queued. Without the queue, a plan started beside one with another
  `API_URL` came back with that `API_URL`'s keys for `api#build` and the
  three tasks above it, and a discovery of a four-project workspace
  started beside a plan of the five-project one listed five projects.
  Two workspaces that differ only in a file's content do not show it: a
  plan takes each file's hash from its own map, and only the walk, the
  env and discovery read the shared state. The rows therefore plan
  workspaces that differ in a file's presence and in the env, with
  configs evaluated in-process first so both plans start in the same
  tick (a Worker's timing staggered them and hid the race in 705's first
  probe).

What the probes and the docs refuted:

- **"`docs#build` at 20 s, and watch the critical path grow."** At 20 s
  the chain `utils#build` → `api#build` → `app#build` → `app#test`
  (24 s) is still the longest; what grows is the work bound (58 s over
  two workers, 29). The path grows past 24 s, so the lab goes on to
  30 s, the Takes field's maximum.
- **"Turborepo restores additively, so it cannot hit this hazard, and it
  cannot tell which task wrote a path either."** Turborepo's own docs do
  not say either. They say it caches the files `outputs` names and
  restores them on a hit (`crafting-your-repository/caching#task-outputs`),
  and nothing about two tasks naming the same files (searched: restore,
  overwrite, overlap, collide, conflict, same output, clean, delete). By
  the W7 rule the page says what the docs say, and that they say nothing
  about the shared case. The claim comes from vx's own parity research
  (`graph/task-graph.ts`'s comment on `detectOutputCollisions`), not
  from Turborepo's docs.
- **"Bazel has no undeclared file at all, because the action cannot see
  it."** The glossary says an action includes its "declared input/output
  artifacts", and that sandboxing "helps ensure" an action does not read
  undeclared inputs, which is weaker than "cannot see". Lab 1 cites the
  first, lab 2 the second.
- **Lab 2's command.** `bun build … && cp config.json dist/` was the
  first draft. Under a sandbox that grants `src/**`, a read `bun build`
  makes of its own (a `package.json`, a `tsconfig.json`) could fail first,
  and `&&` would stop before the read the lab is about. A plain copy has
  no read the page does not name.

Competitor claims, each checked against the tool's docs (Turborepo,
Nx and Bazel clones of 2026-09-24) and linked to the published page:

| Lab | Tool      | What the page says                                                                                    | Source                                                                                          |
| --- | --------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| 1   | Turborepo | no `inputs` key: all files in the package checked into source control are inputs                      | `turborepo.com/docs/reference/configuration#inputs`                                             |
| 1   | Nx        | all files under a project's root by default                                                           | `nx.dev/docs/concepts/how-caching-works#configure-inputs`                                       |
| 1   | Bazel     | an action carries its declared input artifacts                                                        | `bazel.build/reference/glossary#action`                                                         |
| 2   | Turborepo | the default inputs include the file; a task's own `inputs` must list it; the docs describe no sandbox | `turborepo.com/docs/reference/configuration#inputs`                                             |
| 2   | Nx        | task sandboxing: reading an undeclared file is a violation; an Nx Cloud add-on on a dedicated cluster | `nx.dev/docs/features/ci-features/sandboxing`                                                   |
| 2   | Bazel     | the sandbox helps ensure an action does not read undeclared inputs                                    | `bazel.build/reference/glossary#sandboxing`                                                     |
| 3   | Turborepo | caches `outputs` and restores them on a hit; nothing on two tasks naming the same files               | `turborepo.com/docs/crafting-your-repository/caching#task-outputs`                              |
| 3   | Nx        | the same output location for multiple tasks often causes unintentional behavior                       | `nx.dev/docs/kb/configure-outputs#workspace-level-outputs`                                      |
| 3   | Bazel     | an artifact must be generated by at most one action                                                   | `bazel.build/reference/glossary#artifact`                                                       |
| 4   | Turborepo | how many tasks run at once, not which ready task starts first                                         | `turborepo.com/docs/reference/run#--concurrency-number--percentage`                             |
| 4   | Nx        | Nx Agents pick up tasks by historical processing time and dependencies; nothing on a local run        | `nx.dev/docs/features/ci-features/distribute-task-execution`                                    |
| 4   | Bazel     | nothing on the order of ready actions; the profiler shows a finished build's critical path            | `bazel.build/advanced/performance/json-trace-profile` (the scheduling page's existing citation) |

The rows:

| Row                                                                                                                                         | Where                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Per lab, every state its steps reach: `vx run <tasks> --all --dry=json` and the page's Run plan the same keys, statuses and deps            | `packages/vx/tests/playground-parity.unsafe.test.ts` |
| Per step, the moved set equals the hand-written one, in both planners                                                                       | same                                                 |
| Lab 3 as it opens: the CLI's stderr is `vx: <message>` and the page's error is the message, both equal to the hand-written refusal          | same                                                 |
| Every state each lab's steps reach evaluates                                                                                                | `packages/vx-docs/tests/learn-labs.test.ts`          |
| Each step through `runPlayground`: the live sentence and every moved cell equal hand-written truth, and the step's text on the page says it | same                                                 |
| Each lab's static render: its file list (the added file by hand), its configs, the task table by hand, the task field, the env              | same                                                 |
| The page holds the three playgrounds, in lab order                                                                                          | same                                                 |
| The Checkpoint's answer names exactly what the planner moves                                                                                | same                                                 |
| `data-lab`: the element (over a stub DOM) opens on its lab's files and Reset restores its specs; an unknown id throws                       | same                                                 |
| No attribute: the element opens on the workspace, and the playground page's element carries no `data-lab`                                   | same                                                 |
| Lab 4: each step's critical path, bound, both finish times and `docs#build`'s start, by hand, and the step's text says them                 | same                                                 |
| Two plans started at once through the bundle, of workspaces differing in a file and the env: each gets the keys it gets alone               | same                                                 |
| A discovery and a plan started at once: each reads its own workspace                                                                        | same                                                 |
| Two plans in flight at once (the fixture committed, and under another `API_URL`): each equals the CLI's plan of its own state               | `packages/vx/tests/playground-parity.unsafe.test.ts` |

Differentials, each restored by reverse edit:

| Mutation                                                                              | Red                                                                                                                                             |
| ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| Lab 1's start state already declares `notes.md` (in `ui#test`'s inputs)               | the site's lab 1 steps row, its static-render row and the Checkpoint row; the parity row "unlisted-file, after step 2's edits: moves exactly 0" |
| The element ignores `data-lab` (`startState(undefined)`)                              | the site's `data-lab` row and its unknown-id row                                                                                                |
| `runPlayground` shows "the plan failed" for a planner error instead of core's message | the site's lab 3 steps row and the playground's "core's refusal unchanged" row; the parity row "shared-output, as it opens"                     |
| `oneAtATime` runs its argument at once, no queue (bundle rebuilt)                     | the site's two at-once rows; the parity row "two plans in flight at once"                                                                       |

Declaring `notes.md` in `ui#build` itself was the first form of the
first mutation; it cannot leave the steps intact, since step 3's edit
is the declaration, so `applyEdits` throws. The `ui#test` form keeps the
steps and still turns the rows red for the reason the lab is about.

**Sizes.** The element's chunk is 11,015 B (4,217 B gzip), against item
703's 9,795 B: the three start states' texts. `LAB_STEPS` and
`applyEdits` are tree-shaken out of it (no step text is in the chunk).
The planner bundle is 86,497 B, +157 B for the queue.

**Node.** The site builds under Node 22
(`ASTRO_TELEMETRY_DISABLED=1 node node_modules/.bin/astro build`, exit
0, `/learn/labs/` rendered): the labs' static renders evaluate through
`evaluateConfigInProcess`, as the playground's does.

In Chromium (Playwright's, headless, over `astro preview`), the labs page
requested no `planner.js` until the first Run, and one in all. Each lab's
element opened on its own files (lab 1 with `packages/ui/notes.md` after
`ui`'s files, lab 2 with `packages/api/config.json`) and task field
(`build test bundle` in lab 3). Typing each step's edit into the editor
and running gave, step by step, the sentences and cells the page states:
lab 1 "Every key is new.", "No key moved.", then the four moved with
`ui#build`'s cell "config changed, file added: packages/ui/notes.md", then
"packages/ui/notes.md changed"; lab 2 likewise for `api#build` with
"config changed" for the sandbox step; lab 3 "The run failed." with
core's message in the error list and no table, then "10 tasks: 0 hit, 10
miss.", "10 tasks: 10 hit, 0 miss.", and five moved after the
`button.tsx` edit. Reset restored each lab's files and task field and
hid the table. On the scheduling page the simulator, stepped as lab 4
says, finished at 27 / 24, 30 / 29, 38 / 34 and 32 / 30 seconds, and its
bounds sentence named `docs#build` as the critical path from 30 s. There
was no page error and no console error.
