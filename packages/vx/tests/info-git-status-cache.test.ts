// `vx info`'s git status cache row reads the value git itself takes:
// the last one set wins, and core.fsmonitor naming a hook is on.
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { gitStatusCache } from '../src/orchestrator/doctor.js'
import { gitIn, gitInit } from './helpers/workspace.js'

let dir: string | undefined
afterEach(async () => {
  if (dir !== undefined) await rm(dir, { recursive: true, force: true })
})

const repo = async (...config: [string, string][]) => {
  dir = await mkdtemp(path.join(os.tmpdir(), 'vx-info-gsc-'))
  gitInit(dir)
  const git = gitIn(dir)
  for (const [k, v] of config) git('config', '--add', k, v)
  return gitStatusCache(dir)
}

it('a later value overrides an earlier one, as git reads it', async () => {
  expect(
    await repo(
      ['core.untrackedCache', 'true'],
      ['core.untrackedCache', 'false'],
      ['core.fsmonitor', 'false'],
      ['core.fsmonitor', 'true'],
    ),
  ).toEqual({ fsmonitor: true, untrackedCache: false })
})

it('core.fsmonitor naming a hook is on', async () => {
  expect(await repo(['core.fsmonitor', '.git/hooks/fsmonitor-watchman'])).toEqual({
    fsmonitor: true,
    untrackedCache: false,
  })
})

it('nothing set is off', async () => {
  expect(await repo()).toEqual({ fsmonitor: false, untrackedCache: false })
})
