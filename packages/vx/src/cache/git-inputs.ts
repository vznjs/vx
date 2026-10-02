// Git-backed input enumeration: one `git ls-files -s` + one `git status
// --porcelain -z` per run (plus `check-attr` where a filter could convert
// bytes), parsed into the per-project `GitFilesCache` that `inputs.ts`'s
// glob resolution trusts for blob OIDs. Split from `inputs.ts` on
// 2026-09-10: this file talks to git; `inputs.ts` decides which files a
// task declared. Nothing here reads a config or applies a boundary.

import path from 'node:path'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { UserError, executablePath, gitSpawnRefusal } from '../util/index.js'

/** Three facts of the repository a directory is in, from one `git rev-parse`. */
export interface RepoFacts {
  /** `--show-prefix`: the directory's path below the worktree root, `''` at the root. */
  prefix: string
  /** `--git-common-dir` as git prints it, relative to the directory asked. */
  commonDir: string
  /** `--show-object-format`: the hash the index's blob OIDs are in. */
  objectFormat: 'sha1' | 'sha256'
}

const repoFactsMemo = new Map<string, RepoFacts>()

/**
 * The enumeration needs the prefix and the common dir, the file hasher the
 * object format: one spawn answers all three, once per directory for the
 * life of the process — none of them moves while vx runs. A failure (no
 * git, not a repository) is not remembered; the callers degrade on null.
 * Synchronous so a reader that cannot wait (`hashBytes`, in the config
 * load) and the enumeration share one answer whichever asks first.
 */
export function repoFacts(dir: string): RepoFacts | null {
  const hit = repoFactsMemo.get(dir)
  if (hit !== undefined) return hit
  let proc
  try {
    proc = Bun.spawnSync({
      cmd: [
        executablePath('git'),
        'rev-parse',
        '--show-prefix',
        '--git-common-dir',
        '--show-object-format',
      ],
      cwd: dir,
      stdout: 'pipe',
      stderr: 'ignore',
    })
  } catch {
    return null
  }
  if (proc.exitCode !== 0) return null
  // One line per flag, in order. A git that does not know
  // `--show-object-format` echoes it back, as it does any unknown flag,
  // which reads as sha1 — what the flag's own spawn answered there too.
  const [prefix = '', commonDir = '', format = ''] = new TextDecoder()
    .decode(proc.stdout)
    .split('\n')
    .map((l) => l.trim())
  const facts: RepoFacts = {
    prefix,
    commonDir,
    objectFormat: format === 'sha256' ? 'sha256' : 'sha1',
  }
  repoFactsMemo.set(dir, facts)
  return facts
}

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
  /**
   * Absolute paths, as git's lossy decoding spells them, of enumerated
   * files whose names are not UTF-8 (`decodeGitZ`). Such a name cannot
   * be opened from a string, so `resolveFiles` refuses one it would fold.
   */
  private undecodable = new Set<string>()
  /**
   * When the enumeration that vouched for `oids` started (ms since the
   * epoch): an index OID says what a file held when `git status` looked,
   * so a file changed since may hold something else (item 743). Unset on
   * a cache no enumeration filled; its OIDs are then re-checked by content.
   */
  enumeratedAtMs: number | undefined

  get undecodableNames(): ReadonlySet<string> {
    return this.undecodable
  }

  markUndecodable(absPaths: readonly string[]): void {
    for (const p of absPaths) this.undecodable.add(p)
  }

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
    // A partition with no snapshot has nothing for a mark to invalidate
    // (`snapshotFor` answers undefined either way), so this guard bounds
    // memory for a project the enumeration left without a partition; it
    // is not a rule, and deleting it survives the whole core suite (item
    // 648).
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

  /** Tracked files a task's clean removed this run, and whose clean (A-48). */
  private trackedCleans: Array<{ path: string; by: string }> = []

  /**
   * Note which of the files a task's clean just removed git tracks. Called
   * before `markOutputsChanged`, which drops their OIDs. A committed output
   * another task reads with no edge to its producer is gone for as long as
   * the producer runs (vueuse's `metadata/index.json`, N's dogfood), and the
   * reader failed naming only the missing file (A-48).
   */
  noteClean(by: string, dir: string, rels: readonly string[]): void {
    const oids = this.oids.get(dir)
    if (oids === undefined) return
    for (const rel of rels) {
      const abs = path.resolve(dir, rel)
      if (oids.has(abs)) this.trackedCleans.push({ path: abs, by })
    }
  }

  /** The tracked files other tasks' cleans removed that are still missing. */
  trackedCleansMissing(except: string): Array<{ path: string; by: string }> {
    return this.trackedCleans.filter((c) => c.by !== except && !existsSync(c.path))
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

  override clear(): void {
    this.changed.clear()
    this.oids.clear()
    super.clear()
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
  /** Gitlinks (mode 160000): a submodule or an embedded repository, one entry for its whole tree. */
  gitlinks: Set<string>
  /** cwd-relative paths whose names are not UTF-8, spelled lossily (`decodeGitZ`). */
  undecodable: string[]
}

/**
 * git's `-z` output as text, plus the NUL-separated records that were not
 * UTF-8. git prints a path's bytes as they are, and a lossy decode turns
 * `x\xffy` into `x\ufffdy`, which names no file: the name reached the
 * input set, failed the disk probe, and dropped out of the key silently,
 * so every edit to it was a hit (turborepo#9345). Nothing in vx can open a
 * path a string cannot spell, so such a record is kept (lossily, so a
 * glob still matches it) and named, for `resolveFiles` to refuse.
 *
 * The common output holds no U+FFFD at all. Measured on a 1.3 MB,
 * 15,000-record listing (min of 2,000, interleaved): the lossy decode plus
 * the U+FFFD check cost 0.17 ms against 0.10 for the `Response.text()` it
 * replaced, and the check alone 0.003; a fatal decode of the whole output
 * ran 0.73 ms at the median against 0.26. Only output holding a U+FFFD,
 * from an invalid byte or from a name that really holds one, is split at
 * its NULs and each record decoded fatally, which tells the two apart.
 */
function decodeGitZ(bytes: Uint8Array): { text: string; undecodable: Set<string> } {
  const undecodable = new Set<string>()
  const text = LOSSY_UTF8.decode(bytes)
  if (!text.includes('\ufffd')) return { text, undecodable }
  let start = 0
  for (let i = 0; i <= bytes.length; i++) {
    if (i < bytes.length && bytes[i] !== 0) continue
    const record = bytes.subarray(start, i)
    try {
      FATAL_UTF8.decode(record)
    } catch {
      undecodable.add(LOSSY_UTF8.decode(record))
    }
    start = i + 1
  }
  return { text, undecodable }
}

const LOSSY_UTF8 = new TextDecoder()
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true })

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
      cmd: [executablePath('git'), 'ls-files', '-s', '--others', '--exclude-standard', '-z', '.'],
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw gitSpawnRefusal(cwd)
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
  const { text, undecodable } = decodeGitZ(proc.stdout)
  const parsed = parseLsFilesOutput(text, undecodable)
  const nested = expandNestedRepos(cwd, parsed.files, parsed.gitlinks)
  parsed.files = nested.files
  parsed.undecodable.push(...nested.undecodable)
  return parsed
}

