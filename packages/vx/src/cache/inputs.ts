// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs from parent process.env (value
//     undefined for an unset name)
//
// `inputs.env` is the cache-tracking axis for env vars; it's
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
import { lstatSync, readdirSync, realpathSync, rmdirSync, rmSync, statSync } from 'node:fs'
import { rm, rmdir } from 'node:fs/promises'
import type { InputsConfig, TaskConfig } from '../config.js'
import {
  literalPath,
  anyTaskGlob,
  asTrees,
  isExecutableMissing,
  isInstalledPath,
  isLiteralPattern,
  normalizeGlob,
  outputMatcher,
  outputNever,
  realpathOf,
  relPosix,
  restorableOutput,
  shellArgv,
  slashBraceExpansions,
  braceAlternatives,
  splitNegations,
  staticPrefix,
  stripTrailingSlash,
  taskGlob,
  UserError,
  writableUnder,
} from '../util/index.js'
import { GitFilesCache, listingEnv, runGitLsFiles } from './git-inputs.js'
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

// .vx/projects.lock.json is committed (so git enumerates it) but it's vx's own
// frozen-config metadata — never a task input. Excluded globally so a
// re-lock can't bust every cache key the way a tracked source file
// would. (Literal pattern, not the workspace `LOCKFILE_NAME` constant:
// cache is a leaf module and must not import from workspace.)
//
// Relative to the project, so only where vx writes them: its root's `.vx`
// and the `vx.lock.json` beside its config. Matched at any depth, a
// project's own `src/.vx/tmp/*` or `src/sub/vx.lock.json` keyed nothing,
// and an edit to one was a hit (2026-10-17).
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
  '.git/**',
  // vx's machine-local state; the workspace config beside it is a source.
  '.vx/cache/**',
  '.vx/projects.lock.json',
  // `vx lock`'s review copy of a project's resolved config: the config is
  // keyed already, and a re-lock must not move every `**` reader's key.
  'vx.lock.json',
  // What `vx lock` and `vx init` write beside the lock: a re-lock or init
  // must not select every `**` reader under --affected.
  '.vx/.gitattributes',
  '.vx/.gitignore',
  // Where restores stage (archive.ts): vx's own, never an input.
  '.vx/tmp/**',
]

/**
 * `ALWAYS_IGNORE` relative to the workspace root, for `inputs.workspaceFiles`:
 * those globs cross into other projects, and each one's `vx.lock.json` is vx's.
 */
const WORKSPACE_ALWAYS_IGNORE = [...ALWAYS_IGNORE, '**/vx.lock.json']

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
  inputs: InputsConfig | undefined
  /** Project-relative output globs to exclude from inputs. */
  ownOutputs: readonly string[]
  /** Root-relative `outputs.workspaceFiles` globs to exclude from
   *  `inputs.workspaceFiles` (a task cannot invalidate itself). */
  ownWorkspaceOutputs?: readonly string[]
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
   * Run-scoped memo for `inputs.runtime` command execution, keyed
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
   * Run-scoped memo for `inputs.workspaceRuntime`, keyed by command
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
   * Run-scoped memo for `inputs.workspaceFiles`, keyed by the
   * declaration and valid for one enumeration snapshot. A Turbo-mapped
   * workspace gives every task the same `globalDependencies`, and
   * resolving one literal against medusa's 24k-file enumeration per task
   * was 930 ms of a 3.0 s warm no-op (159 scans, 2026-09-11).
   */
  workspaceFilesCache?: WorkspaceFilesCache
  /** Per-run memo for `inputs.files`; see `ProjectFilesCache`. */
  projectFilesCache?: ProjectFilesCache
  /** Resolve no files: the caller folds them from a `filesToken` memo. */
  skipFiles?: boolean
}

export type WorkspaceFilesCache = Map<
  string,
  { snapshot: readonly string[]; result: Promise<string[]> }
>

/**
 * Per-run memo of `inputs.files` resolution, keyed by the project and
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

/**
 * What a task's input files fold to is a function of this token when it is
 * one of the git records alone: the project's partition holds only files
 * the enumeration trusted an index OID for (`GitFilesCache.filesDigest`),
 * and the declaration reaches no gitignored path and no workspace file.
 * The token is the digest, the workspace root (the fold folds paths
 * relative to it) and everything `resolveFiles` keys its memo on.
 * Undefined when only resolving the files can say.
 */
export function filesToken(args: ResolveInputsArgs): string | undefined {
  if ((args.inputs?.workspaceFiles?.length ?? 0) > 0) return undefined
  const plan = filesPlan(args.inputs?.files, args.ownOutputs)
  const cache = args.gitFilesCache
  if (plan === null || cache === undefined) return undefined
  const snapshot = cache.snapshotFor(args.projectDir, plan.positiveGlobs)
  if (snapshot === undefined) return undefined
  const digest = cache.filesDigest(args.projectDir, snapshot)
  if (
    digest === undefined ||
    ignoredReach(plan, snapshot, { dir: args.projectDir, cache }).length > 0
  )
    return undefined
  return `${args.workspaceRoot}\0${filesMemoKey(args.projectDir, plan, args.ownOutputs, args.ownWorkspaceOutputs ?? [], args.nestedProjectDirs)}\0${digest}`
}

