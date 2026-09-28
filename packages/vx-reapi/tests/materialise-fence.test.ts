// A hostile or broken REAPI server's ActionResult never writes outside the
// workspace (L-2): its paths and Tree names were joined as given, links it
// placed were followed, and its setuid bits were kept.

import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { materialiseOutputs } from '../src/executor.js'
import { encodeDirectory, encodeTree, sha256 } from '../src/merkle.js'
import type { Directory } from '../src/wire.js'

const enc = new TextEncoder()
let top: string
let ws: string
let cwd: string
let outside: string
const have = new Map<string, Uint8Array>()

const client = {
  batchReadBlobs: async (ds: { hash: string }[]) => {
    const out = new Map<string, Uint8Array>()
    for (const d of ds) if (have.has(d.hash)) out.set(d.hash, have.get(d.hash)!)
    return out
  },
  readBlob: async (d: { hash: string }) => have.get(d.hash) ?? null,
  digest: 'SHA256',
} as unknown as Parameters<typeof materialiseOutputs>[0]

const blob = (s: string) => {
  const b = enc.encode(s)
  const d = sha256(b)
  have.set(d.hash, b)
  return d
}
const tree = (root: Directory, children: Directory[] = []) => {
  const bytes = encodeTree(root, children)
  const d = sha256(bytes)
  have.set(d.hash, bytes)
  return d
}
const req = () =>
  ({
    taskId: 'pkg#build',
    cwd,
    workspaceRoot: ws,
    outputs: { files: ['**'], workspaceFiles: [] },
  }) as unknown as Parameters<typeof materialiseOutputs>[1]
const run = (result: object) =>
  materialiseOutputs(client, req(), result, () => undefined).then(
    () => 'written',
    (e: Error) => e.message,
  )
const refused = (what: string) =>
  `vx/reapi: the server returned an output outside the workspace (${what}) — refused; nothing is written outside ${ws}`

beforeEach(async () => {
  top = await realpath(await mkdtemp(path.join(tmpdir(), 'vx-fence-')))
  ws = path.join(top, 'ws')
  cwd = path.join(ws, 'pkg')
  outside = path.join(top, 'outside')
  await mkdir(cwd, { recursive: true })
  await mkdir(outside)
  await writeFile(path.join(outside, 'victim'), 'mine')
})
afterEach(async () => {
  have.clear()
  await rm(top, { recursive: true, force: true })
})

const untouched = async () => ({
  victim: await readFile(path.join(outside, 'victim'), 'utf8'),
  outside: (await Array.fromAsync(new Bun.Glob('**').scan({ cwd: outside, dot: true }))).sort(),
})

