// Restoring an entry's outputs into the tree, and replaying its log.

import { chmodSync, lstatSync, readlinkSync, renameSync, type Stats, statSync } from 'node:fs'
import { chmod, mkdir, rename, rm, symlink, utimes } from 'node:fs/promises'
import path from 'node:path'
import { isIndexFull } from '../index-db/index.js'
import {
  UserError,
  formatBytes,
  isDiskFull,
  isFsRefusal,
  isOutOfFds,
  OUT_OF_FDS_HINT,
  restorableOutput,
  restorableOutputDir,
  span,
  modeMatches,
  readUmask,
  restoredMode,
} from '../util/index.js'
import {
  ArchiveSecurityError,
  type ArtifactPlan,
  type ExecUsage,
  copyStaging,
  extractArtifactStream,
  linksRestorable,
  stagingRoot,
  packArtifactStream,
  planOfTree,
  stagesInto,
} from './archive.js'
import { ArtifactVanishedError, CorruptArtifactError, type DeclaredOutputs } from './layer.js'
import {
  type OutputFileRow,
  WORKSPACE_OUTPUT_PREFIX,
  DIR_MODE,
  LINK_MODE,
  rowAncestors,
  wideDirMode,
} from '../memo/index.js'
import { decodedTar } from './zstd.js'
import {
  StoreIndex,
  guard,
  stdoutText,
  tarPath,
  tempPath,
  tempTreePath,
  treePathOf,
} from './store-index.js'

/** A kept link's target, read as `planOfTree` reads it. */
const LINK_TEXT = new TextDecoder('utf-8', { ignoreBOM: true })

/** The sidecar's `exec` from a save's entry: only the axes the runner reported. */
export function usageOfEntry(entry: {
  cpuMs?: number
  peakRssBytes?: number
}): ExecUsage | undefined {
  if (entry.cpuMs === undefined && entry.peakRssBytes === undefined) return undefined
  return {
    ...(entry.cpuMs !== undefined ? { cpuMs: entry.cpuMs } : {}),
    ...(entry.peakRssBytes !== undefined ? { peakRssBytes: entry.peakRssBytes } : {}),
  }
}

/**
 * The directories with a mode to restore (`DIR_MODE` rows) that are absent
 * before the restore, or stand with another mode, deepest first: the
 * restore makes a missing one with mkdir's default, and each is then given
 * the mode the miss left, minus the umask as a file's is. A standing one
 * kept its own mode once, so a branch switch A → B → A left B's 0755 on
 * A's `chmod 700 dist/keys`. A symlink is never followed. A mode only ever
 * narrows mkdir's default, whatever an artifact says.
 */
function modedDirs(
  rows: readonly OutputFileRow[],
  projectDir: string,
  workspaceRoot: string | undefined,
): Array<[string, number]> {
  const out: Array<[string, number]> = []
  for (const r of rows) {
    if ((r.mode & 0o170000) !== DIR_MODE || !r.path.endsWith('/')) continue
    const dir = rowDir(r.path.slice(0, -1), projectDir, workspaceRoot)
    if (dir === undefined) continue
    const st = lstatSync(dir, { throwIfNoEntry: false })
    if (st === undefined || (st.isDirectory() && !modeMatches(st.mode, r.mode)))
      out.push([dir, r.mode & 0o777])
  }
  return out
}

/** A row's directory on disk; a workspace one with no workspace, none. */
function rowDir(
  rel: string,
  projectDir: string,
  workspaceRoot: string | undefined,
): string | undefined {
  if (!rel.startsWith(WORKSPACE_OUTPUT_PREFIX)) return path.join(projectDir, rel)
  return workspaceRoot === undefined
    ? undefined
    : path.join(workspaceRoot, rel.slice(WORKSPACE_OUTPUT_PREFIX.length))
}

/**
 * The directories with no recorded mode that stood narrower than 0755
 * through the restore (a switch from an entry that chmods one, a hand's
 * chmod), each to be given 0755: an entry records only a narrower mode. A
 * directory the restore made (`made`, found missing) is mkdir's, 0755
 * already, and is not asked about again.
 */
function narrowedDirs(
  rows: readonly OutputFileRow[],
  projectDir: string,
  workspaceRoot: string | undefined,
  made: ReadonlySet<string>,
): Array<[string, number]> {
  const out: Array<[string, number]> = []
  const wide = (rel: string): void => {
    const dir = rowDir(rel, projectDir, workspaceRoot)
    if (dir === undefined || made.has(dir)) return
    for (let up = path.dirname(dir); up !== dir && up.length > 1; up = path.dirname(up))
      if (made.has(up)) return
    const st = lstatSync(dir, { throwIfNoEntry: false })
    if (st?.isDirectory() === true && !wideDirMode(st.mode)) out.push([dir, 0o755])
  }
  for (const r of rows)
    if (r.path.endsWith('/') && (r.mode & 0o170000) !== DIR_MODE) wide(r.path.slice(0, -1))
  for (const rel of rowAncestors(rows)) wide(rel)
  return out
}