/** Everything below the git snapshot that decides `resolveFiles`' result. */
function filesMemoKey(
  projectDir: string,
  plan: FilesPlan,
  ownOutputs: readonly string[],
  ownWorkspaceOutputs: readonly string[],
  nestedProjectDirs: readonly string[],
): string {
  return `${projectDir}\0${plan.positive.join('\u0001')}\0${plan.negative.join('\u0001')}\0${ownOutputs.join('\u0001')}\0${ownWorkspaceOutputs.join('\u0001')}\0${nestedProjectDirs.join('\u0001')}`
}

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  const projectRel =
    args.skipFiles === true
      ? ''
      : path.relative(args.workspaceRoot, args.projectDir).split(path.sep).join('/')
  const { files: projectFiles, listing } =
    args.skipFiles === true
      ? { files: [], listing: undefined }
      : await resolveFiles({
          projectDir: args.projectDir,
          workspaceRoot: args.workspaceRoot,
          files: args.inputs?.files,
          ownOutputs: args.ownOutputs,
          ownWorkspaceOutputs: args.ownWorkspaceOutputs ?? [],
          projectRel,
          nestedProjectDirs: args.nestedProjectDirs,
          ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
          ...(args.projectFilesCache !== undefined
            ? { projectFilesCache: args.projectFilesCache }
            : {}),
        })
  let files = projectFiles
  const listings = listing === undefined ? [] : [listing]
  const wsDecl = args.inputs?.workspaceFiles
  if (wsDecl !== undefined && wsDecl.length > 0 && args.skipFiles !== true) {
    const ws = resolveWorkspaceFiles({
      workspaceRoot: args.workspaceRoot,
      workspaceFiles: wsDecl,
      ownWorkspaceOutputs: args.ownWorkspaceOutputs ?? [],
      ownOutputs: args.ownOutputs,
      projectRel,
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
      ...(args.workspaceFilesCache !== undefined ? { memo: args.workspaceFilesCache } : {}),
    })
    if (ws !== undefined) listings.push(ws.listing)
    const wsFiles = ws === undefined ? [] : await ws.files
    // Dedupe: when the project dir IS the workspace root (or a glob
    // overlaps), the same absolute path can arrive via both lists —
    // it must contribute to the key exactly once.
    if (wsFiles.length > 0) files = mergeSorted(projectFiles, wsFiles)
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
 * Resolve `inputs.workspaceFiles` — workspace-root-relative
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
  /** The task's project-relative `outputs.files`, and its project's root-relative directory. */
  ownOutputs: readonly string[]
  projectRel: string
  gitFilesCache?: GitFilesCache
  memo?: WorkspaceFilesCache
}): { files: Promise<string[]>; listing: InputListing } | undefined {
  const positive: string[] = []
  const negative: string[] = []
  for (const entry of args.workspaceFiles) {
    if (entry.startsWith('!')) negative.push(entry.slice(1))
    else positive.push(entry)
  }
  if (positive.length === 0) return undefined

  // A path the task's own outputs take back with `!` is no output, so it
  // stays an input (A-44).
  const ownOutput = outputMatcher(args.ownWorkspaceOutputs)
  // Its project outputs too, which a root-anchored glob can reach as well:
  // left in, the task's own build moved its key, and no run was ever saved.
  let ownProjectOutput: ((rel: string) => boolean) | undefined
  const ownProject = (rel: string): boolean =>
    (ownProjectOutput ??= underProject(args.projectRel, outputMatcher(args.ownOutputs)))(rel)
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
  let isExcluded: ((rel: string) => boolean) | undefined
  let isPositive: ((rel: string) => boolean) | undefined
  const excludedByDeclaration = (rel: string): boolean =>
    (isExcluded ??= anyTaskGlob([...WORKSPACE_ALWAYS_IGNORE, ...asTrees(negative)]))(rel)
  // A committed file stays an input whatever output reaches it (`committedFiles`).
  let committed: ((abs: string) => boolean) | undefined
  const own = (rel: string): boolean =>
    (ownOutput(rel) || ownProject(rel)) &&
    !(committed ??= committedFiles(args.gitFilesCache, args.workspaceRoot))(
      path.join(args.workspaceRoot, rel),
    )
  const listing: InputListing = {
    root: args.workspaceRoot,
    workspaceRoot: args.workspaceRoot,
    listed: gitFiles,
    isInput: (rel) =>
      (isPositive ??= throughLinks(positive, anyTaskGlob(asTrees(positive))))(rel) &&
      !excludedByDeclaration(rel) &&
      !own(rel),
    nested: () => false,
    ...reachOf(positive),
  }
  // Two levels: the declaration's files over the snapshot, shared by every
  // task that declares it, then the task's own outputs taken out. A
  // Turbo-mapped repo gives two thousand tasks one 400-entry list, and a
  // memo keyed by the project too scanned, resolved and sorted the 4,000
  // files it matched once per task (astro, 2026-10-09).
  const declared = JSON.stringify([positive, negative])
  let base: Promise<string[]> | undefined
  const hit = args.memo?.get(declared)
  if (hit !== undefined && hit.snapshot === gitFiles) base = hit.result
  if (base === undefined) {
    isPositive ??= throughLinks(positive, anyTaskGlob(asTrees(positive)))
    base = resolveWorkspaceFilesOver(args, gitFiles, positive, isPositive, excludedByDeclaration)
    args.memo?.set(declared, { snapshot: gitFiles, result: base })
  }
  const ownsAny =
    splitNegations(args.ownWorkspaceOutputs).positive.length > 0 ||
    splitNegations(args.ownOutputs).positive.length > 0
  const reach = ignoredReach(reachOf(positive), gitFiles, {
    dir: args.workspaceRoot,
    cache: args.gitFilesCache,
  })
  const files = base.then((all) => {
    const kept = ownsAny ? all.filter((abs) => !own(relPosix(args.workspaceRoot, abs))) : all
    refuseUndecodable(kept, undecodable, args.workspaceRoot, 'workspaceFiles')
    if (reach.length === 0) return kept
    // Outside the memo: an ignored file a task writes mid-run leaves the
    // snapshot as it was.
    isPositive ??= throughLinks(positive, anyTaskGlob(asTrees(positive)))
    const accept = isPositive
    const extra = ignoredInputs(
      args.workspaceRoot,
      reach,
      (rel) => accept(rel) && !excludedByDeclaration(rel) && !own(rel),
    )
    return extra.length === 0 ? kept : mergeSorted(kept, extra)
  })
  return { files, listing }
}

async function resolveWorkspaceFilesOver(
  args: { workspaceRoot: string; gitFilesCache?: GitFilesCache },
  gitFiles: readonly string[],
  positive: readonly string[],
  isPositive: (rel: string) => boolean,
  excluded: (rel: string) => boolean,
): Promise<string[]> {
  const candidates: string[] = []
  for (const rel of gitFiles) {
    if (!isPositive(rel)) continue
    if (excluded(rel)) continue
    candidates.push(path.resolve(args.workspaceRoot, rel))
  }
  // Same OID-trust shortcut as project files: a clean-per-status
  // tracked file necessarily exists on disk.
  const oids = args.gitFilesCache?.oidsFor(args.workspaceRoot)
  return candidates.filter((abs) => oids?.has(abs) === true || isInputOnDisk(abs)).sort()
}

/**
 * The sorted union of two path lists, each once. Both sides arrive sorted
 * and distinct, so one merge does what a Set and a sort of the
 * concatenation did: 3.7 s of an astro plan, where 2,000 tasks each joined
 * a few project files to the same 4,000 workspace files (2026-10-09). A
 * side out of order takes the general path.
 */
function mergeSorted(a: readonly string[], b: readonly string[]): string[] {
  if (a.length === 0 && isStrictlySorted(b)) return b as string[]
  if (!isStrictlySorted(a) || !isStrictlySorted(b)) return [...new Set([...a, ...b])].sort()
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length && j < b.length) {
    const x = a[i]!
    const y = b[j]!
    if (x <= y) {
      out.push(x)
      i++
      if (x === y) j++
    } else {
      out.push(y)
      j++
    }
  }
  while (i < a.length) out.push(a[i++]!)
  while (j < b.length) out.push(b[j++]!)
  return out
}

function isStrictlySorted(list: readonly string[]): boolean {
  for (let i = 1; i < list.length; i++) if (!(list[i - 1]! < list[i]!)) return false
  return true
}

/** A project-relative matcher asked of root-relative paths: false outside the project. */
function underProject(
  projectRel: string,
  matches: (rel: string) => boolean,
): (rel: string) => boolean {
  if (projectRel === '') return matches
  const prefix = `${projectRel}/`
  return (rel) => rel.startsWith(prefix) && matches(rel.slice(prefix.length))
}