describe('materialiseOutputs refuses what lands outside the workspace (L-2)', () => {
  it('an output file path that climbs out', async () => {
    const r = await run({ output_files: [{ path: '../../outside/victim', digest: blob('pwned') }] })
    expect(r).toBe(refused('../../outside/victim'))
    expect(await untouched()).toEqual({ victim: 'mine', outside: ['victim'] })
  })

  it('an absolute output path', async () => {
    const abs = path.join(outside, 'new')
    const r = await run({ output_files: [{ path: abs, digest: blob('pwned') }] })
    expect(r).toBe(refused(abs))
    expect(await untouched()).toEqual({ victim: 'mine', outside: ['victim'] })
  })

  it('a path holding a NUL is refused, not a raw file-system error', async () => {
    const r = await run({ output_files: [{ path: 'out\0.txt', digest: blob('x') }] })
    expect(r).toBe(refused('out\0.txt'))
  })

  it('a Tree name of `..`', async () => {
    const up: Directory = {
      files: [{ name: 'new', digest: blob('pwned'), is_executable: false }],
      directories: [],
      symlinks: [],
    }
    const upDigest = sha256(encodeDirectory(up))
    const root: Directory = {
      files: [],
      directories: [{ name: '..', digest: upDigest }],
      symlinks: [],
    }
    // dist/.. is pkg; pkg/../.. would be outside: two levels of `..`.
    const mid: Directory = {
      files: [],
      directories: [{ name: '..', digest: upDigest }],
      symlinks: [],
    }
    const midDigest = sha256(encodeDirectory(mid))
    const d = tree({ ...root, directories: [{ name: '..', digest: midDigest }] }, [mid, up])
    const r = await run({ output_directories: [{ path: 'dist', tree_digest: d }] })
    expect(r).toBe(refused(path.join(cwd, 'dist', '..')))
    expect(await untouched()).toEqual({ victim: 'mine', outside: ['victim'] })
    expect(await Bun.file(path.join(ws, 'new')).exists()).toBe(false)
  })

  it('a link the result places, then a directory written through it', async () => {
    const inner: Directory = {
      files: [{ name: 'new', digest: blob('pwned'), is_executable: false }],
      directories: [],
      symlinks: [],
    }
    const d = tree(inner)
    const r = await run({
      output_symlinks: [{ path: 'a', target: '../../outside' }],
      output_directories: [{ path: 'a', tree_digest: d }],
    })
    expect(r).toBe(refused(`${path.join(cwd, 'a')} -> ../../outside`))
    expect(await untouched()).toEqual({ victim: 'mine', outside: ['victim'] })
  })

  it('a link already in the tree that leads out: a directory is not written through it', async () => {
    await symlink(outside, path.join(cwd, 'dist'))
    const r = await run({ output_files: [{ path: 'dist/new', digest: blob('pwned') }] })
    expect(r).toBe(refused(path.join(cwd, 'dist')))
    expect(await untouched()).toEqual({ victim: 'mine', outside: ['victim'] })
  })

  // F-47: each target was judged as text, but the OS follows the links the
  // result already placed: `x -> ..` then `y -> x/../../outside` reads
  // as `pkg/outside` and leads to `<top>/outside`. Either order.
  it('a link that leads out through another link the result placed', async () => {
    const escape = { path: 'd/y', target: 'x/../../outside' }
    const via = { path: 'd/x', target: '..' }
    const placed = async () =>
      lstat(path.join(cwd, 'd', 'y')).then(
        () => true,
        () => false,
      )
    for (const output_symlinks of [
      [via, escape],
      [escape, via],
    ]) {
      const r = await run({ output_symlinks })
      expect([r, await placed()]).toEqual([
        refused(`${path.join(cwd, 'd', 'y')} -> x/../../outside`),
        false,
      ])
      await rm(path.join(cwd, 'd'), { recursive: true, force: true })
    }
    const d = tree({
      files: [],
      directories: [],
      symlinks: [
        { name: 'x', target: '..' },
        { name: 'y', target: 'x/../../outside' },
      ],
    })
    const r = await run({ output_directories: [{ path: 'd', tree_digest: d }] })
    expect([r, await placed()]).toEqual([
      refused(`${path.join(cwd, 'd', 'y')} -> x/../../outside`),
      false,
    ])
    expect(await untouched()).toEqual({ victim: 'mine', outside: ['victim'] })
  })

  // F-57: what a sweep of verifyLinks/resolveThrough left unheld.
  it('an absolute target, a sibling sharing the root as a prefix, and three- and four-link chains lead out', async () => {
    const via = { path: 'd/x', target: '..' }
    const cases = [
      [via, { path: 'd/y', target: `${cwd}/d/x/../../outside` }],
      [via, { path: 'd/y', target: 'x/../../ws-evil' }],
      [
        { path: 'd/a', target: '..' },
        { path: 'd/b', target: 'a/..' },
        { path: 'd/y', target: 'b/../outside' },
      ],
      [
        { path: 'd/a', target: '..' },
        { path: 'd/b', target: 'a/..' },
        { path: 'd/c', target: 'b' },
        { path: 'd/y', target: 'c/../outside' },
      ],
    ]
    const got: string[] = []
    for (const output_symlinks of cases) {
      got.push(await run({ output_symlinks }))
      await rm(path.join(cwd, 'd'), { recursive: true, force: true })
    }
    expect(got).toEqual(
      cases.map((c) => refused(`${path.join(cwd, 'd', 'y')} -> ${c[c.length - 1]!.target}`)),
    )
    expect(await untouched()).toEqual({ victim: 'mine', outside: ['victim'] })
  })

  it('CONTROL: a link to the root itself, and inside links under a root reached through a link, are written', async () => {
    expect(await run({ output_symlinks: [{ path: 'r', target: '..' }] })).toBe('written')
    const alias = path.join(top, 'alias')
    await symlink(top, alias)
    const viaAlias = {
      taskId: 'pkg#build',
      cwd: path.join(alias, 'ws', 'pkg'),
      workspaceRoot: path.join(alias, 'ws'),
      outputs: { files: ['**'], workspaceFiles: [] },
    } as unknown as Parameters<typeof materialiseOutputs>[1]
    const r = await materialiseOutputs(
      client,
      viaAlias,
      { output_symlinks: [{ path: 'current', target: 'r' }] },
      () => undefined,
    ).then(
      () => 'written',
      (e: Error) => e.message,
    )
    expect(r).toBe('written')
  })

  it('a link standing at an output file is replaced, never written through', async () => {
    await symlink(path.join(outside, 'victim'), path.join(cwd, 'out.txt'))
    const r = await run({ output_files: [{ path: 'out.txt', digest: blob('built') }] })
    expect(r).toBe('written')
    expect(await untouched()).toEqual({ victim: 'mine', outside: ['victim'] })
    expect((await lstat(path.join(cwd, 'out.txt'))).isFile()).toBe(true)
    expect(await readFile(path.join(cwd, 'out.txt'), 'utf8')).toBe('built')
  })

  it("a Tree file's setuid and setgid bits are dropped", async () => {
    const d = tree({
      files: [
        {
          name: 'tool',
          digest: blob('#!/bin/sh\n'),
          is_executable: true,
          node_properties: { unixMode: 0o6755 },
        },
      ],
      directories: [],
      symlinks: [],
    })
    expect(await run({ output_directories: [{ path: 'bin', tree_digest: d }] })).toBe('written')
    expect((await stat(path.join(cwd, 'bin', 'tool'))).mode & 0o7777).toBe(0o755)
  })

  it('CONTROL: links and files that stay inside are written', async () => {
    const lib: Directory = {
      files: [{ name: 'x.js', digest: blob('x'), is_executable: false }],
      directories: [],
      symlinks: [],
    }
    const d = tree(
      {
        files: [],
        directories: [{ name: 'lib', digest: sha256(encodeDirectory(lib)) }],
        symlinks: [{ name: 'shared', target: '../../shared' }],
      },
      [lib],
    )
    const r = await run({
      output_files: [{ path: '../root-out.txt', digest: blob('root') }],
      output_symlinks: [{ path: 'current', target: 'dist/lib' }],
      output_directories: [{ path: 'dist', tree_digest: d }],
    })
    expect(r).toBe('written')
    expect({
      root: await readFile(path.join(ws, 'root-out.txt'), 'utf8'),
      lib: await readFile(path.join(cwd, 'current', 'x.js'), 'utf8'),
      shared: await readlink(path.join(cwd, 'dist', 'shared')),
    }).toEqual({ root: 'root', lib: 'x', shared: '../../shared' })
  })
})
