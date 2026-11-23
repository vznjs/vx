// `vx lock --check` with one config that no longer loads: it named every
// locked project as having "no vx.config now", the healthy ones too, since
// the broken audit evaluated none. A graph rule's refusal evaluated them
// all, so it hides no other problem.
import { mkdir, readdir, writeFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterAll, beforeAll, expect, it } from 'bun:test'
import { localWorkspaceSource } from './helpers/local-workspace.js'
import { edgesSource } from './helpers/plugin.js'
import { addProject, makeWorkspace } from './helpers/workspace.js'
import { BIN } from './helpers/vx.js'

const CONFIG = `export default { tasks: { build: { exec: { command: 'true' } } } }\n`

let root: string
beforeAll(async () => {
  root = await makeWorkspace({ prefix: 'vx-lock-check-broken-' })
  await addProject(root, 'a', CONFIG)
  await addProject(root, 'b', CONFIG)
  expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: root }).exitCode).toBe(0)
})
afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

it('a config that no longer loads is the one problem, not every locked project', async () => {
  await writeFile(path.join(root, 'packages', 'a', 'vx.config.mjs'), 'export default {\n')
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock', '--check', '--format', 'json'],
    cwd: root,
  })
  const { problems } = JSON.parse(r.stdout.toString()) as {
    problems: { code: string; message: string }[]
  }
  expect(r.exitCode).toBe(1)
  expect(problems).toHaveLength(1)
  expect(problems[0]!.code).toBe('VX_E_CONFIG')
  expect(problems[0]!.message).toContain('packages/a/vx.config.mjs')
})

const T = `{ exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] }, cache: true }`

it('a graph-rule refusal still names a gone project and a stray review copy', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-check-rule-' })
  const a = await addProject(ws, 'a', CONFIG)
  await addProject(ws, 'c', CONFIG)
  expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws }).exitCode).toBe(0)
  await rm(path.join(ws, 'packages', 'c'), { recursive: true, force: true })
  await mkdir(path.join(ws, 'packages', 'e'))
  await writeFile(path.join(ws, 'packages', 'e', 'vx.lock.json'), '{}\n')
  await writeFile(path.join(a, 'vx.config.mjs'), `export default { tasks: { x: ${T}, y: ${T} } }\n`)
  const r = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock', '--check'], cwd: ws })
  const err = r.stderr.toString()
  await rm(ws, { recursive: true, force: true })
  expect(r.exitCode).toBe(1)
  expect(err).toContain('both declare the output')
  expect(err).toContain('the lock holds packages/c')
  expect(err).toContain('packages/e/vx.lock.json has no vx.config beside it')
})

it('a lock that is not valid JSON is a drift the audit names, in its own shape', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-check-corrupt-' })
  await addProject(ws, 'a', CONFIG)
  await writeFile(path.join(ws, '.vx', 'projects.lock'), '{bad')
  const json = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock', '--check', '--format', 'json'],
    cwd: ws,
  })
  const pretty = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock', '--check'], cwd: ws })
  await rm(ws, { recursive: true, force: true })
  expect(json.exitCode).toBe(1)
  expect(JSON.parse(json.stdout.toString())).toEqual({
    upToDate: false,
    audited: 1,
    notAudited: 0,
    problems: [
      {
        code: 'VX_E_LOCK',
        message: '.vx/projects.lock is not valid JSON — re-run `vx lock` or delete it',
      },
    ],
  })
  expect(pretty.exitCode).toBe(1)
  expect(pretty.stderr.toString()).toContain(
    '✗ vx lock --check  .vx/projects.lock is not valid JSON',
  )
})

// A directory there was a stack trace from `vx lock`, and `--check` read
// it as no lock and sent the user back to that `vx lock`.
it('a directory where the lock goes is one line from lock and --check', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-dir-' })
  await addProject(ws, 'a', CONFIG)
  await mkdir(path.join(ws, '.vx', 'projects.lock'), { recursive: true })
  const lock = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws })
  const check = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock', '--check'], cwd: ws })
  await rm(ws, { recursive: true, force: true })
  expect([lock.exitCode, lock.stderr.toString()]).toEqual([
    1,
    '✗ vx lock  cannot write .vx/projects.lock: a directory stands there; remove it and run again\n',
  ])
  expect([check.exitCode, check.stderr.toString()]).toEqual([
    1,
    '✗ vx lock --check  .vx/projects.lock is a directory — remove it and run `vx lock`\n',
  ])
})

