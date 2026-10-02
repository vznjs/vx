// package.json scripts → vx tasks: the source for a workspace that comes
// from nowhere (no turbo.json, no nx). `vx init` is this mapper.
//
// Scripts carry a command and nothing else, so the mapping is honest about
// what it cannot know: every task gets `exec.command` verbatim; `build`
// gets the conventional `dependsOn: ['^build']` and `test` / `typecheck`
// wait for `build` when the package has one (`lint` does not); a dev-server
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
// Where the manager runs no such hooks (Yarn 2+, D-31; npm or pnpm told
// not to, D-33) `prebuild` is a script like any other.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { taskNameProblem } from './config-schema.js'
import { buildPackageGraph } from './package-graph.js'
import type { ProjectMeta } from './workspace.js'
import {
  foldScriptHooks,
  type GeneratedProject,
  type GeneratedTask,
  type MigrationPlan,
  PERSISTENT_TASK_NAMES,
  PERSISTENT_TODO,
  cacheTodo,
  pruneOrphanPersistentNotes,
} from './migration.js'

// `lint` is not here: a linter reads sources, and an edge to `build`
// serialises the two for nothing (the init walkthrough, 2026-09-04).
const AFTER_BUILD = new Set(['test', 'typecheck', 'check', 'e2e'])
const LIFECYCLE = /^(pre|post)(install|publish|pack|version)$|^(prepare|prepublishOnly|install)$/

/**
 * The script a command delegates to when it is NOTHING but a package-manager
 * invocation of another script: `npm run x`, `pnpm x`, `yarn run x`, `bun run
 * x`, plus npm's bare `npm test` / `npm start`. Flags, arguments or a chain
 * make it a real command again, which is left verbatim.
 */
