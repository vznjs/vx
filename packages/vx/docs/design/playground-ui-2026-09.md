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

- **Why a key moved**, as in "`src/button.tsx` changed". The page shows
  that it moved. Naming the input needs the key's components, and the
  bundle does not return them yet. W10's labs will need them. They are
  the next widening of `PlaygroundResult`: `plan()` already has the
  parts, so this is a view change, not a model change.
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