/** A root-relative matcher asked of project-relative paths. */
function inProject(
  projectRel: string,
  matches: (rel: string) => boolean,
): (rel: string) => boolean {
  return projectRel === '' ? matches : (rel) => matches(`${projectRel}/${rel}`)
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

/**
 * One runtime probe answered on this machine as a key folds it: an
 * `inputs.runtime` command run in `projectDir`, or with `workspace` a
 * `workspaceRuntime` one run in `workspaceRoot`. For an executor that
 * checks a task's probes where it runs it (`TaskExecutor.runtime`).
 */
export function answerRuntime(
  command: string,
  projectDir: string,
  workspaceRoot: string,
  workspace = false,
): Promise<string> {
  return workspace
    ? runRuntimeCommand(
        command,
        workspaceRoot,
        [path.join(workspaceRoot, 'node_modules', '.bin')],
        undefined,
      )
    : runRuntimeCommand(command, projectDir, projectBinDirs(projectDir, workspaceRoot), undefined)
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
        `inputs runtime command could not run: vx runs it with sh -c and 'sh' is not on PATH (command: ${command}, cwd: ${cwd}). Install a POSIX sh and re-run.`,
      )
    }
    throw new UserError(`inputs runtime command failed to spawn: ${command} (cwd: ${cwd})`)
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
      `inputs runtime command exited ${exitCode}: ${command} (cwd: ${cwd})` +
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
      `inputs runtime command printed bytes that are not UTF-8: ${command} (cwd: ${cwd}). ` +
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
 * What a set of output globs may not reach (`outputNever`). `**\/*.js`
 * meant the build's files, and the clean before each run deleted every
 * installed `.js` under `node_modules` with them (A-13); an install task
 * declares `node_modules/**` and keeps it.
 */
function outputExcludes(outputs: readonly string[], scope: 'project' | 'workspace'): Bun.Glob[] {
  return outputNever(outputs, scope).map(globFor)
}

/**
 * Resolve declared output globs (project-relative) to actual produced files.
 * An output directory linked out of the project is refused by name (X-88):
 * dropping its files silently saved an empty entry under a green run.
 */
export async function resolveOutputs(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
}): Promise<string[]> {
  return (await scanOutputs(args)).files
}

/**
 * Whether `resolveOutputs` takes the project-relative file `rel`, decided
 * without the walk: a directory snapshot's file list is held to the
 * entry's rows through it.
 */
export function outputWalkTakes(
  projectDir: string,
  outputs: readonly string[],
  nestedProjectDirs: string[],
): (rel: string) => boolean {
  const restorable = restorableOutput(outputs)
  const nested = inNestedProject(projectDir, nestedProjectDirs)
  return (rel) => restorable(rel) && !nested(rel)
}

/**
 * `resolveOutputs`, plus the empty directories the globs match: a save
 * keeps them, so a hit leaves the tree a miss left (Turbo and Nx restore
 * them too). Only a save asks; a hit's walk compares files.
 */
export async function resolveOutputTree(args: {
  projectDir: string
  outputs: readonly string[]
  nestedProjectDirs: string[]
}): Promise<{ files: string[]; emptyDirs: string[] }> {
  const emptyDirs = new Set<string>()
  const { files } = await scanOutputs(args, emptyDirs)
  return { files, emptyDirs: containedIn(args.projectDir, [...emptyDirs]).sort() }
}

async function scanOutputs(
  args: { projectDir: string; outputs: readonly string[]; nestedProjectDirs: string[] },
  emptyDirs?: Set<string>,
): Promise<{ files: string[] }> {
  const { positive, negative } = splitNegations(args.outputs)
  if (positive.length === 0) return { files: [] }
  const excludeGlobs = [...outputExcludes(positive, 'project'), ...asTrees(negative).map(globFor)]
  const trees = asTrees(positive)
  refuseDirLinkedOut(args.projectDir, trees, 'project')
  const scanned = [
    ...(await scanUnion(
      trees,
      excludeGlobs,
      args.projectDir,
      inNestedProject(args.projectDir, args.nestedProjectDirs),
      emptyDirs,
    )),
  ]
  // Containment, enforced HERE and not only at the loader. `cleanOutputs`
  // DELETES whatever this returns, and `Bun.Glob.scan` happily walks `..` out
  // of its cwd — so the loader's `..`/absolute rejection alone was a single
  // point of failure. The resolver that feeds the delete refuses to name a path
  // outside the project, so any future caller reaching it by another route (a
  // programmatic embedder, a config source that skips the loader) is contained
  // by construction.
  const contained = containedIn(args.projectDir, scanned)
  return { files: outsideNested(args.nestedProjectDirs, contained).sort() }
}

/**
 * Whether git tracks a file under `dir`. No clean deletes a committed (or
 * `git add`ed) file an output glob reaches (2026-10-14: "never
 * delete committed file"); the task may rewrite it and a restore writes the
 * bytes it left. It stays in the task's key, so those bytes follow from
 * the key. Turbo and Nx never clean an output at all.
 */
export function committedFiles(
  cache: GitFilesCache | undefined,
  dir: string,
): (abs: string) => boolean {
  return (cache ?? new GitFilesCache()).committedIn(dir)
}

/**
 * The literal head of each output glob, walked: the scan follows a link
 * there (`dist -> ../elsewhere` for `dist/**`) and only there. A link
 * below it is an output, kept as the link (`archive.ts`). One into `.git`
 * or `.vx` is refused in either scope: for the root project and for
 * workspace outputs those are inside, and the clean deleted the
 * repository through `dist -> .git`. One out of a workspace output's root
 * is left to `containedIn`.
 */
function refuseDirLinkedOut(
  root: string,
  trees: readonly string[],
  scope: 'project' | 'workspace',
): void {
  let realRoot: string | undefined
  for (const tree of trees) {
    let at = root
    for (const part of staticPrefix(tree).split('/')) {
      if (part === '' || part === '.') continue
      at = path.join(at, part)
      if (!isInside(root, at)) break
      let st
      try {
        st = lstatSync(at, { throwIfNoEntry: false })
      } catch {
        break
      }
      if (st === undefined) break
      if (!st.isSymbolicLink()) continue
      let real: string
      try {
        real = realpathSync(at)
        if (!statSync(real).isDirectory()) break
      } catch {
        break
      }
      realRoot ??= realOr(root)
      if (!isInside(realRoot, real)) {
        if (scope === 'workspace') break
        throw new UserError(
          `${at} is a symbolic link to ${real}, outside ${root} — vx never cleans, saves ` +
            'or restores declared outputs through a link that leaves the project. Remove the ' +
            'link and re-run, or stop declaring outputs under it.',
        )
      }
      if (inMetadata(real, realRoot)) {
        throw new UserError(
          `${at} is a symbolic link to ${real}, Git's or vx's metadata — vx never cleans, ` +
            'saves or restores declared outputs through a link into .git or .vx. Remove the ' +
            'link and re-run, or stop declaring outputs under it.',
        )
      }
    }
  }
}

/**
 * Whether `real`, under `realRoot`, is in a `.git` there (`writableUnder`'s
 * rule) or in its `.vx`. Asked only of where a link landed: a build's own
 * `dist/.git/**` is an output (2026-10-17).
 */
