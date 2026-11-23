// `.vx/projects.lock` v9 (M, 2026-11-23): every task once under a stable
// pointer, two lines per record, so git merges edits to neighbouring
// records and an edit rewrites the fewest lines. A pointer is born from its
// first JSON and kept by every later `vx lock` while a task holds it.

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

it('keeps a pointer when its task changes: an edit to a shared task rewrites only its JSON line', () => {
  const before = write(base())
  const lint2 = { ...lint, exec: { command: 'oxlint --deny-warnings' } }
  const after = write(
    lock({
      'packages/ui': project('@acme/ui', { test, build, lint: lint2 }),
      'apps/web': project('@acme/web', { lint: lint2, build }),
    }),
  )
  const a = before.split('\n'),
    b = after.split('\n')
  expect(b.length).toBe(a.length)
  const changed = a.map((l, i) => (l === b[i] ? null : [l, b[i]])).filter(Boolean)
  expect(changed).toEqual([[JSON.stringify(lint), JSON.stringify(lint2)]])
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

it('drops a pointer no task holds any more, and gives a task another project adds a pointer of its own', () => {
  write(base())
  const text = write(
    lock({
      'packages/ui': project('@acme/ui', { build, lint }),
      'apps/web': project('@acme/web', { lint, build }),
      'apps/docs': project('@acme/docs', { build }),
    }),
  )
  expect(text).not.toContain(JSON.stringify(test))
  expect(text.split('\n').filter((l) => l === JSON.stringify(build)).length).toBe(2)
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

// The point of the layout: name and pointer lines stay put, so they sit
// between two branches' edits and git merges both.
it('git merges two branches that edit neighbouring tasks of one project, and neighbouring projects', async () => {
  const b0 = lock({
    'packages/ui': project('@acme/ui', {
      build: { ...build, description: 'ui' },
      lint: { ...lint, description: 'ui' },
      test,
    }),
    'apps/web': project('@acme/web', { build: { ...build, description: 'web' } }),
  })
  const start = write(b0)
  const edit = (dir: string, task: string, description: string): Lockfile => {
    const l = structuredClone(b0)
    const t = l.projects[dir]!.config!.tasks! as Record<string, Record<string, unknown>>
    t[task] = { ...t[task], description }
    return l
  }
  const ours = write(edit('packages/ui', 'build', 'ui2'))
  writeFileSync(path.join(root, '.vx/projects.lock'), start)
  const theirs = write(edit('packages/ui', 'lint', 'ui3'))
  const m = merge(ours, start, theirs)
  expect(m.clean).toBe(true)
  writeFileSync(path.join(root, '.vx/projects.lock'), m.text)
  const tasks = (await readLockfile(root))!.projects['packages/ui']!.config!.tasks as Record<
    string,
    { description?: string }
  >
  expect([tasks['build']!.description, tasks['lint']!.description]).toEqual(['ui2', 'ui3'])
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

// A held pointer's JSON is rewritten in place, so a task that joined it on
// another branch would merge cleanly and read that branch's task.
it('never merges a task added on one branch onto a pointer the other branch edited', async () => {
  // Other projects and tasks keep the two branches' lines apart: @acme/api
  // hashes between d and b, far from the pool.
  const others = Object.fromEntries(
    ['a', 'b', 'c', 'd', 'e'].map((n) => [`packages/${n}`, project(n, { lint, test })]),
  )
  const b0 = lock({ ...others, 'packages/ui': project('@acme/ui', { build }) })
  const start = write(b0)
  const ours = write(
    lock({
      ...others,
      'packages/ui': project('@acme/ui', { build: { ...build, description: 'x' } }),
    }),
  )
  writeFileSync(path.join(root, '.vx/projects.lock'), start)
  const theirs = write(lock({ ...b0.projects, 'apps/api': project('@acme/api', { build }) }))
  const m = merge(ours, start, theirs)
  expect(m.clean).toBe(true)
  writeFileSync(path.join(root, '.vx/projects.lock'), m.text)
  const read = (await readLockfile(root))!.projects
  expect(read['apps/api']!.config!.tasks!['build']).toEqual(build)
  expect(read['packages/ui']!.config!.tasks!['build']).toEqual({ ...build, description: 'x' })
})

it('never merges a task added on one branch onto a pointer the other branch dropped', async () => {
  const b0 = lock({
    'packages/ui': project('@acme/ui', { build }),
    'apps/web': project('@acme/web', { lint }),
  })
  const start = write(b0)
  const ours = write(
    lock({ 'packages/ui': project('@acme/ui', {}), 'apps/web': b0.projects['apps/web']! }),
  )
  writeFileSync(path.join(root, '.vx/projects.lock'), start)
  const theirs = write(lock({ ...b0.projects, 'apps/web': project('@acme/web', { lint, build }) }))
  const m = merge(ours, start, theirs)
  expect(m.clean).toBe(true)
  writeFileSync(path.join(root, '.vx/projects.lock'), m.text)
  expect((await readLockfile(root))!.projects['apps/web']!.config!.tasks!['build']).toEqual(build)
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
