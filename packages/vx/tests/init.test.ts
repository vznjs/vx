// `vx init`: package.json scripts → one vx.config.ts per package, the
// workspace file, and the pointer to @vzn/vx-migrate when a Turbo or Nx
// config sits beside the scripts unread. The Turbo and Nx migrations
// themselves are tested in packages/vx-migrate.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { parseInitArgs } from '../src/cli/init.js'
import { adoptionNext } from '../src/cli/init.js'
import { PLUGIN_TEMPLATES } from '../src/cli/plugin-templates.js'
import {
  delegatedScript,
  loadProjectConfig,
  migrateScripts,
  PERSISTENT_TODO,
} from '../src/workspace/index.js'
import { vxInvocation } from '../src/workspace/migration.js'

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
    'a root outside the members maps its repo-wide scripts, and runs them',
    async () => {
      const root = await makeRoot('vx-init-root-')
      const note =
        "fixture-root (the workspace root): its scripts that check the whole repo are its tasks; those that run the members (`pnpm -r`, `--filter`, a runner) or share a member's task name are left out"
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
        expect(r.out.split('\n')).toContain(note)
        Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
        const lint = await vx(root, ['run', 'lint', '--all'])
        expect(lint.code).toBe(0)
        expect(await Bun.file(path.join(root, 'lint.out')).text()).toBe('linted\n')
        const build = await vx(root, ['run', 'build', '--all', '--dry=json'])
        expect(JSON.parse(build.out).tasks.map((t: { id: string }) => t.id)).toEqual(['a#build'])
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

describe('vx init with nothing to start from', () => {
  it('names the next step when no package.json is here or above (E-37)', async () => {
    // Directly under the temp dir: no parent of it holds a package.json.
    const empty = await mkdtemp(path.join(os.tmpdir(), 'vx-init-none-'))
    try {
      const r = await vx(empty, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({
        code: 1,
        err: 'vx init: no package.json here or in any parent directory; create one (`bun init` or `npm init -y`) and run vx init again\n',
      })
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })
})

describe('parseInitArgs', () => {
  it('defaults', () => {
    expect(parseInitArgs([])).toEqual({ dry: false, force: false, mjs: false })
  })
  it('--mjs', () => {
    expect(parseInitArgs(['--mjs']).mjs).toBe(true)
    expect(parseInitArgs([]).mjs).toBe(false)
  })
  it('--dry and --force', () => {
    expect(parseInitArgs(['--dry', '--force'])).toEqual({ dry: true, force: true, mjs: false })
  })
  it('unknown flag errors', () => {
    expect(parseInitArgs(['--nope']).error).toContain('--nope')
  })
  it('positionals error', () => {
    expect(parseInitArgs(['turbo']).error).toContain('turbo')
  })

  // One argv shape per refusal, each named for the branch it takes. The two
  // rows above use `toContain` on the argument itself, which every branch
  // satisfies — `--dryrun` reads as `--dry` under a prefix match, and a
  // SHORT flag falls to the positional message under a `--` test, both
  // without changing what the error mentions. What separates them is WHICH
  // refusal, so that is what is asserted.
  it.each([
    [[], undefined, { dry: false, force: false, mjs: false }],
    [['--dry'], undefined, { dry: true, force: false, mjs: false }],
    // A near-miss of a known flag is an unknown flag, not a prefix of one.
    [['--dryrun'], 'unknown flag: --dryrun', undefined],
    [['--dry-run'], 'unknown flag: --dry-run', undefined],
    [['--forced'], 'unknown flag: --forced', undefined],
    [['--mjsx'], 'unknown flag: --mjsx', undefined],
    // A single dash is still a flag: it gets the flag message and the
    // pointer, not the positional one.
    [['-d'], 'unknown flag: -d', undefined],
    [['-'], 'unknown flag: -', undefined],
    // Only a bare word is a positional; it gets the pointer too, as
    // `vx lock` and `vx upgrade` give it.
    [['turbo.json'], 'unexpected argument: turbo.json', undefined],
  ])('%p', (argv, error, parsed) => {
    const out = parseInitArgs(argv as string[])
    if (error === undefined) {
      expect(out.error).toBeUndefined()
      expect(out).toEqual(parsed as never)
    } else {
      expect(out.error).toBeDefined()
      expect(out.error!.startsWith(error as string)).toBe(true)
      expect(out.error!.endsWith(' (see `vx init --help`)')).toBe(true)
    }
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
      "root (the workspace root): its scripts that check the whole repo are its tasks; those that run the members (`pnpm -r`, `--filter`, a runner) or share a member's task name are left out",
    ])
    // CONTROL: a hand-written root config stays as written.
    const configured = { ...rootMeta, configPath: '/w/vx.config.ts' }
    expect(migrateScripts([configured, a]).projects.map((p) => p.name)).toEqual(['a'])
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
      exec: { command: 'vx_script() {\n(echo pre\n) && (npm run b "$@"\n)\n}\nvx_script' },
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

  it('--mjs writes vx.config.mjs and vx.workspace.mjs, untyped, and they load', async () => {
    // A package whose own `tsc --build` includes every `.ts` under it
    // compiles a generated vx.config.ts into its dist (TanStack/query,
    // 2026-09-11); the same object as `.mjs` is outside that include.
    const root = await makeScriptsWorkspace()
    try {
      const r = await vx(root, ['init', '--mjs'])
      expect(r.code).toBe(0)
      expect(`${r.out}${r.err}`).toContain('vx init: package.json scripts → vx.config.mjs')
      const configPath = path.join(root, 'packages', 'app', 'vx.config.mjs')
      const generated = await Bun.file(configPath).text()
      expect(generated).not.toContain('@vzn/vx')
      expect(generated).not.toContain('satisfies')
      expect(await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).exists()).toBe(
        false,
      )
      const ws = await Bun.file(path.join(root, 'vx.workspace.mjs')).text()
      expect(ws).not.toContain('@vzn/vx')
      expect(ws).toContain('export default { plugins: [] }')
      const config = await loadProjectConfig(configPath)
      expect(Object.keys(config.tasks ?? {})).toContain('build')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a Turbo repo gets vx.workspace.ts declaring turbo() and nothing else', async () => {
    // Turbo 2.5+ reads `turbo.jsonc` as well (item 938).
    for (const file of ['turbo.json', 'turbo.jsonc']) {
      const root = await makeScriptsWorkspace()
      try {
        await Bun.write(path.join(root, file), '{ "tasks": { "compile": {} } }\n')
        const r = await vx(root, ['init'])
        expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
        expect(r.out).toBe(
          `vx init: ${file} found — turbo() from @vzn/vx-migrate runs its tasks as a start, until \`bunx @vzn/vx-migrate\` writes vx configs; nothing else written.\n` +
            'wrote vx.workspace.ts.\n\n' +
            'next: npm install -D @vzn/vx-migrate && vx run compile --all\n',
        )
        expect(await Bun.file(path.join(root, 'vx.workspace.ts')).text()).toBe(
          "import type { WorkspaceConfig } from '@vzn/vx/config'\n" +
            "import { turbo } from '@vzn/vx-migrate'\n\n" +
            'export default { plugins: [turbo()] } satisfies WorkspaceConfig\n',
        )
        expect(existsSync(path.join(root, 'packages', 'app', 'vx.config.ts'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
  })

  it('an Nx repo gets nx(); turbo.json beside nx.json gets turbo()', async () => {
    for (const [markers, runner] of [
      [['nx.json'], 'nx'],
      [['nx.json', 'turbo.json'], 'turbo'],
    ] as [string[], string][]) {
      const root = await makeScriptsWorkspace()
      try {
        for (const m of markers) await Bun.write(path.join(root, m), '{}\n')
        const r = await vx(root, ['init', '--dry'])
        expect(r.code).toBe(0)
        expect(r.out).toContain(`import { ${runner} } from '@vzn/vx-migrate'`)
        expect(r.out).toContain(`export default { plugins: [${runner}()] }`)
        expect(r.out).toContain('would write vx.workspace.ts (dry run, nothing written).')
        expect(existsSync(path.join(root, 'vx.workspace.ts'))).toBe(false)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
    // An exported graph with no nx.json is no Nx workspace nx() can claim:
    // the scripts are read, as in any repo.
    const root = await makeScriptsWorkspace()
    try {
      await Bun.write(path.join(root, '.nx', 'workspace-data', 'project-graph.json'), '{}\n')
      const r = await vx(root, ['init', '--dry'])
      expect(r.out).toContain('vx init: package.json scripts → vx.config.ts')
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
        const r = await vx(root, ['init', '--dry', '--mjs'])
        rows[label] = [r.code, r.out.split('\n').filter((l) => /import|Cache/.test(l))]
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    }
    expect(rows).toEqual({
      'turbo.json remoteCache': [
        0,
        [
          "import { turbo, turboCache } from '@vzn/vx-migrate'",
          'export default { plugins: [turbo(), turboCache()] }',
          'turboCache(): turbo.json names a remoteCache, so vx shares that remote cache (inert where the variable is unset).',
        ],
      ],
      'workflow TURBO_TOKEN': [
        0,
        [
          "import { turbo, turboCache } from '@vzn/vx-migrate'",
          'export default { plugins: [turbo(), turboCache()] }',
          'turboCache(): .github/workflows/ci.yml sets TURBO_TOKEN, so vx shares that remote cache (inert where the variable is unset).',
        ],
      ],
      'nx gitlab': [
        0,
        [
          "import { nx, nxCache } from '@vzn/vx-migrate'",
          'export default { plugins: [nx(), nxCache()] }',
          'nxCache(): .gitlab-ci.yml sets NX_SELF_HOSTED_REMOTE_CACHE_SERVER, so vx shares that remote cache (inert where the variable is unset).',
        ],
      ],
      disabled: [0, ["import { turbo } from '@vzn/vx-migrate'"]],
      'turbo link': [
        0,
        [
          "import { turbo, turboCache } from '@vzn/vx-migrate'",
          'export default { plugins: [turbo(), turboCache()] }',
          'turboCache(): .turbo/config.json links a team (turbo link), so vx shares that remote cache (inert where the variable is unset).',
        ],
      ],
      'an empty link': [0, ["import { turbo } from '@vzn/vx-migrate'"]],
      'linked, disabled': [0, ["import { turbo } from '@vzn/vx-migrate'"]],
      'nx with a Turbo token': [0, ["import { nx } from '@vzn/vx-migrate'"]],
      'nx cloud': [
        0,
        [
          "import { nx } from '@vzn/vx-migrate'",
          'nx.json connects Nx Cloud, whose cache vx cannot share: runs cache on this machine (nxCache() serves a self-hosted Nx cache).',
        ],
      ],
      'nx cloud, legacy runner': [
        0,
        [
          "import { nx } from '@vzn/vx-migrate'",
          'nx.json connects Nx Cloud, whose cache vx cannot share: runs cache on this machine (nxCache() serves a self-hosted Nx cache).',
        ],
      ],
      'nx, an empty cloud id': [0, ["import { nx } from '@vzn/vx-migrate'"]],
      'a comment naming TURBO_TOKEN': [0, ["import { turbo } from '@vzn/vx-migrate'"]],
      'disabled, with a CI token': [0, ["import { turbo } from '@vzn/vx-migrate'"]],
    })
  }, 60_000)

  it('a kept workspace file that lacks the cache plugin is told to add it', async () => {
    const root = await makeScriptsWorkspace()
    try {
      await Bun.write(path.join(root, 'turbo.json'), '{ "remoteCache": {} }\n')
      const mine =
        "import { turbo } from '@vzn/vx-migrate'\nexport default { plugins: [turbo()] }\n"
      await Bun.write(path.join(root, 'vx.workspace.mjs'), mine)
      const r = await vx(root, ['init'])
      expect(r.out.split('\n').slice(1, 3)).toEqual([
        'vx.workspace.mjs already declares turbo().',
        'turbo.json names a remoteCache: add turboCache() from @vzn/vx-migrate to its plugins and vx shares that remote cache.',
      ])
      expect(await Bun.file(path.join(root, 'vx.workspace.mjs')).text()).toBe(mine)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('an existing workspace file is kept, named, or replaced under --force', async () => {
    const root = await makeScriptsWorkspace()
    try {
      await Bun.write(path.join(root, 'turbo.json'), '{}\n')
      const mine = 'export default { plugins: [] }\n'
      await Bun.write(path.join(root, 'vx.workspace.mjs'), mine)
      const refused = await vx(root, ['init'])
      expect(refused.code).toBe(1)
      expect(refused.err).toBe(
        'vx init: vx.workspace.mjs exists; add turbo() from @vzn/vx-migrate to its plugins, or --force replaces it\n',
      )
      expect(await Bun.file(path.join(root, 'vx.workspace.mjs')).text()).toBe(mine)
      const forced = await vx(root, ['init', '--force'])
      expect(forced.code).toBe(0)
      expect(existsSync(path.join(root, 'vx.workspace.mjs'))).toBe(false)
      expect(await Bun.file(path.join(root, 'vx.workspace.ts')).text()).toContain('turbo()')
      // Declared already: nothing to write, and the next step still said.
      const again = await vx(root, ['init'])
      expect(again.code).toBe(0)
      expect(again.out).toContain('vx.workspace.ts already declares turbo().')
      expect(again.out).toContain('next: npm install -D @vzn/vx-migrate && vx run build --all')
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
      const all = '@vzn/vx @vzn/vx-migrate'
      expect(rows).toEqual([
        `npm install -D ${all} && vx run compile --all`,
        `npm install -D ${all} && npx vx run compile --all`,
        // The first lockfile in pnpm, yarn, bun, npm order names the manager.
        `bun add -d ${all} && bunx vx run compile --all`,
        `yarn add -D -W ${all} && yarn vx run compile --all`,
        `yarn add -D ${all} && yarn vx run compile --all`,
        `pnpm add -D -w ${all} && pnpm vx run compile --all`,
        'pnpm add -D -w @vzn/vx && pnpm vx run compile --all',
      ])
    } finally {
      if (ua === undefined) delete process.env['npm_config_user_agent']
      else process.env['npm_config_user_agent'] = ua
      await rm(root, { recursive: true, force: true })
    }
  })

  it('a refused flag exits 1, on stderr, writing nothing', async () => {
    // `cli run() > a bad argument to init points at its help` reads the
    // MESSAGE. The exit code and the stream are the rest of the contract and
    // were held by neither: a refusal that exits 0 is a script that carries
    // on, and one on stdout is a refusal piped into whatever reads the
    // scaffold.
    const root = await makeScriptsWorkspace()
    try {
      const r = await vx(root, ['init', '--bogus'])
      expect(r.code).toBe(1)
      expect(r.err).toContain('vx init: unknown flag: --bogus')
      expect(r.out).toBe('')
      expect(existsSync(path.join(root, 'vx.workspace.ts'))).toBe(false)
    } finally {
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
      expect(existsSync(path.join(root, 'vx.workspace.ts'))).toBe(true)
      expect(existsSync(path.join(root, 'packages', 'app', 'vx.workspace.ts'))).toBe(false)
      // The control: it did run, and it did write the package's own config.
      expect(existsSync(path.join(root, 'packages', 'app', 'vx.config.ts'))).toBe(true)
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

  it('a run in a workspace whose package globs match nothing says so, not `vx init`', async () => {
    // `vx init` would find no package to write for: the globs are the fault.
    const root = await makeRoot('vx-init-no-packages-')
    await writeFile(
      path.join(root, 'package.json'),
      JSON.stringify({ name: 'ws', private: true, workspaces: ['apps/*'] }),
    )
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    try {
      const r = await vx(root, ['run', 'build', '--all'])
      expect(r.code).not.toBe(0)
      const text = `${r.out}${r.err}`
      expect(text).toContain("No package matched the workspace's package globs")
      expect(text).not.toContain('run `vx init`')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  // A root package.json with no `workspaces` is single-project mode, and a
  // packages/app full of scripts beside it is invisible: `vx init` said
  // "no package.json scripts" and `vx run` said "run vx init" (item 248).
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
      expect(r.out).toContain(`vx init: ${HINT}`)
      expect(r.out).not.toContain('no package.json scripts')
      expect(r.out).not.toContain('Declare tasks in a')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('`vx run` there says the same, not `vx init`', async () => {
    const root = await bareRoot()
    try {
      const r = await vx(root, ['run', 'build', '--all'])
      expect(r.code).not.toBe(0)
      const text = `${r.out}${r.err}`
      expect(text).toContain(HINT)
      expect(text).not.toContain('run `vx init`')
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
      expect(r.out).toContain('package.json scripts → vx.config.ts')
      expect(r.out).not.toContain('declares no `workspaces`')
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
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    try {
      const r = await vx(root, ['init'])
      expect({ code: r.code, err: r.err }).toEqual({ code: 0, err: '' })
      expect(await Bun.file(path.join(root, 'vx.workspace.ts')).exists()).toBe(true)
      expect(await Bun.file(path.join(root, 'packages', 'app', 'vx.config.ts')).exists()).toBe(
        false,
      )
      expect(r.out).toContain('no package.json scripts to turn into tasks')
      expect(r.out).toContain('satisfies ProjectConfig')
      expect(r.out).toContain('next: declare a task as the example shows, then vx run build --all')
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

describe('vx init names the runner that started it', () => {
  it('in the next: line, with the package spec that runner resolves', async () => {
    const root = await makeRoot('vx-init-runner-')
    await addPackage(root, 'app', { build: 'tsc' })
    Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
    const next = async (): Promise<string | undefined> => {
      const proc = Bun.spawn([process.execPath, BIN, 'init', '--dry'], {
        cwd: root,
        env: { ...process.env, npm_config_user_agent: 'npm/10.9.7 node/v22.22.2 linux x64' },
        stdout: 'pipe',
      })
      const out = await new Response(proc.stdout).text()
      expect(await proc.exited).toBe(0)
      return out.trimEnd().split('\n').at(-1)
    }
    try {
      // makeRoot links @vzn/vx in; a dry init loads nothing that needs it.
      expect(await next()).toBe('next: npx vx run build --all')
      await rm(path.join(root, 'node_modules'), { recursive: true })
      expect(await next()).toBe('next: npx @vzn/vx run build --all')
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })

  it('maps each runner, installed or not, and none to a bare vx', () => {
    const rows = [
      'npm/10.9.7 node/v22',
      'pnpm/10.33.0 npm/? node/v22',
      'yarn/4.5.0 npm/? node/v22',
      'bun/1.4.2 npm/? node/v26',
      'deno/2.0',
      undefined,
    ].map((ua) => [ua?.split('/')[0], vxInvocation(ua, false), vxInvocation(ua, true)])
    expect(rows).toEqual([
      ['npm', 'npx @vzn/vx', 'npx vx'],
      ['pnpm', 'pnpm dlx @vzn/vx', 'pnpm vx'],
      ['yarn', 'yarn dlx @vzn/vx', 'yarn vx'],
      ['bun', 'bunx @vzn/vx', 'bunx vx'],
      ['deno', 'vx', 'vx'],
      [undefined, 'vx', 'vx'],
    ])
  })
})

describe('vx init with no build script', () => {
  it('names no cache TODO it did not write', async () => {
    const root = await makeRoot('vx-init-nobuild-')
    await addPackage(root, 'app', { codegen: 'echo gen' })
    try {
      const r = await vx(root, ['init', '--dry'])
      expect(r.code).toBe(0)
      expect(r.out).toContain('1 task migrated clean, 0 TODOs')
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
      expect(text).toContain("import type { ProjectConfig } from '@vzn/vx/config'")
      expect(text).toContain('} satisfies ProjectConfig')
      expect(r.out).toContain('next: vx run build --all')
      expect(r.out).toContain(
        'no task caches yet: add the cache block a TODO shows, and a second run hits',
      )
      expect(text).toContain('TODO(vx-migrate): cache: add `cache: {')
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
      expect(tasks['build']!.exec?.command).toBe(
        'vx_script() {\n(rimraf dist\n) && (tsc -b "$@"\n) && (cp -r assets dist/\n)\n}\nvx_script',
      )
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
        expect(tasks['release']!.exec?.command).toBe(
          'vx_script() {\n(echo pre-release\n) && (npm run build -- --prod "$@"\n)\n}\nvx_script',
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
    'a hand-written vx.workspace.mts is a workspace file: none is written beside it',
    async () => {
      const root = await fresh()
      await addPackage(root, 'a', { build: 'echo a' })
      await writeFile(path.join(root, 'vx.workspace.mts'), 'export default { plugins: [] }\n')
      const r = await vx(root, ['init'])
      expect({ code: r.code, wrote: existsSync(path.join(root, 'vx.workspace.ts')) }).toEqual({
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
        said: r.out.includes('replaced:\n  packages/a/vx.config.mjs'),
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

describe('vx init --plugin <seam>', () => {
  it(
    "writes the seam's plugin and its test, refuses to overwrite, and names the seams",
    async () => {
      const root = await mkdtemp(path.join(os.tmpdir(), 'vx-init-plugin-'))
      try {
        await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'ws' }))
        const ok = await vx(root, ['init', '--plugin', 'key'])
        expect([ok.code, ok.err]).toEqual([0, ''])
        expect(ok.out.split('\n')[0]).toBe('wrote plugins/key.ts and plugins/key.test.ts')
        expect(await Bun.file(path.join(root, 'plugins', 'key.ts')).text()).toBe(
          PLUGIN_TEMPLATES['key']!.plugin,
        )
        expect(await Bun.file(path.join(root, 'plugins', 'key.test.ts')).text()).toBe(
          PLUGIN_TEMPLATES['key']!.test,
        )
        const again = await vx(root, ['init', '--plugin', 'key'])
        expect([again.code, again.err]).toEqual([
          1,
          'vx init: plugins/key.ts exists; --force overwrites it\n',
        ])
        const bad = await vx(root, ['init', '--plugin', 'nope'])
        expect([bad.code, bad.err]).toEqual([
          1,
          `vx init: --plugin takes a seam: one of ${Object.keys(PLUGIN_TEMPLATES).join(', ')} (got 'nope')\n`,
        ])
        // --dry writes nothing.
        const dry = await vx(root, ['init', '--plugin=graph', '--dry'])
        expect(dry.code).toBe(0)
        expect(existsSync(path.join(root, 'plugins', 'graph.ts'))).toBe(false)
        expect(existsSync(path.join(root, 'plugins', 'key.ts'))).toBe(true)
      } finally {
        await rm(root, { recursive: true, force: true })
      }
    },
    TIMEOUT,
  )
})
