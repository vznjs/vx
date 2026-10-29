// What `vx lock` says for a malformed project config, pinned whole: each
// message names the file, and the field when there is one — a syntax
// error its line and column, a missing default export the export, a
// schema violation the field's path from `tasks` and, when the field is
// in the file, its line and column with that line under it.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
let root: string | undefined

afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
})

/** `vx lock` over one member `p` with `config` as its vx.config.ts. */
const run = async (config: string) => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-cfg-err-')))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["p"]}')
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  await mkdir(path.join(root, 'p'))
  await writeFile(path.join(root, 'p', 'package.json'), '{"name":"p"}')
  await writeFile(path.join(root, 'p', 'vx.config.ts'), config)
  const proc = Bun.spawn(['bun', BIN, 'lock'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return { code, err: err.replaceAll(root, '<root>').trim() }
}

const REFUSED = '✗ vx lock  lock not written\n\n  '

/** A schema refusal as printed: the file at the field's line and column, then that line. */
const framed =
  (col: number, problem: string, more: { allowed?: string; fix?: string } = {}) =>
  (config: string): string =>
    `${REFUSED}p/vx.config.ts:1:${col}\n  ${problem}` +
    (more.allowed === undefined ? '' : `\n  allowed: ${more.allowed}`) +
    `\n\n  > 1 | ${config.trim()}\n      | ${' '.repeat(col - 1)}^` +
    (more.fix === undefined ? '' : `\n\n  fix  ${more.fix}`)

const task = (fields: string) => `export default { tasks: { build: { ${fields} } } }\n`
const CACHE_IN = "inputs: { files: ['src/**'] }"

it.each([
  [
    'a syntax error, by line and column',
    'export default { tasks: {}\n',
    framed(27, 'Expected "}" but found end of file'),
  ],
  [
    'named exports and no default',
    'export const config = { tasks: {} }\n',
    `${REFUSED}Project config at <root>/p/vx.config.ts did not export a default object`,
  ],
  [
    'an unknown top-level field',
    'export default { taskz: {} }\n',
    framed(18, 'unknown field "taskz"', { allowed: 'name, tags, tasks', fix: 'use tasks' }),
  ],
  [
    'a command of the wrong type',
    task('exec: { command: 42 }'),
    framed(44, 'tasks.build.exec.command must be a non-empty string'),
  ],
  [
    'a string `cache.outputs`',
    task(`exec: { command: 'x' }, ${CACHE_IN}, cache: { outputs: 'dist' }`),
    framed(100, 'tasks.build.cache.outputs must be an object — `outputs: { files: [...] }`'),
  ],
  [
    'a string `inputs`',
    task(`exec: { command: 'x' }, inputs: 'src/**', cache: { outputs: { files: [] } }`),
    framed(60, 'tasks.build.inputs must be an object — `inputs: { files: [...] }`'),
  ],
  [
    'a missing `cache.outputs`',
    task(`exec: { command: 'x' }, ${CACHE_IN}, cache: {}`),
    `${REFUSED}<root>/p/vx.config.ts: tasks.build.cache.outputs is required when \`cache\` is set`,
  ],
  [
    'a string `dependsOn`',
    task("exec: { command: 'x' }, dependsOn: '^build'"),
    framed(
      60,
      "tasks.build.dependsOn must be an array of strings (Turbo/Nx micro-syntax: 'name', '^name', 'pkg#name')",
    ),
  ],
  [
    'a timeout with no unit',
    task("exec: { command: 'x', timeout: 5000 }"),
    framed(
      58,
      "tasks.build.exec.timeout takes a duration with its unit, like '5000ms' or '5s' (got 5000)",
    ),
  ],
] as Array<[string, string, string | ((config: string) => string)]>)(
  '%s',
  async (_, config, err) => {
    expect(await run(config)).toEqual({ code: 1, err: typeof err === 'string' ? err : err(config) })
  },
)
