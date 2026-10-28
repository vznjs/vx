// A warm run reads every up-front key back from the run key memo
// (orchestrator/run-keys.ts) when nothing they fold has moved. The memo must
// never answer for a run where something did: each case below changes what
// a key folds and expects the task to run.

import { Database } from 'bun:sqlite'
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''
let git: (...args: string[]) => string

const config = (name: string, extra = ''): string =>
  `export default { tasks: { build: { ${extra} inputs: { files: ['src/**'], env: ['RUN_KEYS_ENV'] }, exec: { command: 'cat src/x.txt > out.txt && echo ${name} >> ../../runs.log' }, cache: { outputs: { files: ['out.txt'] } } } } }\n`

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-run-keys-' })
  for (const name of ['a', 'b']) {
    const pkg = path.join(root, 'packages', name)
    await mkdir(path.join(pkg, 'src'), { recursive: true })
    await writeFile(
      path.join(pkg, 'package.json'),
      JSON.stringify(name === 'b' ? { name, dependencies: { a: 'workspace:*' } } : { name }),
    )
    await writeFile(
      path.join(pkg, 'vx.config.mjs'),
      name === 'b'
        ? `import { description } from '../../shared.mjs'\n${config(name, "dependsOn: ['a#build'], description,")}`
        : config(name),
    )
    await writeFile(path.join(pkg, 'src', 'x.txt'), `${name}1\n`)
  }
  await writeFile(path.join(root, 'shared.mjs'), "export const description = 'b'\n")
  await writeFile(path.join(root, '.gitignore'), 'runs.log\nout.txt\n')
  git = gitIn(root)
  git('add', '-A')
  git('commit', '-qm', 'init')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const build = (env: Record<string, string> = {}): void => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', 'build', '--all'],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', ...env },
  })
  if (p.exitCode !== 0) throw new Error(p.stdout.toString() + p.stderr.toString())
}
const runs = async (): Promise<string[]> =>
  (await readFile(path.join(root, 'runs.log'), 'utf8').catch(() => '')).split('\n').filter(Boolean)
const runRows = (): Array<{ task_id: string; key: string }> => {
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  try {
    return (db.query('SELECT task_id, key FROM fold_memo').all() as never[]).filter(
      (r: { task_id: string }) => r.task_id.startsWith('\0run\0'),
    )
  } finally {
    db.close()
  }
}

it('a warm run takes every key from the run memo', async () => {
  build()
  build()
  expect(await runs()).toEqual(['a', 'b'])
  const [row] = runRows()
  expect(row).toBeDefined()
  // Keys no entry holds, under the token the next run computes: read back,
  // both tasks miss and run; derived afresh, they would hit.
  const keys = JSON.parse(row!.key) as { s: [string, string][]; u: [string, string][] }
  keys.s = keys.s.map(([id]) => [id, '0123456789abcdef'])
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.query('UPDATE fold_memo SET key = ? WHERE task_id = ?').run(JSON.stringify(keys), row!.task_id)
  db.close()
  build()
  expect(await runs()).toEqual(['a', 'b', 'a', 'b'])
}, 60_000)

it('an upstream edit, an env value, a config edit and a dirty edit each run what they reach', async () => {
  build()
  build()
  expect(await runs()).toEqual(['a', 'b'])
  // b folds a's key: a committed edit in a runs both.
  await writeFile(path.join(root, 'packages', 'a', 'src', 'x.txt'), 'a2\n')
  git('commit', '-qam', 'a2')
  build()
  expect(await runs()).toEqual(['a', 'b', 'a', 'b'])
  build({ RUN_KEYS_ENV: 'one' })
  expect((await runs()).length).toBe(6)
  build({ RUN_KEYS_ENV: 'one' })
  expect((await runs()).length).toBe(6)
  // A config edit outside b's files: only the resolved config can move b.
  await writeFile(path.join(root, 'shared.mjs'), "export const description = 'moved'\n")
  git('commit', '-qam', 'b config')
  build({ RUN_KEYS_ENV: 'one' })
  expect((await runs()).slice(6)).toEqual(['b'])
  // Twice: the first dirty edit leaves a run row, the second would read it.
  await writeFile(path.join(root, 'packages', 'b', 'src', 'x.txt'), 'b2\n')
  build({ RUN_KEYS_ENV: 'one' })
  await writeFile(path.join(root, 'packages', 'b', 'src', 'x.txt'), 'b3\n')
  build({ RUN_KEYS_ENV: 'one' })
  expect((await runs()).slice(7)).toEqual(['b', 'b'])
  expect(await readFile(path.join(root, 'packages', 'b', 'out.txt'), 'utf8')).toBe('b3\n')
}, 120_000)

