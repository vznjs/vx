// The Merkle input root: vx's flat list of workspace-relative input paths
// becomes REAPI's nested `Directory` tree, and every node is a CAS blob.
//
// Why the file digests are recomputed rather than reused: vx's `InputFile`
// carries a GIT BLOB OID (sha1 over `blob <len>\0` + content), which is a
// different function over different bytes than REAPI's sha256-of-content.
// The key's digest cannot transfer, so the plugin hashes the worktree bytes
// itself — once per (path, size, mtime), cached, because a cold monorepo has
// tens of thousands of inputs and rehashing them per task would dwarf the
// upload it is meant to avoid.

import { createHash } from 'node:crypto'
import { lstat, readlink, stat } from 'node:fs/promises'
import path from 'node:path'
import type { Digest, Directory, DirectoryNode, FileNode, SymlinkNode } from './wire.js'

export interface Blob {
  digest: Digest
  data: Uint8Array
}

export interface InputTree {
  /** Digest of the root `Directory` — goes in `Action.input_root_digest`. */
  root: Digest
  /** Every blob the server needs: file contents plus the Directory nodes. */
  blobs: Blob[]
  /** File count, for logging/metrics. */
  fileCount: number
}

export function sha256(data: Uint8Array): Digest {
  return { hash: createHash('sha256').update(data).digest('hex'), size_bytes: data.length }
}

/**
 * Content digests keyed by `(path, size, mtime_ns)` — Bazel's digest cache.
 * Not persisted in phase 1: a run's own reuse is where the win is, and a
 * stale on-disk cache keyed by mtime is a correctness risk this does not
 * need to take yet.
 */
export class DigestCache {
  private readonly entries = new Map<string, Digest>()

  async digestOf(absPath: string, data: Uint8Array): Promise<Digest> {
    const st = await stat(absPath)
    const key = `${absPath}\0${st.size}\0${st.mtimeMs}`
    const hit = this.entries.get(key)
    if (hit !== undefined) return hit
    const d = sha256(data)
    this.entries.set(key, d)
    return d
  }

  get size(): number {
    return this.entries.size
  }
}

interface DirNode {
  files: Map<string, FileNode>
  dirs: Map<string, DirNode>
  symlinks: Map<string, SymlinkNode>
  /** Pre-digested subtrees grafted by reference — no bytes on this machine. */
  rawDirs: Map<string, Digest>
}

const emptyDir = (): DirNode => ({
  files: new Map(),
  dirs: new Map(),
  symlinks: new Map(),
  rawDirs: new Map(),
})

/** A file grafted into the tree by DIGEST — its bytes are already in the CAS. */
export interface FileGraft {
  /** Workspace-relative POSIX path. */
  path: string
  digest: Digest
  isExecutable: boolean
}

/** A whole directory grafted from a decoded REAPI `Tree`. */
export interface TreeGraft {
  /** Workspace-relative POSIX path the subtree lands at. */
  path: string
  root: Directory
  children: Directory[]
}

/**
 * Re-canonicalise a Tree's directory graph bottom-up under OUR encoder.
 * The Tree's internal `DirectoryNode.digest` values were computed by the
 * WORKER's encoder; if its byte layout differs from ours in any way, reusing
 * them while re-encoding parents would produce parents that reference child
 * digests no blob matches. Rebuilding every digest from the leaves up makes
 * the graph self-consistent regardless of who produced it — file digests are
 * untouched (content-addressed, already in the CAS).
 */
export function canonicaliseTree(graft: TreeGraft): { root: Digest; blobs: Blob[] } {
  const byOldDigest = new Map<string, Directory>()
  for (const child of graft.children) {
    byOldDigest.set(sha256(encodeDirectory(child)).hash, child)
  }
  const blobs: Blob[] = []
  const rebuild = (dir: Directory): Digest => {
    const directories: DirectoryNode[] = dir.directories.map((d) => {
      const child = byOldDigest.get(d.digest.hash)
      // A child we cannot resolve keeps its original digest — the blob may
      // exist server-side under the worker's encoding even if we cannot
      // re-derive it. Better a possibly-dangling reference than a wrong one.
      return child === undefined ? d : { name: d.name, digest: rebuild(child) }
    })
    const canonical: Directory = { files: dir.files, directories, symlinks: dir.symlinks }
    const data = encodeDirectory(canonical)
    const digest = sha256(data)
    blobs.push({ digest, data })
    return digest
  }
  return { root: rebuild(graft.root), blobs }
}

