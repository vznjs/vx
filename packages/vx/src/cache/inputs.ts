// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs from parent process.env
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
import { lstatSync } from 'node:fs'
import { realpath, rm } from 'node:fs/promises'
import type { CacheInputs } from '../config.js'
import { UserError } from '../util/index.js'
import { GitFilesCache, runGitLsFiles } from './git-inputs.js'

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
  type GitEnumeration,
} from './git-inputs.js'

// vx-lock.json is committed (so git enumerates it) but it's vx's own
// frozen-config metadata — never a task input. Excluded globally so a
// re-lock can't bust every cache key the way a tracked source file
// would. (Literal pattern, not the workspace `LOCKFILE_NAME` constant:
// cache is a leaf module and must not import from workspace.)
const ALWAYS_IGNORE = [
  '**/node_modules/**',
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
]

const DEFAULT_FILE_GLOBS: readonly string[] = ['**/*']

export interface ResolvedInputs {
  files: string[]
  envValues: Array<[name: string, value: string]>
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
   * the hash + sandbox-baseline resolveInputs calls.
   */
  runtimeCache?: Map<string, Promise<string>>
  /**
   * Run-scoped memo for `cache.inputs.workspaceRuntime`, keyed by command
   * only — global dedup so a root-level probe spawns once per run.
   */
  workspaceRuntimeCache?: Map<string, Promise<string>>
}

export async function resolveInputs(args: ResolveInputsArgs): Promise<ResolvedInputs> {
  const projectFiles = await resolveFiles({
    projectDir: args.projectDir,
    workspaceRoot: args.workspaceRoot,
    files: args.inputs?.files,
    ownOutputs: args.ownOutputs,
    nestedProjectDirs: args.nestedProjectDirs,
    ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
  })
  let files = projectFiles
  const wsDecl = args.inputs?.workspaceFiles
  if (wsDecl !== undefined && wsDecl.length > 0) {
    const wsFiles = await resolveWorkspaceFiles({
      workspaceRoot: args.workspaceRoot,
      workspaceFiles: wsDecl,
      ownWorkspaceOutputs: args.ownWorkspaceOutputs ?? [],
      ...(args.gitFilesCache !== undefined ? { gitFilesCache: args.gitFilesCache } : {}),
    })
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
            args.runtimeCache,
            `${args.projectDir}\0`,
          ),
          resolveRuntimeValues(wsRuntimeDecl, args.workspaceRoot, args.workspaceRuntimeCache, ''),
        ])
  return {
    files,
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
async function resolveWorkspaceFiles(args: {
  workspaceRoot: string
  workspaceFiles: readonly string[]
  ownWorkspaceOutputs: readonly string[]
  gitFilesCache?: GitFilesCache
}): Promise<string[]> {
  const positive: string[] = []
  const negative: string[] = []
  for (const entry of args.workspaceFiles) {
    if (entry.startsWith('!')) negative.push(entry.slice(1))
    else positive.push(entry)
  }
  if (positive.length === 0) return []

  const excludeGlobs = [...ALWAYS_IGNORE, ...args.ownWorkspaceOutputs, ...negative].map(globFor)
  const positiveGlobs = positive.map(globFor)
  // Workspace-wide partition, keyed by the workspace root. Populated
  // up-front by `populateGitFilesCache(..., workspaceWide: true)` when
  // any loaded task declares workspaceFiles; a missing/invalidated
  // partition re-spawns git at the root on demand.
  let gitFiles = args.gitFilesCache?.snapshotFor(args.workspaceRoot, positiveGlobs)
  if (gitFiles === undefined) {
    gitFiles = runGitLsFiles(args.workspaceRoot).files
    args.gitFilesCache?.set(args.workspaceRoot, gitFiles)
  }
  // Second call site of the literal-input guard. `resolveWorkspaceFiles`
  // carries its own copy of the filter-over-git-set design, so the same
  // silently-folds-nothing hazard exists here — and a fix applied only to the
  // project half would pass that half's tests while leaving this one live.
  const unmatchedLiterals = new Set(positive.filter(isLiteralPath))
  const candidates: string[] = []
  for (const rel of gitFiles) {
    if (unmatchedLiterals.size > 0) unmatchedLiterals.delete(rel)
    if (!positiveGlobs.some((g) => g.match(rel))) continue
    if (excludeGlobs.some((g) => g.match(rel))) continue
    candidates.push(path.resolve(args.workspaceRoot, rel))
  }
  if (unmatchedLiterals.size > 0) {
    await assertNoInvisibleLiteralInputs(unmatchedLiterals, args.workspaceRoot, 'workspaceFiles')
  }
  // Same OID-trust shortcut as project files: a clean-per-status
  // tracked file necessarily exists on disk.
  const oids = args.gitFilesCache?.oidsFor(args.workspaceRoot)
  return candidates.filter((abs) => oids?.has(abs) === true || isInputOnDisk(abs)).sort()
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

function resolveEnvValues(
  names: readonly string[],
  source: NodeJS.ProcessEnv,
): Array<[string, string]> {
  return [...names].sort().map((name) => [name, source[name] ?? ''] as [string, string])
}

/**
 * Run one runtime-input command via `sh -c` (so pipelines / redirects
 * work — "shell is the API"). Returns trimmed stdout+stderr. A non-zero
 * exit is a hard UserError naming the command (fail-loud, like git).
 */
async function runRuntimeCommand(command: string, cwd: string): Promise<string> {
  let proc
  try {
    proc = Bun.spawn(['sh', '-c', command], {
      cwd,
      stdin: 'ignore',
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw new UserError(`cache.inputs runtime command failed to spawn: ${command} (cwd: ${cwd})`)
  }
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const output = `${stdout}${stderr}`.trim()
  if (exitCode !== 0) {
    throw new UserError(
      `cache.inputs runtime command exited ${exitCode}: ${command} (cwd: ${cwd})` +
        (output ? `\n${output}` : ''),
    )
  }
  return output
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
        p = runRuntimeCommand(cmd, cwd)
        memo?.set(key, p)
      }
      return [cmd, await p] as [string, string]
    }),
  )
}

