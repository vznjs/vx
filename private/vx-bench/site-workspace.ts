// The site's workspace (shape.ts) as every runner reads it: written by
// compare.ts for the site and by pr-bench.ts for the per-PR check, so both
// time the same tree.
import { realpathSync } from 'node:fs'
import { mkdir, symlink, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { benchEnv } from './bench-env.js'
import {
  DEPENDS_ON,
  RUN_TASKS,
  SOURCE_FILES,
  command,
  source,
  workspace,
  type Project,
  type TaskName,
} from './shape.js'

const modules = path.join(import.meta.dir, 'node_modules')

/** Every runner's environment, as CI runs them: Nx's daemon off, telemetry and cloud off. */
export const RUNNER_ENV = benchEnv({
  NO_COLOR: '1',
  CI: '1',
  TURBO_TELEMETRY_DISABLED: '1',
  DO_NOT_TRACK: '1',
  NX_CLOUD: 'false',
  // The workspace has no .env file; Nx still reads up to ten candidates
  // per task (2.7 s of a 25 s warm run at 9,603 tasks, 2026-10-12).
  NX_LOAD_DOT_ENV_FILES: 'false',
})

export type Rival = 'turbo' | 'nx' | 'vite-task'

/** A rival's run in `dir`, and how its cache is emptied: a command, then paths removed. */
export interface RivalRun {
  run: string[]
  clear: { command?: string[]; paths: string[] }
}

/** Each rival's run of the site's tasks at `concurrency`, from the workspace's linked bins. */
export function rivalRuns(dir: string, concurrency: number): Record<Rival, RivalRun> {
  const bin = (t: string) => path.join(dir, 'node_modules', '.bin', t)
  return {
    turbo: {
      run: [bin('turbo'), 'run', ...RUN_TASKS, `--concurrency=${concurrency}`],
      clear: {
        command: [bin('turbo'), 'daemon', 'stop'],
        paths: ['.turbo', 'node_modules/.cache/turbo'],
      },
    },
    nx: {
      run: [bin('nx'), 'run-many', '-t', ...RUN_TASKS, `--parallel=${concurrency}`],
      clear: { command: [bin('nx'), 'reset'], paths: [] },
    },
    'vite-task': {
      // Flags before the task name: after it they are the task's arguments,
      // and the run fell back to the default limit of 4.
      run: [bin('vp'), 'run', '-r', '--concurrency-limit', String(concurrency), 'vp-all'],
      clear: { paths: ['node_modules/.vite/task-cache'] },
    },
  }
}
const PROJECTS = workspace()

function git(args: string[], cwd: string): void {
  const r = Bun.spawnSync(['git', ...args], {
    cwd,
    env: benchEnv(),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  if (r.exitCode !== 0) throw new Error(`git ${args.join(' ')} failed:\n${r.stderr.toString()}`)
}

const VP: Record<TaskName, string> = {
  installDeps: 'vp-install',
  build: 'vp-build',
  lint: 'vp-lint',
  test: 'vp-test',
  publish: 'vp-publish',
  typecheck: 'vp-typecheck',
}

/**
 * The site workspace in `dir`: every runner's config over shape.ts, at
 * `concurrency`. `projects`, when given, must name every dependency it holds.
 */
export async function generate(
  dir: string,
  concurrency: number,
  projects: readonly Project[] = PROJECTS,
): Promise<void> {
  const json = (p: string, obj: unknown) =>
    writeFile(path.join(dir, p), JSON.stringify(obj, null, 2) + '\n')

  await mkdir(path.join(dir, 'packages'), { recursive: true })
  await writeFile(
    path.join(dir, '.gitignore'),
    [
      'node_modules',
      'dist',
      '.vx',
      '.turbo',
      '.nx',
      '.vx-runner',
      '*.tsbuildinfo',
      'vx-timings.json',
    ].join('\n') + '\n',
  )
  await json('package.json', {
    name: 'bench-root',
    version: '0.0.0',
    private: true,
    packageManager: 'bun@1.4.2',
    workspaces: ['packages/*'],
  })
  await writeFile(path.join(dir, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')
  // vx as a user tunes it for CI (2026-10-09: "config is part of
  // the experience"): the history plugin orders by the critical path a
  // timings file carries, as CI caches it between runners. The file holds
  // each task's own duration, what an earlier run would record: the untimed
  // seed run that recorded it cost a cold build (2 min 20 s). It sits
  // outside .vx, so a cache wipe keeps it.
  // edges.ts stands in for the lockfile plugin: the workspace is never installed.
  const history = path.join(modules, '@vzn', 'vx-history', 'src', 'index.ts')
  const edges = path.join(import.meta.dir, 'edges.ts')
  const timings: Record<string, number> = {}
  for (const p of projects)
    for (const [t, ms] of Object.entries(p.tasks))
      if (t !== 'installDeps') timings[`${p.name}#${t}`] = ms
  await json('vx-timings.json', {
    version: 1,
    tasks: Object.fromEntries(Object.entries(timings).sort(([a], [b]) => a.localeCompare(b))),
  })
  await Bun.write(
    path.join(dir, '.vx/workspace.mjs'),
    `import { vxHistory } from ${JSON.stringify(history)}\n` +
      `import { benchEdges } from ${JSON.stringify(edges)}\n` +
      `export default { plugins: [vxHistory({ file: 'vx-timings.json' }), benchEdges()] }\n`,
  )
  const turboTask = (t: TaskName) => ({
    dependsOn: [...DEPENDS_ON[t]],
    inputs: t === 'installDeps' ? [] : ['src/**'],
    outputs: t === 'build' ? ['dist/**'] : [],
  })
  await json('turbo.json', {
    $schema: 'https://turborepo.com/schema.json',
    tasks: Object.fromEntries(
      (Object.keys(DEPENDS_ON) as TaskName[]).map((t) => [t, turboTask(t)]),
    ),
  })
  await json('nx.json', {
    $schema: './node_modules/nx/schemas/nx-schema.json',
    parallel: concurrency,
    // `src` with `^src`: Nx does not fold a dependency's change into a
    // task's hash on its own, so an edit reaches the dependents only through
    // the `^` input (vx and Turborepo fold upstream keys).
    namedInputs: {
      default: ['{projectRoot}/**/*'],
      production: ['default'],
      src: ['{projectRoot}/src/**'],
    },
    analytics: false,
  })

  for (const p of projects) {
    const rel = path.join('packages', p.dir)
    const abs = path.join(dir, rel)
    await mkdir(path.join(abs, 'src'), { recursive: true })
    const tasks = Object.keys(p.tasks) as TaskName[]
    const run = tasks.filter((t) => t !== 'installDeps')
    const cmd = (t: TaskName) => command(p, t)
    await json(path.join(rel, 'package.json'), {
      name: p.name,
      version: '0.0.0',
      private: true,
      main: 'dist/index.js',
      scripts: Object.fromEntries(run.map((t) => [t, cmd(t)])),
      dependencies: Object.fromEntries(p.deps.map((d) => [d, 'workspace:*'])),
    })
    // Nx: `nx:run-commands`, the command vx runs, from Nx's own process
    // (`nx:run-script` forks a Node per task, item 735). installDeps is a
    // cached `nx:noop`: an uncached one held the warm run at 16.6 s
    // against 5.9 s cached.
    await json(path.join(rel, 'project.json'), {
      name: p.name,
      $schema: '../../node_modules/nx/schemas/project-schema.json',
      sourceRoot: `${rel}/src`,
      projectType: p.kind === 'app' ? 'application' : 'library',
      targets: Object.fromEntries(
        tasks.map((t) => [
          t,
          t === 'installDeps'
            ? { executor: 'nx:noop', dependsOn: ['^build'], inputs: [], outputs: [], cache: true }
            : {
                executor: 'nx:run-commands',
                options: { command: cmd(t), cwd: '{projectRoot}' },
                dependsOn: [...DEPENDS_ON[t]],
                inputs: ['src', '^src'],
                outputs: t === 'build' ? ['{projectRoot}/dist'] : [],
                cache: true,
              },
        ]),
      ),
    })
    // Vite Task: no command-less task with a dependency of its own, so
    // `installDeps`'s ^build moves onto the tasks that wait for it. Task
    // names cannot repeat a package.json script, and `vp run` takes one
    // task, so `vp-all` (no command) gathers the rest.
    const fromDeps = { task: VP.build, from: 'dependencies' }
    // Vite Task keys a task on its inputs alone, so they name the direct
    // dependencies' outputs: each build output folds its dependencies' in,
    // so an edit reaches every dependent.
    const vpInput = [
      'src/**',
      ...p.deps.map((d) => ({
        pattern: `packages/${d.slice('@bench/'.length)}/dist/index.js`,
        base: 'workspace',
      })),
    ]
    const vpDeps = (t: TaskName): unknown[] =>
      DEPENDS_ON[t].map((s): unknown =>
        s === '^build' || s === 'installDeps' ? fromDeps : VP[s as TaskName],
      )
    await writeFile(
      path.join(abs, 'vite.config.ts'),
      `export default ${JSON.stringify(
        {
          run: {
            tasks: {
              ...Object.fromEntries(
                run.map((t) => [
                  VP[t],
                  {
                    command: cmd(t),
                    dependsOn: vpDeps(t),
                    cache: { input: vpInput, output: t === 'build' ? ['dist/**'] : [] },
                  },
                ]),
              ),
              'vp-all': { command: [], dependsOn: run.map((t) => VP[t]) },
            },
          },
        },
        null,
        2,
      )}\n`,
    )
    const vxTask = (t: TaskName): string =>
      t === 'installDeps'
        ? `    installDeps: { dependsOn: ['^build'] },`
        : `    ${t}: {
      exec: { command: ${JSON.stringify(cmd(t))} },
      dependsOn: ${JSON.stringify(DEPENDS_ON[t])},
      inputs: { files: ['src/**'] }, cache: { outputs: { files: ${t === 'build' ? "['dist/**']" : '[]'} } },
    },`
    await writeFile(
      path.join(abs, 'vx.config.ts'),
      `export default {\n  tasks: {\n${tasks.map(vxTask).join('\n')}\n  },\n}\n`,
    )
    for (let n = 0; n < SOURCE_FILES; n++)
      await writeFile(path.join(abs, 'src', `f${String(n).padStart(2, '0')}.js`), source(p.name, n))
  }
}

// git is required by vx (input hashing). Commit AFTER install so the
// lockfile is tracked and the tree is clean — the realistic scenario, and
// the one where vx's git-OID hashing does zero file reads.
export function gitInit(dir: string): void {
  git(['init', '-q'], dir)
  // No background gc or maintenance: 38k loose objects start one after the
  // commit, which packed them away under a copy of the tree being taken.
  git(['config', 'gc.auto', '0'], dir)
  git(['config', 'maintenance.auto', 'false'], dir)
  git(['add', '-A'], dir)
  git(
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=b@b.b',
      '-c',
      'user.name=b',
      'commit',
      '-qm',
      'init',
    ],
    dir,
  )
}

// The rivals at this package's pins (package.json), linked in rather than
// installed: a run needs no registry, and its key sees the versions through
// the lockfile. node_modules itself is a directory of the workspace, so the
// caches a tool keeps there (Vite Task's) stay in it.
const RIVALS: Record<string, string> = { turbo: 'turbo', nx: 'nx', 'vite-plus': 'vp' }
export async function linkRivals(dir: string): Promise<void> {
  await mkdir(path.join(dir, 'node_modules', '.bin'), { recursive: true })
  for (const [pkg, binName] of Object.entries(RIVALS)) {
    await symlink(realpathSync(path.join(modules, pkg)), path.join(dir, 'node_modules', pkg))
    await symlink(
      realpathSync(path.join(modules, '.bin', binName)),
      path.join(dir, 'node_modules', '.bin', binName),
    )
  }
}
