// A config can leave a timer that holds the event loop. vx set its exit
// code and waited for the loop to drain, so it printed its verdict and
// hung for good; it now exits once main has settled and both streams have
// ended. `vx lock` is the one verb that evaluates a config.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
/** Far past a `vx lock` (~0.1 s); reached only by the hang. */
const HANG_MS = 8_000

let root: string
beforeEach(async () => {
  // Canonical: macOS's tmpdir is a symlink to /private, and vx names the
  // config by its real path.
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-exit-held-')))
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), '{"name":"a"}')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function lock(config: string, env: Record<string, string> = {}) {
  const file = path.join(root, 'packages', 'a', 'vx.config.mjs')
  await writeFile(file, config)
  const proc = Bun.spawn([process.execPath, BIN, 'lock'], {
    cwd: root,
    env: { ...process.env, VX_LOCK_REVIEW_FILES: 'false', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const killer = setTimeout(() => proc.kill('SIGKILL'), HANG_MS)
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  clearTimeout(killer)
  return { code, out, err, file }
}

it(
  'a config holding a timer: `vx lock` prints in full and exits 0',
  async () => {
    const r = await lock(
      "setInterval(() => {}, 1000)\nexport default { tasks: { build: { exec: { command: 'true' } } } }\n",
    )
    expect({ code: r.code, out: r.out, err: r.err }).toEqual({
      code: 0,
      out: 'vx lock: locked 1 project config → .vx/projects.lock.json\n',
      err: '',
    })
  },
  HANG_MS + 5_000,
)

it(
  'an await that never settles under a timer fails at the budget and exits (D-66)',
  async () => {
    const r = await lock(
      'await new Promise(() => { setInterval(() => {}, 1000) })\nexport default {}\n',
      { VX_CONFIG_WORKER_TIMEOUT: '300ms' },
    )
    expect({ code: r.code, out: r.out, err: r.err }).toEqual({
      code: 1,
      out: '',
      err: `vx lock: .vx/projects.lock.json not written: Project config ${r.file} did not finish evaluating within 300ms (VX_CONFIG_WORKER_TIMEOUT)\n`,
    })
  },
  HANG_MS + 5_000,
)
