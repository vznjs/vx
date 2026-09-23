# Roadmap to 1.0 (2026-09-23)

The question this answers: **when is vx feature complete, and what is left
before a 1.0?** Before this page the repo had no definition of either. The
only "done" it stated was `plan-2026-09-22.md`'s "an empty Next list with a
green main and a shipped release", and the README says "Pre-alpha" with no
back-compat.

This page defines both as checkable criteria, lists what stands between
here and each, and says who unblocks what. STATUS.md stays the living
handoff. When a milestone item lands, strike it here in the same commit.

## Where we stand

- **Features.** By the repo's own ledger the feature set is nearly
  closed. The STATUS "Next" list has two open items, and both are "wait
  for a demand signal" (the whole-graph remote run and the streaming
  remote seam). The Turbo and Nx parity tables have no open gap rows
  except one (automatic cache eviction). Everything else there is a
  deliberate difference or an owner-declared out-of-scope item.
- **Work since 2026-09-21 is hardening, not features.** Items 633–654
  are mutation sweeps. Each deletes a guard or duty line in turn and
  proves some test catches it. They raise confidence in existing
  behaviour and add no capability, so they are not on the path to
  feature complete. They are on the path to 1.0 stability (milestone 3).
- **Distribution is the largest real gap.** Only `@vzn/vx` is on npm
  (latest 0.0.21, tag `v0.0.21`). None of the seven plugin packages are
  published: `vx-migrate`, `vx-reapi`, `vx-otel`, `vx-github`, `vx-mcp`,
  `vx-lockfile` and `vx-schedule-history` all return npm 404. The publish
  workflow (`.github/workflows/npm.yml`) ships only the core and its
  platform binaries. Yet the docs call the plugins published and tell
  users to run `bunx @vzn/vx-migrate`, which is the adoption entry
  point. The 0.1.0 release notes are drafted
  (`history/release-0.1.0-notes.md`) but the release is not cut.

## Milestone 0 — close the hardening arc (in flight)

Finish what is running, then stop the sweep loop as the default work.

- 651 plugin host (coordinator), 652 sandbox, 653 workspace config, 654
  telemetry (parallel implementer sessions, one PR each, coordinator
  merges).
- The STATUS trim that follows them (651–654 into `history/`).
- **Exit:** those merged. From then on a sweep runs only against code a
  later item changes, not as the loop's default.

## Milestone 1 — 0.1.0: vx is installable end to end

Nothing new is built here. What exists becomes something a user can
install.

| #   | Item                                                                                                                                                                                                                                                                                                                                                                                        | Who       | Size |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | ---- |
| 1.1 | ~~Publish the plugin packages.~~ DONE in item 656: `build-npm.ts --only=plugins` emits every public package and `npm.yml` publishes them after `@vzn/vx`. Owner: add the seven trusted publishers (`cli.md` § Releasing). Extend `npm.yml` to publish the seven plugins with provenance, at the core's version, core first. Add a law that every non-private package is in the publish set. | agent     | S    |
| 1.2 | ~~Make the docs match.~~ DONE in item 668: `build-npm.unsafe.test.ts` holds every `@vzn/…` a page tells a user to install, run or import to the emitter's publish set. Every "published" or `bunx @vzn/…` line is true on the day of the release, pinned by a test that reads the publish list.                                                                                             | agent     | S    |
| 1.3 | ~~Refresh the 0.1.0 notes with items 624–654.~~ DONE through 672 (items 657, 673); 652–654 are added when they merge, and the PR count is recounted at the cut.                                                                                                                                                                                                                             | agent     | S    |
| 1.4 | Cut 0.1.0 (tag and workflow run).                                                                                                                                                                                                                                                                                                                                                           | **owner** | —    |
| 1.5 | Delete the `NPM_TOKEN` secret, since publishing uses OIDC. Decide the site's address. Optionally enable private vulnerability reporting.                                                                                                                                                                                                                                                    | **owner** | —    |

