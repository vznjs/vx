// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs from parent process.env (value
//     undefined for an unset name)
//
// `cache.inputs.env` is the cache-tracking axis for env vars; it's
// independent of `exec.env`, which controls what reaches the child.
//
// File enumeration defers to git — same as Turbo and Nx. git-inputs.ts
// asks for the tracked set with `git ls-files -s -v` (index OIDs and the
// skip-worktree flag in the same spawn) and for the dirty and untracked
// paths with `git status -uall`, with nested .gitignore, .git/info/exclude
// and the global excludes applied because git already does the cascade.
// The user's `inputs.files` globs are then matched as a *filter* on top
// of that file set. vx requires git to be installed and the workspace to
// be a git work tree; non-git environments are not supported.

import path from 'node:path'
import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync } from 'node:fs'
import { rm, rmdir } from 'node:fs/promises'
import type { CacheConfig, CacheInputs } from '../config.js'
import {
  anyTaskGlob,
  asTrees,
  isExecutableMissing,
  isInstalledPath,
  isLiteralPattern,
  normalizeGlob,
  outputMatcher,
  relPosix,
  shellArgv,
  slashBraceExpansions,
  splitNegations,
  staticPrefix,
  taskGlob,
  UserError,
} from '../util/index.js'
import { GitFilesCache, runGitLsFiles } from './git-inputs.js'
import { FILE_HASH_RACY_MS, racyWindowMs } from './layer.js'

// The git side lives in git-inputs.ts; its whole public surface is
// re-exported here so a reader that reaches the resolver for it (the
// tests do, by deep import) keeps working.
export {
  GitFilesCache,
  populateGitFilesCache,
  runGitLsFiles,
  startGitEnumeration,
  applyGitEnumeration,
  gitPathspecs,
  parseCheckAttrOutput,
  autocrlfConverts,
  gitStatWeakened,
  attributeFilesOutsideTree,
  type GitEnumeration,
} from './git-inputs.js'

// vx-lock.json is committed (so git enumerates it) but it's vx's own
// frozen-config metadata — never a task input. Excluded globally so a
// re-lock can't bust every cache key the way a tracked source file
// would. (Literal pattern, not the workspace `LOCKFILE_NAME` constant:
// cache is a leaf module and must not import from workspace.)
//
// `node_modules` is not here: the enumeration drops an untracked file
// under one (`isInstalledPath`), and a tracked one is a source.
const ALWAYS_IGNORE = [
  // Defense in depth, and measured as exactly that (item 497): git never
  // reports a path under `.git`, so dropping this line changes NOTHING on
  // any route into the input set. Probed three ways with the pattern in
  // and out — a tracked `**/*` glob, an UNTRACKED one, and a literal
  // `inputs.files: ['.git/HEAD']` (refused by the git-reports-it check,
  // not by this list) — all identical, while the control in the same
  // fixture showed an untracked ORDINARY file does enter the set. So the
  // enumeration is the live guard and this is the backstop; every other
  // member of this list is load-bearing and has a row that fails without
  // it. Kept: the day an enumeration stops going through git, this is
  // what keeps a repository's object store out of a cache key.
  '**/.git/**',
  '**/.vx/**',
  '**/*.tsbuildinfo',
  '**/vx-lock.json',
  // `bun build --compile` writes a transient `.<hash>-<n>.bun-build` intermediate
  // in the cwd. It never rests on disk, so it can't be a real input — but a
  // broad `inputs.files: ['**/*']` on a compile task would try to hash the temp
  // file that a CONCURRENT compile is mid-write, racing to EACCES/ENOENT. Always
  // exclude it (vx is Bun-native; compiling standalone binaries is a common task).
  '**/*.bun-build',
  // …and, cross-compiling for a target its cache lacks, the directory it
  // extracts the downloaded runtime into, `<cwd>/.<16 hex>-<8 hex>.tmp/`,
  // 60 MB mid-write under the same race (2026-09-29).
  '**/.????????????????-????????.tmp/**',
]

const DEFAULT_FILE_GLOBS: readonly string[] = ['**/*']

export interface ResolvedInputs {
  files: string[]
  /** What `files` was filtered from, for {@link addedInput}. */
  listings: InputListing[]
  envValues: Array<[name: string, value: string | undefined]>
  runtimeValues: Array<[command: string, output: string]>
  workspaceRuntimeValues: Array<[command: string, output: string]>
}

export interface ResolveInputsArgs {
  projectDir: string
  workspaceRoot: string
  envSource: NodeJS.ProcessEnv
  inputs: CacheInputs | undefined
  /** Project-relative output globs to exclude from inputs. */
  ownOutputs: string[]
  /** Root-relative `outputs.workspaceFiles` globs to exclude from
   *  `inputs.workspaceFiles` (a task cannot invalidate itself). */
  ownWorkspaceOutputs?: string[]
  /** Absolute dirs of nested projects (cross-boundary isolation). */
  nestedProjectDirs: string[]
  /**
   * Per-run memo for `git ls-files` output. The same project's file
   * list is asked for once per task (build + test + …) — without
   * memoization we spawn git 3× per project per run. The orchestrator
   * passes a fresh Map at the top of every `vx run`.
   */
  gitFilesCache?: GitFilesCache
  /**
   * Run-scoped memo for `cache.inputs.runtime` command execution, keyed
   * by `projectDir + '\0' + command`. Shared across a run's tasks so a
   * project's command runs once even across build/test/lint and across
   * the hash + sandbox-baseline resolveInputs calls. The key is sound
   * ONLY because the probe runs in vx's own ambient environment, never a
   * task's `exec.env` (`runRuntimeCommand`): two tasks with different
   * `define`s share one value. Threading the task env in would have to
   * widen this key too, or task A's probe becomes task B's key component.
   */
  runtimeCache?: Map<string, Promise<string>>
  /**
   * Run-scoped memo for `cache.inputs.workspaceRuntime`, keyed by command
   * only — global dedup so a root-level probe spawns once per run.
   */
  workspaceRuntimeCache?: Map<string, Promise<string>>
  /**
   * Answer this task's probes apart from every other task's, in both memos
   * above: the probes may read what its upstream wrote this run, so an
   * answer another task took before that write is not this task's (X-34).
   * The task id.
   */
  runtimeScope?: string
  /**
   * Run-scoped memo for `cache.inputs.workspaceFiles`, keyed by the
   * declaration and valid for one enumeration snapshot. A Turbo-mapped
   * workspace gives every task the same `globalDependencies`, and
   * resolving one literal against medusa's 24k-file enumeration per task
   * was 930 ms of a 3.0 s warm no-op (159 scans, 2026-09-11).
   */
  workspaceFilesCache?: WorkspaceFilesCache
  /** Per-run memo for `inputs.files`; see `ProjectFilesCache`. */
  projectFilesCache?: ProjectFilesCache
}

export type WorkspaceFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: Promise<string[]> }
>

/**
 * Per-run memo of `cache.inputs.files` resolution, keyed by the project and
 * the DECLARATION — tasks of one project that declare the same inputs and
 * the same outputs resolve to the same list, and this repo's own config is
 * the shape that pays for it: twelve shard tasks, each declaring the same
 * whole-tree glob over the same three thousand files (measured 1.2 ms of
 * resolution per task, 2026-09-20).
 *
 * Reuse is gated on the git snapshot being the SAME ARRAY the entry was
 * built from, not on equal contents: a mid-run re-enumeration replaces it
 * (`GitFilesCache.set`), so a task whose inputs a previous task rewrote
 * misses the memo and walks again. Same discipline as WorkspaceFilesCache
 * above.
 */
