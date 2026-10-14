// Which lockfile a plugin reads, now that core folds none: npm() reads
// npm-shrinkwrap.json over package-lock.json, as npm does, and bun()
// refuses a lone bun.lockb, Bun's binary lockfile, which nothing parses.
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { DiscoverContext, ProjectMeta, TaskNode, VxPlugin } from '@vzn/vx'
import { bun, npm } from '../src/index.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-lock-choice-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** One run's key for a task at the root: a fresh context, as core hands each run. */
async function key(plugin: VxPlugin): Promise<Readonly<Record<string, string>> | undefined> {
  const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx', 'cache'), warn() {} }
  return plugin.key!({ projectDir: root } as TaskNode, ctx)
}

async function discover(plugin: VxPlugin): Promise<unknown> {
  const projects: ProjectMeta[] = [
    { name: 'ws', dir: root, configPath: null, packageJson: { name: 'ws' } } as ProjectMeta,
  ]
  const ctx = {
    workspaceRoot: root,
    cacheDir: path.join(root, '.vx', 'cache'),
    warn() {},
    projects,
  } as unknown as DiscoverContext
  return plugin.discover!(ctx)
}

/** An npm v3 lockfile whose root depends on `left` at `version`. */
function npmLock(version: string): string {
  return JSON.stringify({
    name: 'ws',
    lockfileVersion: 3,
    requires: true,
    packages: {
      '': { name: 'ws', dependencies: { left: version } },
      'node_modules/left': {
        version,
        resolved: `https://r/left-${version}.tgz`,
        integrity: `sha512-left${version}`,
      },
    },
  })
}

describe('npm(): npm-shrinkwrap.json', () => {
  it('claims both lockfiles and .npmrc', () => {
    expect(npm().fingerprint?.files).toEqual(['npm-shrinkwrap.json', 'package-lock.json', '.npmrc'])
  })

  it('keys on npm-shrinkwrap.json alone', async () => {
    await writeFile(path.join(root, 'npm-shrinkwrap.json'), npmLock('1.0.0'))
    const one = await key(npm())
    expect(one).toBeDefined()
    await writeFile(path.join(root, 'npm-shrinkwrap.json'), npmLock('2.0.0'))
    expect(await key(npm())).not.toEqual(one)
  })

  it('keys a shrinkwrap as the package-lock.json it was renamed from', async () => {
    await writeFile(path.join(root, 'package-lock.json'), npmLock('1.0.0'))
    const lock = await key(npm())
    await rm(path.join(root, 'package-lock.json'))
    await writeFile(path.join(root, 'npm-shrinkwrap.json'), npmLock('1.0.0'))
    expect(await key(npm())).toEqual(lock!)
  })

  it('beside a package-lock.json, the shrinkwrap is what keys, as npm installs it', async () => {
    await writeFile(path.join(root, 'npm-shrinkwrap.json'), npmLock('1.0.0'))
    await writeFile(path.join(root, 'package-lock.json'), npmLock('1.0.0'))
    const both = await key(npm())
    await writeFile(path.join(root, 'package-lock.json'), npmLock('9.0.0'))
    expect(await key(npm())).toEqual(both!)
    await writeFile(path.join(root, 'npm-shrinkwrap.json'), npmLock('2.0.0'))
    expect(await key(npm())).not.toEqual(both)
  })

  it('discover reads the shrinkwrap', async () => {
    await writeFile(path.join(root, 'npm-shrinkwrap.json'), npmLock('1.0.0'))
    expect(await discover(npm())).toEqual([{ dir: root, name: 'ws', deps: [], reach: [] }])
  })
})

describe('bun(): a lone bun.lockb', () => {
  const REFUSAL =
    'bun.lockb: bun() reads bun.lock and finds none — run `bun install --save-text-lockfile` to write bun.lock'

  it('is refused by key and discover, naming the fix', async () => {
    await writeFile(path.join(root, 'bun.lockb'), new Uint8Array([0, 1, 2]))
    await expect(key(bun())).rejects.toThrow(REFUSAL)
    await expect(discover(bun())).rejects.toThrow(REFUSAL)
  })

  it('beside a bun.lock, or with no lockfile at all, is no refusal', async () => {
    // CONTROL: no lockfile keys nothing, as before.
    expect(await key(bun())).toBeUndefined()
    await writeFile(path.join(root, 'bun.lockb'), new Uint8Array([0, 1, 2]))
    await writeFile(
      path.join(root, 'bun.lock'),
      JSON.stringify({ lockfileVersion: 1, workspaces: { '': { name: 'ws' } }, packages: {} }),
    )
    expect(await key(bun())).toBeDefined()
  })
})