/**
 * Replace each nested repository in a listing — a gitlink (a submodule) or
 * an untracked `dir/` (an embedded repository) — with the files its OWN git
 * lists, prefixed by its path. The outer repository holds one entry for the
 * whole tree and none of its files, and a directory is no input, so a task
 * reading `vendor/lib/x.txt` under `**` folded nothing of it: an edit there
 * was a green hit on the old output while `git status` named the path. The
 * files carry no index OID from here, so they hash by content. A nested
 * repository with no `.git` (a submodule never initialised) has no files to
 * read and stays out. A listing with none is returned as it came.
 */
function expandNestedRepos(
  cwd: string,
  files: string[],
  gitlinks: ReadonlySet<string>,
): { files: string[]; undecodable: string[] } {
  let out: string[] | undefined
  const undecodable: string[] = []
  for (let i = 0; i < files.length; i++) {
    const rel = files[i]!
    const nested = rel.endsWith('/') ? rel.slice(0, -1) : gitlinks.has(rel) ? rel : undefined
    if (nested === undefined) {
      out?.push(rel)
      continue
    }
    out ??= files.slice(0, i)
    const abs = path.join(cwd, nested)
    if (!existsSync(path.join(abs, '.git'))) continue
    const inner = runGitLsFiles(abs)
    for (const f of inner.files) out.push(`${nested}/${f}`)
    for (const f of inner.undecodable) undecodable.push(`${nested}/${f}`)
  }
  return { files: out ?? files, undecodable }
}

/**
 * A file's identity as the key folds it: its blob OID, prefixed by its git
 * mode unless that is a plain file's (100644). A blob OID holds no mode, so
 * a `chmod +x` or a symlink swapped for a file of its target's bytes kept
 * the key while `git status` and `--affected` saw the change, and the task
 * replayed the old output (item 887). The plain mode stays unprefixed, so
 * only executables and symlinks moved key. `hashFile` spells it the same
 * way from a stat.
 */
export function fileIdentity(mode: string, oid: string): string {
  return mode === '100644' ? oid : `${mode}:${oid}`
}

