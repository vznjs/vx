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
import { hashTaskConfig, isKeyless, taskFilesToken, type HashCache } from './task-hash.js'

/** Moves every remembered run: bump it when what a token stands for changes. */
const RUN_MEMO_VERSION = 'run-memo-v1'

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

/**
 * The memo row's name (the selection) and the token its keys stand for, or
 * undefined when a node's key reads something the token cannot name.
 */
export function runKeysToken(args: RunKeysArgs): { id: string; token: string } | undefined {
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
  const tokens = new Map<string, string>()
  for (const node of args.nodes.values()) {
    const cfg = node.config
    if (isKeyless(cfg) || node.excludedUpstream !== undefined) return undefined
    const inputs = cfg.inputs
    if ((inputs?.runtime?.length ?? 0) > 0 || (inputs?.workspaceRuntime?.length ?? 0) > 0) {
      return undefined
    }
    let files = ''
    if (inputs !== undefined) {
      if ((inputs.workspaceFiles?.length ?? 0) > 0) return undefined
      // No positive entry resolves no files (`filesPlan`).
      if (inputs.files === undefined || inputs.files.some((e) => !e.startsWith('!'))) {
        const outputs = cfg.cache?.outputs
        const declared = `${node.projectName}\0${JSON.stringify([inputs.files, outputs?.files, outputs?.workspaceFiles])}`
        let token = tokens.get(declared)
        if (token === undefined) {
          token = taskFilesToken({
            node,
            workspaceRoot: args.workspaceRoot,
            nestedProjectDirs: args.nestedDirsByProject.get(node.projectName) ?? [],
            gitFilesCache: args.gitFilesCache,
            hashCache: args.hashCache,
          })
          if (token === undefined) return undefined
          tokens.set(declared, token)
        }
        files = token
      }
      for (const name of inputs.env ?? []) envNames.add(name)
    }
    ids.push(node.id)
    if (graph !== undefined) {
      parts.push(node.id, node.requested ? '1' : '0', node.platform ?? '', files)
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
  return { id: `\0run\0${xxh3hex(ids.join('\0'))}`, token: xxh3hex(parts.join('\0')) }
}

/** The keys remembered under `token`, mapped back onto this run's nodes. */
export function readRunKeys(
  args: RunKeysArgs,
  at: { id: string; token: string },
): RunKeys | undefined {
  const row = args.hashCache.folds?.get(at.id, at.token)
  if (row === undefined) return undefined
  let parsed: { s: [string, string][]; u: [string, string][] }
  try {
    parsed = JSON.parse(row)
  } catch {
    return undefined
  }
  const stableKeys: StableKey[] = []
  for (const [id, hash] of parsed.s) {
    const node = args.nodes.get(id)
    if (node === undefined) return undefined
    stableKeys.push({ hash, node })
  }
  return { stableKeys, uncachedKeys: new Map(parsed.u) }
}

export function writeRunKeys(
  args: RunKeysArgs,
  at: { id: string; token: string },
  keys: RunKeys,
): void {
  args.hashCache.folds?.set(
    at.id,
    at.token,
    JSON.stringify({
      s: keys.stableKeys.map((k) => [k.node.id, k.hash]),
      u: [...keys.uncachedKeys],
    }),
  )
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
  if (Bun.main.startsWith('/$bunfs/')) {
    const st = statSync(process.execPath)
    return (identity = `${process.execPath}:${st.size}:${st.mtimeMs}:${st.ino}`)
  }
  const src = path.resolve(import.meta.dir, '..')
  const stamps: string[] = []
  for (const rel of readdirSync(src, { recursive: true, encoding: 'utf8' }).sort()) {
    if (!rel.endsWith('.ts')) continue
    const st = statSync(path.join(src, rel))
    stamps.push(`${rel}:${st.size}:${st.mtimeMs}`)
  }
  return (identity = xxh3hex(stamps.join('\0')))
}
