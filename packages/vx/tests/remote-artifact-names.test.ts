// Items 942 and 943: a remote artifact is bytes off the network, and the restore
// materialised whatever names it carried. An artifact naming an input and a
// git hook overwrote the one and planted the other under a green
// `cache-hit-remote`; one holding `out.txt` as a file AND a directory failed
// the run, and every run after it from the local copy, blaming the tree.
// Both are refused at ingest now, so the read is a miss and the task runs.
import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it, spyOn } from 'bun:test'
import { addProject, makeWorkspace, silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { packArtifactBytes, planArtifact } from '../src/cache/archive.js'
import type { CacheGetContext } from '../src/cache/cache.js'
import { LayeredCache, type RemoteCacheLayer } from '../src/cache/index.js'
import { run } from '../src/orchestrator/index.js'

const CFG = `export default { tasks: { build: {
  exec: { command: 'echo built > out.txt' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } } } } }`

/** Source files for an artifact's entries, written once under `dir`. */
async function sources(dir: string, entries: Record<string, string>): Promise<Map<string, string>> {
  const outputs = new Map<string, string>()
  let n = 0
  for (const [name, content] of Object.entries(entries)) {
    const file = path.join(dir, `.entry-${n++}`)
    await writeFile(file, content)
    outputs.set(name, file)
  }
  return outputs
}

/** A remote that answers every key with an artifact of `entries`, packed under that key. */
const serving = async (dir: string, entries: Record<string, string>): Promise<RemoteCacheLayer> => {
  const outputs = await sources(dir, entries)
  return {
    endpoint: 'mem://test',
    async has() {
      return true
    },
    async get(hash: string) {
      const tar = await packArtifactBytes(
        await planArtifact({ key: hash, stdout: 'hi\n', outputs }),
      )
      return { body: new Blob([Bun.zstdCompressSync(tar)]), durationMs: 1 }
    },
    async put() {},
  }
}

describe('a remote artifact names only what its task declares', () => {
  it(
    'one naming an input, a git hook or another project is a miss, and writes none of them',
    async () => {
      const fx = await makeWorkspace('vx-names-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const remote = await serving(fx.root, {
          'outputs/out.txt': 'remote\n',
          'outputs/src/in.txt': 'OVERWRITTEN',
          'workspace-outputs/.git/hooks/post-commit': '#!/bin/sh\n',
          'workspace-outputs/packages/other/file.txt': 'foreign',
        })
        const r = await run({
          cwd: fx.root,
          tasks: ['build'],
          log: silentLogger(fx),
          remoteCache: remote,
        })
        const app = path.join(fx.root, 'packages', 'app')
        expect({
          statuses: r.outcomes.map((o) => o.status),
          out: await readFile(path.join(app, 'out.txt'), 'utf8'),
          input: await readFile(path.join(app, 'src', 'in.txt'), 'utf8'),
          hook: existsSync(path.join(fx.root, '.git', 'hooks', 'post-commit')),
          other: existsSync(path.join(fx.root, 'packages', 'other', 'file.txt')),
          said: fx.log.some((l) => l.includes("not one of the task's declared outputs")),
        }).toEqual({
          statuses: ['success'],
          out: 'built\n',
          input: 'v1',
          hook: false,
          other: false,
          said: true,
        })
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  // The row above mixes both halves, so either half alone masked the other
  // (A-34): each is refused on its own here.
  it.each([
    ['a project output', 'outputs/src/in.txt', 'packages/app/src/in.txt'],
    ['a workspace output', 'workspace-outputs/packages/other/file.txt', 'packages/other/file.txt'],
  ] as const)(
    'one naming only an undeclared %s is a miss, and writes nothing there',
    async (_label, name, landed) => {
      const fx = await makeWorkspace('vx-names-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const remote = await serving(fx.root, { 'outputs/out.txt': 'remote\n', [name]: 'FOREIGN' })
        const r = await run({
          cwd: fx.root,
          tasks: ['build'],
          log: silentLogger(fx),
          remoteCache: remote,
        })
        const at = path.join(fx.root, landed)
        expect({
          statuses: r.outcomes.map((o) => o.status),
          landed: existsSync(at) ? await readFile(at, 'utf8') : null,
        }).toEqual({
          statuses: ['success'],
          landed: landed.endsWith('in.txt') ? 'v1' : null,
        })
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'one holding a file as a directory too is a miss, and the next run without it is a local hit',
    async () => {
      const fx = await makeWorkspace('vx-names-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const remote = await serving(fx.root, {
          'outputs/out.txt': 'remote\n',
          'outputs/out.txt/x': 'nested',
        })
        const log = silentLogger(fx)
        const first = await run({
          cwd: fx.root,
          tasks: ['build'],
          log,
          remoteCache: remote,
        })
        const second = await run({ cwd: fx.root, tasks: ['build'], log })
        expect([first.outcomes.map((o) => o.status), second.outcomes.map((o) => o.status)]).toEqual(
          [['success'], ['cache-hit']],
        )
        expect(await readFile(path.join(fx.root, 'packages', 'app', 'out.txt'), 'utf8')).toBe(
          'built\n',
        )
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'CONTROL: one naming only the declared output is a remote hit',
    async () => {
      const fx = await makeWorkspace('vx-names-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const remote = await serving(fx.root, { 'outputs/out.txt': 'remote\n' })
        const r = await run({
          cwd: fx.root,
          tasks: ['build'],
          log: silentLogger(fx),
          remoteCache: remote,
        })
        expect(r.outcomes.map((o) => o.status)).toEqual(['cache-hit-remote'])
        expect(await readFile(path.join(fx.root, 'packages', 'app', 'out.txt'), 'utf8')).toBe(
          'remote\n',
        )
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'every lookup a run makes tells the cache the task’s declared outputs',
    async () => {
      // Two sites ask a remote: the prefetch and the task's own lookup.
      // The rows above reach only the first (it ingests before the second
      // asks), so both are held here. (The up-front short-circuit probe
      // runs only with no remote layer, where the context goes unread.)
      const fx = await makeWorkspace('vx-names-')
      const seen: Array<[string, CacheGetContext | undefined]> = []
      const get = spyOn(LayeredCache.prototype, 'get')
      const prefetch = spyOn(LayeredCache.prototype, 'prefetch')
      try {
        get.mockImplementation(async (_h: string, ctx?: CacheGetContext) => {
          seen.push(['get', ctx])
          return null
        })
        prefetch.mockImplementation(async (_h: string, ctx?: CacheGetContext) => {
          seen.push(['prefetch', ctx])
          return false
        })
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const remote = await serving(fx.root, { 'outputs/out.txt': 'remote\n' })
        await run({
          cwd: fx.root,
          tasks: ['build'],
          log: silentLogger(fx),
          remoteCache: remote,
        })
      } finally {
        get.mockRestore()
        prefetch.mockRestore()
        await rm(fx.root, { recursive: true, force: true })
      }
      expect(seen.map(([site]) => site).sort()).toEqual(['get', 'prefetch'])
      for (const [, ctx] of seen) {
        expect(ctx?.outputs).toEqual({ files: ['out.txt'], workspaceFiles: [] })
      }
    },
    TIMEOUT,
  )

  // Item 943: nothing tied an artifact to its key, so a layer that
  // answered one key with another's bytes replayed the other task's
  // outputs under a green `cache-hit-remote`.
  it.each([
    ['another key', 'f'.repeat(16)],
    ['no key', undefined],
  ] as const)(
    'one packed under %s is a miss, and its bytes are not restored',
    async (_label, key) => {
      const fx = await makeWorkspace('vx-names-')
      try {
        await addProject(fx.root, 'app', { files: { 'src/in.txt': 'v1' }, config: CFG })
        const outputs = await sources(fx.root, { 'outputs/out.txt': 'from-A\n' })
        const tar = await packArtifactBytes(
          await planArtifact({ ...(key === undefined ? {} : { key }), stdout: 'hi\n', outputs }),
        )
        const remote: RemoteCacheLayer = {
          endpoint: 'mem://test',
          async has() {
            return true
          },
          async get() {
            return { body: new Blob([Bun.zstdCompressSync(tar)]), durationMs: 1 }
          },
          async put() {},
        }
        const r = await run({
          cwd: fx.root,
          tasks: ['build'],
          log: silentLogger(fx),
          remoteCache: remote,
        })
        expect({
          statuses: r.outcomes.map((o) => o.status),
          out: await readFile(path.join(fx.root, 'packages', 'app', 'out.txt'), 'utf8'),
        }).toEqual({ statuses: ['success'], out: 'built\n' })
      } finally {
        await rm(fx.root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
