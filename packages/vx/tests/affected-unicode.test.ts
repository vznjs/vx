// macOS git (core.precomposeunicode, the default) reports paths NFC while
// APFS keeps a name as created, so a project dir a tool made NFD is
// discovered NFD from readdir. Simulated here: git's NFC path against an
// NFD project dir, the two spellings the two sources hand over on macOS.
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
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

it('a git NFC path selects the project whose dir was discovered NFD', async () => {
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