// Each `ls-files -s -v` record is `[<flag> ]<mode> <oid> <stage>\t<path>` —
// the staged-entry form, with an optional cache-state letter (`H`, `S`,
// `h`, …) in front. `--others` paths print bare; with `-z`, core.quotePath
// quoting is off, so a bare path containing a literal tab still cannot
// match the fixed-form prefix. Both answers come from ONE spawn.
function parseLsFilesOutput(out: string, undecodableRecords: ReadonlySet<string>): GitLsResult {
  const files: string[] = []
  const oids = new Map<string, string>()
  const flagged = new Set<string>()
  const gitlinks = new Set<string>()
  const undecodable: string[] = []
  if (out.length === 0) return { files, oids, flagged, gitlinks, undecodable }
  // NUL-separated; trailing NUL produces an empty segment we skip.
  for (const record of out.split('\0')) {
    if (record.length === 0) continue
    const m = LS_FILES_STAGE_RE.exec(record)
    const filePath = m === null ? record : record.slice(m[0].length) // --others: bare path
    files.push(filePath)
    if (undecodableRecords.size > 0 && undecodableRecords.has(record)) undecodable.push(filePath)
    if (m === null) continue
    const mode = m[2]!
    const stage = m[4]!
    if ((mode === '100644' || mode === '100755' || mode === '120000') && stage === '0') {
      oids.set(filePath, fileIdentity(mode, m[3]!))
    } else if (mode === '160000') {
      gitlinks.add(filePath)
    }
    // A LOWERCASE letter means skip-worktree or assume-unchanged (`S` is the
    // older spelling of skip-worktree): git has been told to stop looking at
    // the worktree file, so its index OID says nothing about the disk.
    const flag = m[1]
    if (flag !== undefined && (flag === 'S' || (flag >= 'a' && flag <= 'z'))) flagged.add(filePath)
  }
  return { files, oids, flagged, gitlinks, undecodable }
}

/**
 * `ls-files -s -v -z --debug` as the plain `-s -v -z` stream, plus the size
 * the index records for each regular stage-0 entry's worktree file and its
 * raw OID. With `-z`, each record's NUL is followed by its five
 * newline-ended debug lines (ctime, mtime, dev/ino, uid/gid, size/flags),
 * then the next record.
 */
function stripLsDebug(run: GitRun): {
  plain: string
  undecodable: Set<string>
  indexed: Map<string, { oid: string; size: number }>
} {
  const segs = run.stdout.split('\0')
  const records: string[] = []
  const undecodable = new Set<string>()
  const indexed = new Map<string, { oid: string; size: number }>()
  let record = segs[0]!
  let recordRaw = record
  for (let i = 1; i <= segs.length; i++) {
    const seg = segs[i]
    let rest = ''
    let size = -1
    if (seg !== undefined) {
      let at = 0
      for (let k = 0; k < 5 && at >= 0; k++) {
        const nl = seg.indexOf('\n', at)
        if (nl < 0) at = -1
        else {
          if (k === 4) size = Number(/size: (\d+)/.exec(seg.slice(at, nl))?.[1] ?? -1)
          at = nl + 1
        }
      }
      rest = at < 0 ? '' : seg.slice(at)
    }
    if (record.length > 0) {
      records.push(record)
      if (run.undecodable.has(recordRaw)) undecodable.add(record)
      const m = LS_FILES_STAGE_RE.exec(record)
      if (m !== null && m[4] === '0' && (m[2] === '100644' || m[2] === '100755')) {
        indexed.set(record.slice(m[0].length), { oid: m[3]!, size })
      }
    }
    record = rest
    recordRaw = seg ?? ''
  }
  return { plain: records.join('\0'), undecodable, indexed }
}

/** Blob sizes learned once and kept: a blob's size is fixed for its OID. `Cache` is one. */
export interface BlobSizeMemo {
  knownBlobSizes(oids: readonly string[]): Map<string, number>
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void
}

/**
 * Drop each trusted OID whose blob is not the size the index recorded for
 * the worktree file (A-60). A clean filter's blob differs from the file it
 * was added from, and git holds a stat-clean entry clean without re-reading
 * it once the filter is gone (`core.autocrlf` turned off, a `.gitattributes`
 * rule removed): `status` and the filter gate, which reads today's config,
 * both let the blob stand for bytes it does not hold. The recorded sizes
 * cost no read of the worktree; the blob sizes come from `memo`, and only
 * the ones it lacks from one `cat-file` (65 ms over 3,000 loose objects,
 * the whole of the cost, measured 2026-10-02). A smudged (racy) entry
 * records 0 and is hashed from disk. An answer that cannot be read trusts
 * nothing.
 */
async function dropResizedOids(enumeration: GitEnumeration, memo?: BlobSizeMemo): Promise<void> {
  const { trusted, indexed } = enumeration
  const wanted = new Set<string>()
  for (const rel of trusted.keys()) {
    const entry = indexed.get(rel)
    if (entry !== undefined) wanted.add(entry.oid)
  }
  if (wanted.size === 0) return
  const sizes = memo?.knownBlobSizes([...wanted]) ?? new Map<string, number>()
  const unknown = [...wanted].filter((oid) => !sizes.has(oid))
  if (unknown.length > 0) {
    const run = await enumeration.catFile(unknown.join('\n') + '\n')
    if (run === null || run.exitCode !== 0) {
      trusted.clear()
      return
    }
    const learned = new Map<string, number>()
    for (const line of run.stdout.split('\n')) {
      const sp = line.indexOf(' ')
      const n = Number(line.slice(sp + 1))
      if (sp > 0 && line.slice(sp + 1) !== '' && Number.isInteger(n))
        learned.set(line.slice(0, sp), n)
    }
    for (const [oid, n] of learned) sizes.set(oid, n)
    memo?.rememberBlobSizes(learned)
  }
  for (const rel of trusted.keys()) {
    const entry = indexed.get(rel)
    if (entry === undefined) continue // a symlink: its blob is its target string
    const size = sizes.get(entry.oid)
    // The index keeps the low 32 bits of a size.
    if (size === undefined || size % 2 ** 32 !== entry.size) trusted.delete(rel)
  }
}