export type ProjectFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: readonly string[] }
>

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  const { files: projectFiles, listing } = await resolveFiles({
    projectDir: args.projectDir,
    workspaceRoot: args.workspaceRoot,
    files: args.inputs?.files,
    ownOutputs: args.ownOutputs,
    nestedProjectDirs: args.nestedProjectDirs,
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    ...(args.projectFilesCache !== undefined ? { projectFilesCache: args.projectFilesCache } : {}),
  })
  let files = projectFiles
  const listings = listing === undefined ? [] : [listing]
  const wsDecl = args.inputs?.workspaceFiles
  if (wsDecl !== undefined && wsDecl.length > 0) {
    const ws = resolveWorkspaceFiles({
      workspaceRoot: args.workspaceRoot,
      workspaceFiles: wsDecl,
      ownWorkspaceOutputs: args.ownWorkspaceOutputs ?? [],
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
      ...(args.workspaceFilesCache !== undefined ? { memo: args.workspaceFilesCache } : {}),
    })
    if (ws !== undefined) listings.push(ws.listing)
    const wsFiles = ws === undefined ? [] : await ws.files
    // Dedupe: when the project dir IS the workspace root (or a glob
    // overlaps), the same absolute path can arrive via both lists —
    // it must contribute to the key exactly once.
    if (wsFiles.length > 0) files = [...new Set([...projectFiles, ...wsFiles])].sort()
  }
  // Two awaited empty resolutions per task were ~3 ms of a 1000-task warm
  // run (profiled 2026-09-09); a task declaring neither skips the fan-out.
  const runtimeDecl = args.inputs?.runtime ?? []
  const wsRuntimeDecl = args.inputs?.workspaceRuntime ?? []
  const [runtimeValues, workspaceRuntimeValues] =
    runtimeDecl.length === 0 && wsRuntimeDecl.length === 0
      ? [[], []]
      : await Promise.all([
          resolveRuntimeValues(
            runtimeDecl,
            args.projectDir,
            projectBinDirs(args.projectDir, args.workspaceRoot),
            args.runtimeCache,
            args.runtimeScope === undefined
              ? `${args.projectDir}\0`
              : `${args.projectDir}\0${args.runtimeScope}\0`,
          ),
          resolveRuntimeValues(
            wsRuntimeDecl,
            args.workspaceRoot,
            [path.join(args.workspaceRoot, 'node_modules', '.bin')],
            args.workspaceRuntimeCache,
            args.runtimeScope === undefined ? '' : `\0${args.runtimeScope}\0`,
          ),
        ])
  return {
    files,
    listings,
    envValues: resolveEnvValues(args.inputs?.env ?? [], args.envSource),
    runtimeValues,
    workspaceRuntimeValues,
  }
}

/**
 * Resolve `cache.inputs.workspaceFiles` — workspace-root-relative
 * globs matched against the workspace-wide git file set (tracked +
 * untracked-not-ignored, same visibility as project inputs).
 *
 * Deliberately NO project-boundary rule: a workspaceFiles glob may
 * match files inside any project's directory. This is the documented
 * escape hatch for root-level shared inputs (root tsconfig, shared
 * codegen); the hard boundary continues to apply to project-relative
 * `files` globs only.
 */
function resolveWorkspaceFiles(args: {
  workspaceRoot: string
  workspaceFiles: readonly string[]
  ownWorkspaceOutputs: readonly string[]
  gitFilesCache?: GitFilesCache
  memo?: WorkspaceFilesCache
}): { files: Promise<string[]>; listing: InputListing } | undefined {
  const positive: string[] = []
  const negative: string[] = []
  refuseOneAlternativeBrace(args.workspaceFiles, 'workspaceFiles')
  for (const entry of args.workspaceFiles) {
    if (entry.startsWith('!')) negative.push(entry.slice(1))
    else positive.push(entry)
  }
  if (positive.length === 0) return undefined

  const isExcluded = anyTaskGlob([...ALWAYS_IGNORE, ...asTrees(negative)])
  // A path the task's own outputs take back with `!` is no output, so it
  // stays an input (A-44).
  const ownOutput = outputMatcher(args.ownWorkspaceOutputs)
  const positiveGlobs = asTrees(positive).map(globFor)
  // Workspace-wide partition, keyed by the workspace root. Populated
  // up-front by `populateGitFilesCache(..., workspaceWide: true)` when
  // any loaded task declares workspaceFiles; a missing/invalidated
  // partition re-spawns git at the root on demand.
  let gitFiles = args.gitFilesCache?.snapshotFor(args.workspaceRoot, positiveGlobs)
  let undecodable = args.gitFilesCache?.undecodableNames
  if (gitFiles === undefined) {
    const ls = runGitLsFiles(args.workspaceRoot)
    gitFiles = ls.files
    args.gitFilesCache?.set(args.workspaceRoot, gitFiles)
    undecodable = noteUndecodable(args.gitFilesCache, args.workspaceRoot, ls.undecodable)
  }
  // The memo is valid for the snapshot it was computed over: a task that
  // wrote workspace outputs mid-run replaces the partition, and the next
  // caller sees a different array and scans again.
  const memoKey =
    args.memo === undefined
      ? undefined
      : JSON.stringify([positive, negative, args.ownWorkspaceOutputs])
  let isPositive: ((rel: string) => boolean) | undefined
  const excluded = (rel: string): boolean => isExcluded(rel) || ownOutput(rel)
  const listing: InputListing = {
    root: args.workspaceRoot,
    listed: gitFiles,
    isInput: (rel) => (isPositive ??= anyTaskGlob(asTrees(positive)))(rel) && !excluded(rel),
    nested: () => false,
    ...reachOf(positive),
  }
  if (memoKey !== undefined) {
    const hit = args.memo!.get(memoKey)
    if (hit !== undefined && hit.snapshot === gitFiles) return { files: hit.result, listing }
  }
  isPositive ??= anyTaskGlob(asTrees(positive))
  const result = resolveWorkspaceFilesOver(
    args,
    gitFiles,
    positive,
    isPositive,
    excluded,
    undecodable,
  )
  if (memoKey !== undefined) args.memo!.set(memoKey, { snapshot: gitFiles, result })
  return { files: result, listing }
}

async function resolveWorkspaceFilesOver(
  args: { workspaceRoot: string; gitFilesCache?: GitFilesCache },
  gitFiles: readonly string[],
  positive: readonly string[],
  isPositive: (rel: string) => boolean,
  excluded: (rel: string) => boolean,
  undecodable: ReadonlySet<string> | undefined,
): Promise<string[]> {
  // Second call site of the literal-input guard. `resolveWorkspaceFiles`
  // carries its own copy of the filter-over-git-set design, so the same
  // silently-folds-nothing hazard exists here — and a fix applied only to the
  // project half would pass that half's tests while leaving this one live.
  const unmatchedLiterals = unanswered(
    positive.map(normalizeGlob).filter(isLiteralPattern).map(stripTrailingSlash),
    gitFiles,
  )
  const candidates: string[] = []
  for (const rel of gitFiles) {
    if (!isPositive(rel)) continue
    if (excluded(rel)) continue
    candidates.push(path.resolve(args.workspaceRoot, rel))
  }
  if (unmatchedLiterals.size > 0) {
    await assertNoInvisibleLiteralInputs(unmatchedLiterals, args.workspaceRoot, 'workspaceFiles')
  }
  refuseUndecodable(candidates, undecodable, args.workspaceRoot, 'workspaceFiles')
  // Same OID-trust shortcut as project files: a clean-per-status
  // tracked file necessarily exists on disk.
  const oids = args.gitFilesCache?.oidsFor(args.workspaceRoot)
  return candidates.filter((abs) => oids?.has(abs) === true || isInputOnDisk(abs)).sort()
}

/** Anything at the path — file, directory, symlink to anything or to nothing. */
function existsOnDisk(abs: string): boolean {
  try {
    lstatSync(abs)
    return true
  } catch {
    return false
  }
}

/**
 * What an enumerated path must be to count as an input: a regular file, or
 * a symlink (to anything, or to nothing — its target STRING is what folds,
 * as in git). A directory is not one: git lists a gitlink (a submodule) at
 * its path and the glob `**\/*` matches it, and the hasher has nothing to
 * read there. `Bun.file(p).exists()` answered false for every symlink to a
 * directory and every dangling link too, which silently dropped a tracked
 * link from the key — retargeting it was a stale hit. lstat, synchronously:
 * the paths that reach this probe are the ones without a trusted index OID
 * (untracked and dirty files), a handful on a warm run.
 */
function isInputOnDisk(abs: string): boolean {
  try {
    const st = lstatSync(abs)
    return st.isFile() || st.isSymbolicLink()
  } catch {
    return false
  }
}

/** The task's `node_modules/.bin` directories, as `taskBinDirs` gives its PATH. */
function projectBinDirs(projectDir: string, workspaceRoot: string): string[] {
  const own = path.join(projectDir, 'node_modules', '.bin')
  const root = path.join(workspaceRoot, 'node_modules', '.bin')
  return own === root ? [own] : [own, root]
}

function resolveEnvValues(
  names: readonly string[],
  source: NodeJS.ProcessEnv,
): Array<[string, string | undefined]> {
  return [...names].sort().map((name) => [name, source[name]])
}

/**
 * Run one runtime-input command via `sh -c` (so pipelines / redirects
 * work — "shell is the API"). Returns trimmed stdout+stderr. A non-zero
 * exit is a hard UserError naming the command (fail-loud, like git).
 *
 * The probe inherits vx's AMBIENT environment on purpose — not the task's
 * `exec.env.define` / `passThrough`, which describe the command's
 * environment, not the machine's. That is what lets the run-scoped memo
 * key on (projectDir, command) alone; see `runtimeCache`.
 *
 * Its PATH does lead with the task's own `node_modules/.bin` directories
 * (`binDirs`), as the task's does: `tsc --version` otherwise keyed the
 * global tsc while the task ran the workspace's, and a changed local tool
 * replayed the old output (item 996).
 */
