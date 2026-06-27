import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import type { ExecConfig, TaskConfig, CacheConfig } from '../config.js'
import {
  type CacheLayer,
  type CachePolicy,
  cleanOutputs,
  cleanWorkspaceOutputs,
  FULL_CACHE_POLICY,
  type GitFilesCache,
  resolveInputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
  WORKSPACE_OUTPUT_PREFIX,
} from '../cache/index.js'
import {
  buildIsolatedEnv,
  runCommand,
  runPersistent,
  runSandboxed,
  resolveSandboxConfig,
  type SandboxViolation,
} from '../exec/index.js'
import { isGroupTask, type TaskNode, type TaskOutcome } from '../graph/index.js'
import type { Logger } from './logger.js'
import { computeGroupHash, computeTaskHash, type HashCache } from './task-hash.js'

export interface ExecuteArgs {
  node: TaskNode
  upstream: TaskOutcome[]
  workspaceRoot: string
  workspaceFingerprint: string
  cache: CacheLayer
  /** Granular cache read/write policy. Undefined → everything on. */
  cachePolicy?: CachePolicy
  forwardArgs?: readonly string[] | undefined
  log: Logger
  nestedProjectDirs: string[]
  /** Anchor for hrtime spans across all tasks in this run. */
  runStartHrTimeNs: bigint
  /**
   * Registry the orchestrator owns. For each persistent task we
   * spawn, we stash the subprocess handle here so the orchestrator
   * can SIGTERM it once the rest of the graph finishes.
   */
  persistentRegistry?: Map<string, ReturnType<typeof Bun.spawn>>
  /**
   * Run-scoped set of in-flight subprocesses (one-shot and
   * not-yet-ready persistent). The runner adds/removes children
   * around each spawn; the orchestrator's SIGINT/SIGTERM handler
   * SIGTERMs whatever is in here.
   */
  liveChildren?: Set<ReturnType<typeof Bun.spawn>>
  /** Per-run memo for `git ls-files` (one entry per project dir). */
  gitFilesCache?: GitFilesCache
  /** Per-run memo for derived hashes (package.json bytes + task config). */
  hashCache?: HashCache
}

/**
 * Dispatch a single task to one of three execution paths. Each path
 * owns its own outcome shape; the dispatcher just picks based on the
 * task's config shape (group vs persistent vs cached). Sharing
 * helpers (`taskEnv`, `effectiveForwardArgs`) live below.
 */
export async function executeTask(args: ExecuteArgs): Promise<TaskOutcome> {
  if (isGroupTask(args.node)) return executeGroupTask(args)
  if (args.node.config.exec?.persistent !== undefined) return executePersistentTask(args)
  return executeCachedTask(args)
}

/**
 * Group task: no `exec`. The scheduler has already ensured every
 * dependency completed; we just return success with a hash rolled up
 * from upstream outcomes so downstream cache keys still cascade
 * through us.
 */
function executeGroupTask(args: ExecuteArgs): TaskOutcome {
  const wallclockNs = process.hrtime.bigint() - args.runStartHrTimeNs
  return {
    node: args.node,
    status: 'success',
    exitCode: 0,
    durationMs: 0,
    hash: computeGroupHash(args.upstream),
    wallclockStartNs: wallclockNs,
    wallclockEndNs: wallclockNs,
  }
}

/**
 * Persistent task: dev server / file watcher / daemon. Spawn, wait
 * for ready (regex match or immediate), stash the subprocess in the
 * orchestrator-owned registry, return success. The orchestrator
 * SIGTERMs the registry at end-of-run.
 *
 * Never reads or writes the cache — the project loader rejects
 * `cache + persistent` at config-load time, so by the time we get
 * here, `cache` is guaranteed undefined.
 */
