// Git-backed input enumeration: one `git ls-files -s` + one `git status
// --porcelain -z` per run (plus `check-attr` where a filter could convert
// bytes), parsed into the per-project `GitFilesCache` that `inputs.ts`'s
// glob resolution trusts for blob OIDs. Split from `inputs.ts` on
// 2026-09-10: this file talks to git; `inputs.ts` decides which files a
// task declared. Nothing here reads a config or applies a boundary.

import path from 'node:path'
import { existsSync } from 'node:fs'
import { UserError } from '../util/index.js'

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

/** No glob metacharacter — the entry names one exact path. */

interface GitLsResult {
  /** cwd-relative paths — same visibility set as `--cached --others`. */
  files: string[]
  /**
   * cwd-relative path → index blob OID, for tracked regular files
   * (mode 100644 / 100755) and symlinks (120000) at stage 0 only. A
   * symlink's OID is the blob of its target string, which is exactly
   * what `Cache.hashFile` computes for one, so the two paths agree.
   * Merge-conflict stages and gitlinks are excluded. NOT yet filtered
   * by working-tree dirtiness — callers intersect with `git status`
   * before trusting.
   */
  oids: Map<string, string>
  /** Paths flagged skip-worktree / assume-unchanged (only when `-v` was passed). */
  flagged: Set<string>
}

const LS_FILES_STAGE_RE = /^(?:([A-Za-z]) )?([0-7]{6}) ([0-9a-f]{40,64}) ([0-3])\t/

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
export function runGitLsFiles(cwd: string): GitLsResult {
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

// Each `ls-files -s -v` record is `[<flag> ]<mode> <oid> <stage>\t<path>` —
// the staged-entry form, with an optional cache-state letter (`H`, `S`,
// `h`, …) in front. `--others` paths print bare; with `-z`, core.quotePath
// quoting is off, so a bare path containing a literal tab still cannot
// match the fixed-form prefix. Both answers come from ONE spawn.
function parseLsFilesOutput(out: string): GitLsResult {
  const files: string[] = []
  const oids = new Map<string, string>()
  const flagged = new Set<string>()
  if (out.length === 0) return { files, oids, flagged }
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
    const mode = m[2]!
    const stage = m[4]!
    if ((mode === '100644' || mode === '100755' || mode === '120000') && stage === '0') {
      oids.set(filePath, m[3]!)
    }
    // A LOWERCASE letter means skip-worktree or assume-unchanged (`S` is the
    // older spelling of skip-worktree): git has been told to stop looking at
    // the worktree file, so its index OID says nothing about the disk.
    const flag = m[1]
    if (flag !== undefined && (flag === 'S' || (flag >= 'a' && flag <= 'z'))) flagged.add(filePath)
  }
  return { files, oids, flagged }
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

function parseStatusOutput(out: string): { dirty: Set<string>; untracked: string[] } {
  const tokens = out.split('\0')
  const dirty = new Set<string>()
  const untracked: string[] = []
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!
    if (token.length < 4) continue
    if (token[0] === '?') {
      untracked.push(token.slice(3))
      continue
    }
    dirty.add(token.slice(3))
    // X = R or C → the next token is the rename/copy source path.
    const x = token[0]
    if ((x === 'R' || x === 'C') && i + 1 < tokens.length && tokens[i + 1]!.length > 0) {
      i++
      dirty.add(tokens[i]!)
    }
  }
  return { dirty, untracked }
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
  // Four spawns, one worktree walk. `ls-files -s -v` reads the INDEX only
  // (~9 ms on a 1000-project tree) and answers two questions at once: every
  // tracked path's OID and its cache-state flag. `status -uall` is the one
  // command that walks the worktree, and it answers two as well: which
  // tracked paths are dirty AND which files are untracked. Asking
  // `ls-files --others` for the untracked set walked the same tree a second
  // time (~50 ms of CPU, concurrent with status but contending with it).
  const [ls, status, prefixRes, coreCfg] = await Promise.all([
    spawnGit(['ls-files', '-s', '-v', '-z', '--', ...pathspecs]),
    spawnGit(['status', '--porcelain', '-z', '-uall', '--', ...pathspecs]),
    // Two answers from one spawn. `--show-prefix` is the repo→workspace path
    // (empty when the workspace root IS the git root): `ls-files` prints
    // cwd(workspace)-relative paths but `status` prints repo-root-relative
    // ones, so when the workspace root is a SUBDIR of the git repo the two
    // disagree; this lets us key both the same way below. `--git-dir` locates
    // `info/attributes` for the filter gate (it is not always `.git/` — a
    // linked worktree's `.git` is a FILE pointing elsewhere).
    spawnGit(['rev-parse', '--show-prefix', '--git-dir']),
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
  const { files: tracked, oids, flagged } = parseLsFilesOutput(ls.stdout)
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
  const parsedStatus =
    status !== null && status.exitCode === 0 ? parseStatusOutput(status.stdout) : null
  const dirty = parsedStatus === null ? null : stripPrefixFromSet(parsedStatus.dirty, gitPrefix)
  // Untracked files are inputs too (a new file is the commonest edit there
  // is). They come from the status walk, repo-root-relative like the dirty
  // set. Without a status answer the enumeration is the index alone.
  const untracked =
    parsedStatus === null ? [] : [...stripPrefixFromSet(new Set(parsedStatus.untracked), gitPrefix)]
  const all = untracked.length === 0 ? tracked : tracked.concat(untracked)
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
  for (const rel of flagged) trusted.delete(rel)
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