/** One completed `git` invocation. */
interface GitRun {
  exitCode: number
  stdout: string
  stderr: string
  /** `stdout`'s records that were not UTF-8 (`decodeGitZ`). */
  undecodable: ReadonlySet<string>
}

/**
 * Parse `git check-attr -z text eol ident filter working-tree-encoding` output — a flat stream of
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
 *     `.gitattributes`, no `$GIT_DIR/info/attributes`, none of the files
 *     outside the tree git reads — `attributeFilesOutsideTree`), no rule
 *     can name a filter — return untouched, zero extra work. This is the
 *     default `git init` repo.
 *  3. Otherwise ask `git check-attr` (measured 21 ms; it resolves attributes
 *     from the index WITHOUT reading worktree content) and drop only the
 *     paths that actually carry `text`/`eol`/`ident`/`filter`/
 *     `working-tree-encoding`.
 *
 * Never throws: a probe that fails leaves the map as-is, which is exactly the
 * behaviour before this gate existed.
 */
async function dropFilteredOids(
  trusted: Map<string, string>,
  args: {
    /** Every path the enumeration listed: tracked (dirty ones too) and untracked. */
    listed: readonly string[]
    /** Whether `git status` named an ignored `.gitattributes`, which git applies too. */
    ignoredAttributes: boolean
    workspaceRoot: string
    gitDir: string
    gitPrefix: string
    pathspecs: readonly string[]
    gitVars: string
    spawnGit: (a: string[], stdin?: string) => Promise<GitRun | null>
  },
): Promise<void> {
  if (trusted.size === 0) return
  if (autocrlfConverts(args.gitVars)) {
    trusted.clear()
    return
  }
  // Cheap checks first, and nothing is materialized until one of them fires —
  // on a 15k-file repo with no attributes this whole function is a size check,
  // a line scan of `git var -l`, three stats, and a key walk that exits on the
  // first `.gitattributes` it does not find.
  let attributesPossible =
    args.ignoredAttributes ||
    attributeFilesOutsideTree(args.gitVars, process.env).some((f) =>
      existsSync(path.resolve(args.workspaceRoot, f)),
    ) ||
    (args.gitDir !== '' &&
      existsSync(path.resolve(args.workspaceRoot, args.gitDir, 'info', 'attributes')))
  // Every listed path, not only the trusted ones: git applies a
  // `.gitattributes` that is untracked or modified as well, and scanned in
  // the trusted set alone such a file was never seen, so a CRLF file's LF
  // index blob keyed it through an edit (item 977).
  if (!attributesPossible) {
    for (const rel of args.listed) {
      if (rel === '.gitattributes' || rel.endsWith('/.gitattributes')) {
        attributesPossible = true
        break
      }
    }
  }
  // The scan above can only see what the enumeration LISTED, and a scoped
  // run lists the project dirs alone (`gitPathspecs`). A `.gitattributes`
  // ABOVE them — the workspace root's own, which is where a monorepo puts
  // it — is therefore invisible, and the gate read "no attributes
  // anywhere" and kept every filtered OID. Measured on the real CLI: the
  // same workspace and the same CRLF→LF edit is a miss under `--all`
  // (pathspec `.`, so the root file is listed) and a STALE HIT under
  // `--filter app`. Git resolves attributes from every directory between
  // the repo root and the file, so walk those directories — bounded by
  // depth and project count, never by file count, which is what the
  // gate's cost rule cares about.
  if (!attributesPossible) attributesPossible = attributesAbove(args)
  if (!attributesPossible) return

  // `filter` and `working-tree-encoding` rewrite bytes too: a clean driver
  // (nbstripout, a `sed`) can map two worktree files to one blob, so the
  // blob's OID keyed an edit git calls clean, and the run replayed the old
  // output (item 978). Git LFS is a `filter` as well: its files are hashed
  // from disk now, the one honest identity of what a task reads.
  const res = await args.spawnGit(
    ['check-attr', '--stdin', '-z', 'text', 'eol', 'ident', 'filter', 'working-tree-encoding'],
    [...trusted.keys()].join('\0'),
  )
  if (res === null || res.exitCode !== 0) return
  for (const rel of parseCheckAttrOutput(res.stdout)) trusted.delete(rel)
}

