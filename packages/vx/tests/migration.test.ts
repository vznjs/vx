// The migration seam (`workspace/migration.ts`) driven with hand-made plans:
// the report's exact lines, which files a plan writes or refuses, and how a
// task object renders. `vx init` and `@vzn/vx-migrate` reach it through
// their mappers; these rows hold the seam itself.

import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import {
  isStarterConfig,
  quoteTsLiteral,
  starterProject,
  type ApplyMigrationArgs,
  type GeneratedTask,
  type MigrationPlan,
} from '../src/workspace/index.js'
import { applyMigration } from '../src/orchestrator/index.js'
import { UserError } from '../src/util/index.js'

/** The cache TODO a mapper writes (vx-migrate's wording), suggesting `outputs`. */
const cacheTodo = (outputs: string): string =>
  `cache: add \`inputs: { files: ['src/**'] }, outputs: { files: [${outputs}] }, cache: true\` with this package's real inputs and outputs`

let root: string
let stdout: string
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), 'vx-migration-'))
  writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'root' }))
  stdout = ''
  vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    stdout += String(chunk)
    return true
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(root, { recursive: true, force: true })
})

const task = (name: string, body: Record<string, unknown> | null, todos: string[] = []) =>
  ({ name, todos, task: body }) as GeneratedTask
const plan = (projects: Array<[string, GeneratedTask[]]>): MigrationPlan => ({
  headerNotes: [],
  projects: projects.map(([name, tasks]) => ({
    name,
    dir: path.join(root, name),
    importLines: [],
    tasks,
  })),
  extraFiles: [],
  notes: [],
})
const apply = (p: MigrationPlan, over: Partial<ApplyMigrationArgs> = {}) =>
  applyMigration({
    root,
    metas: [],
    plan: p,
    source: 'turbo.json',
    verb: 'vx-migrate',
    dry: false,
    force: false,
    ...over,
  })
const refusal = async (run: () => Promise<unknown>): Promise<string> => {
  try {
    await run()
  } catch (err) {
    expect(err).toBeInstanceOf(UserError)
    return (err as Error).message
  }
  throw new Error('expected a refusal')
}
const exec = (command: string) => ({ exec: { command } })

describe('quoteTsLiteral', () => {
  it('escapes a carriage return, which ends a single-quoted literal like a newline', async () => {
    expect(quoteTsLiteral('a\rb')).toBe("'a\\rb'")
    // A generated file must load: round-trip the literal through a module.
    const file = path.join(root, 'literal.mjs')
    writeFileSync(file, `export default ${quoteTsLiteral("x\r\n'\\y")}\n`)
    expect((await import(file)).default).toBe("x\r\n'\\y")
  })

  // A script's raw ESC (`echo \u001b]0;title\u0007`) was written into the
  // file as the byte itself, and reading the file retitled the terminal.
  it('writes every other control as its escape, and the literal loads back as the same string', async () => {
    const raw = 'echo \u001b]0;pwn\u0007 \t\u0000\u007f\u009b'
    const lit = quoteTsLiteral(raw)
    // oxlint-disable-next-line no-control-regex
    expect(/[\x00-\x1f\x7f-\x9f]/.test(lit)).toBe(false)
    const file = path.join(root, 'controls.mjs')
    writeFileSync(file, `export default ${lit}\n`)
    expect((await import(file)).default).toBe(raw)
  })
})

