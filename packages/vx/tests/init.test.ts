// `vx init`: package.json scripts → one vx.config.ts per package, the
// workspace file, and the pointer to @vzn/vx-migrate when a Turbo or Nx
// config sits beside the scripts unread. The Turbo and Nx migrations
// themselves are tested in packages/vx-migrate.

import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseInitArgs } from '../src/cli/index.js'
import { delegatedScript } from '../src/workspace/index.js'
import { loadProjectConfig } from '../src/workspace/index.js'

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const TIMEOUT = 20_000

interface VxResult {
  code: number
  out: string
  err: string
}

async function vx(root: string, args: string[]): Promise<VxResult> {
  const proc = Bun.spawn([process.execPath, BIN, ...args], {
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
  return { code, out, err }
}

const CORE_PKG = path.resolve(import.meta.dir, '..')

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  // The scaffolded `vx.workspace.ts` imports `@vzn/vx`, and a tmp dir has
  // no node_modules. This used to resolve through a machine-global
  // `bun link`, so the suite passed or failed on invisible state outside
  // the repo — a `bun install` that drops the link turns every fixture
  // here into `Unexpected while resolving package '@vzn/vx'`. Link it
  // per fixture instead: the test now carries what it needs.
  await mkdir(path.join(root, 'node_modules', '@vzn'), { recursive: true })
  await symlink(CORE_PKG, path.join(root, 'node_modules', '@vzn', 'vx'), 'dir')
  return root
}

async function addPackage(
  root: string,
  name: string,
  scripts: Record<string, string>,
  deps?: Record<string, string>,
): Promise<string> {
  const dir = path.join(root, 'packages', name)
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name, scripts, ...(deps ? { dependencies: deps } : {}) }),
  )
  return dir
}

// ─── Source detection ────────────────────────────────────────────────