async function runRuntimeCommand(
  command: string,
  cwd: string,
  binDirs: readonly string[],
  owner: RuntimeMemo | undefined,
): Promise<string> {
  const ambient = process.env['PATH']
  // As the task's PATH does (exec/env.ts): a dir holding the delimiter
  // splits into an entry relative to the probe's cwd.
  const PATH = [...binDirs.filter((dir) => !dir.includes(path.delimiter)), ambient]
    .filter((entry) => entry)
    .join(path.delimiter)
  let proc
  try {
    // vx's own `sh`, resolved on its PATH before the probe's: Bun.spawn looks
    // a bare name up on the child's PATH, which leads with the project's
    // `node_modules/.bin`, so a dependency's `sh` bin ran every probe (J-69).
    proc = Bun.spawn(shellArgv(command), {
      cwd,
      env: { ...process.env, PATH },
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
      // Its own group, so the probe's whole tree can be taken down with vx
      // (`killProbesOnExit`).
      detached: true,
    })
  } catch (err) {
    // The probe runs through `sh -c` like a task: a box without sh names
    // the shell, not the command (item 244).
    if (isExecutableMissing(err)) {
      throw new UserError(
        `cache.inputs runtime command could not run: vx runs it with sh -c and 'sh' is not on PATH (command: ${command}, cwd: ${cwd}). Install a POSIX sh and re-run.`,
      )
    }
    throw new UserError(`cache.inputs runtime command failed to spawn: ${command} (cwd: ${cwd})`)
  }
  liveProbes.add(proc)
  let mine: Set<ReturnType<typeof Bun.spawn>> | undefined
  if (owner !== undefined) {
    mine = probesOf.get(owner) ?? new Set()
    probesOf.set(owner, mine)
    mine.add(proc)
  }
  killProbesOnExit()
  let stdout, stderr, exitCode
  try {
    ;[stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).bytes(),
      new Response(proc.stderr).bytes(),
      proc.exited,
    ])
  } finally {
    liveProbes.delete(proc)
    mine?.delete(proc)
  }
  if (exitCode !== 0) {
    const lossy = new TextDecoder()
    const shown = `${lossy.decode(stdout)}${lossy.decode(stderr)}`.trim()
    throw new UserError(
      `cache.inputs runtime command exited ${exitCode}: ${command} (cwd: ${cwd})` +
        (shown ? `\n${shown}` : ''),
    )
  }
  let out: string
  let err: string
  try {
    out = FATAL_UTF8.decode(stdout)
    err = FATAL_UTF8.decode(stderr)
  } catch {
    // A lossy decode keys every invalid byte as U+FFFD: Latin-1 é and è
    // folded the same output and replayed each other's build.
    throw new UserError(
      `cache.inputs runtime command printed bytes that are not UTF-8: ${command} (cwd: ${cwd}). ` +
        `Pipe it through a hash or od.`,
    )
  }
  return probeOutput(out, err)
}

/**
 * The probe's output as the key folds it. Plain concatenation keyed stdout
 * `ab` and stdout `a` + stderr `b` alike. A probe with no stderr and no NUL
 * folds its trimmed stdout, as before; any other is framed with a leading
 * NUL and stdout's length, a form no unframed output takes.
 */
function probeOutput(stdout: string, stderr: string): string {
  const out = stdout.trim()
  const err = stderr.trim()
  if (err === '' && !out.includes('\0')) return out
  return `\0${out.length}\0${out}${err}`
}

/**
 * Runtime probes still running. A probe that outlives its answer's need — a
 * run stopped by Ctrl-C, or ended by a refusal, while `node -e …` or a hung
 * `git` still ran — was left behind: vx exited and the probe's shell and
 * what it started ran on under init (A-9). Every probe is its own group, and
 * the ones still listed when vx exits are SIGKILLed with their trees. A
 * `kill -9` of vx runs no exit hook; that residual is the task groups' guard's
 * (exec/kill-tree.ts), which probes are not on.
 */
const liveProbes = new Set<ReturnType<typeof Bun.spawn>>()
let probeExitHooked = false

type RuntimeMemo = Map<string, Promise<string>>
/** The probes each run started, by the run's memo: one run's stop is not another's. */
const probesOf = new WeakMap<RuntimeMemo, Set<ReturnType<typeof Bun.spawn>>>()

/**
 * Kill every runtime probe still running that these memos (one run's
 * `runtimeCache` and `workspaceRuntimeCache`) started, with its tree. A
 * run's stop asks this: a Ctrl-C while a probe ran waited for the probe,
 * or for the signal handler's bound, about 7 s, before vx exited (C-65).
 * Its answer is no longer needed; its caller sees it fail and the run
 * reads it aborted. Another run in the process keeps its own.
 */
export function stopRuntimeProbes(...memos: readonly RuntimeMemo[]): void {
  for (const memo of memos) {
    for (const p of probesOf.get(memo) ?? []) {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {
        // the group is gone
      }
    }
  }
}
function killProbesOnExit(): void {
  if (probeExitHooked) return
  probeExitHooked = true
  process.on('exit', () => {
    for (const p of liveProbes) {
      try {
        process.kill(-p.pid, 'SIGKILL')
      } catch {
        // the group is gone
      }
    }
  })
}

/**
 * Resolve a list of runtime-input commands to sorted [command, output]
 * pairs. Dedups via the shared `memo` (Promise per key): the first
 * caller fires the spawn, concurrent callers await the same promise.
 * `memoKeyPrefix` namespaces project (`projectDir + '\0'`) vs workspace
 * (`''`) so the two scopes never collide in one map (they're separate
 * maps anyway, but the prefix keeps intent explicit). Distinct commands
 * run concurrently via Promise.all.
 */
async function resolveRuntimeValues(
  commands: readonly string[],
  cwd: string,
  binDirs: readonly string[],
  memo: Map<string, Promise<string>> | undefined,
  memoKeyPrefix: string,
): Promise<Array<[string, string]>> {
  if (commands.length === 0) return []
  const unique = [...new Set(commands)].sort()
  return Promise.all(
    unique.map(async (cmd) => {
      const key = `${memoKeyPrefix}${cmd}`
      let p = memo?.get(key)
      if (p === undefined) {
        p = runRuntimeCommand(cmd, cwd, binDirs, memo)
        memo?.set(key, p)
      }
      return [cmd, await p] as [string, string]
    }),
  )
}

/**
 * What no output glob reaches. An output is otherwise taken as written —
 * `node_modules/**` IS an install task's output, so `ALWAYS_IGNORE` does not
 * apply here — but these two directories no task produces, and a root
 * project declaring `**` would otherwise wipe its repository and the cache
 * it is restoring from (2026-09-16).
 */
const OUTPUT_NEVER = ['**/.git/**', '**/.vx/**']

/**
 * What a set of output globs may not reach: `OUTPUT_NEVER`, and every
 * `node_modules` unless a glob names one. `**\/*.js` meant the build's
 * files, and the clean before each run deleted every installed `.js`
 * under `node_modules` with them (A-13); an install task declares
 * `node_modules/**` and keeps it. Workspace outputs took none of this, not
 * even `.git`.
 */
function outputExcludes(outputs: readonly string[]): Bun.Glob[] {
  const namesNodeModules = outputs.some((o) => normalizeGlob(o).split('/').includes('node_modules'))
  return (namesNodeModules ? OUTPUT_NEVER : [...OUTPUT_NEVER, '**/node_modules/**']).map(globFor)
}

/** Resolve declared output globs (project-relative) to actual produced files. */
export async function resolveOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<string[]> {
  const { positive, negative } = splitNegations(args.outputs)
  if (positive.length === 0) return []
  const excludeGlobs = [...outputExcludes(positive), ...asTrees(negative).map(globFor)]
  const scanned = [
    ...(await scanUnion(
      asTrees(positive),
      excludeGlobs,
      args.projectDir,
      inNestedProject(args.projectDir, args.nestedProjectDirs),
    )),
  ]
  // Containment, enforced HERE and not only at the loader. `cleanOutputs`
  // DELETES whatever this returns, and `Bun.Glob.scan` happily walks `..` out
  // of its cwd — so the loader's `..`/absolute rejection alone was a single
  // point of failure. The resolver that feeds the delete refuses to name a path
  // outside the project, so any future caller reaching it by another route (a
  // programmatic embedder, a config source that skips the loader) is contained
  // by construction.
  return containedIn(args.projectDir, scanned).sort()
}