/**
 * The repository root, derived from the workspace root and git's own
 * `--show-prefix` (the repo→workspace path). Exact and free: the prefix
 * came from the same spawn. Deriving it from the git DIRECTORY instead
 * is wrong in a linked worktree, where `--git-dir` names
 * `<main>/.git/worktrees/<name>` — not an ancestor of the worktree's
 * files at all, so a walk stopping there never stops and runs to `/`.
 */
export function repoRootOf(workspaceRoot: string, gitPrefix: string): string {
  const depth = gitPrefix.split('/').filter((p) => p !== '' && p !== '.').length
  return depth === 0 ? workspaceRoot : path.resolve(workspaceRoot, ...Array(depth).fill('..'))
}

/**
 * Is there a `.gitattributes` at or above the scanned dirs, up to the repo
 * root? Only the directories are stat'd — one per level per pathspec — so
 * this stays a handful of syscalls on any repo size.
 */
function attributesAbove(args: {
  workspaceRoot: string
  gitPrefix: string
  pathspecs: readonly string[]
}): boolean {
  const top = repoRootOf(args.workspaceRoot, args.gitPrefix)
  const seen = new Set<string>()
  for (const spec of args.pathspecs) {
    let dir = path.resolve(args.workspaceRoot, spec)
    for (;;) {
      if (!seen.has(dir)) {
        seen.add(dir)
        if (existsSync(path.join(dir, '.gitattributes'))) return true
      }
      const parent = path.dirname(dir)
      // Stop at the repo root, and never walk past the filesystem root on a
      // workspace whose git dir could not be read.
      if (dir === top || parent === dir) break
      dir = parent
    }
  }
  return false
}

/**
 * `git var -l` as `name → value`, the last line for a name winning, as the
 * last value of a config key does in git. Config keys come first and
 * lower-cased; git's own variables (`GIT_ATTR_GLOBAL`, …) follow.
 */
function gitVarList(listing: string): Map<string, string> {
  const vars = new Map<string, string>()
  for (const line of listing.split('\n')) {
    const eq = line.indexOf('=')
    if (eq > 0) vars.set(line.slice(0, eq), line.slice(eq + 1))
  }
  return vars
}

/**
 * `true` when git ignores the executable bit (`core.fileMode=false`, the
 * default on WSL's DrvFs and what `git init` writes on a filesystem without
 * one). Then `git status` reports no `chmod`, and a trusted file's index mode
 * says nothing about the worktree.
 */
function fileModeIgnored(gitVars: string): boolean {
  const v = gitVarList(gitVars).get('core.filemode')?.trim().toLowerCase()
  return v === 'false' || v === 'no' || v === 'off' || v === '0'
}

/**
 * Under `core.fileMode=false`, each trusted identity's mode from an lstat of
 * the worktree file, as `hashFile` takes it; the OID stays the index's. The
 * index mode alone kept the key through a `chmod +x`, and the task replayed
 * the output a 644 input built (item 1076). A path that does not stat goes
 * back to the probe.
 */
function restampModes(trusted: Map<string, string>, workspaceRoot: string): void {
  for (const [rel, id] of trusted) {
    const colon = id.indexOf(':')
    const oid = colon === -1 ? id : id.slice(colon + 1)
    let st
    try {
      st = lstatSync(path.join(workspaceRoot, rel))
    } catch {
      trusted.delete(rel)
      continue
    }
    const mode = st.isSymbolicLink() ? '120000' : (st.mode & 0o100) !== 0 ? '100755' : '100644'
    trusted.set(rel, fileIdentity(mode, oid))
  }
}

/**
 * `true` when the repository's config weakens the stat `git status` judges
 * a file clean by: `core.trustctime` off, or `core.checkStat=minimal`
 * (whole-second mtime and size only). Then a same-size rewrite that restores
 * its mtime — `cp -p`, `tar -x`, a formatter that keeps times — reads clean
 * and would keep its index OID, while the file hasher's own memo still keys
 * on ctime and inode (A-6). Read from the `git var -l` the run already
 * spawns; git's false spellings, the last value winning.
 */
export function gitStatWeakened(gitVars: string): boolean {
  const vars = gitVarList(gitVars)
  const trustctime = vars.get('core.trustctime')?.trim().toLowerCase()
  const checkStat = vars.get('core.checkstat')?.trim().toLowerCase()
  return (
    trustctime === 'false' ||
    trustctime === 'no' ||
    trustctime === 'off' ||
    trustctime === '0' ||
    checkStat === 'minimal'
  )
}

/** `true` when git may rewrite bytes for EVERY auto-detected text file. */
export function autocrlfConverts(gitVars: string): boolean {
  const v = gitVarList(gitVars).get('core.autocrlf')?.trim().toLowerCase()
  return v === 'true' || v === 'input'
}

