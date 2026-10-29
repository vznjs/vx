// package.json scripts → one vx.config.ts per package, the workspace file
// and the lock: `vx init`'s mapper until core stopped reading package.json
// (2026-10-14), and `--keep` in a Turbo or Nx repo. Moved from core's
// init.test.ts; `vx init` hands such a repo to this bin
// (init-no-manifest.test.ts in core holds the hand-off).

import { existsSync, mkdtempSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { foldScriptHooks, loadProjectConfig, PERSISTENT_TODO, ui, VERSION } from '@vzn/vx'
import { delegatedScript, migrateScripts } from '../src/migrate-scripts.js'
import { adoptionNext } from '../src/migrate.js'

/** A report row's value lines, e.g. every `note`. */
function row(out: string, label: string): string[] {
  const lines = out.split('\n')
  const at = lines.findIndex((l) => l.startsWith(`  ${label.padEnd(8)}  `))
  if (at === -1) return []
  const values = [lines[at]!.slice(12)]
  for (let i = at + 1; lines[i]?.startsWith(' '.repeat(12)) === true; i++)
    values.push(lines[i]!.slice(12))
  return values
}

const BIN = path.resolve(import.meta.dir, '..', 'src', 'bin.ts')
const CORE_BIN = path.join(path.dirname(Bun.resolveSync('@vzn/vx', import.meta.dir)), 'bin.ts')
const TIMEOUT = 20_000

// A package manager that installs nothing, first on PATH: what a migration
// installs is adopt.test.ts's subject, and this suite has no network.
const FAKE_PM = mkdtempSync(path.join(os.tmpdir(), 'vx-scripts-pm-'))
for (const pm of ['npm', 'pnpm', 'yarn']) {
  writeFileSync(path.join(FAKE_PM, pm), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
}
afterAll(() => rm(FAKE_PM, { recursive: true, force: true }))

interface VxResult {
  code: number
  out: string
  err: string
}

/**
 * `init` is vx-migrate's run, as `vx init` hands it over; any other verb is
 * core's, behind `vx lock` as a user runs it.
 */
async function vx(
  root: string,
  args: string[],
  extra: Record<string, string> = {},
): Promise<VxResult> {
  const env = { ...process.env, PATH: `${FAKE_PM}:${process.env['PATH']}`, ...extra }
  if (['run', 'show'].includes(args[0]!)) {
    Bun.spawnSync([process.execPath, CORE_BIN, 'lock'], {
      cwd: root,
      env,
      stdout: 'ignore',
      stderr: 'ignore',
    })
  }
  const argv =
    args[0] === 'init'
      ? [process.execPath, '--no-install', BIN, ...args.slice(1)]
      : [process.execPath, CORE_BIN, ...args]
  const proc = Bun.spawn(argv, { cwd: root, env, stdout: 'pipe', stderr: 'pipe' })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, out, err }
}

const CORE_PKG = path.dirname(path.dirname(Bun.resolveSync('@vzn/vx', import.meta.dir)))

async function makeRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), prefix))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  await writeFile(
    path.join(root, 'package.json'),
    JSON.stringify({ name: 'fixture-root', private: true }),
  )
  // The scaffolded `.vx/workspace.ts` imports `@vzn/vx`, and a tmp dir has
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

