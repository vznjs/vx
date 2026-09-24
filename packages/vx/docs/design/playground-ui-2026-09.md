# The playground page (2026-09-24, roadmap W9, item 700)

W9's last step is the page the playground bundle exists for. The reader
edits a small monorepo's files and `vx.config.mjs` files and runs
`vx run`, and vx's real planner, bundled from core's source, says which
tasks hit, which miss and why. The bundle (item 695) and in-page config
evaluation (item 699) are the model. This note decides the view.

## Decisions

- **One page, `learn/playground.mdx`, last in Learn before the
  glossary.** It is the capstone the other pages point into, not a
  replacement for their widgets. W10's labs are sections of this page,
  or pages that embed the same element with a different starting state.
- **The workspace is the Learn pages' toy monorepo, not the parity
  fixture.** `utils`, `ui` and `api` (both use `utils`), and `app`
  (uses `ui` and `api`), with `build` and `test` tasks wired by `^build`
  and `build`, plus `docs#build`, which nothing waits on. That is the
  graph W1 and W4 draw (`components/demos/model/toy-monorepo.ts`). The
  parity fixture is adversarial on purpose, with literal brackets and
  negations, and it teaches nothing. The page's workspace lives in
  `src/playground/workspace.ts` as `.mjs` config texts and source
  files. **Its keys are held to the CLI's** by a parity row beside the
  fixture's in core's unsafe suite, so the page ships only a workspace
  whose plan the CLI agrees with.
- **An island in the W0 pattern, `<vx-playground>`.** `Playground.astro`
  wraps `Demo.astro`.
  - Without JavaScript, the static render is the workspace's file list,
    each config's text, and the task graph as a table (task, what it
    waits for, the files it declares). It is built at build time from
    `workspace.ts`, with no planner needed. It must teach on its own:
    "these tasks exist, these files are their inputs".
  - With JavaScript, the element shows its controls. The planner
    (`/vx/playground/planner.js`, via `import.meta.env.BASE_URL`) is
    imported **on the first Run**, not at page load. A page view that
    never runs costs nothing.
- **No editor dependency.** Files are edited in a `<textarea>` with
  monospace text, one file at a time, picked from the file list. A
  syntax-highlighting editor is a dependency without a reason at this
  size.
- **The loop the page teaches is run, edit, run.**
  - **Run** evaluates every config (`evaluateConfig`, with a deadline of
    2 s) and plans (`planPlayground`) with the reader's task specs
    (default `build test`), env and file state.
  - After a run, every planned key is added to the simulated cache, the
    way a real run saves. The first run therefore misses everywhere and
    a second run with no edit hits everywhere.
  - Each run's table lists the task, the short key (16 hex), the status
    and a **"key moved"** marker against the previous run.
  - A summary line in an `aria-live` region reads, for example, "8
    tasks: 5 hit, 3 miss. Keys moved: ui#build, app#build, app#test."
- **The reader can edit any file and add or delete files.** Adding a
  file the config never mentions, and seeing that nothing moves, is
  W10's first lab. The env is edited as `NAME=value` lines. **Reset**
  restores the starting state and empties the simulated cache.
- **Errors are shown, not swallowed.**
  - A config that fails to evaluate shows its project and the message
    from `evaluateConfig`.
  - A config core refuses shows the message core throws
    (`validateProjectConfig`, `UserError`), unchanged.
  - A task spec that matches nothing lists its unresolved specs.
  - An error keeps the last good table visible and marks it stale.
- **What the view computes is a pure module.** `playground-view.ts`
  holds these functions: the diff between two runs, the summary
  sentence, the static table from `workspace.ts` and the env parser.
  The element only wires them to the DOM. The module's rows run in
  `bun test` without a DOM.

## Not in this step

- Execution, outputs and restores. The page says so: it plans, it does
  not run commands.
- A Gantt chart of the dispatch order. The scheduling page has one.
  Here the dispatch order is one line.

## Rows

- **Site, sandboxed:**
  - the built page holds the static table for every task in
    `workspace.ts` and the loader;
  - the view module's pure functions (diff, summary, env parse, static
    table);
  - the island's markup contract, meaning the classes the element reads
    (the same form as `demo-islands.test.ts`).
- **Core unsafe suite:** the page's workspace, planned by the bundle
  after `evaluateConfig` on each config text, equals
  `vx run build test --all --dry=json` on the same files, committed:
  keys and statuses in two scenarios (committed, and one source edit).
