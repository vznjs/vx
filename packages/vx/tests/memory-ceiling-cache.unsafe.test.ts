// Peak memory of a vx run saving and restoring big outputs, locally and
// through a remote (harness: tests/helpers/memory-ceiling.ts). The remote
// is a test plugin over a directory that streams both ways, so what is
// measured is core's tar and zstd, not the wire's.

import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { beforeAll, describe, expect, it } from 'bun:test'
import { pluginSource } from './helpers/plugin.js'
import { floor, linux, MIB, run, scratch, TIMEOUT, workspace } from './helpers/memory-ceiling.js'

let base = 0

/** A directory the remote plugin below stores in. */
async function fileStore(): Promise<string> {
  const store = scratch(path.join(os.tmpdir(), `vx-mem-remote-${process.pid}-${Math.random()}`))
  await mkdir(store, { recursive: true })
  return store
}

/** A remote over `store` that streams both ways. */
function fileRemote(store: string): string {
  const at = (h: string) => `${JSON.stringify(store)} + '/' + ${h}`
  return pluginSource(
    'test/file-remote',
    `{ cache: () => ({
        endpoint: ${JSON.stringify(store)},
        async has(h) { const f = Bun.file(${at('h')}); return (await f.exists()) ? { size: f.size } : null },
        async get(h) { const f = Bun.file(${at('h')}); return (await f.exists()) ? { body: new Response(f.stream()), durationMs: 1 } : null },
        async put(h, body) { await Bun.write(${at('h')}, body) },
      }) }`,
  )
}
beforeAll(async () => {
  if (linux) base = await floor()
}, TIMEOUT)

describe.skipIf(!linux)('vx peak memory over big outputs', () => {
  it(
    '600 MiB of outputs save, restore and come back through a remote in bounded memory',
    async () => {
      // Half random, half zeros: measured +45 MiB saving, at the floor
      // restoring locally, +37 pulling from the remote.
      const store = await fileStore()
      const remote = fileRemote(store)
      const command = `mkdir -p dist && head -c ${300 * MIB} /dev/urandom > dist/r.bin && head -c ${300 * MIB} /dev/zero > dist/z.bin`
      const root = await workspace(
        {
          a: `export default { tasks: { out: { exec: { command: ${JSON.stringify(command)} }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
        },
        { plugins: [remote] },
      )
      const dist = path.join(root, 'packages', 'a', 'dist')
      const save = await run(root, ['a#out', '--cache-policy=local:rw,remote:rw'])
      expect(await readdir(store)).toHaveLength(1)

      await rm(dist, { recursive: true })
      const restore = await run(root, ['a#out'])
      expect((await stat(path.join(dist, 'r.bin'))).size).toBe(300 * MIB)

      await rm(dist, { recursive: true })
      const pull = await run(root, ['a#out', '--cache-dir', path.join(root, 'fresh-cache')])
      expect(pull.out).toContain('restored-remote')
      expect((await stat(path.join(dist, 'z.bin'))).size).toBe(300 * MIB)

      expect(save.peak - base).toBeLessThan(160)
      expect(restore.peak - base).toBeLessThan(160)
      expect(pull.peak - base).toBeLessThan(160)
    },
    TIMEOUT,
  )
})

describe.skipIf(!linux)('vx peak memory over big inputs', () => {
  it(
    '600 MiB of inputs git holds no OID for hash in bounded memory',
    async () => {
      // Four 150 MiB inputs a fresh clone's git vouches no OID for (untracked
      // here; LFS and other filtered files are the same path): each was read
      // whole and all at once, ~650 MiB over the floor, before a byte was hashed.
      const root = await workspace({
        a: `export default { tasks: { out: { exec: { command: 'mkdir -p dist && ls src > dist/l' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
      })
      const src = path.join(root, 'packages', 'a', 'src')
      for (const n of [1, 2, 3, 4])
        Bun.spawnSync([
          'sh',
          '-c',
          `head -c ${150 * MIB} /dev/urandom > ${JSON.stringify(path.join(src, `big${n}.bin`))}`,
        ])
      const miss = await run(root, ['a#out'])
      expect(miss.out).toContain('a#out')
      expect(miss.peak - base).toBeLessThan(160)
    },
    TIMEOUT,
  )
})

describe.skipIf(!linux)('vx peak memory keeping a failed run', () => {
  it(
    "600 MiB of a failed task's outputs reach the remote in bounded memory",
    async () => {
      const store = await fileStore()
      const command = `mkdir -p dist && head -c ${300 * MIB} /dev/urandom > dist/r.bin && head -c ${300 * MIB} /dev/zero > dist/z.bin && exit 1`
      const root = await workspace(
        {
          a: `export default { tasks: { out: { exec: { command: ${JSON.stringify(command)} }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
        },
        { plugins: [fileRemote(store)], fields: "cache: { upload: { failures: 'always' } }" },
      )
      const failed = await run(root, ['a#out', '--cache-policy=local:rw,remote:rw'], 1)
      const kept = await readdir(store)
      expect(kept).toHaveLength(1)
      const tar = path.join(store, kept[0]!)
      // a header per file, then the end marker
      expect((await stat(tar)).size).toBe(600 * MIB + 2 * 512 + 1024)
      const list = Bun.spawnSync(['tar', '-tvf', tar]).stdout.toString()
      expect(list).toContain('packages/a/dist/r.bin')
      expect(list).toContain(`${300 * MIB} `)
      expect(failed.peak - base).toBeLessThan(160)
    },
    TIMEOUT,
  )
})
