// A workspace-root task (D-39): a `vx.config` at a root the package globs
// do not list makes the root package a project. Before, the file was
// ignored: `a#test` depending on `fixture-root#build` refused with "no such
// project", and every adoption path dropped the root tasks it met.
// Design: docs/design/root-project-2026-09-28.md.
import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadResolvedProjects, run } from '../src/orchestrator/index.js'
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

  // `vx show //#build` and `vx why //#build` read `//` as a project name, as
  // `vx run` did before E-100.
  it("show and why take //#task as the root project's task", async () => {
    await writeFile(path.join(fixture.root, 'vx.config.mjs'), ROOT_CONFIG)
    const r = await run({
      cwd: fixture.root,
      tasks: ['fixture-root#build'],
      log: silentLogger(fixture),
    })
    expect(r.ok).toBe(true)
    const bin = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
    const said = (verb: string) => {
      const p = Bun.spawnSync({
        cmd: [process.execPath, bin, verb, '//#build', '--format', 'json'],
        cwd: path.join(fixture.root, 'packages', 'a'),
        env: { ...process.env, NO_COLOR: '1' },
      })
      return [verb, p.exitCode, p.stdout.toString().includes('fixture-root')]
    }
    expect([said('show'), said('why')]).toEqual([
      ['show', 0, true],
      ['why', 0, true],
    ])
  })

  // Turbo spells the root package `//`: `dependsOn: ['//#build']` refused
  // "no such project or task" though the root is one. A scoped run (`a#test`)
  // must pull the root in too. CONTROL: with no root project, the refusal
  // says the root is no project rather than "no such project".
  it("takes Turbo's //#task as the root project's task", async () => {
    await writeFile(
      path.join(fixture.root, 'packages', 'a', 'vx.config.mjs'),
      `export default { tasks: { test: { dependsOn: ['//#build'], exec: { command: 'cat ../../out/gen.txt' } } } }\n`,
    )
    const refused = await run({ cwd: fixture.root, tasks: ['a#test'], log: silentLogger(fixture) })
      .then(() => '')
      .catch((e: Error) => e.message)
    expect(refused).toContain(
      "depends on //#build, Turbo's root package, but the workspace root is no project here",
    )
    await writeFile(path.join(fixture.root, 'vx.config.mjs'), ROOT_CONFIG)
    const r = await run({ cwd: fixture.root, tasks: ['a#test'], log: silentLogger(fixture) })
    expect(r.ok).toBe(true)
    expect(r.outcomes.map((o) => o.node.id).sort()).toEqual(['a#test', 'fixture-root#build'])
    // The same spelling in `cache.inputs.tasks`, a negated one included.
    await writeFile(
      path.join(fixture.root, 'packages', 'a', 'vx.config.mjs'),
      `export default { tasks: { test: { dependsOn: ['//#build'], exec: { command: 'true' }, cache: { inputs: { files: [], tasks: ['//#build', '!//#lint'] }, outputs: { files: [] } } } } }\n`,
    )
    const a = (await loadResolvedProjects(fixture.root)).get('a')!
    expect(a.config.tasks!['test']!.cache!.inputs!.tasks).toEqual([
      'fixture-root#build',
      '!fixture-root#lint',
    ])
  })

  // `turbo run //#build` runs the root's task from any package; vx read
  // `//` as a project name and said no project declares it.
  it("runs //#task as the root project's task, from the root or a member", async () => {
    await writeFile(path.join(fixture.root, 'vx.config.mjs'), ROOT_CONFIG)
    for (const cwd of [fixture.root, path.join(fixture.root, 'packages', 'a')]) {
      const r = await run({ cwd, tasks: ['//#build'], log: silentLogger(fixture) })
      expect([cwd, r.ok, r.outcomes.map((o) => o.node.id)]).toEqual([
        cwd,
        true,
        ['fixture-root#build'],
      ])
    }
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
