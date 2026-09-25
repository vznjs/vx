// `vx why` e2e — subprocess-driven like show-info.test.ts so the dispatcher
// wiring, exit codes, and UserError presentation match what a user sees.
// The fixture runs a real task twice with a changed input file so the
// persisted entry_inputs rows carry a genuine component-level diff.

import { mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { Database } from 'bun:sqlite'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { parseWhyArgs } from '../src/cli/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000

const APP_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat src/input.txt > out.txt' },
        cache: {
          inputs: { files: ['src/**'] },
          outputs: { files: ['out.txt'] },
        },
      },
    },
  }
`

async function makeWorkspace(): Promise<string> {
  const root = await makeWorkspaceRoot({ prefix: 'vx-why-', git: false })
  const appDir = path.join(root, 'packages', 'app')
  await mkdir(path.join(appDir, 'src'), { recursive: true })
  await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(appDir, 'vx.config.mjs'), APP_CONFIG)
  await writeFile(path.join(appDir, 'src', 'input.txt'), 'v1\n')
  const git = gitIn(root)
  git('init', '-q')
  git('add', '-A')
  return root
}

interface VxResult {
  code: number
  out: string
  err: string
}

async function vx(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
    cwd: root,
    env: { ...process.env, ...env },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

describe('vx why (e2e)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
    // Two runs with a changed input in between → a real key change with
    // component-level fingerprints on both entries.
    await vx(root, ['run', 'build', '--all'])
    await writeFile(path.join(root, 'packages', 'app', 'src', 'input.txt'), 'v2\n')
    await vx(root, ['run', 'build', '--all'])
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'names the changed input component between the last two runs',
    async () => {
      const r = await vx(root, ['why', 'app#build'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('app#build — run ')
      expect(r.out).toContain('cache key changed')
      expect(r.out).toContain('what changed')
      // The exact changed component: the edited input file, kind `file`.
      expect(r.out).toMatch(/changed\s+file\s+.*input\.txt/)
    },
    TIMEOUT,
  )

  it(
    'a bare task name resolves when unique across projects',
    async () => {
      const r = await vx(root, ['why', 'build'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('app#build')
    },
    TIMEOUT,
  )

  it(
    '--format json emits the machine shape (why + component diff)',
    async () => {
      const r = await vx(root, ['why', 'app#build', '--format', 'json'])
      expect(r.code).toBe(0)
      const parsed = JSON.parse(r.out) as {
        taskId: string
        why: { hashChanged: boolean }
        diff: { entries: Array<{ kind: string; name: string; change: string }> }
      }
      expect(parsed.taskId).toBe('app#build')
      expect(parsed.why.hashChanged).toBe(true)
      expect(
        parsed.diff.entries.some((e) => e.kind === 'file' && e.name.includes('input.txt')),
      ).toBe(true)
    },
    TIMEOUT,
  )

  it(
    'an unknown task errors with the same near-miss hint `vx run` gives',
    async () => {
      const r = await vx(root, ['why', 'app#buil'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('no recorded runs')
      expect(r.err).toContain('did you mean app#build')
      // A bare typo is matched against the TASK half and hinted as the
      // runnable id — a substring match alone found nothing for `buld`.
      const bare = await vx(root, ['why', 'buld'])
      expect(bare.code).toBe(1)
      expect(bare.err).toContain('did you mean app#build')
    },
    TIMEOUT,
  )

  it(
    'a stale --run id errors clearly',
    async () => {
      const r = await vx(root, ['why', 'app#build', '--run', 'nope'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('has no row')
    },
    TIMEOUT,
  )

  // Last: it adds a third run, which the tests above must not see.
  it(
    "a hit's line is its status and key — the status names the hit, nothing repeats it",
    async () => {
      await vx(root, ['run', 'build', '--all'])
      const r = await vx(root, ['why', 'app#build'])
      expect(r.code).toBe(0)
      expect(r.out).toMatch(/^  this run   \S+ · cache-hit · key [0-9a-f]+$/m)
      expect(r.out).not.toContain('cache hit ·')
      expect(r.out).toContain('served from cache')
    },
    TIMEOUT,
  )
})

// Every component kind a key folds has a verdict row (item 256): the file
// row was pinned above; the env, package, workspace-fingerprint, config and
// upstream rows were read by eye until this walk pinned each one.
describe('vx why (e2e) — every component kind names its row', () => {
  let root: string
  const APP = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && echo hi > dist/out.txt' },
          dependsOn: ['^build'],
          cache: { inputs: { files: ['src/**'], env: ['APP_MODE'] }, outputs: { files: ['dist/**'] } },
        },
      },
    }
  `
  const LIB = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && echo lib > dist/out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } },
        },
      },
    }
  `
  beforeAll(async () => {
    root = await makeWorkspaceRoot({ prefix: 'vx-why-kinds-', git: false })
    for (const [name, config, deps] of [
      ['app', APP, { lib: '*' }],
      ['lib', LIB, {}],
    ] as const) {
      const dir = path.join(root, 'packages', name)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name, version: '0.0.0', dependencies: deps }),
      )
      await writeFile(path.join(dir, 'vx.config.mjs'), config)
      await writeFile(path.join(dir, 'src', 'index.js'), 'export {}\n')
    }
    await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n')
    const git = gitIn(root)
    git('init', '-q')
    git('add', '-A')
    await vx(root, ['run', 'build', '--all'])
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const why = async (env: Record<string, string> = {}): Promise<string> => {
    const r = await vx(root, ['why', 'app#build'], env)
    expect(r.code).toBe(0)
    return r.out
  }

  it(
    'env, package, workspace fingerprint, config and upstream, each as its own row',
    async () => {
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      expect(await why({ APP_MODE: 'prod' })).toMatch(/changed\s+env\s+APP_MODE\s+\w+ → \w+/)

      await writeFile(
        path.join(root, 'packages', 'app', 'package.json'),
        JSON.stringify({ name: 'app', version: '0.0.1', dependencies: { lib: '*' } }),
      )
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      expect(await why({ APP_MODE: 'prod' })).toMatch(
        /changed\s+package\s+package\.json\s+\w+ → \w+/,
      )

      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# moved\n')
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      const lock = await why({ APP_MODE: 'prod' })
      expect(lock).toMatch(/changed\s+workspace\s+fingerprint\s+\w+ → \w+/)
      // The lockfile moved lib's key too, and app folds it: the upstream row
      // rides with the fingerprint's.
      expect(lock).toMatch(/changed\s+upstream\s+lib#build\s+\w+ → \w+/)

      const appConfig = path.join(root, 'packages', 'app', 'vx.config.mjs')
      await writeFile(appConfig, APP.replace('echo hi', 'echo hey'))
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      expect(await why({ APP_MODE: 'prod' })).toMatch(/changed\s+config\s+config\s+\w+ → \w+/)

      await writeFile(path.join(root, 'packages', 'lib', 'src', 'index.js'), 'export {}\n// v2\n')
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      const up = await why({ APP_MODE: 'prod' })
      expect(up).toMatch(/what changed \(1 component, \d+ unchanged\)/)
      expect(up).toMatch(/changed\s+upstream\s+lib#build\s+\w+ → \w+/)

      // CONTROL: a hit carries no row.
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      const hit = await why({ APP_MODE: 'prod' })
      expect(hit).toContain('cache key unchanged')
      expect(hit).not.toContain('what changed')
    },
    TIMEOUT,
  )
})

describe('parseWhyArgs', () => {
  it(
    'an UNCACHED task is reported as one — not as a cache decision — by why and last',
    async () => {
      const root = await makeWorkspace()
      try {
        const libDir = path.join(root, 'packages', 'lib')
        await mkdir(path.join(libDir, 'src'), { recursive: true })
        await writeFile(path.join(libDir, 'package.json'), JSON.stringify({ name: 'lib' }))
        // No cache block, no declared outputs: the write lands in the default
        // `**/*` input set, so the second run's key differs from the first —
        // the shape that used to headline "cache key changed (inputs differ)".
        await writeFile(
          path.join(libDir, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'echo built > out.txt' } } } }`,
        )
        gitIn(root)('add', '-A')

        expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
        expect((await vx(root, ['run', 'build', '--all'])).code).toBe(0)
        const why = await vx(root, ['why', 'lib#build'])
        expect(why.code).toBe(0)
        expect(why.out).toContain('declares no `cache` block')
        expect(why.out).not.toContain('inputs differ')
        const last = await vx(root, ['last'])
        expect(last.code).toBe(0)
        const row = last.out.split('\n').find((l) => l.includes('lib#build'))
        expect(row).toContain('no-cache')
        // Control: the cached task's row carries no such marker.
        const cachedRow = last.out.split('\n').find((l) => l.includes('app#build'))
        expect(cachedRow).not.toContain('no-cache')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('parses target, --run and --format in both forms', () => {
    expect(parseWhyArgs(['app#build'])).toEqual({ target: 'app#build', format: 'pretty' })
    expect(parseWhyArgs(['build', '--run', 'r1'])).toEqual({
      target: 'build',
      runId: 'r1',
      format: 'pretty',
    })
    expect(parseWhyArgs(['build', '--run=r1', '--format=json'])).toEqual({
      target: 'build',
      runId: 'r1',
      format: 'json',
    })
  })

  it('rejects unknown flags, bad formats, empty --run, extra positionals', () => {
    expect(parseWhyArgs(['--nope']).error).toContain('unknown flag')
    // --cache-dir with vx run's rules: both spellings, a value required,
    // the space form refusing a flag-shaped value.
    expect(parseWhyArgs(['build', '--cache-dir', 'x']).cacheDir).toBe('x')
    expect(parseWhyArgs(['build', '--cache-dir=y/z']).cacheDir).toBe('y/z')
    expect(parseWhyArgs(['build', '--cache-dir']).error).toMatch(/requires a path/)
    expect(parseWhyArgs(['build', '--cache-dir=']).error).toMatch(/requires a path/)
    expect(parseWhyArgs(['build', '--cache-dir', '--format']).error).toMatch(/got flag/)
    expect(parseWhyArgs(['--format', 'xml']).error).toContain('invalid --format')
    expect(parseWhyArgs(['--run=']).error).toContain('invalid --run')
    expect(parseWhyArgs(['a', 'b']).error).toContain('unexpected argument')
  })

  it.each([
    ['--run', 'invalid --run'],
    ['--format', 'invalid --format'],
  ])('names %s when its value is omitted, instead of calling it unknown', (flag, expected) => {
    // A trailing flag used to consume a non-existent argv slot, fall through
    // to the catch-all, and be reported as `unknown flag: --run` — false, and
    // silent about the real mistake. The `=` spelling of the SAME mistake
    // already said `invalid --run: empty`, so one omitted value got two
    // different diagnoses depending on how it was typed.
    const err = parseWhyArgs(['app#build', flag]).error
    expect({ flag, err }).toEqual({ flag, err: expect.stringContaining(expected) })
    expect(err).not.toContain('unknown flag')
    // And never the literal word "undefined" — an omitted value is empty.
    expect(err).not.toContain('undefined')
  })

  it('still rejects a genuinely unknown flag that merely shares a prefix', () => {
    // Control: the fix matches on the flag NAME, so it must not swallow
    // anything that happens to start with the same letters.
    expect(parseWhyArgs(['--runner']).error).toContain('unknown flag: --runner')
    expect(parseWhyArgs(['--formatting']).error).toContain('unknown flag: --formatting')
  })
})

// The promise that makes `vx why` safe anywhere — its own header ("Read-only
// over cache.db — no config evaluation, no re-hash") and the trusting-the-cache
// guide's "safe to run anywhere, including after the fact on a machine that
// just cloned the cache" — was stated in three places and proven in none. A
// config load added here for a nicer message would break it silently, and the
// user who feels it is the one whose configs no longer evaluate.
describe('vx why (e2e) — answers from the database alone', () => {
  let root: string
  beforeAll(async () => {
    root = await makeWorkspace()
    await vx(root, ['run', 'build', '--all'])
    await writeFile(path.join(root, 'packages', 'app', 'src', 'input.txt'), 'v2\n')
    await vx(root, ['run', 'build', '--all'])
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a project config that throws changes nothing it prints',
    async () => {
      const cfg = path.join(root, 'packages', 'app', 'vx.config.mjs')
      await writeFile(cfg, "throw new Error('PROJECT CONFIG EVALUATED')\n")
      const r = await vx(root, ['why', 'app#build'])
      expect(r.err).not.toContain('PROJECT CONFIG EVALUATED')
      expect(r.code).toBe(0)
      expect(r.out).toContain('cache key changed')
      expect(r.out).toMatch(/changed\s+file\s+.*input\.txt/)
      // The control: the sabotage is real, and a verb that DOES evaluate
      // configs trips on it. Without this the test above passes on a config
      // that was never broken.
      const run = await vx(root, ['run', 'build', '--all'])
      expect(run.code).not.toBe(0)
      expect(`${run.err}${run.out}`).toContain('PROJECT CONFIG EVALUATED')
    },
    TIMEOUT,
  )

  it(
    'with --cache-dir, not even the workspace file is read',
    async () => {
      // The guide states the one exception: the workspace file is evaluated
      // once, to find the cache directory — UNLESS --cache-dir names it.
      const ws = path.join(root, 'vx.workspace.mjs')
      await writeFile(ws, "throw new Error('WORKSPACE FILE EVALUATED')\n")
      const cacheDir = path.join(root, '.vx', 'cache')
      const r = await vx(root, ['why', 'app#build', '--cache-dir', cacheDir])
      expect(r.err).not.toContain('WORKSPACE FILE EVALUATED')
      expect(r.code).toBe(0)
      expect(r.out).toContain('cache key changed')
      // Same control, and it also proves the exception is real: without the
      // flag the workspace file IS evaluated, so this same command fails.
      const noFlag = await vx(root, ['why', 'app#build'])
      expect(`${noFlag.err}${noFlag.out}`).toContain('WORKSPACE FILE EVALUATED')
    },
    TIMEOUT,
  )
})

// The exact lines `vx why` prints: target resolution and its refusals, the
// component rows with their signs and padding, and the fallbacks an older or
// thinned database reaches (rows with no run id, no cache-hit column, no
// entry inputs). Each assertion is a whole line or a whole message.
describe('vx why (e2e) — the exact lines', () => {
  let root: string
  const UNCACHED = (tasks: string[]) =>
    `export default { tasks: { ${tasks.map((t) => `${t}: { exec: { command: 'true' } }`).join(', ')} } }\n`
  const APP = `
    export default {
      tasks: {
        build: {
          exec: { command: 'cat src/*.txt > out.txt' },
          cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
        },
      },
    }
  `
  const err = (r: VxResult): string => r.err.trim()
  beforeAll(async () => {
    root = await makeWorkspaceRoot({ prefix: 'vx-why-lines-', git: false })
    const projects: Array<[string, string]> = [
      ['app', APP],
      ['a', UNCACHED(['build', 'lint'])],
      ['b', UNCACHED(['build', 'prelint'])],
      ['c', UNCACHED(['build'])],
      ['d', UNCACHED(['build'])],
    ]
    for (const [name, config] of projects) {
      const dir = path.join(root, 'packages', name)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
      await writeFile(path.join(dir, 'vx.config.mjs'), config)
    }
    const app = path.join(root, 'packages', 'app')
    await writeFile(path.join(app, 'src', 'input.txt'), 'v1\n')
    await writeFile(path.join(app, 'src', 'old.txt'), 'old\n')
    const git = gitIn(root)
    git('init', '-q')
    git('add', '-A')
    await vx(root, ['run', 'build', 'lint', 'prelint', '--all'])
    // The second run: a file removed, a file added, and the package bumped.
    await unlink(path.join(app, 'src', 'old.txt'))
    await writeFile(path.join(app, 'src', 'new.txt'), 'new\n')
    await writeFile(
      path.join(app, 'package.json'),
      JSON.stringify({ name: 'app', version: '0.0.1' }),
    )
    await vx(root, ['run', 'build', '--all'])
  }, TIMEOUT)
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'a bare name matches the whole task name, not its tail',
    async () => {
      const r = await vx(root, ['why', 'lint'])
      expect(r.code).toBe(0)
      expect(r.out.split('\n')[0]).toMatch(/^a#lint — run \S+$/)
    },
    TIMEOUT,
  )

  it(
    'a bare name several projects ran lists them, and a typo hints three',
    async () => {
      const many = await vx(root, ['why', 'build'])
      expect(many.code).toBe(1)
      expect(err(many)).toBe(
        'vx why: "build" ran in 5 projects — pick one:\n  a#build\n  app#build\n  b#build\n  c#build\n  d#build',
      )
      const typo = await vx(root, ['why', 'buld'])
      expect(err(typo)).toBe(
        'vx why: no recorded runs for task "buld" — did you mean a#build, app#build, b#build?',
      )
    },
    TIMEOUT,
  )

  it(
    'an id with no runs and no near miss is refused without a hint; no target is refused',
    async () => {
      const none = await vx(root, ['why', 'app#zzzzzzzz'])
      expect(none.code).toBe(1)
      expect(err(none)).toBe('vx why: no recorded runs for "app#zzzzzzzz"')
      const bare = await vx(root, ['why'])
      expect(bare.code).toBe(1)
      expect(err(bare)).toBe('vx why: <task> required (e.g. vx why app#build, or vx why build)')
    },
    TIMEOUT,
  )

  it(
    'an added row carries +, a removed row -, and every kind is padded to the longest',
    async () => {
      const r = await vx(root, ['why', 'app#build'])
      expect(r.code).toBe(0)
      const lines = r.out.split('\n')
      expect(lines).toContain('  what changed (3 components, 3 unchanged):')
      const rows = lines.filter((l) => l.startsWith('    '))
      expect(rows).toHaveLength(3)
      expect(rows[0]).toMatch(/^ {4}added {3}file {5}packages\/app\/src\/new\.txt {2}\+ [0-9a-f]+$/)
      expect(rows[1]).toMatch(/^ {4}removed file {5}packages\/app\/src\/old\.txt {2}- [0-9a-f]+$/)
      expect(rows[2]).toMatch(/^ {4}changed package {2}package\.json {2}[0-9a-f]+ → [0-9a-f]+$/)
    },
    TIMEOUT,
  )

  // The rows below edit the database the way an older vx left it; each
  // runs after the one before, and the order is the fixture.
  const edit = (sql: string): void => {
    const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
    try {
      db.run(sql)
    } finally {
      db.close()
    }
  }

  it(
    'a run whose cache-hit column is unknown is not called executed',
    async () => {
      edit("UPDATE runs SET cache_hit = NULL WHERE project = 'app' AND task = 'build'")
      const r = await vx(root, ['why', 'app#build'])
      expect(r.out.split('\n')[1]).toMatch(/^ {2}this run {3}\S+ · success · key [0-9a-f]+$/)
    },
    TIMEOUT,
  )

  it(
    'a changed key with no recorded components says why there is no list',
    async () => {
      edit('DELETE FROM entry_inputs')
      const r = await vx(root, ['why', 'app#build'])
      expect(r.code).toBe(0)
      expect(r.out).not.toContain('what changed')
      expect(r.out.split('\n').filter((l) => l.startsWith('  detail     '))).toHaveLength(1)
    },
    TIMEOUT,
  )

  it(
    'runs with no run id fall back to the latest entry, in both formats, and to nothing',
    async () => {
      edit('UPDATE runs SET run_id = NULL')
      const pretty = await vx(root, ['why', 'app#build'])
      expect(pretty.code).toBe(0)
      const [first, second] = pretty.out.split('\n')
      expect(first).toBe(
        'app#build: recorded runs carry no run id — showing the latest cache entry instead',
      )
      expect(second).toMatch(/^ {2}hash [0-9a-f]+ · \$ cat src\/\*\.txt > out\.txt$/)
      const json = await vx(root, ['why', 'app#build', '--format', 'json'])
      const parsed = JSON.parse(json.out) as Record<string, unknown>
      expect(Object.keys(parsed)).toEqual(['taskId', 'why', 'diff', 'explanation'])
      expect([parsed['why'], parsed['diff']]).toEqual([null, null])
      edit('DELETE FROM entries')
      const bare = await vx(root, ['why', 'app#build'])
      expect(bare.code).toBe(0)
      expect(bare.out.split('\n')[1]).toBe('  (no cache entry either)')
    },
    TIMEOUT,
  )
})