/**
 * Keep only the paths that are REALLY inside `root` — lexically, and after
 * resolving symlinks.
 *
 * Lexical alone was sufficient only while `Bun.Glob.scan` refused to descend
 * into symlinked directories, which this repo pinned as a deliberate tripwire
 * on a DEPENDENCY's behaviour. **Bun 1.4.0 tripped it**: with `dist ->
 * ../victim` the scan now yields `dist/precious.txt`, a path that is lexically
 * inside the project while the file it names is not — and the caller rm()s
 * whatever this returns. Measured on 1.4.0 before this guard: a plain
 * `outputs.files: ['dist/**']` deleted a file outside the project.
 *
 * DIRECTORIES are what matter, not files: `rm` on a symlinked FILE unlinks the
 * link and never its target, so a link sitting inside a real output directory
 * is harmless. Resolving per directory also keeps this cheap — one syscall per
 * distinct output directory rather than per output file, concurrently, and a
 * `dist/**` of ten thousand files in one directory costs exactly one.
 *
 * A path whose directory will not resolve (a broken link, or a race with the
 * task that produced it) is REFUSED. When the caller deletes, unresolvable
 * means leave it alone.
 */
function containedIn(root: string, paths: readonly string[]): string[] {
  // One `path.dirname` per path, kept alongside — computing it again in the
  // final filter measured as the DOMINANT added cost on a wide output tree
  // (string work, not syscalls: 10k files in 20 dirs cost more than 5k files
  // in 200, which is the wrong shape for a per-directory probe).
  const lexical: string[] = []
  const lexDirs: string[] = []
  for (const p of paths) {
    if (!isInside(root, p)) continue
    lexical.push(p)
    lexDirs.push(path.dirname(p))
  }
  if (lexical.length === 0) return []
  // Sync, as `hashFile`'s lstat: a realpath is microseconds, and the
  // promise round trip per call was most of this function's cost on every
  // miss (B, 2026-09-30).
  const real = (p: string): string | null => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  const realRoot = real(root) ?? root
  const uniqueDirs = [...new Set(lexDirs)]
  const resolved = uniqueDirs.map(real)
  const contained = new Set<string>()
  for (const [i, dir] of uniqueDirs.entries()) {
    const real = resolved[i]
    if (real !== null && real !== undefined && isInside(realRoot, real)) contained.add(dir)
  }
  return lexical.filter((_p, i) => contained.has(lexDirs[i]!))
}

/** Is `abs` the directory `dir` itself or something beneath it? */
function isInside(dir: string, abs: string): boolean {
  if (abs === dir) return true
  return abs.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep)
}

/**
 * Remove every file currently matching the declared output globs in
 * the project dir. Called both before a cache-hit restore (so the
 * restore lands on a clean slate, matching the cached snapshot bit-
 * for-bit) and before a cache-miss exec (so the task's output dir
 * doesn't carry stale stragglers from a prior run).
 *
 * Globs are evaluated against the *current* tree. Files in declared
 * output paths that the user dropped by hand will be removed — that's
 * the contract of declaring something as an output. Nested-project
 * dirs are excluded the same way `resolveOutputs` does, so we never
 * cross a project boundary.
 */
export async function cleanOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
  /**
   * Before a miss: keep the directory each wildcard glob is rooted at
   * (`dist` for `dist/**`). The task writes its matches under it, so a
   * remove there bought only an rmdir and the task's mkdir: 0.4 ms of a
   * 4.9 ms one-file miss (B-49). A restore prunes it, since the entry's
   * shape decides there.
   */
  keepGlobRoots?: boolean
}): Promise<string[]> {
  const files = await resolveOutputs(args)
  // `force: true` makes rm tolerate ENOENT (e.g. when two output
  // globs overlap and a sibling already deleted a path mid-iteration).
  // A symlink is unlinked, never followed.
  const removed = await removeAll(files, args.projectDir)
  await pruneEmptiedDirs(
    args.projectDir,
    removed,
    args.keepGlobRoots === true ? globRoots(args.projectDir, args.outputs) : undefined,
  )
  // Project-relative posix paths of what was removed — the caller
  // feeds these to GitFilesCache.markOutputsChanged after a restore.
  return files.map((f) => relPosix(args.projectDir, f))
}

/**
 * Remove exactly these project-relative paths — the recorded rows of an
 * ADDITIVE task's own artifact (item 588), never a glob: the glob would
 * take the upstream's files the task adds beside. Emptied directories are
 * pruned as `cleanOutputs` prunes them, and stop at one the upstream still
 * fills.
 */
export async function cleanOutputPaths(args: {
  projectDir: string
  rels: readonly string[]
}): Promise<void> {
  const files = args.rels.map((r) => path.resolve(args.projectDir, r))
  await pruneEmptiedDirs(args.projectDir, await removeAll(files, args.projectDir))
}

/**
 * A file's identity for the additive diff: what the hit path's
 * `isOutputsCurrent` trusts too. Size and mtime alone missed a rewrite to
 * bytes of the same length with the mtime stamped back; the inode and
 * ctime are what no task sets (item 886).
 */
export interface OutputStamp {
  size: number
  mtimeMs: number
  ino: number
  ctimeMs: number
}

/**
 * The stamps of every file the declared outputs currently select — taken
 * BEFORE an additive task runs, so what it added or changed can be told
 * from what it found (item 588).
 */
export async function stampOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<Map<string, OutputStamp>> {
  return stampFiles(await resolveOutputs(args))
}

/** `stampOutputs` for root-anchored `cache.outputs.workspaceFiles` (A-43). */
export async function stampWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: string[]
}): Promise<Map<string, OutputStamp>> {
  return stampFiles(await resolveWorkspaceOutputs(args))
}

function stampFiles(files: readonly string[]): Map<string, OutputStamp> {
  const out = new Map<string, OutputStamp>()
  for (const f of files) {
    try {
      const st = lstatSync(f)
      out.set(f, { size: st.size, mtimeMs: st.mtimeMs, ino: st.ino, ctimeMs: st.ctimeMs })
    } catch {
      // Gone between the walk and the stat: not a file the task found.
    }
  }
  return out
}

/**
 * The files an additive task's run ADDED or CHANGED under its declared
 * outputs: every selected file that was not in `before`, or whose stamp
 * (`OutputStamp`) moved — the proof the hit path trusts for a current
 * tree, so no new trust is introduced. A file the run rewrote, even with
 * identical bytes, counts as its own (its ctime moved), which is the
 * rewrite-in-place cost the design note records.
 *
 * Undefined when the run REMOVED a file it found: an artifact holds what a
 * run wrote, never what it took away, and the upstream's restore puts the
 * file back, so no entry reproduces that run and none is saved.
 */
export async function ownOutputsSince(
  args: { projectDir: string; outputs: string[]; nestedProjectDirs: string[] },
  before: ReadonlyMap<string, OutputStamp>,
): Promise<string[] | undefined> {
  return changedSince(await resolveOutputs(args), before)
}

/** `ownOutputsSince` for root-anchored `cache.outputs.workspaceFiles` (A-43). */
export async function ownWorkspaceOutputsSince(
  args: { workspaceRoot: string; outputs: string[] },
  before: ReadonlyMap<string, OutputStamp>,
): Promise<string[] | undefined> {
  return changedSince(await resolveWorkspaceOutputs(args), before)
}

function changedSince(
  after: readonly string[],
  before: ReadonlyMap<string, OutputStamp>,
): string[] | undefined {
  const own: string[] = []
  let kept = 0
  for (const f of after) {
    const was = before.get(f)
    if (was === undefined) {
      own.push(f)
      continue
    }
    try {
      const st = lstatSync(f)
      kept++
      if (
        st.size !== was.size ||
        st.mtimeMs !== was.mtimeMs ||
        st.ino !== was.ino ||
        st.ctimeMs !== was.ctimeMs
      )
        own.push(f)
    } catch {
      // Vanished since the walk: removed, as one the walk missed is.
    }
  }
  return kept < before.size ? undefined : own
}

/**
 * Up to this many paths, a clean removes synchronously: the threadpool round
 * trip per `rm`/`rmdir` cost more than the unlink itself, 0.30 ms against
 * 0.13 for one file and 1.7 against 1.5 for 128 (min of 7). Past a few
 * hundred the parallel async removal wins (512: 4.5 against 5.4).
 */
const SYNC_CLEAN_MAX = 128