describe('applyMigration', () => {
  it('a lock step of another vx-migrate version is reported, not a crash', async () => {
    // vx-migrate 0.0.637's lock step returned its exit code; core 0.0.639
    // wrote `undefined` to stderr and died with ERR_STREAM_NULL_VALUES.
    let stderr = ''
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk) => {
      stderr += String(chunk)
      return true
    })
    mkdirSync(path.join(root, 'app'))
    const lock = (async () => 1) as unknown as NonNullable<ApplyMigrationArgs['lock']>
    // No lock written: the migration is not done, as `vx init` exits.
    expect(await apply(plan([['app', [task('build', exec('tsc'))]]]), { lock })).toBe(1)
    expect(stderr).toBe('vx lock: the migration tool answered no result: run `vx lock`\n')
    expect(stdout).toContain('not written')
  })

  it('a plan with nothing in it names its source, or the reason its tool gives', async () => {
    expect(await refusal(() => apply(plan([])))).toBe('nothing to migrate: no tasks in turbo.json')
    expect(
      await refusal(() =>
        apply(plan([]), { source: 'moon.yml', emptyReason: 'no task in any moon.yml' }),
      ),
    ).toBe('nothing to migrate: no task in any moon.yml')
  })

  it('an empty init plan says why, and shows the example unless the reason replaces it', async () => {
    const tasksRow = () => stdout.split('\n').find((l) => l.startsWith('  tasks'))
    expect(await apply(plan([]), { source: 'Cargo.toml', init: true })).toBe(0)
    expect(tasksRow()).toBe('  tasks     none: no tasks in Cargo.toml')
    expect(stdout).toContain(
      '  example   a vx.config.ts in a project directory, with your own command:',
    )
    stdout = ''
    rmSync(path.join(root, '.vx'), { recursive: true })
    expect(await apply(plan([]), { init: true, emptyReason: 'members out of reach' })).toBe(0)
    expect(tasksRow()).toBe('  tasks     none: members out of reach')
    expect(stdout).not.toContain('  example ')
    stdout = ''
    rmSync(path.join(root, '.vx'), { recursive: true })
    expect(
      await apply(plan([]), { init: true, emptyReason: 'no script to map', example: true }),
    ).toBe(0)
    expect(tasksRow()).toBe('  tasks     none: no script to map')
    expect(stdout).toContain('  example   ')
  })

  it('marks each TODO with the tool that wrote it', async () => {
    const t = task('build', exec('cargo build'), ['cache: declare inputs'])
    expect(await apply(plan([['app', [t]]]), { verb: 'moon-migrate' })).toBe(0)
    expect(readFileSync(path.join(root, 'app', 'vx.config.ts'), 'utf8')).toContain(
      '    // TODO(moon-migrate): cache: declare inputs\n',
    )
  })

  it('refuses a plan that writes outside the root, and writes nothing', async () => {
    const out = path.join(path.dirname(root), `${path.basename(root)}-out`)
    mkdirSync(path.join(root, 'app'))
    mkdirSync(out)
    try {
      const rel = path.relative(root, out)
      expect(
        await refusal(() =>
          apply(
            plan([
              ['app', []],
              [rel, [task('build', exec('tsc'))]],
            ]),
          ),
        ),
      ).toBe(`${rel}/vx.config.ts: outside the workspace root`)
      expect(existsSync(path.join(out, 'vx.config.ts'))).toBe(false)
      expect(existsSync(path.join(root, 'app', 'vx.config.ts'))).toBe(false)
      const extra = {
        ...plan([['app', []]]),
        extraFiles: [{ relPath: 'a/../../x.ts', contents: '' }],
      }
      expect(await refusal(() => apply(extra))).toBe('a/../../x.ts: outside the workspace root')
      expect(existsSync(path.join(path.dirname(root), 'x.ts'))).toBe(false)
    } finally {
      rmSync(out, { recursive: true, force: true })
    }
  })

  it('writes a config for a project with no tasks too, and no workspace file beside a .js one', async () => {
    mkdirSync(path.join(root, '.vx'), { recursive: true })
    writeFileSync(path.join(root, '.vx/workspace.js'), 'export default { plugins: [] }\n')
    mkdirSync(path.join(root, 'app'))
    mkdirSync(path.join(root, 'empty'))
    await apply(
      plan([
        ['app', [task('build', exec('tsc'))]],
        ['empty', []],
      ]),
    )
    expect(existsSync(path.join(root, 'app', 'vx.config.ts'))).toBe(true)
    // 2026-10-14: "no skips. every project gets a config".
    expect(readFileSync(path.join(root, 'empty', 'vx.config.ts'), 'utf8')).toBe(
      "import type { ProjectConfig } from '@vzn/vx/config'\n\nexport default {\n  tasks: {},\n} satisfies ProjectConfig\n",
    )
    expect(existsSync(path.join(root, '.vx/workspace.ts'))).toBe(false)
  })

  it('refuses beside a hand-written config of another extension, and not for a project it skips', async () => {
    for (const name of ['app', 'empty']) {
      mkdirSync(path.join(root, name))
      writeFileSync(path.join(root, name, 'vx.config.mjs'), 'export default {}\n')
    }
    const metas = ['app', 'empty'].map((name) => ({
      name,
      dir: path.join(root, name),
      configPath: path.join(root, name, 'vx.config.mjs'),
    }))
    expect(
      await refusal(() =>
        apply(
          plan([
            ['app', [task('build', exec('tsc'))]],
            ['empty', []],
          ]),
          { metas },
        ),
      ),
    ).toBe('refusing to overwrite existing files (pass --force to overwrite):\n  app/vx.config.mjs')
  })

  it('a TODO holding a line break stays a comment in the written config (D-21)', async () => {
    mkdirSync(path.join(root, 'app'))
    await apply(
      plan([
        [
          'app',
          [
            task('build', exec('tsc'), [
              'env key "A\nexport const leaked = 1" is not set',
              'and\u2028export const two = 2\r\nthree',
            ]),
          ],
        ],
      ]),
      { format: 'mjs' },
    )
    const file = path.join(root, 'app', 'vx.config.mjs')
    const mod = (await import(file)) as Record<string, unknown>
    expect(Object.keys(mod)).toEqual(['default'])
    expect(readFileSync(file, 'utf8')).toContain('    //   export const leaked = 1" is not set')
  })

  it('counts a skipped target as neither clean nor a TODO, in the singular', async () => {
    mkdirSync(path.join(root, 'app'))
    await apply(
      plan([
        ['app', [task('build', exec('tsc')), task('lint', null), task('e2e', exec('x'), ['why'])]],
      ]),
    )
    const lines = stdout.split('\n')
    expect(lines).toContain('  tasks     1 clean · 1 todo')
    expect(lines).toContain('  todo      app#e2e: why')
  })

  it('a reason several tasks share prints once, under their ids', async () => {
    mkdirSync(path.join(root, 'app'))
    mkdirSync(path.join(root, 'lib'))
    await apply(
      plan([
        ['app', [task('dev', exec('x'), ['set readyWhen']), task('e2e', exec('y'), ['why'])]],
        ['lib', [task('dev', exec('x'), ['set readyWhen'])]],
      ]),
    )
    const lines = stdout.split('\n')
    const at = lines.indexOf('  tasks     3 todo')
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '  todo      app#dev, lib#dev:',
      '              set readyWhen',
      '            app#e2e: why',
    ])
    // Past five ids the rest is a count: the generated files name each.
    stdout = ''
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => task(n, exec('x'), ['r']))
    await apply(plan([['app', many]]), { force: true })
    expect(stdout.split('\n')).toContain(
      '  todo      app#a, app#b, app#c, app#d, app#e and 2 more:',
    )
  })

  // Every fact said once (2026-10-15): the cache TODO already says the
  // task always runs without the block; a line after it said it again.
  it('says the cache TODO once, with no second line about caching', async () => {
    mkdirSync(path.join(root, 'app'))
    await apply(
      plan([
        ['app', [task('build', exec('next build'), [cacheTodo("'.next/**', '!.next/cache/**'")])]],
      ]),
    )
    const rows = stdout.split('\n').filter((l) => /cache/.test(l))
    expect(rows).toEqual([`  todo      app#build: ${cacheTodo("'.next/**', '!.next/cache/**'")}`])
  })

  it('puts the suggested cache block in the task, commented', async () => {
    mkdirSync(path.join(root, 'app'))
    const built = { ...exec('tsc'), inputs: { files: [] }, outputs: { files: [] }, cache: true }
    await apply(
      plan([
        [
          'app',
          [
            task('build', exec('next build'), [cacheTodo("'.next/**', '!.next/cache/**'")]),
            task('pack', built, [cacheTodo("'dist/**'")]),
          ],
        ],
      ]),
    )
    const lines = readFileSync(path.join(root, 'app', 'vx.config.ts'), 'utf8').split('\n')
    const suggested = lines.filter((l) => l.startsWith('      // inputs: '))
    expect(suggested).toEqual([
      "      // inputs: { files: ['src/**'] }, outputs: { files: ['.next/**', '!.next/cache/**'] }, cache: true,",
    ])
    expect(lines[lines.indexOf(suggested[0]!) - 1]).toBe('    build: {')
  })

  it('a run with no TODO names only the clean count', async () => {
    mkdirSync(path.join(root, 'app'))
    await apply(plan([['app', [task('build', exec('tsc')), task('lint', exec('x'))]]]))
    expect(stdout.split('\n')).toContain('  tasks     2 clean')
  })

  it('a dry run says nothing was written', async () => {
    mkdirSync(path.join(root, 'app'))
    await apply(plan([['app', [task('build', exec('tsc'))]]]), { dry: true })
    expect(stdout.split('\n')).toContain('  dry run   nothing written')
    expect(existsSync(path.join(root, 'app', 'vx.config.ts'))).toBe(false)
  })

  it('next names build wherever it sits, else the first task', async () => {
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    mkdirSync(path.join(root, 'app'))
    await apply(plan([['app', [task('lint', exec('x')), task('build', exec('tsc'))]]]), {
      force: true,
    })
    expect(stdout.trimEnd().split('\n').at(-1)).toBe('  next      vx lock, then vx run build --all')
    stdout = ''
    await apply(plan([['app', [task('lint', exec('x')), task('test', exec('y'))]]]), {
      force: true,
    })
    expect(stdout.trimEnd().split('\n').at(-1)).toBe('  next      vx lock, then vx run lint --all')
  })

  it("writes a plan's import lines and a raw expression as code, not as strings (D-22)", async () => {
    // The Nx and Turbo mappers hand over an import and a value that must
    // stay code (`nxExec`); quoted, the config names a string, not the call.
    mkdirSync(path.join(root, 'app'))
    const p = plan([['app', [task('build', { exec: { command: { raw: 'cmd()' } } })]]])
    p.projects[0]!.importLines = ["import { cmd } from './cmd.mjs'"]
    await apply(p, { format: 'mjs' })
    const file = readFileSync(path.join(root, 'app', 'vx.config.mjs'), 'utf8')
    expect(file.startsWith("import { cmd } from './cmd.mjs'\n")).toBe(true)
    expect(file).toContain('\n        command: cmd(),\n')
  })

  it('--force over a config of the SAME name keeps the one it wrote (D-22)', async () => {
    // Only a config of another extension is replaced; unlinked after the
    // write, the same name would leave the project with no config at all.
    mkdirSync(path.join(root, 'app'))
    const existing = path.join(root, 'app', 'vx.config.ts')
    writeFileSync(existing, 'export default {}\n')
    const metas = [
      {
        name: 'app',
        dir: path.join(root, 'app'),
        configPath: existing,
      },
    ]
    await apply(plan([['app', [task('build', exec('tsc'))]]]), { metas, force: true })
    expect(readFileSync(existing, 'utf8')).toContain("command: 'tsc'")
    expect(stdout).not.toContain('replaced:')
  })

  it('renders null, drops undefined, writes {} for an empty object, and quotes only a key that needs it', async () => {
    mkdirSync(path.join(root, 'app'))
    await apply(
      plan([
        [
          'app',
          [
            task('build', {
              exec: { command: 'tsc', env: {} },
              description: undefined,
              meta: { 'dash-key': 1, plain: null },
            }),
          ],
        ],
      ]),
    )
    const file = readFileSync(path.join(root, 'app', 'vx.config.ts'), 'utf8')
    expect(file).toContain(
      [
        '    build: {',
        '      exec: {',
        "        command: 'tsc',",
        '        env: {},',
        '      },',
        '      meta: {',
        "        'dash-key': 1,",
        '        plain: null,',
        '      },',
        '    },',
      ].join('\n'),
    )
  })
})

