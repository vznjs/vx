// package.json scripts → vx tasks: the source for a workspace that comes
// from nowhere (no turbo.json, no nx). `vx init` is this mapper.
//
// Scripts carry a command and nothing else, so the mapping is honest about
// what it cannot know: every task gets `exec.command` verbatim; `build`
// gets the conventional `dependsOn: ['^build']` and `test` / `lint` /
// `typecheck` wait for `build` when the package has one; a dev-server
// shaped script becomes persistent. Caching is opt-in and needs declared
// inputs AND outputs, which a script cannot tell us — so `build` is
// emitted with a cache block whose inputs are the whole project and whose
// outputs are EMPTY, under a TODO naming what to fill in. A cache block
// that guessed `dist/**` would restore the wrong tree for every package
// that writes somewhere else, and a wrong restore is the worst failure
// vx has.

import type { ProjectMeta } from '../workspace/index.js'
import type { GeneratedProject, GeneratedTask, MigrationPlan } from './migrate.js'

const PERSISTENT = new Set(['dev', 'start', 'serve', 'watch', 'preview'])
const AFTER_BUILD = new Set(['test', 'lint', 'typecheck', 'check', 'e2e'])

function scriptsOf(meta: ProjectMeta): Record<string, unknown> {
  return (meta.packageJson as unknown as { scripts?: Record<string, unknown> }).scripts ?? {}
}

export function migrateScripts(metas: readonly ProjectMeta[]): MigrationPlan {
  const projects: GeneratedProject[] = []
  for (const meta of metas) {
    const scripts = scriptsOf(meta)
    const names = Object.keys(scripts).filter(
      (n) => typeof scripts[n] === 'string' && scripts[n] !== '',
    )
    if (names.length === 0) continue
    const hasBuild = names.includes('build')
    const tasks: GeneratedTask[] = []
    for (const name of names) {
      // Lifecycle hooks are npm's, not tasks anyone runs by name.
      if (
        /^(pre|post)(install|publish|pack|version)$|^(prepare|prepublishOnly|install)$/.test(name)
      )
        continue
      const command = scripts[name] as string
      const todos: string[] = []
      const task: Record<string, unknown> = { exec: { command } }
      if (PERSISTENT.has(name)) {
        task['exec'] = { command, persistent: {} }
        todos.push(
          'persistent: add `readyWhen: "<line the server prints when ready>"` so dependents wait for it',
        )
      }
      if (name === 'build') {
        task['dependsOn'] = ['^build']
        task['cache'] = { inputs: { files: ['**/*'] }, outputs: { files: [] } }
        todos.push(
          "cache: inputs default to the whole project ('**/*'); narrow them (e.g. 'src/**') and declare outputs (e.g. 'dist/**') — nothing is cached until outputs are declared",
        )
      } else if (AFTER_BUILD.has(name) && hasBuild) {
        task['dependsOn'] = ['build']
      }
      tasks.push({ name, todos, task })
    }
    if (tasks.length > 0) projects.push({ name: meta.name, dir: meta.dir, importLines: [], tasks })
  }
  return {
    headerNotes: [
      'each script became a task with its command verbatim; caching needs declared inputs and outputs, so only `build` got a cache block, with empty outputs to fill in',
    ],
    projects,
    extraFiles: [],
    notes: [],
  }
}