**Exit:** `bunx @vzn/vx-migrate` and `bun add -d @vzn/vx @vzn/vx-lockfile`
work from the public registry, and a fresh workspace follows the README
with no step that 404s.

## Milestone 2 — feature complete (scope freeze)

**Definition.** vx is feature complete when all of the following hold:

- Every capability in the "Out of scope" list (`comparison.md`) is
  confirmed as out of scope.
- Every other row in `parity.md` and `comparison.md` is either matched
  or a written, deliberate difference.
- No seam is still expected to change shape.

After that, new work is a fix, a performance change or a plugin, never
a core feature.

| #   | Item                                                                                                                                                                                                                                                                                                                      | Why it is in                                                                                                                                                                                    | Size                                          |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 2.1 | ~~**Automatic cache eviction during a run.**~~ DONE in item 658: `cacheRetention: { olderThan, maxSize }` in `vx.workspace.ts`, applied at run end when something is due.                                                                                                                                                 | The one open parity row.                                                                                                                                                                        | M                                             |
| 2.2 | ~~**Streaming remote seam (D2).**~~ DONE in item 662: 150 MiB round trip +495 → +45 MiB peak RSS. `RemoteCacheLayer.get/put` stream a `Blob` or `ReadableStream` instead of a whole buffer. `vx-reapi` gets a streaming digest and chunked upload.                                                                        | It is a breaking change to the plugin API. Deferred "until a workspace uploads > 100 MiB", but a seam that will change cannot be frozen. It must land before milestone 3, demand signal or not. | L                                             |
| 2.3 | ~~**Close the stale parity ledgers.**~~ Audited in item 659 (`parity-audit-2026-09.md`): of 114 rows, 65 FIXED, 28 DECLINED, 4 OBSOLETE, 17 OPEN. Nx H7 is obsolete; Nx L2 is open. All 17 open rows closed by item 670 (items 661, 664–667, 669, 670); DONE.                                                             | "Parity complete" has to be a checkable claim, not a memory.                                                                                                                                    | S–M                                           |
| 2.4 | **Confirm the scope list.** Record the out-of-scope set as final: daemon, JS-function tasks, generators, TUI, non-JS projects, native Windows (WSL only), inferred inputs, graph UI, `nx release`, workspace env, Nx configurations in the native schema, and boundaries. Anything the owner moves in becomes a 2.x item. | Without it "feature complete" has no edge.                                                                                                                                                      | **owner**, S                                  |
| 2.5 | **Real-repo re-measure.** Refine or router (Nx), astro (Turbo), with `node_modules` present. Warm, cold and restore against the published numbers.                                                                                                                                                                        | The perf claim is the first decision driver, and the last real-repo numbers predate items 615–630.                                                                                              | M, needs a box with `node_modules` and yarn 4 |

**Exit:** 2.1–2.5 done, `parity.md` and `comparison.md` show no open
row, and the STATUS "Next" list holds nothing but milestone 3.

## Track W — the site teaches (owner, 2026-09-23)

The owner asked for a site that explains what task orchestration is, with
interactive examples and diagrams. It should show where vx is stronger:
its performance, and also its architecture, its correctness guarantees
and how far it can be extended. In the owner's words, "educate not only
sell". The plan is `design/site-teaches-2026-09.md`.

| #   | Item                                                                                           | Size |
| --- | ---------------------------------------------------------------------------------------------- | ---- |
| W0  | A Learn section, stub pages, and the interactive-island pattern with a no-JavaScript fallback. | S    |
| W1  | What task orchestration is, with a graph explorer.                                             | M    |
| W2  | Caching from first principles, with a key calculator.                                          | M    |
| W3  | Correctness: trusting the cache, with a stale-hit demo.                                        | S–M  |
| W4  | Scheduling, with the item 669 simulator running in the browser.                                | M    |
| W5  | The architecture as a pipeline with seams, with a pipeline explorer.                           | M    |
| W6  | Extending vx: worked plugins that the site's tests type-check.                                 | M    |
| W7  | Choosing between vx, Turbo, Nx and Bazel: design choices and their costs, not a feature table. | M    |
| W8  | A landing page that leads with the problem and the ideas, then the numbers.                    | S    |

