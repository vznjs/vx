// `vx why` e2e — subprocess-driven like show-info.test.ts so the dispatcher
// wiring, exit codes, and UserError presentation match what a user sees.
// The fixture runs a real task twice with a changed input file so the
// persisted entry_inputs rows carry a genuine component-level diff.

import { readFileSync } from 'node:fs'
import { mkdir, rm, unlink, writeFile } from 'node:fs/promises'
import { Database } from 'bun:sqlite'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { gitIn, makeWorkspace as makeWorkspaceRoot } from './helpers/workspace.js'
import { writeEdges } from './helpers/plugin.js'
import { parseShowArgs } from '../src/cli/show.js'
import { parseWhyArgs } from '../src/cli/why.js'
import { WHAT_TO_DO } from '../src/cli/why.js'
import { noticed } from './helpers/notice.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')
const TIMEOUT = 30_000

const APP_CONFIG = `
  export default {
    tasks: {
      build: {
        exec: { command: 'cat src/input.txt > out.txt' },
        inputs: { files: ['src/**'] },
        cache: {
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
      // Each changed kind gets what to do about it, once.
      expect(r.out).toContain(`  what to do:\n    file  ${WHAT_TO_DO['file']}\n`)
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
    'a bare task name reads its own rows, never every pair of the history',
    async () => {
      // Every statement vx prepares, logged by a preload: the walk over
      // every distinct (project, task) sorted the whole run history (24 of
      // 26 ms at 58k rows) to resolve a name one task's rows answer.
      const log = path.join(root, 'sql.log')
      const preload = path.join(root, 'sql-log.ts')
      await writeFile(
        preload,
        `import { Database } from 'bun:sqlite'
