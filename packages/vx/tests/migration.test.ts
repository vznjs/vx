// The migration seam (`workspace/migration.ts`) driven with hand-made plans:
// the report's exact lines, which files a plan writes or refuses, and how a
// task object renders. `vx init` and `@vzn/vx-migrate` reach it through
// their mappers; these rows hold the seam itself.

import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import {
  applyMigration,
  foldScriptHooks,
  isStarterConfig,
  quoteTsLiteral,
  starterProject,
  type ApplyMigrationArgs,
  type GeneratedTask,
  type MigrationPlan,
} from '../src/workspace/index.js'
import { UserError } from '../src/util/index.js'
import { withForwardArgs } from '../src/exec/index.js'

/** The cache TODO a mapper writes (vx-migrate's wording), suggesting `outputs`. */
const cacheTodo = (outputs: string): string =>
  `cache: add \`inputs: { files: ['src/**'] }, cache: { outputs: { files: [${outputs}] } }\` with this package's real inputs and outputs`

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
    expect(await apply(plan([['app', [task('build', exec('tsc'))]]]), { lock })).toBe(0)
    expect(stderr).toBe('vx lock: the migration tool answered no result: run `vx lock`\n')
    expect(stdout).toContain('not written')
  })

  it('a plan with nothing in it names its source', async () => {
    expect(await refusal(() => apply(plan([])))).toBe('nothing to migrate: no tasks in turbo.json')
    expect(await refusal(() => apply(plan([]), { source: 'package.json scripts' }))).toBe(
      'nothing to migrate: no package.json scripts in any workspace member',
    )
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
      packageJson: { name },
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
    const built = { ...exec('tsc'), inputs: { files: [] }, cache: { outputs: { files: [] } } }
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
      "      // inputs: { files: ['src/**'] }, cache: { outputs: { files: ['.next/**', '!.next/cache/**'] } },",
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
        packageJson: { name: 'app' },
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
  const pkg = (name: string, manifest: Record<string, unknown>, tsconfig = true) => {
    const dir = path.join(root, name)
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, ...manifest }))
    if (tsconfig) writeFileSync(path.join(dir, 'tsconfig.json'), '{}')
    return { name, dir, packageJson: { name, ...manifest }, configPath: null }
  }

  it('a TypeScript CommonJS package gets vx.config.mts, which tsc reads as ESM', async () => {
    const metas = [pkg('cjs', {}), pkg('esm', { type: 'module' }), pkg('plain', {}, false)]
    expect(
      await apply(
        plan([
          ['cjs', []],
          ['esm', []],
          ['plain', []],
        ]),
        { metas },
      ),
    ).toBe(0)
    expect(
      ['cjs/vx.config.mts', 'esm/vx.config.ts', 'plain/vx.config.ts'].map((f) =>
        existsSync(path.join(root, f)),
      ),
    ).toEqual([true, true, true])
    expect(existsSync(path.join(root, 'cjs', 'vx.config.ts'))).toBe(false)
    expect(stdout).toContain('  files     cjs/vx.config.mts\n            esm/vx.config.ts\n')
  })

  it('a package.json read from disk opens with a byte-order mark: its type still counts', async () => {
    const { packageJson: _, ...esm } = pkg('esm', {})
    writeFileSync(path.join(esm.dir, 'package.json'), '﻿{"name":"esm","type":"module"}')
    expect(await apply(plan([['esm', []]]), { metas: [esm] })).toBe(0)
    expect(
      ['esm/vx.config.ts', 'esm/vx.config.mts'].map((f) => existsSync(path.join(root, f))),
    ).toEqual([true, false])
  })

  // medusa: the mapping takes the config back as `!vx.config.ts`, and a
  // `*` output then covered the `.mts` written: `vx lock` refused 80 of
  // 84 configs (Growth, 2026-10-14).
  it('the take-back of the own config names the file written', async () => {
    const metas = [pkg('cjs', {})]
    const build = task('build', {
      exec: { command: 'tsc', env: {} },
      inputs: { files: ['src/**'] },
      cache: { outputs: { files: ['*', '!vx.config.ts'] } },
    })
    expect(await apply(plan([['cjs', [build]]]), { metas })).toBe(0)
    const file = readFileSync(path.join(root, 'cjs', 'vx.config.mts'), 'utf8')
    expect(file).toContain("'!vx.config.mts'")
    expect(file).not.toContain("'!vx.config.ts'")
  })

  it('runs the repo’s formatter over what it wrote, and says so', async () => {
    const bin = path.join(root, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'prettier'), `#!/bin/sh\necho "$@" > "${root}/.prettier-args"\n`)
    chmodSync(path.join(bin, 'prettier'), 0o755)
    expect(await apply(plan([['a', [task('build', { exec: { command: 'x' } })]]]))).toBe(0)
    expect(readFileSync(path.join(root, '.prettier-args'), 'utf8').trim()).toBe(
      '--write a/vx.config.ts .vx/workspace.ts',
    )
    expect(stdout).toContain('  note      formatted 2 files with prettier\n')
  })

  it('a dry run formats nothing', async () => {
    const bin = path.join(root, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'prettier'), `#!/bin/sh\ntouch "${root}/.prettier-ran"\n`)
    chmodSync(path.join(bin, 'prettier'), 0o755)
    expect(await apply(plan([['a', [task('build', null)]]]), { dry: true })).toBe(0)
    expect(existsSync(path.join(root, '.prettier-ran'))).toBe(false)
  })

  it('a formatter that fails leaves the files as written and names the error', async () => {
    const bin = path.join(root, 'node_modules', '.bin')
    mkdirSync(bin, { recursive: true })
    writeFileSync(path.join(bin, 'prettier'), '#!/bin/sh\necho "no parser" >&2\nexit 2\n')
    chmodSync(path.join(bin, 'prettier'), 0o755)
    expect(await apply(plan([['a', [task('build', null)]]]))).toBe(0)
    expect(existsSync(path.join(root, 'a', 'vx.config.ts'))).toBe(true)
    expect(stdout).toContain(
      '  note      prettier did not format the written files (exit 2): no parser\n',
    )
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

describe('foldScriptHooks runs the hooks as npm does', () => {
  const run = async (command: string, args: string[] = []) => {
    const full = withForwardArgs(command, args)
    const p = Bun.spawn(['sh', '-c', full], { stdout: 'pipe', stderr: 'ignore' })
    const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited])
    return { code, out: out.trim().split('\n') }
  }

  it('hands the forwarded args to the body alone, not the post hook', async () => {
    expect(
      await run(foldScriptHooks('echo PRE', 'echo BODY', 'echo POST'), ['--flag', 'a b']),
    ).toEqual({ code: 0, out: ['PRE', 'BODY --flag a b', 'POST'] })
  })

  it('stops at a failing pre hook even when the body holds a `;`', async () => {
    expect(await run(foldScriptHooks('false', 'echo A; echo B', 'echo POST'))).toEqual({
      code: 1,
      out: [''],
    })
  })

  it('runs no post hook after a failing body, and keeps the body’s code', async () => {
    expect(await run(foldScriptHooks(undefined, 'echo A; exit 3', 'echo POST'))).toEqual({
      code: 3,
      out: ['A'],
    })
  })

  it('survives a trailing comment in any part', async () => {
    expect(await run(foldScriptHooks('echo PRE # c', 'echo BODY # c', 'echo POST # c'))).toEqual({
      code: 0,
      out: ['PRE', 'BODY', 'POST'],
    })
  })

  it('appends the args as text, as npm does: no part sees them as $1 (hunt 8)', async () => {
    const fold = foldScriptHooks('echo pre:$1:$#', 'echo body:$1:$#: "$*"', 'echo post:$1:$#')
    expect(await run(fold, ['foo', "it's", 'a b', '$HOME'])).toEqual({
      code: 0,
      out: ['pre::0', "body::0:  foo it's a b $HOME", 'post::0'],
    })
    const npm = await run('echo body:$1:$#: "$*"', ['foo', "it's", 'a b', '$HOME'])
    expect(npm.out[0]).toBe("body::0:  foo it's a b $HOME")
  })

  it('CONTROL: a script with no hooks is its body, verbatim', () => {
    expect(foldScriptHooks(undefined, 'tsc -b && echo x', undefined)).toBe('tsc -b && echo x')
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