/** Resolve declared output globs (project-relative) to actual produced files. */
export async function resolveOutputs(args: {
  projectDir: string
  outputs: string[]
  nestedProjectDirs: string[]
}): Promise<string[]> {
  if (args.outputs.length === 0) return []
  const excludeGlobs = boundaryIgnorePatterns(args.projectDir, args.nestedProjectDirs).map(globFor)
  const scanned = [...(await scanUnion(args.outputs, excludeGlobs, args.projectDir))]
  // Containment, enforced HERE and not only at the loader. `cleanOutputs`
  // DELETES whatever this returns, and `Bun.Glob.scan` happily walks `..` out
  // of its cwd — so the loader's `..`/absolute rejection alone was a single
  // point of failure. The resolver that feeds the delete refuses to name a path
  // outside the project, so any future caller reaching it by another route (a
  // programmatic embedder, a config source that skips the loader) is contained
  // by construction.
  return (await containedIn(args.projectDir, scanned)).sort()
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
async function containedIn(root: string, paths: readonly string[]): Promise<string[]> {
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
  const realRoot = await realpath(root).catch(() => root)
  const uniqueDirs = [...new Set(lexDirs)]
  const resolved = await Promise.all(uniqueDirs.map((d) => realpath(d).catch(() => null)))
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
}): Promise<string[]> {
  const files = await resolveOutputs(args)
  // `force: true` makes rm tolerate ENOENT (e.g. when two output
  // globs overlap and a sibling already deleted a path mid-iteration).
  await Promise.all(files.map((f) => rm(f, { force: true })))
  // Project-relative posix paths of what was removed — the caller
  // feeds these to GitFilesCache.markOutputsChanged after a restore.
  return files.map((f) => path.relative(args.projectDir, f).split(path.sep).join('/'))
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
  if (args.outputs.length === 0) return []
  const scanned = [...(await scanUnion(args.outputs, [], args.workspaceRoot))]
  // Same containment as the project twin, anchored one level out. These globs
  // deliberately ignore PROJECT boundaries — that is the escape hatch — but
  // escaping the WORKSPACE was never part of it, and `cleanWorkspaceOutputs`
  // deletes what this returns.
  return (await containedIn(args.workspaceRoot, scanned)).sort()
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
  await Promise.all(files.map((f) => rm(f, { force: true })))
  return files.map((f) => path.relative(args.workspaceRoot, f).split(path.sep).join('/'))
}