/**
 * Build the input root from workspace-relative paths. `executableFor` decides
 * the executable bit, which REAPI carries per file and which a build that
 * runs a checked-in script depends on.
 */
export async function buildInputTree(args: {
  workspaceRoot: string
  paths: readonly string[]
  digests?: DigestCache
  readFile?: (abs: string) => Promise<Uint8Array>
  /** Files referenced by digest — upstream outputs already in the CAS. */
  fileGrafts?: readonly FileGraft[]
  /** Directories grafted from upstream output Trees, re-canonicalised. */
  treeGrafts?: readonly TreeGraft[]
}): Promise<InputTree> {
  const digests = args.digests ?? new DigestCache()
  const read =
    args.readFile ?? (async (abs: string) => new Uint8Array(await Bun.file(abs).arrayBuffer()))
  const root = emptyDir()
  const blobs: Blob[] = []
  const seen = new Set<string>()
  let fileCount = 0

  // Sorted so the tree — and therefore the action digest — is deterministic
  // regardless of the caller's ordering.
  for (const rel of [...args.paths].sort()) {
    const abs = path.join(args.workspaceRoot, rel)
    // lstat, not stat: a symlinked input must be REPRESENTED as a symlink.
    // Following it would upload the target's bytes under the link's path —
    // a tree that lies about its own shape, and a worker that materialises a
    // copy where the task expects a link.
    const st = await lstat(abs)
    if (st.isSymbolicLink()) {
      const target = await readlink(abs)
      const parts = rel.split('/')
      let node = root
      for (const seg of parts.slice(0, -1)) {
        let next = node.dirs.get(seg)
        if (next === undefined) {
          next = emptyDir()
          node.dirs.set(seg, next)
        }
        node = next
      }
      node.symlinks.set(parts[parts.length - 1]!, { name: parts[parts.length - 1]!, target })
      continue
    }
    if (!st.isFile()) continue
    const data = await read(abs)
    const digest = await digests.digestOf(abs, data)
    if (!seen.has(digest.hash)) {
      seen.add(digest.hash)
      blobs.push({ digest, data })
    }
    const parts = rel.split('/')
    let node = root
    for (const seg of parts.slice(0, -1)) {
      let next = node.dirs.get(seg)
      if (next === undefined) {
        next = emptyDir()
        node.dirs.set(seg, next)
      }
      node = next
    }
    // The owner-execute bit is what REAPI models; group/other add nothing a
    // worker can act on.
    node.files.set(parts[parts.length - 1]!, {
      name: parts[parts.length - 1]!,
      digest,
      is_executable: (st.mode & 0o100) !== 0,
    })
    fileCount++
  }

  const insertAt = (rel: string): { node: DirNode; leaf: string } => {
    const parts = rel.split('/')
    let node = root
    for (const seg of parts.slice(0, -1)) {
      let next = node.dirs.get(seg)
      if (next === undefined) {
        next = emptyDir()
        node.dirs.set(seg, next)
      }
      node = next
    }
    return { node, leaf: parts[parts.length - 1]! }
  }

  for (const graft of args.fileGrafts ?? []) {
    const { node, leaf } = insertAt(graft.path)
    node.files.set(leaf, { name: leaf, digest: graft.digest, is_executable: graft.isExecutable })
    fileCount++
  }
  for (const graft of args.treeGrafts ?? []) {
    const { node, leaf } = insertAt(graft.path)
    const canonical = canonicaliseTree(graft)
    for (const b of canonical.blobs) {
      if (!seen.has(b.digest.hash)) {
        seen.add(b.digest.hash)
        blobs.push(b)
      }
    }
    node.rawDirs.set(leaf, canonical.root)
  }

  const rootDigest = serialise(root, blobs, seen)
  return { root: rootDigest, blobs, fileCount }
}

