// Stable error codes: a verb asked for JSON answers a refusal with one JSON
// line on stdout, `{ ok: false, error: { code, message } }`, so an agent
// branches on the code instead of parsing prose. stderr and the exit code
// stay as they were.
import { readdirSync, readFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { errorCode, errorDocument, UserError, wantsJson } from '../src/util/index.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
let broken: string
let bare: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-error-codes-' })
  await addProject(
    root,
    'a',
    `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  )
  await addProject(
    root,
    'loop',
    `export default { tasks: {
      x: { exec: { command: 'true' }, dependsOn: ['y'] },
      y: { exec: { command: 'true' }, dependsOn: ['x'] },
    } }\n`,
  )
  // Its own workspace: a config that does not load refuses every run there.
  broken = await makeWorkspace({ prefix: 'vx-error-codes-broken-' })
  await addProject(
    broken,
    'bad',
    `export default { tasks: { b: { exec: { command: 'true' }, nope: 1 } } }\n`,
  )
  bare = await mkdtemp(path.join(os.tmpdir(), 'vx-error-codes-bare-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  await rm(broken, { recursive: true, force: true })
  await rm(bare, { recursive: true, force: true })
})

async function vx(args: string[], cwd = root) {
  const p = Bun.spawn([process.execPath, BIN, ...args], { cwd, stdout: 'pipe', stderr: 'pipe' })
  const [code, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** The code of the one JSON line on stdout; stderr still says it in prose. */
async function refusal(args: string[], cwd?: string): Promise<string> {
  const r = await vx(args, cwd)
  expect(r.code).toBe(1)
  const doc = JSON.parse(r.stdout) as {
    ok: boolean
    error: { code: string; message: string; docs?: string }
  }
  expect(doc.ok).toBe(false)
  expect(doc.error.docs).toBe(`https://vznjs.github.io/vx/cli/#${doc.error.code.toLowerCase()}`)
  expect(r.stderr).toStartWith('vx')
  expect(doc.error.message.length).toBeGreaterThan(0)
  return doc.error.code
}

describe('a refusal under --format json', () => {
  it('names the refusal by its code', async () => {
    expect({
      unknownTask: await refusal(['run', 'nope', '--all', '--format', 'json']),
      usage: await refusal(['run', 'build', '--bogus', '--format=json']),
      cycle: await refusal(['run', 'x', '--filter', 'loop', '--format', 'json']),
      config: await refusal(['run', 'b', '--all', '--dry=json'], broken),
      noWorkspace: await refusal(['run', 'build', '--format', 'json'], bare),
    }).toEqual({
      unknownTask: 'VX_E_UNKNOWN_TASK',
      usage: 'VX_E_USAGE',
      cycle: 'VX_E_CYCLE',
      config: 'VX_E_CONFIG',
      noWorkspace: 'VX_E_NO_WORKSPACE',
    })
  })

  it('every reading verb answers its refusals with a code too', async () => {
    expect({
      showUsage: await refusal(['show', '--bogus', '--format', 'json']),
      showProject: await refusal(['show', 'nope#build', '--format', 'json']),
      showTask: await refusal(['show', 'a#nope', '--format', 'json']),
      infoUsage: await refusal(['info', '--bogus', '--format', 'json']),
      whyUsage: await refusal(['why', '--format', 'json']),
      whyHistory: await refusal(['why', 'a#build', '--format', 'json']),
      lastHistory: await refusal(['last', '--format', 'json']),
      pruneUsage: await refusal(['cache', 'prune', '--bogus', '--format', 'json']),
      pruneWorkspace: await refusal(
        ['cache', 'prune', '--max-size', '1G', '--format', 'json'],
        bare,
      ),
      cacheSub: await refusal(['cache', 'bogus', '--format', 'json']),
      runNoTask: await refusal(['run', '--format', 'json']),
      verb: await refusal(['bogus', '--format', 'json']),
      taskAsVerb: await refusal(['build', '--format', 'json']),
      topFlag: await refusal(['--bogus', '--format', 'json']),
    }).toEqual({
      showUsage: 'VX_E_USAGE',
      showProject: 'VX_E_UNKNOWN_PROJECT',
      showTask: 'VX_E_UNKNOWN_TASK',
      infoUsage: 'VX_E_USAGE',
      whyUsage: 'VX_E_USAGE',
      whyHistory: 'VX_E_NO_HISTORY',
      lastHistory: 'VX_E_NO_HISTORY',
      pruneUsage: 'VX_E_USAGE',
      pruneWorkspace: 'VX_E_NO_WORKSPACE',
      cacheSub: 'VX_E_USAGE',
      runNoTask: 'VX_E_USAGE',
      verb: 'VX_E_UNKNOWN_COMMAND',
      taskAsVerb: 'VX_E_UNKNOWN_COMMAND',
      topFlag: 'VX_E_USAGE',
    })
  })

  it('CONTROLS: without JSON, or with it only after `--`, stdout stays empty', async () => {
    const plain = await vx(['run', 'nope', '--all'])
    const forwarded = await vx(['run', 'nope', '--all', '--', '--format', 'json'])
    expect([plain.code, plain.stdout, forwarded.code, forwarded.stdout]).toEqual([1, '', 1, ''])
    expect(plain.stderr).toContain('vx run: no projects declare task(s): nope')
  })
})

describe('errorCode', () => {
  const errno = (code: string) => Object.assign(new Error(code), { code })
  it('reads a UserError, the environment and a defect', () => {
    expect([
      errorCode(new UserError('x', 'VX_E_CYCLE')),
      errorCode(new UserError('x')),
      errorCode(new UserError('/ws/packages/a/vx.config.ts: tasks.b has unknown field "c"')),
      errorCode(Object.assign(new Error('from another core'), { name: 'UserError' })),
      errorCode(errno('EMFILE')),
      errorCode(errno('EACCES')),
      errorCode(new TypeError('boom')),
    ]).toEqual([
      'VX_E_CYCLE',
      'VX_E_REFUSED',
      'VX_E_CONFIG',
      'VX_E_REFUSED',
      'VX_E_FDS',
      'VX_E_FS',
      'VX_E_INTERNAL',
    ])
  })

  it('wantsJson reads vx flags only, up to `--`', () => {
    expect([
      wantsJson(['run', 'b', '--format', 'json']),
      wantsJson(['run', 'b', '--format=json']),
      wantsJson(['run', 'b', '--dry=json']),
      wantsJson(['run', 'b', '--format', 'pretty']),
      wantsJson(['run', 'b', '--', '--format=json']),
    ]).toEqual([true, true, true, false, false])
  })
})

// Each code leads to its fix: a section of cli.md titled by the code, which
// the error document links and `vx docs <code>` prints alone.
describe('every core code has a section that says what to do', () => {
  const SRC = path.resolve(import.meta.dir, '..', 'src')
  const CLI_MD = path.resolve(import.meta.dir, '..', 'docs', 'cli.md')
  const thrown = new Set<string>()
  for (const f of readdirSync(SRC, { recursive: true }) as string[]) {
    if (!f.endsWith('.ts')) continue
    for (const m of readFileSync(path.join(SRC, f), 'utf8').matchAll(/'(VX_E_[A-Z_]+)'/g))
      thrown.add(m[1]!)
  }
  const md = readFileSync(CLI_MD, 'utf8')
  const headed = [...md.matchAll(/^#### `(VX_E_[A-Z_]+)`$/gm)].map((m) => m[1]!)

  it('a heading per code the source names, and none it does not', () => {
    expect(thrown.size).toBeGreaterThan(10)
    expect(headed.toSorted()).toEqual([...thrown].toSorted())
  })

  it('the error document links the section; a plugin code links nothing', () => {
    expect([
      JSON.parse(errorDocument('VX_E_CYCLE', 'm')).error,
      JSON.parse(errorDocument('MY_CODE', 'm')).error,
    ]).toEqual([
      { code: 'VX_E_CYCLE', message: 'm', docs: 'https://vznjs.github.io/vx/cli/#vx_e_cycle' },
      { code: 'MY_CODE', message: 'm' },
    ])
  })

  it('`vx docs <code>` prints that section alone, at the linked URL', async () => {
    // VX_E_USAGE: three more sections of cli.md name it.
    const r = await vx(['docs', 'VX_E_USAGE', '--format', 'json'])
    expect(r.code).toBe(0)
    const { hits } = JSON.parse(r.stdout) as { hits: { heading: string; url: string }[] }
    expect(hits.map((h) => [h.heading, h.url])).toEqual([
      ['VX_E_USAGE', JSON.parse(errorDocument('VX_E_USAGE', 'm')).error.docs],
    ])
  })
})