function inMetadata(real: string, realRoot: string): boolean {
  if (!writableUnder(real, realRoot)) return true
  return (
    real
      .slice(realRoot.length + 1)
      .split(path.sep, 1)[0]!
      .toLowerCase() === '.vx'
  )
}

function realOr(p: string): string {
  try {
    return realpathSync(p)
  } catch {
    return p
  }
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
  const realRoot = realOrNull(root) ?? root
  const uniqueDirs = [...new Set(lexDirs)]
  const resolved = uniqueDirs.map(realOrNull)
  const contained = new Set<string>()
  for (const [i, dir] of uniqueDirs.entries()) {
    const real = resolved[i]
    if (real !== null && real !== undefined && isInside(realRoot, real)) contained.add(dir)
  }
  return lexical.filter((_p, i) => contained.has(lexDirs[i]!))
}

/**
 * `committed`, also asked by each path's real directory: the output walk
 * follows a link at a glob's head that stays inside `root` (X-88), so
 * `public/logo.txt` may be `static/logo.txt`, the only name git lists.
 * Asked by the lexical name alone, an untracked `public -> static` link
 * let the clean delete a committed file. One realpath per directory.
 */
function committedPastLinks(
  root: string,
  committed: (abs: string) => boolean,
): (abs: string) => boolean {
  let realRoot: string | undefined
  const canonical = new Map<string, string | null>()
  return (abs) => {
    if (committed(abs)) return true
    const dir = path.dirname(abs)
    let canon = canonical.get(dir)
    if (canon === undefined) {
      const real = realOrNull(dir)
      realRoot ??= realOrNull(root) ?? root
      canon =
        real === null || !isInside(realRoot, real)
          ? null
          : path.join(root, path.relative(realRoot, real))
      canonical.set(dir, canon)
    }
    return canon !== null && canon !== dir && committed(path.join(canon, path.basename(abs)))
  }
}

/**
 * Drop the files whose real directory is in a nested project: a link at a
 * glob's head that stays in the project is followed (X-88), and the
 * lexical nested-project filter cannot see where it lands.
 */
function outsideNested(nestedDirs: readonly string[], files: string[]): string[] {
  if (nestedDirs.length === 0 || files.length === 0) return files
  const realNested = nestedDirs.map((d) => realOrNull(d) ?? d)
  const verdict = new Map<string, boolean>()
  return files.filter((f) => {
    const dir = path.dirname(f)
    let ok = verdict.get(dir)
    if (ok === undefined) {
      const real = realOrNull(dir) ?? dir
      ok = !realNested.some((n) => isInside(n, real))
      verdict.set(dir, ok)
    }
    return ok
  })
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
  outputs: readonly string[]
  nestedProjectDirs: string[]
  committed?: (abs: string) => boolean
  /**
   * What `resolveOutputs` returned for these same arguments, when the
   * caller walked the tree with no await since: a hit that found its tree
   * stale walked it to say so, and a second walk here was half the
   * restore's tree work (X-161).
   */
  resolved?: readonly string[] | undefined
}): Promise<string[]> {
  const committed = committedPastLinks(
    args.projectDir,
    args.committed ?? committedFiles(undefined, args.projectDir),
  )
  sweepRestoreTemps(args.projectDir, args.outputs, committed)
  // An empty directory under the outputs is one too (a save keeps it): one
  // an older build left would otherwise be saved by this run.
  const tree =
    args.resolved === undefined
      ? await resolveOutputTree(args)
      : { files: args.resolved, emptyDirs: [] }
  const matched = tree.files
  // `force: true` makes rm tolerate ENOENT (e.g. when two output
  // globs overlap and a sibling already deleted a path mid-iteration).
  // A symlink is unlinked, never followed.
  const removed = await removeAll(
    matched.filter((f) => !committed(f)),
    args.projectDir,
  )
  await pruneEmptiedDirs(
    args.projectDir,
    removed,
    pruneScope(args.projectDir, args.outputs),
    undefined,
    tree.emptyDirs,
  )
  // Project-relative posix paths the outputs reach, for the caller's
  // GitFilesCache.markOutputsChanged: a committed one kept here is the
  // task's to rewrite or remove, so its index OID no longer vouches for it.
  return matched.map((f) => relPosix(args.projectDir, f))
}

/**
 * Remove the restore temps (`.vx-tmp-<pid>-<n>`, archive.ts) a killed run
 * left beside an exact-file output. A restore stages in `.vx/tmp/` and
 * writes one beside its target only where the target is on another
 * filesystem (EXDEV); a glob over the directory takes it with the outputs,
 * but `out/a.txt` reaches no sibling, and a partial temp stayed in `out/`
 * through every later run (Growth's SIGKILL probe, 2026-10-16). A temp
 * whose writer is alive, this process included, is left: it may be
 * mid-restore.
 */
export function sweepRestoreTemps(
  base: string,
  outputs: readonly string[],
  committed: (abs: string) => boolean = () => false,
): void {
  const dirs = new Set<string>()
  for (const g of outputs) {
    if (g.startsWith('!') || !isLiteralPattern(g)) continue
    dirs.add(path.dirname(path.resolve(base, stripTrailingSlash(normalizeGlob(g)))))
  }
  // A directory that resolves out of `base` is not the outputs': the link
  // refusal runs after this sweep, and a delete never follows a link out.
  let realBase: string | undefined
  for (const dir of dirs) {
    const real = realOrNull(dir)
    if (real === null || !isInside((realBase ??= realOrNull(base) ?? base), real)) continue
    let names: string[]
    try {
      names = readdirSync(dir)
    } catch {
      continue
    }
    for (const name of names) {
      const m = /^\.vx-tmp-([0-9a-z]+)-[0-9a-z]+$/.exec(name)
      if (m === null) continue
      const pid = Number.parseInt(m[1]!, 36)
      if (pid === process.pid || writerAlive(pid)) continue
      // vx never deletes a committed file, whatever its name.
      if (committed(path.join(dir, name))) continue
      rmSync(path.join(dir, name), { force: true })
    }
  }
}

/**
 * Empty `.vx/tmp/` (archive.ts `STAGING`) of the staging directories
 * (`<pid>-<n>`) a killed run left, once per run. One whose writer is alive,
 * another run's or this one's, is left: it may be mid-restore.
 */
export function sweepStaging(workspaceRoot: string): void {
  const top = path.join(workspaceRoot, '.vx', 'tmp')
  let names: string[]
  try {
    names = readdirSync(top)
  } catch {
    return
  }
  for (const name of names) {
    const m = /^([0-9a-z]+)-[0-9a-z]+$/.exec(name)
    if (m === null) continue
    const pid = Number.parseInt(m[1]!, 36)
    if (pid === process.pid || writerAlive(pid)) continue
    rmSync(path.join(top, name), { recursive: true, force: true })
  }
}

function writerAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/**
 * Remove exactly these project-relative paths — the recorded rows of an
 * ADDITIVE task's own artifact (item 588), never a glob: the glob would
 * take the upstream's files the task adds beside. Emptied directories are
 * pruned as `cleanOutputs` prunes them, only inside the declared `outputs`
 * (`pruneScope`), and stop at one the upstream still fills.
 */
export async function cleanOutputPaths(args: {
  projectDir: string
  rels: readonly string[]
  outputs: readonly string[]
  committed?: (abs: string) => boolean
  /** Directories the prune leaves standing even when emptied (absolute). */
  keep?: ReadonlySet<string>
  /** Empty directories to remove too (project-relative). */
  emptyDirs?: readonly string[]
}): Promise<void> {
  const committed = args.committed ?? committedFiles(undefined, args.projectDir)
  const files = args.rels.map((r) => path.resolve(args.projectDir, r)).filter((f) => !committed(f))
  await pruneEmptiedDirs(
    args.projectDir,
    await removeAll(files, args.projectDir),
    pruneScope(args.projectDir, args.outputs),
    args.keep,
    args.emptyDirs?.map((r) => path.resolve(args.projectDir, r)),
  )
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
  outputs: readonly string[]
  nestedProjectDirs: string[]
}): Promise<Map<string, OutputStamp>> {
  return stampFiles(await resolveOutputs(args))
}

/** `stampOutputs` for root-anchored `cache.outputs.workspaceFiles` (A-43). */
export async function stampWorkspaceOutputs(args: {
  workspaceRoot: string
  outputs: readonly string[]
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
  args: { projectDir: string; outputs: readonly string[]; nestedProjectDirs: string[] },
  before: ReadonlyMap<string, OutputStamp>,
): Promise<string[] | undefined> {
  return changedSince(await resolveOutputs(args), before)
}

/** `ownOutputsSince` for root-anchored `cache.outputs.workspaceFiles` (A-43). */
export async function ownWorkspaceOutputsSince(
  args: { workspaceRoot: string; outputs: readonly string[] },
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
  const files = insideRoot(all, root)
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
 * The paths whose directory resolves inside `root`. A link inside the
 * project is followed, as the save follows it (turborepo#13042): a clean
 * that skipped `dist -> real-out` left the last run's files for the next
 * entry to save (X-88). One that leaves the project is never deleted
 * through (X-5); `cleanOutputPaths` takes recorded rows, not the resolver's
 * contained set, so the check is here too, and so is the one into
 * `.git` or `.vx`.
 */
function insideRoot(files: readonly string[], root: string): string[] {
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
      const r = realOrNull(dir)
      if (r === null) ok = true
      else {
        realRoot ??= realOrNull(root) ?? root
        // Where no link moved it, a `.git` is the build's own (inMetadata).
        ok =
          isInside(realRoot, r) &&
          (path.relative(realRoot, r) === path.relative(root, dir) || !inMetadata(r, realRoot))
      }
      own.set(dir, ok)
    }
    return ok
  })
}

/**
 * Remove the directories a clean emptied, and the `emptyDirs` it found
 * (an older build's, which a save would keep), bottom-up, never `root` itself.
 * A restore writes files where the cached entry has them; a directory left
 * standing where the entry holds a FILE of the same name (a task that once
 * wrote `dist/out/…` and now writes `dist/out`) blocks the rename. A directory that still
 * holds something — a stray the globs do not cover — stays, and the restore
 * says so if it is in the way. With a `scope`, only a directory inside it
 * goes (`pruneScope`).
 */