/**
 * A declared output the process cannot remove (a `dist/` another user
 * wrote, a read-only checkout) is the environment's failure, not vx's:
 * the scheduler prints any other error as an "internal error", which
 * sends the reader to file a bug against a permission bit.
 */
async function removeAll(all: readonly string[], root: string): Promise<string[]> {
  const files = notThroughLink(all, root)
  const refused = (f: string, err: NodeJS.ErrnoException): UserError => {
    const rel = relPosix(root, f)
    return new UserError(
      `cannot remove declared output ${rel}: ${err.code ?? err.message} — vx clears a task's ` +
        `declared outputs before it runs and before a restore; make the path removable ` +
        `by this user, or stop declaring it as an output`,
    )
  }
  if (files.length <= SYNC_CLEAN_MAX) {
    for (const f of files) {
      try {
        rmSync(f, { force: true })
      } catch (err) {
        throw refused(f, err as NodeJS.ErrnoException)
      }
    }
    return files
  }
  await Promise.all(
    files.map((f) =>
      rm(f, { force: true }).catch((err: NodeJS.ErrnoException) => {
        throw refused(f, err)
      }),
    ),
  )
  return files
}

/**
 * The paths whose directory is really where it sits, not reached through a
 * symlinked directory. A save follows `dist -> real-out` on purpose
 * (turborepo#13042), but a clean through a link deletes the target's
 * files: `public -> static` in the same project took the tracked
 * `static/logo.svg` before every run (X-5). The link is a declared
 * output's own entry; what it leads to is not.
 */
function notThroughLink(files: readonly string[], root: string): string[] {
  const real = (p: string): string | null => {
    try {
      return realpathSync(p)
    } catch {
      return null
    }
  }
  // Resolved only once a directory exists to compare: after a clean pruned
  // the outputs (the common restore) nothing does, and the call was most
  // of an empty clean.
  let realRoot: string | undefined
  const own = new Map<string, boolean>()
  return files.filter((f) => {
    const dir = path.dirname(f)
    let ok = own.get(dir)
    if (ok === undefined) {
      // A directory already gone has nothing to delete through; its path
      // stays so the prune still reaches the parents it emptied.
      const r = real(dir)
      ok =
        r === null || r === path.join((realRoot ??= real(root) ?? root), path.relative(root, dir))
      own.set(dir, ok)
    }
    return ok
  })
}

/**
 * Remove the directories a clean emptied, bottom-up, never `root` itself.
 * A restore writes files where the cached entry has them; a directory left
 * standing where the entry holds a FILE of the same name (a task that once
 * wrote `dist/out/…` and now writes `dist/out`) blocks the rename, and an
 * empty directory is not an output anyone declared. A directory that still
 * holds something — a stray the globs do not cover — stays, and the restore
 * says so if it is in the way.
 */
async function pruneEmptiedDirs(
  root: string,
  removed: readonly string[],
  keep?: ReadonlySet<string>,
): Promise<void> {
  const rootResolved = path.resolve(root)
  // LEVEL ORDER, not a walk-up per directory. A parent is attempted only
  // once every one of its children has had its turn, which is what makes
  // "the last child empties it" work — and it costs ONE rmdir per
  // directory rather than one per directory PER CHILD.
  //
  // Measured (200 dirs x 20 files, min of 7, three interleaved passes):
  // a walk-up with a `tried` memo is 46 ms but leaves an emptied parent
  // standing when a sibling's turn came first; the same walk-up without
  // the memo is correct and 60 ms, because every child re-attempts the
  // shared parent. This is correct at 44 ms.
  let level = new Set(removed.map((f) => path.dirname(f)))
  while (level.size > 0) {
    const parents = new Set<string>()
    const dirs = [...level].filter(
      (dir) =>
        dir !== rootResolved && dir.startsWith(rootResolved + path.sep) && keep?.has(dir) !== true,
    )
    const gone = (err: NodeJS.ErrnoException): boolean => err.code === 'ENOENT'
    if (dirs.length <= SYNC_CLEAN_MAX) {
      for (const dir of dirs) {
        try {
          rmdirSync(dir)
          parents.add(path.dirname(dir))
        } catch (err) {
          if (gone(err as NodeJS.ErrnoException)) parents.add(path.dirname(dir))
        }
      }
    } else {
      await Promise.all(
        dirs.map(async (dir) => {
          if (await rmdir(dir).then(() => true, gone)) parents.add(path.dirname(dir))
        }),
      )
    }
    level = parents
  }
}

/**
 * The directories the wildcard output globs are rooted at, absolute. A
 * literal names a file or a tree whose shape the task decides, so it has
 * none; nor has a glob rooted at the project itself.
 */
function globRoots(projectDir: string, outputs: readonly string[]): Set<string> {
  const roots = new Set<string>()
  for (const g of outputs) {
    if (g.startsWith('!') || isLiteralPattern(g)) continue
    const prefix = staticPrefix(g)
    if (prefix !== '.') roots.add(path.resolve(projectDir, prefix))
  }
  return roots
}

/**
 * Resolve declared `outputs.workspaceFiles` globs (workspace-root-
 * relative) to actual produced files. Live-FS glob like
 * `resolveOutputs`, anchored at the workspace root — and deliberately
 * with NO project-dir exclusion: workspace outputs are the documented
 * boundary escape hatch.
 */
export async function resolveWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: string[]
}): Promise<string[]> {
  const { positive, negative } = splitNegations(args.outputs)
  if (positive.length === 0) return []
  const excludeGlobs = [...outputExcludes(positive), ...asTrees(negative).map(globFor)]
  const scanned = [...(await scanUnion(asTrees(positive), excludeGlobs, args.workspaceRoot))]
  // Same containment as the project twin, anchored one level out. These globs
  // deliberately ignore PROJECT boundaries — that is the escape hatch — but
  // escaping the WORKSPACE was never part of it, and `cleanWorkspaceOutputs`
  // deletes what this returns.
  return containedIn(args.workspaceRoot, scanned).sort()
}

/**
 * `cleanOutputs` for the workspace-output namespace: wipe every file
 * currently matching the declared root-relative globs. Same contract
 * (clean slate before restore AND before exec), same caching gate at
 * the call site. Returns root-relative posix paths of what was
 * removed — the caller feeds these to
 * `GitFilesCache.markWorkspaceOutputsChanged`.
 */
export async function cleanWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: string[]
}): Promise<string[]> {
  const files = await resolveWorkspaceOutputs(args)
  await pruneEmptiedDirs(args.workspaceRoot, await removeAll(files, args.workspaceRoot))
  return files.map((f) => relPosix(args.workspaceRoot, f))
}

function stripTrailingSlash(p: string): string {
  return p.replace(/\/+$/, '')
}

// The literal-is-a-tree rule moved to `util/paths.ts` (item 442): it
// decides what a clean deletes as well as what a key folds, and the
// graph's overlapping-output refusal — which may not import `cache` —
// has to read the same one. Re-exported here so the cache contract is
// unchanged.
export { asTrees } from '../util/index.js'

/**
 * The literals no path in `files` answers; a literal is answered by the
 * path itself or by anything under it. Git lists in order, so a binary
 * search finds the answer; a listing out of code-unit order (git sorts
 * bytes) can hide one from it, so only a walk says a literal is
 * unanswered. Testing every literal against every file was ~1.5 ms of a
 * 1,800-file all-cached run (2026-10-06).
 */
function unanswered(literals: readonly string[], files: readonly string[]): Set<string> {
  const left = new Set<string>()
  for (const lit of literals) {
    const under = `${lit}/`
    const answered =
      files[lowerBound(files, lit)] === lit ||
      files[lowerBound(files, under)]?.startsWith(under) === true ||
      files.some((rel) => rel === lit || rel.startsWith(under))
    if (!answered) left.add(lit)
  }
  return left
}

/** The first index whose path is not below `key`. */
function lowerBound(files: readonly string[], key: string): number {
  let lo = 0
  let hi = files.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (files[mid]! < key) lo = mid + 1
    else hi = mid
  }
  return lo
}

