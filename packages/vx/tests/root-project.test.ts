// A workspace-root task (D-39): a `vx.config` at a root the package globs
// do not list makes the root package a project. Before, the file was
// ignored: `a#test` depending on `fixture-root#build` refused with "no such
// project", and every adoption path dropped the root tasks it met.
// Design: docs/design/root-project-2026-09-28.md.
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { run } from '../src/orchestrator/index.js'
import { affectedProjects, listProjects, loadWorkspace } from '../src/workspace/index.js'
import { silentLogger, type Fixture } from './helpers/orchestrator-fixture.js'
import { addProject, gitIn, makeWorkspace } from './helpers/workspace.js'

const ROOT_CONFIG = `export default {
  tasks: {
    build: {
      exec: { command: 'mkdir -p out && cat tools/gen.txt > out/gen.txt' },
      cache: { inputs: { files: ['**/*', '!out/**'] }, outputs: { files: ['out/**'] } },
    },
  },
}
`

describe('a root vx.config makes the root a project (D-39)', () => {
  let fixture: Fixture
  beforeEach(async () => {
    const root = await makeWorkspace({ prefix: 'vx-rootproj-' })
    fixture = { root, log: [], err: [] }
    await mkdir(path.join(root, 'tools'), { recursive: true })
    await writeFile(path.join(root, 'tools', 'gen.txt'), 'one\n')
    await addProject(root, 'a', {
      config: `export default { tasks: { test: { dependsOn: ['fixture-root#build'], exec: { command: 'cat ../../out/gen.txt' } } } }\n`,
      files: { 'src/index.js': 'export const a = 1\n' },
    })
  })
  afterEach(async () => {
    await rm(fixture.root, { recursive: true, force: true })
  })

  const names = async (): Promise<string[]> =>
    (await listProjects(await loadWorkspace(fixture.root))).map((p) => p.name)

  it('is a project with the config, and is not without it', async () => {
    expect(await names()).toEqual(['a'])
    await writeFile(path.join(fixture.root, 'vx.config.mjs'), ROOT_CONFIG)
    expect(await names()).toEqual(['a', 'fixture-root'])
    // A root the globs list already is one project, not two.
    await writeFile(
      path.join(fixture.root, 'pnpm-workspace.yaml'),
      'packages:\n  - "."\n  - "packages/*"\n',
    )
    expect(await names()).toEqual(['a', 'fixture-root'])
  })

  it('runs before a member that depends on it', async () => {
    await writeFile(path.join(fixture.root, 'vx.config.mjs'), ROOT_CONFIG)
    const r = await run({ cwd: fixture.root, tasks: ['a#test'], log: silentLogger(fixture) })
    expect(r.ok).toBe(true)
    expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['a#test', 'fixture-root#build'])
  })

  it("keys on the files no member owns: a member's edit leaves it, a root file's moves it", async () => {
    await writeFile(path.join(fixture.root, 'vx.config.mjs'), ROOT_CONFIG)
    const key = async (): Promise<string> => {
      const r = await run({
        cwd: fixture.root,
        tasks: ['fixture-root#build'],
        log: silentLogger(fixture),
      })
      expect(r.ok).toBe(true)
      return r.outcomes.find((o) => o.node.id === 'fixture-root#build')!.hash!
    }
    const base = await key()
    await appendFile(path.join(fixture.root, 'packages', 'a', 'src', 'index.js'), '// edit\n')
    expect(await key()).toBe(base)
    await writeFile(path.join(fixture.root, 'tools', 'gen.txt'), 'two\n')
    expect(await key()).not.toBe(base)
  })

  it('--affected gives a file no member owns to the root, and a member file to the member', async () => {
    await writeFile(path.join(fixture.root, 'vx.config.mjs'), ROOT_CONFIG)
    const git = gitIn(fixture.root)
    git('add', '-A')
    git('commit', '-q', '-m', 'init')
    const affected = async (): Promise<string[]> => {
      const projects = await listProjects(await loadWorkspace(fixture.root))
      return [
        ...(await affectedProjects({ workspaceRoot: fixture.root, since: 'HEAD', projects })),
      ].sort()
    }
    await writeFile(path.join(fixture.root, 'tools', 'gen.txt'), 'two\n')
    expect(await affected()).toEqual(['fixture-root'])
    git('checkout', '--', 'tools/gen.txt')
    await appendFile(path.join(fixture.root, 'packages', 'a', 'src', 'index.js'), '// edit\n')
    expect(await affected()).toEqual(['a'])
  })
})
