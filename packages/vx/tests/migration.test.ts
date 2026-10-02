// The migration seam (`workspace/migration.ts`) driven with hand-made plans:
// the report's exact lines, which files a plan writes or refuses, and how a
// task object renders. `vx init` and `@vzn/vx-migrate` reach it through
// their mappers; these rows hold the seam itself.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'bun:test'
import {
  applyMigration,
  foldScriptHooks,
  quoteTsLiteral,
  type ApplyMigrationArgs,
  type GeneratedTask,
  type MigrationPlan,
} from '../src/workspace/index.js'
import { cacheTodo } from '../src/workspace/migration.js'
import { UserError } from '../src/util/index.js'
import { withForwardArgs } from '../src/exec/index.js'

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
  it('a plan with nothing in it names its source', async () => {
    expect(await refusal(() => apply(plan([])))).toBe('nothing to migrate: no tasks in turbo.json')
    expect(await refusal(() => apply(plan([]), { source: 'package.json scripts' }))).toBe(
      'nothing to migrate: no package.json scripts in any workspace member',
    )
  })

  it('writes no config for a project with no tasks, and no workspace file beside a .js one', async () => {
    writeFileSync(path.join(root, 'vx.workspace.js'), 'export default { plugins: [] }\n')
    mkdirSync(path.join(root, 'app'))
    mkdirSync(path.join(root, 'empty'))
    await apply(
      plan([
        ['app', [task('build', exec('tsc'))]],
        ['empty', []],
      ]),
    )
    expect(existsSync(path.join(root, 'app', 'vx.config.ts'))).toBe(true)
    expect(existsSync(path.join(root, 'empty', 'vx.config.ts'))).toBe(false)
    expect(existsSync(path.join(root, 'vx.workspace.ts'))).toBe(false)
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
    expect(lines).toContain('1 task migrated clean, 1 TODO:')
    expect(lines).toContain('  app#e2e: why')
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
    const at = lines.indexOf('0 tasks migrated clean, 3 TODOs:')
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '  app#dev, lib#dev:',
      '    set readyWhen',
      '  app#e2e: why',
    ])
    // Past five ids the rest is a count: the generated files name each.
    stdout = ''
    const many = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map((n) => task(n, exec('x'), ['r']))
    await apply(plan([['app', many]]), { force: true })
    expect(stdout.split('\n')).toContain('  app#a, app#b, app#c, app#d, app#e and 2 more:')
  })

  it('says a cache block makes the second run hit when no task caches', async () => {
    const hint = 'no task caches yet: add the cache block a TODO shows, and a second run hits'
    mkdirSync(path.join(root, 'app'))
    await apply(plan([['app', [task('build', exec('next build'), [cacheTodo('next build')])]]]))
    expect(stdout.split('\n')).toContain(hint)
    // A task that already caches: the run can hit, and the line would mislead.
    stdout = ''
    const built = { ...exec('tsc'), cache: { inputs: { files: [] }, outputs: { files: [] } } }
    await apply(
      plan([['app', [task('build', built), task('pack', exec('x'), [cacheTodo('x')])]]]),
      {
        force: true,
      },
    )
    expect(stdout).toContain('1 task migrated clean, 1 TODO:')
    expect(stdout.split('\n')).not.toContain(hint)
  })

  it('no TODOs is plural and takes no colon', async () => {
    mkdirSync(path.join(root, 'app'))
    await apply(plan([['app', [task('build', exec('tsc')), task('lint', exec('x'))]]]))
    expect(stdout.split('\n')).toContain('2 tasks migrated clean, 0 TODOs')
  })

  it('a dry run says nothing was written', async () => {
    mkdirSync(path.join(root, 'app'))
    await apply(plan([['app', [task('build', exec('tsc'))]]]), { dry: true })
    expect(stdout.split('\n')).toContain('files (dry run, nothing written):')
    expect(existsSync(path.join(root, 'app', 'vx.config.ts'))).toBe(false)
  })

  it('next names build wherever it sits, else the first task', async () => {
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    mkdirSync(path.join(root, 'app'))
    await apply(plan([['app', [task('lint', exec('x')), task('build', exec('tsc'))]]]), {
      force: true,
    })
    expect(stdout.trimEnd().split('\n').at(-1)).toBe('next: vx run build --all')
    stdout = ''
    await apply(plan([['app', [task('lint', exec('x')), task('test', exec('y'))]]]), {
      force: true,
    })
    expect(stdout.trimEnd().split('\n').at(-1)).toBe('next: vx run lint --all')
  })

  it("writes a plan's import lines and a raw expression as code, not as strings (D-22)", async () => {
    // The Nx and Turbo mappers hand over an import and a value that must
    // stay code (`nxExec`); quoted, the config names a string, not the call.
    mkdirSync(path.join(root, 'app'))
    const p = plan([['app', [task('build', { exec: { command: { raw: 'cmd()' } } })]]])
    p.projects[0]!.importLines = ["import { cmd } from './cmd.mjs'"]
    await apply(p, { format: 'mjs' })
    const file = readFileSync(path.join(root, 'app', 'vx.config.mjs'), 'utf8')
    expect(file).toContain("\nimport { cmd } from './cmd.mjs'\n")
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

  it('CONTROL: a script with no hooks is its body, verbatim', () => {
    expect(foldScriptHooks(undefined, 'tsc -b && echo x', undefined)).toBe('tsc -b && echo x')
  })
})
