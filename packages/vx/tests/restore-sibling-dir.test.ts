// A hit restores a missing output directory as a tree staged aside and
// renamed into place. rename(2) replaces an EMPTY directory, so a sibling
// task's fresh `mkdir -p dist` was swapped for the restored tree: its write
// into the directory it had just resolved failed "Directory nonexistent"
// (fuzzlock seed 2161, 2026-11-23). The restore now lands only where nothing
// stands and fills a directory made since in place.

import { existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { run } from './helpers/orchestrator.js'

let root: string
let app: string
const FILES = 2000

const quiet = {
  status: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-sibling-dir-'))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  await Bun.write(path.join(root, '.vx/workspace.mjs'), localWorkspaceSource())
  app = path.join(root, 'packages', 'app')
  await mkdir(path.join(app, 'src'), { recursive: true })
  await writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'app' }))
  await writeFile(path.join(app, 'src', 'x'), 'x\n')
  // Many files, so the copy into staging awaits often enough for the poll
  // below to run between them: one big file was a single APFS clone on the
  // Mac, staged and landed with no turn between (job 137565144235).
  await writeFile(
    path.join(app, 'vx.config.mjs'),
    `export default { tasks: { b: { exec: { command: 'mkdir -p dist && for i in $(seq 1 ${FILES}); do echo $i > dist/f$i; done' },
      inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
  )
  await Bun.spawn(['git', 'init', '-q'], { cwd: root }).exited
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const build = () =>
  run({ cwd: root, tasks: ['b'], projects: ['app'], log: quiet, handleSignals: false })

// The restore's staged `dist` (`.vx/tmp/<staging>/<n>/f<i>`): staged only
// once the walk found `dist` missing, so a `dist` made now comes after it.
const staged = (): boolean => {
  const tmp = path.join(root, '.vx', 'tmp')
  try {
    return readdirSync(tmp).some((d) => {
      try {
        return readdirSync(path.join(tmp, d)).some(
          (n) =>
            existsSync(path.join(tmp, d, n, 'f1')) || readdirSync(path.join(tmp, d, n)).length > 0,
        )
      } catch {
        return false
      }
    })
  } catch {
    return false
  }
}

it('a directory a sibling made while the tree was staged is filled, not replaced', async () => {
  expect((await build()).ok).toBe(true)
  await rm(path.join(app, 'dist'), { recursive: true })
  const dist = path.join(app, 'dist')
  let made: number | undefined
  const poll = setInterval(() => {
    if (made !== undefined || !staged()) return
    try {
      mkdirSync(dist)
      made = statSync(dist).ino
    } catch {
      // landed already: `made` stays unset and the test fails below
    }
  }, 0)
  const second = await build().finally(() => clearInterval(poll))
  expect(second.outcomes[0]?.cache?.restored).toBe(true)
  // The staging was seen: otherwise the test proved nothing.
  expect(made).toBeNumber()
  expect([statSync(dist).ino, readdirSync(dist).length]).toEqual([made ?? -1, FILES])
})

it('renameNew refuses a standing empty directory and leaves both trees', async () => {
  const { renameNew } = await import('../src/util/index.js')
  mkdirSync(path.join(root, 'from'))
  await writeFile(path.join(root, 'from', 'f'), 'x')
  mkdirSync(path.join(root, 'to'))
  const ino = statSync(path.join(root, 'to')).ino
  const err = await renameNew(path.join(root, 'from'), path.join(root, 'to')).catch((e) => e)
  expect([
    err?.code,
    statSync(path.join(root, 'to')).ino,
    existsSync(path.join(root, 'from', 'f')),
  ]).toEqual(['EEXIST', ino, true])
  await renameNew(path.join(root, 'from'), path.join(root, 'new'))
  // Any other refusal keeps its own code, read off errno.
  const gone = await renameNew(path.join(root, 'from'), path.join(root, 'newer')).catch((e) => e)
  expect(gone?.code).toBe('ENOENT')
  expect(existsSync(path.join(root, 'new', 'f'))).toBe(true)
})
