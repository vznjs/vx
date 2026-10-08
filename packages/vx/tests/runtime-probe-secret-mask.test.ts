// A failed `cache.inputs.runtime` probe's error quotes its command and its
// output, and the probe runs in vx's own environment: a probe that echoed
// `$API_TOKEN` printed the token in the task's stream and in `--dry`'s
// stderr, unmasked (L-11).
import { rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { run, type Logger } from '../src/orchestrator/index.js'

const SECRET = 'supersecretvalue123'
const PAT = 'patvalue456789'
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string
let saved: [string | undefined, string | undefined]
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-probe-mask-' })
  saved = [process.env.API_TOKEN, process.env.GH_PAT]
  process.env.API_TOKEN = SECRET
  process.env.GH_PAT = PAT
})
afterEach(async () => {
  for (const [name, value] of [
    ['API_TOKEN', saved[0]],
    ['GH_PAT', saved[1]],
  ] as const) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(root, { recursive: true, force: true })
})

async function project(): Promise<void> {
  await addProject(
    root,
    'app',
    `export default { tasks: { t: {
      exec: { command: 'true', env: { secret: ['GH_PAT'] } },
      cache: {
        inputs: { files: ['package.json'], runtime: ['echo "saw $API_TOKEN $GH_PAT"; exit 3'] },
        outputs: { files: [] },
      },
    } } }`,
  )
}

const said = (cwd: string): string =>
  `[vx] app#t: cache.inputs runtime command exited 3: echo "saw $API_TOKEN $GH_PAT"; exit 3 (cwd: ${cwd})\nsaw *** ***\n`

it("a failed probe's output is masked in the task's stream", async () => {
  await project()
  const lines: string[] = []
  const log: Logger = {
    status: (m) => void lines.push(m),
    taskStdout: (_n, t) => void lines.push(t),
    taskStderr: (_n, t) => void lines.push(t),
    taskComplete() {},
  }
  const r = await run({ cwd: root, tasks: ['t'], projects: ['app'], log, handleSignals: false })
  expect(r.outcomes.map((o) => o.status)).toEqual(['failed'])
  expect(lines.filter((l) => l.includes('runtime command'))).toEqual([
    said(path.join(root, 'packages', 'app')),
  ])
  expect(lines.some((l) => l.includes(SECRET) || l.includes(PAT))).toBe(false)
})

it("a failed probe's output is masked on --dry's stderr", async () => {
  await project()
  const proc = Bun.spawn([process.execPath, BIN, 'run', 't', '--all', '--dry'], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  expect(err).toBe(said(path.join(root, 'packages', 'app')))
  expect(out.includes(SECRET) || out.includes(PAT)).toBe(false)
}, 20_000)