/**
 * Depth-first, children before parents: a Directory's digest covers its
 * children's digests, so they must be finalised first. REAPI requires `files`
 * and `directories` sorted by name — a server may reject an unsorted
 * Directory, and two orderings of the same tree would otherwise produce two
 * different action digests for identical inputs.
 */
function serialise(node: DirNode, blobs: Blob[], seen: Set<string>): Digest {
  const directories: DirectoryNode[] = []
  const dirNames = [...new Set([...node.dirs.keys(), ...node.rawDirs.keys()])].sort()
  for (const name of dirNames) {
    const sub = node.dirs.get(name)
    directories.push({
      name,
      // A grafted subtree wins over a disk-built one of the same name: the
      // graft is the upstream's AUTHORITATIVE output, the disk copy at best
      // a stale materialisation of it.
      digest: node.rawDirs.get(name) ?? serialise(sub!, blobs, seen),
    })
  }
  const files = [...node.files.keys()].sort().map((n) => node.files.get(n)!)
  const symlinks = [...node.symlinks.keys()].sort().map((n) => node.symlinks.get(n)!)
  const dir: Directory = { files, directories, symlinks }
  const data = encodeDirectory(dir)
  const digest = sha256(data)
  if (!seen.has(digest.hash)) {
    seen.add(digest.hash)
    blobs.push({ digest, data })
  }
  return digest
}

// --- minimal protobuf encoding for the messages whose DIGEST must match ---
//
// The action/command/directory digests are computed from the SERIALISED
// bytes, so they must be encoded exactly as the server would. proto-loader's
// runtime does not expose a stable "encode this message" for arbitrary types
// without a client call, so the four messages whose bytes are load-bearing
// are encoded here, field by field, per the REAPI schema.

function varint(n: number): Uint8Array {
  const out: number[] = []
  let v = n
  while (v >= 0x80) {
    out.push((v & 0x7f) | 0x80)
    v >>>= 7
  }
  out.push(v)
  return new Uint8Array(out)
}

function tag(field: number, wire: number): Uint8Array {
  return varint((field << 3) | wire)
}

function lenField(field: number, payload: Uint8Array): Uint8Array {
  return concat([tag(field, 2), varint(payload.length), payload])
}

// proto3 canonical encoding OMITS fields holding the default value, and every
// conformant implementation (Bazel's included) does so. Emitting an explicit
// zero would change the serialised bytes and therefore the DIGEST — most
// visibly for the empty blob, whose `size_bytes` is 0, so any tree containing
// an empty file would address differently from the server's view of it.
function strField(field: number, value: string): Uint8Array {
  return value === '' ? EMPTY : lenField(field, new TextEncoder().encode(value))
}

/**
 * A REPEATED string element. Unlike a singular field, every element of a
 * repeated field is emitted even when it is the empty string — and REAPI
 * gives `output_paths: [""]` a meaning (the entire working directory), so
 * dropping it would silently discard the action's outputs.
 */
function repStrField(field: number, value: string): Uint8Array {
  return lenField(field, new TextEncoder().encode(value))
}

function boolField(field: number, value: boolean): Uint8Array {
  return value ? concat([tag(field, 0), varint(1)]) : EMPTY
}

function intField(field: number, value: number): Uint8Array {
  return value === 0 ? EMPTY : concat([tag(field, 0), varint(value)])
}

const EMPTY = new Uint8Array()

export function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0)
  const out = new Uint8Array(total)
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.length
  }
  return out
}

/** `Digest { hash = 1 (string), size_bytes = 2 (int64) }` */
export function encodeDigest(d: Digest): Uint8Array {
  return concat([strField(1, d.hash), intField(2, d.size_bytes)])
}

/** `FileNode { name = 1, digest = 2, is_executable = 4, node_properties = 5 }` */
function encodeFileNode(f: FileNode): Uint8Array {
  return concat([
    strField(1, f.name),
    lenField(2, encodeDigest(f.digest)),
    boolField(4, f.is_executable),
    ...(f.node_properties === undefined
      ? []
      : [lenField(5, encodeNodeProperties(f.node_properties))]),
  ])
}