/**
 * Refuse a literal `cache.inputs.files` entry that EXISTS ON DISK but is
 * invisible to git — gitignored, or otherwise absent from
 * `git ls-files --cached --others --exclude-standard`.
 *
 * Such an entry contributes nothing to the cache key, so the task stops
 * tracking a file its own config names as an input. That is a stale hit, and a
 * quiet one: the run replays cached stdout, so it even LOOKS like it executed.
 *
 * Turbo honours the declaration instead (an explicit `inputs` entry overrides
 * gitignore). vx cannot afford to, and the reason is not cost: honouring it
 * would make the cache key depend on a change that `git diff` and
 * `git ls-files --others` CANNOT SEE, so editing that input would re-key the
 * task while `--affected` selected nothing. `docs/cli.md` states the invariant
 * those two surfaces owe each other as a principle — "input hashing sees it, so
 * `--affected` must too" — and it was closed for lockfiles only recently.
 * Honouring a gitignored input would reopen it from the other side.
 *
 * An entry that does NOT exist on disk stays silent: that is an ordinary stale
 * declaration, and refusing it would break every config that lists an
 * optional file.
 *
 * "Exists" is lstat, not `Bun.file(p).exists()`: that answers false for a
 * DIRECTORY, so a literal naming a gitignored `gen/` was never judged and
 * folded nothing in silence — the stale hit this refusal exists to stop, one
 * directory above where it looked (item 565, fixed in 576). A literal naming
 * an EMPTY directory is refused by the same rule, and that is right: git
 * lists no file under it, so it folds nothing whether tracked or not.
 */
async function assertNoInvisibleLiteralInputs(
  literals: ReadonlySet<string>,
  base: string,
  field: 'files' | 'workspaceFiles' = 'files',
): Promise<void> {
  for (const rel of literals) {
    if (!existsOnDisk(path.resolve(base, rel))) continue
    throw new UserError(
      `cache.inputs.${field}: "${rel}" exists in ${base} but git does not report it, ` +
        `so it contributes NOTHING to the cache key — input globs filter the files git ` +
        `lists, and a filter cannot add one back. The task would keep reporting ` +
        `up-to-date after that file changed. If it is generated, depend on the task ` +
        `that produces it via cache.inputs.tasks; if it should be tracked, remove it ` +
        `from .gitignore.`,
    )
  }
}

interface ResolveFilesArgs {
  projectDir: string
  workspaceRoot: string
  files: string[] | undefined
  ownOutputs: string[]
  nestedProjectDirs: string[]
  gitFilesCache?: GitFilesCache
  projectFilesCache?: ProjectFilesCache
}

/**
 * Record the names a fresh `git ls-files` could not decode, in the run's
 * cache when there is one, and return the set to check against.
 */
function noteUndecodable(
  cache: GitFilesCache | undefined,
  dir: string,
  rels: readonly string[],
): ReadonlySet<string> {
  const abs = rels.map((rel) => path.join(dir, rel))
  if (cache === undefined) return new Set(abs)
  cache.markUndecodable(abs)
  return cache.undecodableNames
}

/**
 * An input whose name is not UTF-8 is one vx cannot open (a string cannot
 * spell it), so it could only drop out of the key, where an edit to it is a
 * hit. Named instead, with the way out. One git still lists after it left
 * the disk (a tracked file deleted) drops out as any deleted file does.
 */
function refuseUndecodable(
  candidates: readonly string[],
  undecodable: ReadonlySet<string> | undefined,
  root: string,
  field: 'files' | 'workspaceFiles',
): void {
  if (undecodable === undefined || undecodable.size === 0) return
  const bad = candidates.filter((abs) => undecodable.has(abs) && undecodableOnDisk(abs))
  if (bad.length === 0) return
  const names = bad.map((abs) => JSON.stringify(relPosix(root, abs)))
  throw new UserError(
    `cache.inputs.${field} matched ${names.join(', ')} in ${root}: the name is not valid UTF-8 ` +
      `(shown with \ufffd), and vx cannot read a file by it. Rename it, or exclude it with a ` +
      `negated glob.`,
  )
}

const ONE_ALTERNATIVE_BRACE = /(?<!\\)\{[^{},]*\}/

/**
 * `Bun.Glob` reads `{b}` as a brace of one alternative, so `src/{b}.ts`
 * matches `src/b.ts` and never a file named `{b}.ts`: that file stays out
 * of the key and an edit to it is a hit. Neither reading is sure to be
 * the one meant, so the entry is refused with both spellings.
 */
function refuseOneAlternativeBrace(
  entries: readonly string[],
  field: 'files' | 'workspaceFiles',
): void {
  for (const entry of entries) {
    const m = ONE_ALTERNATIVE_BRACE.exec(entry)
    if (m === null) continue
    const inner = m[0].slice(1, -1)
    throw new UserError(
      `cache.inputs.${field}: "${entry}" holds a brace with one alternative, which matches ` +
        `"${inner}" and never a name holding "${m[0]}". Write "${entry.replace(m[0], inner)}", ` +
        `or "${entry.replace(m[0], `\\{${inner}\\}`)}" for the braces themselves.`,
    )
  }
}

/** What a `files` declaration and its task's outputs compile to, whatever the project. */
interface FilesPlan {
  positive: string[]
  negative: string[]
  isExcluded: (rel: string) => boolean
  ownOutput: (rel: string) => boolean
  positiveGlobs: Bun.Glob[]
  isPositive: (rel: string) => boolean
  /** The literal entries, each naming one path (see `unanswered`). */
  literals: string[]
  /** The directories a positive entry reaches; see `InputListing`. */
  prefixes: string[]
  /**
   * Whether a project-relative path is an input by the declaration alone:
   * a positive glob selects it, and no exclude and no own output takes it
   * back. Projects repeat their relative paths (`src/index.ts`,
   * `package.json`), so each is matched once per plan.
   */
  verdicts: Map<string, boolean>
}

/**
 * Compiled once per declaration for the life of the process: a workspace
 * declares a handful of `files` lists over thousands of tasks, and
 * splitting, normalizing and compiling them per task was ~6 ms of a
 * 1,000-task warm run (I-29). A refused declaration is never stored, so it
 * throws for every task that carries it.
 */
const filesPlans = new Map<string, FilesPlan | null>()

function filesPlan(
  files: readonly string[] | undefined,
  ownOutputs: readonly string[],
): FilesPlan | null {
  const key = JSON.stringify([files ?? null, ownOutputs])
  const memo = filesPlans.get(key)
  if (memo !== undefined) return memo
  const positive: string[] = []
  const negative: string[] = []
  if (files === undefined) {
    positive.push(...DEFAULT_FILE_GLOBS)
  } else {
    refuseOneAlternativeBrace(files, 'files')
    for (const entry of files) {
      if (entry.startsWith('!')) negative.push(entry.slice(1))
      else positive.push(entry)
    }
  }
  const plan =
    positive.length === 0
      ? null
      : {
          positive,
          negative,
          isExcluded: anyTaskGlob([...ALWAYS_IGNORE, ...asTrees(negative)]),
          // A path the task's own outputs take back with `!` is no output, so it
          // stays an input: a tracked file under `dist` the build reads (A-44).
          ownOutput: outputMatcher(ownOutputs),
          positiveGlobs: asTrees(positive).map(globFor),
          isPositive: anyTaskGlob(asTrees(positive)),
          ...reachOf(positive),
          verdicts: new Map<string, boolean>(),
        }
  filesPlans.set(key, plan)
  return plan
}

/**
 * Whether a changed path is one of a cached task's declared file inputs:
 * `projectRel` (the path relative to the project that owns it) against
 * `files`, `workspaceRel` (relative to the workspace root) against
 * `workspaceFiles`; null skips that half, by the globs, `!` exclusions and own-output takebacks
 * the key resolves. `--affected` seeds a task with it (owner, 2026-10-04).
 */
export function declaresInput(
  cache: CacheConfig,
  projectRel: string | null,
  workspaceRel: string | null,
): boolean {
  if (projectRel !== null) {
    const plan = filesPlan(cache.inputs.files, cache.outputs.files)
    if (plan !== null && inPlan(plan, projectRel)) return true
  }
  const ws = cache.inputs.workspaceFiles
  if (workspaceRel === null || ws === undefined || ws.length === 0) return false
  const matcher = workspaceMatcher(ws, cache.outputs.workspaceFiles ?? [])
  return matcher(workspaceRel)
}

function inPlan(plan: FilesPlan, rel: string): boolean {
  let input = plan.verdicts.get(rel)
  if (input === undefined) {
    input = plan.isPositive(rel) && !plan.isExcluded(rel) && !plan.ownOutput(rel)
    plan.verdicts.set(rel, input)
  }
  return input
}

const workspaceMatchers = new Map<string, (rel: string) => boolean>()

function workspaceMatcher(
  decl: readonly string[],
  ownOutputs: readonly string[],
): (rel: string) => boolean {
  const key = JSON.stringify([decl, ownOutputs])
  let m = workspaceMatchers.get(key)
  if (m !== undefined) return m
  const { positive, negative } = splitNegations(decl)
  const isPositive = anyTaskGlob(asTrees(positive))
  const isExcluded = anyTaskGlob([...ALWAYS_IGNORE, ...asTrees(negative)])
  const ownOutput = outputMatcher(ownOutputs)
  m = (rel) => isPositive(rel) && !isExcluded(rel) && !ownOutput(rel)
  workspaceMatchers.set(key, m)
  return m
}

