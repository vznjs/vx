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
    framed(
      1,
      'did not export a default object: it has no `export default` — write `export default { … }`',
    ),
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
    'a string `outputs`',
    task(`exec: { command: 'x' }, ${CACHE_IN}, outputs: 'dist', cache: true`),
    framed(91, 'tasks.build.outputs must be an object — `outputs: { files: [...] }`'),
  ],
  [
    'a string `inputs`',
    task(`exec: { command: 'x' }, inputs: 'src/**', outputs: { files: [] }, cache: true`),
    framed(60, 'tasks.build.inputs must be an object — `inputs: { files: [...] }`'),
  ],
  [
    'a missing `outputs`',
    task(`exec: { command: 'x' }, ${CACHE_IN}, cache: true`),
    // Framed at the `cache` that asks for it.
    framed(
      91,
      'tasks.build: `cache` needs `outputs` — what the task produces, `outputs: { files: [...] }` (`[]` for none)',
    ),
  ],
  [
    'an env var written straight under `exec.env`',
    task("exec: { command: 'x', env: { NODE_ENV: 'production' } }"),
    framed(65, 'tasks.build.exec.env has unknown field "NODE_ENV"', {
      allowed: 'define, passThrough, secret',
      fix: 'use exec.env.define: { NODE_ENV: "production" }',
    }),
  ],
  [
    'an env var with a number value under `exec.env`: the fix spells it a string',
    task("exec: { command: 'x', env: { PORT: 3000 } }"),
    framed(65, 'tasks.build.exec.env has unknown field "PORT"', {
      allowed: 'define, passThrough, secret',
      fix: 'use exec.env.define: { PORT: "3000" }',
    }),
  ],
  [
    'a zero `exec.timeout`',
    task("exec: { command: 'x', timeout: '0s' }"),
    framed(58, 'tasks.build.exec.timeout must be more than 0 — omit it for no limit (got "0s")'),
  ],
  [
    'a `dependsOn` naming no task, at its line',
    task("exec: { command: 'x' }, dependsOn: ['nope']"),
    framed(60, 'tasks.build.dependsOn names p#nope but no such task is declared'),
  ],
  [
    'a string `dependsOn`',
    task("exec: { command: 'x' }, dependsOn: '^build'"),
    framed(60, 'tasks.build.dependsOn must be an array — write dependsOn: ["^build"]'),
  ],
  [
    // As a task written as a string is told (`a command is …`).
    'an exec written as the command',
    task("exec: 'tsc -b'"),
    framed(36, 'tasks.build.exec must be an object — a command is { exec: { command: "tsc -b" } }'),
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

/** `vx lock` over a bare member, with `rest` beside `plugins` in .vx/workspace.mjs. */
const runWs = async (rest: string) => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-ws-err-')))
  Bun.spawnSync(['git', 'init', '-q'], { cwd: root })
  await writeFile(path.join(root, 'package.json'), '{"name":"r","workspaces":["p"]}')
  const src = localWorkspaceSource().replace(
    'export default { plugins:',
    `export default { ${rest}, plugins:`,
  )
  await Bun.write(path.join(root, '.vx/workspace.mjs'), src)
  await mkdir(path.join(root, 'p'))
  await writeFile(path.join(root, 'p', 'package.json'), '{"name":"p"}')
  await writeFile(path.join(root, 'p', 'vx.config.ts'), 'export default { tasks: {} }\n')
  const proc = Bun.spawn(['bun', BIN, 'lock'], {
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [err, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited])
  return {
    code,
    err: err.replaceAll(root, '<root>').trim(),
    line: src.split('\n').findIndex((l) => l.includes(rest)) + 1,
  }
}

// Both printed an unframed path: the policy's grammar is checked outside
// the schema, and a rule's message split its code span.
it.each([
  [
    "cache: { policy: 'locl:rw' }",
    "`cache.policy` invalid layer 'locl': expected 'local' or 'remote'",
  ],
  [
    "run: { rules: { dependencies: [{ from: 'tag:lib', deny: 'tag:app' }] } }",
    "`run.rules.dependencies[0].deny` must be an array of selectors like 'tag:lib'",
  ],
])('a workspace refusal of %p is framed at its line', async (rest, problem) => {
  const r = await runWs(rest)
  expect(r.code).toBe(1)
  if (rest.includes('locl')) expect(r.err).toEndWith("fix  use 'local'")
  expect(r.err).toMatch(
    new RegExp(
      `\\.vx/workspace\\.mjs:${r.line}:\\d+\\n  ${problem.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    ),
  )
})
