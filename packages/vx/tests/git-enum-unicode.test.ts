// macOS git (core.precomposeunicode, the default) reports paths NFC while
// APFS keeps a name as created, so a project dir a tool made NFD is
// discovered NFD from readdir. Simulated here: git's NFC paths against an
// NFD project dir that is the same directory (a link, as APFS folds the two
// names). The shared enumeration must still hand that project its slice and
// trusted OIDs, or every task in it spawns its own `git ls-files`.
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { applyGitEnumeration, GitFilesCache, startGitEnumeration } from '../src/cache/index.js'
import { resolveInputs } from '../src/cache/inputs.js'
import { relPosix } from '../src/util/index.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

const NFC = 'café'
const NFD = 'café'

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-enum-nfc-')))
  await mkdir(path.join(root, 'packages', NFC, 'src'), { recursive: true })
  await writeFile(path.join(root, 'packages', NFC, 'package.json'), '{"name":"cafe"}\n')
  await writeFile(path.join(root, 'packages', NFC, 'src', 'a.ts'), 'a\n')
  gitInitCommit(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

/** The NFD name as a second name of the NFC dir: APFS already makes it one. */
async function nfdNamesNfcDir(): Promise<void> {
  if (process.platform === 'darwin') return
  await symlink(NFC, path.join(root, 'packages', NFD))
  await appendFile(path.join(root, '.git', 'info', 'exclude'), `packages/${NFD}\n`)
}

async function inputsOf(spelling: string): Promise<{
  files: string[]
  oids: Array<[string, string]>
  gitSpawns: number
}> {
  const dir = path.join(root, 'packages', spelling)
  const cache = new GitFilesCache()
  await applyGitEnumeration(await startGitEnumeration(root, ['.']), root, [dir], cache)
  const origSpawn = Bun.spawn
  const origSpawnSync = Bun.spawnSync
  let gitSpawns = 0
  const count = (opt: unknown): void => {
    const cmd = (opt as { cmd?: readonly string[] } | undefined)?.cmd
    if (Array.isArray(cmd) && path.basename(cmd[0] ?? '') === 'git') gitSpawns++
  }
  const bunMut = Bun as unknown as { spawn: typeof Bun.spawn; spawnSync: typeof Bun.spawnSync }
  bunMut.spawn = ((...a: Parameters<typeof Bun.spawn>) => {
    count(a[0])
    return origSpawn(...a)
  }) as typeof Bun.spawn
  bunMut.spawnSync = ((...a: Parameters<typeof Bun.spawnSync>) => {
    count(a[0])
    return origSpawnSync(...a)
  }) as typeof Bun.spawnSync
  try {
    const got = await resolveInputs({
      projectDir: dir,
      workspaceRoot: root,
      envSource: {},
      inputs: { files: ['**/*'] },
      ownOutputs: [],
      nestedProjectDirs: [],
      gitFilesCache: cache,
    })
    return {
      files: got.files.map((f) => relPosix(dir, f)),
      oids: [...(cache.oidsFor(dir) ?? [])].map(([abs, oid]) => [relPosix(dir, abs), oid]),
      gitSpawns,
    }
  } finally {
    bunMut.spawn = origSpawn
    bunMut.spawnSync = origSpawnSync
  }
}

it('an NFD project dir takes its slice of the NFC enumeration, spawning no git', async () => {
  await nfdNamesNfcDir()
  const nfc = await inputsOf(NFC)
  expect(nfc.files).toEqual(['package.json', 'src/a.ts'])
  expect(nfc.oids.map(([rel]) => rel).sort()).toEqual(['package.json', 'src/a.ts'])
  expect(nfc.gitSpawns).toBe(0)
  const nfd = await inputsOf(NFD)
  expect(nfd).toEqual(nfc)
})

// Linux keeps `café` NFC and NFD as two directories, and git lists each
// byte-exact: the NFD project took the NFC sibling's slice and OIDs, so an
// edit to its own file was a stale hit. APFS cannot hold both names.
it.skipIf(process.platform === 'darwin')(
  'NFC and NFD sibling projects each take their own slice where the disk holds both',
  async () => {
    await mkdir(path.join(root, 'packages', NFD, 'src'), { recursive: true })
    await writeFile(path.join(root, 'packages', NFD, 'package.json'), '{"name":"cafe-nfd"}\n')
    await writeFile(path.join(root, 'packages', NFD, 'src', 'b.ts'), 'b\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-qm', 'nfd')
    const dirs = [NFC, NFD].map((s) => path.join(root, 'packages', s))
    const cache = new GitFilesCache()
    await applyGitEnumeration(await startGitEnumeration(root, ['.']), root, dirs, cache)
    const own = (dir: string): string[] =>
      [...(cache.oidsFor(dir) ?? [])].map(([abs]) => relPosix(dir, abs)).sort()
    expect(own(dirs[0]!)).toEqual(['package.json', 'src/a.ts'])
    expect(own(dirs[1]!)).toEqual(['package.json', 'src/b.ts'])
    const nfd = await inputsOf(NFD)
    expect(nfd.files).toEqual(['package.json', 'src/b.ts'])
    expect(nfd.gitSpawns).toBe(0)
  },
)
