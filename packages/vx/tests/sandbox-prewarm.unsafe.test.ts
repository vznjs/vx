// The sandbox probe (~220 ms of spawns on Linux) starts when the run knows
// a sandboxed task will execute, not when the first one does: a task no
// cache can answer, or a confirmed miss, starts it under the classify and
// the upstream work (C-76). A run whose sandboxed tasks all hit still pays
// nothing. Unsafe: it runs a sandbox. A `bwrap` on PATH that marks a file
// tells when the probe ran; the upstream task waits for that mark.

import { chmod, mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { sandboxAvailable } from './helpers/sandbox-gate.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const available = await sandboxAvailable('sandbox prewarm test')
const bwrap = Bun.which('bwrap')

describe.skipIf(!available || process.platform !== 'linux' || bwrap === null)(
  'the sandbox probe starts before the first sandboxed task',
  () => {
    let root = ''
    let shims = ''
    let mark = ''
    beforeEach(async () => {
      root = realpathSync(await makeWorkspace({ prefix: 'vx-sb-prewarm-' }))
      shims = path.join(root, 'shims')
      mark = path.join(root, 'probed')
      await mkdir(shims)
      await writeFile(
        path.join(shims, 'bwrap'),
        `#!/bin/sh\n: > '${mark}'\n[ -e '${root}/slow' ] && sleep 2\nexec '${bwrap}' "$@"\n`,
      )
      await chmod(path.join(shims, 'bwrap'), 0o755)
    })
    afterEach(async () => {
      await rm(root, { recursive: true, force: true })
    })

    const vx = (...args: string[]) => {
      const r = Bun.spawnSync({
        cmd: [process.execPath, BIN, 'run', ...args],
        cwd: root,
        env: { ...process.env, PATH: `${shims}:${process.env['PATH'] ?? ''}`, CI: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      })
      // A timeout's kill reads exit 0 on spawnSync.
      expect(r.exitedDueToTimeout ?? false).toBe(false)
      return r
    }

    // `wait` passes only if the probe ran while it did: up to 10 s.
    const waitForMark = (): string =>
      `i=0; while [ ! -e '${mark}' ] && [ $i -lt 200 ]; do sleep 0.05; i=$((i+1)); done; [ -e '${mark}' ]`

    it('an uncached sandboxed task starts it while its upstream runs', async () => {
      await addProject(
        root,
        'app',
        `export default { tasks: {
          wait: { exec: { command: ${JSON.stringify(waitForMark())} } },
          check: { dependsOn: ['wait'], exec: { command: 'true', sandbox: {} } },
        } }`,
      )
      const r = vx('app#check')
      expect([r.exitCode, r.stdout.toString()]).toEqual([0, expect.stringContaining('app#check')])
    }, 60_000)

    it('a confirmed miss starts it while its upstream runs', async () => {
      await addProject(root, 'app', {
        config: `export default { tasks: {
          wait: {
            exec: { command: ${JSON.stringify(waitForMark())} },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
          },
          check: {
            dependsOn: ['wait'],
            exec: { command: 'true', sandbox: {} },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
          },
        } }`,
        files: { 'src/a.txt': 'a' },
      })
      const r = vx('app#check')
      expect([r.exitCode, r.stdout.toString()]).toEqual([0, expect.stringContaining('app#check')])
    }, 60_000)

    it('an embedder whose sure task is skipped is left with no runtime up', async () => {
      // A probe that outlives the run (slowed here past it) and lands after
      // the end's reset left the runtime's proxies up: an embedder (`vx
      // watch`, a caller of run()) never exits, and this one hung. The
      // CLI's failure exit hid it.
      await writeFile(path.join(root, 'slow'), '')
      await addProject(
        root,
        'app',
        `export default { tasks: {
          fail: { exec: { command: 'exit 1' } },
          check: { dependsOn: ['fail'], exec: { command: 'true', sandbox: {} } },
        } }`,
      )
      const embedder = path.join(root, 'embedder.ts')
      await writeFile(
        embedder,
        `import { run } from ${JSON.stringify(path.resolve(import.meta.dir, '..', 'src', 'orchestrator', 'index.ts'))}
const r = await run({ cwd: ${JSON.stringify(root)}, tasks: ['app#check'], handleSignals: false })
console.log('ok=' + r.ok)
`,
      )
      const r = Bun.spawnSync({
        cmd: [process.execPath, embedder],
        cwd: root,
        env: { ...process.env, PATH: `${shims}:${process.env['PATH'] ?? ''}`, CI: '1' },
        stdout: 'pipe',
        stderr: 'pipe',
        timeout: 30_000,
      })
      expect([
        r.exitedDueToTimeout ?? false,
        r.stdout.toString().trim().split('\n').at(-1),
        existsSync(mark),
      ]).toEqual([false, 'ok=false', true])
    }, 60_000)

    it('control: a run whose sandboxed task hits never probes', async () => {
      await addProject(root, 'app', {
        config: `export default { tasks: {
          check: {
            exec: { command: 'true', sandbox: {} },
            cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
          },
        } }`,
        files: { 'src/a.txt': 'a' },
      })
      // The positive first: the miss probes.
      expect(vx('app#check').exitCode).toBe(0)
      expect(existsSync(mark)).toBe(true)
      await rm(mark)
      const r = vx('app#check')
      expect([r.exitCode, existsSync(mark)]).toEqual([0, false])
    }, 60_000)
  },
)