async function resolveFiles(
  args: ResolveFilesArgs,
): Promise<{ files: string[]; listing?: InputListing }> {
  const plan = filesPlan(args.files, args.ownOutputs)
  if (plan === null) return { files: [] }
  const { positive, negative, isExcluded, ownOutput, positiveGlobs, isPositive } = plan

  const nested = inNestedProject(args.projectDir, args.nestedProjectDirs)

  // Defer to git for the file set (Turbo / Nx parity). Nested .gitignore
  // files, .git/info/exclude, and global excludes all participate
  // correctly because git applies the cascade for us.
  //
  // Per-run memo: each project's git ls-files output is asked for once
  // per task (build + test + lint + …). Spawning git N times for the
  // same project per run is wasteful; we cache the result for the
  // duration of one orchestrator run.
  // Everything below the snapshot that decides the result: the project, what
  // it declares, what it excludes as its own outputs, and the boundaries.
  const memoKey = `${args.projectDir}\0${positive.join('\u0001')}\0${negative.join('\u0001')}\0${args.ownOutputs.join('\u0001')}\0${args.nestedProjectDirs.join('\u0001')}`
  let gitFiles = args.gitFilesCache?.snapshotFor(args.projectDir, positiveGlobs)
  let undecodable = args.gitFilesCache?.undecodableNames
  if (gitFiles !== undefined) {
    const memo = args.projectFilesCache?.get(memoKey)
    // Identity, not equality: a re-enumeration hands back a new array even
    // when the file set is unchanged, and that is exactly when this task's
    // inputs must be walked again.
    if (memo !== undefined && memo.snapshot === gitFiles) {
      return {
        files: [...memo.result],
        listing: listingFor(args.projectDir, gitFiles, plan, nested),
      }
    }
  }
  if (gitFiles === undefined) {
    // Mid-run re-enumeration — or a project the workspace-wide populate
    // left without a partition because the workspace's git did not see its
    // directory (a submodule, an embedded repository); spawned in the
    // project dir, git answers from the nested repository.
    // The OIDs this spawn could yield are NOT
    // trusted (no fresh `git status` to vouch for them — the project's
    // tree just changed); set() drops the project's OID slot and these
    // files fall back to Cache.hashFile, which computes the identical
    // blob OID from disk.
    const ls = runGitLsFiles(args.projectDir)
    gitFiles = ls.files
    // set() also clears the project's pending-changed bookkeeping.
    args.gitFilesCache?.set(args.projectDir, gitFiles)
    undecodable = noteUndecodable(args.gitFilesCache, args.projectDir, ls.undecodable)
  }
  // A LITERAL entry — one with no glob metacharacter — names exactly one file,
  // so "this matched nothing" is unambiguous. For a glob it is not: matching
  // nothing is perfectly legitimate (`src/**/*.gen.ts` in a package with no
  // generated code), which is why only literals are tracked here.
  //
  // The reason it has to be tracked at all: the user's globs FILTER the set git
  // reports, and a filter can only remove. So naming a gitignored file by hand
  // folds NOTHING — silently. The task then reports `up-to-date` while replaying
  // an artifact built from an older version of a file the config explicitly
  // claims as an input. See the refusal below for why this is not simply
  // honoured instead.
  // First pass: glob-filter to candidate absolute paths (no I/O). Git
  // prints normalized relative paths, so under an absolute, normalized
  // project dir a join is a concatenation: `path.resolve` per file was
  // ~27 ms of a 900-task, 12,000-file warm run (I-30).
  const base =
    path.sep === '/' &&
    path.isAbsolute(args.projectDir) &&
    path.normalize(args.projectDir) === args.projectDir
      ? args.projectDir.endsWith('/')
        ? args.projectDir
        : `${args.projectDir}/`
      : undefined
  const candidates: string[] = []
  const verdicts = plan.verdicts
  for (const rel of gitFiles) {
    let input = verdicts.get(rel)
    if (input === undefined) {
      input = isPositive(rel) && !isExcluded(rel) && !ownOutput(rel)
      verdicts.set(rel, input)
    }
    if (!input || nested(rel)) continue
    candidates.push(base === undefined ? path.resolve(args.projectDir, rel) : base + rel)
  }
  const unmatchedLiterals = unanswered(plan.literals, gitFiles)
  if (unmatchedLiterals.size > 0) {
    await assertNoInvisibleLiteralInputs(unmatchedLiterals, args.projectDir, 'files')
  }
  refuseUndecodable(candidates, undecodable, args.projectDir, 'files')
  // Second pass: existence check — but ONLY for paths without a
  // trusted index OID. A clean-per-status tracked file necessarily
  // exists on disk, so skipping its probe keeps the warm path free of
  // per-file syscalls. Paths without an OID keep the probe:
  // `git ls-files -s` can surface staged entries whose working-tree
  // file is gone; the hasher would otherwise throw ENOENT.
  const oids = args.gitFilesCache?.oidsFor(args.projectDir)
  const resolved = candidates.filter((abs) => oids?.has(abs) === true || isInputOnDisk(abs))
  // Git's slice comes sorted and a common prefix keeps it so: one pass
  // proves it instead of a sort per task.
  for (let i = 1; i < resolved.length; i++) {
    if (resolved[i - 1]! > resolved[i]!) {
      resolved.sort()
      break
    }
  }
  // Stored only on the way out: a declaration whose literal named an
  // invisible file threw above, and every task sharing it must throw too.
  args.projectFilesCache?.set(memoKey, { snapshot: gitFiles, result: resolved })
  return { files: [...resolved], listing: listingFor(args.projectDir, gitFiles, plan, nested) }
}

function listingFor(
  root: string,
  listed: readonly string[],
  plan: FilesPlan,
  nested: (rel: string) => boolean,
): InputListing {
  return {
    root,
    listed,
    isInput: (rel) => inPlan(plan, rel),
    nested,
    prefixes: plan.prefixes,
    literals: plan.literals,
  }
}

/**
 * `Bun.Glob` decodes a name that is not UTF-8 lossily, so the path it
 * yields names no file and the output dropped out of the artifact without
 * a word: a hit then restored a tree without it (turborepo#9345's output
 * half). A `\ufffd` that does not stat is that case or a file that left
 * mid-scan; `undecodableOnDisk` tells them apart.
 */
function refuseUndecodableOutput(abs: string): void {
  if (!undecodableOnDisk(abs)) return
  throw new UserError(
    `cache.outputs matched ${JSON.stringify(abs)}: the name is not valid UTF-8 (shown with ` +
      `\ufffd), and vx cannot save a file by it. Rename it, or keep it out of the outputs.`,
  )
}

/**
 * Is `abs` (a lossy spelling) something on disk whose name, or a
 * directory's above it, is not UTF-8? From the deepest ancestor a string
 * can reach, read the raw names and look for one that decodes lossily to
 * the next segment and fatally not at all. Only a path that failed to
 * stat reaches here, so the reads are off every warm path.
 */
function undecodableOnDisk(abs: string): boolean {
  let dir = path.dirname(abs)
  let next = path.basename(abs)
  while (!existsOnDisk(dir)) {
    const parent = path.dirname(dir)
    if (parent === dir) return false
    next = path.basename(dir)
    dir = parent
  }
  let raw: Buffer[]
  try {
    raw = readdirSync(dir, { encoding: 'buffer' })
  } catch {
    return false
  }
  const lossy = new TextDecoder('utf-8', { ignoreBOM: true })
  for (const name of raw) {
    if (lossy.decode(name) !== next) continue
    try {
      FATAL_UTF8.decode(name)
    } catch {
      return true
    }
  }
  return false
}

/**
 * The listing a task's input files were filtered from, and what reading it
 * again takes: {@link addedInput} looks for a file the listing lacked.
 */
export interface InputListing {
  root: string
  /** Root-relative paths, as git listed them. */
  listed: readonly string[]
  isInput: (rel: string) => boolean
  nested: (rel: string) => boolean
  /** Root-relative directories a positive entry reaches, `''` for the root. */
  prefixes: readonly string[]
  /** The literal entries, each naming one path. */
  literals: readonly string[]
}

function reachOf(positive: readonly string[]): { prefixes: string[]; literals: string[] } {
  const prefixes = new Set<string>()
  for (const p of asTrees(positive)) {
    if (isLiteralPattern(p)) continue
    const prefix = staticPrefix(p)
    prefixes.add(prefix === '.' ? '' : prefix)
  }
  return {
    prefixes: [...prefixes],
    literals: positive.map(normalizeGlob).filter(isLiteralPattern).map(stripTrailingSlash),
  }
}

