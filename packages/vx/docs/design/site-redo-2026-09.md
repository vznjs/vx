# The site, redone as one story (2026-09-24, owner)

The owner's verdict on the site after track W: "Website is very bad. I
told you to redo it, not add sections. It should tell a coherent story
and teach about tasks, dependencies, sandbox, caching, concurrency, and
other concepts to understand why you need task orchestration."

He is right, and this page says why and what replaces it. It supersedes
the structure of `site-teaches-2026-09.md`. The widgets that plan built
stay, because they work and are held to the CLI. The pages around them go.

## What is wrong

- **There is no story.** The sidebar has eight groups and about 45
  links. The Learn section is one of them, and ten Learn pages sit above
  forty how-to, concept, reference and internals pages. Caching alone
  has four homes: `learn/caching`, `guides/caching`,
  `guides/trusting-the-cache` and `caching/`. A reader who does not
  already know what a task runner is has no first page and no next page.
- **Pages are reference text, not lessons.** Each Learn page defines,
  then tours vx, then adds a "How Turborepo, Nx and Bazel do it"
  section. The comparison interrupts the teaching on every page. Nothing
  carries the reader from one idea to the next.
- **Two products.** The landing is dark with lime and cyan, and the docs
  are stock Starlight purple. The reader crosses into a different site
  on the first click.
- **Internals are in the reader's path.** `modules/` (about 80 pages),
  `design/` (about 60 pages), `overview`, `architecture`,
  `optimizations`, `patterns` and `flows` all sit in the sidebar.
- **Some diagrams fail.** Mermaid renders on the client, so a slow or
  scripted load shows raw `graph LR` source, or an empty box.

## The story

One book, **The Guide**, read in order. Each chapter opens with the
problem the previous chapter left, teaches one idea with the same small
monorepo, and ends by naming the next problem. The concepts come first.
Each chapter's last section, **"In vx"**, shows the one config line or
command the idea becomes. There is no competitor tour inside a chapter.

**The running example** is the toy monorepo the widgets already use
(`components/demos/model/toy-monorepo.ts`). `utils` holds shared
helpers, `ui` and `api` use `utils`, and `app` uses both. Every chapter
talks about these four packages and nothing else.

| #   | Chapter (URL under `guide/`)    | The problem it opens with                                                                      | What it teaches                                                                                                                                                                                            | Widget (existing)           |
| --- | ------------------------------- | ---------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| 1   | `why/`: Why orchestrate?        | Four packages, one `build` script each; you write a shell loop                                 | What a monorepo is; the loop's three failures: wrong order, everything rebuilt, one at a time. The rest of the book fixes them.                                                                            | none (one static diagram)   |
| 2   | `tasks/`: Tasks                 | The loop runs "scripts"; what exactly is one unit of work?                                     | A task: one command, in one package, that reads inputs and writes outputs. Why one command per task (so each can be ordered, skipped, cached). `package#task` names.                                       | none                        |
| 3   | `dependencies/`: Dependencies   | `app#build` ran before `ui#build` and failed                                                   | A dependency between tasks; `^build` versus same-package; the task graph; waves; why a cycle has no order.                                                                                                 | GraphExplorer               |
| 4   | `concurrency/`: Concurrency     | The graph is right but the run takes as long as the loop                                       | Independent tasks run at once; workers; the critical path; why the choice of which ready task starts first changes the finish time.                                                                        | SchedulerSim                |
| 5   | `caching/`: Caching             | You changed one line in `app`; `utils` rebuilt anyway                                          | A result that depends only on its inputs can be reused. The key (a hash of inputs, command, env); a hit restores outputs; why a key folds its dependencies' keys (the cascade).                            | KeyCalculator               |
| 6   | `trust/`: Can you trust a hit?  | A hit replayed an old output and the run was green                                             | The stale hit; the undeclared input (a file, an env var, a tool version); declared versus inferred inputs; the sandbox, which runs a task with only its declared files so an undeclared read fails loudly. | StaleHit                    |
| 7   | `affected/`: Only what changed  | CI builds all four packages for a README edit                                                  | From a changed file to the packages it touches, then to their dependents; `--affected`; what a change cannot be traced to (a root file no input names).                                                    | GraphExplorer (change mode) |
| 8   | `many-machines/`: Many machines | Your laptop and CI build the same thing twice                                                  | A shared remote cache (and why only trusted writers push); remote execution, where the worker holds only the declared inputs; what each costs.                                                             | none (one static diagram)   |
| 9   | `inside-vx/`: How vx is built   | You now know the ideas; how does one tool hold them without growing a branch for every vendor? | The pipeline (config, project, graph, key, schedule, executor, cache, telemetry) with a seam at each stage; the local floor; a plugin in 20 lines.                                                         | PipelineExplorer            |
| 10  | `try-it/`: Try it               | —                                                                                              | The playground on the same four packages: edit a file, the env or a config and read which tasks run and why. Then the labs, then the quickstart.                                                           | Playground, labs            |

Chapters 1–9 run 800 to 1,500 words each. Every chapter has exactly one
diagram or widget that carries its idea, and a two-question check at the
end (the existing Checkpoint component where the planner can answer, a
static `<details>` where it cannot).

