# Run explorer (2026-10)

Status: parked. Owner call M 2026-10-14 21:41 (via EA): spec only, nothing
scheduled.

## Goal

Replace the CI provider's artifacts view (e.g. GitLab artifacts) with a vx
run view. Every CI run gets an id. Everything a run produced (outputs and
logs of every task, passed or failed, cached or not) is reachable from the
cache by that id, and a local explorer opens it on demand. There is no VZN
service: the store is the user's own cache, read with the user's own token.

## Principles

- **Core only stores; a plugin does the rest.** Core exposes facts; the
  plugin uploads, writes the manifest and serves the explorer. This keeps
  the rule against a first-party dashboard: the explorer is local and
  opt-in.
- **The cache is immutable.** Every entry is written once (`put` never
  overwrites, M 2026-10-14).
- **The cache is trusted,** like CI artifacts. Log content is not filtered
  (M 21:37).
- **A run record never becomes a cache hit.** Only task keys are hits. Log
  and manifest keys are never task keys.

## Flow

1. **Run id.** Core gives each run an id (today `run_id` in run history)
   and exposes it to plugins in the run context, with the CI facts it
   already detects: provider, pipeline id, job id, commit and branch.
2. **Per task, at completion:**
   - **Passed, cached task:** outputs and logs already live under the task
     key. Nothing new is uploaded.
   - **Failed task:** logs and any outputs it left are uploaded under
     `xxh3("failed" \0 taskKey)`.
   - **Uncached task (no task key):** its log is stored under its own
     content hash, `xxh3(logBytes)`. Identical logs are stored once.
3. **Manifest, at run end.** One entry, written once, under
   `xxh3(plugin \0 "run" \0 runId)`:
   ```json
   {
     "version": 1,
     "runId": "…",
     "ci": { "provider": "gitlab", "pipeline": "…", "job": "…" },
     "commit": "…",
     "branch": "…",
     "command": "vx run ci",
     "startedAt": 0,
     "durationMs": 0,
     "tasks": [
       {
         "id": "app#build",
         "status": "success|failed|cached|skipped",
         "durationMs": 0,
         "key": "…",
         "logKey": "…",
         "outputsKey": "…"
       }
     ]
   }
   ```
4. **Log line.** The run's last line is `run <id> · vx explore <id>`.
5. **Explorer.** A plugin verb `vx explore <id>` (the `commands` seam)
   reads the manifest, starts a local UI, and fetches each log or output
   from the cache only when it is opened. A pipeline view groups runs by
   `ci.pipeline`.

## Core seams needed

- Expose the run id and CI facts to plugins.
- Hand a failed task's output files to plugins. Core collects outputs only
  on success today.
- `cache.get/put/has/hasMany` for plugins (designed in
  `shared-timings-2026-10.md`, #3563).

Everything else lives in the plugin.

## Behaviour

- **Write policy:** only runs whose policy may write to the remote (CI by
  default) upload. Local runs upload nothing.
- **Size:** successes add nothing new. Failures and uncached logs are small
  and rare.
- **Expiry:** if the cache evicts an entry, the explorer shows it as
  expired, like CI artifact expiry. The manifest may outlive its entries.
- **Several jobs per pipeline:** each job is its own run with its own
  manifest, grouped by `ci.pipeline` in the explorer.

## Open questions (for when it is un-parked)

- A pipeline-level index, or does the explorer take a list of run ids?
  Each job prints its own.
- Large outputs of failed tasks: upload them all, or only declared outputs?
- Explorer UI: a static bundle served by the verb, with no extra
  dependency.
