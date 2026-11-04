# Task runner conformance

75 cases, each a small workspace and the outcome a user sees: which commands ran, the files left on disk, the exit code. Every tool runs sandboxed. A tool that cannot express a case scores it `–` and it leaves its percentage.

| | vx this commit | turbo 2.11.10 | nx 24.0.2 | vite-task 1.4.0 |
|---|---|---|---|---|
| **all** | 99% (74/75) | 89% (67/75) | 85% (64/75) | 82% (56/68) |
| correctness | 100% (60/60) | 90% (54/60) | 82% (49/60) | 84% (46/55) |
| efficiency | 100% (14/14) | 86% (12/14) | 100% (14/14) | 75% (9/12) |
| graph | 100% (10/10) | 90% (9/10) | 100% (10/10) | 90% (9/10) |
| inputs | 100% (23/23) | 83% (19/23) | 87% (20/23) | 74% (17/23) |
| outputs | 100% (15/15) | 80% (12/15) | 73% (11/15) | 73% (11/15) |
| env | 100% (6/6) | 100% (6/6) | 83% (5/6) | 100% (6/6) |
| cache | 100% (5/5) | 100% (5/5) | 100% (5/5) | 80% (4/5) |
| logs | 0% (0/1) | 100% (1/1) | 100% (1/1) | 100% (1/1) |
| failure | 100% (8/8) | 100% (8/8) | 88% (7/8) | 100% (8/8) |
| affected | 100% (7/7) | 100% (7/7) | 71% (5/7) | – |

## Where the cases come from

Each case is drawn from vx's own tests. Of the 1147 test files in this repo:

- 79 are carried by a case;
- 106 are pending: guards an outcome any task runner shows: a case can carry it.
- 599 are vx-only: guards a vx capability the others lack (sandbox, lock, DTE, history, plugins, servers, vx-only verbs).
- 287 are internal: tests vx code directly, or vx’s own wording and layout, not an outcome.
- 76 are docs: holds docs, the site, releases or the repo to the code.

## Where they differ (25)

### `^build` reaches a dependency’s dependency when the middle project has no build

`graph/transitive-through-taskless` · correctness · app reads lib’s output through mid; skipping lib leaves app reading nothing.

- ✓ **vx**
- ✗ **turbo**: step 1, exited 1, expected success
- ✓ **nx**
- ✗ **vite-task**: step 1, exited 1, expected success

### A gitignored file under an input glob changes nothing

`inputs/gitignored-not-input` · efficiency · Ignored files are local state (logs, caches); keying on them makes every machine miss.

- ✓ **vx**
- ✗ **turbo**: step 5, ran a#build, expected it replayed or left out
- ✓ **nx**
- ✗ **vite-task**: step 5, ran a#build, expected it replayed or left out

### Making an input executable runs the task again

`inputs/executable-bit` · correctness · The mode is part of what the task reads: a build that copies a script ships it runnable or not.

- ✓ **vx**
- ✗ **turbo**: step 3, packages/a/dist/out.txt is "plain\n", expected "exec\n"
- ✗ **nx**: step 3, packages/a/dist/out.txt is "plain\n", expected "exec\n"
- ✗ **vite-task**: step 3, packages/a/dist/out.txt is "plain\n", expected "exec\n"

### Editing a dependency rebuilds the projects that read its output

`inputs/dependency-edit-cascades` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- ✗ **vite-task**: step 3, did not run ui#build, app#build

### Editing one project does not rerun a project that does not depend on it

`inputs/sibling-untouched` · efficiency

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- ✗ **vite-task**: step 3, did not run app#build

### A project nested inside another keeps its files out of the outer project’s inputs

`inputs/nested-project-excluded` · efficiency

- ✓ **vx**
- ✗ **turbo**: step 3, ran outer#build, expected it replayed or left out
- ✓ **nx**
- ✗ **vite-task**: step 3, ran outer#build, expected it replayed or left out

### Pointing an input symlink at another file runs the task again

`inputs/symlink-retarget` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- ✗ **vite-task**: step 4, packages/a/dist/out.txt is "a\n1\n", expected "a\n2\n"

### A task that lists no inputs never replays a stale result when a file it reads changes

`inputs/unlisted-file-never-stale` · correctness · A default guesses what the task reads; a file outside the guess changes and the cache replays the old bytes.

