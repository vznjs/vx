// A workspace whose path holds `!` and a space, and a project directory
// with a space: a `!` read as a negation, or a path split on its space,
// drops every input or output under it. The run keys, saves, restores and
// re-keys there as anywhere else.
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'
import { PARITY_TIMEOUT as TIMEOUT, vx } from './helpers/parity.js'

let root: string
let app: string

beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-ws!2 sp ace-', edges: { 'my app': ['lib'] } })
  const build = (name: string) => `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p dist && cat src/in.txt > dist/out.txt && echo built-${name}' },
      dependsOn: ['^build'],
      inputs: { files: ['src/**'] },
      cache: { outputs: { files: ['dist/**'] } },
    },
  },
}
`
  await addProject(root, 'lib', { config: build('lib'), files: { 'src/in.txt': 'lib\n' } })
  app = await addProject(root, 'my app', { config: build('app'), files: { 'src/in.txt': 'v1\n' } })
  const git = gitIn(root)
  git('add', '-A')
  git('commit', '-q', '-m', 'init')
  expect(app).toContain(`!2 sp ace-`)
  expect(app.endsWith(path.join('packages', 'my app'))).toBe(true)
  expect((await vx(root, ['lock'])).code).toBe(0)
}, TIMEOUT)

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it(
  'keys, saves and restores under a root with `!` and a space, and a project dir with a space',
  async () => {
    const first = await vx(root, ['run', 'my app#build'])
    expect(first.code).toBe(0)
    // A focused run frames the requested task; the dependency counts in the summary.
    expect(first.out).toMatch(/my app#build ── \(\d+ms\) success/)
    expect(first.out).toContain('2 success · 2 total')
    expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('v1\n')

    await rm(path.join(app, 'dist'), { recursive: true })
    const hit = await vx(root, ['run', 'my app#build'])
    expect(hit.code).toBe(0)
    expect(hit.out).toContain('restored-local')
    expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('v1\n')

    await writeFile(path.join(app, 'src', 'in.txt'), 'v2\n')
    const miss = await vx(root, ['run', 'my app#build'])
    expect(miss.code).toBe(0)
    expect(miss.out).toMatch(/my app#build ── \(\d+ms\) success/)
    expect(await readFile(path.join(app, 'dist', 'out.txt'), 'utf8')).toBe('v2\n')
  },
  TIMEOUT,
)
