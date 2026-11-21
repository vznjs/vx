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
beforeAll(async () => {
  if (linux) base = await floor()
}, TIMEOUT)

describe.skipIf(!linux)('vx peak memory over big outputs', () => {
  it(
    '600 MiB of outputs save, restore and come back through a remote in bounded memory',
    async () => {
      // Half random, half zeros: measured +45 MiB saving, at the floor
      // restoring locally, +37 pulling from the remote.
      const store = scratch(path.join(os.tmpdir(), `vx-mem-remote-${process.pid}`))
      await mkdir(store, { recursive: true })
      const at = (h: string) => `${JSON.stringify(store)} + '/' + ${h}`
      const remote = pluginSource(
        'test/file-remote',
        `{ cache: () => ({
        endpoint: ${JSON.stringify(store)},
        async has(h) { const f = Bun.file(${at('h')}); return (await f.exists()) ? { size: f.size } : null },
        async get(h) { const f = Bun.file(${at('h')}); return (await f.exists()) ? { body: new Response(f.stream()), durationMs: 1 } : null },
        async put(h, body) { await Bun.write(${at('h')}, body) },
      }) }`,
      )
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