describe('vx init names what it wrote', () => {
  it('lists ten files one per line, past that the root files and a count', async () => {
    // TanStack form's init listed 97 lines and pushed `next:` off screen
    // (Growth's first-run funnel F4, 2026-10-13).
    const root = await makeRoot('vx-init-files-')
    try {
      for (let i = 0; i < 12; i++) await addPackage(root, `p${i}`, { build: 'tsc' })
      const lines = (await vx(root, ['init', '--dry'])).out.split('\n')
      const from = lines.findIndex((l) => l.startsWith('  files '))
      expect(lines.slice(from, from + 3)).toEqual([
        '  files     .vx/workspace.ts',
        '            .vx/.gitignore',
        '            and 12 more in package directories',
      ])
      // CONTROL: ten or fewer are each named.
      for (let i = 2; i < 12; i++)
        await rm(path.join(root, 'packages', `p${i}`), { recursive: true })
      const few = (await vx(root, ['init', '--dry'])).out
      expect(row(few, 'files').slice(0, 2)).toEqual([
        'packages/p0/vx.config.ts',
        'packages/p1/vx.config.ts',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx init and .vx/.gitignore', () => {
  it('writes .vx/.gitignore with /cache and leaves the root .gitignore alone', async () => {
    const root = await makeRoot('vx-init-ignore-')
    try {
      await addPackage(root, 'a', { build: 'tsc' })
      await Bun.write(path.join(root, '.gitignore'), 'node_modules\n')
      expect((await vx(root, ['init'])).code).toBe(0)
      expect(await Bun.file(path.join(root, '.vx', '.gitignore')).text()).toBe('/cache\n/tmp\n')
      expect(await Bun.file(path.join(root, '.gitignore')).text()).toBe('node_modules\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('--keep writes it too, and never edits an existing one', async () => {
    const root = await makeRoot('vx-init-ignore-keep-')
    try {
      await Bun.write(path.join(root, 'turbo.json'), '{ "tasks": {} }\n')
      expect((await vx(root, ['init', '--keep'])).code).toBe(0)
      expect(await Bun.file(path.join(root, '.vx', '.gitignore')).text()).toBe('/cache\n/tmp\n')
      await Bun.write(path.join(root, '.vx', '.gitignore'), 'mine\n')
      expect((await vx(root, ['init', '--keep'])).code).toBe(0)
      expect(await Bun.file(path.join(root, '.vx', '.gitignore')).text()).toBe('mine\n')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

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
        expect(scripts.out).toContain('  from      package.json scripts\n')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a root outside the members maps its repo-wide scripts, and runs them',
    async () => {
      const root = await makeRoot('vx-init-root-')
      await withLockfile(root)
      const note =
        'fixture-root (the workspace root): its scripts that check the whole repo are its tasks; left out as running the members (`pnpm -r`, `--filter`, a runner): build'
      try {
        await addPackage(root, 'a', { build: 'tsc' })
        // CONTROL: a root with no scripts says nothing.
        expect((await vx(root, ['init', '--dry'])).out.split('\n')).not.toContain(note)
        await writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({
            name: 'fixture-root',
            private: true,
            scripts: { lint: 'echo linted > lint.out', build: 'pnpm -r build' },
          }),
        )
        const r = await vx(root, ['init'])
        expect(r.out.split('\n').map((l) => l.slice(12))).toContain(note)
        Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
        const lint = await vx(root, ['run', 'lint', '--all'])
        expect(lint.code).toBe(0)
        expect(await Bun.file(path.join(root, 'lint.out')).text()).toBe('linted\n')
        const build = await vx(root, ['run', 'build', '--all', '--dry=json'])
        // The root's default build is no match for a bare name (X-102).
        expect(JSON.parse(build.out).tasks.map((t: { id: string }) => t.id)).toEqual(['a#build'])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a second vx init keeps the root it mapped, with no note on it (X-27)',
    async () => {
      const root = await makeRoot('vx-init-root-again-')
      await withLockfile(root)
      try {
        await writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'fixture-root', private: true, scripts: { lint: 'oxlint .' } }),
        )
        await addPackage(root, 'a', { build: 'tsc -b', test: 'vitest run' })
        await addPackage(root, 'b', { build: 'tsc', test: 'bun test' })
        const first = await vx(root, ['init'])
        expect(first.code).toBe(0)
        const rootConfig = await Bun.file(path.join(root, 'vx.config.ts')).text()
        const reported = async (args: string[]): Promise<string[]> => {
          const r = await vx(root, args)
          expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
          const lines = r.out.split('\n')
          const from = lines.findIndex((l) => l.startsWith('  kept '))
          const to = lines.findIndex((l, i) => i > from && !l.startsWith(' '.repeat(12)))
          return [
            ...lines.filter((l) => l.includes('(the workspace root)')),
            ...lines.slice(from, to),
          ]
        }
        expect(await reported(['init'])).toEqual([
          '  kept      packages/a/vx.config.ts (has a vx config)',
          '            packages/b/vx.config.ts (has a vx config)',
          '            vx.config.ts (has a vx config)',
        ])
        // --force replaces the members' configs, never the root's (D-45).
        expect(await reported(['init', '--force', '--dry'])).toEqual([
          '  kept      vx.config.ts (has a vx config)',
        ])
        expect(await Bun.file(path.join(root, 'vx.config.ts')).text()).toBe(rootConfig)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    "a one-package repo's own config is kept once",
    async () => {
      const root = await makeRoot('vx-init-root-once-')
      try {
        await rm(path.join(root, 'pnpm-workspace.yaml'))
        await writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'solo', private: true, scripts: { build: 'echo hi' } }),
        )
        await writeFile(path.join(root, 'vx.config.ts'), 'export default { tasks: {} }\n')
        const r = await vx(root, ['init', '--dry'])
        expect(r.code).toBe(0)
        expect(r.out.split('\n').filter((l) => l.includes('(has a vx config)'))).toEqual([
          '  kept      vx.config.ts (has a vx config)',
        ])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'the run init points at loads over a dependency cycle',
    async () => {
      const root = await makeRoot('vx-init-cycle-')
      try {
        await addPackage(root, 'a', { build: 'true' }, { b: 'workspace:*' })
        await addPackage(root, 'b', { build: 'true' }, { a: 'workspace:*' })
        expect((await vx(root, ['init'])).code).toBe(0)
        Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
        const plan = await vx(root, ['run', 'build', '--all', '--dry=json'])
        expect([plan.code, plan.err]).toEqual([0, ''])
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
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
    ['bun dev', 'dev'],
    ['npm test', 'test'],
    ['npm start', 'start'],
    ['  npm run test:unit  ', 'test:unit'],
    ['npm x', null], // npm needs `run` for anything but test/start
    ['npm run x -- --flag', null],
    ['npm run x --silent', null],
    ['npm run x && npm run y', null],
    ['NODE_ENV=1 npm run x', null],
    ['npm run $SCRIPT', null],
    // Item 908: bare, a manager's own command is not a script.
    ['bun x', null], // bunx, the package runner
    ['bun test', null],
    ['bun build', null],
    ['bun run test', 'test'],
    ['pnpm install', null],
    ['pnpm test', 'test'],
    ['yarn add', null],
    ['yarn test', 'test'],
    // D-32, each probed with a script of that name present: the manager's
    // own command ran, or it ran the script.
    ['pnpm docs', null], // npm's docs page
    ['pnpm version', null],
    ['pnpm info', null],
    ['pnpm server', null],
    ['pnpm dev', 'dev'],
    ['bun deploy', null], // "reserved for future use"
    ['bun config', null],
    ['bun list', null],
    ['bun lint', 'lint'],
    ['yarn check', null], // yarn 1's integrity check; Yarn 4 runs the script, and one set serves both
    ['yarn list', null],
    ['yarn audit', null],
    ['yarn search', null], // Yarn 4's
    ['yarn lint', 'lint'],
  ])('%s → %p', (command, expected) => {
    expect(delegatedScript(command)).toBe(expected)
  })

  it('a command carrying shell syntax is never read as a plain delegation', () => {
    // One guard, thirteen members: the excluded set above is what keeps a
    // command the shell would do something with from being mistaken for a
    // bare `run <script>`. The pair form names the character that broke.
    for (const c of ['&', '|', ';', '<', '>', '(', ')', '`', "'", '"', '\\', '$', ' ']) {
      expect([c, delegatedScript(`npm run a${c}b`)]).toEqual([c, null])
    }
  })
})

/**
 * The mapper on its own, without the `vx init` round trip: what a
 * package.json's scripts become. Every case here is a shape the end-to-end
 * rows above never build.
 */
describe('migrateScripts', () => {
  const project = (scripts: unknown) =>
    migrateScripts([
      {
        name: 'app',
        dir: '/w/app',
        packageJson: { name: 'app', scripts } as never,
        configPath: null,
      },
    ]).projects[0] ?? null
  const mapped = (scripts: unknown): Record<string, unknown> =>
    Object.fromEntries((project(scripts)?.tasks ?? []).map((t) => [t.name, t.task]))

  it('exactly the conventions that read a build wait for it, and `lint` does not', () => {
    const tasks = mapped({
      build: 'tsc -b',
      test: 'v',
      typecheck: 'tsc --noEmit',
      check: 'c',
      e2e: 'pw',
      lint: 'eslint .',
    })
    const waits = Object.entries(tasks)
      .filter(([, t]) => ((t as { dependsOn?: string[] }).dependsOn ?? []).includes('build'))
      .map(([n]) => n)
      .sort()
    expect(waits).toEqual(['check', 'e2e', 'test', 'typecheck'])
    // CONTROLS: a linter reads sources, and `build` waits for its dependants'.
    expect(tasks['lint']).toEqual({ exec: { command: 'eslint .' } })
    expect(tasks['build']).toEqual({ exec: { command: 'tsc -b' }, dependsOn: ['^build'] })
  })

  it('a `build` that only delegates puts `^build` on the task that works (item 907)', () => {
    // `build: pnpm run compile` is a group over `compile`, and the group
    // carried no `^build` at all: `app#compile` ran before `lib#build`.
    const tasks = mapped({ build: 'pnpm run compile', compile: 'tsc -b', test: 'v' })
    expect({ build: tasks['build'], compile: tasks['compile'] }).toEqual({
      build: { dependsOn: ['compile'] },
      compile: { exec: { command: 'tsc -b' }, dependsOn: ['^build'] },
    })
    // Through a chain of groups, to the first command.
    const chained = mapped({ build: 'npm run b1', b1: 'npm run b2', b2: 'tsc' })
    expect(chained['b2']).toEqual({ exec: { command: 'tsc' }, dependsOn: ['^build'] })
    expect(chained['b1']).toEqual({ dependsOn: ['b2'] })
  })

  it('the task a delegating `build` reaches never waits for `build` (D-16)', () => {
    // `typecheck` waits for `build` by convention, but behind
    // `build: npm run typecheck` it IS the build: the edge was a cycle.
    const direct = mapped({ build: 'npm run typecheck', typecheck: 'tsc -b' })
    expect(direct['typecheck']).toEqual({ exec: { command: 'tsc -b' }, dependsOn: ['^build'] })
    // A group on the way that waits for `build` closes the same cycle.
    const chained = mapped({ build: 'npm run check', check: 'npm run tsc', tsc: 'tsc -b' })
    expect(chained['check']).toEqual({ dependsOn: ['tsc'] })
    expect(chained['tsc']).toEqual({ exec: { command: 'tsc -b' }, dependsOn: ['^build'] })
    // Two groups over each other end the walk; the cycle is npm's too.
    const mutual = mapped({ build: 'npm run compile', compile: 'npm run build' })
    expect(mutual['build']).toEqual({ dependsOn: ['compile'] })
    // CONTROL: a `typecheck` beside a `build` that works still waits.
    expect(mapped({ build: 'tsc', typecheck: 'tsc --noEmit' })['typecheck']).toEqual({
      exec: { command: 'tsc --noEmit' },
      dependsOn: ['build'],
    })
  })

  // The cache TODO went only on a `build` with a command, so a delegating
  // `build` wrote none anywhere, while the header said `build` carries one
  // (item 1045). It rides with `^build`, on the task that works.
  it('an outside root is named by its manifest, and only when it has a script', () => {
    const meta = { name: 'a', dir: '/w/a', packageJson: { name: 'a' } as never, configPath: null }
    const notes = (outside?: Record<string, unknown>) =>
      migrateScripts([meta], outside).notes.filter((n) => n.includes('the workspace root'))
    expect(notes({ name: 'r', scripts: { lint: 'eslint .' } })).toEqual([
      'r (the workspace root) not mapped: its scripts run the workspace; declare its own tasks in its vx.config by hand',
    ])
    // vuejs/core: a nameless root's vx.config is skipped, so the note says
    // to name it first; an empty name is no name.
    const nameless =
      'package.json (the workspace root) not mapped: its scripts run the workspace; declare its own tasks in its vx.config by hand, after giving its package.json a "name"'
    expect(notes({ scripts: { lint: 'eslint .' } })).toEqual([nameless])
    expect(notes({ name: '', scripts: { lint: 'eslint .' } })).toEqual([nameless])
    expect(notes({ name: 'r', scripts: { lint: '' } })).toEqual([])
    expect(notes({ name: 'r', scripts: [] })).toEqual([])
    expect(notes({ name: 'r' })).toEqual([])
    expect(notes()).toEqual([])
    // D-87, react: a nameless root whose scripts would map says so, and
    // how many; a hook rides with its script and is not counted.
    const at = (outside: Record<string, unknown>) =>
      migrateScripts([meta], outside, '/w').notes.filter((n) => n.includes('the workspace root'))
    expect(at({ scripts: { prelint: 'echo', lint: 'eslint .', dev: 'pnpm -r dev' } })).toEqual([
      'package.json (the workspace root) not mapped: it has no "name", and vx names a project by it; give it one and run `vx init` again to map 1 of its scripts (lint)',
    ])
    // CONTROL: nothing that would map keeps the old note.
    expect(at({ scripts: { dev: 'pnpm -r dev' } })).toEqual([nameless])
  })

  it('a cycle of builds waits on the builds outside it, never on `^build` (nuxt)', () => {
    const meta = (
      name: string,
      scripts: Record<string, string>,
      deps: string[] = [],
      dev: string[] = [],
    ) => ({
      name,
      dir: `/w/${name}`,
      packageJson: {
        name,
        scripts,
        dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])),
        devDependencies: Object.fromEntries(dev.map((d) => [d, 'workspace:*'])),
      } as never,
      configPath: null,
    })
    const plan = migrateScripts([
      meta('core', { build: 'b' }, ['types', 'server']),
      meta('server', { build: 'b' }, ['kit'], ['core']),
      meta('kit', { build: 'b' }),
      meta('types', {}, ['kit']),
      meta('app', { build: 'b' }, ['core']),
    ])
    const at = (name: string) =>
      plan.projects.find((p) => p.name === name)!.tasks.find((t) => t.name === 'build')!
    const todo =
      'its package is in a dependency cycle (core, server), where `^build` would refuse the run — it waits on the builds outside the cycle; order the ones inside it by hand'
    // core reaches kit through types, which has no build, as `^build` walks.
    expect([at('core').task!['dependsOn'], at('core').todos.includes(todo)]).toEqual([
      ['kit#build'],
      true,
    ])
    expect([at('server').task!['dependsOn'], at('server').todos.includes(todo)]).toEqual([
      ['kit#build'],
      true,
    ])
    // CONTROLS: outside the cycle, `^build` and no TODO.
    expect([at('app').task!['dependsOn'], at('app').todos.includes(todo)]).toEqual([
      ['^build'],
      false,
    ])
    expect(at('kit').task!['dependsOn']).toEqual(['^build'])
  })

  it('a `build` that only delegates puts the cache TODO on the task that works (item 1045)', () => {
    const cacheTodos = (scripts: unknown) =>
      Object.fromEntries(
        (project(scripts)?.tasks ?? []).map((t) => [
          t.name,
          t.todos.filter((d) => d.startsWith('cache: add')).length,
        ]),
      )
    expect(cacheTodos({ build: 'pnpm run compile', compile: 'tsc -b', test: 'v' })).toEqual({
      build: 0,
      compile: 1,
      test: 0,
    })
    expect(cacheTodos({ build: 'npm run b1', b1: 'npm run b2', b2: 'tsc' })).toEqual({
      build: 0,
      b1: 0,
      b2: 1,
    })
    // CONTROL: a `build` with a command carries it itself, once.
    expect(cacheTodos({ build: 'tsc -b', test: 'v' })).toEqual({ build: 1, test: 0 })
  })

  it("the cache TODO names the framework's own build output", () => {
    const outputs = (scripts: Record<string, string>, task = 'build'): string | undefined => {
      const todo = project(scripts)
        ?.tasks.find((t) => t.name === task)
        ?.todos.find((d) => d.startsWith('cache: add'))
      return /outputs: \{ files: \[(.*?)\] \}/.exec(todo ?? '')?.[1]
    }
    expect(outputs({ build: 'next build' })).toBe("'.next/**', '!.next/cache/**'")
    expect(outputs({ build: 'prisma generate && next build --turbo' })).toBe(
      "'.next/**', '!.next/cache/**'",
    )
    expect(outputs({ build: 'nuxt build' })).toBe("'.output/**'")
    expect(outputs({ build: 'nuxi build' })).toBe("'.output/**'")
    expect(outputs({ build: 'remix build' })).toBe("'build/**'")
    expect(outputs({ build: 'react-router build' })).toBe("'build/**'")
    expect(outputs({ build: 'react-scripts build' })).toBe("'build/**'")
    expect(outputs({ build: 'docusaurus build' })).toBe("'build/**'")
    expect(outputs({ build: 'gatsby build' })).toBe("'public/**'")
    expect(outputs({ build: 'storybook build' })).toBe("'storybook-static/**'")
    // The worker a delegating `build` reaches reads its own command.
    expect(outputs({ build: 'npm run b', b: 'next build' }, 'b')).toBe(
      "'.next/**', '!.next/cache/**'",
    )
    // D-90: no tool above, so the dir the command writes or cleans (ky's
    // `distribution`); a hidden dir, a file, a glob, or a scratch dir the
    // command makes again is no guess.
    expect(outputs({ build: 'del-cli distribution && tsc --project tsconfig.dist.json' })).toBe(
      "'distribution/**'",
    )
    expect(outputs({ build: 'rimraf lib && babel src -d lib' })).toBe("'lib/**'")
    expect(outputs({ build: 'tsc --outDir build' })).toBe("'build/**'")
    expect(outputs({ build: 'esbuild src/x.ts --outdir=out' })).toBe("'out/**'")
    expect(outputs({ build: 'rimraf dist types tsconfig.tsbuildinfo && tsc' })).toBe(
      "'dist/**', 'types/**'",
    )
    expect(outputs({ build: 'shx rm -rf ./es && tsc' })).toBe("'es/**'")
    expect(outputs({ build: 'rimraf .turbo && tsc' })).toBe("'dist/**'")
    expect(outputs({ build: 'rimraf "lib/**" && tsc' })).toBe("'dist/**'")
    expect(outputs({ build: 'rm -rf ./ids && mkdir ./ids && vite build' })).toBe("'dist/**'")
    // CONTROLS: anything else, and a near name, keep `dist/**`.
    expect(outputs({ build: 'tsc -b' })).toBe("'dist/**'")
    expect(outputs({ build: 'vite build' })).toBe("'dist/**'")
    expect(outputs({ build: 'nextjs-build' })).toBe("'dist/**'")
  })

  it("under Yarn 2+ a script's `run <script>` is spelled `yarn run` (D-92)", async () => {
    // Yarn's shell reads `run x` as `yarn run x`; vx's shell has no `run`,
    // and berry's `run test:unit packages/…` failed "command not found".
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-berry-run-'))
    try {
      const app = path.join(root, 'packages', 'app')
      await mkdir(app, { recursive: true })
      const scripts = {
        b: 'echo b',
        args: 'run b --x',
        chain: 'echo a && run b; run b || (run b)',
        group: 'run b',
        word: 'echo run b && docker run img',
      }
      const commands = (): Record<string, unknown> =>
        Object.fromEntries(
          (
            migrateScripts([
              {
                name: 'app',
                dir: app,
                packageJson: { name: 'app', scripts } as never,
                configPath: null,
              },
            ]).projects[0]?.tasks ?? []
          ).map((t) => [
            t.name,
            (t.task?.['exec'] as { command?: string } | undefined)?.command ?? t.task,
          ]),
        )
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ private: true, packageManager: 'yarn@4.5.0' }),
      )
      expect(commands()).toEqual({
        b: 'echo b',
        args: 'yarn run b --x',
        chain: 'echo a && yarn run b; yarn run b || (yarn run b)',
        group: { dependsOn: ['b'] },
        word: 'echo run b && docker run img',
      })
      // CONTROL: under npm, `run` is whatever the shell finds; kept.
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }))
      await writeFile(path.join(root, 'package-lock.json'), '{}')
      expect(commands()['args']).toBe('run b --x')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('under Yarn 2+ a pre/post script is a task of its own, never folded (D-31)', async () => {
    // Yarn Berry runs no `pre` / `post` hooks (probed with 4.5.0: `yarn run
    // build` printed BUILD alone), and folding them made the migrated task
    // run scripts the user's `yarn build` never did.
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-berry-'))
    try {
      const app = path.join(root, 'packages', 'app')
      await mkdir(app, { recursive: true })
      const scripts = { prebuild: 'rm -rf dist', build: 'tsc', postbuild: 'echo done' }
      const tasks = (): Record<string, unknown> =>
        Object.fromEntries(
          (
            migrateScripts([
              {
                name: 'app',
                dir: app,
                packageJson: { name: 'app', scripts } as never,
                configPath: null,
              },
            ]).projects[0]?.tasks ?? []
          ).map((t) => [t.name, t.task]),
        )
      const own = {
        prebuild: { exec: { command: 'rm -rf dist' } },
        build: { exec: { command: 'tsc' }, dependsOn: ['^build'] },
        postbuild: { exec: { command: 'echo done' } },
      }
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ private: true, packageManager: 'yarn@4.5.0' }),
      )
      expect(tasks()).toEqual(own)
      // No `packageManager`: a Berry lockfile says the same.
      await writeFile(path.join(root, 'package.json'), JSON.stringify({ private: true }))
      await writeFile(path.join(root, 'yarn.lock'), '# generated\n\n__metadata:\n  version: 8\n')
      expect(tasks()).toEqual(own)
      // CONTROL: yarn 1's lockfile, and npm's, fold the hooks as they run them.
      await writeFile(path.join(root, 'yarn.lock'), '# yarn lockfile v1\n')
      expect(Object.keys(tasks())).toEqual(['build'])
      await rm(path.join(root, 'yarn.lock'))
      await writeFile(path.join(root, 'package-lock.json'), '{}')
      expect(Object.keys(tasks())).toEqual(['build'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('npm and pnpm told to skip hooks keep pre/post apart; Bun and pnpm otherwise fold (D-33)', async () => {
    // Probed with a prebuild / build / postbuild trio: `npm run build`
    // under `ignore-scripts=true` printed BUILD alone, as did `pnpm run
    // build` under `enable-pre-post-scripts=false` or `enablePrePostScripts:
    // false`; Bun and pnpm under `ignore-scripts=true` printed all three.
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-hookcfg-'))
    try {
      const app = path.join(root, 'packages', 'app')
      await mkdir(app, { recursive: true })
      const scripts = { prebuild: 'rm -rf dist', build: 'tsc' }
      const names = (): string[] =>
        (
          migrateScripts([
            {
              name: 'app',
              dir: app,
              packageJson: { name: 'app', scripts } as never,
              configPath: null,
            },
          ]).projects[0]?.tasks ?? []
        )
          .map((t) => t.name)
          .sort()
      const apart = ['build', 'prebuild']
      const at = async (lock: string, files: Record<string, string>): Promise<string[]> => {
        await rm(root, { recursive: true, force: true })
        await mkdir(app, { recursive: true })
        await writeFile(path.join(root, lock), '')
        for (const [f, body] of Object.entries(files)) await writeFile(path.join(root, f), body)
        return names()
      }
      expect(await at('package-lock.json', { '.npmrc': 'ignore-scripts=true\n' })).toEqual(apart)
      expect(await at('pnpm-lock.yaml', { '.npmrc': 'enable-pre-post-scripts = false\n' })).toEqual(
        apart,
      )
      expect(
        await at('pnpm-lock.yaml', {
          'pnpm-workspace.yaml': 'packages: []\nenablePrePostScripts: false\n',
        }),
      ).toEqual(apart)
      // pnpm 10 reads the YAML, so a trailing comment or a flow mapping is
      // the same setting; a line regex missed both and folded the hook.
      expect(
        await at('pnpm-lock.yaml', {
          'pnpm-workspace.yaml': 'packages: []\nenablePrePostScripts: false # hooks off\n',
        }),
      ).toEqual(apart)
      expect(
        await at('pnpm-lock.yaml', {
          'pnpm-workspace.yaml': '{packages: [], enablePrePostScripts: false}\n',
        }),
      ).toEqual(apart)
      expect(
        await at('pnpm-lock.yaml', {
          'pnpm-workspace.yaml': 'packages: []\nenablePrePostScripts: true # hooks on\n',
        }),
      ).toEqual(['build'])
      // CONTROL: the setting a manager ignores, or none, folds the hook.
      expect(await at('pnpm-lock.yaml', { '.npmrc': 'ignore-scripts=true\n' })).toEqual(['build'])
      expect(await at('bun.lock', { '.npmrc': 'ignore-scripts=true\n' })).toEqual(['build'])
      expect(await at('package-lock.json', { '.npmrc': 'ignore-scripts=false\n' })).toEqual([
        'build',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the fold TODO names the manager that ran the hook (E-86)', async () => {
    // A pnpm workspace's TODO said "npm ran `prebuild`" (the init walk).
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-hookname-'))
    try {
      const app = path.join(root, 'packages', 'app')
      const todo = async (lock: string | null): Promise<string | undefined> => {
        await rm(root, { recursive: true, force: true })
        await mkdir(app, { recursive: true })
        if (lock !== null) await writeFile(path.join(root, lock), '')
        const [p] = migrateScripts([
          {
            name: 'app',
            dir: app,
            packageJson: {
              name: 'app',
              scripts: { prebuild: 'rm -rf dist', build: 'tsc' },
            } as never,
            configPath: null,
          },
        ]).projects
        return p?.tasks.find((t) => t.name === 'build')?.todos.find((t) => t.includes(' ran '))
      }
      const said = (pm: string): string =>
        `${pm} ran \`prebuild\` around this script without being asked; folded into the command in that order`
      expect(await todo('pnpm-lock.yaml')).toBe(said('pnpm'))
      expect(await todo('bun.lock')).toBe(said('bun'))
      expect(await todo('yarn.lock')).toBe(said('yarn'))
      expect(await todo('package-lock.json')).toBe(said('npm'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a script reading $npm_package_* gets it defined, from the manifest (D-34)', () => {
    // npm, pnpm, bun and yarn set these for a script and vx sets none: the
    // migrated `echo $npm_package_version` printed an empty string.
    const p = project({
      v: 'echo $npm_package_version ${npm_package_name} $npm_lifecycle_event $npm_config_x',
      prebuild: 'echo $npm_lifecycle_event',
      build: 'tsc',
      plain: 'echo hi',
    })
    const tasks = Object.fromEntries((p?.tasks ?? []).map((t) => [t.name, t]))
    expect(p?.importLines).toEqual(["import pkg from './package.json' with { type: 'json' }"])
    expect(tasks['v']?.task).toEqual({
      exec: {
        command: 'echo $npm_package_version ${npm_package_name} $npm_lifecycle_event $npm_config_x',
        env: {
          define: {
            npm_package_version: { raw: 'pkg.version' },
            npm_package_name: { raw: 'pkg.name' },
            npm_lifecycle_event: 'v',
          },
        },
      },
    })
    expect(tasks['v']?.todos.filter((t) => t.includes('$npm_'))).toEqual([
      'the script reads $npm_config_x, which the package manager sets and vx does not: define it under exec.env.define or drop it',
    ])
    // A folded hook ran under its own event name, which the task cannot give it.
    expect(tasks['build']?.todos.some((t) => t.includes('$npm_lifecycle_event'))).toBe(true)
    // CONTROL: a script reading none gets no env and imports nothing.
    expect(tasks['plain']?.task).toEqual({ exec: { command: 'echo hi' } })
    expect(project({ plain: 'echo hi' })?.importLines).toEqual([])
  })

  it('the hook rules read the manager as each writes itself (D-35)', async () => {
    // A sweep of D-31 to D-34 found these unheld: each flips a fold.
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-hookrules-'))
    try {
      const app = path.join(root, 'app')
      const names = (): string[] =>
        (
          migrateScripts([
            {
              name: 'app',
              dir: app,
              packageJson: { name: 'app', scripts: { prebuild: 'x', build: 'y' } } as never,
              configPath: null,
            },
          ]).projects[0]?.tasks ?? []
        )
          .map((t) => t.name)
          .sort()
      const at = async (files: Record<string, string>): Promise<string[]> => {
        await rm(root, { recursive: true, force: true })
        await mkdir(app, { recursive: true })
        for (const [f, body] of Object.entries(files)) {
          await mkdir(path.dirname(path.join(root, f)), { recursive: true })
          await writeFile(path.join(root, f), body)
        }
        return names()
      }
      const pm = (v: string): string => JSON.stringify({ private: true, packageManager: v })
      // Yarn 1 named in `packageManager` runs hooks; npm named with its
      // version is npm, and reads its `.npmrc`.
      expect(await at({ 'package.json': pm('yarn@1.22.22') })).toEqual(['build'])
      expect(
        await at({ 'package.json': pm('npm@10.9.0'), '.npmrc': 'ignore-scripts=true\n' }),
      ).toEqual(['build', 'prebuild'])
      // A commented-out setting is no setting.
      expect(await at({ 'package-lock.json': '{}', '.npmrc': '# ignore-scripts=true\n' })).toEqual([
        'build',
      ])
      // The nearest lockfile decides: Bun's under a Berry root folds.
      expect(await at({ 'package.json': pm('yarn@4.5.0'), 'app/bun.lock': '' })).toEqual(['build'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a $npm_* read twice is one TODO (D-35)', () => {
    const todos = project({ v: 'echo $npm_config_x $npm_config_x' })?.tasks[0]?.todos ?? []
    expect(todos.filter((t) => t.includes('$npm_config_x'))).toHaveLength(1)
  })

  it('a watcher is persistent by its name or its flag (D-40)', () => {
    // docusaurus's `build:watch` (`tsc --build --watch`) and `copy:watch`
    // were plain tasks: a dependent waited on a script that never exits.
    const persistent = (scripts: Record<string, string>): string[] =>
      (project(scripts)?.tasks ?? [])
        .filter((t) => (t.task?.['exec'] as { persistent?: unknown } | undefined)?.persistent)
        .map((t) => t.name)
        .sort()
    expect(
      persistent({
        'build:watch': 'tsc --build',
        'watch-css': 'sass src:dist',
        'copy:assets': 'node copy.js --watch',
        types: 'tsc -w',
        bundle: 'rollup -c -w',
        serve2: 'nodemon src/index.js',
        jest: 'jest --watchAll',
        opts: 'esbuild app.ts --watch=forever',
      }),
    ).toEqual([
      'build:watch',
      'bundle',
      'copy:assets',
      'jest',
      'opts',
      'serve2',
      'types',
      'watch-css',
    ])
    // CONTROL: `-w` is npm's workspace flag, `--watchman` is jest's, and a
    // `watcher` name is not a `watch` segment.
    expect(
      persistent({
        b: 'npm run build -w pkg',
        t: 'jest --watchman',
        watcher: 'node watcher-report.js',
      }),
    ).toEqual([])
    // D-91: a server, by its command or a persistent script it runs by name
    // (docusaurus's `serve website`, `cross-env … pnpm start`, vitest's `vite`).
    expect(
      persistent({
        'serve:site': 'serve website',
        'serve:ssl': 'pnpm build && serve website/build --ssl-cert c',
        start: 'docusaurus start',
        'start:base': "cross-env BASE_URL='/b/' pnpm start",
        client: 'vite',
        pv: 'vite preview --port 3',
        ns: 'next start',
        nd: 'pnpm build && netlify dev',
        ws: 'webpack serve',
        build: 'tsc',
      }),
    ).toEqual(['client', 'nd', 'ns', 'pv', 'serve:site', 'serve:ssl', 'start', 'start:base', 'ws'])
    // CONTROLS: a build, a server another tool runs and stops, or one sent
    // to the background before the real command.
    expect(
      persistent({
        vb: 'vite build',
        nb: 'next build',
        sb: 'storybook build',
        e2e: 'start-server-and-test "vite preview" 4173 "playwright test"',
        bg: 'pnpm preview & playwright test',
        preview: 'vite preview',
        dock: 'docker run -w /x img',
      }).filter((n) => n !== 'preview'),
    ).toEqual([])
  })

  it('the readiness note rides only a persistent task something depends on', () => {
    // hoppscotch: 24 `dev`-shaped scripts nothing depends on, each with a
    // note to gate dependents it does not have (item 602 in vx-migrate).
    const noted = (scripts: Record<string, string>): string[] =>
      (project(scripts)?.tasks ?? [])
        .filter((t) => t.todos.includes(PERSISTENT_TODO))
        .map((t) => t.name)
    expect(noted({ dev: 'vite', preview: 'vite preview' })).toEqual([])
    // CONTROL: a group over `dev` waits on it.
    expect(noted({ dev: 'vite', start: 'npm run dev' })).toEqual(['dev'])
  })

  it('the workspace root among members is not mapped; a lone package is (D-45)', () => {
    // A root's scripts run the workspace (`npm run build --workspaces`):
    // mapped, its `build` ran every member's build again under `--all`,
    // and since D-39 `--force` replaced a hand-written root config so.
    const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
      name,
      dir,
      packageJson: { name, scripts } as never,
      configPath: null,
    })
    // A root script that checks the whole repo (`eslint .`) is the root's
    // task; one that runs the members, or shares a member's task name, is
    // not (remix: `vx run lint` found no project).
    const rootMeta = meta('root', '/w', {
      // D-85: a left-out script's hook goes with it, not into a task.
      prebuild: 'rm -rf dist',
      build: 'tsc -b',
      lint: 'eslint .',
      test: 'npm run test --workspaces',
      dev: 'pnpm --filter app dev',
      play: 'pnpm -C play dev',
      e2e: 'turbo run e2e',
      ci: 'vx run ci --all',
      'build:common': 'yarn --cwd ./packages/common build:esm',
      'build:b': 'npm --prefix packages/b run build',
      prisma: 'yarn workspace @calcom/prisma prisma',
      release: 'vp run build && vp exec changeset publish',
      // vite: each runs the members through a root script that does.
      'build:all': 'pnpm -r run build',
      'ci-docs': 'pnpm build:all && pnpm docs',
      'test-docs': 'npm run ci-docs',
      // CONTROL: one calling a root script that runs no member maps.
      check: 'pnpm lint && bun run typos',
      typos: 'typos',
    })
    const a = meta('a', '/w/packages/a', { build: 'tsc' })
    const plan = migrateScripts([rootMeta, a])
    expect(plan.projects.map((p) => [p.name, p.tasks.map((t) => t.name)])).toEqual([
      ['a', ['build']],
      ['root', ['lint', 'check', 'typos']],
    ])
    expect(plan.notes).toEqual([
      "root (the workspace root): its scripts that check the whole repo are its tasks; left out as running the members (`pnpm -r`, `--filter`, a runner): test, dev, play, e2e, ci, build:common, build:b, prisma and 4 more; left out as a member's task name, so `--all` never runs one twice: build — one that does other work maps by hand under a name of its own",
    ])
    // CONTROL: a hand-written root config stays as written.
    const configured = { ...rootMeta, configPath: '/w/vx.config.ts' }
    expect(migrateScripts([configured, a]).projects.map((p) => p.name)).toEqual(['a'])
    // A configured root's reason is judged on its own scripts (X-27).
    const sharing = { ...meta('root', '/w', { lint: 'eslint .' }), configPath: '/w/vx.config.ts' }
    expect(
      migrateScripts([sharing, meta('a', '/w/packages/a', { lint: 'eslint src' })]).notes,
    ).toEqual([
      "root (the workspace root) not mapped: its scripts share a member's task name (lint); declare its own tasks in its vx.config by hand",
    ])
    // CONTROL: nothing left to map keeps the old note.
    const runs = meta('root', '/w', { build: 'npm run build --workspaces' })
    expect(migrateScripts([runs, a]).notes).toEqual([
      'root (the workspace root) not mapped: its scripts run the workspace; declare its own tasks in its vx.config by hand',
    ])
    // CONTROL: a single-package repo's root is its project; siblings with
    // no root among them all map.
    expect(migrateScripts([rootMeta]).projects.map((p) => p.name)).toEqual(['root'])
    const b = meta('b', '/w/packages/b', { build: 'tsc' })
    expect(migrateScripts([a, b]).projects.map((p) => p.name)).toEqual(['a', 'b'])
    // A sibling whose dir only starts with the root's name is no member.
    const w2 = meta('w2', '/w2', { build: 'tsc' })
    expect(migrateScripts([rootMeta, w2]).projects.map((p) => p.name)).toEqual(['root', 'w2'])
    // A member holding a nested one, beside a member outside it, is no root.
    const app = meta('app', '/w/apps/a', { build: 'tsc' })
    const ex = meta('ex', '/w/apps/a/ex', { build: 'tsc' })
    const lib = meta('lib', '/w/packages/lib', { build: 'tsc' })
    expect(migrateScripts([app, ex, lib]).projects.map((p) => p.name)).toEqual(['app', 'ex', 'lib'])
  })

  it('a workspace flag counts on the package manager, not the program it runs (D-81)', () => {
    // berry's root `bench` passes node's `-r` (`--require`) through
    // `yarn node`, and was left out as `pnpm -r`.
    const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
      name,
      dir,
      packageJson: { name, scripts } as never,
      configPath: null,
    })
    const root = meta('root', '/w', {
      bench: 'yarn node -r ./scripts/setup-ts-execution ./scripts/bench.ts',
      mocha: 'mocha -r ts-node/register',
      pack: 'tar -C dist -czf out.tgz .',
      watch: 'pnpm exec tsc -w',
      // CONTROLS: the manager's own flags still run the members.
      every: 'cross-env CI=1 pnpm -r test',
      each: 'pnpm exec -r tsc',
      some: 'NODE_ENV=x yarn --cwd packages/a build',
      // npm/cli runs its own npm.
      self: 'node . run test --workspaces --if-present',
    })
    const a = meta('a', '/w/packages/a', { build: 'tsc' })
    expect(
      migrateScripts([root, a]).projects.map((p) => [p.name, p.tasks.map((t) => t.name)]),
    ).toEqual([
      ['a', ['build']],
      ['root', ['bench', 'mocha', 'pack', 'watch']],
    ])
  })

  it("a root script's hook is judged with its script, never by a member's name (D-85)", () => {
    // npm/cli: each member declares `postlint`, and the root's own was
    // dropped from its `lint` as a member's task name.
    const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
      name,
      dir,
      packageJson: { name, scripts } as never,
      configPath: null,
    })
    const root = meta('root', '/w', { lint: 'eslint .', postlint: 'echo after' })
    const a = meta('a', '/w/packages/a', { build: 'tsc', postlint: 'true' })
    const plan = migrateScripts([root, a])
    expect(plan.projects[1]!.tasks).toEqual([
      {
        name: 'lint',
        todos: [
          'npm ran `postlint` around this script without being asked; folded into the command in that order',
        ],
        task: {
          exec: { command: foldScriptHooks(undefined, 'eslint .', 'echo after') },
        },
      },
    ])
    expect(plan.notes).toEqual([
      'root (the workspace root): its scripts that check the whole repo are its tasks',
    ])
  })

  it('a cd runs the members only into a member, and a run verb only on node (D-83)', () => {
    // bun's root: `test/` is no member, and docker's `-w` is its workdir.
    const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
      name,
      dir,
      packageJson: { name, scripts } as never,
      configPath: null,
    })
    const root = meta('root', '/w', {
      typecheck: 'tsc --noEmit && cd test && bun run typecheck',
      linux: 'docker run --rm -w /root/bun img',
      // CONTROLS: into a member, above one, or where vx cannot tell.
      unit: 'cd packages/a && vitest run',
      quoted: "cd './packages/a/src' && tsc",
      above: 'cd packages && ls',
      dyn: 'cd "$DIR" && make',
    })
    const a = meta('a', '/w/packages/a', { build: 'tsc' })
    expect(
      migrateScripts([root, a]).projects.map((p) => [p.name, p.tasks.map((t) => t.name)]),
    ).toEqual([
      ['a', ['build']],
      ['root', ['typecheck', 'linux']],
    ])
  })

  it('a cd into a member whose dir holds a backslash-escaped space runs the members', () => {
    const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
      name,
      dir,
      packageJson: { name, scripts } as never,
      configPath: null,
    })
    const root = meta('root', '/w', {
      escaped: 'cd packages/my\\ app && vitest run',
      escapedParen: 'cd packages/my\\ app\\ \\(v2\\)/src && tsc',
      quoted: 'cd "packages/my app" && vitest run',
      // CONTROL: an escaped space into no member stays a root task.
      other: 'cd docs/my\\ notes && make',
    })
    const a = meta('a', '/w/packages/my app', { build: 'tsc' })
    const b = meta('b', '/w/packages/my app (v2)', { build: 'tsc' })
    expect(
      migrateScripts([root, a, b]).projects.map((p) => [p.name, p.tasks.map((t) => t.name)]),
    ).toEqual([
      ['a', ['build']],
      ['b', ['build']],
      ['root', ['other']],
    ])
  })

  it('a root script reaching a member-running one through a script runner is left out (D-95)', () => {
    // lexical's `ci-check` (`npm-run-all --parallel … tsc-website …`) ran
    // `pnpm --filter @lexical/website run tsc` again as a root task.
    const meta = (name: string, dir: string, scripts: Record<string, string>) => ({
      name,
      dir,
      packageJson: { name, scripts } as never,
      configPath: null,
    })
    const root = meta('root', '/w', {
      'build:all': 'pnpm -r build',
      ci: 'run-s build:all lint',
      ci2: 'npm-run-all --parallel build:all lint',
      ci3: 'concurrently "npm:build:all" "npm:lint"',
      ci4: 'run-p build:*',
      // CONTROLS: a runner over scripts that run no member (`*` stops at
      // `:`), and one naming a script the root does not have.
      ci5: 'run-s lint check:*',
      ci6: 'run-p build',
      'check:types': 'tsc',
      'build:x:y': 'pnpm -r x',
      lint: 'eslint .',
    })
    const a = meta('a', '/w/packages/a', { build: 'tsc' })
    expect(
      migrateScripts([root, a]).projects.map((p) => [p.name, p.tasks.map((t) => t.name)]),
    ).toEqual([
      ['a', ['build']],
      ['root', ['ci5', 'ci6', 'check:types', 'lint']],
    ])
  })

  it("npm's lifecycle scripts are never tasks, but a hook of one is a task of its own", () => {
    // `postprepare` is npm's hook of `prepare`, and `prepare` is npm's own —
    // so it wraps nothing here and has to stand alone or it disappears.
    expect(
      Object.keys(
        mapped({
          build: 'tsc',
          install: 'node-gyp rebuild',
          preinstall: 'a',
          postinstall: 'b',
          prepublish: 'c',
          postpublish: 'd',
          prepack: 'e',
          postpack: 'f',
          preversion: 'g',
          postversion: 'h',
          prepare: 'husky install',
          prepublishOnly: 'i',
          pack: 'echo pack',
          postprepare: 'echo after prepare',
        }),
      ).sort(),
    ).toEqual(['build', 'pack', 'postprepare'])
  })

  it('a delegation that cannot become a group stays the command it was', () => {
    const tasks = mapped({
      b: 'real',
      missing: 'npm run nosuch',
      loop: 'npm run loop',
      hooked: 'npm run b',
      prehooked: 'echo pre',
    })
    // A group over a script that does not exist names a task nothing defines.
    expect(tasks['missing']).toEqual({ exec: { command: 'npm run nosuch' } })
    // A group over ITSELF is a cycle.
    expect(tasks['loop']).toEqual({ exec: { command: 'npm run loop' } })
    // A group has no command, so a folded hook would be dropped silently.
    expect(tasks['hooked']).toEqual({
      exec: { command: foldScriptHooks('echo pre', 'npm run b', undefined) },
    })
    // A group over a lifecycle script or a folded hook names a task the
    // mapping never emits (D-12).
    const noTask = mapped({ prepare: 'husky', setup: 'npm run prepare' })
    expect(noTask['setup']).toEqual({ exec: { command: 'npm run prepare' } })
    const folded = mapped({ prebuild: 'rm -rf dist', build: 'tsc', clean: 'npm run prebuild' })
    expect(folded['clean']).toEqual({ exec: { command: 'npm run prebuild' } })
    // CONTROL, on its own fixture: none of those problems, so still a group.
    expect(mapped({ b: 'real', d: 'npm run b' })['d']).toEqual({ dependsOn: ['b'] })
  })

  it('nothing waits for a `build` the package does not have, and never twice', () => {
    const edges = (tasks: Record<string, unknown>): string[] =>
      Object.entries(tasks)
        .flatMap(([n, t]) =>
          ((t as { dependsOn?: string[] }).dependsOn ?? []).map((d) => `${n}→${d}`),
        )
        .sort()
    // No `build` script: neither the command path nor the group path may
    // invent an edge to one.
    expect(
      edges(
        mapped({
          test: 'vitest',
          typecheck: 'tsc --noEmit',
          'test:unit': 'v',
          e2e: 'npm run test:unit',
        }),
      ),
    ).toEqual(['e2e→test:unit'])
    // And a group whose target IS `build` lists it once, not twice.
    expect(edges(mapped({ build: 'tsc', test: 'npm run build' }))).toEqual([
      'build→^build',
      'test→build',
    ])
  })

  it('a scripts field that is not an object of strings is skipped, never a crash', () => {
    // package.json is a boundary. `typeof null === 'object'`, and a value
    // that is not a string has no `.trim()` — both used to be a TypeError
    // out of `vx init` rather than a package it declined to map.
    expect(project(null)).toBeNull()
    expect(project(['tsc'])).toBeNull()
    expect(project('tsc')).toBeNull()
    expect(Object.keys(mapped({ a: 123, b: 'ok' }))).toEqual(['b'])
    expect(Object.keys(mapped({ a: '', b: 'ok' }))).toEqual(['b'])
  })
})

/**
 * A stand-in `@vzn/vx-lockfile` (the sandbox lets this suite read only
 * core): `pnpm()` supplies the names and edges the real one reads from the
 * lockfile, here from the manifests the fixture wrote.
 */
async function standIn(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true })
  await writeFile(
    path.join(dir, 'package.json'),
    JSON.stringify({ name: '@vzn/vx-lockfile', type: 'module', exports: './index.js' }),
  )
  await writeFile(
    path.join(dir, 'index.js'),
    `import { definePlugin } from '@vzn/vx'
export const pnpm = () => definePlugin(import.meta, {
  async discover(ctx) {
    const pkgs = await Promise.all(
      ctx.projects.map((p) => Bun.file(p.dir + '/package.json').json().catch(() => ({}))),
    )
    const dir = new Map(pkgs.map((pkg, i) => [pkg.name, ctx.projects[i].dir]))
    return ctx.projects.map((p, i) => ({
      dir: p.dir,
      ...(typeof pkgs[i].name === 'string' ? { name: pkgs[i].name } : {}),
      deps: Object.keys({ ...pkgs[i].dependencies, ...pkgs[i].devDependencies })
        .filter((n) => n !== pkgs[i].name && dir.has(n))
        .map((n) => dir.get(n)),
    }))
  },
})
`,
  )
}

/**
 * A pnpm lockfile and the stand-in plugin init declares for it: core reads
 * no manifest edge, so the configs init writes need this edge source.
 */
async function withLockfile(root: string): Promise<void> {
  await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
  await standIn(path.join(root, 'node_modules', '@vzn', 'vx-lockfile'))
}

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
  it('reports itself as vx-migrate, as every migration does, and the file carries no banner', async () => {
    const root = await makeScriptsWorkspace()
    try {
      const r = await vx(root, ['init'])
      expect(r.code).toBe(0)
      const text = `${r.out}${r.err}`
      expect(text).toContain('─ vx-migrate ')
      expect(text).not.toContain('vx migrate')
      const generated = await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).text()
      // The file is the user's: no "generated by" header (2026-10-06).
      expect(generated.startsWith("import type { ProjectConfig } from '@vzn/vx/config'\n")).toBe(
        true,
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('ends with the lock: .vx/projects.lock.json written and named, none under --dry', async () => {
    // 2026-10-14: "vx migrate should generate lock as well".
    const root = await makeScriptsWorkspace()
    await withLockfile(root)
    try {
      const dry = await vx(root, ['init', '--dry'])
      expect(dry.code).toBe(0)
      expect(existsSync(path.join(root, '.vx/projects.lock.json'))).toBe(false)
      const r = await vx(root, ['init'])
      expect(r.code).toBe(0)
      expect(r.err).toBe('')
      expect(row(r.out, 'lock')).toEqual(['3 project configs → .vx/projects.lock.json'])
      const lock = (await Bun.file(path.join(root, '.vx/projects.lock.json')).json()) as {
        projects: Record<string, unknown>
      }
      expect(Object.keys(lock.projects)).toEqual([
        'packages/app',
        'packages/lib',
        'packages/silent',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a coloured report names the lock once: vx lock’s own mark is not its row', async () => {
    // `vx lock` inherits FORCE_COLOR, so its line starts with an escape and
    // the plain `✓ vx lock` prefix match missed: the row repeated it.
    const root = await makeScriptsWorkspace()
    await withLockfile(root)
    try {
      const r = await vx(root, ['init'], { FORCE_COLOR: '1' })
      expect(r.code).toBe(0)
      expect(row(Bun.stripANSI(r.out), 'lock')).toEqual([
        '3 project configs → .vx/projects.lock.json',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a graph rule the lock refuses is printed, and the configs stay written', async () => {
    const root = await makeScriptsWorkspace()
    await withLockfile(root)
    // A member's own config with a dependsOn cycle: the lock's graph check refuses it.
    await writeFile(
      path.join(root, 'packages', 'silent', 'vx.config.mjs'),
      "export default { tasks: { build: { exec: { command: 'true' }, dependsOn: ['build'] } } }\n",
    )
    try {
      const r = await vx(root, ['init'])
      expect(r.code).toBe(0)
      expect(r.err).toContain('✗ vx lock  lock not written\n\n  ')
      expect(r.err).toContain('dependsOn cycle')
      expect(r.out).toContain('  lock      not written\n')
      expect(r.out).toContain('  next      fix the above, then vx lock and ')
      expect(existsSync(path.join(root, '.vx/projects.lock.json'))).toBe(false)
      expect(existsSync(path.join(root, 'packages', 'app', 'vx.config.ts'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names the files .gitignore would drop, and the line that keeps them', async () => {
    // vueuse ignores `packages/**/*.mjs`: `--mjs` wrote configs a commit
    // silently left behind (Growth, 2026-10-09).
    const root = await makeScriptsWorkspace()
    try {
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      const note = async (): Promise<string[]> =>
        (await vx(root, ['init', '--mjs', '--dry'])).out
          .split('\n')
          .filter((l) => l.includes('.gitignore drops'))
          .map((l) => l.slice(12))
      expect(await note()).toEqual([])
      await writeFile(path.join(root, '.gitignore'), 'packages/**/*.mjs\n')
      expect(await note()).toEqual([
        '.gitignore drops 3 files this would write (packages/app/vx.config.mjs, packages/lib/vx.config.mjs, packages/silent/vx.config.mjs): add !vx.config.mjs to .gitignore, or commit them with git add -f',
      ])
      // The advice works: with the line added, nothing is dropped.
      await writeFile(path.join(root, '.gitignore'), 'packages/**/*.mjs\n!vx.config.mjs\n')
      expect(await note()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('--mjs writes vx.config.mjs and .vx/workspace.mjs, untyped, and they load', async () => {
    // A package whose own `tsc --build` includes every `.ts` under it
    // compiles a generated vx.config.ts into its dist (TanStack/query,
    // 2026-09-11); the same object as `.mjs` is outside that include.
    const root = await makeScriptsWorkspace()
    try {
      const r = await vx(root, ['init', '--mjs'])
      expect(r.code).toBe(0)
      expect(`${r.out}${r.err}`).toContain('  files     packages/app/vx.config.mjs\n')
      const configPath = path.join(root, 'packages', 'app', 'vx.config.mjs')
      const generated = await Bun.file(configPath).text()
      expect(generated).not.toContain('@vzn/vx')
      expect(generated).not.toContain('satisfies')
      expect(await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).exists()).toBe(
        false,
      )
      const ws = await Bun.file(path.join(root, '.vx/workspace.mjs')).text()
      expect(ws).not.toContain('@vzn/vx')
      expect(ws).toContain('export default { plugins: [] }')
      const config = await loadProjectConfig(configPath)
      expect(Object.keys(config.tasks ?? {})).toContain('build')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('--keep in a Turbo repo writes .vx/workspace.ts declaring turbo() and the plugins the repo calls for', async () => {
    // Turbo 2.5+ reads `turbo.jsonc` as well (item 938).
    for (const file of ['turbo.json', 'turbo.jsonc']) {
      const root = await makeScriptsWorkspace()
      try {
        await Bun.write(path.join(root, file), '{ "tasks": { "compile": {} } }\n')
        const r = await vx(root, ['init', '--keep'])
        expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
        // The stand-in npm installs nothing, so `next:` installs what is missing.
        expect(r.out.split('\n').slice(2).join('\n')).toBe(
          `  from      ${file}, run by turbo() from @vzn/vx-migrate\n` +
            '  ran       npm install -D @vzn/vx @vzn/vx-migrate @vzn/vx-history\n' +
            '  files     .vx/workspace.ts\n' +
            '            .vx/.gitignore\n' +
            '  note      a temporary start: vx init --native writes native config\n\n' +
            '  next      npm install -D @vzn/vx-migrate @vzn/vx-history && vx lock && vx run compile --all\n',
        )
        expect(await Bun.file(path.join(root, '.vx/workspace.ts')).text()).toBe(
          "import type { WorkspaceConfig } from '@vzn/vx/config'\n" +
            "import { turbo } from '@vzn/vx-migrate'\n" +
            "import { vxHistory } from '@vzn/vx-history'\n\n" +
            'export default {\n  plugins: [\n    turbo(),\n    vxHistory(),\n  ],\n} satisfies WorkspaceConfig\n',
        )
        expect(existsSync(path.join(root, 'packages', 'app', 'vx.config.ts'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('--native or --keep outside a Turbo or Nx repo is refused', async () => {
    const root = await makeScriptsWorkspace()
    try {
      const r = await vx(root, ['init', '--native'])
      expect([r.code, r.err]).toEqual([
        1,
        "vx-migrate: --native answers a Turbo or Nx repo's question, and no turbo.json or nx.json is at .\n",
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('--keep in an Nx repo gets nx(); beside turbo.json, --from picks the runner', async () => {
    for (const [markers, args, runner] of [
      [['nx.json'], [], 'nx'],
      [['nx.json', 'turbo.json'], ['--from', 'turbo'], 'turbo'],
      [['nx.json', 'turbo.json'], ['--from', 'nx'], 'nx'],
    ] as [string[], string[], string][]) {
      const root = await makeScriptsWorkspace()
      try {
        for (const m of markers) await Bun.write(path.join(root, m), '{}\n')
        const r = await vx(root, ['init', '--keep', '--dry', ...args])
        expect(r.code).toBe(0)
        expect(r.out).toContain(`import { ${runner} } from '@vzn/vx-migrate'`)
        expect(r.out).toContain(`  plugins: [\n    ${runner}(),\n`)
        expect(r.out).toContain('  dry run   nothing written\n')
        expect(r.out).toContain('  files     .vx/workspace.ts\n')
        expect(existsSync(path.join(root, '.vx/workspace.ts'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
    // CONTROL: both, and no --from, is a question for the user.
    const root = await makeScriptsWorkspace()
    try {
      for (const m of ['nx.json', 'turbo.json']) await Bun.write(path.join(root, m), '{}\n')
      const r = await vx(root, ['init', '--keep', '--dry'])
      expect([r.code, r.err]).toEqual([
        1,
        'vx-migrate: both turbo.json and an nx workspace are present — pass --from turbo or --from nx\n',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }, 60_000)

  it('a remote cache the repo shows is declared beside the runner, and named', async () => {
    const rows: Record<string, unknown> = {}
    for (const [label, files] of [
      ['turbo.json remoteCache', { 'turbo.json': '{ "remoteCache": { "teamId": "t" } }\n' }],
      [
        'workflow TURBO_TOKEN',
        {
          'turbo.json': '{}\n',
          '.github/workflows/ci.yml': 'env:\n  TURBO_TOKEN: ${{ secrets.T }}\n',
        },
      ],
      [
        'nx gitlab',
        {
          'nx.json': '{}\n',
          '.gitlab-ci.yml': 'variables:\n  NX_SELF_HOSTED_REMOTE_CACHE_SERVER: https://c\n',
        },
      ],
      ['disabled', { 'turbo.json': '{ "remoteCache": { "enabled": false } }\n' }],
      // `turbo link` writes the team, its keys in either case.
      ['turbo link', { 'turbo.json': '{}\n', '.turbo/config.json': '{ "teamid": "team_1" }\n' }],
      ['an empty link', { 'turbo.json': '{}\n', '.turbo/config.json': '{ "teamId": "" }\n' }],
      [
        'linked, disabled',
        {
          'turbo.json': '{ "remoteCache": { "enabled": false } }\n',
          '.turbo/config.json': '{ "teamId": "team_1" }\n',
        },
      ],
      ['nx with a Turbo token', { 'nx.json': '{}\n', '.gitlab-ci.yml': 'TURBO_TOKEN: x\n' }],
      // Nx Cloud is a wire vx does not speak: said, not declared.
      ['nx cloud', { 'nx.json': '{ "nxCloudId": "abc" }\n' }],
      [
        'nx cloud, legacy runner',
        { 'nx.json': '{ "tasksRunnerOptions": { "default": { "runner": "@nrwl/nx-cloud" } } }\n' },
      ],
      ['nx, an empty cloud id', { 'nx.json': '{ "nxCloudId": "" }\n' }],
      // A line that names the variable does not set it (J's lead).
      [
        'a comment naming TURBO_TOKEN',
        {
          'turbo.json': '{}\n',
          '.github/workflows/ci.yml': 'jobs:\n  # TURBO_TOKEN comes later\n  b: { runs-on: x }\n',
        },
      ],
      // Turned off in turbo.json is off, whatever CI sets.
      [
        'disabled, with a CI token',
        {
          'turbo.json': '{ "remoteCache": { "enabled": false } }\n',
          '.github/workflows/ci.yml': 'env:\n  TURBO_TOKEN: ${{ secrets.T }}\n',
        },
      ],
    ] as [string, Record<string, string>][]) {
      const root = await makeScriptsWorkspace()
      try {
        for (const [f, text] of Object.entries(files)) await Bun.write(path.join(root, f), text)
        const r = await vx(root, ['init', '--keep', '--dry', '--mjs'])
        rows[label] = [
          r.code,
          r.out
            .split('\n')
            .filter((l) => /Cache|Nx Cloud/.test(l))
            .map((l) => l.replace(/^ {12}/, '')),
        ]
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
    const shares = (factory: string, why: string) => [
      0,
      [
        `import { ${factory} } from '@vzn/vx-migrate'`,
        `    ${factory}(),`,
        `${factory}(): ${why}, so vx shares that remote cache (token: the variable, else the OS keychain).`,
      ],
    ]
    const cloud = [
      0,
      [
        'nx.json connects Nx Cloud, whose cache vx cannot share: runs cache on this machine (nxCache() serves a self-hosted Nx cache).',
      ],
    ]
    expect(rows).toEqual({
      'turbo.json remoteCache': shares('turboCache', 'turbo.json names a remoteCache'),
      'workflow TURBO_TOKEN': shares('turboCache', '.github/workflows/ci.yml sets TURBO_TOKEN'),
      'nx gitlab': shares('nxCache', '.gitlab-ci.yml sets NX_SELF_HOSTED_REMOTE_CACHE_SERVER'),
      disabled: [0, []],
      'turbo link': shares('turboCache', '.turbo/config.json links a team (turbo link)'),
      'an empty link': [0, []],
      'linked, disabled': [0, []],
      'nx with a Turbo token': [0, []],
      'nx cloud': cloud,
      'nx cloud, legacy runner': cloud,
      'nx, an empty cloud id': [0, []],
      'a comment naming TURBO_TOKEN': [0, []],
      'disabled, with a CI token': [0, []],
    })
  }, 60_000)

  it('a kept workspace file of its own shape that lacks the cache plugin is told to add it', async () => {
    const root = await makeScriptsWorkspace()
    try {
      await Bun.write(path.join(root, 'turbo.json'), '{ "remoteCache": {} }\n')
      const mine =
        "import { turbo } from '@vzn/vx-migrate'\nexport default {\n  plugins: [turbo()],\n}\n"
      await Bun.write(path.join(root, '.vx/workspace.mjs'), mine)
      const r = await vx(root, ['init', '--keep'])
      const said = r.out.split('\n')
      expect(said.filter((l) => /^ {2}kept|^ {12}turbo\.json names/.test(l))).toEqual([
        '  kept      .vx/workspace.mjs (declares turbo())',
        '            turbo.json names a remoteCache: add turboCache() from @vzn/vx-migrate to its plugins and vx shares that remote cache.',
      ])
      expect(await Bun.file(path.join(root, '.vx/workspace.mjs')).text()).toBe(mine)
      // The one-line file vx writes gains it, and says so.
      const line =
        "import { turbo } from '@vzn/vx-migrate'\nexport default { plugins: [turbo()] }\n"
      await Bun.write(path.join(root, '.vx/workspace.mjs'), line)
      const gained = await vx(root, ['init', '--keep'])
      expect([row(gained.out, 'config'), row(gained.out, 'note')[1]]).toEqual([
        ['declared turboCache(), vxHistory() in .vx/workspace.mjs'],
        'turboCache(): turbo.json names a remoteCache, so vx shares that remote cache (token: the variable, else the OS keychain).',
      ])
      expect(await Bun.file(path.join(root, '.vx/workspace.mjs')).text()).toContain(
        '    turboCache(),\n',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an existing workspace file is kept, named, or replaced under --force', async () => {
    const root = await makeScriptsWorkspace()
    try {
      await Bun.write(path.join(root, 'turbo.json'), '{}\n')
      const mine = 'export default { plugins: [] }\n'
      await Bun.write(path.join(root, '.vx/workspace.mjs'), mine)
      const refused = await vx(root, ['init', '--keep'])
      expect(refused.code).toBe(1)
      expect(refused.err).toBe(
        'vx-migrate: .vx/workspace.mjs exists; add turbo() from @vzn/vx-migrate to its plugins, or --force replaces it\n',
      )
      expect(await Bun.file(path.join(root, '.vx/workspace.mjs')).text()).toBe(mine)
      const forced = await vx(root, ['init', '--keep', '--force'])
      expect(forced.code).toBe(0)
      expect(existsSync(path.join(root, '.vx/workspace.mjs'))).toBe(false)
      expect(await Bun.file(path.join(root, '.vx/workspace.ts')).text()).toContain('turbo()')
      // Declared already: nothing to write, and the next step still said.
      const again = await vx(root, ['init', '--keep'])
      expect(again.code).toBe(0)
      expect(again.out).toContain('  kept      .vx/workspace.ts (declares turbo())\n')
      expect(again.out).toContain(
        '  next      npm install -D @vzn/vx-migrate && vx lock && vx run build --all',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a second vx init after the native migration says it is set up, exit 0', async () => {
    // It spawned vx-migrate, which refused to overwrite its own configs, exit 1.
    const root = await makeScriptsWorkspace()
    try {
      await Bun.write(path.join(root, 'turbo.json'), '{ "tasks": { "build": {} } }\n')
      await Bun.write(path.join(root, '.vx/workspace.mjs'), 'export default {}\n')
      await Bun.write(path.join(root, 'packages', 'app', 'vx.config.mjs'), 'export default {}\n')
      expect(await vx(root, ['init'])).toEqual({
        code: 0,
        out: ui.render(
          [
            ui.report(`vx-migrate ${VERSION}`, [
              ['kept', ".vx/workspace.mjs and the projects' vx.config files"],
              ['note', 'vx is already set up here; --force regenerates them from turbo.json'],
              null,
              ['next', 'vx run build --all'],
            ]),
          ],
          { enabled: false },
        ),
        err: '',
      })
      // Control: a workspace that runs the repo through turbo() is no native setup.
      await Bun.write(
        path.join(root, '.vx/workspace.mjs'),
        "import { turbo } from '@vzn/vx-migrate'\nexport default { plugins: [turbo()] }\n",
      )
      // It goes on to vx-migrate, which refuses here (or, sandboxed, cannot fetch).
      const control = await vx(root, ['init'])
      expect(control.out).not.toContain('already set up')
      expect(control.code).not.toBe(0)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it("the next step installs with the repo's own package manager, what is missing only", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-next-'))
    const ua = process.env['npm_config_user_agent']
    try {
      await writeFile(path.join(root, 'nx.json'), '{ "targetDefaults": { "compile": {} } }')
      const rows: string[] = []
      delete process.env['npm_config_user_agent']
      rows.push(adoptionNext(root, 'nx', 'nx.json'))
      for (const [lock, agent] of [
        ['package-lock.json', 'npm/10'],
        ['bun.lock', 'bun/1.4'],
        ['yarn.lock', 'yarn/1'],
        ['yarn.lock', 'yarn/4'],
        ['pnpm-lock.yaml', 'pnpm/10'],
      ]) {
        // Yarn 1's lockfile, then Berry's: the first refuses `add` at a
        // workspace root without `-W`, the second has no such flag.
        const body =
          agent === 'yarn/1'
            ? '# yarn lockfile v1\n'
            : agent === 'yarn/4'
              ? '__metadata:\n  version: 8\n'
              : ''
        await writeFile(path.join(root, lock!), body)
        process.env['npm_config_user_agent'] = agent
        rows.push(adoptionNext(root, 'nx', 'nx.json'))
      }
      await mkdir(path.join(root, 'node_modules', '@vzn', 'vx-migrate'), { recursive: true })
      await writeFile(path.join(root, 'node_modules', '@vzn', 'vx-migrate', 'package.json'), '{}')
      rows.push(adoptionNext(root, 'nx', 'nx.json'))
      // A released vx pins what it names to its own version.
      rows.push(adoptionNext(root, 'nx', 'nx.json', undefined, '0.0.633'))
      const all = '@vzn/vx @vzn/vx-migrate'
      expect(rows).toEqual([
        `npm install -D ${all} && vx lock && vx run compile --all`,
        `npm install -D ${all} && vx lock && vx run compile --all`,
        // The first lockfile in pnpm, yarn, bun, npm order names the manager.
        `bun add -d ${all} && vx lock && vx run compile --all`,
        `yarn add -D -W ${all} && vx lock && vx run compile --all`,
        `yarn add -D ${all} && vx lock && vx run compile --all`,
        `pnpm add -D ${all} && vx lock && vx run compile --all`,
        'pnpm add -D @vzn/vx && vx lock && vx run compile --all',
        'pnpm add -D @vzn/vx@0.0.633 && vx lock && vx run compile --all',
      ])
    } finally {
      if (ua === undefined) delete process.env['npm_config_user_agent']
      else process.env['npm_config_user_agent'] = ua
      await rm(root, { recursive: true, force: true })
    }
  })

  it('the next step runs a task name, never an Nx executor or a Turbo package task', async () => {
    // nx.json `targetDefaults` keys may name an executor (nx-recipes'
    // angular-monorepo: "@angular/build:application"), and the next line
    // said `vx run @angular/build:application --all`, which no project
    // declares (Growth's real-repo runs, 2026-10-16).
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-next-task-'))
    const ua = process.env['npm_config_user_agent']
    delete process.env['npm_config_user_agent']
    try {
      for (const p of ['vx', 'vx-migrate']) {
        await mkdir(path.join(root, 'node_modules', '@vzn', p), { recursive: true })
        await writeFile(path.join(root, 'node_modules', '@vzn', p, 'package.json'), '{}')
      }
      const next = async (file: string, json: unknown, runner: 'nx' | 'turbo') => {
        await writeFile(path.join(root, file), JSON.stringify(json))
        return adoptionNext(root, runner, file)
      }
      expect([
        await next('nx.json', { targetDefaults: { '@angular/build:application': {} } }, 'nx'),
        await next('nx.json', { targetDefaults: { '@nx/js:tsc': {}, test: {} } }, 'nx'),
        await next('turbo.json', { tasks: { 'web#lint': {}, check: {} } }, 'turbo'),
        await next('turbo.json', { tasks: { 'web#build': {}, build: {} } }, 'turbo'),
      ]).toEqual([
        'vx run build --all',
        'vx run test --all',
        'vx run check --all',
        'vx run build --all',
      ])
    } finally {
      if (ua === undefined) delete process.env['npm_config_user_agent']
      else process.env['npm_config_user_agent'] = ua
      await rm(root, { recursive: true, force: true })
    }
  })

  it('run from a package directory, it scaffolds at the WORKSPACE ROOT', async () => {
    // `init` resolves the root before it plans; run it from inside a package
    // and the workspace file still belongs at the top. Take the cwd for the
    // root instead and the scaffold lands in whatever directory the user
    // happened to be in — a second workspace nested in the first, with the
    // real one untouched and nothing said.
    const root = await makeScriptsWorkspace()
    try {
      const r = await vx(path.join(root, 'packages', 'app'), ['init'])
      expect(r.code).toBe(0)
      expect(existsSync(path.join(root, '.vx/workspace.ts'))).toBe(true)
      expect(existsSync(path.join(root, 'packages', 'app', '.vx/workspace.ts'))).toBe(false)
      // The control: it did run, and it did write the package's own config.
      expect(existsSync(path.join(root, 'packages', 'app', 'vx.config.ts'))).toBe(true)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('in a nested workspace the outer one does not list, it scaffolds the NESTED one', async () => {
    // The outer .vx/workspace.ts was taken for the root: init said "no files
    // written" and listed the outer configs, and the nested workspace the
    // user stood in stayed without one.
    // npm, Yarn and Bun own a nested root only when they list it; pnpm takes
    // the nearest pnpm-workspace.yaml, listed or not (findManifestRoot).
    const root = await makeRoot('vx-init-nested-ws-')
    await rm(path.join(root, 'pnpm-workspace.yaml'))
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'outer', private: true, workspaces: ['packages/*'] }),
    )
    await addPackage(root, 'a', { build: 'echo a' })
    await Bun.write(path.join(root, '.vx/workspace.ts'), 'export default {}\n')
    const inner = path.join(root, 'tools', 'inner')
    await mkdir(path.join(inner, 'pkgs', 'z'), { recursive: true })
    await writeFile(
      path.join(inner, 'package.json'),
      JSON.stringify({ name: 'inner', private: true, workspaces: ['pkgs/*'] }),
    )
    await writeFile(
      path.join(inner, 'pkgs', 'z', 'package.json'),
      JSON.stringify({ name: 'z', scripts: { build: 'echo z' } }),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    try {
      const r = await vx(inner, ['init'])
      expect(r.code).toBe(0)
      expect(existsSync(path.join(inner, '.vx/workspace.ts'))).toBe(true)
      expect(existsSync(path.join(inner, 'pkgs', 'z', 'vx.config.ts'))).toBe(true)
      // CONTROL: the outer workspace is untouched.
      expect(existsSync(path.join(root, 'packages', 'a', 'vx.config.ts'))).toBe(false)
      // A member of the outer workspace still resolves to the outer root.
      const m = await vx(path.join(root, 'packages', 'a'), ['init'])
      expect(m.code).toBe(0)
      expect(existsSync(path.join(root, 'packages', 'a', 'vx.config.ts'))).toBe(true)
      expect(existsSync(path.join(root, 'packages', 'a', '.vx/workspace.ts'))).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A root package.json with no `workspaces` is single-project mode, and a
  // packages/app full of scripts beside it is invisible: `vx init` said
  // "no package.json scripts" (item 248).
  const bareRoot = async (): Promise<string> => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-bare-'))
    await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'w', private: true }))
    await addPackage(root, 'app', { build: 'tsc' })
    await addPackage(root, 'lib', { test: 'vitest' })
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    return root
  }
  const HINT =
    'package.json declares no `workspaces` (and there is no pnpm-workspace.yaml), so the root is the only project and 2 package.json below it are not: packages/app, packages/lib. Add `"workspaces": ["packages/*"]` to package.json and re-run.'

  it('`vx init` on a root without `workspaces` names the packages its globs never reach', async () => {
    const root = await bareRoot()
    try {
      const r = await vx(root, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(row(r.out, 'tasks')).toEqual([`none: ${HINT}`])
      expect(r.out).not.toContain('no package.json scripts')
      expect(r.out).not.toContain('  example ')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A pnpm-workspace.yaml with settings and no `packages:` (ngrx's) is
  // where pnpm reads the globs; the hint said there was no such file.
  it('beside a pnpm-workspace.yaml with no packages, names that file', async () => {
    const root = await bareRoot()
    try {
      await writeFile(path.join(root, 'pnpm-workspace.yaml'), 'allowBuilds:\n  esbuild: true\n')
      const r = await vx(root, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(r.out).toContain(
        '  tasks     none: pnpm-workspace.yaml lists no `packages`, so the root is the only project and 2 package.json below it are not: packages/app, packages/lib. Add `packages: ["packages/*"]` to pnpm-workspace.yaml and re-run.',
      )
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // CONTROL: with the globs declared, the same tree is a workspace and init writes both configs.
  it('the same tree with `workspaces` declared is a workspace', async () => {
    const root = await bareRoot()
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ name: 'w', private: true, workspaces: ['packages/*'] }),
      )
      const r = await vx(root, ['init', '--dry'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(row(r.out, 'from')).toEqual(['package.json scripts'])
      expect(r.out).not.toContain('declares no `workspaces`')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a deleted dist is rebuilt on the next run', async () => {
    const root = await makeRoot('vx-init-rebuild-')
    await withLockfile(root)
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
  // Globs that reach no package said only "no scripts", naming nothing to
  // fix (M-42).
  it('names the workspace globs that match no package.json', async () => {
    const root = await makeRoot('vx-init-noglob-')
    try {
      const notes = async (): Promise<string[]> =>
        row((await vx(root, ['init', '--dry'])).out, 'note').filter(
          (l) => !l.startsWith('each script'),
        )
      expect(await notes()).toEqual([
        'the workspace globs ("packages/*") match no package.json: add a package under one, or fix the glob',
      ])
      // CONTROL: a member under the glob, still with no scripts.
      await addPackage(root, 'app', {})
      expect(await notes()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names the root when a single package has no name (M-54)', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-nameless-root-'))
    try {
      await writeFile(
        path.join(root, 'package.json'),
        JSON.stringify({ private: true, scripts: { build: 'tsc' } }),
      )
      const lines = (await vx(root, ['init', '--dry'])).out.split('\n')
      expect(row(lines.join('\n'), 'note').filter((l) => l.startsWith('not mapped'))).toEqual([
        'not mapped: the root — its package.json has no "name", and vx names a project by it; give it one and run `vx init` again',
      ])
      // The scripts exist: the headline said there were none (M-59).
      expect(row(lines.join('\n'), 'tasks')).toEqual(['none: no package.json script became a task'])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('names a package.json workspaces list pnpm-workspace.yaml overrides (M-51)', async () => {
    const root = await makeRoot('vx-init-bothws-')
    try {
      await addPackage(root, 'a', { build: 'true' })
      const note = async (): Promise<string[]> =>
        (await vx(root, ['init', '--dry'])).out
          .split('\n')
          .filter((l) => l.includes("package.json's `workspaces`"))
          .map((l) => l.slice(12))
      const manifest = (workspaces?: unknown) =>
        writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'fixture-root', private: true, workspaces }),
        )
      await manifest(['apps/*'])
      expect(await note()).toEqual([
        "pnpm-workspace.yaml's `packages` lists the members, as pnpm reads them; package.json's `workspaces` (\"apps/*\") is not read: if bun, npm or yarn installs this repo, copy those globs into pnpm-workspace.yaml's `packages`, or delete that key so package.json decides",
      ])
      // The object form is read too.
      await manifest({ packages: ['apps/*'] })
      expect(await note()).toHaveLength(1)
      // CONTROLS: the same list, and none at all, say nothing.
      await manifest(['packages/*'])
      expect(await note()).toEqual([])
      await manifest(undefined)
      expect(await note()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('does not call a matched but unaddressable member unmatched', async () => {
    const root = await makeRoot('vx-init-unaddr-')
    try {
      const globNote = async (): Promise<string[]> =>
        (await vx(root, ['init', '--dry'])).out
          .split('\n')
          .filter((l) => l.slice(12).startsWith('the workspace globs'))
      // CONTROL: no member at all is still named (M-42).
      expect(await globNote()).toHaveLength(1)
      // Two manifests sharing a name: both matched, both left out (M-46).
      for (const dir of ['b', 'c']) {
        await mkdir(path.join(root, 'packages', dir), { recursive: true })
        await writeFile(
          path.join(root, 'packages', dir, 'package.json'),
          JSON.stringify({ name: 'dup', scripts: { build: 'true' } }),
        )
      }
      expect(await globNote()).toEqual([])
      // A nameless manifest alone: matched, not addressable.
      await rm(path.join(root, 'packages'), { recursive: true })
      await mkdir(path.join(root, 'packages', 'a'), { recursive: true })
      await writeFile(
        path.join(root, 'packages', 'a', 'package.json'),
        JSON.stringify({ scripts: { build: 'true' } }),
      )
      expect(await globNote()).toEqual([])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('writes the workspace file, prints an example config and the next command', async () => {
    const root = await makeRoot('vx-init-empty-')
    await addPackage(root, 'app', {})
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    try {
      const r = await vx(root, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(await Bun.file(path.join(root, '.vx/workspace.ts')).exists()).toBe(true)
      // Every project gets a config, one with no task too (2026-10-14).
      expect(await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).text()).toContain(
        '  tasks: {},\n',
      )
      expect(r.out).toContain('no package.json scripts to turn into tasks')
      expect(r.out).toContain('satisfies ProjectConfig')
      expect(row(r.out, 'next')).toEqual([
        'declare a task as the example shows, then vx run build --all',
      ])
      // Idempotent: a second init neither rewrites nor refuses.
      const again = await vx(root, ['init'])
      expect(again.code).toBe(0)
      expect(row(again.out, 'kept')).toEqual(['.vx/workspace.ts'])
      // --dry on an empty workspace writes nothing and says so.
      await rm(path.join(root, '.vx/workspace.ts'))
      const dry = await vx(root, ['init', '--dry'])
      expect(dry.code).toBe(0)
      expect([row(dry.out, 'dry run'), row(dry.out, 'files')]).toEqual([
        ['nothing written'],
        ['.vx/workspace.ts'],
      ])
      expect(await Bun.file(path.join(root, '.vx/workspace.ts')).exists()).toBe(false)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx init names vx, never the runner that started it', () => {
  // Under npm the line said `npx @vzn/vx run …`, under pnpm `pnpm vx`;
  // vx owns the command (2026-10-22).
  it('in the next: line, whatever runner started it', async () => {
    const root = await makeRoot('vx-init-runner-')
    await addPackage(root, 'app', { build: 'tsc' })
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    const next = async (ua: string): Promise<string | undefined> => {
      const proc = Bun.spawn([process.execPath, '--no-install', BIN, '--dry'], {
        cwd: root,
        env: { ...process.env, npm_config_user_agent: ua },
        stdout: 'pipe',
      })
      const out = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      return out.trimEnd().split('\n').at(-1)
    }
    try {
      const lines = []
      for (const ua of ['npm/10.9.7 node/v22', 'pnpm/10.33.0 npm/? node/v22', 'yarn/1.22.22'])
        lines.push(await next(ua))
      expect(lines).toEqual(Array(3).fill('  next      vx run build --all'))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx init with no build script', () => {
  it('names no cache TODO it did not write', async () => {
    const root = await makeRoot('vx-init-nobuild-')
    await addPackage(root, 'app', { codegen: 'echo gen' })
    try {
      const r = await vx(root, ['init', '--dry'])
      expect(r.code).toBe(0)
      expect(row(r.out, 'tasks')).toEqual(['1 clean'])
      expect(r.out).toContain('so no task got a cache block\n')
      expect(r.out).not.toContain('a TODO')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})

describe('vx init (package.json scripts)', () => {
  let root: string
  beforeAll(async () => {
    root = await makeScriptsWorkspace()
    await withLockfile(root)
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  })
  afterAll(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it(
    'writes a config per package with scripts, plus the workspace file, and loads clean',
    async () => {
      const r = await vx(root, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(row(r.out, 'from')).toEqual(['package.json scripts'])
      expect(r.out).toContain('.vx/workspace.ts')
      // A package with no scripts gets a config with no task (2026-10-14).
      expect(
        await Bun.file(path.join(root, 'packages', 'silent', 'vx.config.ts')).text(),
      ).toContain('  tasks: {},\n')
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
      expect(text).toContain("import type { ProjectConfig } from '@vzn/vx/config'")
      expect(text).toContain('} satisfies ProjectConfig')
      expect(row(r.out, 'next')).toEqual(['vx run build --all'])
      expect(r.out).not.toContain('no task caches yet')
      expect(text).toContain('TODO(vx-migrate): cache: add `inputs: {')
      // Nothing depends on `dev`, so no readiness note.
      expect(text).not.toContain('TODO(vx-migrate): persistent')
      Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
      const run = await vx(root, ['run', 'build', '--all', '--dry'])
      expect(run.code).toBe(0)
      expect(run.out).toContain('app#build')
      expect(run.out).toContain('lib#build')
    },
    TIMEOUT,
  )

  it('keeps each config it finds, writes the missing ones, and names the kept (M-52)', async () => {
    // A half-adopted workspace: one config edited by hand, one gone. The
    // whole init was refused, and --force would have replaced the edit.
    const app = path.join(root, 'packages', 'app', 'vx.config.ts')
    const lib = path.join(root, 'packages', 'lib', 'vx.config.ts')
    const hand = "export default { tasks: { build: { exec: { command: 'echo mine' } } } }\n"
    await writeFile(app, hand)
    await rm(lib)
    const again = await vx(root, ['init'])
    expect({ code: again.code, err: again.err }).toEqual({ code: 0, err: '' })
    expect(await Bun.file(app).text()).toBe(hand)
    expect(await Bun.file(lib).exists()).toBe(true)
    expect([row(again.out, 'files'), row(again.out, 'kept')]).toEqual([
      ['packages/lib/vx.config.ts'],
      ['packages/app/vx.config.ts (has a vx config)'],
    ])
    // CONTROL: nothing missing, nothing written, every config named kept.
    const third = await vx(root, ['init'])
    expect(third.code).toBe(0)
    expect([row(third.out, 'files'), row(third.out, 'kept')]).toEqual([
      [],
      [
        'packages/app/vx.config.ts (has a vx config)',
        'packages/lib/vx.config.ts (has a vx config)',
      ],
    ])
    expect(await Bun.file(app).text()).toBe(hand)
    // --force still replaces, as asked.
    const forced = await vx(root, ['init', '--force'])
    expect(forced.code).toBe(0)
    expect(await Bun.file(app).text()).not.toBe(hand)
  })

  it('is also the fallback source of vx migrate when no turbo.json or nx exists', async () => {
    const r = await vx(root, ['init', '--dry'])
    expect(r.code).toBe(0)
    expect(row(r.out, 'from')).toEqual(['package.json scripts'])
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
      await withLockfile(hooked)
      const r = await vx(hooked, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      const cfg = await loadProjectConfig(path.join(hooked, 'packages', 'app', 'vx.config.ts'))
      const tasks = cfg.tasks!
      // `pretest` wraps nothing (no `test`), so it stays a task of its own;
      // `prepack` is an npm lifecycle hook and is never a task.
      expect(Object.keys(tasks).sort()).toEqual(['build', 'pack', 'pretest'])
      expect(tasks['build']!.exec?.command).toBe(
        foldScriptHooks('rimraf dist', 'tsc -b', 'cp -r assets dist/'),
      )
      expect(tasks['pack']!.exec?.command).toBe('echo pack')
      const text = await Bun.file(path.join(hooked, 'packages', 'app', 'vx.config.ts')).text()
      expect(text).toContain(
        'TODO(vx-migrate): pnpm ran `prebuild` and `postbuild` around this script',
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
        await withLockfile(del)
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
        expect(tasks['release']!.exec?.command).toBe(
          foldScriptHooks('echo pre-release', 'npm run build -- --prod', undefined),
        )
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
      expect(r.out).toContain(
        "── packages/weird/vx.config.ts ──\nimport type { ProjectConfig } from '@vzn/vx/config'\n\nexport default {\n  tasks: {},\n}",
      )
    } finally {
      await rm(odd, { recursive: true, force: true })
    }
  })

  it('a workspace with no scripts anywhere is scaffolded by init', async () => {
    const empty = await makeRoot('vx-migrate-empty-')
    try {
      await addPackage(empty, 'a', {})
      const r = await vx(empty, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(r.out).toContain('no package.json scripts to turn into tasks')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

// Item 1033: three ways `vx init` wrote a workspace the next command read
// differently from what the report said.
describe('vx init writes what the next run reads', () => {
  const roots: string[] = []
  afterAll(async () => {
    for (const r of roots) await rm(r, { recursive: true, force: true })
  })
  const fresh = async (): Promise<string> => {
    const root = await makeRoot('vx-init-1033-')
    roots.push(root)
    return root
  }

  it(
    'a hand-written .vx/workspace.mts is a workspace file: none is written beside it',
    async () => {
      const root = await fresh()
      await addPackage(root, 'a', { build: 'echo a' })
      await Bun.write(path.join(root, '.vx/workspace.mts'), 'export default { plugins: [] }\n')
      const r = await vx(root, ['init'])
      expect({ code: r.code, wrote: existsSync(path.join(root, '.vx/workspace.ts')) }).toEqual({
        code: 0,
        wrote: false,
      })
    },
    TIMEOUT,
  )

  it(
    '--force replaces a config of another extension instead of writing a second',
    async () => {
      const root = await fresh()
      const dir = await addPackage(root, 'a', { build: 'echo a' })
      await writeFile(
        path.join(dir, 'vx.config.mjs'),
        "export default { tasks: { build: { exec: { command: 'echo OLD' } } } }\n",
      )
      const r = await vx(root, ['init', '--force'])
      expect({
        code: r.code,
        mjs: existsSync(path.join(dir, 'vx.config.mjs')),
        ts: existsSync(path.join(dir, 'vx.config.ts')),
        said: row(r.out, 'replaced').includes('packages/a/vx.config.mjs'),
      }).toEqual({ code: 0, mjs: false, ts: true, said: true })
    },
    TIMEOUT,
  )

  it(
    'a script no task may be named after is left out with a TODO, and the config loads',
    async () => {
      const root = await fresh()
      const dir = await addPackage(root, 'a', {
        build: 'echo a',
        'lint#fix': 'echo fix',
        '^up': 'echo up',
        ['__proto__']: 'echo proto',
        fix: 'pnpm run lint#fix',
      })
      const r = await vx(root, ['init'])
      expect(r.code).toBe(0)
      const config = await loadProjectConfig(path.join(dir, 'vx.config.ts'))
      const text = await Bun.file(path.join(dir, 'vx.config.ts')).text()
      expect({
        tasks: Object.keys(config.tasks!).sort(),
        proto: Object.getPrototypeOf(config.tasks) === Object.prototype,
        fix: config.tasks!['fix']!.exec?.command,
        todo: text.includes(
          `TODO(vx-migrate): script "lint#fix" not migrated: its name holds '#', which separates a project from its task`,
        ),
      }).toEqual({
        tasks: ['__proto__', 'build', 'fix'],
        proto: true,
        fix: 'pnpm run lint#fix',
        todo: true,
      })
    },
    TIMEOUT,
  )
})

describe('vx init declares the lockfile plugin', () => {
  // Package edges (`^build`, --affected) come from @vzn/vx-lockfile alone,
  // so a workspace file without it has none.
  const linkLockfile = (root: string) =>
    standIn(path.join(root, 'node_modules', '@vzn', 'vx-lockfile'))
  const lockfileWorkspace = async () => {
    const root = await makeRoot('vx-init-lockfile-')
    await addPackage(root, 'app', { build: 'tsc' })
    await writeFile(path.join(root, 'pnpm-lock.yaml'), "lockfileVersion: '9.0'\n")
    return root
  }

  it(
    'writes pnpm() for a pnpm-lock.yaml, and the lock checks clean',
    async () => {
      const root = await lockfileWorkspace()
      try {
        await linkLockfile(root)
        // Listed and installed: nothing to install.
        await writeFile(
          path.join(root, 'package.json'),
          JSON.stringify({ name: 'fixture-root', devDependencies: { '@vzn/vx-lockfile': '*' } }),
        )
        const r = await vx(root, ['init'])
        expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
        expect(await Bun.file(path.join(root, '.vx/workspace.ts')).text()).toBe(
          "import type { WorkspaceConfig } from '@vzn/vx/config'\n" +
            "import { pnpm } from '@vzn/vx-lockfile'\n\n" +
            'export default { plugins: [pnpm()] } satisfies WorkspaceConfig\n',
        )
        expect(r.out).not.toContain('pnpm add')
        expect((await vx(root, ['lock', '--check'])).code).toBe(0)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'installs it with the repo’s manager when missing',
    async () => {
      const root = await lockfileWorkspace()
      const bin = await mkdtemp(path.join(os.tmpdir(), 'vx-init-pm-'))
      try {
        await standIn(path.join(bin, 'pkg'))
        // A stand-in pnpm: records its argv and installs the package.
        await writeFile(
          path.join(bin, 'pnpm'),
          `#!/bin/sh\necho "$@" > argv\ncp -R ${path.join(bin, 'pkg')} node_modules/@vzn/vx-lockfile\n`,
          { mode: 0o755 },
        )
        const proc = Bun.spawn([process.execPath, '--no-install', BIN], {
          cwd: root,
          env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [out, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited])
        expect(code).toBe(0)
        expect((await Bun.file(path.join(root, 'argv')).text()).trim()).toBe(
          `add -D -w @vzn/vx-lockfile${VERSION === '0.0.0' ? '' : `@${VERSION}`}`,
        )
        expect(row(out, 'ran')[0]).toStartWith('pnpm add -D -w @vzn/vx-lockfile')
        expect(await Bun.file(path.join(root, '.vx/workspace.ts')).text()).toContain('pnpm()')
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(bin, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a failed install is reported and the migration still writes its files',
    async () => {
      const root = await lockfileWorkspace()
      const bin = await mkdtemp(path.join(os.tmpdir(), 'vx-init-pm-fail-'))
      try {
        await writeFile(path.join(bin, 'pnpm'), '#!/bin/sh\necho registry-blocked >&2\nexit 1\n', {
          mode: 0o755,
        })
        const proc = Bun.spawn([process.execPath, '--no-install', BIN], {
          cwd: root,
          env: { ...process.env, PATH: `${bin}:${process.env['PATH']}` },
          stdout: 'pipe',
          stderr: 'pipe',
        })
        const [out, err, code] = await Promise.all([
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
          proc.exited,
        ])
        expect(code).toBe(1)
        expect(err).toContain('registry-blocked')
        expect(row(out, 'failed')[0]).toStartWith(
          'installing vx failed (pnpm add -D -w @vzn/vx-lockfile',
        )
        expect(await Bun.file(path.join(root, '.vx/workspace.ts')).text()).toContain('pnpm()')
      } finally {
        await rm(root, { recursive: true, force: true })
        await rm(bin, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'a dry run installs nothing and says what it would run',
    async () => {
      const root = await lockfileWorkspace()
      try {
        const r = await vx(root, ['init', '--dry'])
        expect(r.code).toBe(0)
        expect(row(r.out, 'install')).toEqual(['@vzn/vx-lockfile'])
        expect(existsSync(path.join(root, 'node_modules', '@vzn', 'vx-lockfile'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    '--keep declares yarn() beside turbo() and installs it in next:',
    async () => {
      const root = await makeScriptsWorkspace()
      try {
        await Bun.write(path.join(root, 'turbo.json'), '{ "tasks": { "build": {} } }\n')
        await Bun.write(path.join(root, 'yarn.lock'), '__metadata:\n  version: 8\n')
        const r = await vx(root, ['init', '--keep'])
        expect(r.code).toBe(0)
        expect(await Bun.file(path.join(root, '.vx/workspace.ts')).text()).toBe(
          "import type { WorkspaceConfig } from '@vzn/vx/config'\n" +
            "import { turbo } from '@vzn/vx-migrate'\n" +
            "import { yarn } from '@vzn/vx-lockfile'\n" +
            "import { vxHistory } from '@vzn/vx-history'\n\n" +
            'export default {\n  plugins: [\n    turbo(),\n    yarn(),\n    vxHistory(),\n  ],\n} satisfies WorkspaceConfig\n',
        )
        // Installed with yarn (a stand-in that installs nothing), so `next:` installs them.
        expect(row(r.out, 'next')[0]).toStartWith(
          'yarn add -D @vzn/vx-migrate @vzn/vx-lockfile @vzn/vx-history && vx lock',
        )
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )

  it(
    'CONTROL: a workspace file already here is left as it is',
    async () => {
      const root = await lockfileWorkspace()
      try {
        await mkdir(path.join(root, '.vx'))
        await writeFile(path.join(root, '.vx/workspace.ts'), 'export default { plugins: [] }\n')
        const r = await vx(root, ['init'])
        expect(r.code).toBe(0)
        expect(await Bun.file(path.join(root, '.vx/workspace.ts')).text()).toBe(
          'export default { plugins: [] }\n',
        )
        expect(r.out).not.toContain('vx-lockfile')
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
