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
import { docsIn } from './helpers/docs-pages.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

const REAL_BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')

let root: string
let bare: string
let badPolicy: string
/** One workspace per refusal `vx lock` makes: it stops at the first. */
const refusedByLock: Record<string, string> = {}
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-error-codes-' })
  await addProject(
    root,
    'a',
    `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  )
  const out = `inputs: { files: ['in/**'] }, cache: { outputs: { files: ['dist/**'] } }`
  for (const [name, config] of Object.entries({
    cycle: `export default { tasks: {
      x: { exec: { command: 'true' }, dependsOn: ['y'] },
      y: { exec: { command: 'true' }, dependsOn: ['x'] },
    } }\n`,
    dependsOn: `export default { tasks: { d: { exec: { command: 'true' }, dependsOn: ['ghost'] } } }\n`,
    outputOverlap: `export default { tasks: {
      p: { exec: { command: 'true' }, ${out} },
      q: { exec: { command: 'true' }, ${out} },
    } }\n`,
    inputIsOutput: `export default { tasks: {
      s: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['src/**'] } } },
    } }\n`,
    config: `export default { tasks: { b: { exec: { command: 'true' }, nope: 1 } } }\n`,
  })) {
    refusedByLock[name] = await makeWorkspace({ prefix: `vx-error-codes-${name}-` })
    await addProject(refusedByLock[name], 'p', config)
  }
  badPolicy = await makeWorkspace({ prefix: 'vx-error-codes-policy-', workspaceFile: false })
  await Bun.write(
    path.join(badPolicy, '.vx/workspace.mjs'),
    `export default { cache: { policy: 'local:x' } }\n`,
  )
  await addProject(
    badPolicy,
    'a',
    `export default { tasks: { build: { exec: { command: 'true' } } } }\n`,
  )
  bare = await mkdtemp(path.join(os.tmpdir(), 'vx-error-codes-bare-'))
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
  for (const dir of Object.values(refusedByLock)) await rm(dir, { recursive: true, force: true })
  await rm(bare, { recursive: true, force: true })
  await rm(badPolicy, { recursive: true, force: true })
})

async function vx(args: string[], cwd = root, env: Record<string, string> = {}) {
  const p = Bun.spawn([process.execPath, BIN, ...args], {
    cwd,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [code, stdout, stderr] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  return { code, stdout, stderr }
}

/** The code of the one JSON line on stdout; stderr still says it in prose. */
async function refusal(
  args: string[],
  cwd?: string,
  env?: Record<string, string>,
): Promise<string> {
  const r = await vx(args, cwd, env)
  expect(r.code).toBe(1)
  const doc = JSON.parse(r.stdout) as {
    ok: boolean
    error: { code: string; message: string; docs?: string }
  }
  expect(doc.ok).toBe(false)
  expect(doc.error.docs).toBe(`https://vznjs.github.io/vx/cli/#${doc.error.code.toLowerCase()}`)
  expect(r.stderr).toMatch(/^([✗›] )?vx/)
  expect(doc.error.message.length).toBeGreaterThan(0)
  return doc.error.code
}

