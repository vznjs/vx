# Capability audit: monorepo.tools, row by row (2026-09-24, roadmap track W)

> **Status:** proposal. It changes no code. Items 714–718 carry it out.

## What we're solving

The site plan (`design/site-teaches-2026-09.md`) sets monorepo.tools as the
bar, and one of its "Done means" lines is: every capability monorepo.tools
names as a checkmark has a page here that explains its mechanism, its
failure mode and its cost. STATUS Next 16 lists this as not yet met. Nobody
has checked the site row by row, and no page was found for code generation
or project constraints. The same list says the glossary has no diagram and
no interactive element.

This note does the row-by-row check, decides what each gap gets, and names
the rows that hold each change.

## The list

monorepo.tools could not be fetched: the proxy blocks it. The list below is
written from knowledge of its features section (`libs/website/ui-home`,
the source item 689 read), and item 718 re-reads that source as its first
step before any row pins the names. There are twelve features in three
groups. The only change to the list as the task gave it is that "code
sharing" is "source code sharing" there.

- **Fast:** local computation caching, local task orchestration,
  distributed computation caching, distributed task execution,
  transparent remote execution, detecting affected projects/packages.
- **Understandable:** workspace analysis, dependency graph visualization.
- **Manageable:** source code sharing, consistent tooling, code
  generation, project constraints and visibility.

## The audit

"Taught" means a page explains the mechanism, the failure mode and the
cost. A page that only names the capability does not count.

| #   | Capability                         | What vx does                                                                                                                                                                                                                                                                                                                   | Taught today                                                                                                   | Gap                                                                                                                                                                                                                      |
| --- | ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1   | Local computation caching          | Core. A SQLite index plus one `<key>.tar.zst` per entry (`src/cache/`, `docs/caching.md`). The key is held by `tests/task-hash-derive.test.ts`.                                                                                                                                                                                | `learn/caching`, `learn/correctness`                                                                           | None.                                                                                                                                                                                                                    |
| 2   | Local task orchestration           | Core. The task graph and the two-tier scheduler (`src/graph/`, `tests/task-graph.test.ts`), with the simulator replayed against the real scheduler in `vx-docs/tests`.                                                                                                                                                         | `learn/what-is-task-orchestration`, `learn/scheduling`                                                         | None.                                                                                                                                                                                                                    |
| 3   | Distributed computation caching    | A plugin on the `cache` seam: `@vzn/vx-reapi`, `turboCache()` or `nxCache()`. A remote error degrades to a miss (`tests/layered-cache.test.ts`, "get() suppresses remote errors and returns null").                                                                                                                            | `learn/caching` § Local and remote caches, `learn/extending` § A remote cache layer                            | None.                                                                                                                                                                                                                    |
| 4   | Distributed task execution         | Not in Nx's sense, where agents each hold a full checkout. `@vzn/vx-reapi` spreads one run's tasks over a worker pool (`capacity`), and the scheduler stays on this machine.                                                                                                                                                   | The choosing matrix row "Running tasks on other machines". The glossary files Nx's DTE under remote execution. | The mechanism, failure mode and cost are not taught, and DTE and remote execution are treated as one thing. **716.**                                                                                                     |
| 5   | Transparent remote execution       | `reapi({ execute: true })` over REAPI (`guides/remote-execution`). Held by `packages/vx-reapi/tests/exec-e2e.test.ts`, which runs live in CI's service job and in skip mode in the gate.                                                                                                                                       | `guides/remote-execution`, one glossary entry, one choosing cell, one bullet on `learn/architecture`           | No Learn page teaches why the worker needs every input, or what that catches. **716.**                                                                                                                                   |
| 6   | Detecting affected projects        | Core `--affected[=<base>]` (`src/workspace/affected.ts`), with dependents (`tests/affected-dependents.test.ts`, "an edit to lib selects lib AND app, never tool"). Lockfile closures come from `@vzn/vx-lockfile`.                                                                                                             | `learn/what-is-task-orchestration` § What a change affects, and the graph explorer                             | No failure mode. A root file no glob names selects nothing (`tests/affected-workspace-files.test.ts`, "a shared file NO glob reaches still selects nothing"), and a dependency the manifest omits is invisible. **715.** |
| 7   | Workspace analysis                 | Core reads the package manager's workspaces and all four dependency fields of each `package.json` (`src/workspace/package-graph.ts`, `tests/package-graph.test.ts`, "reads all four dependency fields: a workspace peer orders a build too"). It does no import analysis. `vx show`, `vx info` and `vx mcp` report the result. | One bullet in what-is § How vx does it, and the glossary's "Project graph"                                     | Where the graph comes from, and what it misses, is not taught. **715.**                                                                                                                                                  |
| 8   | Dependency graph visualization     | `vx run <tasks> --graph` prints Graphviz DOT (`tests/cli.test.ts`, "--graph prints Graphviz DOT, skips execution"), plus `--dry=json` and `vx show`. There is no browser UI: "graph UI" is on the out-of-scope list (roadmap 2.4). The Learn graph explorer and the playground draw only the toy monorepo.                     | The toy explorer on what-is; `cli` § Planning mode                                                             | No page tells the reader how to see their own graph, or that vx draws none. **715.**                                                                                                                                     |
| 9   | Source code sharing                | Not vx's job. The package manager's workspaces link the packages, and vx reads what they declare.                                                                                                                                                                                                                              | One sentence in what-is § A toy monorepo                                                                       | Not taught as a capability. **717.**                                                                                                                                                                                     |
| 10  | Consistent tooling                 | A task is one shell command (principle 3), so one `vx run` drives any tool, and `nx()` even runs Nx executors. Project discovery is JavaScript-only.                                                                                                                                                                           | The choosing row "What it builds"                                                                              | Only a matrix cell, and the idea is not taught. **717.**                                                                                                                                                                 |
| 11  | Code generation                    | None. It is out of scope (`comparison.md` § Explicitly out of scope; roadmap 2.4). `vx init` and `bunx @vzn/vx-migrate` write vx's own config and nothing else. A build-time generator is an ordinary task (`guides/task-dependencies` § Same-package ordering).                                                               | Mentioned, not taught: `introduction`, `migrate/from-nx`, `comparison`                                         | No page. **717.**                                                                                                                                                                                                        |
| 12  | Project constraints and visibility | None. It is out of scope ("belongs in lint"), but `comparison.md`'s feature table calls it "— **gap**", which contradicts the out-of-scope list. The glob boundary and the sandbox are key-correctness boundaries, not a dependency policy (below).                                                                            | `comparison` only                                                                                              | No page, and the distinction is untaught. **717.**                                                                                                                                                                       |