// The config lock was renamed into place before the dependencies lock was
// tried: `vx lock` said it wrote nothing while the config lock held the edit.
it('a directory where the dependencies lock goes leaves the config lock as it was', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-deps-dir-' })
  const a = await addProject(ws, 'a', CONFIG)
  expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws }).exitCode).toBe(0)
  const lockFile = path.join(ws, '.vx', 'projects.lock')
  const before = await Bun.file(lockFile).text()
  await writeFile(path.join(a, 'vx.config.mjs'), CONFIG.replace("'true'", "'echo 2'"))
  const deps = path.join(ws, '.vx', 'dependencies.lock')
  await rm(deps)
  await mkdir(deps)
  const lock = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws })
  const after = await Bun.file(lockFile).text()
  const left = (await readdir(path.join(ws, '.vx'))).filter((f) => f.includes('.tmp-'))
  await rm(ws, { recursive: true, force: true })
  expect([lock.exitCode, lock.stderr.toString()]).toEqual([
    1,
    '✗ vx lock  cannot write .vx/dependencies.lock: a directory stands there; remove it and run again\n',
  ])
  expect(after).toBe(before)
  expect(left).toEqual([])
})

it('every config that does not load is named, root-relative, with its frame', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-check-two-broken-' })
  const BAD = `export default { tasks: { b: { bad: 1 } } }\n`
  const a = await addProject(ws, 'a', CONFIG)
  const b = await addProject(ws, 'b', CONFIG)
  await addProject(ws, 'c', CONFIG)
  expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws }).exitCode).toBe(0)
  for (const dir of [a, b]) await writeFile(path.join(dir, 'vx.config.mjs'), BAD)
  const json = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock', '--check', '--format', 'json'],
    cwd: ws,
  })
  const pretty = Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock', '--check'], cwd: ws })
  await rm(ws, { recursive: true, force: true })
  const { problems } = JSON.parse(json.stdout.toString()) as {
    problems: { code: string; message: string }[]
  }
  expect(problems.filter((p) => p.message.includes('unknown field "bad"'))).toEqual(
    ['a', 'b'].map((p) => ({
      code: 'VX_E_CONFIG',
      message: `packages/${p}/vx.config.mjs: tasks.b has unknown field "bad" (allowed: cache, dependsOn, description, exec, inputs, outputs)`,
    })),
  )
  const err = pretty.stderr.toString()
  expect(pretty.exitCode).toBe(1)
  expect(err).toContain('packages/a/vx.config.mjs:1:')
  expect(err).toContain('packages/b/vx.config.mjs:1:')
  expect(err).toContain('> 1 | export default { tasks: { b: { bad: 1 } } }')
  expect(err).not.toContain(ws)
})

it('every broken dependsOn is named, root-relative', async () => {
  const ws = await makeWorkspace({ prefix: 'vx-lock-check-graph-' })
  const a = await addProject(ws, 'a', CONFIG)
  const b = await addProject(ws, 'b', CONFIG)
  expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws }).exitCode).toBe(0)
  const BAD = `export default { tasks: { build: { exec: { command: 'true' }, dependsOn: ['zz'] } } }\n`
  for (const dir of [a, b]) await writeFile(path.join(dir, 'vx.config.mjs'), BAD)
  const r = Bun.spawnSync({
    cmd: [process.execPath, BIN, 'lock', '--check', '--format', 'json'],
    cwd: ws,
  })
  await rm(ws, { recursive: true, force: true })
  const { problems } = JSON.parse(r.stdout.toString()) as {
    problems: { code: string; message: string }[]
  }
  expect(r.exitCode).toBe(1)
  expect(problems.filter((p) => p.message.includes('no such task'))).toEqual(
    ['a', 'b'].map((p) => ({
      code: 'VX_E_DEPENDS_ON',
      message: `packages/${p}/vx.config.mjs: tasks.build.dependsOn names ${p}#zz but no such task is declared`,
    })),
  )
})

