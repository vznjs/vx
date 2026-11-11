// A project's files digest (GitFilesCache.filesDigest) names the partition
// as the run's enumeration listed it, and a task's fold memo row is stored
// under it. A write the run names (a save's, a clean's, a restore's
// outputs) moves only some of the partition: a digest kept across one must
// never name files a task then reads differently. Each case here has a task
// move another's input during a run, then puts the files back as the
// digest named them: a row stored under the stale digest would replay the
// moved bytes.

import { mkdir, readFile, rm, symlink, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { gitIn, makeWorkspace } from './helpers/workspace.js'

const BIN = path.resolve(import.meta.dir, 'helpers', 'vx-locked.ts')

let root = ''
let pkg = ''
let git: (...args: string[]) => string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-stale-digest-' })
  pkg = path.join(root, 'packages', 'a')
  await mkdir(path.join(pkg, 'src'), { recursive: true })
  await mkdir(path.join(pkg, 'gen'), { recursive: true })
  await writeFile(path.join(pkg, 'package.json'), JSON.stringify({ name: 'a' }))
  await writeFile(path.join(pkg, 'src', 'p.txt'), '1\n')
  await writeFile(path.join(root, '.gitignore'), 'res.txt\nlink\n')
  git = gitIn(root)
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** `make` writes `out` from src/p.txt by `command`; `use` reads gen/** after it. */
const configure = (out: string, command: string): Promise<void> =>
  writeFile(
    path.join(pkg, 'vx.config.mjs'),
    `export default { tasks: {
  make: { inputs: { files: ['src/**'] }, outputs: { files: ['${out}'] }, exec: { command: ${JSON.stringify(command)} }, cache: true },
  use: { dependsOn: ['make'], inputs: { files: ['gen/**'], tasks: [] }, outputs: { files: ['res.txt'] }, exec: { command: 'cat gen/* > res.txt 2>/dev/null; true' }, cache: true },
} }\n`,
  )

const vx = (...args: string[]): void => {
  const p = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'run', ...args],
    cwd: root,
    env: { ...process.env, NO_COLOR: '1' },
  })
  if (p.exitCode !== 0) throw new Error(p.stdout.toString() + p.stderr.toString())
}
const commit = (message: string): void => {
  git('add', '-A')
  git('commit', '-qm', message)
}
const res = (): Promise<string> => readFile(path.join(pkg, 'res.txt'), 'utf8')

/**
 * The run that moves `use`'s input: src/p.txt becomes 2, then `make` runs,
 * and `use` must read what `make` left (`moved`). Then `undo` puts the
 * files back as that run's enumeration listed them, and `use` alone must
 * read them (`undone`), not replay what it read mid-run.
 */
async function moveThenUndo(
  moved: string,
  undo: () => Promise<void> | void,
  undone: string,
): Promise<void> {
  await writeFile(path.join(pkg, 'src', 'p.txt'), '2\n')
  // Tracked files only: a loose input stays loose.
  git('commit', '-qam', 'p2')
  vx('a#use')
  expect(await res()).toBe(moved)
  await undo()
  vx('a#use', '--exclude-dependencies')
  expect(await res()).toBe(undone)
}

it('(a) a save rewrites a tracked input in the snapshot', async () => {
  await writeFile(path.join(pkg, 'gen', 'x'), '1\n')
  await configure('gen/x', 'cp src/p.txt gen/x')
  commit('init')
  vx('a#use')
  expect(await res()).toBe('1\n')
  await moveThenUndo('2\n', () => void git('checkout', '--', 'packages/a/gen/x'), '1\n')
}, 60_000)

it('(b) a save rewrites a loose input (untracked, named by its stat)', async () => {
  await configure('gen/x', 'cp src/p.txt gen/x')
  commit('init')
  await writeFile(path.join(pkg, 'gen', 'x'), '1\n')
  vx('a#use')
  expect(await res()).toBe('1\n')
  await moveThenUndo('2\n', () => writeFile(path.join(pkg, 'gen', 'x'), '1\n'), '1\n')
}, 60_000)

it("(c) a save creates a file another task's input glob takes", async () => {
  await writeFile(path.join(pkg, 'gen', 'x'), '1\n')
  await configure('gen/y', 'cp src/p.txt gen/y')
  commit('init')
  vx('a#use')
  expect(await res()).toBe('1\n1\n')
  await rm(path.join(pkg, 'gen', 'y'))
  await moveThenUndo('1\n2\n', () => rm(path.join(pkg, 'gen', 'y')), '1\n')
}, 60_000)

// Untracked: the clean never deletes a committed file (2026-10-14).
it("(d) a clean deletes another task's input", async () => {
  await configure('gen/x', 'test "$(cat src/p.txt)" = 2 || cp src/p.txt gen/x')
  commit('init')
  await writeFile(path.join(pkg, 'gen', 'x'), '1\n')
  vx('a#use')
  expect(await res()).toBe('1\n')
  await moveThenUndo('', () => writeFile(path.join(pkg, 'gen', 'x'), '1\n'), '1\n')
}, 60_000)

it('(e) a save rewrites a loose input at its size and mtime, inside the racy window', async () => {
  await configure('gen/x', 'cp src/p.txt gen/x && touch -d @1600000000 gen/x')
  commit('init')
  await writeFile(path.join(pkg, 'gen', 'x'), '1\n')
  await utimes(path.join(pkg, 'gen', 'x'), 1_600_000_000, 1_600_000_000)
  vx('a#use')
  expect(await res()).toBe('1\n')
  await moveThenUndo(
    '2\n',
    async () => {
      await writeFile(path.join(pkg, 'gen', 'x'), '1\n')
      await utimes(path.join(pkg, 'gen', 'x'), 1_600_000_000, 1_600_000_000)
    },
    '1\n',
  )
}, 60_000)

it('(f) a save writes through a linked directory into the snapshot', async () => {
  await writeFile(path.join(pkg, 'gen', 'x'), '1\n')
  await symlink('gen', path.join(pkg, 'link'))
  await configure('link/x', 'cp src/p.txt link/x')
  commit('init')
  vx('a#use')
  expect(await res()).toBe('1\n')
  await moveThenUndo('2\n', () => void git('checkout', '--', 'packages/a/gen/x'), '1\n')
}, 60_000)