// One edited file moved every key's token, so the whole graph was keyed
// again: 22 ms of a 120 ms run at 200 tasks, where Turbo took 109
// (2026-10-28). Only the edited task and the tasks folding its key derive.
it('an edit derives again only the keys it reaches', async () => {
  const pkg = path.join(root, 'packages', 'c')
  await mkdir(path.join(pkg, 'src'), { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'c' }))
  await writeFile(path.join(pkg, 'vx.config.mjs'), config('c'))
  await writeFile(path.join(pkg, 'src', 'x.txt'), 'c1\n')
  git('add', '-A')
  git('commit', '-qm', 'c')
  build()
  build()
  const derived = async (edit: string, text: string): Promise<number> => {
    await writeFile(path.join(root, 'packages', edit, 'src', 'x.txt'), text)
    const p = Bun.spawnSync({
      cmd: [process.execPath, BIN, 'run', 'build', '--all'],
      cwd: root,
      env: { ...process.env, NO_COLOR: '1', VX_DEBUG_TIMING: '1' },
    })
    if (p.exitCode !== 0) throw new Error(p.stdout.toString() + p.stderr.toString())
    const m = /^\s*task hash\s+\S+\s+(\d+)$/m.exec(p.stderr.toString())
    return m === null ? 0 : Number(m[1])
  }
  expect(await derived('b', 'b2\n')).toBe(1)
  expect(await derived('c', 'c2\n')).toBe(1)
  expect(await derived('a', 'a2\n')).toBe(2)
  expect((await runs()).slice(3)).toEqual(['b', 'c', 'a', 'b'])
  // The keys an edit derived are the keys a full derivation makes: with the
  // memo gone, nothing runs.
  const db = new Database(path.join(root, '.vx', 'cache', 'cache.db'))
  db.query("DELETE FROM fold_memo WHERE task_id LIKE char(0) || 'run%'").run()
  db.close()
  build()
  expect((await runs()).length).toBe(7)
}, 120_000)

it('a run with a keyless task remembers no keys', async () => {
  await writeFile(
    path.join(root, 'packages', 'a', 'vx.config.mjs'),
    `export default { tasks: { build: { exec: { command: 'echo a >> ../../runs.log' } } } }\n`,
  )
  git('commit', '-qam', 'keyless')
  build()
  build()
  expect(runRows()).toEqual([])
}, 60_000)

it('a release binary built from a source tree that is gone remembers keys', async () => {
  // `--minify` inlines the build machine's `import.meta.dir`: the binary
  // must not read the derivation's identity from a `src/` it names.
  const pkg = path.resolve(import.meta.dir, '..')
  const tmp = await mkdtemp(path.join(tmpdir(), 'vx-run-keys-bin-'))
  try {
    const copy = path.join(tmp, 'vx')
    await cp(path.join(pkg, 'src'), path.join(copy, 'src'), { recursive: true })
    await cp(path.join(pkg, 'package.json'), path.join(copy, 'package.json'))
    await symlink(path.join(pkg, 'node_modules'), path.join(copy, 'node_modules'))
    await symlink(path.join(pkg, '..', '..', 'node_modules'), path.join(tmp, 'node_modules'))
    const bin = path.join(tmp, 'vx-bin')
    const built = Bun.spawnSync({
      cmd: [
        process.execPath,
        'build',
        '--compile',
        '--minify',
        '--bytecode',
        'src/bin.ts',
        '--outfile',
        bin,
      ],
      cwd: copy,
      stderr: 'pipe',
    })
    if (built.exitCode !== 0) throw new Error(built.stderr.toString())
    await rm(copy, { recursive: true, force: true })
    // The first run keys afresh; the second derives under a token and stores it.
    for (const cmd of [['lock'], ['run', 'build', '--all'], ['run', 'build', '--all']]) {
      const p = Bun.spawnSync({
        cmd: [bin, ...cmd],
        cwd: root,
        env: { ...process.env, NO_COLOR: '1' },
      })
      if (p.exitCode !== 0) throw new Error(p.stdout.toString() + p.stderr.toString())
    }
    expect(runRows()).toHaveLength(1)
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
}, 120_000)
