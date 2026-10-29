// `vx run --cache-dir <path>` is where the run's cache lives, and every
// plugin stage that is told the cache dir is told that one, resolved as
// the run resolves it. The CLI's selection pass runs the `discover` and
// `project` stages before the run (which reuses them): `discover` was told
// the workspace's cache dir and `project` the flag's raw relative text.
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { gitInit } from './helpers/workspace.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'

const BIN = path.join(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-cache-dir-stages-')))
  gitInit(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(cwd: string, ...args: string[]): { code: number; err: string } {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: {
      ...process.env,
      NO_COLOR: '1',
      CI: '',
      GITHUB_ACTIONS: '',
      VX_LOCK_REVIEW_FILES: 'false',
    },
  })
  return { code: p.exitCode ?? 1, err: p.stderr.toString() }
}

it('every stage of a --cache-dir run is told the one resolved directory', async () => {
  const log = path.join(root, 'seen.log')
  const record = (stage: string): string =>
    `(ctx) => { require('node:fs').appendFileSync(${JSON.stringify(log)}, '${stage} ' + ctx.cacheDir + '\\n') }`
  await mkdir(path.join(root, '.vx'))
  await writeFile(
    path.join(root, '.vx/workspace.mjs'),
    `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
      'vx-test-seen',
      `{ discover(ctx) { (${record('discover')})(ctx); return [] }, project(_c, ctx) { (${record('project')})(ctx) } }`,
    )}] }\n`,
  )
  await mkdir(path.join(root, 'app'))
  await writeFile(
    path.join(root, 'app/vx.config.mjs'),
    "export default { tasks: { hello: { exec: { command: 'true' } } } }\n",
  )
  expect(vx(root, 'lock').code).toBe(0)
  // From the cwd's project, and through `--filter app...`, whose pass stages configs.
  for (const [cwd, args] of [
    ['app', []],
    ['.', ['--filter', 'app...']],
  ] as const) {
    await rm(log, { force: true })
    expect(vx(path.join(root, cwd), 'run', 'hello', ...args, '--cache-dir', 'here').code).toBe(0)
    const seen = new Set((await readFile(log, 'utf8')).trim().split('\n'))
    const dir = path.join(root, cwd, 'here')
    expect([...seen].sort()).toEqual([`discover ${dir}`, `project ${dir}`])
  }
}, 30_000)
