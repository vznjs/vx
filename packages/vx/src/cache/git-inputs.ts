// Git-backed input enumeration: one `git ls-files -s` + one `git status
// --porcelain -z` per run (plus `check-attr` where a filter could convert
// bytes), parsed into the per-project `GitFilesCache` that `inputs.ts`'s
// glob resolution trusts for blob OIDs. Split from `inputs.ts` on
// 2026-09-10: this file talks to git; `inputs.ts` decides which files a
// task declared. Nothing here reads a config or applies a boundary.

import os from 'node:os'
import path from 'node:path'
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  utimesSync,
  writeFileSync,
  type Stats,
} from 'node:fs'
import {
  checkIgnoreSync,
  executablePath,
  gitEnv,
  gitFailure,
  gitSpawnRefusal,
  isInstalledPath,
  notAWorkTree,
  relPosix,
  UserError,
  xxh3hex,
} from '../util/index.js'
import { FILE_HASH_RACY_MS, racyWindowMs } from './layer.js'

/** A name no ignore rule names, standing for a file a task may create. */
const FRESH_NAME = '__vx_probe__'

/** Three facts of the repository a directory is in: read off the disk, or one `git rev-parse`. */
export interface RepoFacts {
  /** `--show-prefix`: the directory's path below the worktree root, `''` at the root. */
  prefix: string
  /** `--git-common-dir` as git prints it, relative to the directory asked. */
  commonDir: string
  /** `--show-object-format`: the hash the index's blob OIDs are in. */
  objectFormat: 'sha1' | 'sha256'
  /** `--git-path index` (it honours `GIT_INDEX_FILE`), relative to the directory asked. */
  indexFile: string
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
  const read = repoFactsFromDisk(dir)
  if (read !== undefined) {
    repoFactsMemo.set(dir, read)
    return read
  }
  let proc
  try {
    proc = Bun.spawnSync({
      cmd: [
        executablePath('git'),
        'rev-parse',
        '--show-prefix',
        '--git-common-dir',
        '--show-object-format',
        '--git-path',
        'index',
      ],
      env: gitEnv(),
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
  const [prefix = '', commonDir = '', format = '', indexFile = ''] = new TextDecoder('utf-8', {
    ignoreBOM: true,
  })
    .decode(proc.stdout)
    .split('\n')
    .map((l) => l.trim())
  const facts: RepoFacts = {
    prefix,
    commonDir,
    objectFormat: format === 'sha256' ? 'sha256' : 'sha1',
    indexFile,
  }
  repoFactsMemo.set(dir, facts)
  return facts
}

/**
 * The refusal a run would meet at its enumeration, asked up front by a
 * verb that waits on the user first (the picker); undefined when git
 * tracks `dir`. Free when it does: `repoFacts` is the answer the run
 * reuses.
 */
export function gitRefusal(dir: string): UserError | undefined {
  if (repoFacts(dir) !== null) return undefined
  let proc
  try {
    proc = Bun.spawnSync({
      cmd: [executablePath('git'), 'rev-parse', '--is-inside-work-tree'],
      env: gitEnv(),
      cwd: dir,
      stdout: 'ignore',
      stderr: 'pipe',
    })
  } catch {
    return gitSpawnRefusal(dir)
  }
  if (proc.exitCode === 0) return undefined
  return notAWorkTree(dir, new TextDecoder().decode(proc.stderr).trim())
}

/** Variables that move where git finds the repository or its index: with any set, git is asked. */
const GIT_LOCATION_ENV = [
  'GIT_INDEX_FILE',
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_COMMON_DIR',
  'GIT_CEILING_DIRECTORIES',
  'GIT_DISCOVERY_ACROSS_FILESYSTEM',
]

/**
 * `repoFacts` for the plain case, read off the disk: the nearest `.git`
 * DIRECTORY above `dir` (resolved as git resolves its cwd), on the same
 * file system, holding a `HEAD`, and its config's object format. The
 * spawn it saves was ~3 ms of every run, synchronous. Undefined — ask
 * git — for anything else: a `.git` file (a linked worktree, a
 * submodule), a location variable, an include in the config, a format it
 * cannot read, no repository at all.
 */
function repoFactsFromDisk(dir: string): RepoFacts | undefined {
  if (GIT_LOCATION_ENV.some((name) => process.env[name] !== undefined)) return undefined
  try {
    const real = realpathSync(dir)
    const dev = lstatSync(real).dev
    for (let at = real; ;) {
      const dotGit = path.join(at, '.git')
      const st = lstatSync(dotGit, { throwIfNoEntry: false })
      if (st !== undefined) {
        if (!st.isDirectory() || !existsSync(path.join(dotGit, 'HEAD'))) return undefined
        const objectFormat = configObjectFormat(readFileSync(path.join(dotGit, 'config'), 'utf8'))
        if (objectFormat === undefined) return undefined
        const below = relPosix(at, real)
        return {
          prefix: below === '' ? '' : `${below}/`,
          commonDir: relPosix(real, dotGit),
          objectFormat,
          indexFile: path.relative(real, path.join(dotGit, 'index')).split(path.sep).join('/'),
        }
      }
      const parent = path.dirname(at)
      if (parent === at || lstatSync(parent).dev !== dev) return undefined
      at = parent
    }
  } catch {
    return undefined
  }
}

/**
 * `[extensions] objectFormat` of a repository config, sha1 when unset;
 * undefined when unsure, or when `core.worktree` puts the work tree
 * somewhere other than the `.git` directory's parent, which the prefix
 * read off the disk assumes.
 */
function configObjectFormat(config: string): 'sha1' | 'sha256' | undefined {
  let section = ''
  let format: 'sha1' | 'sha256' = 'sha1'
  for (const raw of config.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue
    const head = /^\[\s*([A-Za-z0-9.-]+)/.exec(line)
    if (head !== null) {
      section = head[1]!.toLowerCase()
      if (section === 'include' || section === 'includeif') return undefined
      continue
    }
    if (section === 'core' && /^worktree\b/i.test(line)) return undefined
    if (section !== 'extensions') continue
    // `config.worktree` may set `core.worktree` too.
    if (/^worktreeconfig\b/i.test(line)) return undefined
    const kv = /^([A-Za-z0-9-]+)\s*=\s*(.*)$/.exec(line)
    if (kv === null || kv[1]!.toLowerCase() !== 'objectformat') continue
    const value = kv[2]!.toLowerCase()
    if (value === 'sha256' || value === 'sha1') format = value
    else return undefined
  }
  return format
}

interface PartitionDigest {
  snapshot: readonly string[]
  oids: OidSlot | undefined
  /** Built on first read: a partition with untrusted files stats them then. */
  digest: () => string | undefined
}

/**
 * A partition's trusted OIDs, built on first read: a warm run whose keys
 * come back from the fold memo reads none, and building 125,000 abs-path
 * entries up front was ~90 ms of a 5,000-project warm run.
 */
class OidSlot {
  private built: Map<string, string> | undefined
  /** Paths dropped before the map was built: taken out when it is. */
  private dropped: string[] | undefined
  constructor(private build: () => Map<string, string>) {}
  get map(): Map<string, string> {
    if (this.built === undefined) {
      this.built = this.build()
      for (const p of this.dropped ?? []) this.built.delete(p)
      this.dropped = undefined
    }
    return this.built
  }
  /**
   * Forget these paths' OIDs. An unbuilt map stays unbuilt: each restore
   * marks its outputs changed, and building the map to drop them was ~28 ms
   * of a 1,000-project restore whose keys no later read needed.
   */
  drop(paths: Iterable<string>): void {
    if (this.built !== undefined) for (const p of paths) this.built.delete(p)
    else (this.dropped ??= []).push(...paths)
  }
}

interface IgnoredListing {
  root: string
  paths: readonly string[]
  asked: Map<string, boolean>
}

export class GitFilesCache extends Map<string, readonly string[]> {
  /**
   * vx's own directories inside the workspace (the run's cache directory),
   * spelled under the workspace root as the run spells it: no input, even
   * where a glob walks an ignored prefix on disk.
   */
  vxDirs: readonly string[] = []
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
  private oids = new Map<string, OidSlot>()
  /** Per partition, `filesDigest`'s answer and the snapshot and OIDs it describes. */
  private digests = new Map<string, PartitionDigest>()
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
   * What git tracks, by absolute path, within `trackedScopes`: a file there
   * no clean deletes (`committedIn`). Filled by the
   * enumeration, and per directory on demand for one it did not cover.
   * Built on the first question: a run that cleans nothing asks none, and
   * 125,000 paths joined and hashed were ~90 ms of a warm 5,000-project run.
   */
  private tracked = new Set<string>()
  private trackedPending: (() => Iterable<string>)[] = []
  private trackedScopes: string[] = []
  /**
   * Under `core.ignorecase` (macOS's default volume) git's `Foo.txt` is the
   * disk's `foo.txt` after a rename git never saw, so paths are compared
   * case-folded. Decided at the first note: the run's `git var -l`, else
   * the platform.
   */
  private foldCase: boolean | undefined

  private trackedKey(abs: string): string {
    this.foldCase ??=
      this.vars === null
        ? process.platform === 'darwin'
        : gitBool(this.vars.get('core.ignorecase')) === true
    return this.foldCase ? abs.toLowerCase() : abs
  }

  noteTracked(scopes: readonly string[], absPaths: readonly string[]): void {
    this.noteTrackedLater(scopes, () => absPaths)
  }

  /** `noteTracked`, the paths asked for only when a clean asks about one. */
  noteTrackedLater(scopes: readonly string[], absPaths: () => Iterable<string>): void {
    this.trackedPending.push(absPaths)
    this.trackedScopes.push(...scopes)
  }

  private isTracked(abs: string): boolean {
    if (this.trackedPending.length > 0) {
      for (const paths of this.trackedPending.splice(0))
        for (const p of paths()) this.tracked.add(this.trackedKey(p))
    }
    return this.tracked.has(this.trackedKey(abs))
  }

  /**
   * Whether git tracks a file under `dir`: committed (or `git add`ed)
   * files are the user's, never cleaned (2026-10-14: "never
   * delete committed file"). A directory no enumeration covered (a
   * nested repository, a cache no enumeration filled) is listed once.
   * git lists a submodule as its gitlink path alone, so a file under a
   * tracked path is committed too.
   */
  committedIn(dir: string): (abs: string) => boolean {
    let listed = false
    return (abs) => {
      if (!listed) {
        listed = true
        const covered = this.trackedScopes.some((s) => dir === s || dir.startsWith(s + path.sep))
        if (!covered) this.noteTracked([dir], listTracked(dir))
      }
      for (let p = abs; p.length > dir.length; p = path.dirname(p))
        if (this.isTracked(p)) return true
      return false
    }
  }

  /**
   * When the enumeration that vouched for `oids` started (ms since the
   * epoch): an index OID says what a file held when `git status` looked,
   * so a file changed since may hold something else (item 743). Unset on
   * a cache no enumeration filled; its OIDs are then re-checked by content.
   */
  enumeratedAtMs: number | undefined
  /**
   * The declared outputs (root-relative globs) git ignores whole, asked
   * once per run beside the enumeration: no key reads them, so a reader
   * beside their producer keys up front (`dependsOnSiblingOutputs`).
   */
  ignoredOutputs: ReadonlySet<string> = new Set()

  /** What `git status --ignored=matching` named, root-relative and sorted, and the root. */
  private ignored: IgnoredListing | null = null

  setIgnored(root: string, paths: readonly string[]): void {
    this.ignored = { root, paths, asked: new Map() }
  }

  /**
   * Whether git ignores a new file directly in `dir` (absolute) while it
   * reports an ignored path under it: `gen/*` beside a kept `gen/.gitkeep`,
   * or `gen/` with a force-added file. Such a directory is ignored in all
   * but the files git lists, so naming it is asking for its ignored files
   * too. A pattern that ignores only some names (`*.generated.js` in a
   * listed `src`) answers false. Asked once per directory per enumeration,
   * and only where status named an ignored path under it.
   */
  newFilesIgnored(dir: string): boolean {
    const ig = this.ignored
    if (ig === null || ig.paths.length === 0) return false
    const rel = relPosix(ig.root, dir)
    if (rel === '' || rel.startsWith('../')) return false
    let known = ig.asked.get(rel)
    if (known !== undefined) return known
    const under = `${rel}/`
    let lo = 0
    let hi = ig.paths.length
    while (lo < hi) {
      const mid = (lo + hi) >>> 1
      if (ig.paths[mid]! < under) lo = mid + 1
      else hi = mid
    }
    known = false
    if (ig.paths[lo]?.startsWith(under) === true) {
      const probe = `${under}${FRESH_NAME}`
      known = checkIgnoreSync(ig.root, [probe])?.has(probe) === true
    }
    ig.asked.set(rel, known)
    return known
  }

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

  /** The populate's `git var -l`, for `configValue`. */
  private vars: Map<string, string> | null = null

  setGitVars(listing: string | null): void {
    this.vars = listing === null ? null : gitVarList(listing)
  }

  /**
   * A config key's value as `git config --get` answers it (the last one),
   * from the populate's `git var -l`: null when the config has none,
   * undefined when no listing was read.
   */
  configValue(key: string): string | null | undefined {
    return this.vars === null ? undefined : (this.vars.get(key) ?? null)
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
          under.push(relPosix(key, abs))
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
    this.oids.get(partitionDir)?.drop(relPaths.map((rel) => path.resolve(partitionDir, rel)))
  }

  /**
   * A digest of `snapshot`'s paths and index OIDs, when the enumeration
   * trusted an OID for every one, none is a symlink and every name decodes:
   * then the files a task resolves there, and what it folds for them, are
   * a function of this digest and its declaration (`filesToken`). Undefined
   * once anything moved the partition: a re-enumeration, a changed path.
   */
  filesDigest(projectDir: string, snapshot: readonly string[]): string | undefined {
    const d = this.digests.get(projectDir)
    if (d === undefined || d.snapshot !== snapshot || this.get(projectDir) !== snapshot) return
    if (this.oids.get(projectDir) !== d.oids || this.changed.has(projectDir)) return
    return d.digest()
  }

  noteFilesDigest(
    projectDir: string,
    snapshot: readonly string[],
    digest: () => string | undefined,
  ): void {
    let memo: { value: string | undefined } | undefined
    this.digests.set(projectDir, {
      snapshot,
      oids: this.oids.get(projectDir),
      digest: () => (memo ??= { value: digest() }).value,
    })
  }

  /** Trusted index OIDs for a project (abs path → oid), if any survive. */
  oidsFor(projectDir: string): ReadonlyMap<string, string> | undefined {
    return this.oids.get(projectDir)?.map
  }

  setOids(projectDir: string, oids: Map<string, string>): void {
    this.oids.set(projectDir, new OidSlot(() => oids))
  }

  /** What builds the project's OIDs when a read first asks. */
  setLazyOids(projectDir: string, build: () => Map<string, string>): void {
    this.oids.set(projectDir, new OidSlot(build))
  }

  /** Snapshot if still valid for these input globs; undefined → re-spawn. */
  snapshotFor(projectDir: string, inputGlobs: readonly Bun.Glob[]): readonly string[] | undefined {
    const snap = this.get(projectDir)
    if (snap === undefined) return undefined
    const pending = this.changed.get(projectDir)
    if (pending !== undefined && this.pendingMatch(pending, inputGlobs)) return undefined
    return snap
  }

  /**
   * How far each glob has read a `changed` list, -1 once it matched: the
   * list only grows until a reset replaces it, so each glob reads each path
   * once. Every task asked again from the start: 9000 tasks writing into
   * one project cost 10 s of reads (2026-10-25).
   */
  private readonly read = new WeakMap<readonly string[], Map<Bun.Glob, number>>()

  private pendingMatch(pending: readonly string[], globs: readonly Bun.Glob[]): boolean {
    let upTo = this.read.get(pending)
    if (upTo === undefined) this.read.set(pending, (upTo = new Map()))
    for (const g of globs) {
      let i = upTo.get(g) ?? 0
      if (i < 0) return true
      for (; i < pending.length; i++)
        if (g.match(pending[i]!)) {
          upTo.set(g, -1)
          return true
        }
      upTo.set(g, i)
    }
    return false
  }

  override set(key: string, value: readonly string[]): this {
    this.changed.delete(key)
    this.oids.delete(key)
    this.digests.delete(key)
    return super.set(key, value)
  }

  override delete(key: string): boolean {
    this.changed.delete(key)
    this.oids.delete(key)
    this.digests.delete(key)
    return super.delete(key)
  }

  override clear(): void {
    this.changed.clear()
    this.oids.clear()
    this.digests.clear()
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

// A default decoder strips a leading U+FEFF: the first path git lists
// would lose it and name no file.
const LOSSY_UTF8 = new TextDecoder('utf-8', { ignoreBOM: true })
const FATAL_UTF8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true })

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
export function runGitLsFiles(cwd: string, env = gitEnv()): GitLsResult {
  let proc
  try {
    proc = Bun.spawnSync({
      cmd: [executablePath('git'), 'ls-files', '-s', '--others', '--exclude-standard', '-z', '.'],
      env,
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw gitSpawnRefusal(cwd)
  }
  if (proc.exitCode !== 0) {
    // Not a work tree, or git failing in one: either way the inputs
    // cannot be enumerated, and the two have different fixes.
    throw gitFailure(cwd, 'ls-files', proc.exitCode, new TextDecoder().decode(proc.stderr).trim())
  }
  const { text, undecodable } = decodeGitZ(proc.stdout)
  const parsed = parseLsFilesOutput(text.length === 0 ? [] : text.split('\0'), undecodable)
  const nested = expandNestedRepos(cwd, parsed.files, parsed.gitlinks)
  parsed.files = nested.files
  parsed.undecodable.push(...nested.undecodable)
  return parsed
}

/**
 * The files git tracks under `dir`, absolute: one `ls-files` of the index,
 * no worktree walk. Outside a work tree (an embedder's temp dir) nothing
 * is tracked. A git that fails otherwise refuses: read as "nothing
 * tracked", every committed file under `dir` was the output clean's to
 * delete (2026-10-28).
 */
function listTracked(dir: string): string[] {
  let proc
  try {
    proc = Bun.spawnSync({
      cmd: [executablePath('git'), 'ls-files', '-z', '--', '.'],
      env: gitEnv(),
      cwd: dir,
      stdout: 'pipe',
      stderr: 'pipe',
    })
  } catch {
    throw gitSpawnRefusal(dir)
  }
  if (proc.exitCode !== 0) {
    const stderr = new TextDecoder().decode(proc.stderr).trim()
    if (/not a git repository/i.test(stderr)) return []
    throw new UserError(
      `git ls-files failed (exit ${proc.exitCode}) in ${dir}: ${stderr || 'no output'}. Run it there to see why.`,
      'VX_E_GIT',
    )
  }
  const { text } = decodeGitZ(proc.stdout)
  return text
    .split('\0')
    .filter((rel) => rel.length > 0)
    .map((rel) => path.join(dir, rel))
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
    if (!existsSync(path.join(abs, '.git'))) {
      // No repository answers for it: a submodule never initialised (empty)
      // or one whose `.git` was removed to vendor its files, the gitlink
      // left in the index and `git status` silent. Its files are what the
      // task reads, so a walk lists them; they hash by content (A-61).
      for (const f of walkFiles(abs)) out.push(`${nested}/${f}`)
      continue
    }
    let inner
    try {
      inner = runGitLsFiles(abs, nestedRepoEnv())
    } catch {
      // A `.git` git cannot open (a submodule's file naming a lost
      // `.git/modules` entry) answers as no `.git` does: by a walk. It
      // refused the whole run as "not inside a git work tree".
      for (const f of walkFiles(abs)) out.push(`${nested}/${f}`)
      continue
    }
    for (const f of inner.files) out.push(`${nested}/${f}`)
    for (const f of inner.undecodable) undecodable.push(`${nested}/${f}`)
  }
  return { files: out ?? files, undecodable }
}

/**
 * Variables that name the repository git works on (git's `local_repo_env`),
 * which a nested repository's git must not inherit. A pre-commit hook runs
 * vx with `GIT_INDEX_FILE` or `GIT_DIR` naming the OUTER repository, and
 * the nested listing read the outer index: a file the nested repository
 * tracks under an ignore rule fell out of the inputs, a stale hit. git
 * clears the same list for a submodule's commands; config variables stay.
 */
const LOCAL_REPO_ENV = new Set([
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_COMMON_DIR',
  'GIT_DIR',
  'GIT_GRAFT_FILE',
  'GIT_IMPLICIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_INTERNAL_SUPER_PREFIX',
  'GIT_NO_REPLACE_OBJECTS',
  'GIT_OBJECT_DIRECTORY',
  'GIT_PREFIX',
  'GIT_REPLACE_REF_BASE',
  'GIT_SHALLOW_FILE',
  'GIT_WORK_TREE',
])

function nestedRepoEnv(): Record<string, string> {
  const env = gitEnv()
  for (const name of LOCAL_REPO_ENV) delete env[name]
  return env
}

/**
 * The environment a listing of `dir` runs in: `nestedRepoEnv` when a
 * location variable is set and `dir` sits in a repository nested below
 * `workspaceRoot` (a `.git` at it or between), whose git must not read the
 * workspace repository's index; git's own environment otherwise.
 */
export function listingEnv(dir: string, workspaceRoot: string): Record<string, string> {
  if (![...LOCAL_REPO_ENV].some((name) => process.env[name] !== undefined)) return gitEnv()
  for (let at = dir; at !== workspaceRoot && at.startsWith(workspaceRoot); at = path.dirname(at)) {
    if (existsSync(path.join(at, '.git'))) return nestedRepoEnv()
    if (path.dirname(at) === at) break
  }
  return gitEnv()
}

/** Every file and symlink under `dir`, relative and `/`-separated; a `.git` is skipped, a link not followed. */
function walkFiles(dir: string, rel = ''): string[] {
  let entries
  try {
    entries = readdirSync(path.join(dir, rel), { withFileTypes: true })
  } catch {
    return []
  }
  const out: string[] = []
  for (const e of entries) {
    // Nothing tracks a vendored tree's files; an install there is not one.
    if (e.name === '.git' || e.name === 'node_modules') continue
    const r = rel === '' ? e.name : `${rel}/${e.name}`
    if (e.isDirectory()) out.push(...walkFiles(dir, r))
    else out.push(r)
  }
  return out
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
//
// `debug`, for a `--debug` listing: each record's recorded size (aligned
// with `records`) in, and each regular stage-0 entry's raw OID and size out.
function parseLsFilesOutput(
  records: readonly string[],
  undecodableRecords: ReadonlySet<string>,
  debug?: { sizes: readonly number[]; indexed: Map<string, { oid: string; size: number }> },
): GitLsResult {
  const files: string[] = []
  const oids = new Map<string, string>()
  const flagged = new Set<string>()
  const gitlinks = new Set<string>()
  const undecodable: string[] = []
  // NUL-separated; trailing NUL produces an empty segment we skip.
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record.length === 0) continue
    const m = LS_FILES_STAGE_RE.exec(record)
    const filePath = m === null ? record : record.slice(m[0].length) // --others: bare path
    if (m === null && isInstalledPath(filePath)) continue
    files.push(filePath)
    if (undecodableRecords.size > 0 && undecodableRecords.has(record)) undecodable.push(filePath)
    if (m === null) continue
    const mode = m[2]!
    const stage = m[4]!
    if ((mode === '100644' || mode === '100755' || mode === '120000') && stage === '0') {
      oids.set(filePath, fileIdentity(mode, m[3]!))
      if (debug !== undefined && mode !== '120000') {
        debug.indexed.set(filePath, { oid: m[3]!, size: debug.sizes[i]! })
      }
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
 * `ls-files -s -v -z --debug` as the plain `-s -v -z` records, plus the size
 * the index records for each, aligned. With `-z`, each record's NUL is
 * followed by its five newline-ended debug lines (ctime, mtime, dev/ino,
 * uid/gid, size/flags), then the next record. The records go to
 * `parseLsFilesOutput` as they are: joining them for it to split again,
 * a regex per size line and a second regex per record were ~14 ms of a
 * 12,905-file listing.
 */
function splitLsDebug(run: GitRun): {
  records: string[]
  sizes: number[]
  undecodable: Set<string>
} {
  const segs = run.stdout.split('\0')
  const records: string[] = []
  const sizes: number[] = []
  const undecodable = new Set<string>()
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
          if (k === 4) {
            const field = seg.indexOf('size: ', at)
            if (field >= 0 && field < nl) {
              const n = parseInt(seg.slice(field + 6, nl), 10)
              if (!Number.isNaN(n)) size = n
            }
          }
          at = nl + 1
        }
      }
      rest = at < 0 ? '' : seg.slice(at)
    }
    if (record.length > 0) {
      records.push(record)
      sizes.push(size)
      if (run.undecodable.has(recordRaw)) undecodable.add(record)
    }
    record = rest
    recordRaw = seg ?? ''
  }
  return { records, sizes, undecodable }
}

/**
 * What the blob-size check keeps between runs (`Cache` is one): each blob's
 * size, fixed for its OID, and each verdict, the paths an index distrusts,
 * fixed for the index file's bytes (`IndexBlobCheck.key`).
 */
export interface BlobSizeMemo {
  knownBlobSizes(oids: readonly string[]): Map<string, number>
  rememberBlobSizes(sizes: ReadonlyMap<string, number>): void
  blobVerdict(key: string): string[] | undefined
  rememberBlobVerdict(key: string, paths: readonly string[]): void
}

/** Each regular stage-0 index entry's path, raw OID and recorded worktree size, in index order. */
export interface IndexBlobs {
  paths: string[]
  oids: string[]
  sizes: number[]
}

/** What the blob-size check reads, lazily: the verdict's key, and the listing a miss needs. */
export interface IndexBlobCheck {
  /** xxh3 of the index file and the pathspecs; undefined when the file could not be read. */
  key: string | undefined
  /** The entries `ls-files --debug` lists, or null when it fails. */
  blobs(): Promise<IndexBlobs | null>
  /** The key as the index stands now: a verdict is stored only for the index it came from. */
  rekey(): Promise<string | undefined>
}

/**
 * Drop each trusted OID whose blob is not the size the index recorded for
 * the worktree file (A-60). A clean filter's blob differs from the file it
 * was added from, and git holds a stat-clean entry clean without re-reading
 * it once the filter is gone (`core.autocrlf` turned off, a `.gitattributes`
 * rule removed): `status` and the filter gate, which reads today's config,
 * both let the blob stand for bytes it does not hold. Which paths an index
 * distrusts is a function of the index alone, so `memo` keeps the verdict
 * by a hash of the index file and a warm run reads one row: the `--debug`
 * listing and a lookup per entry cost 550 ms at 100,000 files (2026-10-02).
 * An index with no verdict spawns that listing (the recorded sizes), asks
 * the per-OID sizes, and `cat-file` for the ones `memo` lacks; the verdict
 * is stored only if the index is still the one it was read from. A smudged
 * (racy) entry records 0 and is hashed from disk. An answer that cannot be
 * read trusts nothing. A filter that keeps the size (`tr a-z A-Z`) is not
 * caught: only a read of every trusted file would be (caching.md, step 12).
 */
async function dropResizedOids(enumeration: GitEnumeration, memo?: BlobSizeMemo): Promise<void> {
  const { trusted, blobCheck } = enumeration
  if (trusted.size === 0) return
  const key = blobCheck.key
  let resized = key === undefined ? undefined : memo?.blobVerdict(key)
  if (resized === undefined) {
    const blobs = await blobCheck.blobs()
    if (blobs === null) {
      trusted.clear()
      return
    }
    const unique = [...new Set(blobs.oids)]
    const sizes = memo?.knownBlobSizes(unique) ?? new Map<string, number>()
    const unknown = unique.filter((oid) => !sizes.has(oid))
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
    resized = []
    for (let i = 0; i < blobs.oids.length; i++) {
      const size = sizes.get(blobs.oids[i]!)
      // The index keeps the low 32 bits of a size.
      if (size === undefined || size % 2 ** 32 !== blobs.sizes[i]) resized.push(blobs.paths[i]!)
    }
    if (key !== undefined && (await blobCheck.rekey()) === key) {
      memo?.rememberBlobVerdict(key, resized)
    }
  }
  for (const rel of resized) trusted.delete(rel)
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
    /**
     * The same `check-attr`, already started over every listed index entry
     * (a superset of `trusted`) because `attributesInIndex` fired before
     * `status` was back.
     */
    early?: Promise<GitRun | null> | undefined
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
      if (
        (rel === '.gitattributes' || rel.endsWith('/.gitattributes')) &&
        attributesCanConvert(path.join(args.workspaceRoot, rel))
      ) {
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
  const res = await (args.early ?? args.spawnGit(CHECK_ATTR, [...trusted.keys()].join('\0')))
  if (res === null || res.exitCode !== 0) return
  for (const rel of parseCheckAttrOutput(res.stdout)) trusted.delete(rel)
}

const CHECK_ATTR = [
  'check-attr',
  '--stdin',
  '-z',
  'text',
  'eol',
  'ident',
  'filter',
  'working-tree-encoding',
]

/**
 * The filter gate's half that needs only the index listing: an attributes
 * file tracked in it, in `$GIT_DIR/info/attributes`, or above the scanned
 * dirs. When it fires, `dropFilteredOids` is sure to ask `check-attr`, so the
 * enumeration starts it beside `status` (~8 ms on this repo, U-3)
 * instead of after it. When it does not, the whole gate decides later.
 */
function attributesInIndex(args: {
  tracked: readonly string[]
  workspaceRoot: string
  gitDir: string
  gitPrefix: string
  pathspecs: readonly string[]
}): boolean {
  if (
    args.gitDir !== '' &&
    existsSync(path.resolve(args.workspaceRoot, args.gitDir, 'info', 'attributes'))
  ) {
    return true
  }
  for (const rel of args.tracked) {
    if (
      (rel === '.gitattributes' || rel.endsWith('/.gitattributes')) &&
      attributesCanConvert(path.join(args.workspaceRoot, rel))
    )
      return true
  }
  return attributesAbove(args)
}

/**
 * Whether a `.gitattributes` can set an attribute that converts bytes. One
 * that names none of them, nor `binary` (git's one built-in macro) nor a
 * macro definition, cannot: `.vx/.gitattributes`' `linguist-generated`
 * line asked `check-attr` on every run (21 ms) and changed nothing. A macro
 * defined outside the tree already counts as an attributes source. A file
 * that does not read counts as one that converts. Read once per enumeration.
 */
function attributesCanConvert(file: string): boolean {
  let can = attributeReads.get(file)
  if (can === undefined) {
    try {
      can = CONVERTING_ATTRIBUTE.test(readFileSync(file, 'utf8'))
    } catch {
      can = true
    }
    attributeReads.set(file, can)
  }
  return can
}

const CONVERTING_ATTRIBUTE =
  /\[attr\]|\b(?:text|eol|ident|filter|working-tree-encoding|crlf|binary)\b/
const attributeReads = new Map<string, boolean>()

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
        const file = path.join(dir, '.gitattributes')
        if (existsSync(file) && attributesCanConvert(file)) return true
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
    // A bare key (`[core] fileMode` with no `=`) is listed without one, and
    // git reads it as true.
    else if (eq === -1 && /^[a-z]+\./i.test(line)) vars.set(line, 'true')
  }
  return vars
}

/**
 * A boolean config value as git reads it: `true`/`yes`/`on`, `false`/
 * `no`/`off` and the empty value, or an integer (`k`/`m`/`g` suffix
 * allowed) that is true when nonzero. Only `false`/`no`/`off`/`0` were
 * taken, so `trustctime =` or `fileMode = 00` kept index OIDs trusted
 * while git judged by the weaker stat. Undefined when unset or not a
 * boolean git takes.
 */
function gitBool(v: string | undefined): boolean | undefined {
  if (v === undefined) return undefined
  const t = v.trim().toLowerCase()
  if (t === 'true' || t === 'yes' || t === 'on') return true
  if (t === 'false' || t === 'no' || t === 'off' || t === '') return false
  const n = /^([-+]?\d+)[kmg]?$/.exec(t)
  return n === null ? undefined : Number(n[1]) !== 0
}

/**
 * `true` when git ignores the executable bit (`core.fileMode=false`, the
 * default on WSL's DrvFs and what `git init` writes on a filesystem without
 * one). Then `git status` reports no `chmod`, and a trusted file's index mode
 * says nothing about the worktree.
 */
function fileModeIgnored(gitVars: string): boolean {
  return gitBool(gitVarList(gitVars).get('core.filemode')) === false
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
  const checkStat = vars.get('core.checkstat')?.trim().toLowerCase()
  return gitBool(vars.get('core.trustctime')) === false || checkStat === 'minimal'
}

/** `true` when git may rewrite bytes for EVERY auto-detected text file. */
export function autocrlfConverts(gitVars: string): boolean {
  const v = gitVarList(gitVars).get('core.autocrlf')
  return v?.trim().toLowerCase() === 'input' || gitBool(v) === true
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
  ignored: string[]
} {
  const tokens = out.split('\0')
  const dirty = new Set<string>()
  const untracked: string[] = []
  const undecodable = new Set<string>()
  const ignored: string[] = []
  let ignoredAttributes = false
  for (const token of tokens) {
    if (token.length < 4) continue
    if (token[0] === '!') {
      if (token === '!! .gitattributes' || token.endsWith('/.gitattributes'))
        ignoredAttributes = true
      ignored.push(token.slice(3))
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
  return { dirty, untracked, undecodable, ignoredAttributes, ignored }
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
 * `inputs.workspaceFiles`. Disables pathspec scoping (those
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
  /** The paths the index lists (a submodule as its gitlink), workspace-relative: what git tracks. */
  tracked: readonly string[]
  /** The directories `tracked` covers, workspace-relative (`.` for the whole tree). */
  scopes: readonly string[]
  /** Workspace-relative path → index OID, for files whose worktree state matched the index. */
  trusted: Map<string, string>
  /** Tracked paths git does not look at on disk (assume-unchanged, skip-worktree), workspace-relative. */
  flagged: readonly string[]
  /** Whether the worktree had uncommitted changes; null when `git status` failed. */
  dirty: boolean | null
  /** `git var -l`'s listing (merged config, then git's variables); null when it failed. */
  vars: string | null
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
  /** What `git status` named ignored, workspace-relative and sorted (a directory with its `/`). */
  ignored: readonly string[]
  /** `Date.now()` before the spawns: what `trusted` says is true as of no earlier. */
  startedAtMs: number
  /** The blob-size check's input (`dropResizedOids`). */
  blobCheck: IndexBlobCheck
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
  const rels = projectDirs.map((d) => relPosix(workspaceRoot, d))
  const scoped =
    !workspaceWide &&
    rels.length > 0 &&
    rels.length <= MAX_SCOPED_PATHSPECS &&
    rels.every((r) => r !== '' && r !== '.')
  return scoped ? rels : ['.']
}

/**
 * Whether the index holds a racily clean entry: a file stamped no earlier
 * than the second the index was written. git cannot trust its stat and
 * re-hashes the file on every `status` until something rewrites the index,
 * and a fresh checkout is all such entries. A layout this does not read
 * answers false.
 */
function hasRacyEntry(index: Uint8Array, mtimeSec: number, oidBytes: number): boolean {
  const view = new DataView(index.buffer, index.byteOffset, index.byteLength)
  if (index.length < 12 || view.getUint32(0) !== 0x44495243) return false
  const version = view.getUint32(4)
  if (version < 2 || version > 4) return false
  const count = view.getUint32(8)
  let at = 12
  for (let i = 0; i < count; i++) {
    const flagsAt = at + 40 + oidBytes
    if (flagsAt + 2 > index.length) return false
    if (view.getUint32(at + 8) >= mtimeSec) return true
    let pathAt = flagsAt + 2
    if (version >= 3 && (view.getUint16(flagsAt) & 0x4000) !== 0) pathAt += 2
    // v4 opens the path with a varint (bytes of the previous path to drop).
    if (version === 4) while ((index[pathAt++] ?? 0) & 0x80);
    const end = index.indexOf(0, pathAt)
    if (end < 0) return false
    at = version === 4 ? end + 1 : at + ((end - at + 8) & ~7)
  }
  return false
}

/** A private copy a run older than this may still have handed to `status`. */
const STALE_INDEX_MS = 60_000

/** Whether `status` should read a refreshed copy of the index (`refreshedIndex`). */
function racyIndex(
  read: { bytes: Uint8Array; st: Stats },
  objectFormat: 'sha1' | 'sha256',
): boolean {
  if (GIT_LOCATION_ENV.some((name) => process.env[name] !== undefined)) return false
  return hasRacyEntry(
    read.bytes,
    Math.floor(read.st.mtimeMs / 1000),
    objectFormat === 'sha256' ? 32 : 20,
  )
}

/**
 * The index `status` reads when the real one holds a racily clean entry: a
 * copy refreshed once and kept beside it, named by the real index's bytes.
 * `status` reads the real index without writing it (item 880), so in a
 * checkout nothing else had refreshed, every run re-hashed every racy file:
 * 347 against 8 ms on 1,800 files. The copy keeps the real mtime until git
 * refreshes it, so git's own racy rule holds for it; only stats move, the
 * entries are the real index's. Undefined: read the real index.
 */
async function refreshedIndex(
  indexFile: string,
  read: { bytes: Uint8Array; hash: string; st: Stats },
  spawnGit: (
    args: string[],
    stdin?: string,
    env?: Record<string, string>,
  ) => Promise<GitRun | null>,
): Promise<string | undefined> {
  const { bytes, hash, st } = read
  const dir = path.dirname(indexFile)
  const name = `vx-index-${hash}`
  const copy = path.join(dir, name)
  if (existsSync(copy)) return copy
  const tmp = `${copy}.${process.pid}`
  try {
    writeFileSync(tmp, bytes)
    utimesSync(tmp, st.atime, st.mtime)
    const run = await spawnGit(['update-index', '-q', '--refresh'], undefined, {
      GIT_INDEX_FILE: tmp,
    })
    if (run === null || run.exitCode !== 0) throw new Error('refresh failed')
    renameSync(tmp, copy)
  } catch {
    rmSync(tmp, { force: true })
    return undefined
  }
  const stale = Date.now() - STALE_INDEX_MS
  for (const other of readdirSync(dir)) {
    if (!other.startsWith('vx-index-') || other === name) continue
    try {
      if (lstatSync(path.join(dir, other)).mtimeMs < stale) rmSync(path.join(dir, other))
    } catch {
      // another run swept it
    }
  }
  return copy
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
  attributeReads.clear()
  // The spawns are independent — run them concurrently so the
  // bulk-populate costs max(ls-files, status) wall time, not the sum
  // (status alone is ~74 ms on a 1000-project tree; serial spawning
  // was a measurable warm-path regression vs the pre-OID code).
  const spawnGit = async (
    args: string[],
    stdin?: string,
    env?: Record<string, string>,
  ): Promise<GitRun | null> => {
    const spawn = <Out extends 'pipe' | Bun.BunFile>(stdout: Out) =>
      Bun.spawn({
        // `status` refreshes the index when it can take `index.lock`, so
        // the user's own `git add` or `commit` failed on the lock while a
        // vx run held it (12 in 1,165 across 80 runs, item 880). Read-only, as
        // editors and prompts run it; a clean tree costs the same.
        cmd: [executablePath('git'), '--no-optional-locks', ...args],
        cwd: workspaceRoot,
        stdin: stdin === undefined ? 'ignore' : new TextEncoder().encode(stdin),
        stdout,
        stderr: 'pipe',
        env: env !== undefined ? { ...gitEnv(), ...env } : gitEnv(),
      })
    // To a file, not a pipe: the run's thread is busy discovering and
    // loading configs while git lists, and a pipe held a 10 MB listing
    // until the thread came back to drain it 64 KiB at a time (~90 ms of
    // a warm 5,000-project run). In a directory of its own, so no link
    // another user planted in a shared temp directory takes the bytes. A
    // temp directory that takes none falls back to the pipe.
    let dir: string | undefined
    try {
      dir = mkdtempSync(path.join(os.tmpdir(), 'vx-git-'))
    } catch {
      dir = undefined
    }
    try {
      let stdout: Uint8Array
      let stderr: string
      let exitCode: number
      if (dir !== undefined) {
        const out = path.join(dir, 'out')
        const proc = spawn(Bun.file(out))
        ;[stderr, exitCode] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
        stdout = await Bun.file(out).bytes()
      } else {
        const piped = spawn('pipe')
        ;[stdout, stderr, exitCode] = await Promise.all([
          new Response(piped.stdout).bytes(),
          new Response(piped.stderr).text(),
          piped.exited,
        ])
      }
      const { text, undecodable } = decodeGitZ(stdout)
      return { exitCode, stdout: text, stderr, undecodable }
    } catch {
      return null
    } finally {
      if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
    }
  }
  const startedAtMs = Date.now()
  // The gate for whether a clean filter can rewrite bytes between the
  // index and the worktree: git's merged config (`core.autocrlf`) and,
  // from git 2.42, the attributes files it reads outside the tree
  // (`attributeFilesOutsideTree`). No tree scan. It replaced a
  // `config --get-regexp` of three keys at the same cost (1.29 against
  // 1.32 ms, min of 30), which could not name the default global file.
  // Not foldable into the rev-parse below: rev-parse prints no config.
  const varsRun = spawnGit(['var', '-l'])
  // Asked while `var` runs, from the memo the file hasher reads
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
  // The blob-size check's verdict is a function of the index's entries, so
  // the index file's bytes key it: one read, where `ls-files --debug` and a
  // lookup per entry cost 550 ms at 100,000 files (A-60). The verdict's
  // paths are workspace-relative, so the repo→workspace prefix keys it too:
  // a nested workspace sharing the cache read the outer one's verdict and
  // trusted a resized blob.
  const pathspecKey = xxh3hex([facts?.prefix ?? '', ...pathspecs].join('\0'))
  const indexFile =
    facts === null || facts.indexFile === ''
      ? undefined
      : path.resolve(workspaceRoot, facts.indexFile)
  // `ls-files` and `status` each read the index on their own. A write
  // between them (an unstage, a checkout) paired one index's OIDs with the
  // other's verdict: a `git reset` of a staged edit made the file clean to
  // `status` while `ls-files` had listed the staged blob, and that blob
  // keyed the committed bytes on disk. The index is stamped before the
  // listing and after the status; an index that moved trusts no OID.
  const indexStamp = (): string | undefined => {
    if (indexFile === undefined) return undefined
    const st = lstatSync(indexFile, { throwIfNoEntry: false })
    return st === undefined ? undefined : `${st.ino}:${st.ctimeMs}:${st.size}`
  }
  const stampBefore = indexStamp()
  // Four spawns at most (the rev-parse is memoized per process), one
  // worktree walk. `ls-files -s -v` reads the INDEX only
  // (~9 ms on a 1000-project tree) and answers two questions at once: every
  // tracked path's OID and its cache-state flag. `status -uall` is the one
  // command that walks the worktree, and it answers two as well: which
  // tracked paths are dirty AND which files are untracked. Asking
  // `ls-files --others` for the untracked set walked the same tree a second
  // time (~50 ms of CPU, concurrent with status but contending with it).
  const listing = spawnGit(['ls-files', '-s', '-v', '-z', '--', ...pathspecs])
  // Read synchronously: `status` spawns once the read is in, and an async
  // read's answer waited for the main thread to yield, behind the workspace
  // config and discovery (~5 ms of a 1,200-task warm run's wait for git).
  const readIndex = ():
    | { bytes: Uint8Array; hash: string; st: Stats; key: string; stamp: string }
    | undefined => {
    if (indexFile === undefined) return undefined
    try {
      // Stat before the read: a write between them leaves an mtime older
      // than the bytes, which only makes more entries racy.
      const st = lstatSync(indexFile)
      const bytes = readFileSync(indexFile)
      const hash = xxh3hex(bytes)
      return {
        bytes,
        hash,
        st,
        key: `${hash}:${pathspecKey}`,
        stamp: `${st.ino}:${st.ctimeMs}:${st.size}`,
      }
    } catch {
      return undefined
    }
  }
  const read = readIndex()
  // `--ignored=matching` names an ignored path without descending into an
  // ignored directory: git applies an ignored `.gitattributes` as it does
  // any other, and the filter gate below must see it (A-19).
  // `--no-renames`: a deletion paired as an unmerged path's rename source
  // prints only as `UU <path>`, and the deleted file stayed trusted (A-59).
  const spawnStatus = (index: string | undefined) =>
    spawnGit(
      [
        'status',
        '--porcelain',
        '-z',
        '-uall',
        '--ignored=matching',
        '--no-renames',
        '--',
        ...pathspecs,
      ],
      undefined,
      index === undefined ? undefined : { GIT_INDEX_FILE: index },
    )
  // An index with no racy entry is read as it is: `status` spawns now.
  const statusRun =
    read === undefined || indexFile === undefined || !racyIndex(read, facts!.objectFormat)
      ? spawnStatus(undefined)
      : refreshedIndex(indexFile, read, spawnGit).then(spawnStatus)
  const running = Promise.all([listing, statusRun, varsRun])
  const gitPrefix = facts?.prefix ?? ''
  const gitDir = facts?.commonDir ?? ''
  const ls = await listing
  const parsedLs =
    ls !== null && ls.exitCode === 0
      ? parseLsFilesOutput(ls.stdout.length === 0 ? [] : ls.stdout.split('\0'), ls.undecodable)
      : undefined
  const early =
    parsedLs !== undefined &&
    parsedLs.oids.size > 0 &&
    attributesInIndex({ tracked: parsedLs.files, workspaceRoot, gitDir, gitPrefix, pathspecs })
      ? spawnGit(CHECK_ATTR, [...parsedLs.oids.keys()].join('\0'))
      : undefined
  const [, status, vars] = await running
  const indexMoved = indexStamp() !== stampBefore
  // The key stands for the index `ls-files` listed only when that index
  // was written before the enumeration began (git writes it by rename, so
  // the stamp moves with any write) and is still in place after it: a
  // `git add` between the listing and the read paired one index's verdict
  // with the other's entries. Otherwise this run asks for no verdict.
  let indexKey: string | undefined
  if (
    read !== undefined &&
    read.st.ctimeMs < startedAtMs - racyWindowMs(read.st.ctimeMs, FILE_HASH_RACY_MS)
  ) {
    try {
      const st = lstatSync(indexFile!)
      if (`${st.ino}:${st.ctimeMs}:${st.size}` === read.stamp) indexKey = read.key
    } catch {
      // gone: no key
    }
  }
  if (ls === null) {
    throw gitSpawnRefusal(workspaceRoot)
  }
  if (parsedLs === undefined)
    throw gitFailure(workspaceRoot, 'ls-files', ls.exitCode, ls.stderr.trim())
  const { files: tracked, oids, flagged, gitlinks, undecodable } = parsedLs
  // Normalize `status`'s repo-root-relative paths to workspace-relative (strip
  // the `--show-prefix`) so the dirty set is keyed identically to the trusted
  // OID map. Without this, when the workspace root is a git subdir, a modified
  // tracked file is never pruned from `trusted` and keeps its committed OID —
  // a STALE cache hit serving old outputs. Empty prefix (workspace == git root,
  // the common case) is a zero-cost no-op. Paths above the workspace can't be
  // inputs, so they drop out of the set.
  const parsedStatus =
    status !== null && status.exitCode === 0
      ? parseStatusOutput(status.stdout, status.undecodable)
      : null
  const dirty = parsedStatus === null ? null : stripPrefixFromSet(parsedStatus.dirty, gitPrefix)
  // Untracked files are inputs too (a new file is the commonest edit there
  // is). They come from the status walk, repo-root-relative like the dirty
  // set. Without a status answer the enumeration is the index alone.
  const untracked =
    parsedStatus === null
      ? []
      : [...stripPrefixFromSet(new Set(parsedStatus.untracked), gitPrefix)].filter(
          (rel) => !isInstalledPath(rel),
        )
  const listed = untracked.length === 0 ? tracked : tracked.concat(untracked)
  const nested = expandNestedRepos(workspaceRoot, listed, gitlinks)
  const all = nested.files
  undecodable.push(...nested.undecodable)
  // Aggregate dirtiness for the Tier-3 invocation record — derived from
  // this same status spawn so `run()` needs no second `git status`.
  // null when the status spawn failed (non-repo / git error).
  const worktreeDirty = dirty === null ? null : dirty.size > 0
  const trusted = dirty === null || indexMoved ? new Map<string, string>() : oids
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
    early,
  })
  if (vars !== null && vars.exitCode === 0 && fileModeIgnored(vars.stdout)) {
    restampModes(trusted, workspaceRoot)
  }
  if (parsedStatus !== null && parsedStatus.undecodable.size > 0) {
    undecodable.push(...stripPrefixFromSet(parsedStatus.undecodable, gitPrefix))
  }
  return {
    all,
    tracked: gitlinks.size === 0 ? tracked : tracked.concat([...gitlinks]),
    scopes: pathspecs,
    trusted,
    flagged: [...flagged],
    dirty: worktreeDirty,
    vars: vars !== null && vars.exitCode === 0 ? vars.stdout : null,
    changed: dirty === null ? null : [...dirty, ...untracked],
    untracked: dirty === null ? null : untracked,
    undecodable,
    ignored:
      parsedStatus === null
        ? []
        : [...stripPrefixFromSet(new Set(parsedStatus.ignored), gitPrefix)].sort(),
    startedAtMs,
    blobCheck: {
      key: indexKey,
      async blobs() {
        const run = await spawnGit(['ls-files', '-s', '-v', '-z', '--debug', '--', ...pathspecs])
        if (run === null || run.exitCode !== 0) return null
        // Sizes from an index written since the listing judge entries the
        // trusted OIDs did not come from: an add there rewrote a resized
        // entry to one that fits, and the listed OID stood (A-60).
        if (indexStamp() !== stampBefore) return null
        const debug = splitLsDebug(run)
        const indexed = new Map<string, { oid: string; size: number }>()
        parseLsFilesOutput(debug.records, debug.undecodable, { sizes: debug.sizes, indexed })
        const blobs: IndexBlobs = { paths: [], oids: [], sizes: [] }
        for (const [rel, { oid, size }] of indexed) {
          blobs.paths.push(rel)
          blobs.oids.push(oid)
          blobs.sizes.push(size)
        }
        return blobs
      },
      rekey: async () => (await readIndex())?.key,
    },
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

/**
 * Each loose file's stat identity, `hashFile`'s memo key: mode, size,
 * mtime, ctime and inode. Undefined for a symlink (what it points to
 * folds too, and its stat does not move with that), a file gone, or one
 * changed within the racy window, where the memo trusts no stat either.
 */
function statRecords(
  rels: readonly string[],
  abs: (rel: string) => string,
  prefixLength: number,
): string | undefined {
  if (rels.length === 0) return ''
  const now = Date.now()
  let out = ''
  for (const rel of rels) {
    const st = lstatSync(abs(rel), { throwIfNoEntry: false })
    if (st === undefined || !st.isFile()) return undefined
    if (now - Math.floor(st.ctimeMs) < racyWindowMs(st.ctimeMs, FILE_HASH_RACY_MS)) return
    const mode = (st.mode & 0o100) !== 0 ? '100755' : '100644'
    out += `${rel.slice(prefixLength)}\0stat:${mode}:${st.size}:${Math.floor(st.mtimeMs)}:${Math.floor(st.ctimeMs)}:${Number(st.ino)}\n`
  }
  return out
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
  cache.setGitVars(enumeration.vars)
  cache.setIgnored(workspaceRoot, enumeration.ignored)
  cache.enumeratedAtMs = enumeration.startedAtMs
  cache.markUndecodable(enumeration.undecodable.map((rel) => path.join(workspaceRoot, rel)))
  cache.noteTrackedLater(
    enumeration.scopes.map((rel) => path.join(workspaceRoot, rel)),
    () => enumeration.tracked.map((rel) => path.join(workspaceRoot, rel)),
  )
  // Sort once, then each project's files are a contiguous range found
  // by binary search on its `dir/` prefix — O((F+P) log F) instead of
  // the O(P·F) per-project startsWith scan (54 ms at 1090 projects ×
  // ~9k files; ~5 ms this way). Every path under `dir/` sorts in
  // [`dir/`, `dir0`): '0' is the code unit after '/'. An upper bound of
  // `dir/` + U+FFFF left out a file whose name starts with U+FFFF, and
  // it never entered the key.
  // Git lists in order; a list that already is skips the sort.
  let inOrder = true
  for (let i = 1; i < all.length; i++) {
    if (all[i - 1]! > all[i]!) {
      inOrder = false
      break
    }
  }
  const sorted = inOrder ? all : [...all].sort()
  const undecodable =
    enumeration.undecodable.length === 0 ? undefined : new Set(enumeration.undecodable)
  // Git prints normalized relative paths, so under an absolute, normalized
  // root a join is a concatenation: `path.join` per tracked file and
  // `path.relative` per project were most of this pass (I-30's rule).
  const base =
    path.sep === '/' &&
    path.isAbsolute(workspaceRoot) &&
    path.normalize(workspaceRoot) === workspaceRoot
      ? workspaceRoot.endsWith('/')
        ? workspaceRoot
        : `${workspaceRoot}/`
      : undefined
  const abs = (rel: string): string =>
    base === undefined ? path.join(workspaceRoot, rel) : base + rel
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
  const rootOids = (): Map<string, string> => {
    const oids = new Map<string, string>()
    for (const [rel, oid] of trusted) oids.set(abs(rel), oid)
    return oids
  }
  for (const projectDir of projectDirs) {
    const spelled =
      base !== undefined && projectDir.startsWith(base) && path.normalize(projectDir) === projectDir
        ? projectDir.slice(base.length).replace(/\/$/, '')
        : relPosix(workspaceRoot, projectDir)
    // macOS git reports paths NFC (core.precomposeunicode) while a dir
    // discovered by readdir keeps the spelling it was created with: match
    // NFC, and key the OIDs by the project's spelling, which is how
    // `resolveFiles` looks them up.
    const relPrefix = spelled.normalize('NFC')
    if (relPrefix === '' || relPrefix === '.') {
      cache.set(projectDir, all)
      cache.setLazyOids(projectDir, rootOids)
      continue
    }
    const prefix = `${relPrefix}/`
    const start = lowerBound(prefix)
    const end = lowerBound(`${relPrefix}0`)
    const matches: string[] = []
    const projAbs =
      relPrefix === spelled ? abs : (rel: string) => path.join(projectDir, rel.slice(prefix.length))
    const projOids = (): Map<string, string> => {
      const oids = new Map<string, string>()
      for (let i = start; i < end; i++) {
        const rel = sorted[i]!
        const oid = trusted.get(rel)
        if (oid !== undefined) oids.set(projAbs(rel), oid)
      }
      return oids
    }
    // One hash of the records joined: one per record was ~25 ms of 125,000.
    let records: string | undefined = ''
    // A file git vouches for no OID (untracked, or changed since the
    // index) is named by its stat instead, the identity `hashFile`'s memo
    // trusts: a just-added config or an edited file turned the fold memo
    // off for its whole project (+3-5 ms of solid's warm run, 2026-10-22).
    const loose: string[] = []
    for (let i = start; i < end; i++) {
      const rel = sorted[i]!
      const own = rel.slice(prefix.length)
      matches.push(own)
      if (records === undefined) continue
      const oid = trusted.get(rel)
      if (undecodable?.has(rel) === true || oid?.startsWith('120000:') === true) records = undefined
      else if (oid === undefined) loose.push(rel)
      else records += `${own}\0${oid}\n`
    }
    // An empty slice is a directory git did not see, not an empty project:
    // a project has at least its package.json, tracked or untracked. A
    // nested repository — a submodule, an embedded repository, which the
    // workspace's git holds as ONE entry (a gitlink, `dir/` when untracked)
    // — is listed through its own git above (`expandNestedRepos`), but under
    // a pathspec naming a project inside it the workspace's git lists
    // nothing at all; so is a directory ignored outright. Storing the empty slice made the key never move: `inputs
    // matched no files`, then a stale hit under a green run once the source
    // changed (2026-09-16). No partition instead: `resolveFiles` spawns
    // `git ls-files` in the project's own directory, which a nested
    // repository answers, and the files hash by content (no index OID
    // trusted from here) — one spawn per such project per run, nothing for
    // a workspace without one.
    if (matches.length === 0) continue
    // setLazyOids AFTER set — set() drops the project's OID slot.
    cache.set(projectDir, matches)
    cache.setLazyOids(projectDir, projOids)
    if (records !== undefined) {
      const known = records
      cache.noteFilesDigest(projectDir, matches, () => {
        const statted = statRecords(loose, projAbs, prefix.length)
        return statted === undefined ? undefined : xxh3hex(`${known}\0${statted}`)
      })
    }
  }
  if (workspaceWide) {
    cache.set(workspaceRoot, all)
    cache.setLazyOids(workspaceRoot, rootOids)
    cache.setWorkspaceRoot(workspaceRoot)
  }
}
