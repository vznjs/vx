// What travels between the orchestrator and an agent besides orders: a
// task's result (its streams and the files its outputs left) and the files
// its dependencies made elsewhere. One zstd frame: a JSON head, then
// `[u32 path][path][u8 kind][u32 mode][u32 size][bytes]` per file. Relay
// bodies are JSON of at most 1 MiB, so a bundle rides as base64 parts.

import { lstat, mkdir, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { restorableOutput } from '@vzn/vx'

const FILE = 0
const LINK = 1
/** Raw bytes per part: base64 makes 4/3 of it, under the relay's 1 MiB. */
const PART_BYTES = 640 * 1024

export async function pack(
  root: string,
  files: readonly string[],
  head: unknown,
): Promise<Uint8Array> {
  const enc = new TextEncoder()
  const pieces: Uint8Array[] = []
  const u32 = (n: number): Uint8Array => {
    const b = new Uint8Array(4)
    new DataView(b.buffer).setUint32(0, n)
    return b
  }
  const headBytes = enc.encode(JSON.stringify(head))
  pieces.push(u32(headBytes.length), headBytes)
  for (const rel of files) {
    const abs = path.join(root, rel)
    let st
    try {
      st = await lstat(abs)
    } catch {
      continue
    }
    const kind = st.isSymbolicLink() ? LINK : st.isFile() ? FILE : -1
    if (kind < 0) continue
    const bytes =
      kind === LINK
        ? enc.encode(await readlink(abs))
        : new Uint8Array(await Bun.file(abs).arrayBuffer())
    const name = enc.encode(rel)
    pieces.push(
      u32(name.length),
      name,
      new Uint8Array([kind]),
      u32(st.mode & 0o777),
      u32(bytes.length),
      bytes,
    )
  }
  return Bun.zstdCompress(Buffer.concat(pieces))
}

/** Writes the bundle's files under `root` and answers its head. */
export async function unpack(root: string, bundle: Uint8Array): Promise<unknown> {
  const raw = await Bun.zstdDecompress(bundle)
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength)
  const dec = new TextDecoder()
  let at = 0
  const u32 = (): number => {
    const n = view.getUint32(at)
    at += 4
    return n
  }
  const take = (n: number): Uint8Array => {
    if (at + n > raw.length) throw new Error('truncated bundle')
    const b = raw.subarray(at, at + n)
    at += n
    return b
  }
  const head: unknown = JSON.parse(dec.decode(take(u32())))
  while (at < raw.length) {
    const rel = dec.decode(take(u32()))
    const kind = take(1)[0]
    const mode = u32()
    const bytes = take(u32())
    // The bundle came over the network: a path may not leave the root.
    if (path.isAbsolute(rel) || rel.split('/').includes('..')) throw new Error(`unsafe path ${rel}`)
    const abs = path.join(root, rel)
    await mkdir(path.dirname(abs), { recursive: true })
    await rm(abs, { force: true })
    if (kind === LINK) await symlink(dec.decode(bytes), abs)
    else await writeFile(abs, bytes, { mode })
  }
  return head
}

export function toParts(bundle: Uint8Array): string[] {
  const parts: string[] = []
  for (let i = 0; i < bundle.length || i === 0; i += PART_BYTES) {
    parts.push(Buffer.from(bundle.subarray(i, i + PART_BYTES)).toString('base64'))
  }
  return parts
}

export function fromParts(parts: readonly string[]): Uint8Array {
  return Buffer.concat(parts.map((p) => Buffer.from(p, 'base64')))
}

/**
 * The files declared outputs name, workspace-relative: `files` under the
 * project, `workspaceFiles` under the root. A `!` glob drops what it matches.
 */
export async function outputFiles(
  root: string,
  project: string,
  outputs: { readonly files: readonly string[]; readonly workspaceFiles: readonly string[] },
): Promise<string[]> {
  const found = new Set<string>()
  // Core's own matcher, so a glob means here what it means to a restore.
  const scan = async (base: string, globs: readonly string[], scope: 'project' | 'workspace') => {
    if (globs.length === 0) return
    const wanted = restorableOutput(globs, scope)
    const intoModules = globs.some((g) => g.includes('node_modules'))
    const walk = async (rel: string): Promise<void> => {
      const entries = await readdir(path.join(root, base, rel), { withFileTypes: true }).catch(
        () => [],
      )
      for (const e of entries) {
        const child = rel === '' ? e.name : `${rel}/${e.name}`
        if (e.isDirectory()) {
          if (e.name === '.git' || (e.name === 'node_modules' && !intoModules)) continue
          await walk(child)
        } else if ((e.isFile() || e.isSymbolicLink()) && wanted(child)) {
          found.add(base === '' ? child : `${base}/${child}`)
        }
      }
    }
    await walk('')
  }
  await scan(project, outputs.files, 'project')
  await scan('', outputs.workspaceFiles, 'workspace')
  return [...found].sort()
}