/**
 * The attributes files outside the work tree git reads, from the same
 * `git var -l` the gate already spawns. Git 2.42 and later name both:
 * `GIT_ATTR_GLOBAL` is `core.attributesFile` or, unset, the default
 * `$XDG_CONFIG_HOME/git/attributes` (`~/.config/git/attributes` without
 * it), and `GIT_ATTR_SYSTEM` is the build's `$(sysconfdir)/gitattributes`,
 * absent under `GIT_ATTR_NOSYSTEM`. The gate read only the config key, so
 * `* text` in the default file left a CRLF file's LF blob trusted, a
 * stale hit (the upstream survey's row X).
 *
 * An older git names neither; its global lookup is the documented one,
 * mirrored here, and its system file sits where its build put it, which
 * only git knows: `/etc/gitattributes` for a `/usr` build, else
 * `<prefix>/etc/gitattributes` beside the binary's `bin/`. A path may be
 * relative (a relative `core.attributesFile`), to the workspace root.
 */
export function attributeFilesOutsideTree(
  gitVars: string,
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  const vars = gitVarList(gitVars)
  const global = vars.get('GIT_ATTR_GLOBAL')
  const system = vars.get('GIT_ATTR_SYSTEM')
  if (global !== undefined || system !== undefined || vars.has('GIT_CONFIG_GLOBAL')) {
    return [global, system].filter((f): f is string => f !== undefined && f !== '')
  }
  const out: string[] = []
  const configured = vars.get('core.attributesfile')
  const home = env.HOME ?? ''
  if (configured !== undefined && configured !== '') {
    out.push(configured.startsWith('~/') ? path.join(home, configured.slice(2)) : configured)
  } else if ((env.XDG_CONFIG_HOME ?? '') !== '') {
    out.push(path.join(env.XDG_CONFIG_HOME!, 'git', 'attributes'))
  } else if (home !== '') {
    out.push(path.join(home, '.config', 'git', 'attributes'))
  }
  const noSystem = (env.GIT_ATTR_NOSYSTEM ?? '').toLowerCase()
  if (!['1', 'true', 'yes', 'on'].includes(noSystem)) {
    out.push('/etc/gitattributes')
    try {
      const prefix = path.dirname(path.dirname(realpathSync(executablePath('git'))))
      out.push(path.join(prefix, 'etc', 'gitattributes'))
    } catch {
      // No git to resolve: the enumeration has already refused the run.
    }
  }
  return out
}

function parseStatusOutput(
  out: string,
  undecodableRecords: ReadonlySet<string>,
): {
  dirty: Set<string>
  untracked: string[]
  undecodable: Set<string>
  ignoredAttributes: boolean
} {
  const tokens = out.split('\0')
  const dirty = new Set<string>()
  const untracked: string[] = []
  const undecodable = new Set<string>()
  let ignoredAttributes = false
  for (const token of tokens) {
    if (token.length < 4) continue
    if (token[0] === '!') {
      if (token === '!! .gitattributes' || token.endsWith('/.gitattributes'))
        ignoredAttributes = true
      continue
    }
    if (undecodableRecords.size > 0 && undecodableRecords.has(token))
      undecodable.add(token.slice(3))
    if (token[0] === '?') {
      untracked.push(token.slice(3))
      continue
    }
    // No rename record follows: the spawn passes `--no-renames`, so a
    // rename's source is a record of its own (items 976, A-59).
    dirty.add(token.slice(3))
  }
  return { dirty, untracked, undecodable, ignoredAttributes }
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
  await applyGitEnumeration(enumeration, workspaceRoot, projectDirs, cache, workspaceWide)
}

/** What one workspace-wide enumeration learned, before it is partitioned per project. */
export interface GitEnumeration {
  /** Every enumerated path, workspace-relative, tracked and untracked. */
  all: string[]
  /** Workspace-relative path → index OID, for files whose worktree state matched the index. */
  trusted: Map<string, string>
  /** Whether the worktree had uncommitted changes; null when `git status` failed. */
  dirty: boolean | null
  /**
   * What `git status` listed, workspace-relative: modified, staged or deleted
   * paths (both sides of a rename) and untracked files. Null when it failed.
   */
  changed: readonly string[] | null
  /**
   * What `git status` listed as untracked, workspace-relative and before
   * nested repositories are expanded — `git ls-files --others
   * --exclude-standard`'s set. Null when it failed.
   */
  untracked: readonly string[] | null
  /** Workspace-relative paths whose names are not UTF-8 (`decodeGitZ`). */
  undecodable: readonly string[]
  /** `Date.now()` before the spawns: what `trusted` says is true as of no earlier. */
  startedAtMs: number
  /** Each regular stage-0 entry's raw OID and the worktree size the index recorded. */
  indexed: ReadonlyMap<string, { oid: string; size: number }>
  /** `git cat-file --batch-check` over `stdin`'s OIDs; null when it could not spawn. */
  catFile(stdin: string): Promise<{ exitCode: number; stdout: string } | null>
}