describe('a refusal under --format json', () => {
  // Eight vx processes in sequence overran the default 5 s on a loaded
  // 3-core macOS runner; side by side they take the time of one.
  it('names the refusal by its code', async () => {
    const codes = await Promise.all([
      refusal(['run', 'nope', '--all', '--dry=json']),
      refusal(['run', 'build', '--bogus', '--dry=json']),
      refusal(['run', 'build', '--dry=json'], bare),
      refusal(['run', 'build', '--affected=a..b', '--dry=json']),
      refusal(['run', 'build', '--all', '--dry=json'], badPolicy),
      refusal(['run', 'build', '--all', '--cache-policy=disk:r', '--dry=json']),
      refusal(['run', 'build', '--all', '--dry=json'], root, { VX_CACHE_POLICY: 'disk:r' }),
      refusal(['run', 'build', '--all', '--dry=json'], root, {
        VX_CACHE_INPUT_STABILITY_STRATEGY: 'bogus',
      }),
    ])
    const names = [
      'unknownTask',
      'usage',
      'noWorkspace',
      'affectedRange',
      'cachePolicy',
      'cacheFlag',
      'cacheEnv',
      'stabilityEnv',
    ]
    expect(Object.fromEntries(names.map((n, i) => [n, codes[i]]))).toEqual({
      unknownTask: 'VX_E_UNKNOWN_TASK',
      usage: 'VX_E_USAGE',
      noWorkspace: 'VX_E_NO_WORKSPACE',
      affectedRange: 'VX_E_AFFECTED_BASE',
      cachePolicy: 'VX_E_CONFIG',
      cacheFlag: 'VX_E_USAGE',
      cacheEnv: 'VX_E_USAGE',
      stabilityEnv: 'VX_E_USAGE',
    })
  })

  it("a graph or config refusal is the lock's, so a run there has no lock", async () => {
    const said: Record<string, [number, string, string]> = {}
    for (const [name, cwd] of Object.entries(refusedByLock)) {
      const p = Bun.spawnSync([process.execPath, REAL_BIN, 'lock'], { cwd, stderr: 'pipe' })
      said[name] = [
        p.exitCode,
        p.stderr.toString().replaceAll(cwd, '<root>'),
        await refusal(['run', 'b', '--all', '--dry=json'], cwd),
      ]
    }
    const refused = (why: string): [number, string, string] => [
      1,
      `✗ vx lock  lock not written\n\n  ${why}\n`,
      'VX_E_REFUSED',
    ]
    expect(said).toEqual({
      cycle: refused('dependsOn cycle: p#x -> p#y -> p#x — remove one edge of the loop'),
      dependsOn: refused('p#d: dependsOn p#ghost but no such task is declared'),
      outputOverlap: refused(
        "p#p and p#q both write dist/**\n  vx clears a task's outputs before it runs, so one deletes the other's\n\n  fix  give each task its own output path",
      ),
      inputIsOutput: refused(
        'p#s: every file "src/**" in inputs.files selects is also its own output — vx removes a task\'s outputs before it runs, so the task would delete its own sources\n  A task that rewrites files in place (a formatter) declares no outputs',
      ),
      // The text is config-error-audit.test.ts's to pin.
      config: [
        1,
        expect.stringMatching(
          /^✗ vx lock  lock not written\n\n  packages\/p\/vx\.config\.mjs:1:59\n/,
        ),
        'VX_E_REFUSED',
      ],
    })
    // Two vx spawns per refused graph, one after another: a loaded CI
    // runner took past bun's 5 s default.
  }, 30_000)

  it('every reading verb answers its refusals with a code too', async () => {
    expect({
      showUsage: await refusal(['show', '--bogus', '--format', 'json']),
      showProject: await refusal(['show', 'nope#build', '--format', 'json']),
      showTask: await refusal(['show', 'a#nope', '--format', 'json']),
      infoUsage: await refusal(['info', '--bogus', '--format', 'json']),
      whyUsage: await refusal(['why', '--format', 'json']),
      whyHistory: await refusal(['why', 'a#build', '--format', 'json']),
      lastHistory: await refusal(['last', '--format', 'json']),
      pruneUsage: await refusal(['cache', 'clean', '--bogus', '--format', 'json']),
      pruneWorkspace: await refusal(
        ['cache', 'clean', '--max-size', '1G', '--format', 'json'],
        bare,
      ),
      cacheSub: await refusal(['cache', 'bogus', '--format', 'json']),
      runNoTask: await refusal(['run', '--dry=json']),
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
    // Fourteen vx spawns one after another: a loaded Linux runner took
    // past bun's 5 s default.
  }, 30_000)

  // `--format json` as the verb's own word, and the verbs that take no
  // flag: each refused with prose alone and an empty stdout.
  it('a refusal of the JSON flag itself, or by a verb that prints no JSON, answers a code', async () => {
    const codes = await Promise.all([
      refusal(['--format', 'json']),
      refusal(['--format=json']),
      refusal(['help', '--bogus', '--format', 'json']),
      refusal(['help', 'bogus', '--format', 'json']),
      refusal(['version', '--format', 'json']),
      // Verbs that print no JSON refuse the request, as a usage error.
      refusal(['watch', 'build', '--format', 'json']),
      refusal(['watch', 'build', '--dry=json']),
      refusal(['upgrade', '--format', 'json']),
      refusal(['completions', '--format', 'json']),
    ])
    expect(codes).toEqual([
      'VX_E_USAGE',
      'VX_E_USAGE',
      'VX_E_USAGE',
      'VX_E_UNKNOWN_COMMAND',
      'VX_E_USAGE',
      'VX_E_USAGE',
      'VX_E_USAGE',
      'VX_E_USAGE',
      'VX_E_USAGE',
    ])
  })

  // The loader's own refusals open with `Workspace config …`, not the path,
  // and answered VX_E_REFUSED; a config's own throw answered VX_E_INTERNAL.
  it('a workspace file that does not load is VX_E_CONFIG', async () => {
    const codes: Record<string, string> = {}
    for (const [name, body] of Object.entries({
      syntax: 'export default {\n',
      notObject: 'export default 42\n',
      thrownValue: "throw 'no'\n",
      thrownError: "throw new Error('no')\n",
    })) {
      const ws = await makeWorkspace({ prefix: `vx-error-codes-ws-${name}-`, workspaceFile: false })
      try {
        await Bun.write(path.join(ws, '.vx/workspace.mjs'), body)
        codes[name] = await refusal(['show', '--format', 'json'], ws)
      } finally {
        await rm(ws, { recursive: true, force: true })
      }
    }
    expect(codes).toEqual({
      syntax: 'VX_E_CONFIG',
      notObject: 'VX_E_CONFIG',
      thrownValue: 'VX_E_CONFIG',
      thrownError: 'VX_E_CONFIG',
    })
  }, 30_000)

  it('CONTROLS: without JSON, or with it only after `--`, stdout stays empty', async () => {
    const plain = await vx(['run', 'nope', '--all'])
    const forwarded = await vx(['run', 'nope', '--all', '--', '--dry=json'])
    expect([plain.code, plain.stdout, forwarded.code, forwarded.stdout]).toEqual([1, '', 1, ''])
    expect(plain.stderr).toContain('no projects declare task(s): nope')
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
      errorCode(new UserError("Project config /ws/packages/a/vx.config.ts: cannot find 'x'")),
      errorCode(
        new UserError('Workspace config at /ws/.vx/workspace.ts did not export a default object'),
      ),
    ]).toEqual([
      'VX_E_CYCLE',
      'VX_E_REFUSED',
      'VX_E_CONFIG',
      'VX_E_REFUSED',
      'VX_E_FDS',
      'VX_E_FS',
      'VX_E_INTERNAL',
      'VX_E_CONFIG',
      'VX_E_CONFIG',
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
    const r = await docsIn(['VX_E_USAGE', '--format', 'json'])
    expect(r.code).toBe(0)
    const { hits } = JSON.parse(r.out) as { hits: { heading: string; url: string }[] }
    expect(hits.map((h) => [h.heading, h.url])).toEqual([
      ['VX_E_USAGE', JSON.parse(errorDocument('VX_E_USAGE', 'm')).error.docs],
    ])
  })
})
