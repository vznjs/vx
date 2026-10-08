// The error a verb ends on is a plugin's failure (a remote's reply, a
// header it was sent) or a config's own throw: each is text vx did not
// write, and a secret in it reached stderr whole, as did `vx watch`'s
// `cycle failed` line (L-11).
import { mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { startWatch, until } from './helpers/watch-loop.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const SECRET = 'supersecretvalue123'
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const THROW = `throw new Error('reply token=' + process.env.API_TOKEN + ' id=' + process.env.REQ_ID)`
let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-cli-err-mask-' })
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function plugin(hooks: string): Promise<void> {
  await Bun.write(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource([pluginSource('org/p', hooks)]),
  )
}

const env = { API_TOKEN: SECRET, REQ_ID: 'plainrequest42', CI: '', GITHUB_ACTIONS: '' }
function stderr(args: string[]): string {
  const p = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return p.stderr.toString()
}

const SAID = 'reply token=*** id=plainrequest42'

it("a plugin's failure in setup, in a stage and in its verb is masked", async () => {
  await addProject(root, 'app', `export default { tasks: { t: { exec: { command: 'true' } } } }`)
  await plugin(`{ setup() { ${THROW} } }`)
  expect(stderr(['run', 't', '--all'])).toBe(`vx: plugin 'org/p' failed in setup: ${SAID}\n`)
  await plugin(`{ key() { ${THROW} } }`)
  expect(stderr(['run', 't', '--all'])).toBe(`vx: plugin 'org/p' failed in key: ${SAID}\n`)
  await plugin(`{ commands: { boom: { description: 'x', run() { ${THROW} } } } }`)
  expect(stderr(['boom'])).toBe(`vx: plugin 'org/p' failed in command 'boom': ${SAID}\n`)
}, 30_000)

it("a config's own throw is masked", async () => {
  await addProject(root, 'app', `${THROW}\n`)
  const err = stderr(['run', 't', '--all'])
  expect(err.split('\n').filter((l) => l.includes('reply'))).toEqual([`vx: Error: ${SAID}`])
}, 20_000)

it("vx info's config error row is masked", async () => {
  await addProject(root, 'app', `${THROW}\n`)
  const p = Bun.spawnSync([process.execPath, BIN, 'info', '--format', 'json'], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  expect((JSON.parse(p.stdout.toString()) as { configErrors: unknown }).configErrors).toEqual([
    { path: 'packages/app/vx.config.mjs', message: SAID },
  ])
}, 20_000)

it("vx watch's failed cycle is masked", async () => {
  const dir = path.join(root, 'packages', 'app')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'app' }))
  const cfg = path.join(dir, 'vx.config.mjs')
  await writeFile(cfg, `export default { tasks: { build: { exec: { command: 'true' } } } }\n`)
  const w = startWatch(root, ['--all'], env)
  try {
    await until(() => w.out().includes('vx watch: watching'), 'the watching marker')
    await writeFile(cfg, `${THROW}\n`)
    await until(() => w.err().includes('cycle failed'), 'the cycle that cannot load the config')
    expect(
      w
        .err()
        .split('\n')
        .filter((l) => l.includes('cycle failed')),
    ).toEqual([`vx watch: cycle failed: ${SAID}`])
  } finally {
    w.proc.kill('SIGTERM')
    await w.proc.exited
  }
}, 30_000)