Three rows are covered, and nine are not. The audit also found gaps nobody
had listed:

- **Three Learn pages never link the glossary.** The plan promises "a
  glossary every page links into". `what-is-task-orchestration`,
  `extending` and `labs` have no glossary link.
- **The built pages do not all meet the per-page rule.** In `dist/`,
  `extending` carries no interactive element, since its lit pipeline strip
  is static. `playground` and `labs` carry no diagram. The "Not yet met"
  line named only the glossary.

## Decisions

**One new page, not four.** Rows 9–12 are monorepo.tools' "Manageable"
group. None of them is about running tasks, which is what every existing
Learn page teaches. Putting them on `learn/choosing` would turn that page
back into a feature list, the thing the plan set out to replace. So they
get one new lesson, `learn/around-the-runner`, titled "Around the runner:
shared code, generators and constraints". Rows 4–8 are about the graph and
the workers, so they become sections on the pages that already teach those
(`what-is-task-orchestration`, `scheduling`). No other new page.

**Code generation is not vx's job, and the page says why.** The word
covers two things, and the page separates them.

- **Scaffolding** (`nx g`, `turbo gen`) runs once, asks a person
  questions, and writes files that person then owns and commits. There is
  no input to key and nothing to replay, so it is not a task. It also needs
  each framework's conventions, which means an ecosystem, and core names
  no plugin. vx does not write your source. The `commands` seam would let
  a plugin add a `vx gen` verb, but none ships and none is planned. The
  cost is that a vx user runs a second tool for scaffolding (Plop,
  `bun create`, a framework's CLI) and then writes the `vx.config.ts`, by
  hand or with `vx init`.
- **Build-time generation** (`graphql-codegen`, `prisma generate`,
  `protoc`) is a task whose outputs are source. It declares its schema as
  inputs and the generated directory as outputs, and consumers depend on it
  with `dependsOn`. The cascade moves a consumer's key when the schema
  moves, even when the generated files are gitignored and no glob can see
  them (`tests/task-hash-derive.test.ts`, "SENSITIVITY: an upstream key
  change cascades into the dependent"). The failure mode is a consumer that
  reads the generated files without depending on the generator. It can
  start before the generator finishes, and its key misses the schema: a
  stale hit.

**Project constraints are a different thing from vx's boundaries.** The
page states it this precisely:

- **A constraint is a policy on the dependency graph.** It answers "may
  `utils` depend on `app`?" with tags and allow or deny rules, and it is
  checked over imports and manifests. Nx does this with tags and the
  `@nx/enforce-module-boundaries` rule. Turborepo does it with
  `turbo boundaries` tags, which are experimental. Bazel does it with
  target visibility.
- **vx's glob boundary is about the key.** `cache.inputs.files` is
  project-relative: a `..` segment is refused (`tests/project-loader.test.ts`,
  "refuses an escaping glob wherever the `..` sits, and under a `!`"), and a
  nested project's subtree is excluded (`tests/inputs-resolution.test.ts`,
  "excludes a nested project while keeping the parent’s files at the SAME
  depth"). Another project's change reaches a key only through `dependsOn`
  and the cascade. `workspaceFiles` crosses the boundary on purpose.
- **vx's sandbox is about reads, not dependencies.** It denies the
  workspace root outside a task's grants, but grants every `node_modules`
  link from the project and from the workspace root
  (`orchestrator/sandbox-request.ts`, `linkedDeps`). In a hoisted layout the
  root links every workspace package, so a sandboxed task can read a
  sibling it never declared. This checkout's root `node_modules/@vzn`
  links all the first-party packages. Item 717 pins this with a row.
- **The one rule vx enforces on the graph is "no cycles".** There is no
  valid order without it (`tests/task-graph.test.ts`, "a task cycle through
  every project is refused"). Beyond that, vx accepts any dependency that
  `package.json` declares, including one that breaks your architecture.
- **How to get constraints with vx: a lint task.** Use an oxlint or ESLint
  rule, or dependency-cruiser, run as an ordinary cached task. This
  repository does it that way: `tests/module-boundaries.test.ts` and
  `tests/package-boundaries.unsafe.test.ts` are vx's own constraints,
  running as vx tasks. A `project` plugin sees `ctx.packageJson` and could
  refuse a run, but that is the wrong place. It checks manifests, not
  imports, and it would block every run in the workspace, where a lint task
  fails only itself.

**Graph visualization: DOT, plus the Learn explorer for the idea.**
`vx run --graph | dot -Tsvg` is vx's picture of a real workspace. The
section says plainly that vx has no browser UI, and that a `commands`
plugin could add one. Nx has `nx graph`, and Turborepo has
`turbo run --graph` (svg, html, mermaid or dot) and `turbo devtools`, so
this row names a place where the others are ahead.

**Distributed execution: two mechanisms, one section.** The section
teaches the difference.

- **Distributing across agents** (Nx Agents) means each machine holds the
  whole repository. A coordinator hands out tasks, and results travel
  through the remote cache. An undeclared input goes unnoticed, just as it
  does on one machine.
- **Remote execution** (Bazel, `@vzn/vx-reapi`) sends each task as an
  action: its command, the digest of exactly its declared input files, and
  a platform. The worker holds nothing else, so an undeclared input fails
  the task on the worker instead of becoming a stale hit
  (`guides/remote-execution` § It proves your declared inputs).
  monorepo.tools calls this "transparent remote execution".

vx does the second kind. Its costs are that every input must be declared,
the worker image needs your toolchain, you pay transfer time, and you run
or rent the pool.

**The glossary is exempt, and the rule gets written down.** The glossary
is a reference: a reader arrives at one anchor from a link, not at the
top. A diagram or a widget there would be scrolled past, and the checkpoint
exemption (architect, 2026-09-24) already rests on the same reasoning. The
real glossary gap is the missing links from three pages, and the fix is
those links. The plan's rule applied to the seven lesson pages of its
"shape" table (W1–W7), not to the pieces (W9, W10, W12). So the Learn
section gets three kinds, written into the plan and held by a law:

- **Lessons** (W1–W7 and the new page): a diagram, an interactive element
  and a checkpoint, except that `extending` has no element. Its W6 row in
  the plan names a static lit strip, and `learn/architecture`'s pipeline
  explorer is the interactive for the same stages.
- **Tools** (`playground`, `labs`): the playground element and a
  checkpoint. The planner's table is the picture.
- **Reference** (`glossary`): none of the three.

## The changes

Each item follows the Learn pattern: the tool-neutral idea, how vx does it,
one sentence each for Turborepo, Nx and Bazel linked to their published
docs, and a checkpoint on a lesson page. The sentences marked "checked"
below were read from the vendors' docs sources on GitHub on 2026-09-24,
because their sites are blocked here. Each item re-checks its own and
records the date, as item 689 did.

### 714: the Learn page kinds, and the glossary links (S)

- `learn/what-is-task-orchestration`, `learn/extending` and `learn/labs`
  each link at least one term into `learn/glossary`.
- `design/site-teaches-2026-09.md` § Done means: "Every Learn page has a
  diagram…" becomes "Every Learn lesson…", followed by the three kinds
  above.
- New `vx-docs/tests/learn-pages.test.ts`. The kinds are written out by
  hand there, and every row reads the built page.

### 715: what-is, where the graph comes from and how to see yours (S)

- New section **"Where the graph comes from"**, after § What a change
  affects. It covers three sources: manifests (`package.json`), source
  imports, and `BUILD` files. The failure mode is an import the manifest
  does not list. A hoisted `node_modules` resolves it anyway, the graph has
  no edge, `^build` does not order it, and an edit to the imported package
  neither reruns nor re-keys the importer. vx reads manifests only, by
  choice (explicit over magical), and the cost is that this edge is yours
  to keep.
- New section **"Seeing your own graph"**: `vx show`,
  `vx run build --graph | dot -Tsvg`, `vx run build --dry=json` and
  `vx mcp`. There is no browser UI, and a `commands` plugin could add one.
- § What a change affects gains a paragraph, **"What `--affected` cannot
  see"**: a root file no glob names, and the missing edge above.
- Others. Turborepo builds on package-manager workspaces (checked:
  `crafting-your-repository/structuring-a-repository`). It draws the task
  graph with `turbo run --graph` (checked: `reference/run`), shows the
  package graph in a browser with `turbo devtools` (checked:
  `reference/devtools`), and flags an import of a package missing from
  `package.json` with `turbo boundaries` (checked, experimental:
  `reference/boundaries`). Nx computes its graph partly by analysing
  source code, and `nx graph` explores it interactively (checked:
  `features/explore-graph`). Bazel reads `BUILD` deps, and
  `bazel query … --output graph | dot` draws them (checked:
  `query/guide`).
- The diagram is the page's existing Mermaid. No new element: the graph
  explorer already on the page is the interactive.

### 716: scheduling, workers on other machines (S)

- New section **"Workers on other machines"**, after § Restore tier and
  exec tier. It covers the two mechanisms above and their failure modes
  (unnoticed versus failed on the worker). The vx paragraph covers
  `reapi({ execute: true })`, `capacity`, a sandboxed task staying local,
  and no shipped workers. It lists the costs above.
- One Mermaid diagram: the scheduler on this machine, the executor seam,
  the local floor and `reapi`, the CAS and the worker pool.
- Others. Turborepo's docs describe no way to spread a run across machines.
  Nx Agents distribute CI tasks on Nx Cloud. Bazel sends actions over
  REAPI. Each reuses the link the choosing model's `remote-exec` row
  already carries.
- Glossary: **Remote execution** and **Distributed task execution** become
  two terms. Nx's line moves to the second, with "—" plus a sentence under
  the first.

### 717: the new page, "Around the runner" (M)

- `learn/around-the-runner.mdx`, placed in the sidebar after "Extending vx"
  and before "choosing". It has four sections:
  - **Sharing code.** Package-manager workspaces, and vx reads them.
  - **One way to run every tool.** One command per task, and the JS-only
    discovery limit, linked to the choosing row.
  - **Code generation.** Scaffolding versus a generator task, as decided
    above, with the `codegen` example from `guides/task-dependencies`.
  - **Project constraints.** The five bullets above.
- Others. Nx generators are TypeScript functions from plugins, run with
  `nx g <plugin>:<generator>` (checked: `features/generate-code`).
  `turbo gen` runs Plop-based generators it discovers per workspace
  (checked: `reference/generate`, `guides/generating-code`). Bazel's docs
  describe no scaffolding command, and build-time generation is a rule's
  action such as `genrule` (to check). For constraints: Nx tags plus the
  ESLint or Oxlint rule over imports and `package.json`, and a
  language-agnostic conformance rule on the Enterprise plan (checked:
  `features/enforce-module-boundaries`). Turborepo's `turbo boundaries`
  has tag allow and deny rules for dependencies and dependents, and is
  experimental (checked). Bazel's target visibility fails the build at
  analysis, and the default is private (checked: `concepts/visibility`).
- Diagram: a Mermaid of the toy monorepo with a tag on each package
  (`utils` type:util, `ui` type:ui, `api` type:data, `app` type:app) and
  one refused edge drawn dashed.
- Interactive: **`<vx-boundary-check>`**, with a model in
  `demos/model/boundaries.ts`. The reader picks an edge to add. Each edge
  gets three verdicts:

  | Edge                           | Tag rule (a lint, modelled) | vx's task graph                                                                              | vx's sandbox                        |
  | ------------------------------ | --------------------------- | -------------------------------------------------------------------------------------------- | ----------------------------------- |
  | `api` imports `ui`, listed     | refused                     | accepted: `api#build` waits on `ui#build`, and an edit to `ui` re-keys it                    | allowed: a declared, linked package |
  | `api` imports `ui`, not listed | refused                     | no edge: `api#build` is not ordered after `ui#build`, and an edit to `ui` does not re-key it | allowed under a hoisted layout      |
  | `utils` imports `app`, listed  | refused                     | refused: a cycle                                                                             | not reached                         |

  The tag rule is a model, labelled as one. The vx column is held to real
  vx by `planRun`, the way `learn/correctness` holds its stale-hit model.
  The static render shows all three rows.

- Checkpoint: a static `<details>` checkpoint, as on scheduling and
  choosing, because the answer comes from the tag rule, not the planner.
  The question is: "`api` starts importing `ui` and lists it. What stops
  it?" The answer is a tag rule in lint. vx plans it, and the sandbox
  lets it through.
- Glossary: two new terms, **Code generation** and **Project
  constraint**, each with the name every tool uses (vx: "—, a task" and
  "—, a lint task").
- `comparison.md`: the "Boundaries / package-tag visibility" cell changes
  from "— **gap**" to "— out of scope: a lint task", to agree with its own
  out-of-scope list.
- Core: a pin row in `tests/sandbox-runtime.unsafe.test.ts` for the
  hoisted-link claim (below).

### 718: the checklist, mapped, on choosing (S)

- First, re-read `nrwl/monorepo.tools` (`libs/website/ui-home`) and
  correct the twelve names above if they differ.
- A new `demos/model/capabilities.ts`: twelve entries, each with
  monorepo.tools' name, vx's answer in one sentence (ships in core, a
  plugin, or not vx's job, plus the reason), and the page and anchor that
  teach it.
- A new short section on `learn/choosing`, **"From a checklist to the
  mechanisms"**. It renders that model as a table: a reader arriving from
  monorepo.tools finds the page for each checkmark. It is not a checkmark
  grid, because each row is an answer in words and a link.
- STATUS: the "Not yet met" line drops the capability clause.

## Rows

Every row reads the built `dist/` unless it says otherwise. Each
differential listed is reversed after it is run.

**714, `vx-docs/tests/learn-pages.test.ts`:**

- `it('sorts every sidebar Learn page into lessons, tools and the reference, by the hand-written list')`
  compares exact sets in both directions against `astro.config.mjs`'s
  Learn links.
- `it('gives every lesson a diagram and a checkpoint')`. A diagram is a
  `pre.mermaid`, an `svg[role=img]` or a `.vx-pipeline` strip.
- `it('gives every lesson but extending an interactive element, and extending none')`
  keeps the exemption exact.
- `it('gives the playground and the labs their playground element and a checkpoint')`.
- `it('keeps the glossary a reference: no element and no checkpoint')`.
- `it('links every lesson and tool page into the glossary, at an anchor the glossary has')`.
- `it("gives every glossary term a line for vx, Turborepo, Nx and Bazel, and the terms are the hand-written list")`.
  716 and 717 extend the list.
- Differentials: removing correctness's Mermaid, removing a new glossary
  link, or adding an element to extending each turns exactly its row red.

**715, `vx-docs/tests/learn-what-is.test.ts`:**

- `it('a dependency the manifest leaves out drops the edge, and an edit to ui no longer moves app#build')`
  runs `planRun` over a temporary copy of the playground's toy workspace
  with `ui` removed from `app`'s dependencies. The truth is written by
  hand. Its CONTROL row, with the line kept, moves the key.
- `it('names each command it teaches as the CLI reference spells it')`
  checks `vx show`, `--graph` and `--dry=json` against `cli.md`.
- `it('links each vx claim to a test row that exists')` reuses the
  choosing test's row lookup for `affected-workspace-files` and
  `cli.test.ts`.
- `it("sends each other tool's sentence to that tool's docs")`.

**716, in `vx-docs/tests/learn-pages.test.ts` or a new
`learn-scheduling.test.ts`:**

- `it('draws the remote path in Mermaid: scheduler, executor, local floor, store, pool')`
  checks the node ids exactly.
- `it('links its vx claims to the exec-e2e rows that hold them, and says they run live in CI only')`.

**717, `vx-docs/tests/learn-around.test.ts`:**

- `it('the tag rule refuses exactly the edges written out by hand')`.
- `it("vx's column is real vx's: the listed edge is planned, the unlisted one is absent, the cycle is refused")`
  runs `planRun`. The cycle's message matches `/Cycle detected/`.
- `it('shows every edge with its three verdicts without JavaScript, and hides the controls')`.
- `it("loads the element's module from the page's own scripts, free of Bun, process and node:")`.
- `it("sends each other tool's sentence to that tool's docs")`.
- `it("names the sandbox pin row, and core's unsafe suite has it")`.
- `it('answers the checkpoint with the tag rule')`.

**717, core `tests/sandbox-runtime.unsafe.test.ts`:**

- `it('a sibling linked in the workspace root node_modules is readable though undeclared: the grant follows links, not the dependency list')`.
  The fixture makes the link itself, so no package manager's layout is
  assumed.
- `it('CONTROL: a sibling linked nowhere is denied')`.
- Differential: dropping the workspace root from `depDirs` turns the first
  row red, and the control stays green.

**718, `vx-docs/tests/learn-choosing.test.ts`:**

- `it("maps monorepo.tools' twelve capabilities, in its order and words, each to one answer and one page")`.
- `it('lands every capability on a built page and an anchor it has')`.
- `it('words each answer as core, a plugin or not vx’s job, with a source')`.

## Order and size

714 (S) comes first, so every later page is born under the law. Then 715
(S), 716 (S), 717 (M) and 718 (S). 718 goes last because it links anchors
the others create. That is one new page and about two to three agent-days
in total, most of it in 717.

## What's out of scope

- **Building generators, a graph UI or boundaries.** They stay on
  roadmap 2.4's out-of-scope list, and the pages say "today". If the owner
  moves one in, its page changes with it.
- **A fifth lab** for the missing manifest edge. The `planRun` row holds
  the claim. A lab would add parity rows for no new idea.
- **An interactive glossary**, and an interactive element on `extending`.
- **The other "Not yet met" lines**: the landing's cards linking tests,
  and figures on pages other than the landing.
- **Rewriting `comparison.md`'s feature table.** Only the contradictory
  cell changes.

## Open questions

- **The twelve names.** They come from memory, and 718 confirms them
  against the source before any row pins them.
- **The owner's answer to roadmap 2.4.** Generators, graph UI and
  boundaries are "out of scope today", not final, until the owner answers.
- **Which layouts link every workspace package at the root.** The page
  says "a hoisted layout" and names no package manager, because the
  defaults move between releases. The pin builds its own link.

## Why this is the right move

- Twelve rows audited against source, docs and tests. Three were covered,
  nine were not, and two gaps nobody had listed were found (missing
  glossary links, and pages below the per-page rule).
- There is one new page, and only where no existing page's subject fits.
  The other gaps are sections on the pages that already teach the graph
  and the workers.
- The constraints section answers the question the reader actually has.
  vx's boundaries protect the key, not the architecture, and the sandbox
  claim is pinned by a row instead of asserted.
- "Not vx's job" is taught as a mechanism with a cost, not as a missing
  checkmark. That is the plan's difference from monorepo.tools.
- Every exemption is written in one list that a law holds, so the next
  page cannot quietly skip the rule.
