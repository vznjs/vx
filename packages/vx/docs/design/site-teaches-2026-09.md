# The site teaches (2026-09-23, roadmap track W)

The owner asked for this on 2026-09-23: redo the site so it teaches what
task orchestration is, with interactive examples and diagrams, and shows
where vx is stronger. That means performance, and also its architecture,
its correctness guarantees and how far it can be extended. The owner's
words were "We need to educate not only sell."

This page is the plan. It changes no code. Each step below becomes a
STATUS item when it starts.

## What is wrong with the site today

- It is organized for someone who has already chosen vx: a quickstart,
  guides and a reference. Nothing explains the problem to a reader who
  arrives knowing only `npm run build`.
- Two short concept pages (`concepts/how-vx-works.md` and
  `concepts/why-vx-is-fast.md`) carry the whole explanation, as prose.
  They have no diagram a reader can interact with.
- Performance is the only strength with a picture (`BenchChart.astro`).
  The architecture is described only in the Internals section, which is
  collapsed by default. It covers the pipeline with seams, the local
  floor under every plugin, explicit inputs, the sandbox as a proof,
  hashing by inputs rather than outputs, and a stale hit being the worst
  failure. It never compares any of these to what Turbo, Nx or Bazel do.
- `comparison.md` is a feature table. It says what differs, but not why
  the difference matters or what it costs.

## The bar: monorepo.tools

The owner named monorepo.tools as the page to beat, by "1000×" on
education. It was read from its source (`nrwl/monorepo.tools`,
`libs/website/ui-home` and `ui-compare`) on 2026-09-23. Nx wrote it.

