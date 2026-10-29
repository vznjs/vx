// The error a verb ends on is a plugin's failure (a remote's reply, a
// header it was sent) or a config's own throw: each is text vx did not
// write, and a secret in it reached stderr whole, as did `vx watch`'s
// `cycle failed` line (L-11).
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { pluginSource } from './helpers/plugin.js'
import { startWatch, until } from './helpers/watch-loop.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { noticed } from './helpers/notice.js'

const SECRET = 'supersecretvalue123'
const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const THROW = `throw new Error('reply token=' + process.env.API_TOKEN + ' id=' + process.env.REQ_ID)`
let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-cli-err-mask-' })
})
afterEach(() => rm(root, { recursive: true, force: true }))

async function plugin(hooks: string): Promise<void> {
  await Bun.write(
    path.join(root, '.vx/workspace.mjs'),
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
  expect(stderr(['run', 't', '--all'])).toBe(
    noticed(`vx run: plugin 'org/p' failed in setup: ${SAID}\n`),
  )
  await plugin(`{ key() { ${THROW} } }`)
  expect(stderr(['run', 't', '--all'])).toBe(
    noticed(`vx run: plugin 'org/p' failed in key: ${SAID}\n`),
  )
  await plugin(`{ commands: { boom: { description: 'x', run() { ${THROW} } } } }`)
  expect(stderr(['boom'])).toBe(
    noticed(`vx boom: plugin 'org/p' failed in command 'boom': ${SAID}\n`),
  )
}, 30_000)

it("a config's own throw is masked", async () => {
  await addProject(root, 'app', `${THROW}\n`)
  // `vx lock` is the one verb a run's configs are evaluated by.
  const err = stderr(['lock'])
  expect(err.split('\n').filter((l) => l.includes('reply'))).toEqual([
    `  Project config ${root}/packages/app/vx.config.mjs threw: ${SAID} (at ${root}/packages/app/vx.config.mjs:1:11)`,
  ])
}, 20_000)

it("vx watch's failed cycle is masked", async () => {
  // A cycle reads configs from the lock and evaluates none, so the text
  // vx did not write is a plugin's, failing in a stage of the cycle.
  await addProject(
    root,
    'app',
    `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  )
  await plugin(`{ key() { ${THROW} } }`)
  const w = startWatch(root, ['--all'], env)
  try {
    await until(() => w.err().includes('cycle failed'), 'the cycle the plugin fails')
    expect(
      w
        .err()
        .split('\n')
        .filter((l) => l.includes('cycle failed')),
    ).toEqual([`✗ vx watch  cycle failed: plugin 'org/p' failed in key: ${SAID}`])
  } finally {
    w.proc.kill('SIGTERM')
    await w.proc.exited
  }
}, 30_000)