/** `code: message`, where Bun's message does not already open with the code. */
function codeFirst(code: string | undefined, message: string): string {
  return code === undefined || message.startsWith(code) ? message : `${code}: ${message}`
}

function inTree(p: string | undefined, tree: string): boolean {
  return p !== undefined && (p === tree || p.startsWith(`${tree}/`))
}

/**
 * Whether an artifact entry names one of the task's declared outputs, as
 * the save could have packed it (`restorableOutput`: a `!` take-back, vx's
 * own files and an unnamed `node_modules` are none). Asked at ingest and
 * again at every restore, so an entry that reached the local store by any
 * route still writes nothing it should not.
 */
export function declaredName(declared: DeclaredOutputs): (name: string, dir?: boolean) => boolean {
  const isFile = restorableOutput(declared.files)
  const isWsFile = restorableOutput(declared.workspaceFiles, 'workspace')
  const isDir = restorableOutputDir(declared.files)
  const isWsDir = restorableOutputDir(declared.workspaceFiles, 'workspace')
  return (name, dir = false) =>
    name.startsWith('outputs/')
      ? (dir ? isDir : isFile)(name.slice('outputs/'.length))
      : name.startsWith(WORKSPACE_OUTPUT_PREFIX)
        ? (dir ? isWsDir : isWsFile)(name.slice(WORKSPACE_OUTPUT_PREFIX.length))
        : true
}

export async function restoreOutputs(
  ix: StoreIndex,
  hash: string,
  projectDir: string,
  workspaceRoot?: string,
  outputs?: DeclaredOutputs,
): Promise<void> {
  const used: { rows: readonly OutputFileRow[] } = { rows: [] }
  try {
    await restoreOutputsOnce(ix, hash, projectDir, workspaceRoot, outputs, used, false)
  } catch (err) {
    if (!(err instanceof CorruptArtifactError)) throw err
    let failed = err
    // A file artifact has no `at` to say a re-save in another process
    // replaced it since the probe: the probe's rows then name another
    // build's files, and this one reads as corrupt. Rows that changed
    // since are that race, so the restore runs once more on the rows read
    // now, and an entry is dropped only while its rows are the ones that
    // failed: another process's fresh entry is never taken.
    if (entryChanged(ix, hash, used.rows)) {
      try {
        await restoreOutputsOnce(ix, hash, projectDir, workspaceRoot, outputs, used, true)
        return
      } catch (again) {
        if (!(again instanceof CorruptArtifactError)) throw again
        failed = again
      }
    }
    // Bad bytes under a good key failed the task on every run until
    // `--force`, since nothing rewrote them. The
    // entry goes, and the caller runs the task, whose save stores it
    // again; running is always correct, only slower than a hit.
    if (ix.write && !(await dropUnchanged(ix, hash, used.rows)))
      throw new ArtifactVanishedError(hash)
    throw new ArtifactVanishedError(
      hash,
      `${failed.message}; ${ix.write ? 'dropped it' : 'left it (this cache is read-only)'}`,
      failed,
    )
  }
}

/** Whether `hash`'s committed rows are no longer `rows` (path, size, mode, mtime). */
function entryChanged(ix: StoreIndex, hash: string, rows: readonly OutputFileRow[]): boolean {
  const now = guard(ix, () => ix.outputs.loadOutputFilesBatch([hash]).get(hash) ?? [])
  if (now.length !== rows.length) return true
  const was = new Map(rows.map((r) => [r.path, r]))
  return now.some((r) => {
    const w = was.get(r.path)
    return w === undefined || w.size !== r.size || w.mode !== r.mode || w.mtimeMs !== r.mtimeMs
  })
}

/**
 * Restore a tree-form entry: its files copied (or cloned) out one by
 * one, and its links laid, where the outputs are absent, as on every
 * restore after a clean. Anything else (a tree to restore into, a
 * workspace output, a link the extractor would refuse) goes through the
 * extractor the tar form uses, fed the tree packed back into its tar.
 */