// Seven codes the docs told an agent to branch on reached it only as prose:
// `vx lock` prints no JSON, and the audit's problems were strings.
it('each graph rule reaches the audit under its own code', async () => {
  const out = `outputs: { files: ['dist/**'] }, inputs: { files: ['in/**'] }, cache: true`
  const cases: Record<string, { a?: string; root?: string; rules?: string }> = {
    cycle: {
      a: `{ x: { exec: { command: 'true' }, dependsOn: ['y'] }, y: { exec: { command: 'true' }, dependsOn: ['x'] } }`,
    },
    dependsOn: { a: `{ x: { exec: { command: 'true' }, dependsOn: ['ghost'] } }` },
    outputOverlap: {
      a: `{ p: { exec: { command: 'true' }, ${out} }, q: { exec: { command: 'true' }, ${out} } }`,
    },
    inputIsOutput: {
      a: `{ s: { exec: { command: 'true' }, inputs: { files: ['src/**'] }, outputs: { files: ['src/**'] }, cache: true } }`,
    },
    nestedInput: {
      root: `{ r: { exec: { command: 'true' }, inputs: { files: ['packages/b/src/**'] }, outputs: { files: [] }, cache: true } }`,
    },
    nestedOutput: {
      root: `{ r: { exec: { command: 'true' }, inputs: { files: ['x/**'] }, outputs: { files: ['packages/b/dist/**'] }, cache: true } }`,
    },
    dependencyRule: { rules: `{ dependencies: [{ from: 'b', deny: ['a'] }] }` },
  }
  const codes = await Promise.all(
    Object.entries(cases).map(async ([name, c]) => {
      const ws = await makeWorkspace({ prefix: `vx-lock-check-code-${name}-` })
      try {
        const a = await addProject(ws, 'a', CONFIG)
        await addProject(ws, 'b', CONFIG)
        if (c.root !== undefined) await writeFile(path.join(ws, 'vx.config.mjs'), CONFIG)
        expect(Bun.spawnSync({ cmd: [process.execPath, BIN, 'lock'], cwd: ws }).exitCode).toBe(0)
        if (c.a !== undefined)
          await writeFile(path.join(a, 'vx.config.mjs'), `export default { tasks: ${c.a} }\n`)
        if (c.root !== undefined)
          await writeFile(path.join(ws, 'vx.config.mjs'), `export default { tasks: ${c.root} }\n`)
        if (c.rules !== undefined)
          await writeFile(
            path.join(ws, '.vx', 'workspace.mjs'),
            localWorkspaceSource([edgesSource({ b: ['a'] })], '', c.rules),
          )
        const r = Bun.spawnSync({
          cmd: [process.execPath, BIN, 'lock', '--check', '--format', 'json'],
          cwd: ws,
        })
        expect(r.exitCode).toBe(1)
        const { problems } = JSON.parse(r.stdout.toString()) as {
          problems: { code: string; message: string }[]
        }
        // The config edit is drift too, VX_E_LOCK beside the rule's own.
        return [name, problems.map((p) => p.code).filter((code) => code !== 'VX_E_LOCK')]
      } finally {
        await rm(ws, { recursive: true, force: true })
      }
    }),
  )
  expect(Object.fromEntries(codes)).toEqual({
    cycle: ['VX_E_CYCLE'],
    dependsOn: ['VX_E_DEPENDS_ON'],
    outputOverlap: ['VX_E_OUTPUT_OVERLAP'],
    inputIsOutput: ['VX_E_INPUT_IS_OUTPUT'],
    nestedInput: ['VX_E_NESTED_INPUT'],
    nestedOutput: ['VX_E_NESTED_OUTPUT'],
    dependencyRule: ['VX_E_DEPENDENCY_RULE'],
  })
  // Seven workspaces, each locked then audited: two vx spawns apiece.
}, 30_000)
