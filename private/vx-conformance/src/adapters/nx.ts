// Nx: a project.json per project, each task an `nx:run-commands` target.
// Nx folds a dependency's change into a task only through a `^` input:
// each `^task` in dependsOn adds the dependency's own inputs for that task.
import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Adapter } from '../adapter.ts'
import { projectDir } from '../spec.ts'

/** A project-relative glob as Nx spells it; a `!` stays in front. */
function rooted(glob: string): string {
  return glob.startsWith('!') ? `!{projectRoot}/${glob.slice(1)}` : `{projectRoot}/${glob}`
}

/** `lib#build` is Nx's `{ projects: ['lib'], target: 'build' }`; `^build` and `build` read alike. */
function dependsOn(d: string): string | { projects: string[]; target: string } {
  const at = d.indexOf('#')
  return at === -1 ? d : { projects: [d.slice(0, at)], target: d.slice(at + 1) }
}

export const nx: Adapter = {
  name: 'nx',
  pkg: 'nx',
  bins: ['nx'],
  lacks: [],
  env: {
    NX_DAEMON: 'false',
    NX_NO_CLOUD: 'true',
    NX_SKIP_NX_CACHE: 'false',
    NX_TUI: 'false',
    NX_INTERACTIVE: 'false',
    NO_COLOR: '1',
    DO_NOT_TRACK: '1',
  },
  async configure(dir, ws, command) {
    // Each task's inputs are a named input, `<task>-inputs`, so a dependent
    // reaches the files its dependency's task keys on through `^<task>-inputs`,
    // as Nx's `^production` idiom does. A project without the task falls back
    // to all its files.
    const taskNames = new Set(Object.values(ws.projects).flatMap((p) => Object.keys(p.tasks ?? {})))
    await writeFile(
      path.join(dir, 'nx.json'),
      JSON.stringify(
        {
          namedInputs: {
            default: ['{projectRoot}/**/*'],
            ...Object.fromEntries([...taskNames].map((t) => [`${t}-inputs`, ['default']])),
          },
          useDaemonProcess: false,
          analytics: false,
        },
        null,
        2,
      ),
    )
    for (const [name, p] of Object.entries(ws.projects)) {
      const rel = projectDir(name, p)
      const tasks = Object.entries(p.tasks ?? {})
      const namedInputs = Object.fromEntries(
        tasks
          .filter(([, spec]) => spec.inputs)
          .map(([t, spec]) => [`${t}-inputs`, spec.inputs!.map(rooted)]),
      )
      const targets = Object.fromEntries(
        tasks.map(([t, spec]) => [
          t,
          {
            executor: 'nx:run-commands',
            options: { command: command(name, t), cwd: '{projectRoot}' },
            dependsOn: (spec.dependsOn ?? []).map(dependsOn),
            inputs: [
              spec.inputs ? `${t}-inputs` : 'default',
              ...(spec.dependsOn ?? []).filter((d) => d.startsWith('^')).map((d) => `${d}-inputs`),
              ...(spec.env ?? []).map((e) => ({ env: e })),
            ],
            outputs: (spec.outputs ?? []).map(rooted),
            cache: spec.cache !== false,
          },
        ]),
      )
      await writeFile(
        path.join(dir, rel, 'project.json'),
        JSON.stringify({ name, root: rel, namedInputs, targets }, null, 2),
      )
    }
    return []
  },
  run: (task, projects) => [
    'node_modules/.bin/nx',
    'run-many',
    '-t',
    task,
    ...(projects ? ['-p', projects.join(',')] : []),
    '--outputStyle=stream',
  ],
  affected: (task, base) => [
    'node_modules/.bin/nx',
    'affected',
    '-t',
    task,
    `--base=${base}`,
    '--outputStyle=stream',
  ],
}