- **A one-off Chromium probe, recorded here** (as item 695's was):
  load the built page, run, edit `packages/ui/src/button.tsx`, and run
  again. Exactly `ui#build`, `ui#test`, `app#build` and `app#test` move,
  and there is no page error.

## Shipped (item 700)

The page is `learn/playground`, last in Learn before the glossary, and
the caching and correctness pages link to it in one sentence each.

- **Where things are.** The workspace is
  `packages/vx-docs/src/playground/workspace.ts`: `CONFIG_TEXTS` (one
  `vx.config.mjs` text per package), `FILES`, `ENV` (`API_URL`, which
  `api#build` declares) and `TASKS` (`build test`). What the page
  computes is `src/components/demos/model/playground-view.ts`. The
  island is `Playground.astro` plus `demos/playground.ts`
  (`<vx-playground>`).
- **Bare package names.** The packages are `utils`, `ui`, `api`, `app`
  and `docs`, not `@toy/…`, so the ids the page shows are the Learn
  pages' own (`ui#build`).
- **Every build reads `src/**`, every test `src/**` and `test/**`.**
  `docs#build` has no `dependsOn`. Nine tasks for `build test`.
- **The page's Run is one function,** `runPlayground(planner, input)`.
  It asks the bundle which config file core loads for each project, so
  core's discovery, name precedence included, is the only copy of that
  rule. That is a new bundle export, `listPlaygroundProjects`, beside
  `evaluateConfig` and `planPlayground`. It evaluates each text with a
  2 s deadline, plans with the reader's files, env, specs and cache, and
  returns the cache the run leaves: every key it planned. The element
  keeps what it returns, so the cache fill is in the tested function and
  not in DOM code. Rows are ordered by their project's config file in the
  file list, then by each config's task order, so the table reads
  `utils`, `ui`, `api`, `app`, `docs` as the Learn pages do.
- **Errors.** A config that does not evaluate shows
  `<project> (<file>): <message>`. Core's refusal is shown as thrown. A
  spec that matches nothing gets the CLI's words, "no projects declare
  task(s): lint.". An env line that is not `NAME=value`, or an empty spec
  field, is refused before the planner loads. Each error keeps the last
  good table, marked stale in its caption and dimmed.
- **The static table comes from the texts, evaluated at build time by
  the page's own rewrite and JSON rule.** `Playground.astro` evaluates
  `CONFIG_TEXTS` with `evaluateConfigInProcess`: the same rewrite, the
  same `nonJsonPaths` refusal and the same messages as the reader's
  Worker path, with the modules imported in-process from base64 `data:`
  URLs, which Node and Bun both import. It fails the build if one does
  not evaluate. The texts are the one source. (Corrected after CI: the
  step first used the Worker path at build time, on the premise that the
  site builds under `bun --bun astro build` and Bun has `Worker`. Linux
  CI's prerender ran under Node, which has no global `Worker`, and
  `/learn/playground/` failed with "Worker is not defined"; this box
  builds under Bun, so the gate never saw it. Reproduced here by running
  astro under Node 22: red with the Worker path, green with the fix.
  `tests/playground-build-eval.test.ts` deletes the global and requires
  the in-process answer to equal the Worker's for every text and three
  refusals, and pins the import. A percent-encoded `data:` URL was
  refuted on the way: Bun picked the text loader for the api config,
  whose command holds `src/server.ts`, and returned the source as a
  string. Item 708 later gave the prerender Bun as well; the build path stays runtime-agnostic.) The other option, importing
  config objects, needs a second copy of each config, or texts printed
  from objects, which would carry no comments. "Waits for" is resolved by
  the view (`^task`, `task`, `pkg#task`), which is a small copy of core's
  rule. A site row holds it to the deps the planner resolves, for every
  task of the page's workspace.
- **The planner loads on the first Run,** from `data-planner` on
  `.controls`, which `Playground.astro` sets from
  `import.meta.env.BASE_URL`, as the other widgets build their links.
  Before a Run, the page has requested no `planner.js`. The element's
  chunk is 9,056 B (3,524 B gzip), the workspace's texts included. The
  bundle is 84,084 B (29,713 B gzip).

The rows:

| Row                                                                                                                     | Where                                                                                     |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| The page's Run on its workspace: every key, cache status and deps equal `vx run build test --all --dry=json`, committed | `packages/vx/tests/playground-parity.unsafe.test.ts` (`test.bun.unsafe`: git, no sandbox) |
| The same after an uncommitted edit to `packages/ui/src/button.tsx`                                                      | same                                                                                      |
| That edit moves exactly `app#build`, `app#test`, `ui#build` and `ui#test`, in both planners                             | same                                                                                      |
| Diff, summary, failure sentence, order line, env and spec parsing against hand-written truth                            | `packages/vx-docs/tests/playground-view.test.ts` (sandboxed, reads `dist/`)               |
| The static table equals a hand-written one, and its "waits for" equals the planner's deps                               | same                                                                                      |
| The page's Run over the shipped planner: all miss, then all hit; the edit moves the four; a new README moves nothing    | same                                                                                      |
| A broken config names its project and file; core's refusal is unchanged; an unknown spec gets the CLI's words           | same                                                                                      |
| The built page: the static table for every task, the file list, each config's text                                      | `packages/vx-docs/tests/learn-playground.test.ts` (sandboxed, reads `dist/`)              |
| The controls ship hidden, with the starting env and specs and the planner's URL, and the planner is in `dist/`          | same                                                                                      |
| Every selector and `data-action` the element reads matches exactly one element                                          | same                                                                                      |
| The page's scripts define `<vx-playground>`, and no chunk they reach carries the planner                                | same                                                                                      |
| The checkpoint names exactly the keys the planner moves                                                                 | same                                                                                      |
| The bundle exports exactly `evaluateConfig`, `listPlaygroundProjects` and `planPlayground`                              | `packages/vx-docs/tests/playground-bundle.test.ts`                                        |

Differentials, each restored by reverse edit:

| Mutation                                                            | Red                                                                                                     |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `diffRuns` never says `moved`                                       | the diff row, the edit row, the checkpoint row over the Run, and the built page's checkpoint row        |
| `runPlayground` returns the cache it was given, not filled          | "misses everywhere first, saves every key, and hits everywhere on a second run" and the edit row        |
| The page's `ui#test` stops declaring `src/**`                       | NOT the parity rows: 29 of 29 pass. The site's hand-written static table and the built-page rows go red |
| The page's `ui#build` declares `src/**/*.ts`, so the edit misses it | the parity row's moved set: `[]` moved where four were expected                                         |
| `Playground.astro` drops the first static row (site rebuilt)        | the built page's static-table row                                                                       |
| `staticTable` drops the first project                               | the hand-written table row, the "waits for" row and the built page's static-table row                   |

**What a probe refuted.** The step asked that `ui#test` no longer
declaring `src/**` turn the parity row's moved set red. It cannot: a
task's key folds the keys of the tasks it waits for, and `ui#test` waits
for `ui#build`, which reads the edited file. So the edit still moves
`ui#test`, and the moved set is the same four. The parity rows compare
the page with the CLI, which read the same mutated text and agree. The
site's hand-written table catches the mutation instead, and a mutation
the edit does see, `ui#build` no longer reading `button.tsx`, turns the
parity row red.

In Chromium (Playwright's, headless, over the built site's
`astro preview`), the page requested no `planner.js` until the first
Run. The first Run gave "9 tasks: 0 hit, 9 miss. Every key is new.",
with all nine keys equal to `vx run build test --all --dry=json`'s on the
same files committed. The second Run gave all nine hits and "No key
moved.". Appending a line to `packages/ui/src/button.tsx` in the editor
then gave "9 tasks: 5 hit, 4 miss. Keys moved: ui#build, ui#test,
app#build, app#test.", and exactly those four rows carried "moved".
Adding `packages/ui/README.md` gave all nine hits and no key moved.
Deleting the last `}` of `packages/api/vx.config.mjs` gave the error
"api (packages/api/vx.config.mjs): SyntaxError: Unexpected token ')'",
kept the last good table with `data-stale="true"` and a stale caption,
and the live region said so. Reset hid the table, and the next Run
missed all nine again. There was no page error and no console error.

## Shipped (item 703): why a key moved

The "Key moved" cell names what moved the key, by the rule `vx why`
uses. Design: `design/labs-checkpoints-2026-09.md` § First.

- **One join.** `cacheKeyDiff`'s join over two runs' `entry_inputs` is
  its own pure function, `diffKeyComponents(before, after)` in
  `orchestrator/metrics.ts`: two `{ kind, name, hash }` sets in, the
  `changed` / `added` / `removed` entries (ordered by kind, then name)
  and the unchanged count out. `cacheKeyDiff` keeps its SQL and calls
  it. The move is behaviour-neutral: `cacheKeyDiff`'s rows cover the
  three verdicts and the kind order, and the one case they did not, the
  name order within a kind, got a row first (mixed case, since the
  scan's BINARY order and `localeCompare` differ there), green on the old
  code.
- **The components.** The playground's cache layer passes a fresh
  `captureInto` array to `foldKey` for every key and keeps it under the
  key, so each `PlaygroundTask` carries `components`, the rows a real
  miss writes to `entry_inputs`. Core's `foldKey` and its run path are
  unchanged: only the bundle's layer asks for the capture.
- **The page uses the bundle's copy of the function.** The bundle
  re-exports `diffKeyComponents`, the `Planner` interface names it, and
  the element passes `planner.diffKeyComponents` to
  `diffRuns(prev, next, diff)`. The other route, importing core's source
  into the view module, was not taken: `package-boundaries.unsafe`
  exempts only `src/playground/`, it would put core into the element's
  chunk (which the built-page row keeps free of the planner), and the
  planner is loaded before any key can move, since the first Run loads
  it. The bundle is the file the parity rows build, so the function the
  page calls is the one they test.
- **The words.** `describeChange(entry)` per kind the fold records:
  `packages/ui/src/button.tsx changed`, `file added: …`,
  `upstream ui#build moved`, `env API_URL changed`, `config changed`,
  `package.json changed`, `workspace fingerprint changed`,
  `args after -- changed`, `output of <command> changed`,
  `plugin part <name> changed`. `changeCell` names at most two, then
  "and N more". A group's key has no components, so its cell still
  says "moved". The `aria-live` summary is unchanged.
- **Sizes.** The bundle is 86,312 B (30,373 B gzip), +729 B (+252 B
  gzip) on the tree before this change. The element's chunk is 9,795 B
  (3,832 B gzip), against item 700's recorded 9,056 B.

The rows:

| Row                                                                                                                                                                                                                                      | Where                                                |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| `cacheKeyDiff` names changed / added / removed, orders by kind, and (new) orders one kind by name                                                                                                                                        | `packages/vx/tests/metrics.test.ts`                  |
| A real `vx run build test --all`, then the `button.tsx` edit, a new file, and that file gone: per step, `vx why <id> --format json`'s entries for the four moved tasks are the exact expected set, and equal the page's, hashes included | `packages/vx/tests/playground-parity.unsafe.test.ts` |
| `diffRuns` diffs only a moved key's components, through the bundle's function                                                                                                                                                            | `packages/vx-docs/tests/playground-view.test.ts`     |
| `describeChange` for each kind and verdict; the cell's "and N more" cut                                                                                                                                                                  | same                                                 |
| The page's Run over the shipped planner names the `button.tsx` edit for all four moved tasks (exact set and cells)                                                                                                                       | same                                                 |
| The bundle exports exactly `diffKeyComponents`, `evaluateConfig`, `listPlaygroundProjects` and `planPlayground`                                                                                                                          | `packages/vx-docs/tests/playground-bundle.test.ts`   |

The parity row's workspace is the page's with every command made
`true`: the page's commands (`vite build`, `tsc -b`, `astro build`)
are not on the gate's box, and a command folds into its own task's key
only, which none of the steps moves.

Differentials, each restored by reverse edit:

| Mutation                                                          | Red                                                                                                                          |
| ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `diffKeyComponents` swaps `added` and `removed`                   | `cacheKeyDiff`'s three-verdict row, the parity row's added and removed steps, and (bundle rebuilt) the site's `diffRuns` row |
| The bundle's layer stops passing `captureInto` (components empty) | the parity row's three steps and the site's `button.tsx` naming row                                                          |
| `describeChange` names an upstream by its hash, not its task id   | the site's per-kind row and its `button.tsx` naming row                                                                      |
| `changeCell` names three before "and N more"                      | the site's cut row                                                                                                           |
| `cacheKeyDiff`'s sort drops the name tiebreak (before the move)   | the new name-order row                                                                                                       |

**What a probe refuted.** The step's parity row compared the
`button.tsx` edit alone, and the swap of `added` and `removed` was to
turn it red. It cannot: an edit to a tracked file gives only `changed`,
and the row as first written stayed green under the swap: its file's 34
rows passed, and `cacheKeyDiff`'s three-verdict row was the only red. The row now also adds a file and
then removes it, and those two steps go red.

In Chromium (Playwright's, headless, over the built site's
`astro preview`), the first Run gave all nine keys new. Appending a
line to `packages/ui/src/button.tsx` and running again gave "9 tasks: 5
hit, 4 miss. Keys moved: ui#build, ui#test, app#build, app#test.", and
the four rows' "Key moved" cells read `packages/ui/src/button.tsx
changed` (`ui#build`), `packages/ui/src/button.tsx changed, upstream
ui#build moved` (`ui#test`), `upstream ui#build moved` (`app#build`)
and `upstream app#build moved` (`app#test`); the other five were empty.
There was no page error and no console error.
