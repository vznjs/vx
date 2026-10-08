// A TS config may build any task string from `process.env`, not only the
// command: `vx show` masked the command and `env.define` and printed a
// runtime probe, `readyWhen` and the description with the value; the run
// history stored a probe's command as its row name, so `vx why` printed
// it; `--dry` and the picker printed the description (L-11).
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { pickTask } from '../src/cli/select.js'
import { run, type Logger } from '../src/orchestrator/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const TOKEN = 'tokenvalue123'
const PAT = 'patvalue456789'
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string
let saved: [string | undefined, string | undefined]

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-config-mask-' })
  saved = [process.env.API_TOKEN, process.env.GH_PAT]
  process.env.API_TOKEN = TOKEN
  process.env.GH_PAT = PAT
  await addProject(
    root,
    'app',
    `const t = process.env.API_TOKEN
const p = process.env.GH_PAT
export default { tasks: {
  t: {
    description: \`deploys \${t} \${p}\`,
    exec: { command: 'true', env: { secret: ['GH_PAT'] } },
    cache: {
      inputs: { files: ['package.json'], runtime: [\`echo \${t}\`, \`echo \${p}\`] },
      outputs: { files: [] },
    },
  },
  srv: { exec: { command: 'true', persistent: { readyWhen: \`up \${t}\` } } },
  wait: { exec: {
    command: 'exec sleep 30',
    timeout: 1500,
    env: { secret: ['GH_PAT'] },
    persistent: { readyWhen: \`up \${t} \${p}\` },
  } },
} }`,
  )
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

function vx(args: string[], env: Record<string, string> = {}): string {
  const p = Bun.spawnSync([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  return p.stdout.toString() + p.stderr.toString()
}

const leaks = (text: string): boolean => text.includes(TOKEN) || text.includes(PAT)

it('vx show masks every string of the task', () => {
  expect(vx(['show', 'app#t'])).toBe(
    [
      'app — packages/app',
      '',
      't',
      '  description:    deploys *** ***',
      '  command:        true',
      '  env.secret:     GH_PAT',
      '  inputs.files:   package.json',
      '  inputs.runtime: echo ***, echo ***',
      '  outputs.files:  ',
      '',
    ].join('\n'),
  )
  expect(vx(['show', 'app#srv'])).toBe(
    [
      'app — packages/app',
      '',
      'srv',
      '  command:    true',
      '  persistent: readyWhen: up ***',
      '',
    ].join('\n'),
  )
  const json = JSON.parse(vx(['show', 'app#t', '--format', 'json'])) as {
    config: { description: string; cache: { inputs: { runtime: string[] } } }
  }
  expect([json.config.description, json.config.cache.inputs.runtime]).toEqual([
    'deploys *** ***',
    ['echo ***', 'echo ***'],
  ])
}, 20_000)

it("vx why names a runtime probe's row masked, and the history holds no value", async () => {
  vx(['run', 't', '--all'], { API_TOKEN: 'tokenbefore111', GH_PAT: 'patbefore222' })
  vx(['run', 't', '--all'])
  const why = JSON.parse(vx(['why', 'app#t', '--format', 'json'])) as {
    diff: { entries: Array<{ change: string; kind: string; name: string }> }
  }
  expect(why.diff.entries.map((e) => `${e.change} ${e.kind} ${e.name}`)).toEqual([
    'changed config config',
    'changed runtime echo ***',
    'changed runtime echo *** (2)',
  ])
  const pretty = vx(['why', 'app#t'])
  expect(pretty.split('\n').filter((l) => l.startsWith('    changed runtime'))).toEqual([
    expect.stringMatching(/^ {4}changed runtime {2}echo \*\*\* {2}[0-9a-f]{16} → [0-9a-f]{16}$/),
    expect.stringMatching(
      /^ {4}changed runtime {2}echo \*\*\* \(2\) {2}[0-9a-f]{16} → [0-9a-f]{16}$/,
    ),
  ])
  expect(leaks(pretty)).toBe(false)
  const dir = path.join(root, '.vx', 'cache')
  const db = (
    await Promise.all(
      (await readdir(dir))
        .filter((f) => f.startsWith('cache.db'))
        .map((f) => Bun.file(path.join(dir, f)).text()),
    )
  ).join('')
  expect(db.includes('echo ***')).toBe(true)
  expect(['tokenbefore111', 'patbefore222', TOKEN, PAT].filter((v) => db.includes(v))).toEqual([])
}, 30_000)

it('--dry masks the description, as text and as JSON', () => {
  const text = vx(['run', 't', '--all', '--dry'])
  expect(text.split('\n').filter((l) => l.includes('deploys'))).toEqual([
    `${' '.repeat(5 + 'app#t'.length + 2)}deploys *** ***`,
  ])
  const json = JSON.parse(vx(['run', 't', '--all', '--dry=json'])) as {
    tasks: Array<{ description?: string }>
  }
  expect(json.tasks.map((t) => t.description)).toEqual(['deploys *** ***'])
}, 20_000)

it("the picker's menu masks the description", async () => {
  const input = new PassThrough()
  const output = new PassThrough()
  let printed = ''
  output.on('data', (c: Buffer) => {
    printed += c.toString()
  })
  const picking = pickTask(root, { input, output })
  while (!printed.includes('Pick a task')) await Bun.sleep(5)
  input.write('9\n')
  await picking
  expect(printed.split('\n').filter((l) => l.includes('app#'))).toEqual([
    '  1. app#srv ',
    '  2. app#t     deploys *** ***',
    '  3. app#wait',
  ])
})

it('the readiness notice masks a secret in readyWhen, a listed one too', async () => {
  const saved = process.env.VX_READY_NOTICE_MS
  process.env.VX_READY_NOTICE_MS = '200'
  const lines: string[] = []
  const log: Logger = {
    status: (s) => void lines.push(s),
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
  }
  try {
    await run({ cwd: root, tasks: ['app#wait'], log, handleSignals: false })
  } finally {
    if (saved === undefined) delete process.env.VX_READY_NOTICE_MS
    else process.env.VX_READY_NOTICE_MS = saved
  }
  expect(lines.filter((l) => l.includes('not ready after'))).toEqual([
    'vx: app#wait not ready after 200 ms: waiting for a line matching /up *** ***/ (readyWhen)',
  ])
}, 20_000)