- ✓ **vx**
- ✗ **turbo**: step 3, packages/a/dist/out.txt is "one\n", expected "two\n"
- ✗ **nx**: step 3, packages/a/dist/out.txt is "one\n", expected "two\n"
- ✓ **vite-task**

### A task that lists no inputs never replays a stale result when a variable it reads changes

`inputs/unlisted-env-never-stale` · correctness · A cache keyed on files alone replays the output of a value the command no longer sees.

- ✓ **vx**
- ✓ **turbo**
- ✗ **nx**: step 2, packages/a/dist/out.txt is "dev\n", a stale result
- ✓ **vite-task**

### A rebuild leaves no output the new inputs no longer produce

`outputs/stale-output-removed-on-rebuild` · correctness · A file a renamed source used to produce would otherwise ship from dist forever.

- ✓ **vx**
- ✗ **turbo**: step 3, packages/a/dist/old.txt exists, expected none
- ✗ **nx**: step 3, packages/a/dist/old.txt exists, expected none
- ✗ **vite-task**: step 3, packages/a/dist/old.txt exists, expected none

### Restoring an older entry leaves no file a later build added

`outputs/stale-output-removed-on-restore` · correctness · The restored tree must be the one that entry’s inputs produce.

- ✓ **vx**
- ✗ **turbo**: step 5, packages/a/dist/b.txt exists, expected none
- ✗ **nx**: step 5, packages/a/dist/b.txt exists, expected none
- ✗ **vite-task**: step 5, packages/a/dist/b.txt exists, expected none

### A stray file dropped in an output directory is gone after a restore

`outputs/stray-file-removed-on-restore` · correctness · Outputs are what the task wrote; a leftover file in dist ships in the package.

- ✓ **vx**
- ✗ **turbo**: step 3, packages/a/dist/stray.txt exists, expected none
- ✗ **nx**: step 3, packages/a/dist/stray.txt exists, expected none
- ✗ **vite-task**: step 3, packages/a/dist/stray.txt exists, expected none

### A symlink output comes back as the same link

`outputs/symlink-restored` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- ✗ **vite-task**: step 4, packages/a/dist/latest.txt is missing

### A replayed task that lists no outputs leaves a file it wrote, and the user then edited, alone

`outputs/unlisted-not-clobbered` · correctness · A default guesses what the task writes; restoring a file nobody declared overwrites the user’s bytes with an old copy.

- ✓ **vx**
- ✓ **turbo**
- ✗ **nx**: step 3, a#build replayed and left packages/a/dist/report.txt "report\n", expected "mine\n"
- ✓ **vite-task**

### An unset variable and an empty one are different values

`env/unset-vs-empty` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✗ **nx**: step 2, packages/a/dist/out.txt is "unset\n", expected "\n"
- ✓ **vite-task**

### A replayed task shows the output its run printed

`logs/replay-shows-log` · output

- ✗ **vx**: step 2, output lacks "printed-by-build"
- ✓ **turbo**
- ✓ **nx**
- ✓ **vite-task**

### Changing a dependency’s command rebuilds the projects that read its output

`cache/dependency-command-change-cascades` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- ✗ **vite-task**: step 3, did not run ui#build, app#build

### Asking for a task no project declares fails the run

`failure/missing-task-in-filter` · correctness · A typo that exits 0 lets CI pass having checked nothing.

- ✓ **vx**
- ✓ **turbo**
- ✗ **nx**: step 1, succeeded, expected a failure
- ✓ **vite-task**

### A committed change selects its project and every project that depends on it

`affected/change-reaches-dependents` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✗ **nx**: step 3, did not run app#test
- – **vite-task**: needs affected

### A change in a project nothing depends on selects only that project

`affected/leaf-change-stays-put` · efficiency

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- – **vite-task**: needs affected

### With nothing changed, an affected run runs nothing and succeeds

`affected/nothing-changed` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- – **vite-task**: needs affected

### An uncommitted edit counts as a change

`affected/uncommitted-change` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- – **vite-task**: needs affected

### A new file git does not track yet counts as a change

`affected/untracked-file` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- – **vite-task**: needs affected

### A deleted file counts as a change to its project

`affected/deleted-file` · correctness

- ✓ **vx**
- ✓ **turbo**
- ✗ **nx**: step 3, did not run app#test
- – **vite-task**: needs affected

### A change to a root file no task reads selects nothing

`affected/root-file-reaches-nobody` · efficiency