async function pruneEmptiedDirs(
  root: string,
  removed: readonly string[],
  scope?: PruneScope,
  keep?: ReadonlySet<string>,
  emptyDirs: readonly string[] = [],
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
  let level = new Set([...removed.map((f) => path.dirname(f)), ...emptyDirs])
  while (level.size > 0) {
    const parents = new Set<string>()
    const dirs = [...level].filter(
      (dir) =>
        dir !== rootResolved &&
        dir.startsWith(rootResolved + path.sep) &&
        (scope === undefined || inScope(dir, scope)) &&
        keep?.has(dir) !== true,
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

interface PruneScope {
  /** Wildcard globs' roots (`dist` for `dist/**`): prune strictly below. */
  below: string[]
  /** Literal outputs (`out` as a tree): prune the path itself and below. */
  atOrBelow: string[]
}

/**
 * Where a clean, before a miss or a restore, may prune: only the trees the
 * task declared. A directory above a glob's root or holding a literal
 * output (`out` for `out/a.txt`) stays: a sibling task running beside this
 * one may have just made it and not yet written into it, and pruning it
 * failed that task "Directory nonexistent". A glob's root stays: the task
 * writes under it, and a remove there bought only an rmdir and the task's
 * mkdir (B-49). A literal's own path goes: the entry or the task may need
 * a file there. A glob rooted at the project prunes nothing.
 */
function pruneScope(base: string, outputs: readonly string[]): PruneScope {
  const scope: PruneScope = { below: [], atOrBelow: [] }
  for (const g of outputs) {
    if (g.startsWith('!')) continue
    // `literalPath`, as `asTrees` reads it: an escaped `out/\[x\]` is one path.
    const lit = literalPath(normalizeGlob(g))
    if (lit !== null) {
      scope.atOrBelow.push(path.resolve(base, stripTrailingSlash(lit)))
      continue
    }
    const prefix = staticPrefix(g)
    if (prefix !== '.') scope.below.push(path.resolve(base, prefix))
  }
  return scope
}

function inScope(dir: string, scope: PruneScope): boolean {
  return (
    scope.below.some((r) => dir.startsWith(r + path.sep)) ||
    scope.atOrBelow.some((r) => dir === r || dir.startsWith(r + path.sep))
  )
}

/**
 * Resolve declared `outputs.workspaceFiles` globs (workspace-root-
 * relative) to actual produced files. Live-FS glob like
 * `resolveOutputs`, anchored at the workspace root — and deliberately
 * with NO project-dir exclusion: workspace outputs are the documented
 * boundary escape hatch.
 */
export async function resolveWorkspaceOutputs(
  args: {
    workspaceRoot: string
    outputs: readonly string[]
  },
  emptyDirs?: Set<string>,
): Promise<string[]> {
  const { positive, negative } = splitNegations(args.outputs)
  if (positive.length === 0) return []
  const excludeGlobs = [...outputExcludes(positive, 'workspace'), ...asTrees(negative).map(globFor)]
  const trees = asTrees(positive)
  refuseDirLinkedOut(args.workspaceRoot, trees, 'workspace')
  const scanned = [
    ...(await scanUnion(trees, excludeGlobs, args.workspaceRoot, undefined, emptyDirs)),
  ]
  // Same containment as the project twin, anchored one level out. These globs
  // deliberately ignore PROJECT boundaries — that is the escape hatch — but
  // escaping the WORKSPACE was never part of it, and `cleanWorkspaceOutputs`
  // deletes what this returns.
  return containedIn(args.workspaceRoot, scanned).sort()
}

/** `resolveOutputTree` for `outputs.workspaceFiles`: the files and the empty directories. */
export async function resolveWorkspaceOutputTree(args: {
  workspaceRoot: string
  outputs: readonly string[]
}): Promise<{ files: string[]; emptyDirs: string[] }> {
  const emptyDirs = new Set<string>()
  const files = await resolveWorkspaceOutputs(args, emptyDirs)
  return { files, emptyDirs: containedIn(args.workspaceRoot, [...emptyDirs]).sort() }
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
  outputs: readonly string[]
  committed?: (abs: string) => boolean
  /** `cleanOutputs`'s `resolved`, from `resolveWorkspaceOutputs`. */
  resolved?: readonly string[] | undefined
}): Promise<string[]> {
  const committed = committedPastLinks(
    args.workspaceRoot,
    args.committed ?? committedFiles(undefined, args.workspaceRoot),
  )
  sweepRestoreTemps(args.workspaceRoot, args.outputs, committed)
  const tree =
    args.resolved === undefined
      ? await resolveWorkspaceOutputTree(args)
      : { files: args.resolved, emptyDirs: [] }
  const matched = tree.files
  await pruneEmptiedDirs(
    args.workspaceRoot,
    await removeAll(
      matched.filter((f) => !committed(f)),
      args.workspaceRoot,
    ),
    pruneScope(args.workspaceRoot, args.outputs),
    undefined,
    tree.emptyDirs,
  )
  return matched.map((f) => relPosix(args.workspaceRoot, f))
}

function realOrNull(p: string): string | null {
  try {
    return realpathOf(p)
  } catch {
    return null
  }
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
function unanswered(
  literals: readonly string[],
  files: readonly string[],
  newIgnored?: (lit: string) => boolean,
): Set<string> {
  const left = new Set<string>()
  for (const lit of literals) {
    const under = `${lit}/`
    const answered =
      files[lowerBound(files, lit)] === lit ||
      files[lowerBound(files, under)]?.startsWith(under) === true ||
      files.some((rel) => rel === lit || rel.startsWith(under))
    if (!answered || newIgnored?.(lit) === true) left.add(lit)
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
 * The entries a declaration names outright that git answers nothing for: a
 * literal, or a glob's fixed prefix (`dist` of `dist/**`), with no listed
 * path at or under it. Such a path is gitignored or absent, and naming it
 * is asking for it (2026-10-16), so {@link ignoredInputs} reads it
 * from disk. A broad glob (`**`, or `src/**` over a listed `src`) reaches
 * no ignored file: `node_modules` is never walked.
 */
function ignoredReach(
  reach: { prefixes: readonly string[]; literals: readonly string[] },
  listed: readonly string[],
  ignoredIn?: { dir: string; cache: GitFilesCache | undefined },
): readonly string[] {
  let named = outrightMemo.get(reach)
  if (named === undefined) outrightMemo.set(reach, (named = outright(reach)))
  if (named.length === 0) return []
  // Per listing and entries: thousands of tasks share a few declarations.
  let memo = reachMemo.get(listed)
  if (memo === undefined) reachMemo.set(listed, (memo = new Map()))
  const key = named.join('\0')
  let left = memo.get(key)
  if (left === undefined) {
    // A listed path under a named directory git otherwise ignores (a kept
    // `gen/.gitkeep`) answered for the whole of it, and the untracked files
    // beside it never entered the key.
    const cache = ignoredIn?.cache
    const newIgnored =
      cache === undefined
        ? undefined
        : (lit: string) => cache.newFilesIgnored(path.resolve(ignoredIn!.dir, lit))
    memo.set(key, (left = [...unanswered(named, listed, newIgnored)]))
  }
  return left
}

const reachMemo = new WeakMap<readonly string[], Map<string, readonly string[]>>()
// A declaration's plan is memoized, so its entries are reckoned once.
const outrightMemo = new WeakMap<object, string[]>()

/**
 * A declaration's literals and globs' fixed prefixes, each once: none for a
 * glob that starts with a wildcard, and none that leaves the directory the
 * entries are relative to (a project's boundary is hard).
 */
function outright(reach: { prefixes: readonly string[]; literals: readonly string[] }): string[] {
  return [
    ...new Set(
      [...reach.literals, ...reach.prefixes].filter(
        (p) => p !== '' && p !== '.' && p !== '..' && !p.startsWith('../') && !path.isAbsolute(p),
      ),
    ),
  ]
}

/**
 * The files on disk under the {@link ignoredReach} entries that `accept`
 * keeps, sorted and absolute. A file is hashed from disk like any untracked
 * one; nothing here is stored or restored. `node_modules` is no special
 * case (2026-10-16): an ignored path named outright is an input,
 * a generated client (`node_modules/.prisma/client/**`) too; skipping
 * installs here folded such an entry to nothing, silently. lstat, not
 * `exists()`: that answers false for a directory. Never memoized: a
 * dependency writes these mid-run.
 */
function ignoredInputs(
  root: string,
  reach: readonly string[],
  accept: (rel: string) => boolean,
): string[] {
  const found = new Set<string>()
  for (const entry of reach) {
    const abs = path.resolve(root, entry)
    const st = lstatSync(abs, { throwIfNoEntry: false })
    if (st === undefined) continue
    if (!st.isDirectory()) {
      if ((st.isFile() || st.isSymbolicLink()) && accept(entry)) found.add(abs)
      continue
    }
    for (const rel of WALK.scanSync({
      cwd: abs,
      onlyFiles: false,
      followSymlinks: false,
      dot: true,
    })) {
      const full = `${entry}/${rel.split(path.sep).join('/')}`
      if (!accept(full)) continue
      const file = path.join(abs, rel)
      if (isInputOnDisk(file)) found.add(file)
    }
  }
  return [...found].sort()
}

const WALK = new Bun.Glob('**')

interface ResolveFilesArgs {
  projectDir: string
  workspaceRoot: string
  files: readonly string[] | undefined
  ownOutputs: readonly string[]
  /** Root-relative `outputs.workspaceFiles`, and the project's root-relative directory. */
  ownWorkspaceOutputs: readonly string[]
  projectRel: string
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
    `inputs.${field} matched ${names.join(', ')} in ${root}: the name is not valid UTF-8 ` +
      `(shown with \ufffd), and vx cannot read a file by it. Rename it, or exclude it with a ` +
      `negated glob.`,
  )
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
  /**
   * Whether a path is an input but for the task's own outputs: one git
   * tracks stays an input (`committedFiles`), so the key sees an edit to a
   * committed file an output glob reaches.
   */
  ownOnly: Map<string, boolean>
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
          isPositive: throughLinks(positive, anyTaskGlob(asTrees(positive))),
          ...reachOf(positive),
          verdicts: new Map<string, boolean>(),
          ownOnly: new Map<string, boolean>(),
        }
  filesPlans.set(key, plan)
  return plan
}

/**
 * `isPositive`, and each path a glob's static directory passes through:
 * git lists a linked directory as one path, the link, so `lib/**` over
 * `lib -> ../shared` matched nothing, and an edit behind it kept the key
 * the task's last bytes were saved under (2026-10-25). The link is then
 * an input, and its key includes every file behind it.
 */
function throughLinks(
  positive: readonly string[],
  isPositive: (rel: string) => boolean,
): (rel: string) => boolean {
  const through = new Set<string>()
  // Each brace alternative by its own prefix: whole, `{lib,src}/**` has
  // none, and a file behind `lib -> ../shared` was no input.
  for (const g of positive.flatMap(braceAlternatives)) {
    const prefix = staticPrefix(g)
    if (prefix === '.' || prefix === '' || path.isAbsolute(prefix)) continue
    const parts = prefix.split('/')
    for (let i = 1; i <= parts.length; i++) through.add(parts.slice(0, i).join('/'))
  }
  return through.size === 0 ? isPositive : (rel) => isPositive(rel) || through.has(rel)
}

/**
 * Whether a changed path is one of a task's declared file inputs:
 * `projectRel` (the path relative to the project that owns it) against
 * `files`, `workspaceRel` (relative to the workspace root) against
 * `workspaceFiles`; null skips that half, by the globs and `!` exclusions (a path under
 * the task's own outputs counts: a committed one is keyed). `--affected` seeds a task with it (2026-10-04).
 */
export function declaresInput(
  task: TaskConfig,
  projectRel: string | null,
  workspaceRel: string | null,
): boolean {
  const inputs = task.inputs
  if (inputs === undefined) return false
  if (projectRel !== null) {
    // A changed path under the task's own outputs is a committed file
    // (`git diff` lists only what git tracks) or a stray `git status`
    // lists: either way it may be an input, so it counts.
    const plan = filesPlan(inputs.files, task.cache?.outputs.files ?? [])
    if (plan !== null && (inPlan(plan, projectRel) || ownOnly(plan, projectRel))) return true
  }
  const ws = inputs.workspaceFiles
  if (workspaceRel === null || ws === undefined || ws.length === 0) return false
  return workspaceMatcher(ws)(workspaceRel)
}

/**
 * Whether a task's `workspaceFiles` may name a file under `dir`
 * (workspace-relative): a nested repository git reports as that one path,
 * whose files the key folds and a match against the path alone misses.
 * By the entries' static prefixes, so a glob that may descend counts.
 */
export function workspaceFilesReachInto(task: TaskConfig, dir: string): boolean {
  const ws = task.inputs?.workspaceFiles
  if (ws === undefined || ws.length === 0) return false
  return reaches(reachOf(splitNegations(ws).positive).prefixes, dir)
}

/**
 * The paths a task names outright (literals, and globs' fixed prefixes),
 * `files` relative to its project and `workspaceFiles` to the root: where a
 * gitignored input can be (`ignoredReach`).
 */
export function namedOutright(task: TaskConfig): { files: string[]; workspaceFiles: string[] } {
  const inputs = task.inputs
  const plan =
    inputs === undefined ? null : filesPlan(inputs.files, task.cache?.outputs.files ?? [])
  const ws = inputs?.workspaceFiles ?? []
  return {
    files: plan === null ? [] : outright(plan),
    workspaceFiles: ws.length === 0 ? [] : outright(reachOf(splitNegations(ws).positive)),
  }
}

function inPlan(plan: FilesPlan, rel: string): boolean {
  let input = plan.verdicts.get(rel)
  if (input === undefined) {
    input = plan.isPositive(rel) && !plan.isExcluded(rel) && !plan.ownOutput(rel)
    plan.verdicts.set(rel, input)
  }
  return input
}

/** `FilesPlan.ownOnly`, memoised: asked only of a path `inPlan` refused. */
function ownOnly(plan: FilesPlan, rel: string): boolean {
  let own = plan.ownOnly.get(rel)
  if (own === undefined) {
    own = plan.ownOutput(rel) && plan.isPositive(rel) && !plan.isExcluded(rel)
    plan.ownOnly.set(rel, own)
  }
  return own
}

const workspaceMatchers = new Map<string, (rel: string) => boolean>()

function workspaceMatcher(decl: readonly string[]): (rel: string) => boolean {
  const key = JSON.stringify(decl)
  let m = workspaceMatchers.get(key)
  if (m !== undefined) return m
  const { positive, negative } = splitNegations(decl)
  const isPositive = throughLinks(positive, anyTaskGlob(asTrees(positive)))
  const isExcluded = anyTaskGlob([...WORKSPACE_ALWAYS_IGNORE, ...asTrees(negative)])
  m = (rel) => isPositive(rel) && !isExcluded(rel)
  workspaceMatchers.set(key, m)
  return m
}

async function resolveFiles(
  args: ResolveFilesArgs,
): Promise<{ files: string[]; listing?: InputListing }> {
  const plan = filesPlan(args.files, args.ownOutputs)
  if (plan === null) return { files: [] }
  const { isExcluded, ownOutput, positiveGlobs, isPositive } = plan

  const nested = inNestedProject(args.projectDir, args.nestedProjectDirs)
  // Its root-anchored outputs that land in the project, as `files` sees them.
  const ownWsOutput = inProject(args.projectRel, outputMatcher(args.ownWorkspaceOutputs))

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
  const memoKey = filesMemoKey(
    args.projectDir,
    plan,
    args.ownOutputs,
    args.ownWorkspaceOutputs,
    args.nestedProjectDirs,
  )
  let gitFiles = args.gitFilesCache?.snapshotFor(args.projectDir, positiveGlobs)
  let undecodable = args.gitFilesCache?.undecodableNames
  if (gitFiles !== undefined) {
    const memo = args.projectFilesCache?.get(memoKey)
    // Identity, not equality: a re-enumeration hands back a new array even
    // when the file set is unchanged, and that is exactly when this task's
    // inputs must be walked again.
    if (memo !== undefined && memo.snapshot === gitFiles) {
      return {
        files: withIgnored(
          args.projectDir,
          memo.result,
          ignoredReach(plan, gitFiles, { dir: args.projectDir, cache: args.gitFilesCache }),
          plan,
          nested,
          ownWsOutput,
        ),
        listing: listingFor(args, gitFiles, plan, nested, ownWsOutput),
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
    const ls = runGitLsFiles(args.projectDir, listingEnv(args.projectDir, args.workspaceRoot))
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
  const committed = committedFiles(args.gitFilesCache, args.projectDir)
  for (const rel of gitFiles) {
    let input = verdicts.get(rel)
    if (input === undefined) {
      input = isPositive(rel) && !isExcluded(rel) && !ownOutput(rel)
      verdicts.set(rel, input)
    }
    if ((!input && !ownOnly(plan, rel)) || nested(rel) || ownWsOutput(rel)) continue
    const abs = base === undefined ? path.resolve(args.projectDir, rel) : base + rel
    if (!input && !committed(abs)) continue
    candidates.push(abs)
  }
  const reach = ignoredReach(plan, gitFiles, { dir: args.projectDir, cache: args.gitFilesCache })
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
  args.projectFilesCache?.set(memoKey, { snapshot: gitFiles, result: resolved })
  return {
    files: withIgnored(args.projectDir, resolved, reach, plan, nested, ownWsOutput),
    listing: listingFor(args, gitFiles, plan, nested, ownWsOutput),
  }
}

/** The resolved files, plus the gitignored ones the declaration names outright. */
function withIgnored(
  projectDir: string,
  resolved: readonly string[],
  reach: readonly string[],
  plan: FilesPlan,
  nested: (rel: string) => boolean,
  ownWsOutput: (rel: string) => boolean,
): string[] {
  if (reach.length === 0) return [...resolved]
  const extra = ignoredInputs(
    projectDir,
    reach,
    (rel) => inPlan(plan, rel) && !nested(rel) && !ownWsOutput(rel),
  )
  return extra.length === 0 ? [...resolved] : mergeSorted(resolved, extra)
}

function listingFor(
  args: { projectDir: string; workspaceRoot: string; gitFilesCache?: GitFilesCache | undefined },
  listed: readonly string[],
  plan: FilesPlan,
  nested: (rel: string) => boolean,
  ownWsOutput: (rel: string) => boolean,
): InputListing {
  const root = args.projectDir
  let committed: ((abs: string) => boolean) | undefined
  return {
    root,
    workspaceRoot: args.workspaceRoot,
    listed,
    isInput: (rel) =>
      (inPlan(plan, rel) ||
        (ownOnly(plan, rel) &&
          (committed ??= committedFiles(args.gitFilesCache, root))(path.join(root, rel)))) &&
      !ownWsOutput(rel),
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
  /** Where git's location variables point; `root` in a repository below it is listed without them. */
  workspaceRoot: string
  /** Root-relative paths, as git listed them. */
  listed: readonly string[]
  isInput: (rel: string) => boolean
  nested: (rel: string) => boolean
  /** Root-relative directories a positive entry reaches, `''` for the root. */
  prefixes: readonly string[]
  /** The literal entries, each naming one path. */
  literals: readonly string[]
}

function reachOf(entries: readonly string[]): { prefixes: string[]; literals: string[] } {
  // Each alternative names what it would alone: `{gen/a.txt,gen/b.txt}`
  // names both files, as `gen/{a,b}.txt` does; whole, it had no fixed
  // prefix and named nothing (Growth's parity, 2026-10-17).
  const positive = entries.flatMap(braceAlternatives)
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
  for (const rel of runGitLsFiles(l.root, listingEnv(l.root, l.workspaceRoot)).files) {
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
  emptyDirs?: Set<string>,
): Promise<Set<string>> {
  const matches = new Set<string>()
  const links: string[] = []
  const take = (rel: string): void => {
    if (nested(rel) || excludeGlobs.some((g) => g.match(rel))) return
    const abs = path.resolve(cwd, rel)
    const st = lstatSync(abs, { throwIfNoEntry: false })
    if (st !== undefined && (st.isFile() || st.isSymbolicLink())) {
      matches.add(abs)
      if (st.isSymbolicLink()) links.push(abs)
    } else if (emptyDirs !== undefined && st?.isDirectory() === true) {
      if (readdirSync(abs).length === 0) emptyDirs.add(abs)
    } else if (st === undefined && rel.includes('\ufffd')) refuseUndecodableOutput(abs)
  }
  const opts = { cwd, onlyFiles: false, followSymlinks: false, dot: true }
  // `Bun.Glob`'s scan finds nothing for a brace whose alternatives hold a
  // `/`: `{dist,lib/esm}/**` saved an empty artifact, and a hit restored
  // nothing over a cleaned tree (A-10). Expanded here, as discovery does.
  const patterns = positive.flatMap(slashBraceExpansions)
  // A leading `**` walks the whole project whatever else is listed, so the
  // list is one walk: Turbo's `dist/**`, `**/dist/**`, `**/dist` was three,
  // ~2 ms of a warm hit on solid.
  // Not where a static head passes through a link: the one walk does not
  // follow links, and the per-pattern scan enters them (X-88).
  if (
    patterns.length > 1 &&
    patterns.some((p) => p.startsWith('**')) &&
    !patterns.some((p) => headLinked(cwd, p))
  ) {
    const any = anyTaskGlob(patterns)
    for (const rel of WHOLE_TREE.scanSync(opts)) if (any(rel)) take(rel)
    return matches
  }
  for (const pattern of patterns) {
    if (absentPrefix(cwd, pattern)) continue
    const from = scanRoot(cwd, pattern)
    if (from === null) continue
    if (from === undefined) for (const rel of globFor(pattern).scanSync(opts)) take(rel)
    else
      for (const rel of globFor(from.rest).scanSync({ ...opts, cwd: from.dir }))
        take(`${from.prefix}/${rel}`)
  }
  // A literal names the path and its tree (`dist`, `dist/**`), and a tree
  // whose head is a directory link is walked through it: the link and the
  // files under it were one artifact holding `dist` as a file and a
  // directory, refused, so the task never cached. The walk is the output.
  if (links.length > 0) {
    const sorted = [...matches].sort()
    for (const link of links) {
      const under = `${link}/`
      const at = sorted.findIndex((m) => m >= under)
      if (at !== -1 && sorted[at]!.startsWith(under)) matches.delete(link)
    }
  }
  return matches
}

/** `pattern`'s static directory passes through a symlink under `cwd`. */
function headLinked(cwd: string, pattern: string): boolean {
  const prefix = staticPrefix(pattern)
  if (prefix === '.' || path.isAbsolute(prefix)) return false
  let at = cwd
  for (const part of prefix.split('/')) {
    at = path.join(at, part)
    const st = lstatSync(at, { throwIfNoEntry: false })
    if (st === undefined || !st.isDirectory()) return st?.isSymbolicLink() === true
  }
  return false
}

/**
 * Where `pattern`'s scan can start: its static directory, with the rest of
 * the pattern to match there. `Bun.Glob` walks the whole of `cwd` whatever
 * the prefix: `out/d1/**` beside 9000 sibling dirs cost 2.3 ms a scan, twice
 * per miss (2026-10-25). Null when the prefix is a file, which nothing lies
 * under (a literal's `<file>/**` tree). Undefined (scan from `cwd`) for no
 * prefix, an escape, or a prefix that does not stat (a dangling link, a
 * cycle), whose refusals the walk from `cwd` names. A prefix through a
 * link is entered either way.
 */
function scanRoot(
  cwd: string,
  pattern: string,
): { prefix: string; rest: string; dir: string } | null | undefined {
  const prefix = staticPrefix(pattern)
  if (prefix === '.' || prefix.includes('\\') || path.isAbsolute(prefix)) return undefined
  if (!pattern.startsWith(`${prefix}/`) || prefix.split('/').includes('..')) return undefined
  const dir = path.join(cwd, prefix)
  let st
  try {
    st = statSync(dir, { throwIfNoEntry: false })
  } catch {
    return undefined
  }
  if (st === undefined) return undefined
  if (!st.isDirectory()) return null
  return { prefix, rest: pattern.slice(prefix.length + 1), dir }
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

const WHOLE_TREE = new Bun.Glob('**')

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