**Exit:** every Learn page has a diagram and an interactive element and
reads with JavaScript off. Every number comes from `benchmarks.md`,
every guarantee links to its test, and every comparison names what vx's
choice costs. The track does not block the 0.1.0 tag, but it lands
before the release is announced.

## Milestone 3 — 1.0: the contract

Feature complete says nothing will be added. 1.0 says what will not
break.

| #   | Item                                                                                                                                                                                                                                                                                                                                                             | Size        |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- |
| 3.1 | **Freeze the config schema.** Policy written in item 672 (`versioning-1.0.md`); takes effect at 1.0. `config-schema.ts` becomes the 1.0 schema. Later changes are additive, or deprecated for one minor before removal, with the refusal message naming the replacement.                                                                                         | M           |
| 3.2 | **Freeze the plugin API.** Policy written in item 672 (`versioning-1.0.md`); takes effect at 1.0. The 13 hooks in `PLUGIN_HOOKS`, the `CacheLayer`, `TaskExecutor` and telemetry record shapes, and the façade export list (already snapshot-pinned). Same deprecation rule.                                                                                     | M           |
| 3.3 | ~~**Cache compatibility policy.**~~ DONE in item 671: the first open after a `CACHE_VERSION` bump prints `cache format changed: vA → vB`. A `CACHE_VERSION` bump stays allowed, since a stale hit is worse than a cold run. It becomes a documented, announced event (release notes plus a one-line notice on the first run after upgrade), never a silent wipe. | S           |
| 3.4 | ~~**Semver and support statement.**~~ DONE in item 672: `versioning-1.0.md`; the README points to it at 1.0. What a minor or patch may change, the Bun floor policy, supported platforms (Linux and macOS, Windows via WSL), and the README maturity table moved from "Pre-alpha".                                                                               | S           |
| 3.5 | **Soak.** Run 0.x on real repos (vx itself, one Turbo repo and one Nx repo, through the adoption plugins) for a period the owner chooses, with no correctness regression before 1.0 is tagged.                                                                                                                                                                   | owner-timed |

**Exit:** 3.1–3.4 merged and the soak clean. The owner tags 1.0.

## When

Estimates assume the current pace, which is about 15–20 merged items on
a good day, with this session coordinating and up to three implementer
sessions. They are working-day estimates for agent work only. Owner
actions and the soak are on the owner's clock.

| Milestone           | Agent work                     | Blocked on                                          |
| ------------------- | ------------------------------ | --------------------------------------------------- |
| 0 hardening arc     | ≈ ½ day (in flight)            | nothing                                             |
| 1 installable 0.1.0 | ≈ 1 day                        | owner cuts the release and decides the site address |
| 2 feature complete  | ≈ 3–5 days (2.2 is most of it) | owner confirms scope (2.4); a box for 2.5           |
| W the site teaches  | ≈ 4–6 days                     | nothing (the site address is 1.5)                   |
| 3 1.0 contract      | ≈ 2–3 days, plus the soak      | owner sets the soak length and tags                 |

So **feature complete is milestone 2**. It is about a week of agent work
after 0.1.0 ships, provided the owner answers 2.4 and a box with
`node_modules` is available for 2.5.

## Decisions this roadmap takes, and those it leaves to the owner

- **Taken (architecture, coordinator):**
  - The streaming seam lands before 1.0 (2.2), because freezing a seam
    known to change would be the first breaking change of 1.1.
  - The sweep loop stops being the default after milestone 0.
  - The plugins publish at the core's version, as one release train.
- **Left to the owner:**
  - Cutting 0.1.0.
  - The site's address.
  - The final scope list (2.4).
  - The soak length and the 1.0 tag.
