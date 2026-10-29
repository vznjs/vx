// A file the plugin reads that is there but cannot be read is never taken
// for one that is absent: absent, it turns a check off or keys nothing,
// and the run goes on from a guess. Only ENOENT means absent.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { DiscoverContext, TaskNode } from '@vzn/vx'
import { bun, pnpm } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-io-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const PNPM = "lockfileVersion: '9.0'\n\nimporters:\n\n  .: {}\n\n  packages/a: {}\n"

const discover = async (plugin = pnpm()): Promise<readonly unknown[]> => {
  const ctx: DiscoverContext = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    projects: [],
    warn() {},
    worktreeChanges: async () => null,
  }
  return await plugin.discover!(ctx)
}

it('an unparsable pnpm-workspace.yaml refuses the lock, named, not every workspace check', async () => {
  // Read as no globs, it found no workspace dir, so a workspace the
  // lockfile does not list yet passed `vx lock` with no edges.
  await writeFile(path.join(root, 'pnpm-lock.yaml'), PNPM)
  await writeFile(path.join(root, 'package.json'), '{"name":"r"}')
  await mkdir(path.join(root, 'packages/a'), { recursive: true })
  await writeFile(path.join(root, 'packages/a/package.json'), '{"name":"a"}')
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages: [\n')
  await expect(discover()).rejects.toThrow('pnpm-workspace.yaml: not YAML (')
  // CONTROL: none at all is no globs, as pnpm reads it.
  await rm(path.join(root, 'pnpm-workspace.yaml'))
  expect(await discover()).toHaveLength(1)
})

it('a settings file that is there but unreadable refuses the key, not folds as absent', async () => {
  await mkdir(path.join(root, '.npmrc'))
  const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn() {} }
  await expect(pnpm().key!({ projectDir: root } as TaskNode, ctx)).rejects.toThrow('.npmrc')
})

it('a package.json that is there but unreadable refuses the lock, not reads as no manifest', async () => {
  // Read as none, the root's workspace globs were none: a workspace the
  // lockfile does not list yet passed `vx lock` with no edges.
  await writeFile(
    path.join(root, 'bun.lock'),
    '{ "lockfileVersion": 1, "workspaces": { "": { "name": "r" } }, "packages": {} }\n',
  )
  await mkdir(path.join(root, 'package.json'))
  await expect(discover(bun())).rejects.toThrow('package.json: cannot be read (')
  // CONTROL: none at all is no manifest.
  await rm(path.join(root, 'package.json'), { recursive: true })
  expect(await discover(bun())).toBeDefined()
})
