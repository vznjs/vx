// A task string may hold a secret's value, not only the command: `vx show`
// masked the command and `env.define` and printed a runtime probe,
// `readyWhen` and the description with the value; the run history stored a
// probe's command as its row name, so `vx why` printed it; `--dry` and the
// picker printed the description (L-11). `vx lock` refuses a config that
// evaluates to a secret where it runs (lock-secret.test.ts), but a lock
// written where the value was no secret reaches a run where it is: here the
// lock is written with neither variable set.
import { readdir, rm } from 'node:fs/promises'
import path from 'node:path'
import { PassThrough } from 'node:stream'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { pickTask } from '../src/cli/select.js'
import { run } from '../src/orchestrator/index.js'
import { type Logger } from '../src/report/index.js'
import { gradientRule } from '../src/util/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const TOKEN = 'tokenvalue123'
const PAT = 'patvalue456789'
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string
let saved: [string | undefined, string | undefined]

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-config-mask-' })
  saved = [process.env.API_TOKEN, process.env.GH_PAT]
  await addProject(
    root,
    'app',
    `export default { tasks: {
  t: {
    description: 'deploys ${TOKEN} ${PAT}',
    exec: { command: 'true', env: { secret: ['GH_PAT'] } },
    inputs: { files: ['package.json'], runtime: ['echo ${TOKEN} $(cat stamp)', 'echo ${PAT} $(cat stamp)'] },
    cache: {
      outputs: { files: [] },
    },
  },
  srv: { exec: { command: 'true', persistent: { readyWhen: 'up ${TOKEN}' } } },
  wait: { exec: {
    command: 'exec sleep 30',
    timeout: '1500ms',
    env: { secret: ['GH_PAT'] },
    persistent: { readyWhen: 'up ${TOKEN} ${PAT}' },
  } },
} }`,
  )
  const { API_TOKEN: _t, GH_PAT: _p, ...clean } = process.env
  const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    cwd: root,
    env: { ...clean, VX_LOCK_REVIEW_FILES: 'false' },
    stderr: 'pipe',
  })
  expect(lock.stderr.toString()).toBe('')
  process.env.API_TOKEN = TOKEN
  process.env.GH_PAT = PAT
  await Bun.write(stamp(), '0')
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

const stamp = (): string => path.join(root, 'packages', 'app', 'stamp')
const leaks = (text: string): boolean => text.includes(TOKEN) || text.includes(PAT)

it('vx show masks every string of the task', () => {
  expect(vx(['show', 'app#t'])).toBe(
    [
      '',
      gradientRule({ enabled: false }, 'app#t'),
      '  dir             packages/app',
      '  description     deploys *** ***',
      '  command         true',
      '  env.secret      GH_PAT',
      '  inputs.files    package.json',
      '  inputs.runtime  echo *** $(cat stamp), echo *** $(cat stamp)',
      '  outputs.files',
      '',
    ].join('\n'),
  )
  expect(vx(['show', 'app#srv'])).toBe(
    [
      '',
      gradientRule({ enabled: false }, 'app#srv'),
      '  dir         packages/app',
      '  command     true',
      '  persistent  readyWhen: up ***',
      '',
    ].join('\n'),
  )
  const json = JSON.parse(vx(['show', 'app#t', '--format', 'json'])) as {
    config: { description: string; inputs: { runtime: string[] } }
  }
  expect([json.config.description, json.config.inputs.runtime]).toEqual([
    'deploys *** ***',
    ['echo *** $(cat stamp)', 'echo *** $(cat stamp)'],
  ])
}, 20_000)

it('vx show builds the env mask once for the tasks that define no variable', async () => {
  // Built per task, the pattern over vx's env was 10 of `vx show build`'s
  // 58 ms over 100 projects. A preload counts the patterns that hold the
  // env's secret: one per task before, one per process now.
  for (const name of ['p1', 'p2', 'p3']) {
    await addProject(
      root,
      name,
      `export default { tasks: { b: { exec: { command: 'echo ${TOKEN}' } } } }`,
    )
  }
  const { API_TOKEN: _t, GH_PAT: _p, ...clean } = process.env
  const lock = Bun.spawnSync([process.execPath, BIN, 'lock'], {
    cwd: root,
    env: { ...clean, VX_LOCK_REVIEW_FILES: 'false' },
    stderr: 'pipe',
  })
  expect(lock.stderr.toString()).toBe('')
  const log = path.join(root, 'patterns.log')
  const preload = path.join(root, 'count-patterns.ts')
  await Bun.write(
    preload,
    `import { appendFileSync } from 'node:fs'
const Native = RegExp
globalThis.RegExp = new Proxy(Native, {
  construct(target, args) {
    if (String(args[0]).includes(${JSON.stringify(TOKEN)})) appendFileSync(${JSON.stringify(log)}, 'x')
    return Reflect.construct(target, args)
  },
})
`,
  )
  const p = Bun.spawnSync([process.execPath, '--preload', preload, BIN, 'show', 'b'], {
    cwd: root,
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const out = p.stdout.toString()
  expect(out.split('\n').filter((l) => l.includes('command'))).toEqual([
    '  command   echo ***',
    '  command   echo ***',
    '  command   echo ***',
  ])
  expect(await Bun.file(log).text()).toBe('x')
}, 20_000)

it("vx why names a runtime probe's row masked, and the history holds no value", async () => {
  // A probe sees only the essential env, so the change it answers is a file's.
  await Bun.write(stamp(), '1')
  vx(['run', 't', '--all'])
  await Bun.write(stamp(), '2')
  vx(['run', 't', '--all'])
  const why = JSON.parse(vx(['why', 'app#t', '--format', 'json'])) as {
    diff: { entries: Array<{ change: string; kind: string; name: string }> }
  }
  expect(why.diff.entries.map((e) => `${e.change} ${e.kind} ${e.name}`)).toEqual([
    'changed runtime echo *** $(cat stamp)',
    'changed runtime echo *** $(cat stamp) (2)',
  ])
  const pretty = vx(['why', 'app#t'])
  expect(pretty.split('\n').filter((l) => l.startsWith('    changed runtime'))).toEqual([
    expect.stringMatching(
      /^ {4}changed runtime {2}echo \*\*\* \$\(cat stamp\) {2}[0-9a-f]{16} → [0-9a-f]{16}$/,
    ),
    expect.stringMatching(
      /^ {4}changed runtime {2}echo \*\*\* \$\(cat stamp\) \(2\) {2}[0-9a-f]{16} → [0-9a-f]{16}$/,
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
  expect([TOKEN, PAT].filter((v) => db.includes(v))).toEqual([])
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
  const saved = process.env.VX_TEST_READY_NOTICE
  process.env.VX_TEST_READY_NOTICE = '200ms'
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
    if (saved === undefined) delete process.env.VX_TEST_READY_NOTICE
    else process.env.VX_TEST_READY_NOTICE = saved
  }
  expect(lines.filter((l) => l.includes('not ready after'))).toEqual([
    'vx: app#wait not ready after 200 ms: waiting for a line matching /up *** ***/ (readyWhen)',
  ])
}, 20_000)