/**
 * `NodeProperties { properties = 1, mtime = 2, unix_mode = 3 }`.
 *
 * `unix_mode` is a `google.protobuf.UInt32Value` — a WRAPPER message, so the
 * value is nested (`{ value = 1 }`), not a bare varint. Same for `mtime` as a
 * `Timestamp { seconds = 1, nanos = 2 }`. Getting either shape wrong changes
 * the Directory bytes and therefore every digest above it.
 */
export function encodeNodeProperties(np: NodeProperties): Uint8Array {
  const parts: Uint8Array[] = []
  if (np.mtimeMs !== undefined) {
    const seconds = Math.floor(np.mtimeMs / 1000)
    const nanos = Math.round((np.mtimeMs - seconds * 1000) * 1e6)
    parts.push(lenField(2, concat([intField(1, seconds), intField(2, nanos)])))
  }
  if (np.unixMode !== undefined) parts.push(lenField(3, intField(1, np.unixMode)))
  return concat(parts)
}

/** `DirectoryNode { name = 1, digest = 2 }` */
function encodeDirectoryNode(d: DirectoryNode): Uint8Array {
  return concat([strField(1, d.name), lenField(2, encodeDigest(d.digest))])
}

/** `Directory { files = 1, directories = 2, symlinks = 3 }` */
export function encodeDirectory(dir: Directory): Uint8Array {
  return concat([
    ...dir.files.map((f) => lenField(1, encodeFileNode(f))),
    ...dir.directories.map((d) => lenField(2, encodeDirectoryNode(d))),
    ...dir.symlinks.map((s) => lenField(3, concat([strField(1, s.name), strField(2, s.target)]))),
  ])
}

/** REAPI `DigestFunction.Value`. SHA256 is the universal baseline. */
export const DIGEST_FUNCTION = {
  UNKNOWN: 0,
  SHA256: 1,
  SHA1: 2,
  MD5: 3,
  VSO: 4,
  SHA384: 5,
  SHA512: 6,
  MURMUR3: 7,
  BLAKE3: 8,
} as const
export type DigestFunctionName = keyof typeof DIGEST_FUNCTION

/** REAPI `Compressor.Value`. */
export const COMPRESSOR = { IDENTITY: 0, ZSTD: 1, DEFLATE: 2, BROTLI: 3 } as const

/** Node.js hash names for the digest functions we can actually compute. */
const HASH_ALGO: Partial<Record<DigestFunctionName, string>> = {
  SHA256: 'sha256',
  SHA1: 'sha1',
  MD5: 'md5',
  SHA384: 'sha384',
  SHA512: 'sha512',
  BLAKE3: 'blake3',
}

/**
 * Digest under a negotiated function. Servers advertise what they accept via
 * `Capabilities.cache_capabilities.digest_functions`; mixing functions inside
 * one action is invalid, so the choice is made once per client.
 */
export function digestWith(fn: DigestFunctionName, data: Uint8Array): Digest {
  const algo = HASH_ALGO[fn]
  if (algo === undefined) throw new Error(`@vzn/vx-reapi: unsupported digest function ${fn}`)
  return { hash: createHash(algo).update(data).digest('hex'), size_bytes: data.length }
}

/** True when this build of Bun/Node can compute the function at all. */
export function canDigest(fn: DigestFunctionName): boolean {
  const algo = HASH_ALGO[fn]
  if (algo === undefined) return false
  try {
    createHash(algo)
    return true
  } catch {
    return false
  }
}

export interface NodeProperties {
  /** POSIX mode bits, as REAPI's `unix_mode` (a `UInt32Value` wrapper). */
  unixMode?: number
  /** Modification time in ms since the epoch. */
  mtimeMs?: number
}

export const OUTPUT_DIRECTORY_FORMAT = {
  TREE_ONLY: 0,
  DIRECTORY_ONLY: 1,
  TREE_AND_DIRECTORY: 2,
} as const