import { appendFileSync } from 'node:fs'
const proto = Database.prototype as any
for (const m of ['query', 'prepare']) {
  const orig = proto[m]
  proto[m] = function (sql: string, ...rest: unknown[]) {
    appendFileSync(${JSON.stringify(log)}, sql.replace(/\\s+/g, ' ') + '\\n')
    return orig.call(this, sql, ...rest)
  }
}
`,
      )
      const sqlFor = async (args: string[]): Promise<string[]> => {
        await rm(log, { force: true })
        const p = Bun.spawnSync([process.execPath, '--preload', preload, BIN, ...args], {
          cwd: root,
          stdout: 'pipe',
          stderr: 'pipe',
        })
        expect(p.stdout.toString() + p.stderr.toString()).toContain('build')
        return readFileSync(log, 'utf8')
          .split('\n')
          .filter((s) => s.includes(' FROM runs'))
      }
      const everyPair = (sql: string[]): boolean =>
        sql.some((s) => s.includes('SELECT DISTINCT project, task FROM runs'))
      expect(everyPair(await sqlFor(['why', 'build']))).toBe(false)
      // Control: a miss still lists every pair, for its suggestions.
      expect(everyPair(await sqlFor(['why', 'buld']))).toBe(true)
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
      expect(r.err).toContain('fix  app#build')
      // A bare typo is matched against the TASK half and hinted as the
      // runnable id — a substring match alone found nothing for `buld`.
      const bare = await vx(root, ['why', 'buld'])
      expect(bare.code).toBe(1)
      expect(bare.err).toContain('fix  app#build')
    },
    TIMEOUT,
  )

  it(
    'a stale --run id errors clearly',
    async () => {
      const r = await vx(root, ['why', 'app#build', '--run', 'nope'])
      expect(r.code).toBe(1)
      expect(r.err).toBe(
        noticed('vx why: no recorded run nope (vx last --list shows recent runs)\n'),
      )
    },
    TIMEOUT,
  )

  // Last: it adds a third run, which the tests above must not see.
  it(
    "a hit's line is its status, what it did to the disk and its key — nothing repeats the hit",
    async () => {
      await vx(root, ['run', 'build', '--all'])
      const r = await vx(root, ['why', 'app#build'])
      expect(r.code).toBe(0)
      // The output was in place: a hit that restored nothing says so.
      expect(r.out).toMatch(/^  this run   \S+ · cache-hit · up-to-date · key [0-9a-f]+$/m)
      expect(r.out).not.toContain('cache hit ·')
      expect(r.out).toContain('served from cache')
    },
    TIMEOUT,
  )
})

// Every component kind a key folds has a verdict row (item 256): the file
// row was pinned above; the env, config and upstream rows were read by eye
// until this walk pinned each one. Core keys no package file: package.json
// is a file row when a task lists it, and a lockfile no plugin claims is no
// row at all.
describe('vx why (e2e) — every component kind names its row', () => {
  let root: string
  const APP = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && echo hi > dist/out.txt' },
          dependsOn: ['^build'],
          inputs: { files: ['src/**', 'package.json'], env: ['APP_MODE'] }, cache: { outputs: { files: ['dist/**'] } },
        },
      },
    }
  `
  const LIB = `
    export default {
      tasks: {
        build: {
          exec: { command: 'mkdir -p dist && echo lib > dist/out.txt' },
          inputs: { files: ['src/**'] }, cache: { outputs: { files: ['dist/**'] } },
        },
      },
    }
  `
  beforeAll(async () => {
    root = await makeWorkspaceRoot({ prefix: 'vx-why-kinds-', git: false, edges: { app: ['lib'] } })
    for (const [name, config] of [
      ['app', APP],
      ['lib', LIB],
    ] as const) {
      const dir = path.join(root, 'packages', name)
      await mkdir(path.join(dir, 'src'), { recursive: true })
      await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0' }))
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
    'env, package.json as an input, config and upstream, each as its own row',
    async () => {
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      expect(await why({ APP_MODE: 'prod' })).toMatch(/changed\s+env\s+APP_MODE\s+\w+ → \w+/)

      await writeFile(
        path.join(root, 'packages', 'app', 'package.json'),
        JSON.stringify({ name: 'app', version: '0.0.1' }),
      )
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      const pkg = await why({ APP_MODE: 'prod' })
      expect(pkg).toMatch(/what changed \(1 component, \d+ unchanged\)/)
      expect(pkg).toMatch(/changed\s+file\s+packages\/app\/package\.json\s+\w+ → \w+/)

      // No plugin claims the lockfile, so no key folds it: a hit.
      await writeFile(path.join(root, 'pnpm-lock.yaml'), 'lockfileVersion: 9\n# moved\n')
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      expect(await why({ APP_MODE: 'prod' })).toContain('cache key unchanged')

      const appConfig = path.join(root, 'packages', 'app', 'vx.config.mjs')
      await writeFile(appConfig, APP.replace('echo hi', 'echo hey'))
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      expect(await why({ APP_MODE: 'prod' })).toMatch(/changed\s+config\s+config\s+\w+ → \w+/)

      await writeFile(path.join(root, 'packages', 'lib', 'src', 'index.js'), 'export {}\n// v2\n')
      await vx(root, ['run', 'build', '--all'], { APP_MODE: 'prod' })
      const up = await why({ APP_MODE: 'prod' })
      expect(up).toMatch(/what changed \(1 component, \d+ unchanged\)/)
      expect(up).toMatch(/changed\s+upstream\s+lib#build\s+\w+ → \w+/)
      // One `vx why` walks to the file, and what to do is the file's.
      expect(up).toContain(
        '  root cause:\n    app#build ← lib#build ← file packages/lib/src/index.js\n\n' +
          '  what to do:\n    file      an edit re-runs by design;',
      )

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

  // "Its key is folded by dependents only" read as if a dependent could
  // hit; a keyless task's key is new each run, so every dependent misses.
  it(
    'an uncached task with no inputs says every dependent misses',
    async () => {
      const root = await makeWorkspace()
      try {
        const libDir = path.join(root, 'packages', 'lib')
        await mkdir(libDir, { recursive: true })
        await writeFile(path.join(libDir, 'package.json'), JSON.stringify({ name: 'lib' }))
        await writeFile(
          path.join(libDir, 'vx.config.mjs'),
          `export default { tasks: { gen: { exec: { command: 'true' } } } }`,
        )
        gitIn(root)('add', '-A')
        expect((await vx(root, ['run', 'gen', '--all'])).code).toBe(0)
        expect((await vx(root, ['run', 'gen', '--all'])).code).toBe(0)
        const why = await vx(root, ['why', 'lib#gen'])
        expect(why.out).toContain(
          'it declares no `inputs` either, so each run derives a new key and every task that depends on it misses',
        )
        expect(why.out).not.toContain('folded by dependents only')
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

  it('an empty target is no target, and vx show refuses one (E-35)', () => {
    // As a query '' is a part of every name: its hint listed the workspace.
    expect(parseWhyArgs([''])).toEqual({ format: 'pretty' })
    expect(parseShowArgs(['']).error).toBe(
      'empty target (omit it to list every project) (see `vx show --help`)',
    )
    // A swallowed flag is no pattern (run's X-13, for show).
    const want = '--filter requires a value: a project name, glob or path (see `vx show --help`)'
    expect(parseShowArgs(['--filter', '--format', 'json']).error).toBe(want)
    expect(parseShowArgs(['--filter']).error).toBe(want)
    // An empty `=` was taken, and the run said `filter "" names no project`.
    expect(parseShowArgs(['--filter=']).error).toBe(want)
    expect(parseShowArgs(['--filter=app']).filters).toEqual(['app'])
  })

  it('rejects unknown flags, bad formats, empty --run, extra positionals', () => {
    expect(parseWhyArgs(['--nope']).error).toContain('unknown flag')
    // --cache-dir with vx run's rules: both spellings, a value required,
    // the space form refusing a flag-shaped value.
    expect(parseWhyArgs(['build', '--cache-dir', 'x']).cacheDir).toBe('x')
    expect(parseWhyArgs(['build', '--cache-dir=y/z']).cacheDir).toBe('y/z')
    expect(parseWhyArgs(['build', '--cache-dir']).error).toBe(
      '--cache-dir requires a path (see `vx why --help`)',
    )
    expect(parseWhyArgs(['build', '--cache-dir=']).error).toBe(
      '--cache-dir requires a path (see `vx why --help`)',
    )
    expect(parseWhyArgs(['build', '--cache-dir', '--format']).error).toMatch(
      /got flag .* \(see `vx why --help`\)$/,
    )
    expect(parseWhyArgs(['--format', 'xml']).error).toBe(
      '--format must be pretty or json (got xml) (see `vx why --help`)',
    )
    expect(parseWhyArgs(['--run=']).error).toBe(
      '--run requires a run id (`vx last --list` shows them) (see `vx why --help`)',
    )
    expect(parseWhyArgs(['a', 'b']).error).toBe('unexpected argument: b (see `vx why --help`)')
  })

  it.each([
    ['--run', '--run requires a run id (`vx last --list` shows them) (see `vx why --help`)'],
    ['--format', '--format requires a value: pretty or json (see `vx why --help`)'],
  ])('names %s when its value is omitted, instead of calling it unknown', (flag, expected) => {
    // A trailing flag used to consume a non-existent argv slot, fall through
    // to the catch-all, and be reported as `unknown flag: --run` — false, and
    // silent about the real mistake. The `=` spelling of the SAME mistake
    // said something else (`invalid --run: empty`), so one omitted value got two
    // different diagnoses depending on how it was typed.
    const err = parseWhyArgs(['app#build', flag]).error
    expect({ flag, err }).toEqual({ flag, err: expected })
    // The `=` spelling of the same mistake reads the same.
    expect(parseWhyArgs(['app#build', `${flag}=`]).error).toBe(expected)
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
      const ws = path.join(root, '.vx/workspace.mjs')
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
          inputs: { files: ['src/**', 'package.json'] }, cache: { outputs: { files: ['out.txt'] } },
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
        noticed(
          'vx why: "build" ran in 5 projects — pick one:\n  a#build\n  app#build\n  b#build\n  c#build\n  d#build',
        ).trimEnd(),
      )
      const typo = await vx(root, ['why', 'buld'])
      expect(err(typo)).toBe(
        noticed(
          'vx why: no recorded runs for task "buld" — did you mean a#build, app#build, b#build?',
        ).trimEnd(),
      )
    },
    TIMEOUT,
  )

  it(
    'an id with no runs and no near miss points at vx last; no target is refused',
    async () => {
      const none = await vx(root, ['why', 'app#zzzzzzzz'])
      expect(none.code).toBe(1)
      expect(err(none)).toBe(
        noticed(
          'vx why: no recorded runs for "app#zzzzzzzz"; `vx last --list` shows what has run',
        ).trimEnd(),
      )
      const bare = await vx(root, ['why'])
      expect(bare.code).toBe(1)
      expect(err(bare)).toBe(
        noticed('vx why: <task> required (e.g. vx why app#build, or vx why build)').trimEnd(),
      )
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
      const head = lines.indexOf('  what changed (3 components, 3 unchanged):')
      const rows = lines.slice(head + 1, lines.indexOf('', head))
      expect(rows).toHaveLength(3)
      // package.json is a file row like any other: core keys no package file.
      expect(rows[0]).toMatch(
        /^ {4}changed file {2}packages\/app\/package\.json {2}[0-9a-f]+ → [0-9a-f]+$/,
      )
      expect(rows[1]).toMatch(/^ {4}added {3}file {2}packages\/app\/src\/new\.txt {2}\+ [0-9a-f]+$/)
      expect(rows[2]).toMatch(/^ {4}removed file {2}packages\/app\/src\/old\.txt {2}- [0-9a-f]+$/)
      // One line per kind, in the rows' order, padded as they are.
      expect(lines.slice(lines.indexOf('  what to do:') + 1, -1)).toEqual([
        `    file  ${WHAT_TO_DO['file']}`,
      ])
    },
    TIMEOUT,
  )

  it(
    'a stored kind the map does not know is listed but gets no what-to-do line',
    async () => {
      // An older (or newer) vx may have stored a kind this one's fold no
      // longer captures; its row prints, and "undefined" never does.
      const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
      const latest = (
        db
          .query(
            "SELECT hash FROM runs WHERE project = 'app' AND task = 'build' ORDER BY rowid DESC LIMIT 1",
          )
          .get() as { hash: string }
      ).hash
      db.run(
        `UPDATE entry_inputs SET components = json_insert(components, '$[#]', json_array('legacy', 'x', 'ab')) WHERE entry_hash = ?`,
        [latest],
      )
      db.close()
      try {
        const r = await vx(root, ['why', 'app#build'])
        const lines = r.out.split('\n')
        expect(lines).toContain('    added   legacy  x  + ab')
        expect(lines.slice(lines.indexOf('  what to do:') + 1, -1)).toEqual([
          `    file    ${WHAT_TO_DO['file']}`,
        ])
      } finally {
        const back = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
        back.run(
          `UPDATE entry_inputs SET components = (SELECT json_group_array(json(j.value)) FROM json_each(components) j WHERE j.value->>0 != 'legacy')`,
        )
        back.close()
      }
    },
    TIMEOUT,
  )

  it(
    'a key the format moved names the upgrade, not an input (X-142)',
    async () => {
      // An upgrade that bumps CACHE_VERSION moves every key with no input
      // changed; the previous entry here stands for the older vx's.
      const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
      const prev = (
        db
          .query(
            "SELECT hash FROM runs WHERE project = 'app' AND task = 'build' ORDER BY rowid DESC LIMIT 1 OFFSET 1",
          )
          .get() as { hash: string }
      ).hash
      const format = (
        db
          .query(
            "SELECT j.value->>2 AS hash FROM entry_inputs, json_each(components) j WHERE entry_hash = ? AND j.value->>0 = 'format'",
          )
          .get(prev) as { hash: string }
      ).hash
      db.run(
        'UPDATE entry_inputs SET components = replace(components, ?, ?) WHERE entry_hash = ?',
        [JSON.stringify(format), '"vx-cache-v0"', prev],
      )
      db.close()
      try {
        const lines = (await vx(root, ['why', 'app#build'])).out.split('\n')
        expect(lines.filter((l) => l.startsWith('    ') && l.includes('format'))).toEqual([
          expect.stringMatching(
            /^ {4}changed format {2}cache-version {2}vx-cache-v0 → vx-cache-v\d+$/,
          ),
          `    format  ${WHAT_TO_DO['format']}`,
        ])
      } finally {
        const back = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
        back.run('UPDATE entry_inputs SET components = replace(components, ?, ?)', [
          '"vx-cache-v0"',
          JSON.stringify(format),
        ])
        back.close()
      }
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
    'a skipped run is not called executed and shows no empty key (item 898)',
    async () => {
      // The latest run becomes the shape a skip records (no key, never a
      // hit), then goes back: the rows below read the fixture as it was.
      const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
      const latest =
        "rowid = (SELECT max(rowid) FROM runs WHERE project = 'app' AND task = 'build')"
      const was = db.query(`SELECT status, hash, cache_hit FROM runs WHERE ${latest}`).get() as {
        status: string
        hash: string
        cache_hit: number | null
      }
      db.run(`UPDATE runs SET status = 'skipped', hash = '', cache_hit = 0 WHERE ${latest}`)
      db.close()
      try {
        const r = await vx(root, ['why', 'app#build'])
        expect(r.out.split('\n')[1]).toMatch(/^ {2}this run {3}\S+ · skipped · no key$/)
      } finally {
        const back = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
        back
          .query(`UPDATE runs SET status = ?, hash = ?, cache_hit = ? WHERE ${latest}`)
          .run(was.status, was.hash, was.cache_hit)
        back.close()
      }
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

describe('vx why in a workspace that never ran (E-39)', () => {
  it('says nothing has run yet, and how to change that', async () => {
    const root = await makeWorkspace()
    try {
      const r = await vx(root, ['why', 'app#build'])
      expect({ code: r.code, err: r.err }).toEqual({
        code: 1,
        err: '› vx why  no runs of app#build yet\n\n  fix  vx run app#build\n',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('vx why after a run of only a group (X-50)', () => {
  it('says no run executed a task, instead of "nothing has run here yet"', async () => {
    const root = await makeWorkspace()
    try {
      // No config: `lib` has only the default `build`, a group, whose `^build` needs an edge source.
      // A configured dependant gives a config-less package its default build.
      await writeEdges(root, { app: ['lib'] })
      const app = path.join(root, 'packages', 'app')
      await mkdir(app, { recursive: true })
      await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
      await writeFile(path.join(app, 'vx.config.mjs'), 'export default { tasks: {} }\n')
      const lib = path.join(root, 'packages', 'lib')
      await mkdir(lib, { recursive: true })
      await writeFile(path.join(lib, 'package.json'), JSON.stringify({ name: 'lib' }))
      expect((await vx(root, ['run', 'lib#build'])).code).toBe(0)
      const r = await vx(root, ['why', 'lib#build'])
      expect({ code: r.code, err: r.err }).toEqual({
        code: 1,
        err: noticed(
          'vx why: no recorded runs for "lib#build"; no recorded run executed a task (a group records none: ask about a task it depends on)\n',
        ),
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 30_000)
})

describe('vx why — what to do', () => {
  it('covers exactly the kinds the key fold captures', () => {
    // From the source of truth, not from the map: every `kind: '…'` the
    // fold pushes, and nothing else.
    const fold = readFileSync(
      path.resolve(import.meta.dir, '..', 'src', 'cache', 'key-fold.ts'),
      'utf8',
    )
    const kinds = [...fold.matchAll(/cap\.push\(\{ kind: '([^']+)'/g)].map((m) => m[1]!)
    expect(kinds.length).toBeGreaterThan(5)
    expect(Object.keys(WHAT_TO_DO).sort()).toEqual([...new Set(kinds)].sort())
  })
})

describe('vx why prints a file name (L-31)', () => {
  it(
    'writes a control character in it as \\xNN, never raw',
    async () => {
      const root = await makeWorkspace()
      try {
        await vx(root, ['run', 'build', '--all'])
        await writeFile(path.join(root, 'packages', 'app', 'src', 'x\x1b]0;owned\x07\ry.txt'), 'z')
        await vx(root, ['run', 'build', '--all'])
        const r = await vx(root, ['why', 'app#build'])
        expect(r.code).toBe(0)
        expect(r.out).toContain('packages/app/src/x\\x1b]0;owned\\x07\\x0dy.txt')
        // oxlint-disable-next-line no-control-regex
        expect(r.out.match(/[\x00-\x09\x0b-\x1f\x7f-\x9f]/g)).toBeNull()
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('vx why — a secret-named env input', () => {
  // Its hashes are its value, unsalted: a short one is recoverable from a CI
  // log that printed `vx why` (M-62). The row names it and says it changed.
  it(
    'shows the name and the change, no hash, in text and in json',
    async () => {
      const root = await makeWorkspaceRoot({ prefix: 'vx-why-secret-', git: false })
      try {
        const appDir = path.join(root, 'packages', 'app')
        await mkdir(path.join(appDir, 'src'), { recursive: true })
        await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'app' }))
        await writeFile(path.join(appDir, 'src', 'input.txt'), 'v1\n')
        await writeFile(
          path.join(appDir, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'cat src/input.txt > out.txt' },
            inputs: { files: ['src/**'], env: ['API_TOKEN', 'REGION'] }, cache: { outputs: { files: ['out.txt'] } } } } }\n`,
        )
        const git = gitIn(root)
        git('init', '-q')
        git('add', '-A')
        await vx(root, ['run', 'build', '--all'], { API_TOKEN: 'secret-one', REGION: 'eu' })
        await vx(root, ['run', 'build', '--all'], { API_TOKEN: 'secret-two', REGION: 'us' })
        const text = await vx(root, ['why', 'app#build'])
        expect(
          text.out
            .split('\n')
            .filter((l) => /^\s+changed\s+env\s/.test(l))
            .map((l) => l.trim().replace(/[0-9a-f]{16}/g, '<hash>')),
        ).toEqual([
          'changed env   API_TOKEN',
          // CONTROL: a name with no secret word keeps its hashes.
          'changed env   REGION  <hash> → <hash>',
        ])
        const json = JSON.parse((await vx(root, ['why', 'app#build', '--format', 'json'])).out) as {
          diff: { entries: { kind: string; name: string; before?: string; after?: string }[] }
        }
        const token = json.diff.entries.find((e) => e.name === 'API_TOKEN')
        expect([token?.before, token?.after]).toEqual(['***', '***'])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a name only exec.env.secret makes secret is hidden too (M-63)',
    async () => {
      const root = await makeWorkspaceRoot({ prefix: 'vx-why-named-', git: false })
      try {
        const appDir = path.join(root, 'packages', 'app')
        await mkdir(path.join(appDir, 'src'), { recursive: true })
        await writeFile(path.join(appDir, 'package.json'), JSON.stringify({ name: 'app' }))
        await writeFile(path.join(appDir, 'src', 'input.txt'), 'v1\n')
        await writeFile(
          path.join(appDir, 'vx.config.mjs'),
          `export default { tasks: { build: { exec: { command: 'cat src/input.txt > out.txt', env: { secret: ['GH_PAT'] } },
            inputs: { files: ['src/**'], env: ['GH_PAT', 'REGION'] }, cache: { outputs: { files: ['out.txt'] } } } } }\n`,
        )
        const git = gitIn(root)
        git('init', '-q')
        git('add', '-A')
        await vx(root, ['run', 'build', '--all'], { GH_PAT: 'pat-value-one', REGION: 'eu' })
        await vx(root, ['run', 'build', '--all'], { GH_PAT: 'pat-value-two', REGION: 'us' })
        const text = await vx(root, ['why', 'app#build'])
        expect(
          text.out
            .split('\n')
            .filter((l) => /^\s+changed\s+env\s/.test(l))
            .map((l) => l.trim().replace(/[0-9a-f]{16}/g, '<hash>')),
        ).toEqual([
          'changed env   GH_PAT',
          // CONTROL: a name neither the rule nor the task calls secret.
          'changed env   REGION  <hash> → <hash>',
        ])
        const json = JSON.parse((await vx(root, ['why', 'app#build', '--format', 'json'])).out) as {
          diff: { entries: { kind: string; name: string; before?: string; after?: string }[] }
        }
        const pat = json.diff.entries.find((e) => e.name === 'GH_PAT')
        expect([pat?.before, pat?.after]).toEqual(['***', '***'])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('vx why — an input another task rewrites', () => {
  it(
    'names the task that was running when the moved file last changed',
    async () => {
      const root = await makeWorkspace()
      const appDir = path.join(root, 'packages', 'app')
      const libDir = path.join(root, 'packages', 'lib')
      try {
        // app#build rewrites a file lib#check's key reads, as documenso's
        // build rewrites @documenso/lib's translations: each run re-keys both.
        await mkdir(path.join(libDir, 'src'), { recursive: true })
        await writeFile(path.join(libDir, 'package.json'), JSON.stringify({ name: 'lib' }))
        await writeFile(path.join(libDir, 'src', 'gen.txt'), '0\n')
        await writeFile(
          path.join(libDir, 'vx.config.mjs'),
          `export default {
            tasks: { check: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: [] } } } },
          }`,
        )
        await writeFile(
          path.join(appDir, 'vx.config.mjs'),
          `export default {
            tasks: {
              build: {
                dependsOn: ['lib#check'],
                exec: { command: 'cat src/input.txt > out.txt && date +%s%N > ../lib/src/gen.txt' },
                inputs: { files: ['src/**'] }, cache: { outputs: { files: ['out.txt'] } },
              },
            },
          }`,
        )
        await vx(root, ['run', 'app#build'])
        await vx(root, ['run', 'app#build'])
        const r = await vx(root, ['why', 'app#build'])
        expect(r.code).toBe(0)
        expect(r.out).toContain(
          '  changed during a run:\n    packages/lib/src/gen.txt  while app#build ran\n',
        )
        expect(r.out).toContain('a task that writes a file a key reads re-keys it every run')
        // The `written` row is padded with the kinds it stands beside: a
        // lone `file` kind left it one column of its own.
        const own = (await vx(root, ['why', 'lib#check'])).out.split('\n')
        expect(own.slice(own.indexOf('  what to do:') + 1, -1)).toEqual([
          `    file     ${WHAT_TO_DO['file']}`,
          '    written  a task that writes a file a key reads re-keys it every run; give that write its own task with the file as an output, or keep the file out of inputs.files',
        ])
        const j = JSON.parse((await vx(root, ['why', 'app#build', '--format', 'json'])).out)
        expect(j.writers).toEqual([
          { taskId: 'lib#check', file: 'packages/lib/src/gen.txt', writers: ['app#build'] },
        ])

        // An edit after the run names no writer.
        await writeFile(path.join(libDir, 'src', 'gen.txt'), 'hand\n')
        const later = JSON.parse((await vx(root, ['why', 'app#build', '--format', 'json'])).out)
        expect(later.writers).toEqual([])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('vx why — a task that never records a key', () => {
  it(
    'a second run of a persistent task is not called its first, and says why nothing compares',
    async () => {
      const root = await makeWorkspace()
      try {
        await writeFile(
          path.join(root, 'packages', 'app', 'vx.config.mjs'),
          `export default { tasks: { dev: { exec: { command: 'true', persistent: {} } } } }`,
        )
        await vx(root, ['run', 'app#dev'])
        await vx(root, ['run', 'app#dev'])
        const r = await vx(root, ['why', 'app#dev'])
        expect(r.code).toBe(0)
        const lines = r.out.split('\n')
        expect(lines[1]).toMatch(/^ {2}this run {3}\S+ · success · executed · no key$/)
        expect(lines.slice(2)).toEqual([
          '  previous   (none with a cache key)',
          '  verdict    this task recorded no cache key (skipped, or a persistent task) — nothing to compare',
          '',
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

describe('vx why — an upstream that is a group', () => {
  it(
    'follows the moved key through the group to the file, and advises no verb on the group',
    async () => {
      const root = await makeWorkspaceRoot({ prefix: 'vx-why-group-', git: false })
      try {
        await writeEdges(root, { app: ['lib'] })
        const configs: Array<[string, string]> = [
          [
            'app',
            `export default { tasks: {
              prep: { dependsOn: ['^build'] },
              test: { dependsOn: ['prep'], exec: { command: 'true' }, inputs: { files: ['a.txt'] }, cache: { outputs: { files: [] } } },
            } }`,
          ],
          [
            'lib',
            `export default { tasks: {
              build: { exec: { command: 'true' }, inputs: { files: ['a.txt'] }, cache: { outputs: { files: [] } } },
            } }`,
          ],
        ]
        for (const [name, config] of configs) {
          const dir = path.join(root, 'packages', name)
          await mkdir(dir, { recursive: true })
          await writeFile(path.join(dir, 'package.json'), JSON.stringify({ name }))
          await writeFile(path.join(dir, 'a.txt'), name)
          await writeFile(path.join(dir, 'vx.config.mjs'), config)
        }
        const git = gitIn(root)
        git('init', '-q')
        git('add', '-A')
        expect((await vx(root, ['run', 'app#test'])).code).toBe(0)
        await writeFile(path.join(root, 'packages', 'lib', 'a.txt'), 'changed')
        expect((await vx(root, ['run', 'app#test'])).code).toBe(0)

        const j = JSON.parse((await vx(root, ['why', 'app#test', '--format', 'json'])).out) as {
          roots: { chain: string[]; entries: { name: string }[] }[]
        }
        expect(j.roots.map((r) => [r.chain.join(' <- '), r.entries.map((e) => e.name)])).toEqual([
          ['app#test <- app#prep <- lib#build', ['packages/lib/a.txt']],
        ])
        const r = await vx(root, ['why', 'app#test'])
        expect(r.out).toContain('app#test ← app#prep ← lib#build ← file packages/lib/a.txt')
        expect(r.out).not.toContain('vx why app#prep')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