async function executePersistentTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, log } = args
  // Type narrowing: the dispatcher checks `exec.persistent` before
  // calling us, so `exec` and `exec.persistent` are both present.
  const step = node.config.exec as ExecConfig & {
    persistent: NonNullable<ExecConfig['persistent']>
  }
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []
  const env = taskEnv(node, step)
  const wallclockStartNs = process.hrtime.bigint() - args.runStartHrTimeNs

  // When readyWhen is set we leave the command untouched so the
  // regex matcher sees the unmodified output. When it's absent the
  // task is "ready on spawn" — we can safely append forwardArgs in
  // the same way runCommand does.
  const persistentOpts: Parameters<typeof runPersistent>[0] = {
    command:
      step.persistent.readyWhen !== undefined
        ? step.command
        : effectiveForwardArgs.length > 0
          ? step.command + ' ' + effectiveForwardArgs.map((s) => JSON.stringify(s)).join(' ')
          : step.command,
    cwd: node.projectDir,
    env,
    onStdout: (chunk) => log.taskStdout(node, chunk),
    onStderr: (chunk) => log.taskStderr(node, chunk),
    ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
  }
  if (step.persistent.readyWhen !== undefined) {
    persistentOpts.readyWhen = step.persistent.readyWhen
  }
  // For a persistent task `exec.timeout` bounds the readiness wait.
  if (step.timeout !== undefined) {
    persistentOpts.timeoutMs = step.timeout
  }

  const spawn = runPersistent(persistentOpts)
  try {
    await spawn.ready
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    // Surface readiness failure on stderr so the user sees what went
    // wrong; the buffered stdout/stderr already streamed live via the
    // logger callbacks during spawn.ready.
    process.stderr.write(`\n[vx] ${node.id}: persistent task failed to become ready: ${message}\n`)
    return {
      node,
      status: 'failed',
      exitCode: 1,
      durationMs: spawn.readyMs(),
      wallclockStartNs,
      wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
    }
  }

  args.persistentRegistry?.set(node.id, spawn.child)
  return {
    node,
    status: 'success',
    exitCode: 0,
    durationMs: spawn.readyMs(),
    wallclockStartNs,
    wallclockEndNs: process.hrtime.bigint() - args.runStartHrTimeNs,
  }
}

/**
 * Cached task: the common case. Hash inputs, try cache.get; on hit,
 * clean+restore+replay logs; on miss (or --no-cache), clean outputs,
 * spawn the command, save on success.
 */