// Item 905: npm runs `pre<x>`, `x` and `post<x>` as three scripts. The fold
// is one sh command, run the way the runner runs a task: `sh -c` over the
// command with the forwarded args appended, quoted (runner.ts).
// Growth's parity run, 2026-10-14: the written config broke the repo's own
// checks. medusa's plugin builds run tsc (node16) over a CommonJS package,
// where a `.ts` type-imports the ESM `@vzn/vx/config` and fails (TS1479 /
// TS1541); create-t3-turbo's `prettier --check` flagged the file's quotes.
describe('a written config passes the repo’s own checks', () => {
  const member = (name: string, esModule: boolean | undefined, tsconfig = true) => {
    const dir = path.join(root, name)
    mkdirSync(dir, { recursive: true })
    if (tsconfig) writeFileSync(path.join(dir, 'tsconfig.json'), '{}')
    return { name, dir, configPath: null, ...(esModule === undefined ? {} : { esModule }) }
  }

  it('beside a tsconfig.json tsc reads as CommonJS, the config is vx.config.mts', async () => {
    const metas = [
      member('cjs', false),
      member('esm', true),
      member('plain', false, false),
      member('unknown', undefined),
    ]
    expect(
      await apply(
        plan([
          ['cjs', []],
          ['esm', []],
          ['plain', []],
          ['unknown', []],
        ]),
        { metas },
      ),
    ).toBe(0)
    expect(
      ['cjs/vx.config.mts', 'esm/vx.config.ts', 'plain/vx.config.ts', 'unknown/vx.config.mts'].map(
        (f) => existsSync(path.join(root, f)),
      ),
    ).toEqual([true, true, true, true])
    expect(existsSync(path.join(root, 'cjs', 'vx.config.ts'))).toBe(false)
    expect(stdout).toContain('  files     cjs/vx.config.mts\n            esm/vx.config.ts\n')
  })

  // A `*` output covered the `.mts` written while the plan took back
  // `!vx.config.ts`, and `vx lock` refused the config.
  it('the take-back of the own config names the file written', async () => {
    const metas = [member('cjs', false)]
    const build = task('build', {
      exec: { command: 'tsc', env: {} },
      inputs: { files: ['src/**'] },
      outputs: { files: ['*', '!vx.config.ts'] },
      cache: true,
    })
    expect(await apply(plan([['cjs', [build]]]), { metas })).toBe(0)
    const file = readFileSync(path.join(root, 'cjs', 'vx.config.mts'), 'utf8')
    expect(file).toContain("'!vx.config.mts'")
    expect(file).not.toContain("'!vx.config.ts'")
  })

  it('hands the files written to the tool’s own step, and reports its lines', async () => {
    const seen: (readonly string[])[] = []
    const written = (paths: readonly string[]) => {
      seen.push(paths)
      expect(existsSync(path.join(root, 'a', 'vx.config.ts'))).toBe(true)
      return ['formatted with fmt']
    }
    expect(await apply(plan([['a', [task('build', exec('x'))]]]), { written })).toBe(0)
    expect(seen).toEqual([['a/vx.config.ts', '.vx/workspace.ts', '.vx/.gitignore']])
    expect(stdout).toContain('  note      formatted with fmt\n')
  })

  it('a dry run calls no step after the write', async () => {
    let called = false
    const written = () => ((called = true), [])
    expect(await apply(plan([['a', [task('build', null)]]]), { dry: true, written })).toBe(0)
    expect(called).toBe(false)
  })
})

