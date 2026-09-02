// Resolve declared cache inputs into the concrete pieces that go into the
// cache key:
//   - files: absolute paths whose contents are hashed
//   - envValues: [name, value] pairs from parent process.env
//
// `cache.inputs.env` is the cache-tracking axis for env vars; it's
// independent of `exec.env`, which controls what reaches the child.
//
// File enumeration defers to git — same as Turbo and Nx. We ask git for
// the file set via `git ls-files --cached --others --exclude-standard`,
// which gives us:
//   - all tracked files,
//   - plus untracked-but-not-ignored files,
//   - with nested .gitignore + .git/info/exclude + global excludes
//     correctly applied (because git already does the cascade).
// The user's `inputs.files` globs are then matched as a *filter* on
// top of that file set. vx requires git to be installed and the
// workspace to be a git work tree; non-git environments are not
// supported.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { realpath, rm } from 'node:fs/promises'
import type { CacheInputs } from '../config.js'
import { UserError } from '../util/index.js'

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
  const [runtimeValues, workspaceRuntimeValues] = await Promise.all([
    resolveRuntimeValues(
      args.inputs?.runtime ?? [],
      args.projectDir,
      args.runtimeCache,
      `${args.projectDir}\0`,
    ),
    resolveRuntimeValues(
      args.inputs?.workspaceRuntime ?? [],
      args.workspaceRoot,
      args.workspaceRuntimeCache,
      '',
    ),
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

  const excludeGlobs = [...ALWAYS_IGNORE, ...args.ownWorkspaceOutputs, ...negative].map(
    (p) => new Bun.Glob(p),
  )
  const positiveGlobs = positive.map((p) => new Bun.Glob(p))
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
  const exists = await Promise.all(
    candidates.map((abs) => oids?.has(abs) === true || Bun.file(abs).exists()),
  )
  const matches: string[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (exists[i]) matches.push(candidates[i]!)
  }
  return matches.sort()
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
  const excludeGlobs = boundaryIgnorePatterns(args.projectDir, args.nestedProjectDirs).map(
    (p) => new Bun.Glob(p),
  )
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

/**
 * Per-run memo of each project's `git ls-files` output, plus the
 * staleness bookkeeping that lets the warm path avoid re-spawning git.
 *
 * After a cache-hit restore we know EXACTLY which paths changed on
 * disk: the declared outputs `cleanOutputs` wiped plus the artifact's
 * output files. `markOutputsChanged` records them; `snapshotFor`
 * hands back the existing snapshot when a resolving task's input
 * globs can't match any changed path — provably identical to what a
 * re-spawn would return, since glob matching ignores gitignore status
 * entirely when the path doesn't match. When globs DO overlap,
 * returning undefined forces the caller down the re-spawn path so
 * gitignore semantics stay byte-identical.
 *
 * The cache-miss save path still uses plain `delete` — an executed
 * task may write files outside its declared outputs, and only git can
 * see those.
 */
export class GitFilesCache extends Map<string, readonly string[]> {
  private changed = new Map<string, string[]>()
  /**
   * Per-project trusted index OIDs: absolute path → git blob OID, for
   * tracked regular files whose working-tree state matched the index
   * at populate time (per one `git status --porcelain` snapshot).
   * These feed `Cache.key` via `CacheKeyInput.fileHashes` so a clean
   * tree derives input hashes with zero reads / stats / SQLite.
   *
   * Dropped wholesale on `set` / `delete`: a mid-run re-enumeration
   * proves the project's tree changed, and index OIDs can't be
   * re-trusted without a fresh status — the per-file fallback
   * (`Cache.hashFile`) computes the identical blob OID from disk, so
   * dropping is a pure perf concession, never a correctness one.
   */
  private oids = new Map<string, Map<string, string>>()
  /**
   * Set when `populateGitFilesCache` stored a WORKSPACE-WIDE partition
   * (any loaded task declares `inputs.workspaceFiles`). Null when the
   * feature is unused — every workspace-partition hook below is then a
   * no-op, so unused-feature behavior stays byte-identical.
   */
  private wsRoot: string | null = null
  /**
   * Whether the worktree had any uncommitted changes at populate time,
   * derived from the SAME `git status --porcelain` spawn that prunes
   * dirty paths from the trusted-OID set. Lets the Tier-3 invocation
   * record report `dirty` without a SECOND status spawn. `null` until
   * populate runs, or when the status spawn failed (non-repo).
   */
  private dirty: boolean | null = null

  setWorkspaceRoot(root: string): void {
    this.wsRoot = root
  }

  /** Aggregate worktree dirtiness from the populate-time status spawn. */
  get worktreeDirty(): boolean | null {
    return this.dirty
  }

  setWorktreeDirty(dirty: boolean | null): void {
    this.dirty = dirty
  }

  markOutputsChanged(projectDir: string, relPaths: readonly string[]): void {
    this.recordChanged(projectDir, relPaths)
    // The workspace-wide partition sees the same files under
    // root-relative names; forward so a downstream workspaceFiles
    // task can't reuse a snapshot its globs could now contradict.
    if (this.wsRoot !== null && this.wsRoot !== projectDir) {
      this.recordChanged(
        this.wsRoot,
        relPaths.map((rel) =>
          path.relative(this.wsRoot!, path.resolve(projectDir, rel)).split(path.sep).join('/'),
        ),
      )
    }
  }

  /**
   * Record root-anchored changed paths (cleaned/restored workspace
   * outputs) against EVERY partition that can see them: the workspace
   * partition under their root-relative names, and any project
   * partition whose dir contains them (workspace outputs may land
   * inside other projects' dirs — the no-boundary escape hatch).
   */
  markWorkspaceOutputsChanged(workspaceRoot: string, relPaths: readonly string[]): void {
    if (relPaths.length === 0) return
    for (const key of this.keys()) {
      if (key === workspaceRoot) {
        this.recordChanged(key, relPaths)
        continue
      }
      const under: string[] = []
      for (const rel of relPaths) {
        const abs = path.resolve(workspaceRoot, rel)
        if (abs.startsWith(key + path.sep)) {
          under.push(path.relative(key, abs).split(path.sep).join('/'))
        }
      }
      if (under.length > 0) this.recordChanged(key, under)
    }
  }

  /**
   * Drop the workspace-wide partition (if one exists). Called after a
   * cache-miss save — an executed task may have written undeclared
   * files anywhere in its project dir, and the workspace partition
   * spans that subtree; only a fresh enumeration can see them. No-op
   * when the feature is unused.
   */
  invalidateWorkspacePartition(): void {
    if (this.wsRoot !== null) this.delete(this.wsRoot)
  }

  private recordChanged(partitionDir: string, relPaths: readonly string[]): void {
    if (!this.has(partitionDir)) return
    const cur = this.changed.get(partitionDir)
    if (cur) cur.push(...relPaths)
    else this.changed.set(partitionDir, [...relPaths])
    // These paths just changed on disk; their index OIDs (if any) no
    // longer describe the working-tree content.
    const partitionOids = this.oids.get(partitionDir)
    if (partitionOids) {
      for (const rel of relPaths) partitionOids.delete(path.resolve(partitionDir, rel))
    }
  }

  /** Trusted index OIDs for a project (abs path → oid), if any survive. */
  oidsFor(projectDir: string): ReadonlyMap<string, string> | undefined {
    return this.oids.get(projectDir)
  }

  setOids(projectDir: string, oids: Map<string, string>): void {
    this.oids.set(projectDir, oids)
  }

  /** Snapshot if still valid for these input globs; undefined → re-spawn. */
  snapshotFor(projectDir: string, inputGlobs: readonly Bun.Glob[]): readonly string[] | undefined {
    const snap = this.get(projectDir)
    if (snap === undefined) return undefined
    const pending = this.changed.get(projectDir)
    if (pending !== undefined && pending.some((p) => inputGlobs.some((g) => g.match(p)))) {
      return undefined
    }
    return snap
  }

  override set(key: string, value: readonly string[]): this {
    this.changed.delete(key)
    this.oids.delete(key)
    return super.set(key, value)
  }

  override delete(key: string): boolean {
    this.changed.delete(key)
    this.oids.delete(key)
    return super.delete(key)
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

/** No glob metacharacter — the entry names one exact path. */
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
    (p) => new Bun.Glob(p),
  )

  // Defer to git for the file set (Turbo / Nx parity). Nested .gitignore
  // files, .git/info/exclude, and global excludes all participate
  // correctly because git applies the cascade for us.
  //
  // Per-run memo: each project's git ls-files output is asked for once
  // per task (build + test + lint + …). Spawning git N times for the
  // same project per run is wasteful; we cache the result for the
  // duration of one orchestrator run.
  const positiveGlobs = positive.map((p) => new Bun.Glob(p))
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
  // Second pass: parallel existence check — but ONLY for paths
  // without a trusted index OID. A clean-per-status tracked file
  // necessarily exists on disk, so skipping its probe keeps the warm
  // path free of per-file syscalls. Paths without an OID keep the
  // probe: `git ls-files -s` can surface staged entries whose
  // working-tree file is gone; the hasher would otherwise throw
  // ENOENT.
  const oids = args.gitFilesCache?.oidsFor(args.projectDir)
  const exists = await Promise.all(
    candidates.map((abs) => oids?.has(abs) === true || Bun.file(abs).exists()),
  )
  const matches: string[] = []
  for (let i = 0; i < candidates.length; i++) {
    if (exists[i]) matches.push(candidates[i]!)
  }
  return matches.sort()
}

interface GitLsResult {
  /** cwd-relative paths — same visibility set as `--cached --others`. */
  files: string[]
  /**
   * cwd-relative path → index blob OID, for tracked REGULAR files
   * (mode 100644 / 100755) at stage 0 only. Symlinks are excluded
   * (their OID hashes the link-target string, not the dereferenced
   * content our fallback hasher would read); merge-conflict stages
   * and gitlinks are excluded too. NOT yet filtered by working-tree
   * dirtiness — callers intersect with `git status` before trusting.
   */
  oids: Map<string, string>
}

// `<mode> <oid> <stage>\t<path>` — the staged-entry form of
// `ls-files -s`. `--others` paths print bare; with `-z`,
// core.quotePath quoting is off, so a bare path containing a literal
// tab still can't match this fixed-form prefix.
const LS_FILES_STAGE_RE = /^([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t/

/**
 * Run `git ls-files -s --others --exclude-standard -z .` in `cwd`.
 * One spawn yields BOTH the file list (identical visibility to the
 * pre-v20 `--cached --others` form, verified empirically: same set
 * including staged-but-deleted files and per-stage conflict
 * duplicates) AND each tracked file's index OID — the heart of the
 * Turbo-parity "hashes come from git's index" fast path. Throws a
 * `UserError` when git is unavailable or `cwd` isn't a git work
 * tree; vx requires git. `-z` survives filenames with newlines /
 * spaces.
 */
function runGitLsFiles(cwd: string): GitLsResult {
  let proc
  try {
    proc = Bun.spawnSync({
      cmd: ['git', 'ls-files', '-s', '--others', '--exclude-standard', '-z', '.'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw new UserError(
      `vx requires git: failed to spawn 'git' (working dir: ${cwd}). Install git and re-run.`,
    )
  }
  if (proc.exitCode !== 0) {
    // Exit 128 = not a git work tree; other non-zero = git failure.
    // Either way we can't enumerate inputs reliably.
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    throw new UserError(
      `vx requires git: ${cwd} is not inside a git work tree. ` +
        `Run 'git init' in your workspace root.${stderr ? ` (git: ${stderr})` : ''}`,
    )
  }
  return parseLsFilesOutput(new TextDecoder().decode(proc.stdout))
}

function parseLsFilesOutput(out: string): GitLsResult {
  const files: string[] = []
  const oids = new Map<string, string>()
  if (out.length === 0) return { files, oids }
  // NUL-separated; trailing NUL produces an empty segment we skip.
  for (const record of out.split('\0')) {
    if (record.length === 0) continue
    const m = LS_FILES_STAGE_RE.exec(record)
    if (m === null) {
      files.push(record) // --others entry: bare path
      continue
    }
    const filePath = record.slice(m[0].length)
    files.push(filePath)
    const mode = m[1]!
    const stage = m[3]!
    if ((mode === '100644' || mode === '100755') && stage === '0') {
      oids.set(filePath, m[2]!)
    }
  }
  return { files, oids }
}

/** One completed `git` invocation. */
interface GitRun {
  exitCode: number
  stdout: string
  stderr: string
}

/**
 * Parse `git check-attr -z text eol ident` output — a flat stream of
 * `<path>\0<attr>\0<value>\0` triples — into the set of paths where a clean
 * filter can rewrite bytes. `unspecified` means no rule matched and
 * `unset` (`-text`) explicitly disables conversion; both leave the index blob
 * byte-identical to the worktree file, so those OIDs stay trusted.
 */
export function parseCheckAttrOutput(out: string): Set<string> {
  const affected = new Set<string>()
  const fields = out.split('\0')
  for (let i = 0; i + 2 < fields.length; i += 3) {
    const value = fields[i + 2]!
    if (value !== 'unspecified' && value !== 'unset') affected.add(fields[i]!)
  }
  return affected
}

/**
 * Remove from `trusted` every path whose index blob may differ from its
 * worktree bytes because a clean filter applies.
 *
 * Gated in two steps so the common case pays NOTHING. The precise answer —
 * `git ls-files --eol`, comparing `i/` to `w/` — was measured at 240 ms on a
 * 15k-file tree because it must READ every worktree file: 13x the entire
 * enumeration, on a run whose warm total is ~130 ms, and in the common Linux
 * case it finds nothing. So instead:
 *
 *  1. If `core.autocrlf` is true/input, conversion applies to every
 *     auto-detected text file with no attribute needed — trust nothing.
 *  2. Else, if no attributes source exists anywhere (no in-tree
 *     `.gitattributes`, no `$GIT_DIR/info/attributes`, no
 *     `core.attributesFile`), no rule can name a filter — return untouched,
 *     zero extra work. This is the default `git init` repo.
 *  3. Otherwise ask `git check-attr` (measured 21 ms; it resolves attributes
 *     from the index WITHOUT reading worktree content) and drop only the
 *     paths that actually carry `text`/`eol`/`ident`.
 *
 * Never throws: a probe that fails leaves the map as-is, which is exactly the
 * behaviour before this gate existed.
 */
async function dropFilteredOids(
  trusted: Map<string, string>,
  args: {
    workspaceRoot: string
    gitDir: string
    coreConfig: string
    spawnGit: (a: string[], stdin?: string) => Promise<GitRun | null>
  },
): Promise<void> {
  if (trusted.size === 0) return
  if (autocrlfConverts(args.coreConfig)) {
    trusted.clear()
    return
  }
  // Cheap checks first, and nothing is materialized until one of them fires —
  // on a 15k-file repo with no attributes this whole function is a size check,
  // a substring scan of an empty string, one stat, and a key walk that exits
  // on the first `.gitattributes` it does not find.
  let attributesPossible =
    args.coreConfig.toLowerCase().includes('core.attributesfile') ||
    (args.gitDir !== '' &&
      existsSync(path.resolve(args.workspaceRoot, args.gitDir, 'info', 'attributes')))
  if (!attributesPossible) {
    for (const rel of trusted.keys()) {
      if (rel === '.gitattributes' || rel.endsWith('/.gitattributes')) {
        attributesPossible = true
        break
      }
    }
  }
  if (!attributesPossible) return

  const res = await args.spawnGit(
    ['check-attr', '--stdin', '-z', 'text', 'eol', 'ident'],
    [...trusted.keys()].join('\0'),
  )
  if (res === null || res.exitCode !== 0) return
  for (const rel of parseCheckAttrOutput(res.stdout)) trusted.delete(rel)
}

/** `true` when git may rewrite bytes for EVERY auto-detected text file. */
export function autocrlfConverts(coreConfig: string): boolean {
  for (const line of coreConfig.split('\n')) {
    const [name, value] = [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]
    if (name.toLowerCase() === 'core.autocrlf') {
      const v = value.trim().toLowerCase()
      return v === 'true' || v === 'input'
    }
  }
  return false
}

/**
 * Paths `git ls-files -v -z` marks as not-watched: `S` is skip-worktree, and
 * ANY lowercase letter is assume-unchanged layered on that entry's state.
 * Either way git has been told to stop comparing the worktree file, so its
 * index OID says nothing about what is — or isn't — on disk. Each
 * NUL-terminated record is `<letter><space><path>`.
 */
export function parseFlaggedOutput(out: string): Set<string> {
  const flagged = new Set<string>()
  for (const record of out.split('\0')) {
    if (record.length < 3 || record[1] !== ' ') continue
    const letter = record[0]!
    if (letter === 'S' || (letter >= 'a' && letter <= 'z')) flagged.add(record.slice(2))
  }
  return flagged
}

function parseStatusOutput(out: string): Set<string> {
  const tokens = out.split('\0')
  const dirty = new Set<string>()
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.length < 4) continue
    dirty.add(token.slice(3))
    // X = R or C → the next token is the rename/copy source path.
    const x = token[0]
    if ((x === 'R' || x === 'C') && i + 1 < tokens.length && tokens[i + 1]!.length > 0) {
      i++
      dirty.add(tokens[i]!)
    }
  }
  return dirty
}

/**
 * Strip a repo→workspace `--show-prefix` (e.g. `code/`) from each path, keeping
 * only paths inside the workspace — so a repo-root-relative set (from `git
 * status`/`diff`) is re-keyed workspace-relative to match `git ls-files`. Empty
 * prefix → returns the set unchanged (workspace root IS the git root).
 */
function stripPrefixFromSet(paths: Set<string>, prefix: string): Set<string> {
  if (prefix === '') return paths
  const out = new Set<string>()
  for (const p of paths) if (p.startsWith(prefix)) out.add(p.slice(prefix.length))
  return out
}

/**
 * Run `git ls-files` ONCE at the workspace root, then partition the
 * result by project. Populates `cache` for every project in
 * `projectDirs` with project-relative path lists matching what a
 * per-project spawn would have produced. Throws `UserError` if the
 * workspace isn't a git work tree (vx requires git).
 *
 * Why bulk: each spawn costs ~5-10ms (fork+exec). On a 200-project
 * workspace that's 1-2s of pure overhead reclaimed.
 *
 * Files in nested-project subtrees stay in their parent's list — the
 * boundary-ignore globs in `resolveFiles` filter them out the same way
 * they did before. Cheaper to filter once-per-task than to subtract
 * here.
 *
 * v20: the same `ls-files -s` spawn also yields each tracked file's
 * index OID. A second spawn (`git status --porcelain`) prunes paths
 * whose working tree diverges from the index; what survives is
 * stored per project via `cache.setOids` and feeds `Cache.key`
 * directly — clean-tree input hashing costs zero reads/stats/SQLite.
 *
 * `workspaceWide`: set when any loaded task declares
 * `cache.inputs.workspaceFiles`. Disables pathspec scoping (those
 * globs must see every file from the root) and additionally stores a
 * workspace-wide partition keyed by `workspaceRoot` (files + trusted
 * OIDs), which `resolveWorkspaceFiles` consumes. When false, the
 * enumeration behavior — pathspecs, spawn count, stored partitions —
 * is byte-identical to the pre-workspaceFiles code.
 */
export async function populateGitFilesCache(
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: GitFilesCache,
  workspaceWide = false,
): Promise<void> {
  const enumeration = await startGitEnumeration(
    workspaceRoot,
    gitPathspecs(workspaceRoot, projectDirs, workspaceWide),
  )
  applyGitEnumeration(enumeration, workspaceRoot, projectDirs, cache, workspaceWide)
}

/** What one workspace-wide enumeration learned, before it is partitioned per project. */
export interface GitEnumeration {
  /** Every enumerated path, workspace-relative, tracked and untracked. */
  all: string[]
  /** Workspace-relative path → index OID, for files whose worktree state matched the index. */
  trusted: Map<string, string>
  /** Whether the worktree had uncommitted changes; null when `git status` failed. */
  dirty: boolean | null
}

/**
 * Pathspec scoping: when the run only needs a handful of projects
 * (scoped config loading), let git scan just those dirs — 75 ms →
 * 11 ms on an 11k-file repo. Above 64 dirs (or when a project IS
 * the root) the whole-tree scan wins on arg/exec overhead anyway.
 */
export function gitPathspecs(
  workspaceRoot: string,
  projectDirs: readonly string[],
  workspaceWide: boolean,
): string[] {
  const rels = projectDirs.map((d) => path.relative(workspaceRoot, d).split(path.sep).join('/'))
  const scoped =
    !workspaceWide &&
    rels.length > 0 &&
    rels.length <= 64 &&
    rels.every((r) => r !== '' && r !== '.')
  return scoped ? rels : ['.']
}

/**
 * The spawn half of `populateGitFilesCache`, separated so an UNSCOPED run
 * can start it before the configs are evaluated — the enumeration needs
 * only the pathspecs, and `['.']` is right for every unscoped run — and
 * overlap ~60 ms of git with ~80 ms of config evaluation on a
 * 1000-project tree instead of paying them back to back.
 */
export async function startGitEnumeration(
  workspaceRoot: string,
  pathspecs: readonly string[],
): Promise<GitEnumeration> {
  // The spawns are independent — run them concurrently so the
  // bulk-populate costs max(ls-files, status) wall time, not the sum
  // (status alone is ~74 ms on a 1000-project tree; serial spawning
  // was a measurable warm-path regression vs the pre-OID code).
  const spawnGit = async (args: string[], stdin?: string): Promise<GitRun | null> => {
    try {
      const proc = Bun.spawn({
        cmd: ['git', ...args],
        cwd: workspaceRoot,
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      return { exitCode, stdout, stderr }
    } catch {
      return null
    }
  }
  const [ls, status, prefixRes, flagged, coreCfg] = await Promise.all([
    spawnGit(['ls-files', '-s', '--others', '--exclude-standard', '-z', '--', ...pathspecs]),
    spawnGit(['status', '--porcelain', '-z', '--', ...pathspecs]),
    // Two answers from one spawn. `--show-prefix` is the repo→workspace path
    // (empty when the workspace root IS the git root): `ls-files` prints
    // cwd(workspace)-relative paths but `status` prints repo-root-relative
    // ones, so when the workspace root is a SUBDIR of the git repo the two
    // disagree; this lets us key both the same way below. `--git-dir` locates
    // `info/attributes` for the filter gate (it is not always `.git/` — a
    // linked worktree's `.git` is a FILE pointing elsewhere).
    spawnGit(['rev-parse', '--show-prefix', '--git-dir']),
    // Index-only, so it costs ~5 ms against the enumeration's ~19 ms on a
    // 15k-file tree and runs concurrently with it. `-v` tags each entry with
    // its cache state; a LOWERCASE letter means skip-worktree or
    // assume-unchanged — git has been told to stop looking at the worktree
    // file, so its index OID says nothing about what is (or isn't) on disk.
    spawnGit(['ls-files', '-v', '-z', '--', ...pathspecs]),
    // Reads three config keys, no tree scan — the gate for whether a clean
    // filter can rewrite bytes between the index and the worktree. Exits 1
    // when none are set, which is the common case and means "no gate".
    spawnGit(['config', '--get-regexp', '^core\\.(autocrlf|eol|attributesfile)$']),
  ])
  if (ls === null) {
    throw new UserError(
      `vx requires git: failed to spawn 'git' (working dir: ${workspaceRoot}). Install git and re-run.`,
    )
  }
  if (ls.exitCode !== 0) {
    const stderr = ls.stderr.trim()
    throw new UserError(
      `vx requires git: ${workspaceRoot} is not inside a git work tree. ` +
        `Run 'git init' in your workspace root.${stderr ? ` (git: ${stderr})` : ''}`,
    )
  }
  const { files: all, oids } = parseLsFilesOutput(ls.stdout)
  // Normalize `status`'s repo-root-relative paths to workspace-relative (strip
  // the `--show-prefix`) so the dirty set is keyed identically to the trusted
  // OID map. Without this, when the workspace root is a git subdir, a modified
  // tracked file is never pruned from `trusted` and keeps its committed OID —
  // a STALE cache hit serving old outputs. Empty prefix (workspace == git root,
  // the common case) is a zero-cost no-op. Paths above the workspace can't be
  // inputs, so they drop out of the set.
  // One spawn, two lines: `--show-prefix` then `--git-dir`.
  const revLines =
    prefixRes !== null && prefixRes.exitCode === 0 ? prefixRes.stdout.split('\n') : []
  const gitPrefix = (revLines[0] ?? '').trim()
  const gitDir = (revLines[1] ?? '').trim()
  const dirtyRaw =
    status !== null && status.exitCode === 0 ? parseStatusOutput(status.stdout) : null
  const dirty = dirtyRaw === null ? null : stripPrefixFromSet(dirtyRaw, gitPrefix)
  // Aggregate dirtiness for the Tier-3 invocation record — derived from
  // this same status spawn so `run()` needs no second `git status`.
  // null when the status spawn failed (non-repo / git error).
  const worktreeDirty = dirty === null ? null : dirty.size > 0
  const trusted = dirty === null ? new Map<string, string>() : oids
  if (dirty !== null) {
    for (const rel of dirty) trusted.delete(rel)
  }
  // A skip-worktree / assume-unchanged path sits at stage 0 and `git status`
  // reports nothing for it, so it would otherwise keep a trusted OID — and
  // resolveFiles SKIPS its existence probe for OID-carrying paths. A sparse
  // checkout would then count a file that is not on disk as an input, so
  // materializing it later changes no key and the old artifact is replayed.
  // Dropping the OID sends these back through the probe, where they correctly
  // fall out of the input set while unmaterialized.
  if (flagged !== null && flagged.exitCode === 0) {
    for (const rel of parseFlaggedOutput(flagged.stdout)) trusted.delete(rel)
  }
  // An index OID is only the file's content hash when git stores the worktree
  // bytes VERBATIM. Under a clean filter (`text`/`eol`/`ident`) the blob is a
  // DIFFERENT sequence of bytes — the LF-normalized form — while the task
  // reads the CRLF worktree file. `git status` compares AFTER filtering, so
  // such a file reports clean and keeps its OID: the CRLF and LF states then
  // fold the SAME key and a real content change is invisible.
  //
  // Dropping an OID is not over-invalidation. It routes the path to
  // `hashFile`, which hashes the worktree bytes — the source that was correct
  // all along. The only cost is the read, so the gate below is about paying it
  // ONLY where a filter can actually apply.
  await dropFilteredOids(trusted, {
    workspaceRoot,
    gitDir,
    coreConfig: coreCfg !== null && coreCfg.exitCode === 0 ? coreCfg.stdout : '',
    spawnGit,
  })
  return { all, trusted, dirty: worktreeDirty }
}

/** The partition half of `populateGitFilesCache`: store per-project slices of one enumeration. */
export function applyGitEnumeration(
  enumeration: GitEnumeration,
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: GitFilesCache,
  workspaceWide = false,
): void {
  const { all, trusted } = enumeration
  cache.setWorktreeDirty(enumeration.dirty)
  // Sort once, then each project's files are a contiguous range found
  // by binary search on its `dir/` prefix — O((F+P) log F) instead of
  // the O(P·F) per-project startsWith scan (54 ms at 1090 projects ×
  // ~9k files; ~5 ms this way). '/' sorts below most filename chars,
  // so the range [prefix, prefix+'\xff…') is contiguous in the sorted
  // array; lowerBound on `prefix` and on `prefix + '￿'` bracket it.
  const sorted = [...all].sort()
  const lowerBound = (key: string): number => {
    let lo = 0
    let hi = sorted.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (sorted[mid]! < key) lo = mid + 1
      else hi = mid
    }
    return lo
  }
  for (const projectDir of projectDirs) {
    const relPrefix = path.relative(workspaceRoot, projectDir).split(path.sep).join('/')
    if (relPrefix === '' || relPrefix === '.') {
      cache.set(projectDir, all)
      const rootOids = new Map<string, string>()
      for (const [rel, oid] of trusted) rootOids.set(path.join(workspaceRoot, rel), oid)
      cache.setOids(projectDir, rootOids)
      continue
    }
    const prefix = `${relPrefix}/`
    const start = lowerBound(prefix)
    const end = lowerBound(`${prefix}￿`)
    const matches: string[] = []
    const projOids = new Map<string, string>()
    for (let i = start; i < end; i++) {
      const rel = sorted[i]!
      matches.push(rel.slice(prefix.length))
      const oid = trusted.get(rel)
      if (oid !== undefined) projOids.set(path.join(workspaceRoot, rel), oid)
    }
    // setOids AFTER set — set() drops the project's OID slot.
    cache.set(projectDir, matches)
    cache.setOids(projectDir, projOids)
  }
  if (workspaceWide) {
    const rootOids = new Map<string, string>()
    for (const [rel, oid] of trusted) rootOids.set(path.join(workspaceRoot, rel), oid)
    cache.set(workspaceRoot, all)
    cache.setOids(workspaceRoot, rootOids)
    cache.setWorkspaceRoot(workspaceRoot)
  }
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
    const glob = new Bun.Glob(pattern)
    for await (const rel of glob.scan({ cwd, onlyFiles: true, dot: true })) {
      if (excludeGlobs.some((g) => g.match(rel))) continue
      matches.add(path.resolve(cwd, rel))
    }
  }
  return matches
}

function boundaryIgnorePatterns(projectDir: string, nestedDirs: string[]): string[] {
  return nestedDirs.map((d) => {
    const rel = path.relative(projectDir, d).split(path.sep).join('/')
    return `${rel}/**`
  })
}