export interface CommandSpec {
  arguments: readonly string[]
  environmentVariables: ReadonlyArray<{ name: string; value: string }>
  outputPaths: readonly string[]
  workingDirectory: string
  platform: ReadonlyArray<{ name: string; value: string }>
  /**
   * DEPRECATED-in-v2.1 fields, still SET for v2.0 servers: a v2.1+ server
   * reads `output_paths` and ignores these; a v2.0 server does the inverse
   * (`output_paths` is an unknown field to it). Setting both is how one
   * Command works against either generation. The digest stays consistent
   * because both sides hash the bytes the CLIENT produced.
   */
  legacyOutputFiles?: readonly string[]
  legacyOutputDirectories?: readonly string[]
  /** `output_node_properties` — names of NodeProperties the client wants back. */
  outputNodeProperties?: readonly string[]
  /** `output_directory_format` — request Tree blobs, root digests, or both. */
  outputDirectoryFormat?: number
}

/**
 * `Command { arguments = 1, environment_variables = 2, output_files = 3,
 *            output_directories = 4, platform = 5, working_directory = 6,
 *            output_paths = 7, output_node_properties = 8,
 *            output_directory_format = 9 }`
 *
 * Env vars and every output list MUST be sorted per the spec — otherwise two
 * identical commands hash differently and never share a cache entry across
 * machines. Fields are emitted in FIELD-NUMBER ORDER because the digest is
 * over these bytes and canonical encoders write ascending field numbers.
 */
export function encodeCommand(c: CommandSpec): Uint8Array {
  const env = [...c.environmentVariables].sort((a, b) =>
    a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
  )
  const platform = [...c.platform].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
  return concat([
    ...c.arguments.map((a) => repStrField(1, a)),
    ...env.map((e) => lenField(2, concat([strField(1, e.name), strField(2, e.value)]))),
    ...[...(c.legacyOutputFiles ?? [])].sort().map((p) => repStrField(3, p)),
    ...[...(c.legacyOutputDirectories ?? [])].sort().map((p) => repStrField(4, p)),
    ...(platform.length > 0
      ? [
          lenField(
            5,
            concat(
              platform.map((p) => lenField(1, concat([strField(1, p.name), strField(2, p.value)]))),
            ),
          ),
        ]
      : []),
    ...(c.workingDirectory === '' ? [] : [strField(6, c.workingDirectory)]),
    ...[...c.outputPaths].sort().map((p) => repStrField(7, p)),
    ...[...(c.outputNodeProperties ?? [])].sort().map((n) => repStrField(8, n)),
    ...(c.outputDirectoryFormat === undefined || c.outputDirectoryFormat === 0
      ? []
      : [intField(9, c.outputDirectoryFormat)]),
  ])
}

/**
 * `Action { command_digest = 1, input_root_digest = 2, timeout = 6,
 *           do_not_cache = 7 }`
 */
export function encodeAction(a: {
  commandDigest: Digest
  inputRootDigest: Digest
  timeoutSeconds?: number
  doNotCache?: boolean
  /** `salt` (field 9) — bytes that change the action digest without changing
   *  the work, so a caller can force a distinct cache entry. */
  salt?: Uint8Array
  /** `platform` (field 10) — REAPI v2.2 moved it here from `Command`. */
  platform?: ReadonlyArray<{ name: string; value: string }>
}): Uint8Array {
  const platform = [...(a.platform ?? [])].sort((x, y) =>
    x.name < y.name ? -1 : x.name > y.name ? 1 : 0,
  )
  return concat([
    lenField(1, encodeDigest(a.commandDigest)),
    lenField(2, encodeDigest(a.inputRootDigest)),
    ...(a.timeoutSeconds === undefined || a.timeoutSeconds === 0
      ? []
      : [lenField(6, intField(1, Math.floor(a.timeoutSeconds)))]),
    boolField(7, a.doNotCache === true),
    ...(a.salt === undefined || a.salt.length === 0 ? [] : [lenField(9, a.salt)]),
    ...(platform.length === 0
      ? []
      : [
          lenField(
            10,
            concat(
              platform.map((pr) =>
                lenField(1, concat([strField(1, pr.name), strField(2, pr.value)])),
              ),
            ),
          ),
        ]),
  ])
}

