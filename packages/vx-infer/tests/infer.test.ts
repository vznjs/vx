// Inferred tasks through `planRun` over config-less packages: each plugin
// gives a package the tasks its tool implies, the package's own
// declaration wins, and a package without the tool gets nothing.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { planRun, run, type Logger } from '@vzn/vx'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
let root: string

function silent(): Logger {
  return {
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
    status() {},
  } as never
}

async function pkg(
  name: string,
  manifest: Record<string, unknown>,
  files: Record<string, string> = {},
) {
  const dir = path.join(root, 'packages', name)
  await mkdir(path.join(dir, 'src'), { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, version: '1.0.0', ...manifest }),
  )
  await writeFile(path.join(dir, 'src', 'index.ts'), `// ${name}\n`)
  for (const [f, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, f)), { recursive: true })
    await writeFile(path.join(dir, f), content)
  }
  return dir
}

async function workspace(...plugins: string[]): Promise<void> {
  await writeFile(
    path.join(root, 'vx.workspace.mjs'),
    localWorkspaceSource(
      plugins,
      `import { scripts, vite, vitest, next, tsc } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
    ),
  )
}

/** Every task of every project, keyed `pkg#task`, as the plan sees it. */
async function tasks(
  ...names: string[]
): Promise<Map<string, { command: string | undefined; deps: readonly string[]; cache: unknown }>> {
  const plan = await planRun({ cwd: root, tasks: names, log: silent() })
  const out = new Map<
    string,
    { command: string | undefined; deps: readonly string[]; cache: unknown }
  >()
  for (const t of plan.tasks) {
    out.set(t.node.id, {
      command: t.node.config.exec?.command,
      deps: t.deps,
      cache: t.node.config.cache,
    })
  }
  return out
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-infer-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws', private: true }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(path.join(root, '.gitignore'), 'dist\n.next\n')
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('scripts()', () => {
  it('every script is an uncached task; build waits on ^build; dev is persistent; lifecycle scripts are skipped', async () => {
    await pkg('lib', { scripts: { build: 'echo lib', prebuild: 'echo pre', prepare: 'echo prep' } })
    await pkg('app', {
      scripts: { build: 'echo app', dev: 'echo dev', test: 'echo test' },
      dependencies: { lib: 'workspace:*' },
    })
    await workspace('scripts()')
    const t = await tasks('build', 'test', 'dev')
    expect([...t.keys()].sort()).toEqual(['app#build', 'app#dev', 'app#test', 'lib#build'])
    expect(t.get('app#build')!.deps).toEqual(['lib#build'])
    expect(t.get('app#build')!.cache).toBeUndefined()
    const plan = await planRun({ cwd: root, tasks: ['dev'], log: silent() })
    expect(
      plan.tasks.find((x) => x.node.id === 'app#dev')!.node.config.exec?.persistent,
    ).toBeDefined()
    // Uncached means it runs every time.
    const first = await run({ cwd: root, tasks: ['test'], log: silent(), handleSignals: false })
    const second = await run({ cwd: root, tasks: ['test'], log: silent(), handleSignals: false })
    expect(first.outcomes[0]!.status).toBe('success')
    expect(second.outcomes[0]!.status).toBe('success')
  })

  it("the package's own declaration wins over the inferred one", async () => {
    const dir = await pkg('app', { scripts: { test: 'echo script' } })
    await writeFile(
      path.join(dir, 'vx.config.mjs'),
      "export default { tasks: { test: { exec: { command: 'echo mine' }, cache: { inputs: { files: ['src/**'] }, outputs: { files: [] } } } } }\n",
    )
    await workspace('scripts()')
    const t = await tasks('test')
    expect(t.get('app#test')!.command).toBe('echo mine')
    expect(t.get('app#test')!.cache).toBeDefined()
  })

  it('exclude skips a script', async () => {
    await pkg('app', { scripts: { build: 'echo b', clean: 'rm -rf dist' } })
    await workspace("scripts({ exclude: ['clean'] })")
    const plan = await planRun({ cwd: root, tasks: ['clean'], log: silent() })
    expect(plan.tasks).toHaveLength(0)
  })
})

describe('vite() / vitest()', () => {
  it('a vite.config gives build, dev and preview with the config among the inputs', async () => {
    await pkg(
      'web',
      { devDependencies: { vite: '^6' } },
      { 'vite.config.ts': 'export default {}\n', 'index.html': '<html/>' },
    )
    await pkg('plain', {})
    await workspace('vite()')
    const t = await tasks('build')
    expect([...t.keys()]).toEqual(['web#build'])
    expect(t.get('web#build')!.command).toBe('vite build')
    const cache = t.get('web#build')!.cache as {
      inputs: { files: string[] }
      outputs: { files: string[] }
    }
    expect(cache.inputs.files).toContain('vite.config.ts')
    expect(cache.outputs.files).toEqual(['dist/**'])
    const preview = await planRun({ cwd: root, tasks: ['preview'], log: silent() })
    expect(preview.tasks.map((x) => x.node.id).sort()).toEqual(['web#build', 'web#preview'])
  })

  it('vitest infers test from its own config, or from vite.config when vitest is a dependency', async () => {
    await pkg('a', {}, { 'vitest.config.mts': 'export default {}\n' })
    await pkg(
      'b',
      { devDependencies: { vitest: '^3' } },
      { 'vite.config.ts': 'export default {}\n' },
    )
    await pkg('c', {}, { 'vite.config.ts': 'export default {}\n' })
    await workspace('vitest()')
    const t = await tasks('test')
    expect([...t.keys()].sort()).toEqual(['a#test', 'b#test'])
    expect((t.get('b#test')!.cache as { inputs: { files: string[] } }).inputs.files).toContain(
      'vite.config.ts',
    )
  })
})

describe('next() / tsc()', () => {
  it('a next.config gives build, dev and start; .next/cache is never an output', async () => {
    await pkg('site', {}, { 'next.config.mjs': 'export default {}\n' })
    await workspace('next()')
    const t = await tasks('build', 'start')
    expect([...t.keys()].sort()).toEqual(['site#build', 'site#start'])
    expect(t.get('site#start')!.deps).toEqual(['site#build'])
    const outputs = (t.get('site#build')!.cache as { outputs: { files: string[] } }).outputs.files
    expect(outputs).toContain('.next/server/**')
    expect(outputs.some((g) => g.startsWith('.next/cache'))).toBe(false)
  })

  it('tsc infers typecheck only with a tsconfig AND typescript in the manifest', async () => {
    await pkg('typed', { devDependencies: { typescript: '^5' } }, { 'tsconfig.json': '{}' })
    await pkg('untyped', {}, { 'tsconfig.json': '{}' })
    await workspace("tsc({ task: 'check' })")
    const t = await tasks('check')
    expect([...t.keys()]).toEqual(['typed#check'])
    expect(t.get('typed#check')!.command).toBe('tsc --noEmit -p tsconfig.json')
  })

  it('the plugins compose: scripts fills what the tool plugins did not', async () => {
    await pkg(
      'web',
      { scripts: { build: 'vite build', lint: 'eslint .' } },
      { 'vite.config.ts': 'export default {}\n' },
    )
    await workspace('vite()', 'scripts()')
    const t = await tasks('build', 'lint')
    // vite() came first and owns build with its cache block; scripts() adds lint.
    expect(t.get('web#build')!.cache).toBeDefined()
    expect(t.get('web#lint')!.command).toBe('eslint .')
    expect(t.get('web#lint')!.cache).toBeUndefined()
  })
})