export function delegatedScript(command: string): string | null {
  const m =
    /^(?:(?:npm run|(pnpm|yarn|bun)(?: (run))?) ([^\s&|;<>()$`'"\\]+)|npm (test|start))$/.exec(
      command.trim(),
    )
  if (m === null) return null
  if (m[4] !== undefined) return m[4]
  const [, manager, run, name] = m
  // Bare, the manager's own command wins over a script of that name:
  // `bun test` is Bun's test runner and `bun build` its bundler, never the
  // `test` / `build` script, and a group over the script ran the wrong
  // thing (item 908). `pnpm test` and `yarn test` do run the script.
  if (manager !== undefined && run === undefined && OWN_COMMANDS[manager]!.has(name!)) return null
  return name!
}

/** What `<manager> <name>`, with no `run`, runs as the manager's own command. */
// Listing a name that runs the script only keeps the command verbatim, so
// each set leans wide; missing one of the manager's own made a group over
// a script the manager never runs (D-32: `pnpm docs` opened npm's docs page,
// `bun deploy` answered "reserved", `yarn check` verified dependencies).
const OWN_COMMANDS: Readonly<Record<string, ReadonlySet<string>>> = {
  // `bun --help`, Bun 1.4.2, the short aliases, and the names it reserves
  // or runs itself (probed: `bun lint` runs the script).
  bun: new Set(
    'run test x repl exec install i add a remove rm update audit dedupe prune outdated link unlink publish patch pm info why build init create c upgrade feedback list deploy config login logout whoami help'.split(
      ' ',
    ),
  ),
  // pnpm 10.33.0's `commandNames`, and the npm commands it passes through
  // to npm whatever the scripts say.
  pnpm: new Set(
    'add approve-builds audit bin c cache cat-file cat-index ci clean-install completion config create dedupe deploy dislink dlx doctor env exec fetch find-hash get i ic ignored-builds import init install install-clean install-test it la licenses link list ll ln ls m multi outdated pack patch patch-commit patch-remove prune publish rb rebuild recursive remove restart rm root run run-script self-update server set setup store un uni uninstall unlink up update upgrade why access adduser bugs deprecate dist-tag docs edit find home info issues login logout owner ping prefix profile pkg repo s se search set-script show star stars team token unpublish unstar v version view whoami xmas help'.split(
      ' ',
    ),
  ),
  // `yarn help`, Yarn 1.22.22 and Yarn 4.5.0: one set for both.
  yarn: new Set(
    'access add audit autoclean bin cache check config constraints create dedupe dlx exec explain files generate-lock-entry global help import info init install licenses link list login logout node npm outdated owner pack patch patch-commit plugin policies publish rebuild remove run search set stage tag team unlink unplug up upgrade upgrade-interactive version versions why workspace workspaces'.split(
      ' ',
    ),
  ),
}

/**
 * The package manager that owns `dir`, when it runs `pre` / `post` hooks
 * around a script; null when it runs none. The manager is the nearest `packageManager` field or
 * lockfile, and its settings are read beside it, as each reads them for a
 * member too. Probed with a `prebuild` / `build` / `postbuild` trio: Yarn
 * 2+ runs none (D-31); npm runs none under `ignore-scripts=true` in
 * `.npmrc`; pnpm runs none under `enable-pre-post-scripts=false` there or
 * `enablePrePostScripts: false` in `pnpm-workspace.yaml` (D-33); Bun and
 * Yarn 1 run them whatever those say. No manager found is npm's default.
 */
function runsScriptHooks(dir: string, memo: Map<string, string | null>): string | null {
  const known = memo.get(dir)
  if (known !== undefined) return known
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(path.join(dir, f), 'utf8')
    } catch {
      return undefined
    }
  }
  let manager: string | undefined
  try {
    const pm = (JSON.parse(read('package.json') ?? '') as { packageManager?: unknown })
      .packageManager
    if (typeof pm === 'string')
      manager = /^yarn@([2-9]|\d{2,})/.test(pm) ? 'berry' : pm.split('@')[0]
  } catch {}
  if (manager === undefined) {
    const yarnLock = read('yarn.lock')
    if (yarnLock !== undefined) manager = yarnLock.includes('\n__metadata:') ? 'berry' : 'yarn'
    else if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) manager = 'pnpm'
    else if (existsSync(path.join(dir, 'package-lock.json'))) manager = 'npm'
    else if (['bun.lock', 'bun.lockb'].some((f) => existsSync(path.join(dir, f)))) manager = 'bun'
  }
  let answer: string | null
  if (manager === undefined) {
    const up = path.dirname(dir)
    answer = up === dir ? 'npm' : runsScriptHooks(up, memo)
  } else {
    const npmrc = read('.npmrc') ?? ''
    const set = (key: string, value: string): boolean =>
      new RegExp(`^\\s*${key}\\s*=\\s*${value}\\s*$`, 'm').test(npmrc)
    const runs =
      manager === 'berry'
        ? false
        : manager === 'npm'
          ? !set('ignore-scripts', 'true')
          : manager === 'pnpm'
            ? !set('enable-pre-post-scripts', 'false') &&
              !/^enablePrePostScripts:\s*false\s*$/m.test(read('pnpm-workspace.yaml') ?? '')
            : true
    answer = runs ? manager : null
  }
  memo.set(dir, answer)
  return answer
}

const MANIFEST_IMPORT = "import pkg from './package.json' with { type: 'json' }"

/**
 * The `$npm_*` variables a command reads. Every manager sets them for a
 * script (probed: npm, pnpm, bun and yarn printed the version, the name
 * and the script's name) and vx sets none, so a migrated `echo
 * $npm_package_version` printed nothing (D-34). The name and version are
 * read from the manifest at evaluation, so a bump reaches them; the event
 * is the script's own name, which a folded hook does not share.
 */
function npmEnv(
  command: string,
  script: string,
  folded: boolean,
): { define: Record<string, unknown>; unset: string[]; readsManifest: boolean } {
  const define: Record<string, unknown> = {}
  const unset: string[] = []
  let readsManifest = false
  for (const [, v] of command.matchAll(/\$\{?(npm_[A-Za-z0-9_]+)/g)) {
    if (v! in define || unset.includes(v!)) continue
    if (v === 'npm_package_name' || v === 'npm_package_version') {
      define[v] = { raw: v === 'npm_package_name' ? 'pkg.name' : 'pkg.version' }
      readsManifest = true
    } else if (v === 'npm_lifecycle_event' && !folded) define[v] = script
    else unset.push(v!)
  }
  return { define, unset, readsManifest }
}

/**
 * A script that never exits by design (D-40): a `watch` segment in its
 * name (`build:watch`, `watch-css`), a `--watch` flag, `tsc -w` /
 * `rollup -w`, or nodemon. Run as a plain task it held its dependents
 * forever. A bare `-w` elsewhere is not read: `npm run x -w pkg` is a
 * workspace.
 */
function isWatcher(name: string, command: string): boolean {
  if (name.split(/[:\-_.]/).includes('watch')) return true
  return (
    /(?:^|\s)--watch(?:All)?(?:[=\s]|$)/.test(command) ||
    /\b(?:tsc|rollup)\b[^&|;]*\s-w(?:\s|$)/.test(command) ||
    /(?:^|[\s&|;])nodemon\b/.test(command)
  )
}

function scriptsOf(meta: ProjectMeta): Record<string, unknown> {
  // package.json is a boundary: `scripts` is whatever the file holds. A
  // string or an array would enumerate its indices as script names.
  const raw = (meta.packageJson as unknown as { scripts?: unknown }).scripts
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return {}
  return raw as Record<string, unknown>
}

/**
 * A `build` that only delegates (`build: pnpm run compile`) is a group over
 * its target, and the `^build` edge every `build` carries belongs on the
 * task that does the work: the group ran `compile` with no edge at all, so
 * a package compiled before the ones it imports had built (item 907). On
 * the group itself it would not hold — the group waits on both, `compile`
 * on neither. Followed through a chain of groups to the first command,
 * which takes the cache TODO too: a group has no command to cache, and the
 * TODO a delegating `build` never got was the one the header promised
 * (item 1045).
 */
function upstreamBuildOnWorker(tasks: GeneratedTask[]): void {
  const byName = new Map(tasks.map((t) => [t.name, t]))
  const seen = new Set<string>()
  let at = byName.get('build')
  while (at?.task !== undefined && at.task !== null && !('exec' in at.task)) {
    if (seen.has(at.name)) return
    seen.add(at.name)
    const deps = at.task['dependsOn']
    at = Array.isArray(deps) ? byName.get(String(deps[0])) : undefined
  }
  if (at === undefined || at.name === 'build' || at.task === null || at.task === undefined) return
  // The worker IS `build`'s work, and so is every group on the way to it:
  // a `typecheck` behind `build: npm run typecheck` waited for `build`,
  // and the run refused the cycle (D-16).
  for (const name of [...seen, at.name]) {
    const t = byName.get(name)!.task!
    if (name !== 'build' && Array.isArray(t['dependsOn'])) {
      t['dependsOn'] = (t['dependsOn'] as string[]).filter((d) => d !== 'build')
    }
  }
  const deps = Array.isArray(at.task['dependsOn']) ? (at.task['dependsOn'] as string[]) : []
  if (!deps.includes('^build')) at.task['dependsOn'] = ['^build', ...deps]
  const todo = cacheTodo(String((at.task['exec'] as { command?: unknown }).command))
  if (!at.todos.includes(todo)) at.todos.push(todo)
}

/**
 * A root script that runs the members rather than checking the repo:
 * pnpm's `-r` / `--filter` / `-C`, Yarn's `--cwd` (excalidraw's
 * `build:common`) and `yarn workspace <name>` (cal.com's `prisma`), npm's
 * `--prefix`, the workspace flags, Bun's `--filter`,
 * Vite+'s `vp run` (tiptap), and the other runners, vx itself included. Mapped, it ran every member's
 * task again beside the member's own (D-45).
 */
const RUNS_MEMBERS =
  /(^|[\s;&|(])(turbo|nx|lerna|ultra|wireit|nps|moon|rush|vx)(\s|$)|\bworkspaces?\s+(foreach|run)\b|\byarn\s+workspace\s|\bvp\s+run\s|\bcd\s/

/** A workspace flag, read only where a package manager takes it (`pmRunsMembers`). */
const MEMBER_FLAG =
  /^(-r|--recursive|--filter|-F|--workspaces|-ws|--workspace|-w|-C|--dir|--cwd|--prefix|--if-present|--parallel|--stream)(=|$)/

/**
 * The workspace flags are a package manager's: on the program it runs they
 * mean something else, and berry's `bench` (`yarn node -r ./setup.ts …`,
 * node's `--require`) was left out as running the members (D-81). With no
 * manager named, a `run` verb is one.
 */
function pmRunsMembers(script: string): boolean {
  for (const segment of script.split(/&&|\|\||[;|()]/)) {
    const words = segment.trim().split(/\s+/)
    let i = words.findIndex((w) => /^(pnpm|npm|yarn|bun)$/.test(w))
    // npm/cli runs itself: `node . run test --workspaces`.
    if (i < 0) i = words.indexOf('run')
    if (i < 0) continue
    // `exec`, `dlx` and `x` take the manager's flags up to the program name.
    let program = false
    for (i++; i < words.length; i++) {
      const w = words[i]!
      if (MEMBER_FLAG.test(w)) return true
      if (program && !w.startsWith('-')) break
      if (w === 'node') break
      if (w === 'exec' || w === 'dlx' || w === 'x') program = true
    }
  }
  return false
}

/** A package manager running a script by name: `pnpm build`, `npm run x`, `bun run x`. */
const RUNS_SCRIPT =
  /(?:^|[\s;&|(])(?:pnpm|npm|yarn|bun)\s+(?:run(?:-script)?\s+)?([^\s;&|()'"-][^\s;&|()'"]*)/g

/**
 * The scripts that run the members, directly or through another of these
 * scripts: vite's `ci-docs` (`pnpm build && pnpm docs-build`) runs each
 * member's build through the root's own `build` (`pnpm -r … run build`).
 */
function runningMembers(scripts: Readonly<Record<string, unknown>>): Set<string> {
  const text = Object.entries(scripts).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  )
  const out = new Set(
    text.filter(([, v]) => RUNS_MEMBERS.test(` ${v}`) || pmRunsMembers(v)).map(([n]) => n),
  )
  for (let grew = true; grew;) {
    grew = false
    for (const [n, v] of text) {
      if (out.has(n)) continue
      if ([...v.matchAll(RUNS_SCRIPT)].some((m) => out.has(m[1]!))) {
        out.add(n)
        grew = true
      }
    }
  }
  return out
}

/**
 * `outside`: the root manifest when the root is no member (pnpm's and
 * Yarn's default), whose own scripts (`lint: eslint .`) went unmapped
 * without a word; `outsideDir` is where it sits.
 */
export function migrateScripts(
  metas: readonly ProjectMeta[],
  outside?: Readonly<Record<string, unknown>>,
  outsideDir?: string,
): MigrationPlan {
  const projects: GeneratedProject[] = []
  const hookMemo = new Map<string, string | null>()
  // The workspace root among members: many of its scripts run the
  // workspace (`npm run build --workspaces`, `pnpm -r build`), and a root
  // task made of one ran every member's build again under `--all`. Since
  // D-39 a hand-written root config makes the root a project, and
  // `--force` replaced it so (D-45). A lone package is its repo's project
  // and maps.
  const root = metas.length > 1 ? workspaceRootOf(metas) : undefined
  const notes: string[] = []
  // The rest check the whole repo (`lint: oxlint .`, `test: vitest`):
  // `vx run lint` found no project in remix, wagmi or element-plus. Such a
  // script maps onto the root, when the root has a name (vx skips a
  // nameless one's config), no config of its own, and no member declares
  // the task, so `--all` never runs one check twice.
  const outsideName =
    typeof outside?.['name'] === 'string' && outside['name'] !== '' ? outside['name'] : undefined
  const rootMeta: ProjectMeta | undefined =
    root !== undefined
      ? root.configPath === null
        ? root
        : undefined
      : outsideName !== undefined && outsideDir !== undefined
        ? { name: outsideName, dir: outsideDir, packageJson: outside as never, configPath: null }
        : undefined
  const memberTasks = new Set(
    metas
      .filter((m) => m !== root)
      .flatMap((m) => Object.entries(scriptsOf(m)))
      .filter(([, v]) => typeof v === 'string' && v !== '')
      .map(([n]) => n),
  )
  const rootScripts = (meta: ProjectMeta): Record<string, unknown> => {
    const scripts = scriptsOf(meta)
    const runs = runningMembers(scripts)
    return Object.fromEntries(
      Object.entries(scripts).filter(
        ([n, v]) => typeof v === 'string' && !memberTasks.has(n) && !runs.has(n),
      ),
    )
  }
  const rootMapped =
    rootMeta === undefined
      ? 0
      : Object.keys(rootScripts(rootMeta)).filter((n) => !LIFECYCLE.test(n)).length
  const outsideScripts = outside?.['scripts']
  const outsideRuns =
    typeof outsideScripts === 'object' &&
    outsideScripts !== null &&
    Object.values(outsideScripts).some((v) => typeof v === 'string' && v !== '')
  const unnamedMaps = (): string[] => {
    const meta: ProjectMeta = {
      name: 'package.json',
      dir: outsideDir!,
      packageJson: outside as never,
      configPath: null,
    }
    const scripts = scriptsOf(meta)
    return Object.keys(rootScripts(meta)).filter((n) => {
      // A hook rides in its script's command and is no script to name.
      const base = /^(?:pre|post)(.+)$/.exec(n)?.[1]
      return !LIFECYCLE.test(n) && (base === undefined || !(base in scripts))
    })
  }
  const rootName =
    root?.name ??
    (outsideRuns
      ? typeof outside?.['name'] === 'string' && outside['name'] !== ''
        ? outside['name']
        : 'package.json'
      : undefined)
  if (rootName !== undefined && rootMapped > 0) {
    notes.push(
      `${rootName} (the workspace root): its scripts that check the whole repo are its tasks; those that run the members (\`pnpm -r\`, \`--filter\`, a runner) or share a member's task name are left out`,
    )
  } else if (rootName === 'package.json' && outsideDir !== undefined && unnamedMaps().length > 0) {
    // react's nameless root: "its scripts run the workspace" was not why,
    // and 30 of its scripts (`build`, `lint`, `test`) map once it has a
    // name (D-87).
    const would = unnamedMaps()
    notes.push(
      `package.json (the workspace root) not mapped: it has no "name", and vx names a project by it; give it one and run \`vx init\` again to map ${would.length} of its scripts (${would.slice(0, 8).join(', ')}${would.length > 8 ? ', …' : ''})`,
    )
  } else if (rootName !== undefined) {
    // A nameless root's vx.config is skipped (vx names projects by their
    // manifest's name), so the hand-written one needs a name first (vuejs/core).
    notes.push(
      `${rootName} (the workspace root) not mapped: its scripts run the workspace; declare its own tasks in its vx.config by hand` +
        (rootName === 'package.json' ? ', after giving its package.json a "name"' : ''),
    )
  }
  const mapped = metas.filter((m) => m !== root)
  if (rootMeta !== undefined && rootMapped > 0) mapped.push(rootMeta)
  for (const meta of mapped) {
    const scripts = meta === rootMeta ? rootScripts(meta) : scriptsOf(meta)
    const hooksBy = runsScriptHooks(meta.dir, hookMemo)
    const runsHooks = hooksBy !== null
    const runnable = Object.keys(scripts).filter(
      (n) => typeof scripts[n] === 'string' && scripts[n] !== '',
    )
    // A script whose name no task may carry (`lint#fix`, `^up`) was written
    // as one, and the next run refused the whole config (item 1033). It is
    // left out, with a TODO, and a script delegating to it keeps its
    // command rather than naming it as an edge.
    const refused = runnable.flatMap((n) => {
      const why = taskNameProblem(n)
      return why === null ? [] : [[n, why] as const]
    })
    const names = runnable.filter((n) => taskNameProblem(n) === null)
    if (runnable.length === 0) continue
    const hasBuild = names.includes('build')
    const has = (n: string): boolean => names.includes(n)
    // Lifecycle hooks are npm's, not tasks anyone runs by name, and a hook
    // of a script that exists rides inside that script's command.
    const isTask = (n: string): boolean => {
      if (!has(n) || LIFECYCLE.test(n)) return false
      const hookOf = runsHooks ? /^(pre|post)(.+)$/.exec(n) : null
      return hookOf === null || !has(hookOf[2]!) || LIFECYCLE.test(hookOf[2]!)
    }
    const tasks: GeneratedTask[] = []
    let readsManifest = false
    for (const name of names) {
      if (!isTask(name)) continue

      const todos: string[] = []
      const own = scripts[name] as string
      const delegate = delegatedScript(own)
      // npm lifecycle hooks (`prepack`, `prepublishOnly`, …) belong to the
      // package manager and never ride inside a task — `pack` stays alone.
      const hook = (h: string): boolean => runsHooks && has(h) && !LIFECYCLE.test(h)
      const hooks = [`pre${name}`, `post${name}`].filter(hook)
      // A group over a script that is no task (`setup: npm run prepare`)
      // named a task nothing defines, and the run `vx init` suggested
      // refused the config (D-12).
      if (delegate !== null && isTask(delegate) && delegate !== name && hooks.length === 0) {
        // A group: no exec, the graph runs the target. `npm test` calling
        // `vitest` through `npm run test:unit` is two tasks, not a subprocess.
        const task: Record<string, unknown> = { dependsOn: [delegate] }
        if (AFTER_BUILD.has(name) && hasBuild && delegate !== 'build') {
          task['dependsOn'] = [delegate, 'build']
        }
        tasks.push({ name, todos, task })
        continue
      }

      const command = foldScriptHooks(
        hook(`pre${name}`) ? (scripts[`pre${name}`] as string) : undefined,
        own,
        hook(`post${name}`) ? (scripts[`post${name}`] as string) : undefined,
      )
      if (hooks.length > 0) {
        todos.push(
          `${hooksBy} ran ${hooks.map((h) => `\`${h}\``).join(' and ')} around this script without being asked; folded into the command in that order`,
        )
      }
      const exec: Record<string, unknown> = { command }
      const npm = npmEnv(command, name, hooks.length > 0)
      if (Object.keys(npm.define).length > 0) exec['env'] = { define: npm.define }
      if (npm.readsManifest) readsManifest = true
      for (const v of npm.unset) {
        todos.push(
          `the script reads $${v}, which the package manager sets and vx does not: define it under exec.env.define or drop it`,
        )
      }
      const task: Record<string, unknown> = { exec }
      if (PERSISTENT_TASK_NAMES.has(name) || isWatcher(name, own)) {
        exec['persistent'] = {}
        todos.push(PERSISTENT_TODO)
      }
      if (name === 'build') {
        task['dependsOn'] = ['^build']
        todos.push(cacheTodo(own))
      } else if (AFTER_BUILD.has(name) && hasBuild) {
        task['dependsOn'] = ['build']
      }
      tasks.push({ name, todos, task })
    }
    for (const [name, why] of refused) {
      tasks.push({
        name,
        todos: [
          `script ${JSON.stringify(name)} not migrated: its name ${why} — rename the script, or add it by hand under another name`,
        ],
        task: null,
      })
    }
    upstreamBuildOnWorker(tasks)
    if (tasks.length > 0) {
      const importLines = readsManifest ? [MANIFEST_IMPORT] : []
      projects.push({ name: meta.name, dir: meta.dir, importLines, tasks })
    }
  }
  breakBuildCycles(projects, metas)
  pruneOrphanPersistentNotes(projects, PERSISTENT_TODO)
  return {
    headerNotes: [
      // Where to add one is the TODO's to say, when there is one: an Nx repo
      // whose only script is `codegen` read "`build` carries a TODO" over
      // "0 TODOs" (the first-five-minutes walk, 2026-09-28).
      'each script became a task with its command verbatim; caching needs declared inputs and outputs, so no task got a cache block',
    ],
    projects,
    extraFiles: [],
    notes,
  }
}

/**
 * pnpm sorts a dependency cycle away and builds anyway; vx's `^build`
 * refuses it, so the config init wrote failed its first run (nuxt:
 * `@nuxt/nitro-server` devDepends on `nuxt`, which depends on it; vitest's
 * browser packages). A package in a cycle of builds waits, instead of on
 * `^build`, on each build outside its cycle that `^build` reaches (through
 * packages with none, as core walks it), with a TODO to order the cycle.
 */
function breakBuildCycles(projects: GeneratedProject[], metas: readonly ProjectMeta[]): void {
  const builds = new Set(
    projects
      .filter((p) => p.tasks.some((t) => t.name === 'build' && t.task !== null))
      .map((p) => p.name),
  )
  if (builds.size < 2) return
  const graph = buildPackageGraph([...metas])
  const holders = new Map<string, string[]>()
  for (const name of builds) {
    const found = new Set<string>()
    const visited = new Set([name])
    const frontier = [...graph.directDeps(name)]
    while (frontier.length > 0) {
      const at = frontier.pop()!
      if (visited.has(at)) continue
      visited.add(at)
      if (builds.has(at)) found.add(at)
      else frontier.push(...graph.directDeps(at))
    }
    holders.set(name, [...found].sort())
  }
  for (const cycle of cyclesOf(holders)) {
    const members = new Set(cycle)
    for (const p of projects) {
      if (!members.has(p.name)) continue
      const at = p.tasks.find(
        (t) =>
          Array.isArray(t.task?.['dependsOn']) &&
          (t.task['dependsOn'] as string[]).includes('^build'),
      )
      if (at === undefined) continue
      const outside = holders
        .get(p.name)!
        .filter((h) => !members.has(h))
        .map((h) => `${h}#build`)
      at.task!['dependsOn'] = (at.task!['dependsOn'] as string[]).flatMap((d) =>
        d === '^build' ? outside : [d],
      )
      at.todos.push(
        `its package is in a dependency cycle (${cycle.join(', ')}), where \`^build\` would refuse the run — it waits on the builds outside the cycle; order the ones inside it by hand`,
      )
    }
  }
}

/** The strongly connected components of more than one node (Tarjan), each sorted. */
function cyclesOf(edges: ReadonlyMap<string, readonly string[]>): string[][] {
  const index = new Map<string, number>()
  const low = new Map<string, number>()
  const stack: string[] = []
  const onStack = new Set<string>()
  const out: string[][] = []
  const visit = (v: string): void => {
    index.set(v, index.size)
    low.set(v, index.get(v)!)
    stack.push(v)
    onStack.add(v)
    for (const w of edges.get(v) ?? []) {
      if (!index.has(w)) {
        visit(w)
        low.set(v, Math.min(low.get(v)!, low.get(w)!))
      } else if (onStack.has(w)) {
        low.set(v, Math.min(low.get(v)!, index.get(w)!))
      }
    }
    if (low.get(v) === index.get(v)) {
      const comp: string[] = []
      let w: string
      do {
        w = stack.pop()!
        onStack.delete(w)
        comp.push(w)
      } while (w !== v)
      if (comp.length > 1) out.push(comp.sort())
    }
  }
  for (const v of [...edges.keys()].sort()) if (!index.has(v)) visit(v)
  return out
}

/** The member whose directory holds every other member's, if one does. */
function workspaceRootOf(metas: readonly ProjectMeta[]): ProjectMeta | undefined {
  const outer = metas.reduce((a, b) => (b.dir.length < a.dir.length ? b : a))
  const prefix = outer.dir.endsWith(path.sep) ? outer.dir : outer.dir + path.sep
  return metas.every((m) => m === outer || m.dir.startsWith(prefix)) ? outer : undefined
}
