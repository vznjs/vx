// A workspace package with no vx config is still a project: `--affected`
// gives its changed files to it (the deepest project dir), and its default
// `build` keys them. The key's and the clean's fence were built from the
// config-bearing projects alone, so a root `build` reading `**` folded a
// config-less member's files while `--affected` did not select it (a CI
// gate went green past a task whose key moved), and a root output glob
// `**/*.js` cleaned the member's tracked source (X-57).

import { existsSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { silentLogger, TIMEOUT } from './helpers/orchestrator-fixture.js'
import { addProject, gitIn, gitInitCommit, makeWorkspace } from './helpers/workspace.js'

const CLI = path.join(import.meta.dir, '..', 'src', 'bin.ts')

let root: string | undefined
afterEach(async () => {
  if (root) await rm(root, { recursive: true, force: true })
  root = undefined
})

const B_CONFIG = `export default { tasks: { build: {
  exec: { command: 'true' },
  cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } },
} } }
`

/** The root (`r`) builds over `**`; `a` has no config, `b` has one. */
async function workspace(rootOutputs: string, command = 'true'): Promise<string> {
  const r = (root = await makeWorkspace({
    prefix: 'vx-configless-fence-',
    rootName: 'r',
    git: false,
  }))
  await writeFile(
    path.join(r, 'vx.config.mjs'),
    `export default { tasks: { build: {
      exec: { command: ${JSON.stringify(command)} },
      cache: { inputs: { files: ['**'] }, outputs: { files: ${rootOutputs} } },
    } } }
`,
  )
  await writeFile(path.join(r, 'own.txt'), 'own-1\n')
  await addProject(r, 'a', { files: { 'src/a.js': 'a-1\n' } })
  await addProject(r, 'b', { config: B_CONFIG, files: { 'src/b.js': 'b-1\n' } })
  gitInitCommit(r)
  return r
}

function plan(cwd: string, ...args: string[]): Map<string, string> {
  const p = Bun.spawnSync({
    cmd: ['bun', CLI, 'run', 'build', ...args, '--dry=json'],
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, CI: '', GITHUB_ACTIONS: '', NO_COLOR: '1' },
  })
  const out = new TextDecoder().decode(p.stdout)
  expect(p.exitCode, out + new TextDecoder().decode(p.stderr)).toBe(0)
  const tasks = (
    JSON.parse(out.slice(out.indexOf('{'))) as { tasks: { id: string; hash: string }[] }
  ).tasks
  return new Map(tasks.map((t) => [t.id, t.hash]))
}

async function commitEdit(r: string, rel: string, content: string): Promise<void> {
  await writeFile(path.join(r, rel), content)
  const git = gitIn(r)
  git('add', '-A')
  git('commit', '-q', '-m', `edit ${rel}`)
}

it(
  "a config-less member's edit moves the root's key exactly when --affected selects the root",
  async () => {
    const r = await workspace('[]')
    const before = plan(r, '--all').get('r#build')
    expect(before).toBeDefined()

    await commitEdit(r, 'packages/a/src/a.js', 'a-2\n')
    expect(plan(r, '--all').get('r#build')).toBe(before)
    expect([...plan(r, '--affected=HEAD~1').keys()].sort()).toEqual(['a#build'])

    // Control: the root's own file moves its key and selects it.
    await commitEdit(r, 'own.txt', 'own-2\n')
    expect(plan(r, '--all').get('r#build')).not.toBe(before)
    expect([...plan(r, '--affected=HEAD~1').keys()].sort()).toEqual(['r#build'])
  },
  TIMEOUT,
)

it(
  "the root's output clean leaves a config-less member's file alone",
  async () => {
    const r = await workspace(`['**/*.js']`, 'echo out > out.js')
    await writeFile(path.join(r, 'stale.js'), 'stale\n')
    const fixture = { root: r, log: [], err: [] }
    const result = await run({ cwd: r, tasks: ['r#build'], log: silentLogger(fixture) })
    expect(result.ok, fixture.err.join('\n')).toBe(true)
    // Control: the clean ran, and took the root's own stale output.
    expect(existsSync(path.join(r, 'stale.js'))).toBe(false)
    expect(await readFile(path.join(r, 'packages/a/src/a.js'), 'utf8')).toBe('a-1\n')
    expect(await readFile(path.join(r, 'packages/b/src/b.js'), 'utf8')).toBe('b-1\n')
  },
  TIMEOUT,
)
