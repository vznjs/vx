// What the Upgrading vx page says for a breaking commit whose footer is too
// long or too technical for a reader: plain words, short paragraphs, the same
// facts. Keyed by the commit subject without its `(#N)`; the footer is git
// history and cannot be edited. tests/site-upgrading.unsafe.test.ts holds every
// paragraph of the release list to the site's readability rules.
export const SAY: Readonly<Record<string, string>> = {
  'fix(plugins)!: refuse a plugin option value of the wrong kind':
    '`refuseUnknownOptions(factory, options, known)` takes a `PluginOptionKinds<Options>` record in place of a list of option names (released in 0.0.397).\n\nPass each option with its kind. The type checker derives the kinds from your options interface.',
  'refactor(vx-otel)!: stop exporting the OTLP builders':
    '`@vzn/vx-otel` stops exporting its OTLP builders. These exports are gone:\n\n- `buildLogsRequest`, `buildMetricsRequest`, `buildTraceRequest`\n- `resourceAttributes`, `runSpanAttributes`, `taskSpanAttributes`, `taskStatusCode`\n- `SEMCONV`, `VX_ATTR`\n- the types `KeyValue`, `OtlpLogRecord`, `OtlpSpan`\n\nImport only the plugin itself.',
  'refactor(vx-migrate)!: export only the four plugins':
    '`@vzn/vx-migrate` exports only its four plugins. These exports are gone, with their types:\n\n- `mapTurboWorkspace`, `mapNxWorkspace`, `nxExecCommand`, `parseNxGraph`, `readNxJsonFacts`\n- `TurboRemoteCache`, `NxRemoteCache`, `resolveTurboCacheConfig`, `resolveNxCacheConfig`\n- `turboRemoteAccess`, `artifactTag`, `VERCEL_API`, `MIN_SIGNATURE_KEY_LENGTH`\n- `migrateCmd`, `parseMigrateArgs`',
  'refactor(vx-reapi)!: stop exporting the wire and Merkle internals':
    '`@vzn/vx-reapi` stops exporting its wire and Merkle internals. These exports are gone, with the wire and Merkle types:\n\n- `ReapiClient`, `reapiExecutor`, `acceptsTask`, `globToOutputPath`, `outputPathSets`\n- `buildInputTree`, `canDigest`, `decodeDirectory`, `decodeTree`, `digestWith`\n- `encodeAction`, `encodeCommand`, `encodeDigest`, `encodeDirectory`, `encodeNodeProperties`, `sha256`\n- `assertBunSupportsChunking`, `CHUNK_BYTES`, `SAFE_CHUNK_BYTES`, `MIN_BUN`\n- `COMPRESSOR`, `DIGEST_FUNCTION`, `OUTPUT_DIRECTORY_FORMAT`',
  'feat(cache)!: count restored and up-to-date hits everywhere':
    'The local index schema moves from `SCHEMA_VERSION` `v30` to `v31`. Run history starts empty once; nothing to do.\n\nThe old artifacts stay on disk. Run `vx cache prune` to remove them.\n\nIf you read these types, expect extra fields: `WhyDidThisRerun` (`thisRun` / `previousRun`), `RunSummaryRow`, `InvocationDetail`, `RunSummaryRecord`, `CacheStats`.',
  'feat(cache)!: replace rewrittenInputs with cache.inputStability':
    "`cache.rewrittenInputs` and `VX_REWRITTEN_INPUTS` are gone. Use `cache.inputStability` instead:\n\n- `strategy`: `'immutable'`, `'mutable'` or `'unchecked'`\n- `severity`: `'warn'` or `'error'`\n- `'withhold'` → `'immutable'`, `'compare'` → `'mutable'`\n- env vars: `VX_INPUT_STABILITY`, `VX_INPUT_STABILITY_SEVERITY`",
  'feat(run)!: check graph rules in vx lock; runs are frozen under CI':
    'Under CI a run reads its configs from `vx-lock.json`, and writes that file first when it is missing.\n\nTo evaluate the configs instead, pass `--no-frozen` or set `VX_RUN_FROZEN=false`.\n\n`vx lock` refuses a graph that breaks `run.rules`, and `vx lock --check` reports it.',
  'feat(cache)!: read the default key first; a scope only names writes':
    "A cache scope reads the default key first and writes only its own key, locally and remotely.\n\n`'trusted'` and `'read-only'` are plain scope names. For a read-only run, set `cache.policy` to `'remote:r'`.\n\nOff CI, the default policy writes nothing to the remote cache.\n\n- `RunOptions.defaultCacheScope` → `RunOptions.remoteReadOnlyByDefault`\n- `CachePolicy.remoteScope` and `scopeCachePolicy` are removed.\n\nThe cache moves to `vx-cache-v43`, so every cached task misses once after you upgrade.",
  'refactor!: drop rename shims, flag aliases and lock path fields':
    'Old names stop working. An old config key or flag fails the unknown field or flag check. An old `VX_*` variable is ignored.\n\n`vx migrate`, `vx prune` and `vx stats` are unknown verbs unless a plugin declares them.\n\n- `--cache` → `--cache-policy`\n- `--download` → `--cache-download`\n\n`vx-lock.json` is version 2 (project name → resolved config). Re-run `vx lock`.\n\n`vx lock --check` reports one drift message per project.',
  'feat!: retire @vzn/vx-mcp for the agent skill and vx last --stats':
    "`@vzn/vx-mcp` and `vx mcp` are gone.\n\nInstall the agent skill instead (`bunx skills add vznjs/vx`) and read the CLI's `--format json`. For run history, use `vx last --stats`.\n\n`@vzn/vx` stops exporting `clampInt`, `collectInfo`, `maskedCommand`, `maskedLine` and the run-history queries:\n\n- `cacheKeyDiff`, `latestRunId`, `resolveRunId`, `inputWriters`\n- `rootCauses`, `runFailures`, `taskLog`, `whyDidThisRerunQuery`",
  'feat(workspace)!: drop the config eval cache; all verbs read the lock':
    'The config eval cache is gone: index `SCHEMA_VERSION` `v35` drops its tables. Run history starts empty once; nothing to do.\n\nRemoved exports: `ConfigEvalStore`, `LoadProjectConfigOptions`, the `Cache` config-eval methods, and the options of `loadProjectConfig`.\n\n`vx info` drops its config errors row. `vx show` and `vx info` need a lock file: run `vx lock`.',
  'feat(graph)!: project edges come only from plugins':
    "Project edges come only from plugins. Without a plugin that returns `deps`, there are no package edges.\n\nAdd `pnpm()`, `bun()`, `npm()` or `yarn()` from `@vzn/vx-lockfile` to `.vx/workspace.ts`.\n\nA `^task` with no edge source is refused (`VX_E_DEPENDS_ON`). That includes the default build's `^build`.\n\n`--affected` stops comparing manifests at the base. A dependency change reaches it through the lockfile.\n\nCatalogs and `workspace:` / `npm:` / `file:` range resolution are gone. Removed exports: `buildPackageGraph`, the `Catalogs` type.",
  'feat(cache)!: core keys no package file':
    'Core leaves `package.json`, the root lockfiles and install settings out of every cache key. Without a lockfile plugin, an install changes no key.\n\nDeclare `pnpm()`, `bun()`, `npm()` or `yarn()` from `@vzn/vx-lockfile` in `.vx/workspace.ts`.\n\n`TaskInputs` drops `packageJsonDigest` and `workspaceFingerprint`.\n\n`npm()` reads `npm-shrinkwrap.json` first. `bun()` refuses a lone `bun.lockb`: run `bun install --save-text-lockfile`.',
  'feat(workspace)!: a project is a directory with a vx.config':
    "A project is a directory with a `vx.config`. A `package.json` member is no project without one, unless a lockfile plugin (`pnpm()`, `bun()`, `npm()`, `yarn()`) adds it.\n\nA project's name is its config `name`, else a plugin's, else its path (`//` for the root). Two projects with one name are refused.\n\nLock version 2 is refused: re-run `vx lock`.\n\nPlugin contexts drop `packageJson`, and so does `ProjectMeta`. `PackageMeta` keeps it for `vx init`.",
  'feat(cli)!: vx init writes no package.json-derived config':
    '`vx init` hands any repo with a `package.json`, `pnpm-workspace.yaml`, `turbo.json` or `nx.json` to `@vzn/vx-migrate`.\n\nIts report says `vx-migrate:`, and `--keep` installs what it declares. Both runners need `bunx @vzn/vx-migrate --from`.\n\nWith none of those files, `vx init` writes a `.vx/workspace.ts` that declares no plugin and an empty root `vx.config.ts`.\n\nTo map your scripts, run `bunx @vzn/vx-migrate` (with `--from scripts` beside another source).\n\n`@vzn/vx` drops `findManifestRoot`, `listPackages`, `PackageMeta` and `LoadReads`. `ApplyMigrationArgs.metas` is `MigrationMember[]`.',
  'feat(cache)!: stop ignoring *.tsbuildinfo as an input':
    'vx stops ignoring `*.tsbuildinfo` by default. A tracked, or untracked and not ignored, `tsbuildinfo` is an input of any task whose globs reach it.\n\nTo keep it out of keys, add it to `.gitignore` or declare it an output.',
  'refactor(cli)!: remove vx run --summarize and --format json':
    "`vx run --summarize`, `vx run --format json` and `schemas/summary.json` are removed.\n\nRead a run's result with `vx last --format json`. `vx run --dry=json` still prints the plan.\n\nRemoved fields: `RunOptions.summarize` / `json`, `RunSummary.json`, `OutputContext.json`.",
  "fix(cache)!: stop ignoring Bun's compile temp files in core":
    "vx no longer skips the temp files `bun build --compile` writes. A broad input glob like `**/*` on a compile task, or on a task in the same directory, picks them up.\n\nAdd both excludes to that task's `inputs.files`:\n\n- `'!**/*.bun-build'`\n- `'!**/.????????????????-????????.tmp/**'`",
  "fix(vx-migrate)!: leave reads and writes to core's cache policy":
    "`turboCache()` and `nxCache()` ignore `TURBO_CACHE`, `TURBO_REMOTE_CACHE_READ_ONLY`, `NX_SKIP_REMOTE_CACHE` and `NX_DISABLE_REMOTE_CACHE`. `RemoteCacheLayer.access` is removed.\n\nTo keep untrusted pull requests from writing the shared cache, set vx's `cache.policy`, or pass `--cache-policy=local:rw,remote:r`.",
  'feat(cache)!: keep symlinks under outputs as links':
    "A symlink under a task's `outputs` is cached and restored as a link, not as a copy of its target. An absolute link, or one pointing out of the workspace, fails the save.\n\n`CacheLayer.save` drops `readable`.\n\nEvery cached task misses once after the upgrade (cache version v45). Nothing to do.",
  "fix(cache)!: reserve vx's names only where vx writes them":
    "`.git`, `.vx` and `vx.lock.json` are reserved only at a project's root (and each project's `vx.lock.json` for `workspaceFiles`). Deeper down, they are normal inputs and outputs.\n\n`restorableOutput` takes a scope: `'project'` or `'workspace'`.\n\nEvery cached task misses once after the upgrade (cache version v46). Nothing to do.",
  "feat(cache)!: scope a branch's remote cache by owner/repo:branch":
    "The remote cache for a branch is scoped by `<owner>/<repo>:<branch>`. Update these names:\n\n- `--cache-scope` and `cache.scope` → set `VX_CACHE_SCOPE`\n- `run.affectedBase` → `baseBranch` (a branch name)\n- `VX_RUN_AFFECTED_BASE` → `VX_BASE_BRANCH`\n\nA bare `--affected` on the base branch is refused; it no longer falls back to `HEAD~1`. Pass `--affected=<sha>` there.\n\n`github()` scopes by `<owner>/<repo>:<branch>`, not `pr-<n>`. The config hook's `ctx` gains `setBranch`.\n\nThe local cache stores every entry under its task key, whatever the scope.",
  'perf(cache)!: drop run-end housekeeping and cache.retention':
    "A run no longer cleans the cache at its end. `cache.retention` is removed, with `VX_CACHE_RETENTION_OLDER_THAN` and `VX_CACHE_RETENTION_MAX_SIZE`.\n\nTo trim the cache, run `vx cache clean --older-than` or `vx cache clean --max-size`.\n\n`@vzn/vx-migrate` no longer maps Turbo's `cacheMaxSize` / `cacheMaxAge` or Nx's `maxCacheSize`.",
  'feat(cli)!: install vx on init, migrate only Turbo and Nx':
    '`vx init` hands only Turbo and Nx repos to `@vzn/vx-migrate`. A repo with only a `package.json` gets an empty root project.\n\nTo turn `package.json` scripts into tasks, run `bunx @vzn/vx-migrate`.\n\n`vx init` also installs `@vzn/vx` globally and as a root `devDependency`.',
  'feat(vx-migrate)!: scope Turbo cache reads by ref, keys stay plain':
    "Task keys carry no branch scope, and `turboCache()` and `nxCache()` drop the `x-vx-cache-scope` header.\n\n`turboCache()` picks how reads are scoped:\n\n- `scope: 'header'` (default): sends `x-artifact-read-scopes` on every read\n- `scope: 'key'`: keys entries by ref\n\nThe server's OIDC trust policy decides who may write. `VX_CACHE_SCOPE` scopes only plugin entries.",
  'feat(history)!: name the task with no inputs that stops a hit':
    '`TaskOutcome.keyless` is replaced by `keylessBy`: the id of the task with no inputs that the key depends on.\n\nRun history starts empty once; nothing to do.',
  'feat(vx-dte-relay)!: allow issuer:repo:workflow entries in one ALLOW':
    'One `ALLOW` list replaces three trust settings. Each entry reads `issuer:owner/repo:workflow`.\n\n- Worker: `ISSUERS`, `REPOSITORIES`, `WORKFLOWS` → `ALLOW`\n- `vx-dte-relay`: `--issuer`, `--repository`, `--workflow` → `--allow`\n- `createVerifier`: `issuers`, `repositories`, `workflows` → `allow`',
  'feat(vx-dte)!: call DTE agents workers':
    "DTE agents are called workers. Rename:\n\n- `vx dte agent` → `vx dte worker`\n- `dte({ agents })` → `dte({ workers })`\n- `VX_DTE_AGENT` → `VX_DTE_WORKER`\n- `github()` default workflow → `vx-worker.yml`, with a `workers` input\n- GitLab job template → `.vx-worker`; its bridge → `vx-workers`\n\nThe run list's column header reads `· worker`.",
  'feat(vx-cache-server)!: OIDC only, task timings, batch uploads':
    "The server's routes are:\n\n- `GET /v1/artifacts/download/<hash>`\n- `POST /v1/artifacts/download`, `/v1/artifacts/upload`, `/v1/artifacts/check`\n- `POST /v1/timings/upload` and `/v1/timings/query`\n- `GET /v1/capabilities`\n\n`PUT`, `HEAD`, `/v1/runs` and `/v1/tasks/query` are gone.\n\nConfig changes:\n\n- `TOKENS` and `RUN_DAYS` are gone; `TIMING_DAYS` keeps timings\n- `MAX_ARTIFACT_BYTES` → `MAX_UPLOAD_BYTES` (`maxUploadBytes`)\n\nEvery request needs a CI OIDC token. `vxCache()` drops `token`, `history` and `oidc`, and serves CI jobs only.\n\nDeploy the server and `vxCache()` together, on an empty database and bucket.",
  'feat(vx-cache-server)!: one bucket, no database, exact-key reads':
    '`vx-cache-server` stores everything in one bucket. It drops its database (`--db`, Postgres, D1), the timings routes and the sweep (`TRUSTED_DAYS`, `BRANCH_DAYS`, `TIMING_DAYS`).\n\nTo expire old entries, set lifecycle rules on the bucket.\n\n`/v1/artifacts/check` and the batch download take `{ keys: [{ scope, hash }] }`. A single download names its ref in `x-vx-scope`. `x-artifact-read-scopes` is gone.\n\n`vxCache()` no longer keeps timings or orders tasks. Declare `vxHistory()` for that.',
  "feat(vx-cache-server)!: send and store scopes as their refs' hashes":
    "A `vx-cache` or `vx-history` scope is sent as its ref's hash, never the ref itself: the first 128 bits of SHA-256, as 32 lowercase hex digits.\n\nThis covers `x-vx-scope`, check and download keys, and history query scopes. A plain ref gets a 400.\n\nUpgrade `vxCache()`, `vxHistory()` and the servers together.",
  "feat(vx-cache-server)!: speak Turbo's routes, cache downloads per DC":
    "The server speaks Turbo's routes. Rename:\n\n- `GET /v1/artifacts/download/<hash>` → `GET /v1/artifacts/<hash>`\n- `POST /v1/artifacts/check` → `POST /v1/artifacts`\n- `x-vx-scope` → `x-artifact-scope`; `x-vx-max-*` → `x-artifact-max-*`\n- `MAX_CHECK_KEYS` / `maxCheckKeys` → `MAX_CHECK_HASHES` / `maxCheckHashes` (lookups, 6 by default on Workers)\n\nThe check takes `{ hashes, scopes }` and answers `{ <hash>: { size, scope } | null }`.\n\nGone: `POST /v1/artifacts/download`, `MAX_BATCH_ARTIFACTS`, `maxBatchArtifacts` and `x-vx-max-batch-artifacts`.\n\nDeploy the server and `vxCache()` together.",
  'feat(vx-devtools)!: name a repository by org/name, not its id':
    'A `TRUST` rule names a repository by org/name. Rename:\n\n- GitHub: `repository_id` → `repository`\n- GitLab: `project_id` → `project_path`\n- `Access`: `id` → `repository`\n\nStored keys change, so the cache and history start cold once.',
  "feat(vx-devtools)!: admit CI by the relay's ALLOW string, not TRUST":
    "The cache and history servers read `ALLOW` in place of `TRUST`, the same string the DTE relay reads: space-separated `issuer:owner/repo:workflow` entries.\n\nIn `@vzn/vx-devtools`:\n\n- `parseTrust` → `parseAllow`; `TrustRule` → `Allowed`\n- `oidcAuth` and `oidcTokenAuth` take `allow`, not `trust`\n\nProtected refs are gone: any run of a listed workflow writes its branch's cache. Set `ALLOW` to each repository's CI workflow.",
  'docs(vx-docs)!: release post for v0.0.647':
    "Several flags, config values and plugin options were renamed or tightened. Update each one you use:\n\n- `vx cache clean --dry-run` → `--dry` (its JSON field `dryRun` → `dry`)\n- `vx run --dry=text` → `--dry=pretty`\n- A duration in `M` is refused: write minutes as `m`.\n- `baseBranch: 'origin/main'` is refused: write `baseBranch: 'main'`.\n- A glob brace like `{src,lib}` matches each alternative on its own.\n- An `inputs.tasks` entry that matches no dependency is refused.\n- A dependency rule selector that `--filter` would misread is refused.\n- `inputs.runtime` probes see only the essential env. Name any other variable in `inputs.env`.\n- `vxHistory({ defaultBranch })` → `vxHistory({ baseBranch })`\n- Timings in the remote cache need `vxHistory({ url })`.\n- `turboCache({ apiUrl })` → `turboCache({ url })`\n- `nxCache({ server, accessToken })` → `nxCache({ url, token })`\n- `reapi()` reads no `VX_REAPI_*` variable. Pass its options in code instead.",
  'fix!: close the last hardening batch before v0.0.647':
    '`VxCacheLayer.hasMany` resolves `null`, not an empty map, once the remote is off for the run.\n\nIf you call the cache layer yourself, treat `null` as "cannot say", as core does.\n\n`CACHE_VERSION` is `vx-cache-v51`: every cached task misses once after you upgrade. Nothing to do.',
  'feat(cache)!: keep run notes and lockfile memos in cache.db':
    "`SCHEMA_VERSION` is `v50`. Run history starts empty once; nothing to do. Stored artifacts stay.\n\nA run's steps, warnings and failed output live in the `steps`, `warnings` and `failures` tables of `cache.db`. Lockfile parses live in its `lockfile_memos` table.\n\nvx no longer writes or reads `<cacheDir>/steps/`, `warnings/`, `failures/` or `lockfile-claims/`. You may delete them.\n\n`vx cache clean` no longer takes those folder names from a cache dir you named.\n\nIf you call `runFailures` or `taskLog`, pass the index handle, not the cache dir.",
  'refactor(vx)!: hand plugins history rows, not a cache.db handle':
    '`@vzn/vx` no longer exports `LocalHistoryProvider`, and `Cache` has no `dbHandle()`. A plugin cannot open `cache.db`.\n\nRead run history with `localHistory(cache, { recent, branch, defs })`. It returns `loadFor`, `p50sFor`, `resourcesFor`, `hasImported` and `importTimings`.',
  'feat(vx-cache-server)!: keep artifacts in issuer/repo/branch folders':
    'A `vx-cache` scope on the wire is its ref, percent-encoded (`refs%2Fheads%2Fmain`), not its hash. The server refuses a hashed scope with `400`.\n\n`blobName()` is synchronous and names readable folders. Artifacts stored before are not read again; they expire in a day.\n\nDeploy the server and upgrade `vxCache()` together.',
  'feat(orchestrator)!: key runs from the dependencies lock':
    'A run refuses when a lockfile a plugin reads changed after your last `vx lock`, or when `.vx/dependencies.lock.json` is missing.\n\nRun `vx lock` after each install.\n\nThe lock is version 3 (files record extras). For plugin authors: `KeyHookContext` gains `locked(file)`, and `FingerprintDigests` gains `extras`.',
  'perf(vx-cache)!: cut cache and history requests per run':
    "`vxCache()` names several scopes in one `vx-scope` header. An older `vx-cache-server` refuses that with `400`.\n\nDeploy the server first, then upgrade `vxCache()`.\n\n`VxCacheLayer.start()` is gone: `open()` asks the server nothing, and the first check learns the server's limits.",
  'refactor(vx-dte-server)!: check tokens with @vzn/vx-devtools':
    "The relay no longer exports `parseAllow`, `TokenError`, `Allowed`, `repositoryClaimOf` or `workflowClaimOf`. Use `parseAllow`, `Refusal` and `Admits` from `@vzn/vx-devtools`.\n\nRefusal texts changed. Update any script or alert that matches them:\n\n- `this relay's ALLOW` → `this server's ALLOW`\n- `repository <r>` names the token field, lowercased: `repository` or `project_path`.\n- `workflow <w>` → `job_workflow_ref <w>` or `ci_config_ref_uri <w>`\n- The audience hint ends `or set the server's AUDIENCE`.\n- The issuer is checked before the header's `alg`.\n- A signature no held key made reads `bad signature`.\n\nThe image bundles `@vzn/vx-devtools`, so build it from the repo root.",
  'fix!: everyday workspaces never cache a wrong build':
    "`CACHE_VERSION` is `vx-cache-v56` and the index schema is `v56`. Caches start empty once, so every cached task misses once after you upgrade.\n\nRun `vx lock` again after you upgrade. `vx-lockfile` digests changed, so `vx lock --check` fails on the old lock.\n\nWhat changed: a workspace package's own version counts under `bun()` and `npm()`, and so do `pnpm()`'s injected copies.",
  'refactor(cache)!: take history and memos off Cache and CacheLayer':
    "`Cache` loses `recordRun`, `recordRuns`, `recordMeasures`, `recordRunBundle` and `recordRemoteErrors`. No public replacement: core records each run itself.\n\n`CacheLayer` and `LayeredCache` lose `recordRunBundle`. A custom layer's `recordRunBundle` is no longer called.\n\nOn `Cache`, call these through `cache.memo.<name>` (`StoreMemo`):\n\n- `hashFile`, `hashBytes`, `hashFiles`\n- `knownBlobSizes`, `rememberBlobSizes`, `holdBlobSizes`, `storeHeldBlobSizes`\n- `blobVerdict`, `rememberBlobVerdict`\n- `loadOutputFilesBatch`, `isOutputsCurrent`, `recordOutputDirs`, `recordOutputStamps`\n- `loadOutputDirsBatch`, `outputDirsCurrent`\n- `foldMemo()` → `cache.memo.folds`\n\n`CacheLayer` and `LayeredCache` lose `hashFile`, `loadOutputFilesBatch`, `isOutputsCurrent`, `recordOutputDirs`, `recordOutputStamps`, `loadOutputDirsBatch` and `outputDirsCurrent`.\n\nA layer hands those out as `layer.memo` (`TaskMemo`).",
  'refactor(graph)!: group TaskOutcome by concern, a union by status':
    "`TaskOutcome` fields moved into groups. Update each read:\n\n- `storedDurationMs`, `storedCpuMs`, `storedPeakRssBytes` → `cache.stored.{durationMs, cpuMs, peakRssBytes}`\n- `restored`, `saved`, `inputFiles`, `artifactBytes`, `outputBytes` → `cache.*`\n- `inputChanges`, `unkeyed`, `driftedInput`, `keylessBy` → `cache.*`\n- `cacheOff` → `cache.off`; `outputs: 'deferred'` → `cache.deferred: true`\n- `queuedMs`, `admissionHeldMs`, `fetchMs`, `saveMs` → `timing.*`\n- `wallclockStartNs`, `wallclockEndNs` → `timing.startNs`, `timing.endNs`\n- `cpuMs`, `peakRssBytes`, `peakCores`, `avgRssBytes` → `usage.*`\n- `where`, `carried` → `placement.*`\n- `whereCores`, `whereMemoryBytes`, `cpuShare` → `placement.cores`, `placement.memoryBytes`, `placement.cpuShare`\n- `attempts` → `attempts.count`\n- `failedAttempts`, `attemptOutputs`, `flaky` → `attempts.failed`, `attempts.outputs`, `attempts.flaky`\n- `sandboxViolations`, `sandboxViolationLines`, `sandboxFix` → `sandbox.violations`, `sandbox.lines`, `sandbox.fix`\n\nA skipped outcome has no `exitCode`. Read `exitCodeOf(outcome)` for the exit code a record writes.\n\nA skipped outcome keeps `hash` only when `--fail-fast` stopped it after its key was computed.\n\nThe groups and status variants are exported as types.\n\n`RunOptions` loses `staged`, `discovered`, `selectedByDiff`, `selectedOutright`, `affectedReasons` and `remoteRequested`.\n\nIt also loses `remoteReadOnlyByDefault`, `summaryTable`, `holdPersistent`, `watch`, `keep` and `commandWindows`.\n\nvx's CLI passes those internally; `run()` and `planRun()` no longer read them. Drop them from your calls.",
  'refactor(workspace)!: keep JS out of the migration seam':
    "`@vzn/vx` no longer exports `foldScriptHooks`.\n\nFor migrator authors:\n\n- `ApplyMigrationArgs` drops `unmapped`: pass `emptyReason` and `example`.\n- `MigrationMember`'s `packageJson` → `esModule`\n- Core runs no formatter unless the migrator passes `written`.",
  'refactor(exec)!: group executor capabilities and distribution':
    '`TaskExecutor` keys moved into two groups. Any other executor key refuses the run.\n\n- `remote`, `sandbox`, `servers`, `runtime`, `exclusive`, `timeouts`, `platforms`, `capacity` → under `capabilities`\n- `workers`, `demand`, `running`, `unneeded`, `footer`, `machines`, `idealMs`, `advice`, `profile` → under `distribution`\n\n`@vzn/vx` no longer exports `localFloor`, `LocalFloor`, `sandboxRequestFor`, `sweepPlaceholders`, `SandboxRequest` or `BoundedCapture`.\n\nIt also drops `answerRuntime`, `packageManagerPath` and `sampleTrees`.\n\nA worker calls `workerRuntime({ root })` and uses `prepare(task)` → `run()` / `sweep()`, `probe`, `packageManager` and `sample`.',
  'feat(vx-cache-server)!: hash issuer, repository and ref in object names':
    "A `vx-cache-server` object's name is `<hash(issuer)>/<hash(repository)>/<hash(ref)>/<hash>`, not the percent-encoded names.\n\nEach of the first three parts is the first 32 hex digits of a SHA-256.\n\nArtifacts stored under the old names are not read. `blobName()` is async: `await` it.",
  "perf(history)!: keep a run's cache hits as one packed row":
    'The index schema is `v57`. Run history starts empty once; nothing to do.\n\nA cached task with no stored artifact to reuse runs once more.\n\nA run writes no `runs` row for a cache hit until something reads the history. `vx last`, `vx why` and `vx info` write those rows out first.\n\nIf a tool reads `cache.db` directly, it sees hits only up to the last of those commands.',
  'feat(orchestrator)!: replace --continue with --fail-fast':
    '`--continue` is gone: use `--fail-fast`. Rename each one you use:\n\n- `--continue` → `--fail-fast`\n- `run.continue` → `run.failFast`\n- `VX_RUN_CONTINUE` → `VX_RUN_FAIL_FAST`\n- pipeline key `continue` → `failFast`\n- `RunOptions.continueMode` → `failFast`',
  'feat(vx-dte)!: group machines into worker types for exec.worker':
    '`dte()` groups machines into worker types:\n\n- `dte({ workers: { <size>: {...} } })` → `dte({ workers: { <type>: { machines: { <name>: {...} } } } })`\n\nMachine names in output and adapter options read `<type>.<machine>`.',
  'feat(util)!: output components for every verb and plugin':
    "`vx lock` prints `✓ vx lock N project configs → .vx/projects.lock.json`. A refusal prints `✗ vx lock lock not written`, with what, why and the fix under it.\n\n`applyMigration`'s `lock` option returns `{ code, said }`.",
  // The 2026-11-23 day PR squashed three breaking commits into one.
  'feat!: land 2026-11-23 alpha hardening, docs and locks':
    "`.vx/projects.lock` is version 9 and `.vx/dependencies.lock` version 6. Run `vx lock` once to rewrite both.\n\n`vx lock --check --format json` lists each problem as `{ code, message }`, not as a string.\n\n`vx run --dry=json` → `vx run --dry --format json`; `--dry=pretty` → `--dry`; pipeline `dry: 'json'` → `dry: true, format: 'json'`.",
  // The 2026-11-25 day PR squashed three breaking commits into one.
  'feat!: land 2026-11-25 alpha hardening, locks and docs':
    "`.vx/projects.lock` is version 10 and `.vx/dependencies.lock` version 7: each project's lines sit together, so branches that edit different projects merge cleanly. Run `vx lock` once and commit both locks.\n\n`vx lock` now refuses:\n\n- `exec.persistent.readyWhen: ''`, which matched any line. Omit `readyWhen` to be ready once the task starts.\n- a name listed twice in `inputs.env`, `exec.env.passThrough`, `exec.env.secret` or `tags`. Keep one of each.\n- a dependency rule whose only list is `deny: []`. Delete the rule.\n- an `inputs.files` or `outputs.files` glob that reaches into a nested project past its fixed folder, such as a root `packages/**/*.log`. Let the member's task own them, or take them back with `!packages/a/**`.\n- a project named with a leading `-`, which `vx run -web#build` read as a flag. Rename the project.\n\nA run refuses an `inputs.files` link into another project (`VX_E_NESTED_INPUT`) unless a task it depends on there declares the target in `inputs.files` or `outputs`.\n\nDeclare it there, or take the link back (`!src/a`) and name its files in `inputs.workspaceFiles`.\n\nA plugin's `setup` that returns a value fails, and a `teardown` that returns one is warned. Close it in `teardown` and return nothing.\n\nui.Column's object form has an optional `align`: a plugin that reads `column.align` handles `undefined`.",
  'feat(cache)!: make the artifact ceiling a setting, 1 GiB by default':
    'The default artifact ceiling is 1 GiB, not 2 GiB. Raise it with `cache.artifactCeiling` or `VX_CACHE_ARTIFACT_CEILING`.',
  'refactor(cli)!: remove vx run --tag':
    '`vx run --tag` is gone, and `@vzn/vx-otel` drops its `vx.tag.<key>` attributes.',
  // Native Windows support does not exist; the page never names it.
  'refactor!: drop native Windows code paths': '',
  'feat!: affected per task, three task kinds, env patterns, hardening':
    'A task with no `exec` and empty `inputs` is refused. Add `exec`, or drop `inputs` to make it a group.\n\nThe `cache`, `outputs` and `inputs.stability` refusals of such a task name `exec`.',
  'refactor(cli)!: drop the lock merge driver, name it .vx/projects.lock':
    '`vx lock` writes `.vx/projects.lock`, not `.vx/projects.lock.jsonl`, and `vx lock --merge` is gone.',
}

