// `.vx/projects.lock` v9 (M, 2026-11-23): every distinct task once under a
// pointer that is the hash of its JSON, two lines per record, so git merges
// edits to neighbouring records and the same projects lock to the same text.

import { afterEach, beforeEach, expect, it } from 'bun:test'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { ProjectConfig } from '../src/config.js'
import {
  LOCKFILE_VERSION,
  type Lockfile,
  type LockedProject,
  lockfileWrite,
  readLockfile,
} from '../src/workspace/index.js'

let root: string
beforeEach(async () => {
  root = mkdtempSync(path.join(tmpdir(), 'vx-lock-format-'))
  await mkdir(path.join(root, '.vx'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const lint = { cache: true, exec: { command: 'oxlint' }, inputs: { files: ['**/*'] } }
const build = { cache: true, exec: { command: 'vite build' }, inputs: { files: ['src/**'] } }
const test = { cache: true, exec: { command: 'vitest run' }, inputs: { files: ['src/**'] } }

const project = (
  name: string,
  tasks: Record<string, unknown>,
  extra: Partial<LockedProject> = {},
) => ({ name, file: 'vx.config.ts', config: { tasks } as ProjectConfig, ...extra }) as LockedProject

const lock = (projects: Record<string, LockedProject>): Lockfile => ({
  version: LOCKFILE_VERSION,
  projects,
})

/** Writes `l` over whatever lock is there, as `vx lock` does; its text. */
const write = (l: Lockfile): string => {
  const w = lockfileWrite(root, l)
  writeFileSync(w.file, w.text)
  return String(w.text)
}

const base = () =>
  lock({
    'packages/ui': project('@acme/ui', { test, build, lint }),
    'apps/web': project('@acme/web', { lint, build }),
  })

it('writes the header, the pool as pointer and JSON lines, then each project with a line per task name and its pointer', () => {
  const text = write(base())
  const lines = text.trimEnd().split('\n')
  expect(lines[0]).toBe(`{"version":${LOCKFILE_VERSION}}`)
  // Three distinct tasks: three pointers, each then its JSON, sorted.
  const pool = lines.slice(1, 7)
  const pointers = pool.filter((_, i) => i % 2 === 0)
  expect(pointers.every((p) => /^#[0-9a-z]{7}$/.test(p))).toBe(true)
  expect([...pointers].sort()).toEqual(pointers)
  expect(pool.filter((_, i) => i % 2 === 1).every((b) => b.startsWith('{'))).toBe(true)
  // Tasks in name order; `vx.config.ts` is the file a line leaves out.
  const ui = lines.indexOf('@acme/ui\t{"path":"packages/ui"}')
  expect(ui).toBeGreaterThan(6)
  expect(lines.slice(ui + 1, ui + 7).filter((_, i) => i % 2 === 0)).toEqual([
    '\tbuild',
    '\tlint',
    '\ttest',
  ])
  expect(
    lines
      .slice(ui + 1, ui + 7)
      .filter((_, i) => i % 2 === 1)
      .every((p) => pointers.includes(p)),
  ).toBe(true)
})

it('orders projects by the hash of their name, so two new ones seldom land side by side', () => {
  const names = Array.from({ length: 40 }, (_, i) => `p${String(i).padStart(2, '0')}`)
  const text = write(
    lock(Object.fromEntries(names.map((n) => [`packages/${n}`, project(n, { lint })]))),
  )
  const order = text
    .split('\n')
    .filter((l) => /^p\d\d\t/.test(l))
    .map((l) => l.slice(0, 3))
  expect(order).not.toEqual(names)
  expect([...order].sort()).toEqual(names)
  const h = (n: string) => Bun.hash.xxHash3(n)
  expect(order.every((n, i) => i === 0 || h(order[i - 1]!) < h(n))).toBe(true)
})

it('reads back every entry as written: file, by, other config keys, no tasks, odd names', async () => {
  const l = lock({
    'packages/ui': project('@acme/ui', { test, build, lint }),
    'packages/mjs': project('mjs', { lint }, { file: 'vx.config.mjs' }),
    'packages/added': {
      name: 'added',
      by: '@vzn/vx-migrate',
      config: { tasks: { lint } } as ProjectConfig,
    },
    'packages/bare': { name: 'bare' },
    'packages/tags': project(
      'tags',
      { lint },
      { config: { tags: ['x'], tasks: { lint } } as ProjectConfig },
    ),
    'packages/none': project('none', {}),
    'packages/odd': project('#odd\tname', { '"q"': lint, 'a\tb': build }),
  })
  write(l)
  const read = await readLockfile(root)
  expect(Bun.deepEquals(read!.projects, l.projects, true)).toBe(true)
  expect(read!.projects['packages/bare']).toEqual({ name: 'bare' })
  expect(read!.projects['packages/added']!.file).toBeUndefined()
})

it('gives an edited task the pointer of its new JSON, in its pool entry and each line that holds it', () => {
  const before = write(base())
  const lint2 = { ...lint, exec: { command: 'oxlint --deny-warnings' } }
  const after = write(
    lock({
      'packages/ui': project('@acme/ui', { test, build, lint: lint2 }),
      'apps/web': project('@acme/web', { lint: lint2, build }),
    }),
  )
  const a = new Set(before.split('\n')),
    b = after.split('\n')
  const added = b.filter((l) => !a.has(l))
  // Its pool entry (pointer and JSON), and that pointer on both projects' lint lines.
  expect(added.length).toBe(4)
  expect(added.filter((l) => l === added[0]).length).toBe(3)
  expect(added).toContain(JSON.stringify(lint2))
})

it('moves only the edited project to a new pointer when the others keep the old task', () => {
  const before = write(base())
  const lint2 = { ...lint, exec: { command: 'oxlint --deny-warnings' } }
  const after = write(
    lock({
      'packages/ui': project('@acme/ui', { test, build, lint }),
      'apps/web': project('@acme/web', { lint: lint2, build }),
    }),
  )
  const a = new Set(before.split('\n')),
    b = after.split('\n')
  const added = b.filter((l) => !a.has(l))
  // The new pool entry (pointer and JSON) and web's lint pointer.
  expect(added.length).toBe(3)
  expect(added).toContain(JSON.stringify(lint2))
  expect([...a].filter((l) => !b.includes(l))).toEqual([
    // web's old lint pointer line: the same text as ui's, so only one goes.
  ])
})

it('drops a pointer no task holds any more, and shares one whose task another project adds', () => {
  write(base())
  const text = write(
    lock({
      'packages/ui': project('@acme/ui', { build, lint }),
      'apps/web': project('@acme/web', { lint, build }),
      'apps/docs': project('@acme/docs', { build }),
    }),
  )
  expect(text).not.toContain(JSON.stringify(test))
  expect(text.split('\n').filter((l) => l === JSON.stringify(build)).length).toBe(1)
})

it('writes the same text for the same projects from no lock, and again over itself', () => {
  const once = write(base())
  expect(write(base())).toBe(once)
  rmSync(path.join(root, '.vx/projects.lock'))
  expect(write(base())).toBe(once)
})

const merge = (ours: string, baseText: string, theirs: string) => {
  const f = (n: string, t: string) => {
    const p = path.join(root, n)
    writeFileSync(p, t)
    return p
  }
  const r = spawnSync('git', ['merge-file', '-p', f('o', ours), f('b', baseText), f('t', theirs)], {
    encoding: 'utf8',
  })
  return { clean: r.status === 0, text: r.stdout }
}

// A name line stays put, so it sits between two branches' edits and git
// merges both.
it('git merges two branches that edit tasks of different projects', async () => {
  // Other tasks keep the two branches' pool entries apart.
  const others = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((n) => [
      `packages/${n}`,
      project(n, { lint: { ...lint, description: n } }),
    ]),
  )
  const b0 = lock({
    ...others,
    'packages/ui': project('@acme/ui', { build: { ...build, description: 'ui' }, lint }),
    'apps/web': project('@acme/web', { build: { ...build, description: 'web' }, lint }),
  })
  const start = write(b0)
  const edit = (dir: string, description: string): Lockfile => {
    const l = structuredClone(b0)
    const t = l.projects[dir]!.config!.tasks! as Record<string, Record<string, unknown>>
    t['build'] = { ...t['build'], description }
    return l
  }
  const ours = write(edit('packages/ui', 'ui3'))
  const theirs = write(edit('apps/web', 'web2'))
  const m = merge(ours, start, theirs)
  expect(m.clean).toBe(true)
  writeFileSync(path.join(root, '.vx/projects.lock'), m.text)
  const read = (await readLockfile(root))!.projects
  const d = (dir: string) =>
    (read[dir]!.config!.tasks!['build'] as { description: string }).description
  expect([d('packages/ui'), d('apps/web')]).toEqual(['ui3', 'web2'])
})

it('reads a lock a merge left conflicted as one to re-lock', async () => {
  const text = write(base())
  const lines = text.split('\n')
  lines.splice(3, 0, '<<<<<<< ours', '=======', '>>>>>>> theirs')
  writeFileSync(path.join(root, '.vx/projects.lock'), lines.join('\n'))
  expect(readLockfile(root)).rejects.toThrow('merge conflict')
})

it('refuses a task line with no pointer, and a pointer the pool lacks', async () => {
  const text = write(base())
  const p = path.join(root, '.vx/projects.lock')
  const lines = text.trimEnd().split('\n')
  const last = lines.length - 1
  writeFileSync(p, `${lines.slice(0, last).join('\n')}\n`)
  expect(readLockfile(root)).rejects.toThrow('run `vx lock`')
  writeFileSync(p, `${[...lines.slice(0, last), '#zzzzzzz'].join('\n')}\n`)
  expect(readLockfile(root)).rejects.toThrow('#zzzzzzz')
  expect(readFileSync(p, 'utf8')).toContain('#zzzzzzz')
})

// A pointer names its JSON, so no clean merge can give a task a body
// neither branch wrote for it: it conflicts, refuses as a pointer the pool
// lacks, or reads each branch's task.
const settles = async (
  ours: string,
  start: string,
  theirs: string,
  expected: Record<string, unknown>,
) => {
  const m = merge(ours, start, theirs)
  if (!m.clean) return
  writeFileSync(path.join(root, '.vx/projects.lock'), m.text)
  const read = await readLockfile(root).catch((e: Error) => e)
  if (read instanceof Error) return expect(read.message).toContain('vx lock')
  for (const [dir, tasks] of Object.entries(expected))
    expect(read!.projects[dir]!.config!.tasks as unknown).toEqual(tasks)
}

it('never merges a task added on one branch onto the body another branch edited', async () => {
  const others = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e'].map((n) => [`packages/${n}`, project(n, { lint, test })]),
  )
  const b0 = lock({ ...others, 'packages/ui': project('@acme/ui', { build }) })
  const start = write(b0)
  const built = { ...build, description: 'x' }
  const ours = write(lock({ ...others, 'packages/ui': project('@acme/ui', { build: built }) }))
  const theirs = write(lock({ ...b0.projects, 'apps/api': project('@acme/api', { build }) }))
  await settles(ours, start, theirs, {
    'packages/ui': { build: built },
    'apps/api': { build },
  })
})

it('never merges a task added on one branch onto a body the other branch dropped', async () => {
  const b0 = lock({
    'packages/ui': project('@acme/ui', { build }),
    'apps/web': project('@acme/web', { lint }),
  })
  const start = write(b0)
  const ours = write(
    lock({ 'packages/ui': project('@acme/ui', {}), 'apps/web': b0.projects['apps/web']! }),
  )
  const theirs = write(lock({ ...b0.projects, 'apps/web': project('@acme/web', { lint, build }) }))
  await settles(ours, start, theirs, { 'apps/web': { build, lint } })
})

it('refuses a pool pointer cut short or written twice, so a reader sees the body a task gets', async () => {
  const p = path.join(root, '.vx/projects.lock')
  const lines = [
    '{"version":9}',
    '#abc',
    '{"x":1}',
    JSON.stringify(build),
    'app\t{"path":"app"}',
    '\tbuild',
    '#abc',
    '{"x":1}',
  ]
  writeFileSync(p, `${lines.join('\n')}\n`)
  expect(readLockfile(root)).rejects.toThrow('run `vx lock`')
  const twice = [
    '{"version":9}',
    '#aaaaaaa',
    JSON.stringify(lint),
    '#aaaaaaa',
    JSON.stringify(build),
    'app\t{"path":"app"}',
    '\tbuild',
    '#aaaaaaa',
  ]
  writeFileSync(p, `${twice.join('\n')}\n`)
  expect(readLockfile(root)).rejects.toThrow('run `vx lock`')
})