async function restoreTree(
  ix: StoreIndex,
  hash: string,
  tree: string,
  treeIno: number,
  rows: readonly OutputFileRow[],
  projectDir: string,
  workspaceRoot: string | undefined,
  verify: (provided: ReadonlySet<string>) => void,
  accept: ((name: string, dir?: boolean) => boolean) | undefined,
  dated: Map<string, number>,
  absentDirs: Set<string>,
): Promise<void> {
  const files = rows.filter((r) => !r.path.endsWith('/') && r.mode !== LINK_MODE)
  let bytes = 0
  for (const r of files) bytes += r.size
  if (bytes > ix.artifactCeiling) {
    throw new CorruptArtifactError(
      hash,
      `its outputs hold ${formatBytes(bytes)}, past the ${formatBytes(ix.artifactCeiling)} artifact ceiling`,
    )
  }
  if (
    await copyTree(
      ix,
      hash,
      tree,
      treeIno,
      rows,
      files,
      projectDir,
      workspaceRoot,
      accept,
      dated,
      absentDirs,
    )
  )
    return
  await extractArtifactStream(
    packArtifactStream(treePlan(ix, hash, tree, rows)),
    projectDir,
    workspaceRoot,
    verify,
    accept,
    workspaceRoot,
    undefined,
    dated,
    absentDirs,
  )
}

/**
 * The tree packed back into its tar, its sidecar rebuilt from the rows
 * and each file held to its row's size: the tree form keeps no checksum,
 * and a file cut short at rest (a crash after its rename, before its data
 * reached the disk) was restored, and uploaded under a fresh sum.
 */
export function treePlan(
  ix: StoreIndex,
  hash: string,
  tree: string,
  rows: readonly OutputFileRow[],
): ArtifactPlan {
  const usage = ix.selectUsage.get(hash) as {
    cpu_ms: number | null
    peak_rss_bytes: number | null
  } | null
  const exec = usageOfEntry({
    ...(usage?.cpu_ms != null ? { cpuMs: usage.cpu_ms } : {}),
    ...(usage?.peak_rss_bytes != null ? { peakRssBytes: usage.peak_rss_bytes } : {}),
  })
  let plan: ArtifactPlan
  try {
    plan = planOfTree(tree, stdoutText(ix, hash), rows, hash, exec)
  } catch (err) {
    // A kept link retargeted at rest, as a file is cut short: named as the damage it is.
    if (err instanceof ArchiveSecurityError) throw new CorruptArtifactError(hash, err.message, err)
    throw err
  }
  const size = new Map(rows.map((r) => [r.path, r.size]))
  for (const i of plan.inputs) {
    const rel = i.name.startsWith('outputs/') ? i.name.slice('outputs/'.length) : i.name
    const want = size.get(rel)
    if (want !== undefined && want !== i.size)
      throw new CorruptArtifactError(hash, `${i.name} holds ${i.size} bytes, recorded ${want}`)
  }
  return plan
}

/**
 * The copy-out: false, having written nothing, where it is not the case it
 * serves. It writes only where nothing stands: each file's place is absent,
 * and every directory on the way either is a real directory or is absent
 * and made here. solid's build outputs `store/dist/**` beside the sources
 * in `store/`; asking that each output's TOP be absent sent every such
 * restore through the tar extractor, ~25 ms a task. The
 * files of each absent top directory are copied into the workspace's
 * `.vx/tmp/` (`copyStaging`) and the directory renamed in once, so a
 * reader finds it complete or not at all; one staging cannot rename into
 * as a write in place would land (another filesystem, a setgid
 * directory) is the extractor's.
 */
