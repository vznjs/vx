// `vx lock --merge`: git's merge driver for both locks, registered per
// clone by `vx lock`. Two branches that changed different projects merge
// clean into a lock a run reads; one project both changed differently is a
// conflict that refuses until `vx lock`.

import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { mergeLock } from '../src/workspace/lock-merge.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 30_000
const P = '.vx/projects.lock.jsonl'
const D = '.vx/dependencies.lock'

const config = (cmd: string) =>
  `export default { tasks: { build: { exec: { command: ${JSON.stringify(cmd)} } } } }\n`

it('merges two sides that changed different keys, line by line', () => {
  const head = '{"version":8}'
  const t = (id: string) => `#${id}\t{"exec":{"command":"${id}"}}`
  const p = (name: string, id: string) =>
    `${name}\t{"path":"packages/${name}","file":"vx.config.mjs","config":{"tasks":{"build":"#${id}"}}}`
  const lock = (...ls: string[]) => `${[head, ...ls].join('\n')}\n`
  const base = lock(t('a1'), t('b1'), p('a', 'a1'), p('b', 'b1'))
  const ours = lock(t('a2'), t('b1'), p('a', 'a2'), p('b', 'b1'))
  const theirs = lock(t('a1'), t('b2'), t('c1'), p('a', 'a1'), p('b', 'b2'), p('c', 'c1'))
  // Task lines follow the project lines that name them: a1 and b1 are gone.
  expect(mergeLock(P, base, ours, theirs)).toEqual({
    text: lock(t('a2'), t('b2'), t('c1'), p('a', 'a2'), p('b', 'b2'), p('c', 'c1')),
    clean: true,
  })
  // A project one side removed and the other left goes.
  expect(mergeLock(P, base, lock(t('a1'), p('a', 'a1')), base).text).toBe(
    lock(t('a1'), p('a', 'a1')),
  )
  // Both changed one project differently: marked, not clean.
  const both = mergeLock(P, base, ours, lock(t('a3'), t('b1'), p('a', 'a3'), p('b', 'b1')))
  expect(both.clean).toBe(false)
  expect(both.text).toContain(
    `<<<<<<< ours\n${p('a', 'a2')}\n=======\n${p('a', 'a3')}\n>>>>>>> theirs\n`,
  )
})

it('merges the dependencies lock by name, and conflicts whole on other files', () => {
  const h = (files: string) => `{"version":5,"files":${files},"edges":true}`
  const lock = (head: string, ...ls: string[]) => `${[head, ...ls].join('\n')}\n`
  const one = h('["bun.lock"]')
  const base = lock(one, 'a\t\t\t=x', 'b\ta\t\t=y')
  const merged = mergeLock(
    D,
    base,
    lock(one, 'a\t\t\t=x2', 'b\ta\t\t=y'),
    lock(one, 'a\t\t\t=x', 'b\ta\t\t=y2'),
  )
  expect(merged).toEqual({ text: lock(one, 'a\t\t\t=x2', 'b\ta\t\t=y2'), clean: true })
  // Names a JSON string holds sort by the name, as `vx lock` writes them.
  const odd = mergeLock(
    D,
    base,
    lock(one, '"\\tz"', 'a\t\t\t=x', 'b\ta\t\t=y'),
    lock(one, 'a\t\t\t=x', 'b\ta\t\t=y', 'c'),
  )
  expect(odd.text).toBe(lock(one, '"\\tz"', 'a\t\t\t=x', 'b\ta\t\t=y', 'c'))
  // A digest column is a file of the header's: another list is a whole conflict.
  const two = mergeLock(
    D,
    base,
    lock(h('["bun.lock","x.lock"]'), 'a\t\t\t=x,=q', 'b\ta\t\t=y'),
    lock(one, 'a\t\t\t=x', 'b\ta\t\t=y2'),
  )
  expect(two.clean).toBe(false)
  expect(two.text.startsWith('<<<<<<< ours\n')).toBe(true)
})

let root: string
beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-lock-merge-' })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function vx(...args: string[]) {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1', CI: '', GITHUB_ACTIONS: '' },
  })
  return { code: p.exitCode, out: p.stdout.toString() + p.stderr.toString() }
}

it(
  'vx lock registers the driver; branches that changed different projects merge clean',
  async () => {
    const git = gitIn(root)
    await addProject(root, 'a', config('echo a'))
    await addProject(root, 'b', config('echo b'))
    expect(vx('lock').code).toBe(0)
    expect(git('config', '--get', 'merge.vx-lock.driver')).toContain('lock --merge %O %A %B %P')
    expect(await readFile(path.join(root, '.vx/.gitattributes'), 'utf8')).toContain('merge=vx-lock')
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('checkout', '-qb', 'one')
    await writeFile(path.join(root, 'packages/a/vx.config.mjs'), config('echo a2'))
    expect(vx('lock').code).toBe(0)
    git('commit', '-qam', 'one')
    git('checkout', '-q', '-')
    await writeFile(path.join(root, 'packages/b/vx.config.mjs'), config('echo b2'))
    expect(vx('lock').code).toBe(0)
    git('commit', '-qam', 'two')
    git('merge', '-q', '--no-edit', 'one')
    // What vx lock writes from the merged configs, byte for byte.
    const merged = await readFile(path.join(root, P), 'utf8')
    expect(vx('lock', '--check').code).toBe(0)
    expect(vx('lock').code).toBe(0)
    expect(await readFile(path.join(root, P), 'utf8')).toBe(merged)
    const run = vx('run', 'build', '--all', '--output-logs', 'full')
    expect([run.code, run.out.includes('a2'), run.out.includes('b2')]).toEqual([0, true, true])
  },
  TIMEOUT,
)

it(
  'one project both branches changed is a conflict a run refuses until vx lock',
  async () => {
    const git = gitIn(root)
    await addProject(root, 'a', config('echo a'))
    expect(vx('lock').code).toBe(0)
    git('add', '-A')
    git('commit', '-qm', 'base')
    git('checkout', '-qb', 'one')
    await writeFile(path.join(root, 'packages/a/vx.config.mjs'), config('echo one'))
    expect(vx('lock').code).toBe(0)
    git('commit', '-qam', 'one')
    git('checkout', '-q', '-')
    await writeFile(path.join(root, 'packages/a/vx.config.mjs'), config('echo two'))
    expect(vx('lock').code).toBe(0)
    git('commit', '-qam', 'two')
    expect(() => git('merge', '-q', '--no-edit', 'one')).toThrow()
    expect(await readFile(path.join(root, P), 'utf8')).toContain('<<<<<<< ours')
    const run = vx('run', 'build', '--all')
    expect(run.code).toBe(1)
    expect(run.out).toContain('vx lock')
    // The config's own conflict resolved, vx lock writes the lock anew.
    await writeFile(path.join(root, 'packages/a/vx.config.mjs'), config('echo both'))
    expect(vx('lock').code).toBe(0)
    expect(vx('run', 'build', '--all', '--output-logs', 'full').out).toContain('both')
  },
  TIMEOUT,
)