/** Above this many project dirs the enumeration walks the whole tree. */
export const MAX_SCOPED_PATHSPECS = 64

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
    rels.length <= MAX_SCOPED_PATHSPECS &&
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
  const spawnGit = async (
    args: string[],
    stdin?: string,
    env?: Record<string, string>,
  ): Promise<GitRun | null> => {
    try {
      const proc = Bun.spawn({
        // `status` refreshes the index when it can take `index.lock`, so
        // the user's own `git add` or `commit` failed on the lock while a
        // vx run held it (12 in 1,165 across 80 runs, item 880). Read-only, as
        // editors and prompts run it; a clean tree costs the same.
        cmd: [executablePath('git'), '--no-optional-locks', ...args],
        cwd: workspaceRoot,
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout: 'pipe',
        stderr: 'pipe',
        ...(env !== undefined ? { env: { ...process.env, ...env } } : {}),
      })
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).bytes(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      const { text, undecodable } = decodeGitZ(stdout)
      return { exitCode, stdout: text, stderr, undecodable }
    } catch {
      return null
    }
  }
  const startedAtMs = Date.now()
  // Four spawns at most (the rev-parse is memoized per process), one
  // worktree walk. `ls-files -s -v` reads the INDEX only
  // (~9 ms on a 1000-project tree) and answers two questions at once: every
  // tracked path's OID and its cache-state flag. `status -uall` is the one
  // command that walks the worktree, and it answers two as well: which
  // tracked paths are dirty AND which files are untracked. Asking
  // `ls-files --others` for the untracked set walked the same tree a second
  // time (~50 ms of CPU, concurrent with status but contending with it).
  // `--debug` adds each entry's recorded stat, for the blob-size check
  // (`dropResizedOids`, A-60).
  const listing = spawnGit(['ls-files', '-s', '-v', '-z', '--debug', '--', ...pathspecs]).then(
    (run) =>
      run === null || run.exitCode !== 0 ? { run, debug: null } : { run, debug: stripLsDebug(run) },
  )
  const running = Promise.all([
    listing,
    // `--ignored=matching` names an ignored path without descending into an
    // ignored directory: git applies an ignored `.gitattributes` as it does
    // any other, and the filter gate below must see it (A-19).
    // `--no-renames`: a deletion paired as an unmerged path's rename source
    // prints only as `UU <path>`, and the deleted file stayed trusted (A-59).
    spawnGit([
      'status',
      '--porcelain',
      '-z',
      '-uall',
      '--ignored=matching',
      '--no-renames',
      '--',
      ...pathspecs,
    ]),
    // The gate for whether a clean filter can rewrite bytes between the
    // index and the worktree: git's merged config (`core.autocrlf`) and,
    // from git 2.42, the attributes files it reads outside the tree
    // (`attributeFilesOutsideTree`). No tree scan. It replaced a
    // `config --get-regexp` of three keys at the same cost (1.29 against
    // 1.32 ms, min of 30), which could not name the default global file.
    // Not foldable into the rev-parse below: rev-parse prints no config.
    spawnGit(['var', '-l']),
  ])
  // Asked while the three above run, from the memo the file hasher reads
  // too (`repoFacts`). `prefix` is the repo→workspace path (empty when the
  // workspace root IS the git root): `ls-files` prints cwd(workspace)-
  // relative paths but `status` prints repo-root-relative ones, so when the
  // workspace root is a SUBDIR of the git repo the two disagree; this lets
  // us key both the same way below. `commonDir` locates `info/attributes`
  // for the filter gate: it is not always `.git/` (a linked worktree's
  // `.git` is a FILE pointing elsewhere), and it is the COMMON dir rather
  // than the per-worktree one because that is where git reads the file
  // from — probed, 2026-09-20: from inside a worktree `git check-attr text`
  // goes `unspecified` → `auto` when the rule is written to the common
  // dir's `info/attributes`, while the per-worktree gitdir has no such file
  // at all. `--git-dir` named the per-worktree directory, so the gate
  // looked where the rule can never be.
  const facts = repoFacts(workspaceRoot)
  const [{ run: ls, debug }, status, vars] = await running
  if (ls === null) {
    throw gitSpawnRefusal(workspaceRoot)
  }
  if (ls.exitCode !== 0) {
    const stderr = ls.stderr.trim()
    throw new UserError(
      `vx requires git: ${workspaceRoot} is not inside a git work tree. ` +
        `Run 'git init' in your workspace root.${stderr ? ` (git: ${stderr})` : ''}`,
    )
  }
  const {
    files: tracked,
    oids,
    flagged,
    gitlinks,
    undecodable,
  } = parseLsFilesOutput(debug!.plain, debug!.undecodable)
  // Normalize `status`'s repo-root-relative paths to workspace-relative (strip
  // the `--show-prefix`) so the dirty set is keyed identically to the trusted
  // OID map. Without this, when the workspace root is a git subdir, a modified
  // tracked file is never pruned from `trusted` and keeps its committed OID —
  // a STALE cache hit serving old outputs. Empty prefix (workspace == git root,
  // the common case) is a zero-cost no-op. Paths above the workspace can't be
  // inputs, so they drop out of the set.
  const gitPrefix = facts?.prefix ?? ''
  const gitDir = facts?.commonDir ?? ''
  const parsedStatus =
    status !== null && status.exitCode === 0
      ? parseStatusOutput(status.stdout, status.undecodable)
      : null
  const dirty = parsedStatus === null ? null : stripPrefixFromSet(parsedStatus.dirty, gitPrefix)
  // Untracked files are inputs too (a new file is the commonest edit there
  // is). They come from the status walk, repo-root-relative like the dirty
  // set. Without a status answer the enumeration is the index alone.
  const untracked =
    parsedStatus === null ? [] : [...stripPrefixFromSet(new Set(parsedStatus.untracked), gitPrefix)]
  const listed = untracked.length === 0 ? tracked : tracked.concat(untracked)
  const nested = expandNestedRepos(workspaceRoot, listed, gitlinks)
  const all = nested.files
  undecodable.push(...nested.undecodable)
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
  // Under a weakened stat, `git status` vouches for nothing a same-size,
  // time-keeping rewrite made: every file is hashed from disk instead.
  if (vars !== null && vars.exitCode === 0 && gitStatWeakened(vars.stdout)) trusted.clear()
  // An index OID is only the file's content hash when git stores the worktree
  // bytes VERBATIM. Under a clean filter (`text`/`eol`/`ident`/`filter`/`working-tree-encoding`) the blob is a
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
    listed: all,
    ignoredAttributes: parsedStatus?.ignoredAttributes ?? false,
    workspaceRoot,
    gitDir,
    gitPrefix,
    pathspecs,
    gitVars: vars !== null && vars.exitCode === 0 ? vars.stdout : '',
    spawnGit,
  })
  if (vars !== null && vars.exitCode === 0 && fileModeIgnored(vars.stdout)) {
    restampModes(trusted, workspaceRoot)
  }
  if (parsedStatus !== null && parsedStatus.undecodable.size > 0) {
    undecodable.push(...stripPrefixFromSet(parsedStatus.undecodable, gitPrefix))
  }
  return {
    all,
    trusted,
    dirty: worktreeDirty,
    changed: dirty === null ? null : [...dirty, ...untracked],
    untracked: dirty === null ? null : untracked,
    undecodable,
    startedAtMs,
    indexed: debug!.indexed,
    // A missing blob is an answer ("missing"), never a fetch from a partial
    // clone's promisor remote.
    catFile: (stdin) =>
      spawnGit(['cat-file', '--batch-check=%(objectname) %(objectsize)'], stdin, {
        GIT_NO_LAZY_FETCH: '1',
      }),
  }
}

