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
8. **W8, the landing page (S).** Last, because it summarizes the rest.

Estimate: about four to six working days of agent work. It does not
block the 0.1.0 tag. It should land before the release is announced
publicly, because the announcement sends people to the site. The site's
address is still the owner's decision (roadmap 1.5).

## Done means

- Every Learn page has a diagram and an interactive element, and reads
  correctly with JavaScript off.
- Every number on the site comes from `benchmarks.md`, and every
  guarantee links to its test.
- Every comparison states what vx's choice costs and names at least one
  case where another tool is the better pick.
- The site build, its tests and its link checks are green in `vx run ci
--all`.