async function copyTree(
  ix: StoreIndex,
  hash: string,
  tree: string,
  ino: number,
  rows: readonly OutputFileRow[],
  files: readonly OutputFileRow[],
  projectDir: string,
  workspaceRoot: string | undefined,
  accept: ((name: string) => boolean) | undefined,
  dated: Map<string, number>,
  absentDirs: Set<string>,
): Promise<boolean> {
  const links: Array<[string, string]> = []
  for (const r of rows) {
    if (r.path.startsWith(WORKSPACE_OUTPUT_PREFIX)) return false
    if (accept !== undefined && !r.path.endsWith('/') && !accept(`outputs/${r.path}`)) return false
    if (r.mode !== LINK_MODE) continue
    // The link as kept, held to its row as `planOfTree` holds it: one
    // retargeted at rest is the extractor's to refuse, and name.
    let to: Buffer
    try {
      to = readlinkSync(path.join(tree, r.path), 'buffer')
    } catch {
      return false
    }
    if (to.byteLength !== r.size || Bun.hash.crc32(to) !== r.mtimeMs) return false
    links.push([r.path, LINK_TEXT.decode(to)])
  }
  // Laid here only where the extractor lays each one; any refusal is its to name.
  if (links.length > 0 && !(await linksRestorable(links, rows, projectDir, workspaceRoot)))
    return false
  // What stands at each path, asked once: a real directory, nothing, or
  // anything else (a file, a link), which the extractor's rules decide.
  // Synchronous: the walk before this one looked these paths up, so each
  // answer is a cached dentry, and the async form cost a 1,600-restore run
  // ~40 ms of its main thread in promises.
  const standing = new Map<string, 'dir' | 'absent' | 'other'>()
  const at = (rel: string): 'dir' | 'absent' | 'other' => {
    let known = standing.get(rel)
    if (known === undefined) {
      try {
        const st = lstatSync(path.join(projectDir, rel), { throwIfNoEntry: false })
        known = st === undefined ? 'absent' : st.isDirectory() ? 'dir' : 'other'
        if (known === 'absent') absentDirs.add(path.join(projectDir, rel))
      } catch {
        known = 'other'
      }
      standing.set(rel, known)
    }
    return known
  }
  // The topmost absent directories this copy makes, and the files it
  // writes into a directory that stood: what a failure removes, and only that.
  const made = new Set<string>()
  const placed: string[] = []
  const fits = rows.every((r) => {
    const segs = r.path.replace(/\/$/, '').split('/')
    for (let i = 1; i <= segs.length; i++) {
      const rel = segs.slice(0, i).join('/')
      const isLeaf = i === segs.length
      const state = at(rel)
      if (state === 'absent') {
        if (!isLeaf || r.path.endsWith('/')) made.add(rel)
        else placed.push(rel)
        return true
      }
      if (state === 'other' || (isLeaf && !r.path.endsWith('/'))) return false
    }
    return true
  })
  if (!fits) return false
  // A directory made under another one made here is the outer one's.
  const roots = [...made].filter((d) => ![...made].some((o) => d.startsWith(`${o}/`)))
  readUmask()
  const plain = restoredMode(0o666)
  // Another process's re-save of this key renames the tree aside and a
  // new one in mid-copy: the files copied after came from another build.
  // A changed inode is that race, a miss (the task runs), and the entry
  // the other process saved is kept. `ino` is the tree's as the restore
  // found it, before this walk: a swap since is caught all the same.
  const swapped = (): boolean => lstatSync(tree, { throwIfNoEntry: false })?.ino !== ino
  // A standing directory of this user's that withholds its own write (a
  // task's `chmod 555 dist/ro`) gets owner write and search for the copy
  // and its mode back after, as the extractor's rename does: else only
  // root could restore a file into it, and the hit failed EACCES.
  const reopened = new Map<string, number>()
  const reopen = (dir: string): boolean => {
    if (reopened.has(dir)) return true
    const st = lstatSync(dir, { throwIfNoEntry: false })
    if (st?.isDirectory() !== true || st.uid !== process.getuid?.()) return false
    if ((st.mode & 0o300) === 0o300) return false
    reopened.set(dir, st.mode & 0o7777)
    chmodSync(dir, (st.mode & 0o7777) | 0o300)
    return true
  }
  // A missing top directory is built whole in staging and renamed in
  // once, as the extractor does: copied in place, a reader met its files
  // empty, then short. A file missing from a directory that stands is
  // copied straight to its place: a temp renamed in cost such a restore
  // a fifth to a third more (tmpfs, 3,000 files).
  if (roots.length === 0 && placed.length === 0) return true
  // A restore into a project directory not there yet makes it, as the
  // copy in place did.
  // Its stat also answers, below, what a rename into it keeps.
  let projectStat: Stats | undefined
  try {
    projectStat = statSync(projectDir, { throwIfNoEntry: false })
  } catch {
    projectStat = undefined
  }
  if (projectStat === undefined) await mkdir(projectDir, { recursive: true })
  const staging = roots.length > 0 ? copyStaging(workspaceRoot) : undefined
  if (staging?.stats !== undefined) {
    const fits = new Map<string, boolean>()
    for (const rel of roots) {
      const dir = path.dirname(path.join(projectDir, rel))
      let fit = fits.get(dir)
      if (fit === undefined) {
        const top = !rel.includes('/') && projectStat !== undefined
        fit = stagesInto(
          staging.stats,
          top ? projectStat : statSync(dir, { throwIfNoEntry: false }),
        )
        fits.set(dir, fit)
      }
      if (!fit) return false
    }
  }
  const temps = new Map(roots.map((rel) => [rel, staging!.temp(path.join(projectDir, rel))]))
  const target = (rel: string): string => {
    for (const d of roots) {
      if (rel === d || rel.startsWith(`${d}/`)) return temps.get(d)! + rel.slice(d.length)
    }
    return path.join(projectDir, rel)
  }
  // Per file, not `fs.promises.cp` of the tree (14.5 ms for vueuse's 92
  // tree files against 1.9; `cpSync` 3.5), nor a Worker: the copies are
  // 1.9 ms of a 25 ms restore, and one Worker's start is 1.5–2.4 ms.
  // A tree file is asked its type first: a FIFO at its place (damage at
  // rest) blocked the copy's open for a writer that never came, and the
  // run hung. An lstat, not an open of our own handed to Bun:
  // Bun clones only from a path, and a link there is damage too.
  const copy = async (to: string, from: string, rel: string): Promise<number> => {
    if (lstatSync(from, { throwIfNoEntry: false })?.isFile() === false)
      throw new CorruptArtifactError(hash, `${rel} is not a file in its stored tree`)
    try {
      return await Bun.write(to, Bun.file(from), { createPath: false })
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EACCES' || !reopen(path.dirname(to))) throw err
      return await Bun.write(to, Bun.file(from), { createPath: false })
    }
  }
  const landed: string[] = []
  let landing = false
  // Every file here is written, so each is dated now (see `dated`).
  const now = Date.now()
  const nowDate = new Date(now)
  try {
    const dirs = new Set<string>()
    for (const r of rows) {
      dirs.add(target(r.path.endsWith('/') ? r.path.slice(0, -1) : path.posix.dirname(r.path)))
    }
    // Only the deepest, at once: each makes its parents, and one after
    // another they cost solid's 13-directory restore ~1.5 ms of awaits.
    const sorted = [...dirs].sort()
    const leaves = sorted.filter((d, i) => !sorted[i + 1]?.startsWith(`${d}/`))
    if (leaves.length === 1) await mkdir(leaves[0]!, { recursive: true })
    else await Promise.all(leaves.map((d) => mkdir(d, { recursive: true })))
    // Every copy settles before a failure is handled: one still in flight
    // would write its file again after the cleanup removed it.
    // A link is undated, as the extractor lays it.
    const copied = await Promise.allSettled([
      ...files.map(async (r) => {
        const to = target(r.path)
        const n = await copy(to, path.join(tree, r.path), r.path)
        if (n !== r.size)
          throw new CorruptArtifactError(hash, `${r.path} holds ${n} bytes, recorded ${r.size}`)
        const mode = restoredMode(r.mode)
        if (mode !== plain) await chmod(to, mode)
        await utimes(to, nowDate, nowDate)
        dated.set(`outputs/${r.path}`, now)
      }),
      ...links.map(([rel, to]) => symlink(to, target(rel))),
    ])
    const failed = copied.find((c) => c.status === 'rejected')
    if (failed !== undefined) throw failed.reason
    if (swapped()) throw new ArtifactVanishedError(hash)
    landing = true
    // At once, every one settled before a failure is handled, as the
    // copies; one alone is awaited, as a 1,601-restore run felt the promises.
    const land = async (rel: string): Promise<void> => {
      await rename(temps.get(rel)!, path.join(projectDir, rel))
      landed.push(rel)
    }
    if (roots.length === 1) await land(roots[0]!)
    else {
      const renamed = await Promise.allSettled(roots.map(land))
      const unrenamed = renamed.find((c) => c.status === 'rejected')
      if (unrenamed !== undefined) throw unrenamed.reason
    }
  } catch (err) {
    await Promise.all([...temps.values()].map((t) => rm(t, { recursive: true, force: true })))
    // Something made at a missing directory's place since the walk: what
    // landed holds the entry's bytes, and the extractor restores the rest.
    const code = landing ? (err as NodeJS.ErrnoException).code : undefined
    if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EISDIR' || code === 'ENOTDIR')
      return false
    await Promise.all([
      ...landed.map((rel) => rm(path.join(projectDir, rel), { recursive: true, force: true })),
      ...placed.map((rel) => rm(path.join(projectDir, rel), { force: true })),
    ])
    if (!(err instanceof ArtifactVanishedError) && swapped()) throw new ArtifactVanishedError(hash)
    throw err
  } finally {
    for (const [dir, mode] of reopened) {
      try {
        chmodSync(dir, mode)
      } catch {
        // gone with the task's own cleanup since
      }
    }
  }
  return true
}

