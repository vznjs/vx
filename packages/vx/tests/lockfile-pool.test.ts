// `.vx/projects.lock.json` writes a task or task part that two places hold
// alike once, in `pool`, and a read puts it back.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, test } from 'bun:test'
import type { ProjectConfig, TaskConfig } from '../src/config.js'
import {
  LOCKFILE_VERSION,
  lockEntryBroken,
  lockfilePath,
  readLockfile,
  writeLockfile,
} from '../src/workspace/lockfile.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-lock-pool-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const entry = (tasks: Record<string, TaskConfig>) => ({
  file: 'vx.config.ts',
  config: { tasks } as ProjectConfig,
})
const build: TaskConfig = {
  exec: { command: 'tsc -b', env: { passThrough: ['CI'] } },
  inputs: { files: ['src/**'] },
  cache: { outputs: { files: ['dist/**'] } },
}
const shard = (i: number): TaskConfig => ({
  exec: {
    command: `bun test ${i}`,
    env: { define: { A: '1' } },
    sandbox: { allow: { read: ['**/*'] } },
  },
  inputs: { files: ['**/*'] },
})

async function roundTrip(projects: Record<string, ReturnType<typeof entry>>) {
  await writeLockfile(root, { version: LOCKFILE_VERSION, projects })
  const raw = JSON.parse(await Bun.file(lockfilePath(root)).text())
  const read = await readLockfile(root)
  expect(read!.projects).toEqual(projects)
  return { raw, read: read! }
}

test('a task two projects declare alike is written once and read back shared', async () => {
  const { raw, read } = await roundTrip({ a: entry({ build }), b: entry({ build }) })
  expect(raw.pool.task).toHaveLength(1)
  expect(raw.projects.a.config.tasks.build).toBe(0)
  expect(raw.projects.b.config.tasks.build).toBe(0)
  expect(read.projects['a']!.config.tasks!['build']).toBe(
    read.projects['b']!.config.tasks!['build'],
  )
  expect(Object.hasOwn(read, 'pool')).toBe(false)
})

test('tasks that differ share their alike parts', async () => {
  const { raw } = await roundTrip({ a: entry({ s1: shard(1), s2: shard(2), s3: shard(3) }) })
  expect(raw.pool.task).toBeUndefined()
  expect(raw.pool.inputs).toEqual([{ files: ['**/*'] }])
  expect(raw.pool.env).toEqual([{ define: { A: '1' } }])
  expect(raw.pool.sandbox).toHaveLength(1)
  expect(raw.projects.a.config.tasks.s2).toEqual({
    exec: { command: 'bun test 2', env: 0, sandbox: 0 },
    inputs: 0,
  })
})

test('a pooled task names its pooled parts', async () => {
  const other: TaskConfig = { ...build, exec: { command: 'tsc', env: build.exec!.env! } }
  const { raw } = await roundTrip({ a: entry({ build, other }), b: entry({ build, other }) })
  expect(raw.pool.task).toHaveLength(2)
  expect(raw.pool.task[0].exec).toBe(0)
  expect(raw.pool.exec).toEqual([
    { command: 'tsc -b', env: 0 },
    { command: 'tsc', env: 0 },
  ])
  expect(raw.pool.env).toEqual([{ passThrough: ['CI'] }])
})

test('a value held once stays where it is', async () => {
  const { raw } = await roundTrip({ a: entry({ build }), b: entry({ test: shard(1) }) })
  expect(raw.pool).toBeUndefined()
  expect(raw.projects.a.config.tasks.build).toEqual(build)
})

test('one workspace writes one byte sequence', async () => {
  const projects = { a: entry({ build, s1: shard(1) }), b: entry({ build, s2: shard(2) }) }
  await writeLockfile(root, { version: LOCKFILE_VERSION, projects })
  const first = await Bun.file(lockfilePath(root)).text()
  await writeLockfile(root, { version: LOCKFILE_VERSION, projects: structuredClone(projects) })
  expect(await Bun.file(lockfilePath(root)).text()).toBe(first)
})

test('an index with no pool entry is refused, and named on a crash path', async () => {
  await Bun.write(
    lockfilePath(root),
    JSON.stringify({
      version: LOCKFILE_VERSION,
      pool: { task: [] },
      projects: { a: entry({ build: 3 as never }) },
    }),
  )
  await expect(readLockfile(root)).rejects.toThrow('no task 3 in its pool — re-run `vx lock`')
  expect(lockEntryBroken(root)).toBe(true)
})
