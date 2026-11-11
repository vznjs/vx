// `vx lock` resolves `{options.outputPath}` once, and a run follows the
// lock: `vx run b#build -- --outputPath=dist/other` cleaned dist/libs/b,
// wrote dist/other, saved an empty artifact, and the next identical run
// was a hit that restored nothing. Nx resolves the outputs from the
// task's overrides, which vx cannot: a forwarded arg naming an option the
// cached outputs read is refused before the command runs.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it } from 'bun:test'
import type { PackageMeta } from '../src/packages.js'
import { mapNxWorkspace, type NxGraph } from '../src/nx/nx-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-nx-fwd-out-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function commandOf(target: Record<string, unknown>): Promise<string> {
  const dir = path.join(root, 'libs', 'b')
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'package.json'), '{"name":"b"}')
  const meta: PackageMeta = {
    name: 'b',
    dir,
    packageJson: { name: 'b' } as never,
    configPath: null,
  }
  const graph = {
    nodes: { b: { data: { root: 'libs/b', targets: { build: target } } } },
    dependencies: {},
  }
  const m = await mapNxWorkspace(root, [meta], graph as NxGraph, {
    cacheable: new Set<string>(),
  })
  const build = m.projects[0]!.tasks.find((t) => t.name === 'build')!
  return (build.task!['exec'] as { command: string }).command
}

// The line as vx runs it: forwarded args appended, from the project dir.
function run(command: string, args: string) {
  const r = Bun.spawnSync({
    cmd: ['sh', '-c', `${command} ${args}`],
    cwd: path.join(root, 'libs', 'b'),
    env: { ...process.env, PATH: '/usr/bin:/bin' },
  })
  return { code: r.exitCode, stderr: r.stderr.toString() }
}

const write = {
  executor: 'nx:run-commands',
  cache: true,
  outputs: ['{options.outputPath}'],
  options: {
    command: 'mkdir -p {args.outputPath} && echo x > {args.outputPath}/o.txt',
    outputPath: 'dist/libs/b',
  },
}

it('a forwarded arg naming an option the outputs read is refused, others run', async () => {
  const command = await commandOf(write)
  for (const args of ['--outputPath=dist/other', '--outputPath dist/other', '--no-outputPath']) {
    const r = run(command, args)
    expect(r.code).toBe(2)
    expect(r.stderr).toContain('--outputPath')
    expect(r.stderr).toContain('configuration')
    expect(await Bun.file(path.join(root, 'dist/other/o.txt')).exists()).toBe(false)
  }
  expect(run(command, '--mode=x').code).toBe(0)
  expect(await Bun.file(path.join(root, 'dist/libs/b/o.txt')).exists()).toBe(true)
})

it('a single appended run-commands line is guarded too', async () => {
  const command = await commandOf({
    ...write,
    options: { command: 'echo', outputPath: 'dist/libs/b' },
  })
  expect(run(command, '--outputPath=dist/other').code).toBe(2)
  expect(run(command, '--x=1').code).toBe(0)
})

it('an executor line hands nx-exec the options its outputs read', async () => {
  const command = await commandOf({
    executor: '@nx/js:tsc',
    cache: true,
    outputs: ['{options.outputPath}', '{options.reports.dir}'],
    options: { outputPath: 'dist/libs/b', reports: { dir: 'r' } },
  })
  expect(command).toContain('--outputs-option outputPath --outputs-option reports')
})

it('an uncached target forwards the option as before', async () => {
  const command = await commandOf({ ...write, cache: false })
  expect(run(command, '--outputPath=dist/other').code).toBe(0)
  expect(await Bun.file(path.join(root, 'dist/other/o.txt')).exists()).toBe(true)
})