- ✓ **vx**
- ✓ **turbo**
- ✓ **nx**
- – **vite-task**: needs affected

## Where they agree (50)

- `^build` builds every dependency before the project that needs it (`graph/deps-first`)
- Running one project's task runs what it depends on, and nothing else (`graph/one-project-pulls-its-deps`)
- A bare name in dependsOn waits on the same project’s task (`graph/same-project-dependency`)
- `lib#build` in dependsOn runs that task first, with no package dependency (`graph/explicit-task-edge`)
- A dependency two projects share builds once per run (`graph/diamond-runs-once`)
- Running a library’s task does not run the projects that depend on it (`graph/dependents-not-pulled`)
- A task only some projects declare runs in exactly those (`graph/task-in-some-projects`)
- A project whose directory holds spaces builds, caches and restores (`graph/project-dir-with-spaces`)
- A task named `test:unit` runs as its own task (`graph/task-name-with-colon`)
- A second run over an unchanged tree replays instead of running (`inputs/unchanged-replays`)
- Editing an input runs the task again (`inputs/edit`)
- A same-size edit right after a commit runs the task again (`inputs/same-size-edit`)
- A new file under an input glob runs the task again (`inputs/new-file`)
- Deleting an input runs the task again (`inputs/deleted-file`)
- Renaming an input runs the task again (`inputs/renamed-file`)
- An edit deep in a nested input directory runs the task again (`inputs/nested-dir`)
- An edit to an input named with spaces, `$` and quotes runs the task again (`inputs/odd-file-name`)
- An edit to an input with a non-ASCII name runs the task again (`inputs/unicode-file-name`)
- Undoing an edit replays the first run’s outputs, not the edited ones (`inputs/revert-replays-old`)
- A file outside the task’s inputs changes nothing (`inputs/outside-inputs-ignored`)
- A file a `!` input pattern takes back changes nothing (`inputs/negated-glob`)
- A new file git does not track yet is an input (`inputs/untracked-file`)
- An edit to a file outside a dependency’s build inputs does not rebuild its dependents (`inputs/dependency-non-input-edit`)
- A task that lists no inputs runs again when its project’s sources change (`inputs/default-inputs-edit`)
- Deleted outputs come back from the cache with the same bytes (`outputs/restored-on-hit`)
- Deleted outputs are restored, not rebuilt (`outputs/restored-on-hit-without-rerun`)
- An output edited by hand is put back on the next run (`outputs/edited-output-restored`)
- Only declared outputs are restored (`outputs/undeclared-not-restored`)
- A `!` output pattern keeps that file out of the cache (`outputs/negated-output`)
- An executable output comes back executable (`outputs/executable-bit-restored`)
- Nested output directories and binary bytes restore intact (`outputs/nested-and-binary`)
- A dependency’s deleted outputs are back before a rebuilding dependent reads them (`outputs/dependency-restored-for-dependent`)
- Two projects with the same command and the same sources keep their own outputs (`outputs/same-command-two-projects`)
- A replayed task that lists no outputs does not bring back a file the user deleted (`outputs/unlisted-not-conjured`)
- A declared variable reaches the command (`env/declared-reaches-task`)
- Changing a declared variable runs the task again (`env/declared-change-reruns`)
- Going back to an earlier value restores that value’s outputs (`env/back-to-old-value`)
- `MODE` and `mode` are different variables (`env/name-case-sensitive`)
- A variable the task does not declare changes nothing (`env/undeclared-change-ignored`)
- A task with caching off runs on every run (`cache/uncached-runs-every-time`)
- Changing a task’s command runs it again (`cache/command-change-reruns`)
- Declaring a new output runs the task again so the cache holds it (`cache/outputs-change-rekeys`)
- Committing a change keeps the entry the uncommitted run saved (`cache/survives-checkout-copy`)
- A task that exits non-zero fails the run (`failure/exit-code-fails-run`)
- A failed task is not replayed as a success next time (`failure/never-cached`)
- A failed dependency stops the projects that need it from running (`failure/dependents-skipped`)
- Fixing a failed task’s input makes the next run pass and build (`failure/fixed-then-passes`)
- A task killed by a signal fails the run and is not cached (`failure/killed-by-signal`)
- A task that writes to stderr and exits 0 succeeds (`failure/stderr-is-not-failure`)
- Tasks that depend on each other in a cycle fail the run before any runs (`failure/task-cycle-refused`)
