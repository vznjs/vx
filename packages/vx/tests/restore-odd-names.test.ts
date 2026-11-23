// Names a user's tree really holds, in one workspace: a root and a scoped
// project dir with spaces, unicode and glob characters, and inputs and
// outputs named with each. macOS is the point (a Mac worker runs this
// file): APFS keeps an NFD name as created while git reports it NFC, and
// a quote or a backslash is a legal name there too. Each name keys, saves,
// restores byte for byte under its own spelling, and an edit to it misses.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { dry, PARITY_TIMEOUT as TIMEOUT, vx } from './helpers/parity.js'

const NFC = 'café'
const NFD = 'café'
// NFC and NFD of one name are one file on APFS: each gets its own name here.
const NAMES = [
  'a b.txt',
  `${NFC} c.txt`,
  `${NFD} d.txt`,
  `${NFD} dir/[x] y.txt`,
  '{a,b}.txt',
  '*star?.txt',
  '!bang #hash $d.txt',
  'quote".txt',
  'back\\slash.txt',
  '中文/文件.txt',
  'emoji😀.txt',
  `${'L'.repeat(200)}.txt`,
]
const ID = '@scope/odd app#build'

let root: string
let app: string

/** Every file under `dir` by its name as the file system spells it, with its text. */
async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const rel of await readdir(dir, { recursive: true, withFileTypes: true }))
    if (rel.isFile()) {
      const abs = path.join(rel.parentPath, rel.name)
      out[path.relative(dir, abs)] = await readFile(abs, 'utf8')
    }
  return out
}

beforeAll(async () => {
  root = await makeWorkspace({ prefix: `vx-odd ${NFD} [w]{s}"q-`, edges: {} })
  const files: Record<string, string> = {}
  for (const n of NAMES) files[`src/${n}`] = `v1 ${n}\n`
  app = await addProject(root, '@scope/odd app', {
    config: `export default { tasks: { build: {
  exec: { command: 'mkdir -p dist && cp -R src/. dist/' },
  inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true } } }\n`,
    files,
  })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  // Untracked: hashed from disk, not from git's OIDs.
  await mkdir(path.join(app, 'src', `new ${NFD}`))
  await writeFile(path.join(app, 'src', `new ${NFD}`, 'u [1].txt'), 'u1\n')
  expect((await vx(root, ['lock'])).code).toBe(0)
}, TIMEOUT)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it(
  'saves and restores every name under its own spelling, byte for byte',
  async () => {
    const want = await tree(path.join(app, 'src'))
    expect(Object.keys(want)).toHaveLength(NAMES.length + 1)
    const first = await vx(root, ['run', ID])
    expect(first.code).toBe(0)
    expect(await tree(path.join(app, 'dist'))).toEqual(want)

    await rm(path.join(app, 'dist'), { recursive: true })
    const hit = await vx(root, ['run', ID])
    expect(hit.code).toBe(0)
    expect(hit.out).toContain('restored-local')
    expect(await tree(path.join(app, 'dist'))).toEqual(want)
  },
  TIMEOUT,
)

it(
  'misses on an edit to each name, tracked or not',
  async () => {
    expect((await vx(root, ['run', ID])).code).toBe(0)
    const kept: string[] = []
    for (const n of [...NAMES, `new ${NFD}/u [1].txt`]) {
      const file = path.join(app, 'src', n)
      const before = await readFile(file, 'utf8')
      await writeFile(file, `${before}v2\n`)
      const [task] = await dry(root, [ID])
      if (task!.cacheStatus !== 'miss') kept.push(`${JSON.stringify(n)}: ${task!.cacheStatus}`)
      await writeFile(file, before)
    }
    expect(kept).toEqual([])
  },
  TIMEOUT,
)