// Bug hunt, 2026-10-14: a root .gitignore from the old layout drops `.vx`,
// where the workspace config and lock now live, so neither reached git and
// CI found no workspace. The note's `!workspace.ts` could not help: git
// re-includes nothing under an excluded directory.
describe('a root .gitignore that drops .vx', () => {
  beforeEach(() => {
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })

  it('stays untouched, and the note names the directory, not a ! line that cannot work', async () => {
    writeFileSync(path.join(root, '.gitignore'), 'node_modules\n/.vx/\ndist\n')
    expect(await apply(plan([['a', [task('build', null)]]]))).toBe(0)
    expect(readFileSync(path.join(root, '.gitignore'), 'utf8')).toBe('node_modules\n/.vx/\ndist\n')
    expect(stdout).toContain(
      'stop ignoring .vx/ (a ! line cannot re-include a file inside an ignored directory)',
    )
    expect(stdout).not.toContain('!workspace.ts')
  })

  it('CONTROL: a file ignored by its own name still gets the ! line', async () => {
    writeFileSync(path.join(root, '.gitignore'), 'vx.config.ts\n')
    expect(await apply(plan([['a', [task('build', null)]]]))).toBe(0)
    expect(stdout).toContain('add !vx.config.ts to .gitignore')
    expect(stdout).not.toContain('stop ignoring')
  })
})

describe('isStarterConfig', () => {
  it("is the starter of the file's own format only", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'vx-starter-'))
    try {
      const at = (name: string, text: string): boolean => {
        writeFileSync(path.join(dir, name), text)
        return isStarterConfig(path.join(dir, name))
      }
      expect([
        at('vx.config.ts', starterProject('ts')),
        at('vx.config.mjs', starterProject('mjs')),
        // A user's own config that happens to read as the other starter.
        at('vx.config.ts', starterProject('mjs')),
        at('vx.config.mjs', starterProject('ts')),
      ]).toEqual([true, true, false, false])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
