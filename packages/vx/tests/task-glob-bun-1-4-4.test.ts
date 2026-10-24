// Bun 1.4.4's `Bun.Glob` reads brace ranges and extglobs; 1.4.2 read both as
// literal text. vx expands a range itself, as `Bun.Glob` does, so every
// matcher names the same files; an extglob is still refused.

import { writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { braceAlternatives } from '../src/util/index.js'
import { run } from './helpers/orchestrator.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const quiet = { status() {}, taskStdout() {}, taskStderr() {}, taskComplete() {} }

let root: string | undefined
afterEach(async () => {
  if (root !== undefined) await rm(root, { recursive: true, force: true })
  root = undefined
})

async function project(input: string): Promise<{ dir: string; statuses: () => Promise<string[]> }> {
  root = await makeWorkspace({ prefix: 'vx-glob-144-' })
  const dir = await addProject(root, 'p', {
    config: `
      export default {
        tasks: {
          build: {
            exec: { command: 'echo ok > out.txt' },
            inputs: { files: [${JSON.stringify(input)}] },
            cache: { outputs: { files: ['out.txt'] } },
          },
        },
      }
    `,
    files: { 'src/a1.ts': '1', 'src/a2.ts': '2', 'src/a4.ts': '4' },
  })
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-q', '-m', 'init')
  const ws = root
  const statuses = async (): Promise<string[]> =>
    (await run({ cwd: ws, tasks: ['build'], log: quiet })).outcomes.map((o) => o.status)
  return { dir, statuses }
}

it('a range expands to the names Bun.Glob matches', () => {
  const names = [
    'a-1',
    'a0',
    'a1',
    'a2',
    'a3',
    'a4',
    'a01',
    'a02',
    'a03',
    'a7',
    'a10',
    'aa',
    'ab',
    'ac',
  ]
  for (const p of [
    'a{1..3}',
    'a{3..1}',
    'a{01..03}',
    'a{-1..1}',
    'a{1..10..3}',
    'a{a..c}',
    'a{1..3,x}',
  ]) {
    const alts = braceAlternatives(p)
    expect([p, names.filter((n) => alts.some((a) => new Bun.Glob(a).match(n)))]).toEqual([
      p,
      names.filter((n) => new Bun.Glob(p).match(n)),
    ])
  }
})

it('src/a{1..3}.ts keys a1 and a2, and not a4', async () => {
  const { dir, statuses } = await project('src/a{1..3}.ts')
  expect(await statuses()).toEqual(['success'])
  await writeFile(path.join(dir, 'src/a4.ts'), '4b')
  expect(await statuses()).toEqual(['cache-hit'])
  await writeFile(path.join(dir, 'src/a2.ts'), '2b')
  expect(await statuses()).toEqual(['success'])
}, 30_000)

it('a mixed-case range is refused: it spans [, \\ and ]', async () => {
  await project('src/a{A..c}.ts')
  await expect(run({ cwd: root!, tasks: ['build'], log: quiet })).rejects.toThrow(
    '"src/a{A..c}.ts" holds the brace range {A..c}, which vx expands only within one case ' +
      'and up to 1024 names. Write a smaller range or a comma brace.',
  )
}, 30_000)

it('src/@(a1|a2).ts is refused, though Bun.Glob now reads it', async () => {
  expect(new Bun.Glob('src/@(a1|a2).ts').match('src/a1.ts')).toBe(true)
  await project('src/@(a1|a2).ts')
  await expect(run({ cwd: root!, tasks: ['build'], log: quiet })).rejects.toThrow('is an extglob')
}, 30_000)

it('a mixed-case range after one vx expands is refused too, in an output as well', async () => {
  await project('src/a{1..2}{A..c}.ts')
  await expect(run({ cwd: root!, tasks: ['build'], log: quiet })).rejects.toThrow(
    '"src/a{1..2}{A..c}.ts" holds the brace range {A..c}',
  )
  await rm(root!, { recursive: true, force: true })
  root = await makeWorkspace({ prefix: 'vx-glob-144-' })
  await addProject(root, 'p', {
    config: `export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, cache: { outputs: { files: ['o{1..2}{A..c}'] } } } } }`,
  })
  await expect(run({ cwd: root, tasks: ['build'], log: quiet })).rejects.toThrow(
    '"o{1..2}{A..c}" holds the brace range {A..c}',
  )
}, 30_000)