/**
 * Remove one entry while its rows are still `rows`: false, touching
 * nothing, once another process re-saved the key. Checked and dropped
 * under the write lock a save renames its artifact in under, so no save
 * lands between; the artifact is moved aside inside, unlinked after.
 */
async function dropUnchanged(
  ix: StoreIndex,
  hash: string,
  rows: readonly OutputFileRow[],
): Promise<boolean> {
  const aside: string[] = []
  const drop = ix.db.transaction(() => {
    if (entryChanged(ix, hash, rows)) return false
    for (const [from, to] of [
      [tarPath(ix, hash), tempPath(ix, hash)],
      [treePathOf(ix, hash), tempTreePath(ix, hash)],
    ] as const) {
      try {
        renameSync(from, to)
        aside.push(to)
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      }
    }
    ix.deleteBlob.run(hash)
    ix.deleteEntryRow.run(hash)
    ix.outputs.forget([hash])
    return true
  })
  let dropped: boolean
  try {
    dropped = drop.immediate()
  } catch (err) {
    if (!isIndexFull(err)) throw err
    dropped = drop.immediate()
  }
  for (const a of aside) await rm(a, { recursive: true, force: true })
  return dropped
}

async function restoreOutputsOnce(
  ix: StoreIndex,
  hash: string,
  projectDir: string,
  workspaceRoot: string | undefined,
  outputs: DeclaredOutputs | undefined,
  used: { rows: readonly OutputFileRow[] },
  fresh: boolean,
): Promise<void> {
  // In-process extraction — no fork+exec on the hot path
  // (~5-10ms reclaimed per hit vs the prior subprocess `tar -xf`).
  //
  // The "tree is already current" skip-everything check happens at
  // the orchestrator level (using the batched `output_files` map),
  // BEFORE this method runs. By the time we're here we've committed
  // to a fresh extract.
  //
  // `stdout` / `stderr` entries in the archive are ignored on this
  // path — they're surfaced via `get()` for the orchestrator to
  // replay through the logger.
  const src = tarPath(ix, hash)
  // The caller already committed to this hit and WIPED the declared
  // outputs, so a restore that did not fail here would report a green cache
  // hit over an emptied output tree. The artifact existed when `get()`
  // probed it, so its absence now means something removed it underneath us
  // (a `vx cache clean` in another shell, here or for another workspace
  // on a shared `--cache-dir`) — `ArtifactVanishedError`, which the caller
  // turns into a miss: the task runs.
  //
  // The FAILING is held twice: the decode below reaches the missing file
  // and throws `CorruptArtifactError` from the extract catch either way.
  // What the `ENOENT` mapping in that catch carries alone is the CLASS,
  // and the two ask for opposite answers — a prune raced this run (run
  // the task) versus the cache holds bad bytes (fail, and say so). The
  // roundtrip row asserts the class; a row that only asserts
  // "the restore fails" passes with the mapping deleted. A separate
  // `exists()` probe would cost one thread-pool round trip per restore, to
  // learn what the read reports itself.
  const endRows = span('restore: rows')
  // The index says exactly which files this entry materializes. If the
  // archive cannot produce one of them, restoring "successfully" leaves a
  // hole that no later run detects: the skip-restore check compares the
  // same truncated expectation against the same truncated tree and agrees
  // forever. Refuse instead of silently under-restoring — checked before
  // anything is renamed into place.
  //
  // An inline artifact and its rows are read in one read transaction, so
  // one snapshot: a re-save of the key in another process replaces both
  // in one commit, and two reads could pair its rows with the old bytes.
  // The probe's held rows serve only while the blob carries the
  // `at` the probe saw: a re-save or a renewal since moves it, and then
  // the rows are read again in the blob's snapshot. A file artifact's
  // re-save is caught after, by its rows (`restoreOutputs`).
  let rows: readonly OutputFileRow[] = []
  let inline: Uint8Array | undefined
  // With the probe's rows held, no transaction: a file artifact's tree,
  // standing now, is the live one, read with no statement (an inline save
  // moves the tree aside in the commit that adds its blob, and one moved
  // aside mid-copy is the race `copyTree` catches); an inline one is the
  // blob read alone, its own snapshot. The blob read and its transaction
  // cost a 1,600-restore run ~70 ms of its main thread.
  const held = fresh ? undefined : ix.outputs.heldRowsOf(hash)
  const heldAt = ix.heldInlineAt.get(hash)
  let treeIno: number | undefined
  let treeAsked = false
  if (held !== undefined && heldAt === undefined) {
    treeIno = lstatSync(treePathOf(ix, hash), { throwIfNoEntry: false })?.ino
    treeAsked = true
    if (treeIno !== undefined) rows = held
  } else if (held !== undefined) {
    const blob = guard(ix, () => ix.selectBlob.get(hash)) as {
      at: number
      bytes: Uint8Array
    } | null
    if (blob?.at === heldAt) {
      inline = blob!.bytes
      rows = held
    }
  }
  if (treeIno === undefined && inline === undefined) {
    guard(ix, () =>
      ix.db.transaction(() => {
        const blob = ix.selectBlob.get(hash) as { at: number; bytes: Uint8Array } | null
        inline = blob?.bytes
        rows =
          !fresh && (blob === null || blob.at === ix.heldInlineAt.get(hash))
            ? ix.outputs.rowsOf(hash)
            : (ix.outputs.loadOutputFilesBatch([hash]).get(hash) ?? [])
      })(),
    )
    // A tree asked of above and absent: the artifact is the blob or the
    // tar, and a tree saved since is a miss at worst (the tar is gone).
    if (inline === undefined && !treeAsked)
      treeIno = lstatSync(treePathOf(ix, hash), { throwIfNoEntry: false })?.ino
  }
  used.rows = rows
  const expected = rows
    .filter((r) => workspaceRoot !== undefined || !r.path.startsWith(WORKSPACE_OUTPUT_PREFIX))
    .map((r) => (r.path.startsWith(WORKSPACE_OUTPUT_PREFIX) ? r.path : `outputs/${r.path}`))
  endRows()
  const moded = modedDirs(rows, projectDir, workspaceRoot)
  // The directories the restore found missing: made 0755, not asked again.
  const absentDirs = new Set<string>()
  const verify = (provided: ReadonlySet<string>): void => {
    const missing = expected.filter((name) => !provided.has(name))
    if (missing.length > 0) {
      throw new CorruptArtifactError(
        hash,
        `artifact is missing ${missing.length} recorded output(s): ${missing.slice(0, 3).join(', ')}`,
      )
    }
  }

  // One tar reader and one extractor either way; only the decode differs
  // by size. A large artifact is decoded and read as it streams, so the
  // restore costs a chunk of memory, not 4× the artifact (measured
  // on 150 MiB: +644 MiB in memory, +49 MiB streamed, same
  // wall time). A small one is decoded in one call: the stream setup
  // costs ~35 µs per artifact, which is 4% of the headline restore row
  // when every artifact is a one-file `dist/` (measured: 390 vs 355 ms
  // per 1 000). The local artifact was validated at ingest, so a missing
  // declared size is allowed; the output ceiling applies to both.
  const tree = treeIno === undefined ? undefined : treePathOf(ix, hash)
  const written = new Map<string, number>()
  const endExtract = span('restore: extract')
  try {
    // Every step here is an async filesystem call on purpose: a
    // synchronous restore of a small artifact is 2× faster ALONE (1.25 →
    // 0.62 ms sequential) and 30% slower in the run, where
    // four workers overlap their round trips and a blocking one stalls
    // the other three (1,000-project restore row 1.1–1.2 s → 1.5 s).
    const accept = outputs === undefined ? undefined : declaredName(outputs)
    if (tree !== undefined) {
      await restoreTree(
        ix,
        hash,
        tree,
        treeIno!,
        rows,
        projectDir,
        workspaceRoot,
        verify,
        accept,
        written,
        absentDirs,
      )
    } else {
      const tar = await decodedTar(inline ?? Bun.file(src), hash, ix.artifactCeiling)
      await extractArtifactStream(
        tar,
        projectDir,
        workspaceRoot,
        verify,
        accept,
        workspaceRoot,
        undefined,
        written,
        absentDirs,
      )
    }
    // Keyed by row path: a project output's row drops the `outputs/`.
    const byRow = new Map<string, number>()
    for (const [name, t] of written)
      byRow.set(name.startsWith(WORKSPACE_OUTPUT_PREFIX) ? name : name.slice('outputs/'.length), t)
    ix.localMemo.datedMtimes.set(hash, byRow)
    const dirModes = [...moded, ...narrowedDirs(rows, projectDir, workspaceRoot, absentDirs)].sort(
      (a, b) => b[0].length - a[0].length,
    )
    for (const [dir, mode] of dirModes) await chmod(dir, restoredMode(mode))
  } catch (err) {
    // A UserError here is the extractor naming the tree's fault (an
    // output directory that links out of the project).
    if (
      err instanceof CorruptArtifactError ||
      err instanceof UserError ||
      err instanceof ArtifactVanishedError
    )
      throw err
    // The save and the ingest proved every name safe, so one that reads
    // unsafe now is damaged or tampered bytes: a long name's pax record
    // has no header checksum, and the name is judged before the CRC at
    // the end is read. Thrown as is, it failed the task on every run with
    // the entry kept.
    if (err instanceof ArchiveSecurityError) throw new CorruptArtifactError(hash, err.message, err)
    // What is on disk, not what is in the archive: a directory standing
    // where the entry holds a file, or a file where it needs a directory.
    // The restore removes the FILES the output globs select that block it
    // and the directories that removal emptied, so this is a path it left: one
    // the globs do not cover, or an empty directory where a file goes,
    // which `dist/**` covers and the clean does not take.
    // Named as such, not as a corrupt artifact. A
    // link on the way never lands here: the extractor writes through one
    // that stays in the project, dangling or not, and names one that
    // leaves it or loops.
    const code = (err as NodeJS.ErrnoException).code
    if (code === 'EISDIR' || code === 'ENOTDIR' || code === 'EEXIST' || code === 'ENOTEMPTY') {
      // Bun's message already opens with the code: `EEXIST: EEXIST: …` read
      // as a stutter. EEXIST and ENOTDIR are a FILE in a directory's
      // place; the told-backwards sentence named only the reverse.
      const msg = (err as Error).message
      const what =
        code === 'EISDIR' || code === 'ENOTEMPTY'
          ? 'a directory stands where the entry holds a file'
          : 'a file stands where the entry needs a directory'
      throw new UserError(
        `restore of ${hash} into ${projectDir} was blocked by what is on disk (${codeFirst(code, msg)}): ${what}. ` +
          `A restore replaces what the output globs select, not this — remove it and re-run.`,
      )
    }
    // A legal name under a destination deep enough that the two together
    // pass PATH_MAX: the artifact is fine, the workspace's location is
    // not.
    if (code === 'ENAMETOOLONG') {
      throw new UserError(
        `restore of ${hash} into ${projectDir} could not write its outputs (${code}: ${(err as Error).message}). ` +
          `An output path under this directory is longer than the file system allows — move the workspace to a shorter path.`,
      )
    }
    // Same distinction for a tree the process cannot write into — a
    // `dist/` another user owns, a read-only checkout, a full disk: the
    // artifact is intact, the tree is not the process's to change.
    // A refusal to READ the artifact is the cache directory's, not the
    // outputs': the old line sent the reader to the wrong tree.
    // A tree copy's error can name its source; no read fails ENOSPC.
    if (
      isFsRefusal(err) &&
      code !== 'ENOSPC' &&
      code !== 'EDQUOT' &&
      (err.path === src || (tree !== undefined && inTree(err.path, tree)))
    ) {
      throw new UserError(
        `restore of ${hash} could not read its artifact (${codeFirst(code, err.message)}). ` +
          `Make the cache directory readable by this user, or point cacheDir / --cache-dir at one that is.`,
      )
    }
    // The outputs may be writable while `.vx/tmp/`, where a restore
    // stages, is not: a read-only source mount with writable output
    // volumes. The outputs' remedy sent the user to the wrong path.
    if (isFsRefusal(err)) {
      const top = workspaceRoot === undefined ? undefined : stagingRoot(workspaceRoot)
      if (top !== undefined && code !== 'ENOSPC' && code !== 'EDQUOT' && inTree(err.path, top)) {
        throw new UserError(
          `restore of ${hash} into ${projectDir} could not stage its outputs: restores stage in ${top}, ` +
            `which is not writable (${codeFirst(code, err.message)}). ` +
            `Make it writable by this user (a writable mount or volume over a read-only checkout).`,
        )
      }
      const remedy = isDiskFull(err)
        ? 'Free space on that disk and re-run.'
        : 'Make the declared output paths writable by this user, or stop declaring them as outputs.'
      throw new UserError(
        `restore of ${hash} into ${projectDir} could not write its outputs (${codeFirst(code, err.message)}). ${remedy}`,
      )
    }
    // The process is out of descriptors: the artifact is fine, and
    // calling it corrupt sent the reader after the cache.
    if (isOutOfFds(err)) {
      throw new UserError(
        `restore of ${hash} into ${projectDir} could not open a file (${err.message}) — ${OUT_OF_FDS_HINT}`,
      )
    }
    // The artifact itself is gone: the read names its path (`bytes()`
    // opens it; a staged file's ENOENT names the temp below).
    if (code === 'ENOENT' && (err as NodeJS.ErrnoException).path === src) {
      throw new ArtifactVanishedError(hash)
    }
    // So is a tree a prune or another process's re-save moved aside
    // mid-copy. The tree the restore found, still in place, lacking a
    // file is damage at rest (a hand-deleted file): called vanished "(a
    // vx cache clean)" that never ran, and kept, so the demoted task's
    // own probe hit it again and said so twice.
    const missing = (err as NodeJS.ErrnoException).path
    if (code === 'ENOENT' && tree !== undefined && inTree(missing, tree)) {
      if (lstatSync(tree, { throwIfNoEntry: false })?.ino !== treeIno)
        throw new ArtifactVanishedError(hash)
      const rel = path.relative(tree, missing!).split(path.sep).join('/')
      throw new CorruptArtifactError(hash, `${rel} is missing from its stored tree`)
    }
    // A staged file the restore itself just wrote is gone before its
    // commit: another process cleaned the same outputs under us (two runs
    // on one workspace, a `vx watch` beside a `vx run` — a clean landing
    // 4–32 ms into a 2,000-file restore reproduces it). The
    // artifact is intact; the tree was not ours alone.
    if (code === 'ENOENT' && /\.vx-tmp-|[\\/]\.vx[\\/]tmp[\\/]/.test((err as Error).message)) {
      throw new UserError(
        `restore of ${hash} into ${projectDir} was interrupted: a file it had just written vanished (${(err as Error).message}). ` +
          `Another vx run is using this workspace — re-run once it is done.`,
      )
    }
    throw new CorruptArtifactError(hash, 'artifact is not a readable archive', err)
  } finally {
    endExtract()
  }
}