/** `Tree { root = 1, children = 2 }` — the shape an OutputDirectory points at. */
export function decodeTree(buf: Uint8Array): { root?: Directory; children: Directory[] } {
  const out: { root?: Directory; children: Directory[] } = { children: [] }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarintAt(buf, i)
    i = k
    const wire = key & 7
    if (wire !== 2) break
    const [len, l] = readVarintAt(buf, i)
    i = l
    const slice = buf.subarray(i, i + len)
    i += len
    if (key >>> 3 === 1) out.root = decodeDirectory(slice)
    else if (key >>> 3 === 2) out.children.push(decodeDirectory(slice))
  }
  return out
}

/** `Directory { files = 1, directories = 2, symlinks = 3 }` */
export function decodeDirectory(buf: Uint8Array): Directory {
  const dir: Directory = { files: [], directories: [], symlinks: [] }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarintAt(buf, i)
    i = k
    const wire = key & 7
    if (wire !== 2) break
    const [len, l] = readVarintAt(buf, i)
    i = l
    const slice = buf.subarray(i, i + len)
    i += len
    const field = key >>> 3
    if (field === 1) dir.files.push(decodeFileNode(slice))
    else if (field === 2) dir.directories.push(decodeDirectoryNode(slice))
    else if (field === 3) dir.symlinks.push(decodeSymlinkNode(slice))
  }
  return dir
}

function decodeFileNode(buf: Uint8Array): FileNode {
  const f: FileNode = { name: '', digest: { hash: '', size_bytes: 0 }, is_executable: false }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarintAt(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      const [len, l] = readVarintAt(buf, i)
      i = l
      const slice = buf.subarray(i, i + len)
      i += len
      if (field === 1) f.name = new TextDecoder().decode(slice)
      else if (field === 2) f.digest = decodeDigestBytes(slice)
    } else if (wire === 0) {
      const [v, n] = readVarintAt(buf, i)
      i = n
      if (field === 4) f.is_executable = v === 1
    } else break
  }
  return f
}

function decodeDirectoryNode(buf: Uint8Array): DirectoryNode {
  const d: DirectoryNode = { name: '', digest: { hash: '', size_bytes: 0 } }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarintAt(buf, i)
    i = k
    if ((key & 7) !== 2) break
    const [len, l] = readVarintAt(buf, i)
    i = l
    const slice = buf.subarray(i, i + len)
    i += len
    if (key >>> 3 === 1) d.name = new TextDecoder().decode(slice)
    else if (key >>> 3 === 2) d.digest = decodeDigestBytes(slice)
  }
  return d
}

function decodeSymlinkNode(buf: Uint8Array): SymlinkNode {
  const sl: SymlinkNode = { name: '', target: '' }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarintAt(buf, i)
    i = k
    if ((key & 7) !== 2) break
    const [len, l] = readVarintAt(buf, i)
    i = l
    const slice = buf.subarray(i, i + len)
    i += len
    if (key >>> 3 === 1) sl.name = new TextDecoder().decode(slice)
    else if (key >>> 3 === 2) sl.target = new TextDecoder().decode(slice)
  }
  return sl
}

export function decodeDigestBytes(buf: Uint8Array): Digest {
  const d: Digest = { hash: '', size_bytes: 0 }
  let i = 0
  while (i < buf.length) {
    const [key, k] = readVarintAt(buf, i)
    i = k
    const field = key >>> 3
    const wire = key & 7
    if (wire === 2) {
      const [len, l] = readVarintAt(buf, i)
      i = l
      if (field === 1) d.hash = new TextDecoder().decode(buf.subarray(i, i + len))
      i += len
    } else if (wire === 0) {
      const [v, n] = readVarintAt(buf, i)
      i = n
      if (field === 2) d.size_bytes = v
    } else break
  }
  return d
}

export function readVarintAt(buf: Uint8Array, at: number): [number, number] {
  let result = 0
  let shift = 0
  let i = at
  for (;;) {
    const byte = buf[i++]
    if (byte === undefined) return [result >>> 0, i]
    result |= (byte & 0x7f) << shift
    if ((byte & 0x80) === 0) break
    shift += 7
  }
  return [result >>> 0, i]
}
