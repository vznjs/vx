// --affected and a clean filter (`text`, `eol`, `core.autocrlf`): a CRLF
// edit to an LF file hashes, through the filter, to the base's blob, so
// `git diff` and `hash-object` call it unchanged, while the key hashes
// the raw bytes (git-inputs.ts trusts no OID a filter can touch) and moved.
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import { affectedProjects } from '../src/workspace/affected.js'
import { lock } from './helpers/orchestrator.js'
import { addProject, gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

let root: string
let git: (...args: string[]) => string

beforeEach(async () => {
  root = await makeWorkspace({ prefix: 'vx-affected-filters-', git: false })
  for (const name of ['a', 'b']) {
    await addProject(root, name, {
      config:
        "export default { tasks: { build: { exec: { command: 'true' }, inputs: { files: ['**'] }, outputs: { files: [] }, cache: true } } }\n",
      files: { 'src/index.js': 'export {}\n' },
    })
  }
  gitInitCommit(root)
  await lock(root)
  git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'lock')
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

const projects = () =>
  ['a', 'b'].map((name) => ({ name, dir: path.join(root, 'packages', name), configPath: null }))

const owners = async () =>
  [...(await affectedProjects({ workspaceRoot: root, since: 'HEAD', projects: projects() }))].sort()

const crlf = () => writeFile(path.join(root, 'packages/a/src/index.js'), 'export {}\r\n')

it('a CRLF edit under a committed `* text=auto` selects its project', async () => {
  await writeFile(path.join(root, '.gitattributes'), '* text=auto\n')
  git('add', '.gitattributes')
  git('commit', '-q', '-m', 'attrs')
  await crlf()
  expect(await owners()).toEqual(['a'])
})

it('a CRLF edit under `core.autocrlf input` selects its project', async () => {
  git('config', 'core.autocrlf', 'input')
  await crlf()
  expect(await owners()).toEqual(['a'])
})

it('a CRLF edit to an assume-unchanged file under a filter selects its project', async () => {
  git('config', 'core.autocrlf', 'input')
  git('update-index', '--assume-unchanged', 'packages/a/src/index.js')
  await crlf()
  expect(await owners()).toEqual(['a'])
})
