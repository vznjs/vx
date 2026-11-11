// macOS git (core.precomposeunicode, the default) reports paths NFC while
// APFS keeps a name as created, so a project dir a tool made NFD is
// discovered NFD from readdir. Simulated here: git's NFC path against an
// NFD project dir that is the same directory (a link, as APFS folds the two
// names), the two spellings the two sources hand over on macOS.
import { appendFile, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { gitIn, gitInitCommit } from './helpers/workspace.js'

const NFC = 'café'
const NFD = 'café'

let root: string

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-aff-nfc-')))
  await mkdir(path.join(root, 'packages', NFC), { recursive: true })
  await writeFile(path.join(root, 'packages', NFC, 'x.txt'), '1\n')
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

it('a git NFC path selects the project whose dir was discovered NFD', async () => {
  await nfdNamesNfcDir()
  await writeFile(path.join(root, 'packages', NFC, 'x.txt'), '2\n')
  gitIn(root)('commit', '-qam', 'edit')
  const projects = [
    {
      name: 'cafe',
      dir: path.join(root, 'packages', NFD),
      packageJson: { name: 'cafe' } as never,
      configPath: null,
    },
  ]
  const owners = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
  expect([...owners]).toEqual(['cafe'])
})

// The parent a NEW nested project took files from is found by the nested
// dir's NFD spelling too: that lookup has no realpath to fall back on.
it('a new nested project discovered NFD re-selects the project above it', async () => {
  await nfdNamesNfcDir()
  await writeFile(path.join(root, 'packages', NFC, 'package.json'), '{"name":"cafe"}\n')
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-qm', 'nest')
  const projects = [
    ['outer', path.join(root, 'packages')],
    ['cafe', path.join(root, 'packages', NFD)],
  ].map(([name, dir]) => ({
    name: name!,
    dir: dir!,
    packageJson: { name } as never,
    configPath: null,
  }))
  const owners = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
  expect([...owners].toSorted()).toEqual(['cafe', 'outer'])
})

// vercel/turborepo#11137: names git quotes outside `-z` (CJK, Cyrillic,
// an emoji, a space) each select their project, committed, edited in the
// tree or untracked. CONTROL: an untouched project stays out.
it('a changed file with a non-ASCII or spaced name selects its project', async () => {
  const names = { cjk: '测试 文件.txt', cyr: 'файл.rs', emoji: 'emoji_🚀.md', quiet: 'q.txt' }
  for (const [p, f] of Object.entries(names)) {
    await mkdir(path.join(root, 'packages', p), { recursive: true })
    if (p !== 'emoji') await writeFile(path.join(root, 'packages', p, f), '1\n')
  }
  gitIn(root)('add', '-A')
  gitIn(root)('commit', '-qm', 'base')
  await writeFile(path.join(root, 'packages', 'cjk', names.cjk), '2\n')
  gitIn(root)('commit', '-qam', 'edit')
  await writeFile(path.join(root, 'packages', 'cyr', names.cyr), '2\n')
  await writeFile(path.join(root, 'packages', 'emoji', names.emoji), 'new\n')
  const projects = Object.keys(names).map((name) => ({
    name,
    dir: path.join(root, 'packages', name),
    packageJson: { name } as never,
    configPath: null,
  }))
  const owners = await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects })
  expect([...owners].toSorted()).toEqual(['cjk', 'cyr', 'emoji'])
})

// Linux keeps `café` NFC and NFD as two directories and git reports each
// byte-exact: keyed NFC, the two projects were one key and an edit in one
// selected the other. APFS cannot hold both names.
it.skipIf(process.platform === 'darwin')(
  'NFC and NFD sibling projects are each selected by their own edit',
  async () => {
    await mkdir(path.join(root, 'packages', NFD), { recursive: true })
    await writeFile(path.join(root, 'packages', NFD, 'x.txt'), '1\n')
    gitIn(root)('add', '-A')
    gitIn(root)('commit', '-qm', 'nfd')
    const projects = [
      ['nfc', NFC],
      ['nfd', NFD],
    ].map(([name, dir]) => ({
      name: name!,
      dir: path.join(root, 'packages', dir!),
      packageJson: { name } as never,
      configPath: null,
    }))
    const owners = async (): Promise<string[]> =>
      [...(await affectedProjects({ workspaceRoot: root, since: 'HEAD~1', projects }))].toSorted()
    for (const [name, dir] of [
      ['nfc', NFC],
      ['nfd', NFD],
    ]) {
      await writeFile(path.join(root, 'packages', dir!, 'x.txt'), `${name}\n`)
      gitIn(root)('commit', '-qam', name!)
      expect(await owners()).toEqual([name!])
    }
  },
)
