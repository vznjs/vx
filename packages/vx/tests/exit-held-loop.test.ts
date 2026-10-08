// A config can leave a timer that holds the event loop. vx set its exit
// code and waited for the loop to drain, so it printed its verdict and
// hung for good; it now exits once main has settled and both streams have
// ended.

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
/** Far past a `vx show` (~0.1 s); reached only by the hang. */
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
  await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
  await writeFile(path.join(root, 'packages', 'a', 'package.json'), '{"name":"a"}')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function show(config: string, env: Record<string, string> = {}) {
  const file = path.join(root, 'packages', 'a', 'vx.config.mjs')
  await writeFile(file, config)
  const proc = Bun.spawn([process.execPath, BIN, 'show', 'a'], {
    cwd: root,
    env: { ...process.env, ...env },
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
  'a config holding a timer: `vx show` prints in full and exits 0',
  async () => {
    const r = await show(
      "setInterval(() => {}, 1000)\nexport default { tasks: { build: { exec: { command: 'true' } } } }\n",
    )
    expect({ code: r.code, out: r.out, err: r.err }).toEqual({
      code: 0,
      out: 'a — packages/a\n\nbuild\n  command: true\n',
      err: '',
    })
  },
  HANG_MS + 5_000,
)

it(
  'an await that never settles under a timer fails at the budget and exits (D-66)',
  async () => {
    const r = await show(
      'await new Promise(() => { setInterval(() => {}, 1000) })\nexport default {}\n',
      { VX_CONFIG_WORKER_TIMEOUT_MS: '300' },
    )
    expect({ code: r.code, out: r.out, err: r.err }).toEqual({
      code: 1,
      out: '',
      err: `vx: Project config ${r.file} did not finish evaluating within 300ms (VX_CONFIG_WORKER_TIMEOUT_MS)\n`,
    })
  },
  HANG_MS + 5_000,
)
