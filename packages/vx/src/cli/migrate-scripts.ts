// package.json scripts → vx tasks: the source for a workspace that comes
// from nowhere (no turbo.json, no nx). `vx init` is this mapper.
//
// Scripts carry a command and nothing else, so the mapping is honest about
// what it cannot know: every task gets `exec.command` verbatim; `build`
// gets the conventional `dependsOn: ['^build']` and `test` / `lint` /
// `typecheck` wait for `build` when the package has one; a dev-server
// shaped script becomes persistent. Caching is opt-in and needs declared
// inputs AND outputs, which a script cannot tell us — so NO task gets a
// cache block; `build` carries a TODO showing the block to add. Until
// 2026-09-04 `build` was emitted with whole-project inputs and EMPTY
// outputs "to fill in": that is not an uncached task but a no-output one —
// it hits on unchanged inputs and skips the build with nothing to restore,
// so a deleted `dist` stayed deleted under a green `up-to-date` run
// (reproduced on the init walkthrough). A block that guessed `dist/**`
// would restore the wrong tree for every package that writes somewhere
// else, and a wrong restore is the worst failure vx has.
//
// Two npm conventions are mapped rather than copied, because copying them
// loses behaviour: `pre<x>` / `post<x>` hooks, which npm runs around `x`
// without being named, are folded into `x`'s command in that order (a
// standalone `prebuild` task is one `vx run build` never runs — and the
// hook is usually `rimraf dist`); and a script that is nothing but
// `<pm> run <other>` becomes a GROUP over `<other>`, so the graph sees the
// dependency instead of a package-manager subprocess it cannot cache.

import type { ProjectMeta } from '../workspace/index.js'
import type { GeneratedProject, GeneratedTask, MigrationPlan } from './migrate.js'

const PERSISTENT = new Set(['dev', 'start', 'serve', 'watch', 'preview'])
const AFTER_BUILD = new Set(['test', 'lint', 'typecheck', 'check', 'e2e'])
const LIFECYCLE = /^(pre|post)(install|publish|pack|version)$|^(prepare|prepublishOnly|install)$/

/**
 * The script a command delegates to when it is NOTHING but a package-manager
 * invocation of another script: `npm run x`, `pnpm x`, `yarn run x`, `bun run
 * x`, plus npm's bare `npm test` / `npm start`. Flags, arguments or a chain
 * make it a real command again, which is left verbatim.
 */
export function delegatedScript(command: string): string | null {
  const m =
    /^(?:(?:npm run|pnpm(?: run)?|yarn(?: run)?|bun(?: run)?) ([^\s&|;<>()$`'"\\]+)|npm (test|start))$/.exec(
      command.trim(),
    )
  return m === null ? null : (m[1] ?? m[2])!
}

function scriptsOf(meta: ProjectMeta): Record<string, unknown> {
  // package.json is a boundary: `scripts` is whatever the file holds. A
  // string or an array would enumerate its indices as script names.
  const raw = (meta.packageJson as unknown as { scripts?: unknown }).scripts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
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
    const has = (n: string): boolean => names.includes(n)
    const tasks: GeneratedTask[] = []
    for (const name of names) {
      // Lifecycle hooks are npm's, not tasks anyone runs by name.
      if (LIFECYCLE.test(name)) continue
      // A hook of a script that exists rides inside that script's command.
      const hookOf = /^(pre|post)(.+)$/.exec(name)
      if (hookOf !== null && has(hookOf[2]!) && !LIFECYCLE.test(hookOf[2]!)) continue

      const todos: string[] = []
      const own = scripts[name] as string
      const delegate = delegatedScript(own)
      // npm lifecycle hooks (`prepack`, `prepublishOnly`, …) belong to the
      // package manager and never ride inside a task — `pack` stays alone.
      const hook = (h: string): boolean => has(h) && !LIFECYCLE.test(h)
      const hooks = [`pre${name}`, `post${name}`].filter(hook)
      if (delegate !== null && has(delegate) && delegate !== name && hooks.length === 0) {
        // A group: no exec, the graph runs the target. `npm test` calling
        // `vitest` through `npm run test:unit` is two tasks, not a subprocess.
        const task: Record<string, unknown> = { dependsOn: [delegate] }
        if (AFTER_BUILD.has(name) && hasBuild && delegate !== 'build') {
          task['dependsOn'] = [delegate, 'build']
        }
        tasks.push({ name, todos, task })
        continue
      }

      const command = [
        ...(hook(`pre${name}`) ? [scripts[`pre${name}`] as string] : []),
        own,
        ...(hook(`post${name}`) ? [scripts[`post${name}`] as string] : []),
      ].join(' && ')
      if (hooks.length > 0) {
        todos.push(
          `npm ran ${hooks.map((h) => `\`${h}\``).join(' and ')} around this script without being asked; folded into the command in that order`,
        )
      }
      const task: Record<string, unknown> = { exec: { command } }
      if (PERSISTENT.has(name)) {
        task['exec'] = { command, persistent: {} }
        todos.push(
          'persistent: add `readyWhen: "<line the server prints when ready>"` so dependents wait for it',
        )
      }
      if (name === 'build') {
        task['dependsOn'] = ['^build']
        todos.push(
          "cache: add `cache: { inputs: { files: ['src/**'] }, outputs: { files: ['dist/**'] } }` with this package's real inputs and outputs — without it the task always runs; a block with EMPTY outputs would be a cached no-op, not an uncached task",
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
      'each script became a task with its command verbatim; caching needs declared inputs and outputs, so no task got a cache block — `build` carries a TODO showing the one to add',
    ],
    projects,
    extraFiles: [],
    notes: [],
  }
}