/** A heading for a commit whose subject uses a word readers do not know. */
export const TITLE: Readonly<Record<string, string>> = {
  'feat!: affected per task, three task kinds, env patterns, hardening':
    'A task with empty inputs needs exec',
  'feat!: land 2026-11-25 alpha hardening, locks and docs':
    'Both locks have new versions, and vx lock refuses more',
  'feat(vx-dte)!: plan a distributed run with one engine':
    'Distributed task execution plans with one engine',
  'refactor(workspace)!: keep JS out of the migration seam': '`foldScriptHooks` is not exported',
  'refactor(orchestrator)!: make the lockfile claim ecosystem-neutral':
    'Lockfile plugins name importers links',
  'refactor(cache)!: take history and memos off Cache and CacheLayer':
    'Cache no longer records runs',
  'fix(graph)!: refuse configs that fold no upstream or clean sources':
    'Refuse inputs.tasks lists that pick no dependency',
  'feat(cache)!: keep run notes and lockfile memos in cache.db': 'Run history moves into cache.db',
  "feat(vx-devtools)!: admit CI by the relay's ALLOW string, not TRUST":
    'Servers accept CI by the ALLOW string, not TRUST',
  'feat(vx-dte-relay)!: let the orchestrator claim its run with a key':
    'The orchestrator signs its requests with a key',
  'feat(vx-dte-relay)!: admit named repos, deploy to Cloudflare by cf':
    'The relay accepts named repositories, deploys with cf',
  "perf(cache)!: read a warm task's key back from a files-fold memo":
    "Read a warm task's key back from the cache index",
}

