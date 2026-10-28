// A clean never deletes from Git's or vx's metadata. An output glob's
// literal head is followed (X-88), and the only check asked that its real
// path stay in the project: for the root project and for
// `outputs.workspaceFiles`, `.git` is in it, so `dist -> .git` with
// `dist/**` had the clean before a run, and the stale sweep after a hit,
// delete the repository. A link below the head is unlinked, never followed.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import {
  cleanOutputPaths,
  cleanOutputs,
  cleanWorkspaceOutputs,
  resolveOutputs,
  resolveWorkspaceOutputs,
} from '../src/cache/inputs.js'

let root = ''
beforeEach(() => {
  root = realpathSync(mkdtempSync(path.join(tmpdir(), 'vx-clean-link-git-')))
  mkdirSync(path.join(root, '.git', 'refs'), { recursive: true })
  writeFileSync(path.join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  writeFileSync(path.join(root, '.git', 'refs', 'keep'), 'x')
  mkdirSync(path.join(root, '.vx', 'cache'), { recursive: true })
  writeFileSync(path.join(root, '.vx', 'cache', 'db'), 'x')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

const intact = (): void => {
  expect(readdirSync(path.join(root, '.git')).sort()).toEqual(['HEAD', 'refs'])
  expect(readdirSync(path.join(root, '.git', 'refs'))).toEqual(['keep'])
  expect(readdirSync(path.join(root, '.vx', 'cache'))).toEqual(['db'])
}

const refusal = (link: string, to: string): string =>
  `${path.join(root, link)} is a symbolic link to ${path.join(root, to)}, Git's or vx's ` +
  'metadata — vx never cleans, saves or restores declared outputs through a link into ' +
  '.git or .vx. Remove the link and re-run, or stop declaring outputs under it.'

for (const to of ['.git', '.git/refs', '.vx']) {
  it(`a project output dir linked to ${to} is refused, and nothing is deleted`, async () => {
    symlinkSync(to, path.join(root, 'dist'))
    const args = { projectDir: root, outputs: ['dist/**'], nestedProjectDirs: [] }
    // The miss's clean, and the hit's walk that feeds its sweep.
    await expect(cleanOutputs(args)).rejects.toThrow(refusal('dist', to))
    await expect(resolveOutputs(args)).rejects.toThrow(refusal('dist', to))
    intact()
  })

  it(`a workspace output dir linked to ${to} is refused, and nothing is deleted`, async () => {
    symlinkSync(to, path.join(root, 'out'))
    const args = { workspaceRoot: root, outputs: ['out/**'] }
    await expect(cleanWorkspaceOutputs(args)).rejects.toThrow(refusal('out', to))
    await expect(resolveWorkspaceOutputs(args)).rejects.toThrow(refusal('out', to))
    intact()
  })
}

it('a .git spelled in another case is refused', async () => {
  mkdirSync(path.join(root, '.GIT'))
  writeFileSync(path.join(root, '.GIT', 'keep'), 'x')
  symlinkSync('.GIT', path.join(root, 'dist'))
  await expect(
    cleanOutputs({ projectDir: root, outputs: ['dist/**'], nestedProjectDirs: [] }),
  ).rejects.toThrow(refusal('dist', '.GIT'))
  expect(existsSync(path.join(root, '.GIT', 'keep'))).toBe(true)
})

it("a hit's recorded rows are never removed through a link into .git", async () => {
  symlinkSync('.git', path.join(root, 'dist'))
  await cleanOutputPaths({ projectDir: root, rels: ['dist/HEAD'], outputs: ['dist/**'] })
  intact()
})

it('control: a link below the glob root is unlinked, never followed', async () => {
  mkdirSync(path.join(root, 'dist'))
  writeFileSync(path.join(root, 'dist', 'a.js'), 'x')
  symlinkSync('../.git', path.join(root, 'dist', 'g'))
  await cleanOutputs({ projectDir: root, outputs: ['dist/**'], nestedProjectDirs: [] })
  expect(readdirSync(path.join(root, 'dist'))).toEqual([])
  intact()
})

it('control: a link out of the project is still refused as leaving it', async () => {
  const project = path.join(root, 'p')
  mkdirSync(project)
  symlinkSync('../.git', path.join(project, 'dist'))
  await expect(
    cleanOutputs({ projectDir: project, outputs: ['dist/**'], nestedProjectDirs: [] }),
  ).rejects.toThrow(`outside ${project}`)
  intact()
})

it('control: a link to a .git-like name is cleaned through', async () => {
  mkdirSync(path.join(root, '.github'))
  writeFileSync(path.join(root, '.github', 'a.yml'), 'x')
  symlinkSync('.github', path.join(root, 'dist'))
  await cleanOutputs({ projectDir: root, outputs: ['dist/**'], nestedProjectDirs: [] })
  expect(readdirSync(path.join(root, '.github'))).toEqual([])
})
