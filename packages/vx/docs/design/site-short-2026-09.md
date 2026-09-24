# The site, short (owner, 2026-09-24)

The owner, after the Guide shipped: "The website is still terrible. It
should be short but visualizing. Maybe one diagram that has all the
examples. And we don't need 2 benches. Leave first. Focus on
extensibility, no paywall, freedom, performance, sandbox, correctness."
Asked where that applies, the owner chose the whole site. The site's
address is GitHub Pages (`vznjs.github.io/vx`), so it is no longer an
owner item.

This supersedes the ten-chapter Guide of `site-redo-2026-09.md`. The
diagram kit, its phone layouts and its laws stay. So do the playground,
the Reference and the blog.

## The shape

- **The landing is the whole story.** It has four parts, in this order:
  1. **Hero.** One line saying what vx is, the install command, and two
     buttons: Quickstart and GitHub.
  2. **The one diagram** (below), with its six numbered callouts
     explained in six short lines.
  3. **Performance.** The first benchmark only (`#bench`, "First in
     every row"). The real-repo rows (`#real`) and the scaling panel
     (`#scale`) go.
  4. **Four pillars, one card each:** correctness, the sandbox,
     extensibility, and freedom (MIT, no paywall, no cloud, no account,
     bring a Turbo or Nx repo unchanged). Each card is an icon, a title,
     one sentence of at most 15 words, and a link to its Docs page.

  A footer closes the page. The chapters list, the loop picture, the
  "one run" terminal and "Bring the repo you have" all go. "Bring the
  repo you have" is folded into the freedom card.

- **The Guide collapses into the landing.** Every `guide/*` URL
  redirects to the landing anchor of its callout. `why` goes to the
  diagram, `tasks` and `dependencies` to ①, `concurrency` to ②,
  `caching` to ③, `affected` to ④, `trust` to ⑤, `inside-vx` to ⑥,
  and `many-machines` to the extensibility card.

  The playground moves to `playground/`, as the Docs' last page, "Try
  it". The labs go, and redirect to the playground. The widgets that no
  page hosts any more (key calculator, scheduler simulator, stale hit,
  pipeline explorer, graph explorer, checkpoints) go with their rows. A
  row that holds a model to real vx and still has a page to hold stays.

- **The Docs become six pages, each at most about 400 words of prose,
  config blocks aside:**
  1. **`quickstart/`.** Install, `vx init`, a config, run. Folds in
     `add-to-existing-repo`.
  2. **`guides/configure/`.** Tasks and dependencies, caching and
     inputs, environment variables, dev (persistent) tasks, workspace
     config and lockfiles. One short section and at most one config
     block for each.
  3. **`guides/sandboxing/`.** Stays as it is (item 728).
  4. **`guides/ci/`.** Running and filtering (`--affected`), CI, the
     remote cache and remote execution.
  5. **`guides/migrate/`.** Turborepo and Nx.
  6. **`guides/plugins/`.** Writing a plugin, OpenTelemetry and
     `vx mcp`.

  Every URL that goes redirects to its new page and section. **Every
  law that reads a Docs page moves with its text.** Examples:
  - `site-samples.unsafe.test.ts`: the `WorkspaceConfig` fields and the
    OpenTelemetry options table.
  - `doc-references`.
  - The env-var table pins.
  - `build-npm.unsafe.test.ts`: install lines.

  A law is never deleted to get green.

- **The header** carries Docs, Reference, Blog and GitHub. The sidebar
  has two sections: the Docs, then the Reference. The Reference stays as
  it is: the CLI, the config reference, benchmarks, "vx, Turborepo, Nx,
  Bazel", parity, the glossary, and internals behind its index.

## The one diagram

One `Picture`, drawn by the diagram kit and named `one-run`. It carries
a phone layout that says the same thing (the kit's laws hold it). It
shows the toy monorepo's build after you edit `app`:

- **① Tasks and dependencies.** Four boxes: `utils#build`, `ui#build`,
  `api#build`, `app#build`. Arrows run `utils → ui`, `utils → api`,
  `ui → app` and `api → app`, meaning "is used by".
- **② Parallel.** `ui#build` and `api#build` sit inside a dashed frame
  titled "at once".
- **③ Cache.** `utils#build`, `ui#build` and `api#build` are in the ok
  tone, each with the sub line "from cache".
- **④ Only what changed.** `app#build` is in the accent tone, with the
  sub line "you edited app". A note beside it reads "✎ runs".
- **⑤ Sandbox.** A link-tone frame titled "sandbox" surrounds
  `app#build`. A danger arrow labelled "✕ denied" leaves it for a muted
  box outside the frame, `../secrets.env`.
- **⑥ Plugins.** Along the foot runs a strip of the run's stages
  (`graph · key · schedule · run · cache · telemetry`). Two
  plugin boxes hang on it, `remote cache` and `OpenTelemetry`, with a
  note: "yours plugs in the same way".

Each number sits as a note beside the part it names. Under the drawing,
six lines, one per callout, each a bold term and at most eight words:

1. **Tasks.** `app` builds after what it uses.
2. **Parallel.** `ui` and `api` build at once.
3. **Cache.** Unchanged work comes back from the cache.
4. **Only what changed.** You edited `app`; only `app` runs.
5. **Sandbox.** A read you did not declare fails the task.
6. **Plugins.** Swap the cache, runner or telemetry. No fork.

Each line's anchor (`#tasks`, `#parallel`, `#cache`, `#changed`,
`#sandbox`, `#plugins`) is where the old chapters redirect.

## Laws

- **`landing.test.ts`** holds this section order: hero, diagram,
  `#bench`, pillars. It holds the six callouts, as the picture's data
  and the six lines. It holds exactly one benchmark section, and the
  pillars' four titles in order: correctness, sandbox, extensibility,
  freedom. `check.site` and `update-site.ts` stop writing `#real` and
  `#scale`.
- **`diagram-kit.test.ts`** holds `one-run` and its phone layout.
- **`sidebar.test.ts`** holds the two sections.
- **`redirects.test.ts`** holds that every URL the old sidebar or the
  Guide had still resolves.
- **`site-links.test.ts`** holds that every link lands.
