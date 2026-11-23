// A sandboxed task in a workspace whose root holds a space, an NFD name,
// a quote and glob characters, writing outputs with such names: macOS
// spells each path into a seatbelt profile, Linux into bwrap's binds and
// the tracer's records. The task runs, its outputs save and restore, and
// a write no grant covers is named by its own path.
import { readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { PARITY_TIMEOUT as TIMEOUT, vx } from './helpers/parity.js'
import { sandboxAvailable } from './helpers/sandbox-gate.js'

const available = await sandboxAvailable('sandbox odd names test')

const NFD = 'café'
const NAMES = [
  'a b.txt',
  `${NFD}.txt`,
  `${NFD} dir/[x] y.txt`,
  '{a,b}.txt',
  'quote".txt',
  '中文/文件.txt',
]

let root = ''
let app = ''

async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {}
  for (const e of await readdir(dir, { recursive: true, withFileTypes: true }))
    if (e.isFile()) {
      const abs = path.join(e.parentPath, e.name)
      out[path.relative(dir, abs)] = await readFile(abs, 'utf8')
    }
  return out
}

describe.skipIf(!available)('a sandboxed task among odd names', () => {
  beforeAll(async () => {
    // A seatbelt profile cannot spell a double quote, and the Mac refuses a
    // project dir holding [ ] * ? (its sandbox reads them as a pattern), so
    // the Mac's root goes without both.
    const odd = process.platform === 'darwin' ? '' : ' [w]{s}"q'
    root = await makeWorkspace({ prefix: `vx-sb odd ${NFD}${odd}-`, edges: {} })
    const files: Record<string, string> = {}
    for (const n of NAMES) files[`src/${n}`] = `v1 ${n}\n`
    const task = (command: string, outputs: string) => `{
      exec: { command: ${JSON.stringify(command)}, sandbox: { allow: { read: ['.'], write: ['dist/'], systemInfo: ['vfs.disk-space'] } } },
      inputs: { files: ['src/**'] }, outputs: { files: [${outputs}] }, cache: true }`
    app = await addProject(root, '@scope/odd app', {
      config: `export default { tasks: {
  build: ${task('mkdir -p dist && cp -R src/. dist/', "'dist/**'")},
  stray: ${task(`mkdir "gen ${NFD} [y]"`, '')},
} }\n`,
      files,
    })
    const git = gitIn(root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    expect((await vx(root, ['lock'])).code).toBe(0)
  }, TIMEOUT)

  afterAll(async () => {
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  it(
    'runs, saves and restores every name',
    async () => {
      const want = await tree(path.join(app, 'src'))
      const first = await vx(root, ['run', '@scope/odd app#build'])
      expect(first.code).toBe(0)
      expect(await tree(path.join(app, 'dist'))).toEqual(want)
      await rm(path.join(app, 'dist'), { recursive: true })
      const hit = await vx(root, ['run', '@scope/odd app#build'])
      expect(hit.code).toBe(0)
      expect(hit.out).toContain('restored-local')
      expect(await tree(path.join(app, 'dist'))).toEqual(want)
    },
    TIMEOUT,
  )

  it(
    'names a refused write by its own path',
    async () => {
      const r = await vx(root, ['run', '@scope/odd app#stray'])
      expect(r.code).not.toBe(0)
      expect(r.out + r.err).toContain(`gen ${NFD} [y]`)
    },
    TIMEOUT,
  )
})