/** Every directory holding a listed path, `''` for the root, once per listing. */
const listedDirsMemo = new WeakMap<readonly string[], Set<string>>()
function listedDirs(listed: readonly string[]): Set<string> {
  let dirs = listedDirsMemo.get(listed)
  if (dirs !== undefined) return dirs
  dirs = new Set([''])
  for (const rel of listed) {
    for (let i = rel.lastIndexOf('/'); i > 0; i = rel.lastIndexOf('/', i - 1)) {
      const dir = rel.slice(0, i)
      if (dirs.has(dir)) break
      dirs.add(dir)
    }
  }
  listedDirsMemo.set(listed, dirs)
  return dirs
}

function reaches(prefixes: readonly string[], rel: string): boolean {
  return prefixes.some(
    (p) => p === '' || rel === p || rel.startsWith(`${p}/`) || p.startsWith(`${rel}/`),
  )
}

/**
 * An input file that exists now and that the key did not fold, or undefined.
 * The facts re-check only the files the key folded, so a file ADDED under
 * an input glob while the command ran — and read by it — was saved under a
 * key without it, and replayed once the file was gone.
 *
 * Adding a name changes its directory's ctime, so the listing's directories
 * that a positive entry reaches are stat'ed, and only one changed since
 * `listedAt` (the listing's time, less the racy window) is read. A name
 * there that the key lacks and the declaration matches, or an unlisted
 * directory, is asked of git, which alone knows what is ignored; so is a
 * missing literal that now exists. Not seen: a file added inside a
 * directory that held no listed file before (only ignored ones, or none)
 * and was not itself created during the run — its parent's ctime stays.
 */
export function addedInput(
  listings: readonly InputListing[],
  keyFiles: ReadonlySet<string>,
  listedAt: number,
): string | undefined {
  for (const l of listings) {
    const found = addedTo(l, keyFiles, listedAt)
    if (found !== undefined) return found
  }
  return undefined
}

function addedTo(
  l: InputListing,
  keyFiles: ReadonlySet<string>,
  listedAt: number,
): string | undefined {
  const candidates: string[] = []
  for (const lit of l.literals) {
    if (l.nested(lit) || keyFiles.has(path.resolve(l.root, lit))) continue
    if (existsOnDisk(path.resolve(l.root, lit))) candidates.push(lit)
  }
  const known = listedDirs(l.listed)
  for (const dir of known) {
    if (!reaches(l.prefixes, dir) || (dir !== '' && l.nested(`${dir}/`))) continue
    const abs = dir === '' ? l.root : path.resolve(l.root, dir)
    let entries
    try {
      const st = lstatSync(abs, { throwIfNoEntry: false })
      if (st === undefined) continue
      if (st.ctimeMs < listedAt - racyWindowMs(st.ctimeMs, FILE_HASH_RACY_MS)) continue
      entries = readdirSync(abs, { withFileTypes: true })
    } catch {
      // Unreadable here: git answers for the whole directory instead.
      candidates.push(dir)
      continue
    }
    for (const e of entries) {
      const rel = dir === '' ? e.name : `${dir}/${e.name}`
      if (e.isDirectory()) {
        if (known.has(rel) || e.name === 'node_modules' || l.nested(`${rel}/`)) continue
        if (reaches(l.prefixes, rel)) candidates.push(rel)
      } else if (
        l.isInput(rel) &&
        !l.nested(rel) &&
        !isInstalledPath(rel) &&
        !keyFiles.has(path.resolve(abs, e.name))
      ) {
        candidates.push(rel)
      }
    }
  }
  if (candidates.length === 0) return undefined
  for (const rel of runGitLsFiles(l.root).files) {
    if (!candidates.some((c) => c === '' || rel === c || rel.startsWith(`${c}/`))) continue
    if (isInstalledPath(rel) || l.nested(rel) || !l.isInput(rel)) continue
    const abs = path.resolve(l.root, rel)
    if (!keyFiles.has(abs) && isInputOnDisk(abs)) return abs
  }
  return undefined
}

const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

/**
 * Union of the OUTPUT files matching any positive pattern in `cwd`, minus
 * files matching any exclude glob (tested by Bun.Glob.match on the relative
 * path). Bun.Glob takes a single pattern per instance, so we iterate.
 *
 * Yields SYMLINKS (never followed, never descended): a task that emits
 * `dist/out -> ../src/x` has produced an output, so the save must capture it
 * (as its target's bytes, `planArtifact`) and the clean must remove it — a
 * link the clean leaves standing blocks the directory a later entry restores
 * there. Bun's `onlyFiles` walk drops every symlink, so this lists everything
 * and sorts by `lstat`.
 *
 * Sync scan. The async walk was chosen on 2026-09-02, when a warm HIT globbed
 * its outputs and the thread pool overlapped a thousand of them; the directory
 * short-circuit took the glob off the hit path, and what is left runs on the
 * MISS path twice per task (clean, then resolve), where the walk is CPU-bound
 * and each async chunk costs a main-thread round trip. Measured 2026-09-09 on
 * a 1,000-task cold run (see STATUS).
 *
 * A second `mode: 'files'` branch lived here until item 566, defaulted to and
 * reached by NOTHING — both call sites pass `'outputs'`. Its `dot: true` could
 * be deleted with the whole suite green for the plainest reason there is.
 */
async function scanUnion(
  positive: readonly string[],
  excludeGlobs: readonly Bun.Glob[],
  cwd: string,
  nested: (rel: string) => boolean = () => false,
): Promise<Set<string>> {
  const matches = new Set<string>()
  // `Bun.Glob`'s scan finds nothing for a brace whose alternatives hold a
  // `/`: `{dist,lib/esm}/**` saved an empty artifact, and a hit restored
  // nothing over a cleaned tree (A-10). Expanded here, as discovery does.
  for (const pattern of positive.flatMap(slashBraceExpansions)) {
    if (absentPrefix(cwd, pattern)) continue
    const glob = globFor(pattern)
    for (const rel of glob.scanSync({ cwd, onlyFiles: false, followSymlinks: false, dot: true })) {
      if (nested(rel) || excludeGlobs.some((g) => g.match(rel))) continue
      const abs = path.resolve(cwd, rel)
      const st = lstatSync(abs, { throwIfNoEntry: false })
      if (st !== undefined && (st.isFile() || st.isSymbolicLink())) matches.add(abs)
      else if (st === undefined && rel.includes('\ufffd')) refuseUndecodableOutput(abs)
    }
  }
  return matches
}

/**
 * True when `pattern`'s static directory is not on disk, so nothing can
 * match under it. A restore into a tree without its outputs scans each
 * glob twice (the check, then the clean), and a scan of a missing `dist`
 * cost ~58 µs where the lstat costs a few. Anything this cannot read
 * plainly (no prefix, an escape, an absolute path, a refused stat) scans.
 */
function absentPrefix(cwd: string, pattern: string): boolean {
  const prefix = staticPrefix(pattern)
  if (prefix === '.' || prefix.includes('\\') || path.isAbsolute(prefix)) return false
  try {
    return lstatSync(path.join(cwd, prefix), { throwIfNoEntry: false }) === undefined
  } catch {
    return false
  }
}

// Compiled once per pattern string for the life of the process: a `Bun.Glob`
// is immutable, and the same handful of declared globs are compiled again
// for every task otherwise (three sites, up to thousands of times per run).
const globMemo = new Map<string, Bun.Glob>()
function globFor(pattern: string): Bun.Glob {
  let g = globMemo.get(pattern)
  if (g === undefined) globMemo.set(pattern, (g = taskGlob(pattern)))
  return g
}

/**
 * Whether a project-relative path lies inside a nested project: its
 * ancestor directories looked up in a set, O(depth). One `<nested>/**` glob
 * per nested project matched every file against every one, O(files ×
 * nested): 320 ms of astro's 834 ms warm no-op, 4,003 files against 330
 * fixture projects (I's log, A-11). A glob also read `*`, `?` or `{` in a
 * nested directory's NAME as syntax, so a project at `pkg*` took its
 * sibling `pkg-b`'s files out of the key; a name is a name.
 */
function inNestedProject(projectDir: string, nestedDirs: string[]): (rel: string) => boolean {
  if (nestedDirs.length === 0) return () => false
  const dirs = new Set(nestedDirs.map((d) => relPosix(projectDir, d)))
  return (rel) => {
    for (let i = rel.indexOf('/'); i !== -1; i = rel.indexOf('/', i + 1)) {
      if (dirs.has(rel.slice(0, i))) return true
    }
    return false
  }
}