async function executeCachedTask(args: ExecuteArgs): Promise<TaskOutcome> {
  const { node, upstream, cache, log } = args
  const cfg: TaskConfig = node.config
  const step = cfg.exec as ExecConfig // dispatcher guarantees exec is present
  const cacheCfg: CacheConfig | undefined = cfg.cache
  const policy = args.cachePolicy ?? FULL_CACHE_POLICY
  const cfgCacheable = cacheCfg !== undefined
  // We may READ when at least one read axis is on (the cache layer
  // refines local vs remote), and WRITE when at least one write axis is
  // on. Output management (clean before exec) keys off writes — so
  // `--no-cache` (all off) leaves the user's tree alone, while `--force`
  // (reads off, writes on) still wipes + repopulates a clean snapshot.
  const willRead = cfgCacheable && (policy.localRead || policy.remoteRead)
  const willWrite = cfgCacheable && (policy.localWrite || policy.remoteWrite)

  const outputs = cacheCfg?.outputs.files ?? []
  const wsOutputs = cacheCfg?.outputs.workspaceFiles ?? []
  const anyOutputs = outputs.length > 0 || wsOutputs.length > 0
  const effectiveForwardArgs = node.requested ? (args.forwardArgs ?? []) : []

  // Prefer the hash precomputed in `prepareRun` (batched topo-walk).
  // Falls back to per-task computation only when a caller skips the
  // upfront pass (legacy entry points, focused tests).
  // Hash is computed mid-run, not at prepareRun time. Tasks whose
  // `cache.inputs.files` matches sibling outputs (e.g. `'**/*'` after
  // a `codegen` step has written `generated.txt`) need the upstream
  // outputs ALREADY on disk when their hash is computed — so we
  // can't lift this into prepareRun. Same model as Turbo / Nx.
  const hash = await computeTaskHash({
    node,
    upstream,
    workspaceRoot: args.workspaceRoot,
    workspaceFingerprint: args.workspaceFingerprint,
    cache,
    forwardArgs: args.forwardArgs,
    nestedProjectDirs: args.nestedProjectDirs,
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    ...(args.hashCache !== undefined ? { hashCache: args.hashCache } : {}),
  })

  const cleanArgs = {
    projectDir: node.projectDir,
    outputs,
    nestedProjectDirs: args.nestedProjectDirs,
  }
  const wsCleanArgs = { workspaceRoot: args.workspaceRoot, outputs: wsOutputs }

  // Cache lookup. On hit, time the user-perceived restore op
  // (clean+restore+log-replay) — that's what the framed-block footer
  // shows, not the original exec time stored in the entry.
  if (willRead) {
    const cacheOpStart = performance.now()
    const hit = await cache.get(hash, { taskId: node.id, command: step.command })
    if (hit) {
      // "Tree is already current" short-circuit — skip cleanOutputs
      // + restoreOutputs when the on-disk state matches what this
      // entry recorded at save time. Integrity-preserving: we
      // require BOTH that the output-glob walk yields exactly the
      // expected paths (no strays, no missing) AND that every file's
      // (size, mode, mtime) matches the stored fingerprint. Any
      // divergence falls through to a real clean + restore.
      //
      // The output-file fingerprints can't be batch-loaded at
      // prepareRun time — non-leaf task hashes depend on upstream
      // outputs that haven't been written yet, so hashes are
      // necessarily computed mid-run. We do one extra SELECT per
      // cache hit here. Still beats reading the manifest from the
      // tar (decompress + parse) at the same point.
      let skipRestore = false
      if (anyOutputs) {
        const expected = cache.loadOutputFilesBatch([hash]).get(hash) ?? []
        if (expected.length > 0) {
          // Two namespaces in the rows: bare rels are project outputs,
          // `workspace-outputs/<rel>` rows anchor at the workspace root.
          const projExpected = expected.filter((e) => !e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
          const wsExpected = expected
            .filter((e) => e.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
            .map((e) => ({ ...e, path: e.path.slice(WORKSPACE_OUTPUT_PREFIX.length) }))
          const actualAbs = await resolveOutputs({
            projectDir: node.projectDir,
            outputs,
            nestedProjectDirs: args.nestedProjectDirs,
          })
          const actualWsAbs = await resolveWorkspaceOutputs({
            workspaceRoot: args.workspaceRoot,
            outputs: wsOutputs,
          })
          const setsMatch = (
            actual: readonly string[],
            exp: ReadonlyArray<{ path: string }>,
          ): boolean => {
            const expSet = new Set(exp.map((e) => e.path))
            return actual.length === expSet.size && actual.every((r) => expSet.has(r))
          }
          const actualRels = actualAbs.map((p) =>
            path.relative(node.projectDir, p).split(path.sep).join('/'),
          )
          const actualWsRels = actualWsAbs.map((p) =>
            path.relative(args.workspaceRoot, p).split(path.sep).join('/'),
          )
          if (setsMatch(actualRels, projExpected) && setsMatch(actualWsRels, wsExpected)) {
            skipRestore =
              (await cache.isOutputsCurrent(node.projectDir, projExpected)) &&
              (await cache.isOutputsCurrent(args.workspaceRoot, wsExpected))
          }
        }
      }
      if (!skipRestore) {
        let cleanedRels: string[] = []
        let cleanedWsRels: string[] = []
        if (outputs.length > 0) cleanedRels = await cleanOutputs(cleanArgs)
        if (wsOutputs.length > 0) cleanedWsRels = await cleanWorkspaceOutputs(wsCleanArgs)
        await cache.restoreOutputs(hash, node.projectDir, args.workspaceRoot)
        // Restored outputs changed the project's tree — but on this
        // path we know the EXACT changed paths (wiped declared
        // outputs + the artifact's files). Record them instead of
        // dropping the snapshot; downstream same-project tasks only
        // re-spawn git when their input globs can actually see one of
        // these paths. The cache-miss save path below keeps the
        // unconditional drop (an executed task may write undeclared
        // files only git can see).
        if (outputs.length > 0) {
          args.gitFilesCache?.markOutputsChanged(node.projectDir, [
            ...cleanedRels,
            ...hit.outputFiles.filter((p) => !p.startsWith(WORKSPACE_OUTPUT_PREFIX)),
          ])
        }
        if (wsOutputs.length > 0) {
          args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, [
            ...cleanedWsRels,
            ...hit.outputFiles
              .filter((p) => p.startsWith(WORKSPACE_OUTPUT_PREFIX))
              .map((p) => p.slice(WORKSPACE_OUTPUT_PREFIX.length)),
          ])
        }
      }
      if (hit.stdout) log.taskStdout(node, hit.stdout)
      const status =
        hit.exitCode !== 0 ? 'failed' : hit.source === 'remote' ? 'cache-hit-remote' : 'cache-hit'
      // `restored` distinguishes "we just wrote files to disk" from
      // "disk already matched the cached snapshot". Drives the
      // "up-to-date" vs "local-cache" / "remote-cache" label in the
      // framed block. Only meaningful when at least one output was
      // declared — no-outputs tasks never materialize anything, so
      // they're vacuously up-to-date.
      const restored = !skipRestore && anyOutputs
      return {
        node,
        status,
        exitCode: hit.exitCode,
        durationMs: Math.round(performance.now() - cacheOpStart),
        hash,
        restored,
      }
    }
  }

  // Cache miss path (or caching disabled). Clean declared outputs
  // before exec so a stale prior-build artifact can't survive into a
  // fresh run. Gated on WRITES: a no-write policy (`--no-cache`) leaves
  // the user's tree alone (they're debugging); a write-but-no-read
  // policy (`--force`) wipes so the saved snapshot is clean.
  if (willWrite && outputs.length > 0) await cleanOutputs(cleanArgs)
  if (willWrite && wsOutputs.length > 0) {
    // Root-anchored deletions can land in other projects' dirs; mark
    // them so stale per-project git snapshots can't survive the wipe.
    const cleanedWsRels = await cleanWorkspaceOutputs(wsCleanArgs)
    args.gitFilesCache?.markWorkspaceOutputsChanged(args.workspaceRoot, cleanedWsRels)
  }

  const env = taskEnv(node, step)
  const wallclockStartNs = process.hrtime.bigint() - args.runStartHrTimeNs

  // Sandbox is opt-in per task via `sandbox: {}` (or `sandbox: {...}`)
  // in the task config. No CLI flag, no workspace inheritance — the
  // task config is the single source of truth.
  const useSandbox = cfg.sandbox !== undefined
  let violations: SandboxViolation[] = []
  const result = useSandbox ? await runSandboxedTask() : await runUnsandboxedTask()

  async function runUnsandboxedTask(): ReturnType<typeof runCommand> {
    return runCommand({
      command: step.command,
      cwd: node.projectDir,
      env,
      forwardArgs: effectiveForwardArgs,
      onStdout: (chunk) => log.taskStdout(node, chunk),
      onStderr: (chunk) => log.taskStderr(node, chunk),
      ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
      ...(step.timeout !== undefined ? { timeoutMs: step.timeout } : {}),
    })
  }

  async function runSandboxedTask(): ReturnType<typeof runCommand> {
    // Baseline allowRead = resolved cache.inputs.files (absolute paths)
    // Baseline allowWrite = static prefix of every cache.outputs.files glob
    // Baseline denyRead = the workspace root, so any read outside the
    //   project's declared inputs trips the deny boundary.
    // The user's sandbox block extends each list with explicit additions.
    const resolved = await resolveInputs({
      projectDir: node.projectDir,
      workspaceRoot: args.workspaceRoot,
      envSource: process.env,
      inputs: cacheCfg?.inputs,
      ownOutputs: outputs,
      ownWorkspaceOutputs: wsOutputs,
      nestedProjectDirs: args.nestedProjectDirs,
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
      ...(args.hashCache !== undefined
        ? {
            runtimeCache: args.hashCache.runtime,
            workspaceRuntimeCache: args.hashCache.workspaceRuntime,
          }
        : {}),
    })
    const baseAllowWrite = [
      ...outputs.map((g) => path.join(node.projectDir, staticPrefix(g))),
      // Workspace outputs anchor their write prefixes at the root.
      ...wsOutputs.map((g) => path.join(args.workspaceRoot, staticPrefix(g))),
    ]
    // bwrap can't --bind a non-existent host path; the bind silently
    // becomes a no-op (or a tmpfs that evaporates on exit), and writes
    // to the path appear to succeed inside the sandbox but never land
    // on the host. Pre-create every output path so the binds resolve
    // to real fs entries: globbed outputs (`dist/**`) become empty
    // dirs; literal outputs (`out.txt`) become empty files.
    await prepareOutputsForBind(node.projectDir, outputs)
    await prepareOutputsForBind(args.workspaceRoot, wsOutputs)
    // Output paths are read+write — a task that declares `dist/**` as
    // output expects to read what it just wrote (e.g. `touch dist/x`
    // stats the file; `tsc --incremental` re-reads .tsbuildinfo). This
    // isn't magic — the user already declared these paths; we're just
    // honoring the natural read-write symmetry of an output directory.
    const sandboxResult = await runSandboxed({
      command: step.command,
      cwd: node.projectDir,
      env,
      forwardArgs: effectiveForwardArgs,
      onStdout: (chunk) => log.taskStdout(node, chunk),
      onStderr: (chunk) => log.taskStderr(node, chunk),
      ...(args.liveChildren !== undefined ? { liveChildren: args.liveChildren } : {}),
      ...(step.timeout !== undefined ? { timeoutMs: step.timeout } : {}),
      baseAllowRead: [...resolved.files, ...baseAllowWrite],
      baseAllowWrite,
      baseDenyRead: [args.workspaceRoot],
      config: resolveSandboxConfig(cfg.sandbox ?? {}, node.projectDir),
    })
    violations = sandboxResult.violations
    const { violations: _v, ...runResult } = sandboxResult
    return runResult
  }

  const wallclockEndNs = process.hrtime.bigint() - args.runStartHrTimeNs

  // Fail-on-violation. macOS's structured violation store lets us turn
  // a passing exit code into a failure when the task tripped the
  // boundary; Linux relies on the child failing naturally on ENOENT,
  // so violations.length is always 0 there but the task will already
  // be exit != 0 if it needed the missing file.
  //
  // Violations are surfaced via `TaskOutcome.sandboxViolationLines` so
  // the framed-output renderer can show them inline in the task's
  // block, not as loose status output above it.
  let effectiveExitCode = result.exitCode
  let effectiveStderr = result.stderr
  if (violations.length > 0) {
    if (effectiveExitCode === 0) effectiveExitCode = 1
    // Mirror into stderr for cache-persist + structured consumers; the
    // framed-output block reads from sandboxViolationLines directly.
    effectiveStderr += '\n[vx] sandbox violations:\n'
    for (const v of violations) effectiveStderr += `  ${v.line}\n`
  }

  // A child we SIGTERMed for exceeding `exec.timeout` is a genuine
  // failure (timed out) — stream a clear line into the framed block so
  // the 143 exit reads as a timeout, and fall through to the normal
  // exit-code path (failed, never cached).
  if (result.timedOut) {
    log.taskStderr(node, `\n[vx] timed out after ${step.timeout}ms — killed (SIGTERM)\n`)
  }

  // A child killed by a shutdown signal (Ctrl-C / SIGTERM teardown)
  // never finished on its own terms — revert it to aborted so it's
  // neither cached, counted, nor shown. SIGKILL (OOM, forced) stays a
  // real failure. A timeout also SIGTERMs, but `timedOut` marks it as
  // our own deadline, not a shutdown — so it stays a real failure.
  if ((result.signal === 'SIGINT' || result.signal === 'SIGTERM') && !result.timedOut) {
    return {
      node,
      status: 'aborted',
      exitCode: effectiveExitCode,
      durationMs: result.durationMs,
      hash,
      wallclockStartNs,
      wallclockEndNs,
    }
  }

  if (effectiveExitCode === 0 && willWrite) {
    const outputFiles = await resolveOutputs({
      projectDir: node.projectDir,
      outputs,
      nestedProjectDirs: args.nestedProjectDirs,
    })
    const wsOutputFiles = await resolveWorkspaceOutputs({
      workspaceRoot: args.workspaceRoot,
      outputs: wsOutputs,
    })
    await cache.save({
      hash,
      projectDir: node.projectDir,
      outputFiles,
      ...(wsOutputFiles.length > 0
        ? { workspaceOutputFiles: wsOutputFiles, workspaceRoot: args.workspaceRoot }
        : {}),
      entry: {
        taskId: node.id,
        command: step.command,
        exitCode: effectiveExitCode,
        durationMs: result.durationMs,
        stdout: result.stdout,
      },
    })
    // This task just wrote outputs to the project's tree. Record the
    // exact declared-output paths as changed (same as the cache-hit
    // restore path) instead of dropping the whole snapshot: a downstream
    // same-project task then re-spawns git ONLY when its input globs can
    // actually see one of these paths. On a 1000-package cold run this
    // removes ~one synchronous `git ls-files` spawn per project (the
    // single largest cold-run cost — 22% of CPU in profiling). Contract:
    // outputs must be declared — an executed task that writes files
    // outside `cache.outputs.files` which a same-project downstream task
    // reads is undeclared behavior (the restore path already assumes it).
    if (outputFiles.length > 0) {
      args.gitFilesCache?.markOutputsChanged(
        node.projectDir,
        outputFiles.map((p) => path.relative(node.projectDir, p).split(path.sep).join('/')),
      )
    }
    // Declared workspace outputs may have landed inside OTHER
    // projects' dirs (no-boundary escape hatch) — mark the exact
    // paths against every partition that can see them.
    if (wsOutputFiles.length > 0) {
      args.gitFilesCache?.markWorkspaceOutputsChanged(
        args.workspaceRoot,
        wsOutputFiles.map((f) => path.relative(args.workspaceRoot, f).split(path.sep).join('/')),
      )
    }
    // The workspace-wide partition (when one exists) spans this
    // project's subtree, so it inherits the same "undeclared writes
    // are only visible to git" rule as the project drop above.
    if (outputFiles.length + wsOutputFiles.length > 0) {
      args.gitFilesCache?.invalidateWorkspacePartition()
    }
  }

  return {
    node,
    status: effectiveExitCode === 0 ? 'success' : 'failed',
    exitCode: effectiveExitCode,
    durationMs: result.durationMs,
    hash,
    ...(result.cpuMs !== undefined ? { cpuMs: result.cpuMs } : {}),
    ...(result.peakRssBytes !== undefined ? { peakRssBytes: result.peakRssBytes } : {}),
    wallclockStartNs,
    wallclockEndNs,
    ...(violations.length > 0
      ? {
          sandboxViolations: violations.length,
          sandboxViolationLines: violations.map((v) => v.line),
        }
      : {}),
  }
}

/**
 * Ensure each declared output path exists on the host as either an
 * empty file (for literal output specs) or a directory (for globbed
 * specs) so bwrap's --bind can find a real fs entry to mount. Without
 * this, writes inside the sandbox to a non-existent allowWrite path
 * silently disappear (bwrap creates a tmpfs that evaporates on exit).
 *
 * `cleanOutputs` ran just before this in the cache-enabled path, so
 * we know any stale content was wiped; what's left is to materialize
 * the empty skeleton.
 */
async function prepareOutputsForBind(
  projectDir: string,
  outputs: readonly string[],
): Promise<void> {
  for (const g of outputs) {
    const hasWildcard = /[*?[\]]/.test(g)
    if (hasWildcard) {
      const abs = path.join(projectDir, staticPrefix(g))
      await mkdir(abs, { recursive: true })
    } else {
      const abs = path.join(projectDir, g)
      await mkdir(path.dirname(abs), { recursive: true })
      const f = Bun.file(abs)
      if (!(await f.exists())) await Bun.write(abs, '')
    }
  }
}

/**
 * Return the longest prefix of a glob that contains no wildcards. Used
 * to derive an allowWrite path from each `cache.outputs.files` entry:
 * `dist/**` → `dist`, `build/output.js` → `build/output.js`, `**` →
 * `.` (the project dir itself). bwrap binds at the directory level so
 * a file path covers writes to that file; a dir path covers writes
 * anywhere underneath.
 */
function staticPrefix(glob: string): string {
  const wildcardIdx = glob.search(/[*?[\]]/)
  if (wildcardIdx === -1) return glob
  // Trim back to the last separator before the wildcard so we keep
  // only complete path components (e.g. `dist/sub-**` → `dist`, not
  // `dist/sub-`).
  const head = glob.slice(0, wildcardIdx)
  const lastSep = head.lastIndexOf('/')
  if (lastSep === -1) return '.'
  return head.slice(0, lastSep) || '/'
}

/**
 * Build the child-process env for one task. Same arguments at every
 * call site (persistent + cached); the project's own
 * `node_modules/.bin` is prepended to PATH — never the workspace
 * root's, never sibling projects' (per the project-isolation rule).
 */
function taskEnv(node: TaskNode, step: ExecConfig): NodeJS.ProcessEnv {
  return buildIsolatedEnv({
    passThrough: step.env?.passThrough ?? [],
    define: step.env?.define ?? {},
    source: process.env,
    binPaths: [path.join(node.projectDir, 'node_modules', '.bin')],
  })
}