/**
 * Changes only plugin authors, callers of vx's JavaScript API and hosts of
 * its servers act on: the release list closes them under their own heading.
 */
export const AUTHORS: ReadonlySet<string> = new Set([
  'feat(vx-migrate)!: run Turbo root tasks with no root vx.config',
  'fix(plugins)!: refuse a plugin option value of the wrong kind',
  'refactor(vx-github)!: stop exporting the Checks API helpers',
  'refactor(vx-otel)!: stop exporting the OTLP builders',
  'refactor(vx-lockfile)!: stop exporting the parser namespaces',
  'refactor(vx-migrate)!: export only the four plugins',
  'refactor(vx-reapi)!: stop exporting the wire and Merkle internals',
  'test(contract): hold every plugin export to its README',
  'fix(vx-reapi)!: inline the wire-only keys',
  'feat(cache)!: keep artifacts when the store schema changes',
  'fix(cache)!: dry prune on an earlier index previews the store',
  'refactor(cache)!: drop unread store fields, fix chunking comments',
  'perf(orchestrator)!: skip the schedule stage when every task is a hit',
  'feat(cache)!: a cache plugin provides only the remote',
  'feat(plugin)!: output stage lets a plugin draw the terminal',
  'feat(plugin)!: discover names projects and supplies edges',
  "feat(plugin)!: keep a CI run's bytes and hand plugins a run report",
  'refactor(cache)!: one LayeredCache over every declared remote',
  'perf(orchestrator)!: never hold a run on fetched schedule weights',
  "fix(cache)!: restore only the task's declared outputs",
  'feat(cache)!: read one plugin cache key per request',
  'feat(cache)!: run a task here when its download is slower',
  'fix(vx-dte)!: a task an agent has not begun reads waiting',
  'feat(vx-dte)!: sign relay keys by GitHub OIDC, with no secret',
  'feat(vx-dte-relay)!: admit named repos, deploy to Cloudflare by cf',
  'feat(vx-dte-relay)!: let the orchestrator claim its run with a key',
  'feat(vx-dte-relay)!: allow issuer:repo:workflow entries in one ALLOW',
  'refactor(vx-dte-relay)!: drop the frames version from join',
  'refactor(vx-dte-relay)!: take only sends, remove and leave frames',
  "docs(vx-dte-relay)!: mark the relay's socket-only protocol breaking",
  'feat(vx-dte)!: drop the agent names the relay still took',
  'feat(vx-dte-relay)!: keep only live runs, retry 3 times',
  'fix(orchestrator)!: name the setting that asked for a missing remote',
  'perf(cache)!: one round-trip per remote hit, never "up to date"',
  'feat(vx-dte-relay)!: lose a participant when its socket closes',
  'feat(vx-dte-relay)!: keep runs in socket attachments, not storage',
  'feat(vx-dte-relay)!: join on the socket only, drop pin and rate limit',
  "fix(vx-dte)!: replay a worker's output in the order it was written",
  'feat(vx-dte-relay)!: speak the Switchboard protocol, v1',
  'feat(vx-dte-relay)!: serve the relay API under /v1/',
  'refactor(vx-dte-server)!: rename @vzn/vx-dte-relay to vx-dte-server',
  'feat(vx-cache-server)!: run many Bun nodes over one Postgres',
  'refactor(graph)!: move criticalPath into core',
  'refactor(vx-devtools)!: move the CI token check into @vzn/vx-devtools',
  'feat(vx-cache-server)!: name objects by issuer, id, scope and hash',
  'feat(vx-cache-server)!: take uploads one artifact at a time',
  'feat(vx-dte-server)!: store nothing',
  'fix(cache,vx-cache,vx-migrate)!: count no upload a remote skipped',
  "fix(vx-dte-server)!: answer 502 when the issuer's keys cannot be read",
  'refactor(vx-ci,vx-otel)!: drop the test transports from the options',
  "feat(vx-devtools)!: admit CI by the relay's ALLOW string, not TRUST",
  'fix(exec)!: keep numeric signals, forward args into compounds',
  'fix!: close known lockfile, cache, DTE and watch issues',
  'refactor(vx)!: hand plugins history rows, not a cache.db handle',
  'feat(report)!: one grid for both task lists, with cost and place',
  'fix(vx-devtools)!: read issuer keys through the Worker shared cache',
  'fix(report)!: drop waited, show usual from the first row, title lists',
  'feat(ui)!: draw every line vx prints from one UI kit',
  'fix!: close watch, lock, DTE and history bugs found by the bug hunt',
  'fix!: close affected, sandbox, summary and migrate bugs from the hunt',
  'fix(cache)!: clean only vx stores under ~/.vx; name failed saves once',
  'fix(vx-cache)!: keep remote hits when a token is refused',
  "fix(vx-cache-server)!: ask Blobs.size for the bucket's own answer",
  'feat(vx-dte)!: time worker warm-ups as tasks in history',
  'refactor(vx-dte-server)!: check tokens with @vzn/vx-devtools',
  'refactor(cache)!: take history and memos off Cache and CacheLayer',
  'refactor(graph)!: group TaskOutcome by concern, a union by status',
  'refactor(orchestrator)!: make the lockfile claim ecosystem-neutral',
  'refactor(workspace)!: keep JS out of the migration seam',
  'refactor(exec)!: group executor capabilities and distribution',
  'perf(vx-dte)!: an uncached task ends before its files are home',
  'feat(vx-cache-server)!: hash issuer, repository and ref in object names',
  'fix(vx-dte)!: wait on a late worker, never give up and ask again',
  "fix(cache)!: stream a failed task's outputs to the remote",
])

/**
 * The JavaScript API part of a change whose user part SAY tells: the release
 * list puts it under the same heading, in the block for plugin authors.
 */
export const API: Readonly<Record<string, string>> = {
  'feat!: affected per task, three task kinds, env patterns, hardening':
    "`defineProject` types require `exec` beside a literal empty `inputs` list. `Cache.orphanStats()` also returns `missing` and `missingBytes`. `AffectedReason.kind` gains `'always'`.",
  'feat(cache)!: make the artifact ceiling a setting, 1 GiB by default':
    '`RunOptions.artifactCeiling` is removed.',
  'feat(orchestrator)!: replace --continue with --fail-fast':
    '`RunOptions.continueMode` is `failFast`.',
  'refactor(cli)!: remove vx run --tag':
    '`RunOptions.tags` and `RunContextRecord.tags` are removed (`TELEMETRY_SCHEMA_VERSION` 4).',
}