**What it does well.** It opens with a crisp definition ("multiple
distinct projects with well-defined relationships"). It names a real
misconception ("monorepo ≠ monolith"). The "polyrepo tax" is a
side-by-side of four pains and their monorepo answers. It has a curated
list of resources, and it admits that features are not everything
("you may find Lage more enjoyable to use than Nx or Bazel").

**Where it stops, and where this site starts:**

| monorepo.tools                                                                                                             | This site                                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Names a capability in one sentence ("store and replay … you never build the same thing twice") with a static illustration. | Explains the mechanism, then hands the reader the controls: build a key, change an input, watch what reruns.                                                                              |
| Nothing runs. The only interaction is switching tabs.                                                                      | The real planner runs in the browser (W9): the actual task-graph builder, key fold and scheduler over a workspace the reader edits.                                                       |
| Features are yes/no checkmarks across 9 tools.                                                                             | Every design choice says what it buys, what it costs, and when another tool's choice is better (W7). A checkmark hides the difference between "supported" and "correct by construction".  |
| Failure is absent. "Hermetic builds" is one line.                                                                          | Failure is taught: stale hits, cache poisoning, undeclared inputs, flaky ordering. The reader breaks a build and watches what catches it (W3, W10).                                       |
| Written by one vendor, whose tool ticks every box. The claims are unsourced.                                               | Every claim about another tool links to that tool's docs, with the date it was checked. Every claim about vx links to the test that holds it.                                             |
| One long page and one table. No path from novice to expert.                                                                | A learning path from the problem to the plugin API, with a checkpoint question per page that the reader answers against the live model (W11), and a glossary every page links into (W12). |

"1000×" is measured by what a reader can do after reading, not by page
length. After monorepo.tools, a reader can name features. After this
site, a reader should be able to:

- predict what a change reruns;
- say why a cache hit is safe or stale;
- read a task graph;
- choose a tool for stated reasons;
- write a plugin.

Each Learn page's checkpoint tests one of those.

## Principles

1. **Teach first, then show vx.** Each concept page explains the idea in
   general terms: what any task runner has to solve, and how Turbo, Nx,
   Bazel and vx solve it. Only after that does it show vx's choice.
2. **Be honest about trade-offs.** Every "vx is stronger here" sits next
   to what it costs and where another tool is the better choice. The
   existing deliberate-differences list in `comparison.md` is the source.
3. **Every claim links to its proof.** A number comes from
   `benchmarks.md`. A guarantee names the test that holds it. The docs
   already pin these; the site links to them rather than restating them.
4. **Interactive, but it still reads without JavaScript.** Every
   interactive element renders a meaningful static state first, as
   progressive enhancement. Mermaid covers the static diagrams.
5. **No new UI framework without a written reason.** Interactive pieces
   are Astro islands written as plain TypeScript web components. The
   site already depends on Astro, Starlight and Mermaid, and a framework
   is a dependency that needs a reason next to it.
6. **Run the real code where it is pure.** The scheduling simulator that
   item 669 rebuilt (`vx-bench/schedule-policy.ts`) calls the real
   `criticalPathPriorities`. A browser build of it shows vx's actual
   scheduler, not an illustration of one. Other pure pieces (the
   cache-key fold, glob matching, graph building) are candidates as
   long as they do not need Bun.

## The shape

A new top-level **Learn** section comes before the guides. Each page
teaches one idea, carries one interactive element and at least one
diagram, and ends with "how vx does it" and "how the others do it".

| #   | Page                                  | Teaches                                                                                                                               | Interactive                                                                                                                                                 |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W1  | What is task orchestration?           | Tasks, dependencies, the task graph, why a monorepo needs more than `npm run`                                                         | **Graph explorer**: a toy monorepo; click a package to see its task graph, and edit a file to see what `--affected` selects                                 |
| W2  | Caching, from first principles        | Content addressing, what goes into a key, why inputs and not outputs, what makes a stale hit, local vs remote                         | **Key calculator**: change an input, an env var or an upstream, and watch the key and its dependents change (the cascade)                                   |
| W3  | Correctness: can you trust the cache? | Declared inputs versus inferred inputs, the stale-hit failure class, the sandbox as proof of what a task touched                      | **Stale-hit demo**: an undeclared input edited, the wrong bytes replayed, and the sandbox violation that catches it                                         |
| W4  | Scheduling                            | Parallelism, critical path, the worker pool, why the order matters, restore tier versus exec tier                                     | **Scheduler sim**: the item 669 simulator in the browser, with workers, durations and policies (`count`, `median`, `oracle`) on one graph, as a Gantt chart |
| W5  | Architecture: a pipeline with seams   | The stages from `config` to `telemetry`, the local floor, why core names no plugin, what a seam is for                                | **Pipeline explorer**: click a stage to see the hook it exposes, which first-party plugin fills it and a ten-line plugin for it                             |
| W6  | Extending vx                          | Worked examples: a remote cache as a `CacheLayer`, remote execution through REAPI, a telemetry sink, a CLI verb, adopting Turbo or Nx | Side-by-side code with the pipeline diagram lit up at the stage each example fills                                                                          |
| W7  | vx, Turbo, Nx, Bazel: choosing        | The design choices behind each tool and what each choice buys and costs, beyond the feature table                                     | A filterable matrix: pick what matters to you and see which choices favour which tool, with the reasons and the "choose another tool if…" rows              |

Four more pieces carry the ambition past a set of pages:

| #   | Piece                                  | What it is                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | -------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| W9  | **vx in the browser (the playground)** | The real planner over a virtual workspace. The task-graph builder and the scheduler are pure TypeScript today. Key derivation needs only xxh3 and file reads. The one Bun call in the graph is `Bun.Glob`, used for output overlap. A browser build with a byte-identical xxh3 (a row proves it against `Bun.hash`) and a virtual file system lets the reader edit `vx.config.ts` and source files, run `vx run build`, and step through what hits, misses and reruns. Every Learn widget becomes a view onto this one model, not a separate mock. |
| W10 | **Labs: break it on purpose**          | Guided exercises in the playground: remove a declared input and get a stale hit; add a file the config never mentions; make two tasks write one output; order tasks badly and watch the critical path grow. Each lab ends with the vx mechanism that stops it, and whether Turbo, Nx or Bazel would.                                                                                                                                                                                                                                               |
| W11 | **Checkpoints**                        | One question per Learn page, answered by the reader and then checked against the live model. For example: "you edit `packages/ui/src/button.ts`, which tasks rerun?" No accounts and no tracking; it all runs in the page.                                                                                                                                                                                                                                                                                                                         |
| W12 | **Glossary**                           | One tool-neutral definition per term (task graph, cache key, affected, hermeticity, remote execution, seam), each with the name every tool uses for it, linked from every page.                                                                                                                                                                                                                                                                                                                                                                    |

Two more pieces change around those pages:

- **The landing page (W8)** leads with the problem and the three ideas
  (explicit inputs, a pipeline with seams, Bun-native speed), and only
  then shows the numbers.
- **The existing pages** keep their places. The guides stay under
  "Build your monorepo", and the Internals pages link from W5.

## Order and size

The work is for an agent. Each step is one or two PRs, gated like any
other change, with the site build and its link and sample laws green.

1. **W0, the skeleton (S).** The Learn section in the sidebar, stub pages,
   and the island pattern: one web component, its no-JavaScript fallback,
   and a build test that checks the fallback renders.
2. **W1 and the graph explorer (M).**
3. **W2 and the key calculator (M).** Uses the real fold if it can run in
   the browser. If it cannot, a documented model, labelled as a model.
4. **W4 and the scheduler sim (M).** Compiles `schedule-policy.ts` for
   the browser, with a row that keeps the site's copy and the bench's
   copy the same code.
5. **W5 and W6, the pipeline explorer and worked plugins (M).** Each
   worked example is a real file the site's tests type-check against
   `@vzn/vx`, so it cannot rot.
6. **W3, the correctness page (S–M).**
7. **W7, choosing a tool (M).** Written from `comparison.md` and
   `parity.md`. Every competitor claim links to that tool's own docs.
8. **W9 spike, then W9 (S spike, L build).** The spike answers two
   questions before any widget depends on it:
   - Can the planner modules be bundled for the browser behind a small
     platform shim (the file system, the glob matcher, xxh3)?
   - Do they produce keys byte-identical to the CLI's on the same
     workspace?
     If yes, W1, W2 and W4 are rebuilt as views on it. If no, they stay on
     their own models, each labelled as a model.
9. **W10, the labs, and W11, the checkpoints (M).** They need W9.
10. **W12, the glossary (S).** Can start any time.
11. **W8, the landing page (S).** Last, because it summarizes the rest.

Estimate: about four to six working days of agent work for W0–W8, and
another four to six for W9–W12, most of it the playground. It does not
block the 0.1.0 tag. It should land before the release is announced
publicly, because the announcement sends people to the site. The site's
address is still the owner's decision (roadmap 1.5).

## Done means

- Every Learn page has a diagram and an interactive element, reads
  correctly with JavaScript off, and ends with a checkpoint.
- The playground computes the same task graph and keys as the CLI on the
  same workspace, proven by a test.
- Every capability monorepo.tools names as a checkmark has a page here
  that explains its mechanism, its failure mode and its cost.
- Every number on the site comes from `benchmarks.md`, and every
  guarantee links to its test.
- Every comparison states what vx's choice costs and names at least one
  case where another tool is the better pick.
- The site build, its tests and its link checks are green in `vx run ci
--all`.