/** A run's whole-tree enumeration, started on its first ask and shared after. */
export interface LazyGitEnumeration {
  start(): Promise<GitEnumeration>
  /** The enumeration, once something started it. */
  readonly started: Promise<GitEnumeration> | undefined
}

export function lazyGitEnumeration(workspaceRoot: string): LazyGitEnumeration {
  let started: Promise<GitEnumeration> | undefined
  return {
    start() {
      if (started === undefined) {
        started = startGitEnumeration(workspaceRoot, ['.'])
        // Its first reader may never await it (a config throws first); the
        // one that does still sees the error.
        started.catch(() => {})
      }
      return started
    },
    get started() {
      return started
    },
  }
}

/** The partition half of `populateGitFilesCache`: store per-project slices of one enumeration. */
export async function applyGitEnumeration(
  enumeration: GitEnumeration,
  workspaceRoot: string,
  projectDirs: readonly string[],
  cache: GitFilesCache,
  workspaceWide = false,
  memo?: BlobSizeMemo,
): Promise<void> {
  await dropResizedOids(enumeration, memo)
  const { all, trusted } = enumeration
  cache.setWorktreeDirty(enumeration.dirty)
  cache.enumeratedAtMs = enumeration.startedAtMs
  cache.markUndecodable(enumeration.undecodable.map((rel) => path.join(workspaceRoot, rel)))
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
    // An empty slice is a directory git did not see, not an empty project:
    // a project has at least its package.json, tracked or untracked. A
    // nested repository — a submodule, an embedded repository, which the
    // workspace's git holds as ONE entry (a gitlink, `dir/` when untracked)
    // — is listed through its own git above (`expandNestedRepos`), but under
    // a pathspec naming a project inside it the workspace's git lists
    // nothing at all; so is a directory ignored outright. Storing the empty slice made the key never move: `cache.inputs
    // matched no files`, then a stale hit under a green run once the source
    // changed (2026-09-16). No partition instead: `resolveFiles` spawns
    // `git ls-files` in the project's own directory, which a nested
    // repository answers, and the files hash by content (no index OID
    // trusted from here) — one spawn per such project per run, nothing for
    // a workspace without one.
    if (matches.length === 0) continue
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