describe('vx init source detection', () => {
  it(
    'an empty workspace still writes the workspace file; scripts are the source',
    async () => {
      const root = await makeRoot('vx-init-det-')
      try {
        const empty = await vx(root, ['init', '--dry'])
        expect(empty.code).toBe(0)
        expect(empty.out).toContain('no package.json scripts')
        await addPackage(root, 'a', { build: 'tsc' })
        const scripts = await vx(root, ['init', '--dry'])
        expect(scripts.code).toBe(0)
        expect(scripts.out).toContain('package.json scripts → vx.config.ts')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '`vx migrate` points at @vzn/vx-migrate and exits 1',
    async () => {
      // The verb left core with the Turbo and Nx mappers; a remembered
      // command lands on the pointer, never on a silent unknown verb.
      const root = await makeRoot('vx-init-moved-')
      try {
        const r = await vx(root, ['migrate'])
        expect(r.code).toBe(1)
        expect(r.err).toContain('bunx @vzn/vx-migrate')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})

// ─── Parser ───────────────────────────────────────────────────────────

describe('parseInitArgs', () => {
  it('defaults', () => {
    expect(parseInitArgs([])).toEqual({ dry: false, force: false })
  })
  it('--dry and --force', () => {
    expect(parseInitArgs(['--dry', '--force'])).toEqual({ dry: true, force: true })
  })
  it('unknown flag errors', () => {
    expect(parseInitArgs(['--nope']).error).toContain('--nope')
  })
  it('positionals error', () => {
    expect(parseInitArgs(['turbo']).error).toContain('turbo')
  })
})

// ─── Scripts (`vx init`) ───────────────────────────────────────────────

describe('delegatedScript', () => {
  it.each([
    ['npm run x', 'x'],
    ['pnpm x', 'x'],
    ['pnpm run x', 'x'],
    ['yarn run x', 'x'],
    ['yarn x', 'x'],
    ['bun run x', 'x'],
    ['bun x', 'x'],
    ['npm test', 'test'],
    ['npm start', 'start'],
    ['  npm run test:unit  ', 'test:unit'],
    ['npm x', null], // npm needs `run` for anything but test/start
    ['npm run x -- --flag', null],
    ['npm run x --silent', null],
    ['npm run x && npm run y', null],
    ['NODE_ENV=1 npm run x', null],
    ['npm run $SCRIPT', null],
  ])('%s → %p', (command, expected) => {
    expect(delegatedScript(command)).toBe(expected)
  })
})

async function makeScriptsWorkspace(): Promise<string> {
  const root = await makeRoot('vx-migrate-scripts-')
  await addPackage(root, 'app', {
    build: 'tsc -b',
    test: 'vitest run',
    lint: 'eslint .',
    dev: 'vite',
    postinstall: 'echo hooks are not tasks',
  })
  await addPackage(root, 'lib', { build: 'tsc' })
  await addPackage(root, 'silent', {})
  return root
}

describe('vx init — the generated build is not a cached no-op', () => {
  // Until 2026-09-04 `init` gave `build` a cache block with whole-project
  // inputs and EMPTY outputs "to fill in". That is not an uncached task: it
  // hits on unchanged inputs and skips the build with nothing to restore,
  // so on the init walkthrough a deleted `dist` stayed deleted under a
  // green `up-to-date` run. The scaffold now emits no cache block; this
  // pin fails with the old block (verified by stashing the fix).
  it('reports itself as `vx init`, on the terminal and in the generated file', async () => {
    // `init` is `migrate --from scripts` underneath; its report and the
    // file banner used to say `vx migrate`, which reads as the wrong verb
    // to someone who typed `init`.
    const root = await makeScriptsWorkspace()
    try {
      const r = await vx(root, ['init'])
      expect(r.code).toBe(0)
      const text = `${r.out}${r.err}`
      expect(text).toContain('vx init: package.json scripts → vx.config.ts')
      expect(text).not.toContain('vx migrate:')
      const generated = await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).text()
      expect(generated).toContain('// Generated by `vx init` from package.json scripts.')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names a turbo.json it did not read, with both ways to use it', async () => {
    // `init` maps scripts only; on a Turbo repo it used to generate the
    // scripts' TODOs and say nothing about the edges turbo.json declares.
    const root = await makeScriptsWorkspace()
    try {
      await Bun.write(path.join(root, 'turbo.json'), '{ "tasks": { "build": {} } }\n')
      const r = await vx(root, ['init'])
      expect(r.code).toBe(0)
      const text = `${r.out}${r.err}`
      expect(text).toContain('vx init: package.json scripts → vx.config.ts')
      expect(text).toContain('note: turbo.json found and not read — `bunx @vzn/vx-migrate` maps it')
      expect(text).toContain('`plugins: [turbo()]` from @vzn/vx-migrate')
      // The control — the package reads it, so the note would be false
      // there — lives in packages/vx-migrate/tests, the only place that
      // may spawn its bin.
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a run in a workspace with no vx config at all names `vx init`', async () => {
    const root = await makeRoot('vx-init-first-run-')
    await addPackage(root, 'w', { build: 'echo hi' })
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    try {
      const r = await vx(root, ['run', 'build', '--all'])
      expect(r.code).not.toBe(0)
      expect(`${r.out}${r.err}`).toContain('No package declares a vx.config — run `vx init`')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a deleted dist is rebuilt on the next run', async () => {
    const root = await makeRoot('vx-init-rebuild-')
    await addPackage(root, 'w', { build: 'mkdir -p dist && cp src/a.txt dist/a.txt' })
    await mkdir(path.join(root, 'packages', 'w', 'src'), { recursive: true })
    await writeFile(path.join(root, 'packages', 'w', 'src', 'a.txt'), 'a\n')
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    try {
      expect((await vx(root, ['init'])).code).toBe(0)
      const dist = path.join(root, 'packages', 'w', 'dist', 'a.txt')
      for (let i = 0; i < 2; i++) {
        const r = await vx(root, ['run', 'build', '--all'])
        expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      }
      expect(await Bun.file(dist).exists()).toBe(true)
      await rm(path.join(root, 'packages', 'w', 'dist'), { recursive: true, force: true })
      const r = await vx(root, ['run', 'build', '--all'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(await Bun.file(dist).exists()).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx init on a workspace with no scripts', () => {
  it('writes the workspace file, prints an example config and the next command', async () => {
    const root = await makeRoot('vx-init-empty-')
    await addPackage(root, 'app', {})
    try {
      const r = await vx(root, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(await Bun.file(path.join(root, 'vx.workspace.ts')).exists()).toBe(true)
      expect(await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).exists()).toBe(
        false,
      )
      expect(r.out).toContain('no package.json scripts to turn into tasks')
      expect(r.out).toContain('satisfies ProjectConfig')
      expect(r.out).toContain('next: vx run build --all')
      // Idempotent: a second init neither rewrites nor refuses.
      const again = await vx(root, ['init'])
      expect(again.code).toBe(0)
      expect(again.out).toContain('vx.workspace.ts already exists')
      // --dry on an empty workspace writes nothing and says so.
      await rm(path.join(root, 'vx.workspace.ts'))
      const dry = await vx(root, ['init', '--dry'])
      expect(dry.code).toBe(0)
      expect(dry.out).toContain('would write vx.workspace.ts (dry run, nothing written)')
      expect(await Bun.file(path.join(root, 'vx.workspace.ts')).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx init (package.json scripts)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeScriptsWorkspace()
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'writes a config per package with scripts, plus the workspace file, and loads clean',
    async () => {
      const r = await vx(root, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(r.out).toContain('package.json scripts → vx.config.ts')
      expect(r.out).toContain('vx.workspace.ts')
      // A package with no scripts gets no config.
      expect(await Bun.file(path.join(root, 'packages', 'silent', 'vx.config.ts')).exists()).toBe(
        false,
      )
      const app = await loadProjectConfig(path.join(root, 'packages', 'app', 'vx.config.ts'))
      const tasks = app.tasks!
      expect(Object.keys(tasks).sort()).toEqual(['build', 'dev', 'lint', 'test'])
      expect(tasks['build']!.exec?.command).toBe('tsc -b')
      expect(tasks['build']!.dependsOn).toEqual(['^build'])
      // Caching needs declared inputs AND outputs; the scaffold shows the
      // block in a TODO instead of guessing — an EMPTY-outputs block is a
      // cached no-op, pinned below.
      expect(tasks['build']!.cache).toBeUndefined()
      expect(tasks['test']!.dependsOn).toEqual(['build'])
      expect(tasks['test']!.cache).toBeUndefined()
      // A linter reads sources; an edge to build would only serialise them.
      expect(tasks['lint']!.dependsOn).toBeUndefined()
      expect(tasks['dev']!.exec?.persistent).toEqual({})
      const text = await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).text()
      // Typed for the editor through a type-only import Bun erases, so the
      // file loaded above without `@vzn/vx` installed.
      expect(text).toContain("import type { ProjectConfig } from '@vzn/vx'")
      expect(text).toContain('} satisfies ProjectConfig')
      expect(r.out).toContain('next: vx run build --all')
      expect(text).toContain('TODO(vx-migrate): cache: add `cache: {')
      expect(text).toContain('TODO(vx-migrate): persistent')
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      const run = await vx(root, ['run', 'build', '--all', '--dry'])
      expect(run.code).toBe(0)
      expect(run.out).toContain('app#build')
      expect(run.out).toContain('lib#build')
    },
    TIMEOUT,
  )

  it('refuses to overwrite without --force, like migrate', async () => {
    const again = await vx(root, ['init'])
    expect(again.code).toBe(1)
    expect(again.err).toContain('refusing to overwrite')
    const forced = await vx(root, ['init', '--force'])
    expect(forced.code).toBe(0)
  })

  it('is also the fallback source of vx migrate when no turbo.json or nx exists', async () => {
    const r = await vx(root, ['init', '--dry'])
    expect(r.code).toBe(0)
    expect(r.out).toContain('package.json scripts → vx.config.ts')
  })

  // npm runs `pre<x>` / `post<x>` around `x` without being asked, so a
  // standalone `prebuild` task would be one `vx run build` never runs — and
  // that hook is usually `rimraf dist`. CONFIRMED before the fold (2026-09-03):
  // the emitted `build` ran `echo build` alone.
  it('folds pre/post hooks into the script they wrap, in npm order', async () => {
    const hooked = await makeRoot('vx-migrate-hooks-')
    try {
      await addPackage(hooked, 'app', {
        prebuild: 'rimraf dist',
        build: 'tsc -b',
        postbuild: 'cp -r assets dist/',
        pretest: 'echo no test script here',
        pack: 'echo pack',
        prepack: 'echo lifecycle, not a hook of a task',
      })
      const r = await vx(hooked, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      const cfg = await loadProjectConfig(path.join(hooked, 'packages', 'app', 'vx.config.ts'))
      const tasks = cfg.tasks!
      // `pretest` wraps nothing (no `test`), so it stays a task of its own;
      // `prepack` is an npm lifecycle hook and is never a task.
      expect(Object.keys(tasks).sort()).toEqual(['build', 'pack', 'pretest'])
      expect(tasks['build']!.exec?.command).toBe('rimraf dist && tsc -b && cp -r assets dist/')
      expect(tasks['pack']!.exec?.command).toBe('echo pack')
      const text = await Bun.file(path.join(hooked, 'packages', 'app', 'vx.config.ts')).text()
      expect(text).toContain(
        'TODO(vx-migrate): npm ran `prebuild` and `postbuild` around this script',
      )
    } finally {
      await rm(hooked, { recursive: true, force: true })
    }
  })

  // `test: npm run test:unit` used to become a task whose command spawns the
  // package manager, which then runs a script the graph cannot see or cache.
  // A group over the target says the same thing in vx's own terms.
  it(
    'a script that only delegates to another becomes a group over it; chains stay verbatim',
    async () => {
      const del = await makeRoot('vx-migrate-delegate-')
      try {
        await addPackage(del, 'app', {
          build: 'tsc -b',
          'test:unit': 'vitest run',
          test: 'npm run test:unit',
          ci: 'yarn build',
          check: 'pnpm lint && pnpm typecheck',
          lint: 'eslint .',
          typecheck: 'tsc --noEmit',
          release: 'npm run build -- --prod',
          prerelease: 'echo pre-release',
          publishit: 'npm run release',
        })
        const r = await vx(del, ['init'])
        expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
        const tasks = (await loadProjectConfig(path.join(del, 'packages', 'app', 'vx.config.ts')))
          .tasks!
        // Group: no exec, the target plus `build` (test waits for build).
        expect(tasks['test']!.exec).toBeUndefined()
        expect(tasks['test']!.dependsOn).toEqual(['test:unit', 'build'])
        expect(tasks['ci']!.exec).toBeUndefined()
        expect(tasks['ci']!.dependsOn).toEqual(['build'])
        // CONTROLS — each of these stays a real command:
        expect(tasks['check']!.exec?.command).toBe('pnpm lint && pnpm typecheck') // a chain
        // Arguments make it a real command, and its hook folds in front.
        expect(tasks['release']!.exec?.command).toBe('echo pre-release && npm run build -- --prod')
        // Delegating to a script that is itself hooked is still a plain group.
        expect(tasks['publishit']!.exec).toBeUndefined()
        expect(tasks['publishit']!.dependsOn).toEqual(['release'])
        expect(tasks['test:unit']!.exec?.command).toBe('vitest run')
        // The generated workspace plans the delegation as two tasks.
        Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: del })
        const run = await vx(del, ['run', 'test', '--all', '--dry'])
        expect(run.code).toBe(0)
        expect(run.out).toContain('app#test:unit')
        expect(run.out).toContain('app#build')
      } finally {
        await rm(del, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it('a scripts field that is not an object contributes nothing (indices are not script names)', async () => {
    const odd = await makeRoot('vx-migrate-oddscripts-')
    try {
      const dir = path.join(odd, 'packages', 'weird')
      await mkdir(dir, { recursive: true })
      await writeFile(
        path.join(dir, 'package.json'),
        JSON.stringify({ name: 'weird', scripts: ['tsc'] }),
      )
      await addPackage(odd, 'fine', { build: 'tsc' })
      const r = await vx(odd, ['init', '--dry'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('packages/fine/vx.config.ts')
      expect(r.out).not.toContain('packages/weird/vx.config.ts')
    } finally {
      await rm(odd, { recursive: true, force: true })
    }
  })

  it('a workspace with no scripts anywhere is scaffolded by init; `vx migrate` only points', async () => {
    const empty = await makeRoot('vx-migrate-empty-')
    try {
      await addPackage(empty, 'a', {})
      const m = await vx(empty, ['migrate'])
      expect(m.code).toBe(1)
      expect(m.err).toContain('bunx @vzn/vx-migrate')
      const r = await vx(empty, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(r.out).toContain('no package.json scripts to turn into tasks')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})