function isLiteralPath(glob: string): boolean {
  return !/[*?[\]{}]/.test(glob)
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
 */
async function assertNoInvisibleLiteralInputs(
  literals: ReadonlySet<string>,
  base: string,
  field: 'files' | 'workspaceFiles' = 'files',
): Promise<void> {
  for (const rel of literals) {
    if (!(await Bun.file(path.resolve(base, rel)).exists())) continue
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
}

async function resolveFiles(args: ResolveFilesArgs): Promise<string[]> {
  const positive: string[] = []
  const negative: string[] = []

  if (args.files === undefined) {
    positive.push(...DEFAULT_FILE_GLOBS)
  } else {
    for (const entry of args.files) {
      if (entry.startsWith('!')) negative.push(entry.slice(1))
      else positive.push(entry)
    }
  }

  if (positive.length === 0) return []

  const boundaryIgnores = boundaryIgnorePatterns(args.projectDir, args.nestedProjectDirs)
  const excludeGlobs = [...ALWAYS_IGNORE, ...boundaryIgnores, ...args.ownOutputs, ...negative].map(
    globFor,
  )

  // Defer to git for the file set (Turbo / Nx parity). Nested .gitignore
  // files, .git/info/exclude, and global excludes all participate
  // correctly because git applies the cascade for us.
  //
  // Per-run memo: each project's git ls-files output is asked for once
  // per task (build + test + lint + …). Spawning git N times for the
  // same project per run is wasteful; we cache the result for the
  // duration of one orchestrator run.
  const positiveGlobs = positive.map(globFor)
  let gitFiles = args.gitFilesCache?.snapshotFor(args.projectDir, positiveGlobs)
  if (gitFiles === undefined) {
    // Mid-run re-enumeration. The OIDs this spawn could yield are NOT
    // trusted (no fresh `git status` to vouch for them — the project's
    // tree just changed); set() drops the project's OID slot and these
    // files fall back to Cache.hashFile, which computes the identical
    // blob OID from disk.
    gitFiles = runGitLsFiles(args.projectDir).files
    // set() also clears the project's pending-changed bookkeeping.
    args.gitFilesCache?.set(args.projectDir, gitFiles)
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
  const unmatchedLiterals = new Set(positive.filter(isLiteralPath))
  // First pass: glob-filter to candidate absolute paths (no I/O).
  const candidates: string[] = []
  for (const rel of gitFiles) {
    if (unmatchedLiterals.size > 0) unmatchedLiterals.delete(rel)
    let matched = false
    for (const g of positiveGlobs) {
      if (g.match(rel)) {
        matched = true
        break
      }
    }
    if (!matched) continue
    if (excludeGlobs.some((g) => g.match(rel))) continue
    candidates.push(path.resolve(args.projectDir, rel))
  }
  if (unmatchedLiterals.size > 0) {
    await assertNoInvisibleLiteralInputs(unmatchedLiterals, args.projectDir, 'files')
  }
  // Second pass: existence check — but ONLY for paths without a
  // trusted index OID. A clean-per-status tracked file necessarily
  // exists on disk, so skipping its probe keeps the warm path free of
  // per-file syscalls. Paths without an OID keep the probe:
  // `git ls-files -s` can surface staged entries whose working-tree
  // file is gone; the hasher would otherwise throw ENOENT.
  const oids = args.gitFilesCache?.oidsFor(args.projectDir)
  return candidates.filter((abs) => oids?.has(abs) === true || isInputOnDisk(abs)).sort()
}

/**
 * Union of files matching any positive pattern in `cwd`, minus files
 * matching any exclude glob (tested by Bun.Glob.match on the relative
 * path). Bun.Glob takes a single pattern per instance, so we iterate.
 */
async function scanUnion(
  positive: readonly string[],
  excludeGlobs: readonly Bun.Glob[],
  cwd: string,
): Promise<Set<string>> {
  const matches = new Set<string>()
  for (const pattern of positive) {
    const glob = globFor(pattern)
    // Sync scan. The async walk was chosen on 2026-09-02, when a warm HIT
    // globbed its outputs and the thread pool overlapped a thousand of
    // them; the directory short-circuit took the glob off the hit path, and
    // what is left runs on the MISS path twice per task (clean, then
    // resolve), where the walk is CPU-bound and each async chunk costs a
    // main-thread round trip. Measured 2026-09-09 on a 1,000-task cold run
    // (see STATUS).
    for (const rel of glob.scanSync({ cwd, onlyFiles: true, dot: true })) {
      if (excludeGlobs.some((g) => g.match(rel))) continue
      matches.add(path.resolve(cwd, rel))
    }
  }
  return matches
}

// Compiled once per pattern string for the life of the process: a `Bun.Glob`
// is immutable, and the same handful of declared globs are compiled again
// for every task otherwise (three sites, up to thousands of times per run).
const globMemo = new Map<string, Bun.Glob>()
function globFor(pattern: string): Bun.Glob {
  let g = globMemo.get(pattern)
  if (g === undefined) globMemo.set(pattern, (g = new Bun.Glob(pattern)))
  return g
}

function boundaryIgnorePatterns(projectDir: string, nestedDirs: string[]): string[] {
  return nestedDirs.map((d) => {
    const rel = path.relative(projectDir, d).split(path.sep).join('/')
    return `${rel}/**`
  })
}
