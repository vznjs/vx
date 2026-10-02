// Every run ends and leaves no child behind, over seeded random graphs of
// one-shots and servers: servers that get ready, crash before or after it,
// never get ready inside their timeout, or trap SIGTERM; one-shots that
// pass, fail or take a while; each `--continue` mode, with and without
// `holdPersistent`, run to the end or stopped at a random moment. Probes
// of 190 and 120 graphs found no hang and no orphan; this keeps them
// (C-82). Unsafe: it judges liveness, which the sandbox's pid
// namespace hides (a zombie reads alive there).

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import type { Logger } from '../src/orchestrator/index.js'
import { run } from '../src/orchestrator/index.js'
import { isAlive, waitForDead } from './helpers/alive.js'
import { rng } from './helpers/rng.js'
import { gitInitCommit } from './helpers/workspace.js'

const silent: Logger = {
  status: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
}

// Each kind's command, after it records its pid. `trap` must come first.
const KINDS = {
  ok: (rec: string) => `{ exec: { command: '${rec}; true' } }`,
  fail: (rec: string) => `{ exec: { command: '${rec}; exit 3' } }`,
  slow: (rec: string) => `{ exec: { command: '${rec}; sleep 0.3' } }`,
  server: (rec: string) =>
    `{ exec: { command: '${rec}; echo READY; exec sleep 30', persistent: { readyWhen: 'READY' } } }`,
  crashBefore: (rec: string) =>
    `{ exec: { command: '${rec}; sleep 0.1; exit 4', persistent: { readyWhen: 'READY' } } }`,
  crashAfter: (rec: string) =>
    `{ exec: { command: '${rec}; echo READY; sleep 0.2; exit 5', persistent: { readyWhen: 'READY' } } }`,
  neverReady: (rec: string) =>
    `{ exec: { command: '${rec}; exec sleep 30', timeout: 400, persistent: { readyWhen: 'READY' } } }`,
  trapServer: (rec: string) =>
    `{ exec: { command: 'trap "" TERM; ${rec}; echo READY; while true; do sleep 0.1; done', persistent: { readyWhen: 'READY' } } }`,
}
const NAMES = Object.keys(KINDS) as Array<keyof typeof KINDS>

let tmp = ''
let grace: string | undefined
beforeAll(async () => {
  tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-plife-'))
  // The trapping server waits out the kill grace at every stop.
  grace = process.env['VX_KILL_GRACE_MS']
  process.env['VX_KILL_GRACE_MS'] = '300'
})
afterAll(async () => {
  if (grace === undefined) delete process.env['VX_KILL_GRACE_MS']
  else process.env['VX_KILL_GRACE_MS'] = grace
  await rm(tmp, { recursive: true, force: true })
})

async function scenario(seed: number, iter: number, stopAt?: number): Promise<string[]> {
  const broken: string[] = []
  const rnd = rng(seed)
  const root = path.join(tmp, `w${seed}`)
  const p = path.join(root, 'packages', 'p')
  const pids = path.join(root, 'pids')
  await mkdir(p, { recursive: true })
  await mkdir(pids)
  await writeFile(path.join(root, 'package.json'), '{"name":"fx","workspaces":["packages/*"]}')
  await writeFile(path.join(p, 'package.json'), '{"name":"p"}')
  const n = 2 + Math.floor(rnd() * 6)
  const kinds: string[] = []
  const tasks: string[] = []
  for (let i = 0; i < n; i++) {
    const deps = Array.from({ length: i }, (_, j) => `t${j}`).filter(() => rnd() < 0.4)
    const kind = NAMES[Math.floor(rnd() * NAMES.length)]!
    kinds.push(kind)
    const task = KINDS[kind](`echo $$ > ${pids}/t${i}`)
    tasks.push(`t${i}: ${task.replace(/^\{ /, `{ dependsOn: ${JSON.stringify(deps)}, `)}`)
  }
  await writeFile(
    path.join(p, 'vx.config.mjs'),
    `export default { tasks: { ${tasks.join(',\n')} } }\n`,
  )
  gitInitCommit(root, 'init')
  const mode = (['never', 'deps-ok', 'always'] as const)[Math.floor(rnd() * 3)]!
  const requested = Array.from({ length: n }, (_, i) => `p#t${i}`).filter(() => rnd() < 0.5)
  if (requested.length === 0) requested.push(`p#t${n - 1}`)
  const hold = rnd() < 0.3
  const label = `#${iter} mode=${mode} hold=${hold} stop=${stopAt} requested=${requested.join(',')} kinds=${kinds.join(',')}`

  const ac = new AbortController()
  const reason = rnd() < 0.5 ? 'SIGINT' : 'SIGTERM'
  const timer = stopAt === undefined ? undefined : setTimeout(() => ac.abort(reason), stopAt)
  const started = Date.now()
  const r = await run({
    cwd: root,
    tasks: requested,
    continueMode: mode,
    log: silent,
    handleSignals: false,
    holdPersistent: hold,
    signal: ac.signal,
  })
  clearTimeout(timer)
  // Every server sleeps 30 s: a run that waited one out did not stop it.
  if (Date.now() - started > 10_000) broken.push(`${label}: took ${Date.now() - started} ms`)
  await r.persistent?.stop()
  for (const f of await readdir(pids)) {
    const pid = Number((await readFile(path.join(pids, f), 'utf8')).trim())
    if (await waitForDead(pid, 1_000)) continue
    broken.push(`${label}: ${f} (${kinds[Number(f.slice(1))]}) outlived the run`)
    if (isAlive(pid)) process.kill(pid, 'SIGKILL')
  }
  return broken
}

it('a run with servers in it always ends, and no child outlives it', async () => {
  const broken: string[] = []
  for (let i = 0; i < 12; i++) broken.push(...(await scenario(7000 + i, i)))
  expect(broken).toEqual([])
}, 120_000)

it('so does one stopped at any moment, by SIGINT or SIGTERM', async () => {
  const broken: string[] = []
  for (let i = 0; i < 12; i++) {
    const at = Math.floor(rng(500 + i)() * 700)
    broken.push(...(await scenario(11000 + i, i, at)))
  }
  expect(broken).toEqual([])
}, 120_000)
