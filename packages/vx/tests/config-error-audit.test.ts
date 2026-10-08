// What `vx run` says for a malformed project config, pinned whole: each
// message names the file, and the field when there is one — a syntax
// error its line and column, a missing default export the export, a
// schema violation the field's path from `tasks` and, when the field is
// in the file, its line and column with that line under it.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** `vx run build --all --dry` over one member `p` with `config` as its vx.config.ts. */
const run = async (config: string) => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-cfg-err-')))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["p"]}')
  await mkdir(path.join(root, 'p'))
  await writeFile(path.join(root, 'p', 'package.json'), '{"name":"p"}')
  await writeFile(path.join(root, 'p', 'vx.config.ts'), config)
  const proc = Bun.spawn(['bun', BIN, 'run', 'build', '--all', '--dry'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, err: err.replaceAll(root, '<root>').trim() }
}

/** A schema refusal as printed: the file at the field's line and column, then that line. */
const framed =
  (col: number, said: string) =>
  (config: string): string =>
    `vx: p/vx.config.ts:1:${col}${said}\n\n> 1 | ${config.trim()}\n    | ${' '.repeat(col - 1)}^`

const task = (fields: string) => `export default { tasks: { build: { ${fields} } } }\n`
const CACHE_IN = "inputs: { files: ['src/**'] }"

it.each([
  [
    'a syntax error, by line and column',
    'export default { tasks: {}\n',
    'vx: Project config <root>/p/vx.config.ts:1:27: Expected "}" but found end of file',
  ],
  [
    'named exports and no default',
    'export const config = { tasks: {} }\n',
    'vx: Project config at <root>/p/vx.config.ts did not export a default object',
  ],
  [
    'an unknown top-level field',
    'export default { taskz: {} }\n',
    framed(18, ' has unknown field "taskz" (allowed: tags, tasks) — did you mean tasks?'),
  ],
  [
    'a command of the wrong type',
    task('exec: { command: 42 }'),
    framed(44, ': tasks.build.exec.command must be a non-empty string'),
  ],
  [
    'a string `cache.outputs`',
    task(`exec: { command: 'x' }, cache: { ${CACHE_IN}, outputs: 'dist' }`),
    framed(100, ': tasks.build.cache.outputs must be an object — `outputs: { files: [...] }`'),
  ],
  [
    'a string `cache.inputs`',
    task(`exec: { command: 'x' }, cache: { inputs: 'src/**', outputs: { files: [] } }`),
    framed(69, ': tasks.build.cache.inputs must be an object — `inputs: { files: [...] }`'),
  ],
  [
    'a missing `cache.outputs`',
    task(`exec: { command: 'x' }, cache: { ${CACHE_IN} }`),
    'vx: <root>/p/vx.config.ts: tasks.build.cache.outputs is required when `cache` is set',
  ],
  [
    'a string `dependsOn`',
    task("exec: { command: 'x' }, dependsOn: '^build'"),
    framed(
      60,
      ": tasks.build.dependsOn must be an array of strings (Turbo/Nx micro-syntax: 'name', '^name', 'pkg#name')",
    ),
  ],
  [
    'a timeout in words',
    task("exec: { command: 'x', timeout: '5s' }"),
    framed(58, ': tasks.build.exec.timeout must be a positive integer (milliseconds)'),
  ],
] as Array<[string, string, string | ((config: string) => string)]>)(
  '%s',
  async (_, config, err) => {
    expect(await run(config)).toEqual({ code: 1, err: typeof err === 'string' ? err : err(config) })
  },
)
