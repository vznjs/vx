// A workspace with no orchestrator: root package.json scripts fan out
// through the package manager. The parser rows are real root scripts
// (vite, vitest, sveltekit, pinia, starlight, react-day-picker, npm/cli,
// 2026-09-28); the plan rows match what `pnpm -r` 10.34 selected and in
// what order, on pinia, starlight and react-day-picker.
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { loadProjectConfig, planRun, run, type Logger } from '@vzn/vx'
import { parseFanOut } from '../src/scripts/scripts-map.js'
import { localWorkspaceSource } from './helpers/local-workspace.js'

const PLUGIN_INDEX = path.resolve(import.meta.dir, '..', 'src', 'index.ts')
const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_PKG = path.resolve(import.meta.dir, '..', '..', 'vx')
const TIMEOUT = 30_000

describe('parseFanOut', () => {
  it('reads the fan-out forms real root scripts use', () => {
    const rows: [string, ReturnType<typeof parseFanOut>][] = [
      [
        "pnpm -r --filter='./packages/*' run build",
        { tool: 'pnpm', script: 'build', include: ['./packages/*'], exclude: [], sorted: true },
      ],
      [
        'NODE_OPTIONS="--max-old-space-size=8192" pnpm -r --parallel --filter=\'./packages/**\' run dev',
        { tool: 'pnpm', script: 'dev', include: ['./packages/**'], exclude: [], sorted: false },
      ],
      [
        "CI=true pnpm -r --reporter-hide-prefix --stream --sequential --filter '@vitest/test-*' --filter !test-browser run test",
        {
          tool: 'pnpm',
          script: 'test',
          include: ['@vitest/test-*'],
          exclude: ['test-browser'],
          sorted: true,
        },
      ],
      [
        'pnpm -r --filter="./packages/*" --filter="!./packages/kit" --workspace-concurrency=1 test:unit',
        {
          tool: 'pnpm',
          script: 'test:unit',
          include: ['./packages/*'],
          exclude: ['./packages/kit'],
          sorted: true,
        },
      ],
      [
        'pnpm run -r size',
        { tool: 'pnpm', script: 'size', include: [], exclude: [], sorted: true },
      ],
      [
        "pnpm --no-bail --workspace-concurrency 1 --filter '@example/*' build",
        { tool: 'pnpm', script: 'build', include: ['@example/*'], exclude: [], sorted: true },
      ],
      [
        'pnpm -F @sveltejs/kit prepublishOnly',
        {
          tool: 'pnpm',
          script: 'prepublishOnly',
          include: ['@sveltejs/kit'],
          exclude: [],
          sorted: true,
        },
      ],
      [
        'npm run lint --workspaces --include-workspace-root --if-present',
        { tool: 'npm', script: 'lint', include: [], exclude: [], sorted: true },
      ],
      [
        'yarn workspaces run test',
        { tool: 'yarn', script: 'test', include: [], exclude: [], sorted: true },
      ],
      [
        'yarn workspaces foreach -Ap run dev',
        { tool: 'yarn', script: 'dev', include: [], exclude: [], sorted: false },
      ],
      [
        'yarn workspaces foreach -Apt run build',
        { tool: 'yarn', script: 'build', include: [], exclude: [], sorted: true },
      ],
      [
        "bun --filter '*' build",
        { tool: 'bun', script: 'build', include: [], exclude: [], sorted: true },
      ],
      [
        'lerna run build --scope @x/* --no-sort',
        { tool: 'lerna', script: 'build', include: ['@x/*'], exclude: [], sorted: false },
      ],
      ['pnpm -r exec attw --pack .', null],
      ['pnpm run test:types', null],
      ['npm run build', null],
      ['tsc -p scripts', null],
    ]
    for (const [cmd, want] of rows) expect([cmd, parseFanOut(cmd)]).toEqual([cmd, want])
  })
})

let root: string

function silent(): Logger & { lines: string[] } {
  const lines: string[] = []
  const log = {
    lines,
    status: (line: string) => lines.push(line),
    runStart() {},
    taskStart() {},
    taskStdout() {},
    taskStderr() {},
    taskComplete() {},
    runStatus() {},
    runEnd() {},
  }
  return log as unknown as Logger & { lines: string[] }
}

async function write(rel: string, text: string): Promise<void> {
  const file = path.join(root, rel)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, text)
}

async function pkg(
  dir: string,
  name: string,
  scripts: Record<string, string>,
  deps: string[] = [],
) {
  await write(
    `${dir}/package.json`,
    JSON.stringify({
      name,
      scripts,
      dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
    }),
  )
}

beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-scripts-'))
  await write('pnpm-workspace.yaml', 'packages:\n  - "packages/*"\n  - "examples/*"\n')
  await write(
    'package.json',
    JSON.stringify({
      name: 'ws',
      private: true,
      scripts: {
        build: "pnpm -r --filter='./packages/*' run build",
        lint: "pnpm -r --filter='!@x/skip' lint",
        dev: 'pnpm -r --parallel run dev',
        ci: "pnpm -r --filter './packages/*' build && pnpm -r test",
        typecheck: 'tsc -p scripts && pnpm -r typecheck',
        'build:examples': "pnpm --filter '@example/*' build",
        release: 'changeset publish',
      },
    }),
  )
  await pkg('packages/lib', '@x/lib', {
    build: 'echo lib >> ../../order.txt',
    test: 'echo test-lib',
    dev: 'sleep 30',
    lint: 'echo lint-lib',
  })
  await pkg(
    'packages/app',
    '@x/app',
    {
      build: 'echo app >> ../../order.txt',
      test: 'echo test-app',
      typecheck: 'echo tc',
    },
    ['@x/lib'],
  )
  await pkg('examples/demo', '@example/demo', { build: 'echo demo >> ../../order.txt' }, ['@x/app'])
  await pkg('packages/skip', '@x/skip', { lint: 'echo lint-skip' })
  await write('.gitignore', 'order.txt\nnode_modules\n')
  await write(
    'vx.workspace.mjs',
    localWorkspaceSource(
      ['workspaceScripts()'],
      `import { workspaceScripts } from ${JSON.stringify(PLUGIN_INDEX)}\n`,
    ),
  )
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  Bun.spawnSync({ cmd: ['git', 'add', '-A'], cwd: root })
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('workspaceScripts()', () => {
  it(
    'maps each fan-out to the packages it selects, with ^ edges where the tool sorts',
    async () => {
      const log = silent()
      const plan = await planRun({
        cwd: root,
        tasks: ['build', 'test', 'dev', 'typecheck', 'lint'],
        log,
      })
      const tasks = new Map(plan.tasks.map((t) => [t.node.id, t.node]))
      expect([...tasks.keys()].sort()).toEqual([
        '@example/demo#build',
        '@x/app#build',
        '@x/app#test',
        '@x/app#typecheck',
        '@x/lib#build',
        '@x/lib#dev',
        '@x/lib#lint',
        '@x/lib#test',
      ])
      expect(tasks.get('@x/app#build')!.deps).toEqual(['@x/lib#build'])
      expect(tasks.get('@example/demo#build')!.deps).toEqual(['@x/app#build'])
      // `ci` runs every build before any test: the package's own build first.
      expect(tasks.get('@x/app#test')!.deps.sort()).toEqual(['@x/app#build', '@x/lib#test'])
      // `--parallel` orders nothing, and a dev server is persistent.
      expect(tasks.get('@x/lib#dev')!.deps).toEqual([])
      expect(tasks.get('@x/lib#dev')!.config.exec?.persistent).toBeDefined()
      for (const t of tasks.values()) expect(t.config.cache).toBeUndefined()
      expect(log.lines).toContain(
        '[@vzn/vx-migrate] note: root script commands that run at the workspace root are not mapped — vx has no workspace-root tasks: typecheck (`tsc -p scripts`)',
      )
      expect(log.lines).toContain(
        '[@vzn/vx-migrate] note: `ci` is `vx run build test`, `build:examples` is `vx run build`',
      )
    },
    TIMEOUT,
  )

  it(
    'runs the builds in dependency order, as pnpm -r does',
    async () => {
      const r = await run({
        cwd: root,
        tasks: ['build'],
        log: silent(),
        handleSignals: false,
        concurrency: 4,
      })
      expect(r.ok).toBe(true)
      expect(await Bun.file(path.join(root, 'order.txt')).text()).toBe('lib\napp\ndemo\n')
    },
    TIMEOUT,
  )
})

describe('vx-migrate --from scripts', () => {
  it(
    'is the source when nothing else is, and writes the configs workspaceScripts() runs',
    async () => {
      const plan = await planRun({ cwd: root, tasks: ['@x/app#test'], log: silent() })
      const live = plan.tasks.find((t) => t.node.id === '@x/app#test')!.node.config
      await rm(path.join(root, 'vx.workspace.mjs'))
      await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
      await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
      const proc = Bun.spawn([process.execPath, BIN], {
        cwd: root,
        env: { ...process.env },
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const [out, err, code] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ])
      expect(err).toBe('')
      expect(code).toBe(0)
      expect(out).toContain('package.json scripts → vx.config.ts')
      const config = await loadProjectConfig(path.join(root, 'packages/app/vx.config.ts'))
      expect(config.tasks!['test']).toEqual(live as never)
    },
    TIMEOUT,
  )
})
