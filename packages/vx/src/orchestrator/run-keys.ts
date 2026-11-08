// The run key memo: every up-front key a warm run derived, read back whole
// when nothing any of them folds has moved. Deriving them again cost 250 ms
// of a 1,070 ms warm run at 9,600 tasks even with every fold memo row
// answering (2026-10-22): the per-task walk itself, not the files.
//
// The token is everything `deriveStableKeys` reads: each node's id, edges,
// resolved config, plugin key parts and files token, the declared env
// values, the forward args and the code that derives. A run the token cannot
// vouch for (a keyless or runtime-probed task, a declaration no files token
// covers) derives as before.

import { readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import type { GitFilesCache } from '../cache/index.js'
import type { TaskNode } from '../graph/index.js'
import { xxh3hex } from '../util/index.js'
import type { StableKey } from './stable-keys.js'
import {
  hashTaskConfig,
  inputStrategiesOf,
  isKeyless,
  taskFilesToken,
  workspaceCleanOf,
  type HashCache,
} from './task-hash.js'

/** Moves every remembered run: bump it when what a token stands for changes. */
const RUN_MEMO_VERSION = 'run-memo-v2'

export interface RunKeysArgs {
  nodes: Map<string, TaskNode>
  workspaceRoot: string
  claimedFiles: readonly string[]
  forwardArgs?: readonly string[] | undefined
  nestedDirsByProject: Map<string, string[]>
  gitFilesCache: GitFilesCache
  hashCache: HashCache
}

/** What a run's up-front pass yields, as the memo holds it. */
export interface RunKeys {
  stableKeys: StableKey[]
  uncachedKeys: Map<string, string>
}

/** Where a run's keys are remembered: the selection's row, under its token. */
export interface RunKeysAt {
  id: string
  token: string
  /**
   * The token less each node's files, and each node's files token, when a
   * remembered graph fixes every edge and config (`graph`): an edit then
   * moves only the files of the projects it touched, and the keys it
   * reaches are all that derive again (`readRunDelta`).
   */
  delta?: () => { global: string; files: Map<string, string> }
}

/**
 * The memo row's name (the selection) and the token its keys stand for, or
 * undefined when a node's key reads something the token cannot name.
 */
export function runKeysToken(args: RunKeysArgs): RunKeysAt | undefined {
  if (args.hashCache.folds === undefined) return undefined
  const parts: string[] = [
    RUN_MEMO_VERSION,
    codeIdentity(),
    args.workspaceRoot,
    JSON.stringify(args.forwardArgs ?? []),
    JSON.stringify([...args.claimedFiles].sort()),
    JSON.stringify([...args.nestedDirsByProject]),
    // Which outputs git ignores decides which a reader may see (`readableOutputs`).
    [...args.gitFilesCache.ignoredOutputs].sort().join('\0'),
    // Folded into a config's key; a remembered graph's token names the
    // lock, not `.vx/workspace` or the variables.
    String(workspaceCleanOf(args.hashCache)),
    String(inputStrategiesOf(args.hashCache)?.run),
    String(inputStrategiesOf(args.hashCache)?.workspace),
  ]
  // A remembered graph's token names every node's edges and config, so
  // each node adds only what may differ under it (4 of 8 ms at 1,206
  // tasks, 2026-10-23).
  const graph = args.hashCache.graph
  parts.push(graph ?? '')
  const ids: string[] = []
  const envNames = new Set<string>()
  // Tasks of one project mostly declare the same files and outputs, and the
  // token is a function of that declaration (`filesToken`): one walk each,
  // not one per task (5 of 12 ms at 1,206 tasks, 2026-10-23).
  // Keyed by the project, then by the declaration's text, and that text is
  // taken once per config object: the lock shares a config among the tasks
  // that declare it alike, and a stringify and a joined key per node were
  // ~6 ms of 9,603 (2026-11-07).
  const tokens = new Map<string, Map<string, string>>()
  const declarations = new Map<TaskNode['config'], string>()
  const declarationOf = (cfg: TaskNode['config']): string => {
    let text = declarations.get(cfg)
    if (text === undefined) {
      text = JSON.stringify([cfg.inputs?.files, cfg.outputs?.files, cfg.outputs?.workspaceFiles])
      declarations.set(cfg, text)
    }
    return text
  }
  const filesAt: number[] = []
  for (const node of args.nodes.values()) {
    const cfg = node.config
    if (isKeyless(cfg) || node.excludedUpstream !== undefined) return undefined
    const inputs = cfg.inputs
    if ((inputs?.runtime?.length ?? 0) > 0 || (inputs?.workspaceRuntime?.length ?? 0) > 0) {
      return undefined
    }
    // A files token in full is a root, a declaration and a digest, ~200
    // characters per node, joined and hashed again: 2 MB of token at 8,002
    // tasks (2026-11-07). Each distinct one is hashed once instead, and the
    // node names that hash, which is also what the delta compares.
    let files = ''
    if (inputs !== undefined) {
      if ((inputs.workspaceFiles?.length ?? 0) > 0) return undefined
      // No positive entry resolves no files (`filesPlan`).
      if (inputs.files === undefined || inputs.files.some((e) => !e.startsWith('!'))) {
        const declared = declarationOf(cfg)
        let byDeclared = tokens.get(node.projectName)
        if (byDeclared === undefined) tokens.set(node.projectName, (byDeclared = new Map()))
        let token = byDeclared.get(declared)
        if (token === undefined) {
          const full = taskFilesToken({
            node,
            workspaceRoot: args.workspaceRoot,
            nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
            gitFilesCache: args.gitFilesCache,
          })
          if (full === undefined) return undefined
          token = xxh3hex(full)
          byDeclared.set(declared, token)
        }
        files = token
      }
      for (const name of inputs.env ?? []) envNames.add(name)
    }
    ids.push(node.id)
    if (graph !== undefined) {
      parts.push(node.id, node.requested ? '1' : '0', node.platform ?? '')
      filesAt.push(parts.push(files) - 1)
      continue
    }
    parts.push(
      node.id,
      node.projectName,
      node.projectDir,
      node.deps.join('\u0001'),
      (node.orderOnly ?? []).join('\u0001'),
      node.requested ? '1' : '0',
      hashTaskConfig(cfg, args.hashCache),
      JSON.stringify(node.keyParts ?? []),
      node.platform ?? '',
      JSON.stringify(node.addsToOutputsOf ?? []),
      JSON.stringify(node.outputsAddedToBy ?? []),
      files,
    )
  }
  for (const name of [...envNames].sort()) {
    const value = process.env[name]
    parts.push(value === undefined ? name : `${name}=${value}`)
  }
  const selection = xxh3hex(ids.join('\0'))
  const at: RunKeysAt = { id: `\0run\0${selection}`, token: xxh3hex(parts.join('\0')) }
  if (graph !== undefined) {
    let delta: { global: string; files: Map<string, string> } | undefined
    at.delta = () => {
      if (delta !== undefined) return delta
      const files = new Map<string, string>()
      const rest = [...parts]
      filesAt.forEach((i, n) => {
        files.set(ids[n]!, parts[i]!)
        rest[i] = ''
      })
      return (delta = { global: `${selection}\0${xxh3hex(rest.join('\0'))}`, files })
    }
  }
  return at
}

/**
 * A memo row: each stable and uncached key with its node's place in the
 * run's node order. The token names every node id in that order, so a row
 * read under it means the same nodes; by id, the row's JSON and a lookup
 * per node were ~5 ms of 8,002 (2026-11-07).
 */
interface KeysRow {
  /** Stable keys: node places, and their keys alike. */
  s: number[]
  h: string[]
  /** Uncached keys: node places, and their keys alike. */
  u: number[]
  k: string[]
}

/** The keys remembered under `token`, mapped back onto this run's nodes. */
export function readRunKeys(
  args: RunKeysArgs,
  at: { id: string; token: string },
): RunKeys | undefined {
  const row = args.hashCache.folds?.get(at.id, at.token)
  if (row === undefined) return undefined
  let parsed: KeysRow
  try {
    parsed = JSON.parse(row)
  } catch {
    return undefined
  }
  const { s, h, u, k } = parsed
  if (s?.length !== h?.length || u?.length !== k?.length) return undefined
  const nodes = [...args.nodes.values()]
  const stableKeys: StableKey[] = []
  for (let i = 0; i < s.length; i++) {
    const node = nodes[s[i]!]
    if (node === undefined) return undefined
    stableKeys.push({ hash: h[i]!, node })
  }
  const uncachedKeys = new Map<string, string>()
  for (let i = 0; i < u.length; i++) {
    const node = nodes[u[i]!]
    if (node === undefined) return undefined
    uncachedKeys.set(node.id, k[i]!)
  }
  return { stableKeys, uncachedKeys }
}

/**
 * What a run's derivation leaves for the next one to start from: every key
 * it made, in the order it made them, and which became stable or uncached
 * keys. Those verdicts are a function of the graph, the configs and what
 * git ignores, all in the global token, so a run under the same global
 * token keeps them and derives only the keys an edit reaches.
 */
export interface RunDerivation {
  keys: Map<string, string>
  stable: string[]
  uncached: string[]
}

interface DeltaRow {
  k: [string, string][]
  f: [string, string][]
  s: string[]
  u: string[]
}

const deltaId = (at: RunKeysAt): string => `\0rund\0${at.id.slice('\0run\0'.length)}`

/**
 * The last derivation under this run's global token, and the tasks whose
 * keys may have moved since: each one whose files token did, and every task
 * folding one of theirs. Undefined when no such derivation is remembered.
 */
export function readRunDelta(
  args: RunKeysArgs,
  at: RunKeysAt,
): { derivation: RunDerivation; dirty: Set<string> } | undefined {
  if (at.delta === undefined) return undefined
  const { global, files } = at.delta()
  const row = args.hashCache.folds?.get(deltaId(at), global)
  if (row === undefined) return undefined
  let parsed: DeltaRow
  try {
    parsed = JSON.parse(row)
  } catch {
    return undefined
  }
  const was = new Map(parsed.f)
  const dirty = new Set<string>()
  for (const [id, token] of files) if (was.get(id) !== token) dirty.add(id)
  const dependants = new Map<string, string[]>()
  for (const node of args.nodes.values()) {
    for (const dep of node.deps) {
      const list = dependants.get(dep)
      if (list === undefined) dependants.set(dep, [node.id])
      else list.push(node.id)
    }
  }
  const stack = [...dirty]
  while (stack.length > 0) {
    for (const up of dependants.get(stack.pop()!) ?? []) {
      if (dirty.has(up)) continue
      dirty.add(up)
      stack.push(up)
    }
  }
  return {
    derivation: { keys: new Map(parsed.k), stable: parsed.s, uncached: parsed.u },
    dirty,
  }
}

export function writeRunDelta(args: RunKeysArgs, at: RunKeysAt, derivation: RunDerivation): void {
  if (at.delta === undefined || args.hashCache.folds === undefined) return
  const { global, files } = at.delta()
  const row: DeltaRow = {
    k: [...derivation.keys],
    f: [...files],
    s: derivation.stable,
    u: derivation.uncached,
  }
  args.hashCache.folds.set(deltaId(at), global, JSON.stringify(row))
}

export function writeRunKeys(
  args: RunKeysArgs,
  at: { id: string; token: string },
  keys: RunKeys,
): void {
  if (args.hashCache.folds === undefined) return
  const place = new Map<string, number>()
  for (const id of args.nodes.keys()) place.set(id, place.size)
  const row: KeysRow = { s: [], h: [], u: [], k: [] }
  for (const key of keys.stableKeys) {
    const n = place.get(key.node.id)
    if (n === undefined) return
    row.s.push(n)
    row.h.push(key.hash)
  }
  for (const [id, key] of keys.uncachedKeys) {
    const n = place.get(id)
    if (n === undefined) return
    row.u.push(n)
    row.k.push(key)
  }
  args.hashCache.folds.set(at.id, at.token, JSON.stringify(row))
}

let identity: string | undefined

/**
 * The code that derives the keys: a compiled binary is its file; a source
 * checkout is every module under `src/`, so an edit to the derivation from
 * source never reads back a key the old code made.
 */
export function codeIdentity(): string {
  if (identity !== undefined) return identity
  // `Bun.main`, not `import.meta.dir`: `--minify` inlines the build
  // machine's source path, so an installed binary walked a `src/` that is
  // not there, threw, and lost every warm run's short circuit (2026-10-22).
  // ctime and inode with the mtime, as the file hash memo keys: an npm
  // tarball stamps every file 1985-10-26 and extraction keeps that mtime,
  // so an upgrade that kept a file's size left its stamp alone, and `cp
  // -p` does the same to a binary. No write can set ctime back.
  if (Bun.main.startsWith('/$bunfs/')) {
    const st = statSync(process.execPath)
    return (identity = `${process.execPath}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`)
  }
  const src = path.resolve(import.meta.dir, '..')
  const stamps: string[] = []
  for (const rel of readdirSync(src, { recursive: true, encoding: 'utf8' }).sort()) {
    if (!rel.endsWith('.ts')) continue
    const st = statSync(path.join(src, rel))
    stamps.push(`${rel}:${st.size}:${st.mtimeMs}:${st.ctimeMs}:${st.ino}`)
  }
  return (identity = xxh3hex(stamps.join('\0')))
}