**What moves out of the chapters:** "Choosing a tool" (the current
`learn/choosing`) becomes one page after the Guide, **"vx, Turborepo,
Nx, Bazel"**. The glossary stays as a reference page. The sandbox,
caching and env how-to material stays in the Docs.

## The site around the story

The top navigation has four places: **Guide**, **Docs**, **Reference**,
**Blog**.

- **Guide** is the ten chapters above, in a sidebar of their own, with
  nothing else in it.
- **Docs** is how to use vx, one page per job:
  - Get started: quickstart, adding vx to a repo, migrating from
    Turborepo, migrating from Nx.
  - Configure: tasks and dependencies, caching and inputs, environment
    variables, the sandbox, dev tasks, lockfiles.
  - Run: running and filtering, CI, the remote cache, remote execution.
  - Extend: writing a plugin, OpenTelemetry, `vx mcp`.

  Pages that say the same thing merge. `guides/caching`,
  `guides/trusting-the-cache` and the "Caching deep dive" become one
  caching page plus the reference; `concepts/how-vx-works` folds into
  chapter 9. "Why vx is fast" goes to Reference.

- **Reference** is the CLI, configuration, benchmarks, "vx, Turborepo,
  Nx, Bazel", the parity map and the glossary.
- **Internals** (`modules/`, `design/`, `overview`, `architecture`,
  `optimizations`, `patterns`, `flows`) leave the sidebar. The pages
  still build, because the repo's laws link them. The Reference sidebar
  ends with one link, "Internals (for contributors)", to an index page.

Every old URL that moves gets a redirect (Astro's `redirects`), so
external links and the blog keep working. The site-wide link check
(item 711) holds the result.

## One look

Starlight takes the landing's palette and type, so the site is one
product.

- Dark by default, with a light theme that works.
- Lime accent `--vx-accent`, cyan links, the landing's font stack.
- The chapter layout: the chapter number and title, the question it
  answers, then the prose at a readable measure (about 68ch), and at the
  foot a "Next: <the next chapter's question>" card instead of Starlight's
  plain prev/next.
- **Diagrams are build-time SVG, never client Mermaid.** A small set of
  Astro components (box, arrow, graph-of-tasks, timeline) draws each
  chapter's picture into the HTML. Mermaid stays only on internals pages.

## The landing

The landing is the story's cover, not a second story.

- **The hero:** the question every monorepo reaches ("Four packages.
  One build. Why is it slow, and why is it wrong?"), a picture of the
  shell loop failing in the three ways chapter 1 names, and one primary
  action: "Read the guide". Quickstart is second.
- **Below the hero:** the ten chapters as a table of contents, one line
  each (the problem, then the idea).
- **Then:**
  - the numbers (the generator's anchors unchanged);
  - "Bring the repo you have" (`turbo()` and `nx()`);
  - "Open, all of it".
- **What goes:** the three idea sections of item 709, because the
  chapters now teach them.

## What survives, and what the tests become

- **Widgets survive:** the graph explorer, the key calculator, the
  scheduler simulator, the stale-hit demo, the pipeline explorer, the
  playground, the labs and the checkpoints. So do their models and the
  rows that hold them to the CLI. Only their host page changes.
- **`learn-*.test.ts` rows move with their widgets.** Rows about the old
  pages' prose (section orders, "how the others do it" sentences,
  competitor source links on teaching pages) go with that prose; the
  choosing page's rows move to the "vx, Turborepo, Nx, Bazel" page.
- **New laws:**
  - `guide.test.ts` holds the chapter order. Each chapter opens with its
    problem, ends with a "Next" card naming the next chapter, uses only
    the four toy packages, and carries exactly one teaching widget or
    SVG. No chapter mentions Turborepo, Nx or Bazel outside "In vx" and
    the check.
  - `sidebar.test.ts` holds the three sidebars and that no internals
    page is in them.
  - `redirects.test.ts` holds that every URL the old sidebar linked
    still resolves, as a page or a redirect.
- **The site-wide link check** (item 711) and the landing's figure rows
  (item 712) stay.

## Order of work

1. **R1, skeleton (one implementer).**
   - The top nav and the three sidebars; internals out.
   - The redirects.
   - The theme unified; the chapter layout and the Next card; the SVG
     diagram kit.
   - Ten chapter stubs, each carrying its problem sentence and its Next
     card.
   - The laws above, over the stubs.
2. **R2, chapters (three implementers in parallel, after R1):**
   - 1–3 (why, tasks, dependencies);
   - 4–6 (concurrency, caching, trust);
   - 7–10 (affected, many machines, inside vx, try it).

   Each rewrites from the old Learn pages' substance, not their text.
   The architect edits every chapter for voice and continuity before it
   merges.

3. **R3, docs consolidation and the landing (two implementers,
   parallel with R2).**
   - Merge the duplicate how-to pages; move the rows.
   - The landing as the cover.
4. **R4, the old Learn pages go,** with redirects to their chapters, and
   the site plan's "Done means" is rewritten for the Guide.

## Voice

- **Second person, present tense, short paragraphs.** Say the problem
  before the mechanism.
- **Anchor every term.** A term is defined the first time it is used and
  linked to the glossary.
- **No claim without its test.** "vx refuses a cycle" links the row that
  holds it, as today.
- **No bullet walls in the Guide.** A list is for steps and choices, not
  for explanations.
