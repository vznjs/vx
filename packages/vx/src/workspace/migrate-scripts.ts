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
    /^(?:(?:npm run|(pnpm|pn|yarn|bun)(?: (run))?) ([^\s&|;<>()$`'"\\]+)|npm (test|start))$/.exec(
      command.trim(),
    )
  if (m === null) return null
  if (m[4] !== undefined) return m[4]
  const [, alias, run, name] = m
  // `pn` is pnpm's own short name (pnpm 11; pnpm/pnpm's scripts run it).
  const manager = alias === 'pn' ? 'pnpm' : alias
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
function runsScriptHooks(dir: string, memo: Map<string, Owner>): string | null {
  const { manager, at } = ownerOf(dir, memo)
  const read = (f: string): string | undefined => {
    try {
      return readFileSync(path.join(at, f), 'utf8')
    } catch {
      return undefined
    }
  }
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
  return runs ? manager : null
}

/** The package manager that owns a directory, and the directory that says so. */
interface Owner {
  manager: string
  at: string
}

/**
 * The nearest `packageManager` field or lockfile from `dir` up: `berry` for
 * Yarn 2+, `yarn` for Yarn 1, else the manager's name; none found is npm.
 */
function ownerOf(dir: string, memo: Map<string, Owner>): Owner {
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
    // A manager vx knows nothing of (zod's `nub@0.8.3`) says nothing about
    // hooks: the lockfile beside it does, and "nub ran `postbuild`" was a
    // claim nothing had checked (D-96).
    if (typeof pm === 'string' && /^(npm|pnpm|yarn|bun)@/.test(pm))
      manager = /^yarn@([2-9]|\d{2,})/.test(pm) ? 'berry' : pm.split('@')[0]
  } catch {}
  if (manager === undefined) {
    const yarnLock = read('yarn.lock')
    if (yarnLock !== undefined) manager = yarnLock.includes('\n__metadata:') ? 'berry' : 'yarn'
    else if (existsSync(path.join(dir, 'pnpm-lock.yaml'))) manager = 'pnpm'
    else if (existsSync(path.join(dir, 'package-lock.json'))) manager = 'npm'
    else if (['bun.lock', 'bun.lockb'].some((f) => existsSync(path.join(dir, f)))) manager = 'bun'
  }
  const up = path.dirname(dir)
  const owner =
    manager !== undefined
      ? { manager, at: dir }
      : up === dir
        ? { manager: 'npm', at: dir }
        : ownerOf(up, memo)
  memo.set(dir, owner)
  return owner
}

/**
 * Yarn 2+ runs a script in its own shell, where `run <script>` is `yarn
 * run <script>`; vx's shell has no `run`, and 23 of berry's scripts
 * (`run build:zip:worker`, `run test:unit packages/…`) mapped to tasks
 * that failed "command not found" (D-92). Spelled out, at the head of
 * each `&&` / `||` / `;` / `|` segment.
 */
function berryRun(command: string): string {
  return command.replace(/(^|&&|\|\||[;|(])(\s*)run(?=\s)/g, '$1$2yarn run')
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

/** A server run alone (`serve website`, `http-server`), or a tool's own server verb. */
const SERVERS = new Set(['serve', 'http-server', 'live-server', 'sirv', 'webpack-dev-server'])
const SERVER_TOOLS = new Set([
  'vite',
  'next',
  'astro',
  'nuxt',
  'nuxi',
  'remix',
  'react-router',
  'docusaurus',
  'storybook',
  'netlify',
  'wrangler',
  'webpack',
  'expo',
  'react-native',
])
const SERVER_VERBS = new Set(['dev', 'serve', 'start', 'preview'])
const LAUNCHERS = new Set(['cross-env', 'npx', 'bunx', 'exec', 'dlx'])

/**
 * A command that runs a server (D-91): docusaurus's `serve website` and
 * `netlify dev` mapped as one-shot tasks, so a dependent waited forever and
 * a server that exits on stdin EOF ended at once. Read per `&&` segment,
 * past env assignments and launchers; a quoted string is another tool's
 * argument (`start-server-and-test 'vite preview' …` exits).
 */
function servesCommand(command: string): boolean {
  for (const segment of foreground(command.replace(/"[^"]*"|'[^']*'/g, ' '))) {
    const words = segment
      .trim()
      .split(/\s+/)
      .filter((w) => w !== '')
    let i = 0
    while (
      i < words.length &&
      (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!) ||
        LAUNCHERS.has(words[i]!) ||
        words[i]!.startsWith('-') ||
        (/^(pnpm|npm|yarn)$/.test(words[i]!) && LAUNCHERS.has(words[i + 1] ?? '')))
    ) {
      // A launcher's `--package <name>` / `-p <name>` names what to install,
      // not the program: docusaurus's `pnpm dlx --package netlify-cli netlify
      // dev` read `netlify-cli` as the program (D-112).
      i += words[i] === '--package' || words[i] === '-p' ? 2 : 1
    }
    const [program, verb] = [words[i], words[i + 1]]
    if (program === undefined) continue
    if (SERVERS.has(program)) return true
    if (SERVER_TOOLS.has(program) && verb !== undefined && SERVER_VERBS.has(verb)) return true
    if (program === 'vite' && (verb === undefined || verb.startsWith('-'))) return true
  }
  return false
}

/**
 * Whether script `name` never exits: by name, as a watcher, as a server, or
 * running such a script of its own package by name (docusaurus's
 * `start:baseUrl`: `cross-env BASE_URL=… pnpm start`) or through a runner.
 */
function isPersistent(
  name: string,
  scripts: Readonly<Record<string, unknown>>,
  seen: Set<string> = new Set(),
): boolean {
  const own = scripts[name]
  if (typeof own !== 'string' || seen.has(name)) return false
  seen.add(name)
  if (PERSISTENT_TASK_NAMES.has(name) || isWatcher(name, own) || servesCommand(own)) return true
  // Through a runner too: `concurrently "npm:web" "npm:api"` and `run-p web
  // api` over two servers mapped as one-shot tasks (D-113).
  const text = Object.entries(scripts).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  )
  return foreground(own).some((segment) =>
    scriptRefs(segment, text).some((ref) => isPersistent(ref, scripts, seen)),
  )
}

/** The `&&` / `;` / `|` segments of a command, less those it backgrounds with a single `&`. */
function foreground(command: string): string[] {
  return command
    .split(/&&|\|\||[;|()]/)
    .flatMap((part) => part.split('&').slice(-1))
    .filter((segment) => segment.trim() !== '')
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
  /(^|[\s;&|(])(turbo|nx|lerna|ultra|wireit|nps|moon|rush|vx)(\s|$)|\bworkspaces?\s+(foreach|run)\b|\byarn\s+workspace\s|\bvp\s+run\s/

/** A workspace flag, read only where a package manager takes it (`pmRunsMembers`). */
const MEMBER_FLAG =
  /^(-r|--recursive|--filter|-F|--workspaces|-ws|--workspace|-w|-C|--dir|--cwd|--prefix|--if-present|--parallel|--stream)(=|$)/

/**
 * The workspace flags are a package manager's: on the program it runs they
 * mean something else, and berry's `bench` (`yarn node -r ./setup.ts …`,
 * node's `--require`) was left out as running the members (D-81). With no
 * manager named, `node <bin> run` is one (npm/cli's own npm), and not
 * `docker run -w` (D-83).
 */
function pmRunsMembers(script: string): boolean {
  for (const segment of script.split(/&&|\|\||[;|()]/)) {
    const words = segment.trim().split(/\s+/)
    let i = words.findIndex((w) => /^(pnpm|pn|npm|yarn|bun)$/.test(w))
    // npm/cli runs itself: `node . run test --workspaces`.
    if (i < 0) i = words.findIndex((w, j) => w === 'run' && words[j - 2] === 'node')
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

const CD = /(?:^|[\s;&|(])cd\s+("[^"]*"|'[^']*'|[^\s;&|()]+)/g

/**
 * A `cd` into a member's directory, or one holding members, runs that
 * member's work (kit's `cd packages/kit && vitest run`); bun's
 * `typecheck` (`cd test && bun run typecheck`) enters no member and was
 * left out (D-83). A target vx cannot read (`$DIR`, `~`) still counts.
 */
function cdsToMembers(script: string, rootDir: string, memberDirs: readonly string[]): boolean {
  for (const m of script.matchAll(CD)) {
    const target = m[1]!.replace(/^(["'])(.*)\1$/, '$2')
    if (/[$`~*?]/.test(target) || target === '-') return true
    const dir = path.resolve(rootDir, target)
    const inside = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep)
    if (memberDirs.some((d) => inside(d, dir) || inside(dir, d))) return true
  }
  return false
}

/**
 * The manager a root's files name, or undefined: `pnpm-workspace.yaml` is
 * pnpm's whatever the lockfile, and the npm `ownerOf` falls back to at the
 * file-system root with no lockfile anywhere is no claim.
 */
function rootManager(dir: string, memo: Map<string, Owner>): string | undefined {
  if (existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return 'pnpm'
  const owner = ownerOf(dir, memo)
  const guessed =
    owner.at === path.parse(owner.at).root && !existsSync(path.join(owner.at, 'package-lock.json'))
  return guessed ? undefined : owner.manager
}

/**
 * How the repo's own manager runs the members, for the root note: an npm
 * repo read "(`pnpm -r`, `--filter`, a runner)" (insomnia).
 */
function membersExample(manager: string | undefined): string {
  switch (manager) {
    case 'npm':
      return '`--workspaces`, `-w`'
    case 'yarn':
      return '`yarn workspaces run`, `yarn workspace`'
    case 'berry':
      return '`yarn workspaces foreach`, `yarn workspace`'
    case 'bun':
      return '`bun --filter`'
    default:
      return '`pnpm -r`, `--filter`'
  }
}

/**
 * The hooks a package's build hides in when it has no `build` script:
 * react-navigation's twelve packages build in `prepack: bob build`, their
 * root's `build` (`lerna run prepack`) runs the members and is left out,
 * and the repo mapped with no build at all.
 */
const LIFECYCLE_BUILD_HOOKS = ['prepack', 'prepublishOnly', 'prepublish', 'prepare']
const BUILDER =
  /(?:^|[\s;&|(])(?:bob build|tsc|tsup|tsdown|rollup|vite build|babel|unbuild|esbuild|webpack|microbundle|pkgroll|bunchee|preconstruct build)(?:\s|$)/

/** The workspace flags that move a package manager off the package it runs in. */
const ELSEWHERE_FLAG = /^(-r|--recursive|--filter|-F|--workspaces|-ws|--workspace)(=|$)/
const DIR_FLAG = /^(-C|--dir|--cwd|--prefix)(?:=(.*))?$/

/**
 * The part of a member's script that runs another member's work: pinia's
 * online-playground `build` is `pnpm -C ../pinia run build && vite build`,
 * and mapped verbatim it built pinia again beside pinia's own task, writing
 * the dist its siblings read. `yarn workspace <name>`, a runner, `pnpm -r`
 * / `--filter`, and a `cd` / `-C` / `--cwd` / `--prefix` whose innermost
 * member is another one count; a fixture inside the member, or the root,
 * does not.
 */
function siblingRun(script: string, dir: string, others: readonly string[]): string | undefined {
  const inside = (a: string, b: string): boolean => a === b || a.startsWith(b + path.sep)
  const intoOther = (target: string): boolean => {
    const t = path.resolve(dir, target.replace(/^(["'])(.*)\1$/, '$2'))
    if (/[$`~*?]/.test(target)) return false
    const owner = [dir, ...others]
      .filter((d) => inside(t, d))
      .sort((x, y) => y.length - x.length)[0]
    return owner !== undefined && owner !== dir
  }
  for (const segment of script.split(/&&|\|\||[;|()]/)) {
    const s = segment.trim()
    if (RUNS_MEMBERS.test(` ${s}`)) return s
    for (const m of s.matchAll(CD)) if (intoOther(m[1]!)) return s
    const words = s.split(/\s+/)
    const at = words.findIndex((w) => /^(pnpm|pn|npm|yarn|bun)$/.test(w))
    if (at < 0) continue
    for (let i = at + 1; i < words.length; i++) {
      const w = words[i]!
      if (ELSEWHERE_FLAG.test(w)) return s
      const flag = DIR_FLAG.exec(w)
      if (flag === null) continue
      const target = flag[2] ?? words[++i]
      if (target !== undefined && intoOther(target)) return s
    }
  }
  return undefined
}

/**
 * The package globs a `lerna.json` beside a lone root lists (Lerna's
 * default when it names none), or undefined: Lerna-classic repos list
 * their packages there, not in `workspaces`, and vx saw the root alone
 * (D-111).
 */
function lernaPackages(dir: string): string[] | undefined {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(path.join(dir, 'lerna.json'), 'utf8'))
  } catch {
    return undefined
  }
  const listed = (json as { packages?: unknown } | null)?.packages
  return Array.isArray(listed) && listed.every((g) => typeof g === 'string') && listed.length > 0
    ? listed
    : ['packages/*']
}

function lernaNote(globs: readonly string[]): string {
  const list = globs.map((g) => JSON.stringify(g)).join(', ')
  return `lerna.json lists the packages (${list}), but package.json declares no \`workspaces\`, so vx sees the root alone: add \`"workspaces": [${list}]\` to package.json and run \`vx init\` again`
}

/**
 * Yarn 2+ installs with Plug'n'Play unless `.yarnrc.yml` names another
 * linker: a package's bins live in `.pnp.cjs`, and a task's `json5` exited
 * 127 under vx, which runs no `yarn` in front of a command (probed on Yarn
 * 4.5).
 */
function usesPnp(dir: string): boolean {
  let rc = ''
  try {
    rc = readFileSync(path.join(dir, '.yarnrc.yml'), 'utf8')
  } catch {}
  const linker = /^nodeLinker:\s*["']?([\w-]+)/m.exec(rc)?.[1]
  return linker === undefined || linker === 'pnp'
}

const PNP_NOTE =
  "Yarn Plug'n'Play installs this repo: a package's bins live in `.pnp.cjs`, not `node_modules/.bin`, so a task's `tsc` is not found under vx — set `nodeLinker: node-modules` in `.yarnrc.yml` and run `yarn install`, or write each command as `yarn exec '<command>'`"

/** A runner of this package's scripts by name: `run-p build:*`. */
const RUNS_OWN = /(?:^|\s)(?:run-s|run-p|npm-run-all)(?:\s|$)/

/** A package manager running a script by name: `pnpm build`, `npm run x`, `bun run x`. */
const RUNS_SCRIPT =
  /(?:^|[\s;&|(])(?:pnpm|pn|npm|yarn|bun)\s+(?:run(?:-script)?\s+)?([^\s;&|()'"-][^\s;&|()'"]*)/g

/**
 * The scripts a command runs by name: a package manager's (`pnpm x`, `npm
 * run x`), `run-s` / `run-p` / `npm-run-all` (`build:*` is one segment,
 * `build:**` any), and `concurrently "npm:x"`. A root `ci: run-s build:all
 * lint` over `build:all: pnpm -r build` mapped as a root task (D-95).
 */
function scriptRefs(command: string, scripts: readonly (readonly [string, string])[]): string[] {
  const refs = [...command.matchAll(RUNS_SCRIPT)].map((m) => m[1]!)
  for (const m of command.matchAll(/["']?\b(?:npm|pnpm|yarn|bun):([^\s"']+)/g)) refs.push(m[1]!)
  for (const segment of command.split(/&&|\|\||[;|()]/)) {
    const words = segment.trim().split(/\s+/)
    const at = words.findIndex((w) => /^(run-s|run-p|npm-run-all)$/.test(w))
    if (at < 0) continue
    for (const w of words.slice(at + 1)) {
      if (w.startsWith('-')) continue
      const name = w.replace(/^(["'])(.*)\1$/, '$2')
      if (!name.includes('*')) {
        refs.push(name)
        continue
      }
      const re = new RegExp(
        `^${name
          .split(/(\*\*|\*)/)
          .map((part) =>
            part === '**'
              ? '.*'
              : part === '*'
                ? '[^:]*'
                : part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'),
          )
          .join('')}$`,
      )
      for (const [n] of scripts) if (re.test(n)) refs.push(n)
    }
  }
  return refs
}

/**
 * The scripts that run the members, directly or through another of these
 * scripts: vite's `ci-docs` (`pnpm build && pnpm docs-build`) runs each
 * member's build through the root's own `build` (`pnpm -r … run build`).
 */
function runningMembers(
  scripts: Readonly<Record<string, unknown>>,
  rootDir: string,
  memberDirs: readonly string[],
): Set<string> {
  const text = Object.entries(scripts).filter(
    (e): e is [string, string] => typeof e[1] === 'string',
  )
  const out = new Set(
    text
      .filter(
        ([, v]) =>
          RUNS_MEMBERS.test(` ${v}`) || pmRunsMembers(v) || cdsToMembers(v, rootDir, memberDirs),
      )
      .map(([n]) => n),
  )
  for (let grew = true; grew;) {
    grew = false
    for (const [n, v] of text) {
      if (out.has(n)) continue
      if (scriptRefs(v, text).some((r) => out.has(r))) {
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
  const hookMemo = new Map<string, Owner>()
  // The workspace root among members: many of its scripts run the
  // workspace (`npm run build --workspaces`, `pnpm -r build`), and a root
  // task made of one ran every member's build again under `--all`. Since
  // D-39 a hand-written root config makes the root a project, and
  // `--force` replaced it so (D-45). A lone package is its repo's project
  // and maps.
  const root = metas.length > 1 ? workspaceRootOf(metas) : undefined
  const notes: string[] = []
  const lifecycleBuilds: [string, string, string][] = []
  // Members that got no config: with nothing named they vanished from the
  // summary, and a reader could not tell skipped from forgotten.
  const idle: string[] = []
  // The rest check the whole repo (`lint: oxlint .`, `test: vitest`):
  // `vx run lint` found no project in remix, wagmi or element-plus. Such a
  // script maps onto the root, when the root has a name (vx skips a
  // nameless one's config), no config of its own, and no member declares
  // the task, so `--all` never runs one check twice.
  const outsideName =
    typeof outside?.['name'] === 'string' && outside['name'] !== '' ? outside['name'] : undefined
  // insomnia's root is named as its `packages/insomnia`: a root config made
  // it a project, and every later run was refused for the duplicate (D-129).
  const clash = outsideName === undefined ? undefined : metas.find((m) => m.name === outsideName)
  // A root with a config of its own is kept as written, and a run of `vx
  // init` after the one that mapped it keeps it like a member's (X-27).
  const rootKept = root !== undefined && root.configPath !== null
  const rootMeta: ProjectMeta | undefined =
    root !== undefined
      ? rootKept
        ? undefined
        : root
      : outsideName !== undefined && outsideDir !== undefined && clash === undefined
        ? { name: outsideName, dir: outsideDir, packageJson: outside as never, configPath: null }
        : undefined
  const memberTasks = new Set(
    metas
      .filter((m) => m !== root)
      .flatMap((m) => Object.entries(scriptsOf(m)))
      .filter(([, v]) => typeof v === 'string' && v !== '')
      .map(([n]) => n),
  )
  // The root scripts left out, by why: jest's root `build` (every package's)
  // went unnamed beside the website's, and `vx run build --all` built the
  // website alone (D-85). A left-out script's `pre` / `post` hook goes with
  // it where the manager runs hooks: kept, it became a task of its own.
  const leftOut = (meta: ProjectMeta): { runs: string[]; shared: string[]; out: Set<string> } => {
    const scripts = scriptsOf(meta)
    const runs = runningMembers(
      scripts,
      meta.dir,
      metas.filter((m) => m !== root).map((m) => m.dir),
    )
    const hooks = runsScriptHooks(meta.dir, hookMemo) !== null
    const hookOf = (n: string): string | undefined => {
      const base = hooks ? /^(?:pre|post)(.+)$/.exec(n)?.[1] : undefined
      return base !== undefined && typeof scripts[base] === 'string' ? base : undefined
    }
    // A hook rides in its script's command, so it is judged with it.
    const named = Object.keys(scripts).filter(
      (n) => typeof scripts[n] === 'string' && !LIFECYCLE.test(n) && hookOf(n) === undefined,
    )
    const left = {
      runs: named.filter((n) => runs.has(n)),
      shared: named.filter((n) => memberTasks.has(n) && !runs.has(n)),
    }
    const outNames = new Set([...left.runs, ...left.shared])
    const out = new Set(
      Object.keys(scripts).filter((n) => outNames.has(n) || outNames.has(hookOf(n) ?? '')),
    )
    return { ...left, out }
  }
  const rootScripts = (meta: ProjectMeta): Record<string, unknown> => {
    const scripts = scriptsOf(meta)
    const { out } = leftOut(meta)
    return Object.fromEntries(
      Object.entries(scripts).filter(([n, v]) => typeof v === 'string' && !out.has(n)),
    )
  }
  const mapsOf = (meta: ProjectMeta | undefined): number =>
    meta === undefined ? 0 : Object.keys(rootScripts(meta)).filter((n) => !LIFECYCLE.test(n)).length
  const rootMapped = mapsOf(rootMeta)
  const listed = (names: readonly string[]): string =>
    names.slice(0, 8).join(', ') + (names.length > 8 ? ` and ${names.length - 8} more` : '')
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
  // Why a root mapped nothing: `eslint .` beside a member's `lint` runs
  // nothing of the workspace, and the note said it did.
  const rootLeftOut = (): string => {
    const judged = rootKept ? root : rootMeta
    if (judged === undefined) return 'run the workspace'
    const scripts = scriptsOf(judged)
    const named = Object.keys(scripts).filter(
      (n) => typeof scripts[n] === 'string' && scripts[n] !== '' && !LIFECYCLE.test(n),
    )
    const runs = runningMembers(
      scripts,
      judged.dir,
      metas.filter((m) => m !== root).map((m) => m.dir),
    )
    const shared = named.filter((n) => memberTasks.has(n) && !runs.has(n))
    if (shared.length === 0) return 'run the workspace'
    const list = `${shared.slice(0, 8).join(', ')}${shared.length > 8 ? ', …' : ''}`
    return `${shared.length < named.length ? 'run the workspace or ' : ''}share a member's task name (${list})`
  }
  const rootName =
    root?.name ??
    (outsideRuns
      ? typeof outside?.['name'] === 'string' && outside['name'] !== ''
        ? outside['name']
        : 'package.json'
      : undefined)
  if (rootName !== undefined && rootMapped > 0) {
    const { runs, shared } = leftOut(rootMeta!)
    notes.push(
      `${rootName} (the workspace root): its scripts that check the whole repo are its tasks` +
        (runs.length > 0
          ? `; left out as running the members (${membersExample(rootMeta && rootManager(rootMeta.dir, hookMemo))}, a runner): ${listed(runs)}`
          : '') +
        (shared.length > 0
          ? `; left out as a member's task name, so \`--all\` never runs one twice: ${listed(shared)} — one that does other work maps by hand under a name of its own`
          : ''),
    )
  } else if (clash !== undefined && outsideDir !== undefined && unnamedMaps().length > 0) {
    const would = unnamedMaps()
    notes.push(
      `${clash.name} (the workspace root) not mapped: ${path.relative(outsideDir, clash.dir).split(path.sep).join('/')} has the same "name", and vx names a project by it; rename the root's and run \`vx init\` again to map ${would.length} of its scripts (${would.slice(0, 8).join(', ')}${would.length > 8 ? ', …' : ''})`,
    )
  } else if (rootName === 'package.json' && outsideDir !== undefined && unnamedMaps().length > 0) {
    // react's nameless root: "its scripts run the workspace" was not why,
    // and 30 of its scripts (`build`, `lint`, `test`) map once it has a
    // name (D-87).
    const would = unnamedMaps()
    notes.push(
      `package.json (the workspace root) not mapped: it has no "name", and vx names a project by it; give it one and run \`vx init\` again to map ${would.length} of its scripts (${would.slice(0, 8).join(', ')}${would.length > 8 ? ', …' : ''})`,
    )
  } else if (rootName !== undefined && !(rootKept && mapsOf(root) > 0)) {
    // A nameless root's vx.config is skipped (vx names projects by their
    // manifest's name), so the hand-written one needs a name first (vuejs/core).
    notes.push(
      `${rootName} (the workspace root) not mapped: its scripts ${rootLeftOut()}; declare its own tasks in its vx.config by hand` +
        (rootName === 'package.json' ? ', after giving its package.json a "name"' : ''),
    )
  }
  const mapped = metas.filter((m) => m !== root)
  if (rootMeta !== undefined && rootMapped > 0) mapped.push(rootMeta)
  for (const meta of mapped) {
    const scripts = meta === rootMeta ? rootScripts(meta) : scriptsOf(meta)
    const hooksBy = runsScriptHooks(meta.dir, hookMemo)
    const runsHooks = hooksBy !== null
    const berry = ownerOf(meta.dir, hookMemo).manager === 'berry'
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
    if (meta !== rootMeta && !('build' in scripts)) {
      const hook = LIFECYCLE_BUILD_HOOKS.find(
        (h) => typeof scripts[h] === 'string' && BUILDER.test(scripts[h] as string),
      )
      if (hook !== undefined) lifecycleBuilds.push([meta.name, hook, scripts[hook] as string])
    }
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
    const text = Object.entries(scripts).filter(
      (e): e is [string, string] => typeof e[1] === 'string',
    )
    for (const name of names) {
      if (!isTask(name)) continue

      const todos: string[] = []
      const own = berry ? berryRun(scripts[name] as string) : (scripts[name] as string)
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
      const sibling =
        meta === rootMeta
          ? undefined
          : siblingRun(
              own,
              meta.dir,
              metas.filter((m) => m !== root && m !== meta).map((m) => m.dir),
            )
      if (sibling !== undefined) {
        todos.push(
          `\`${sibling}\` runs another member's work outside the graph, again beside that member's own task: name that task under dependsOn (\`<member>#<task>\`) and drop it from the command`,
        )
      }
      // A chain of this package's own scripts (`check: pnpm run build &&
      // pnpm run lint`) ran each again inside the command, beside the task
      // of that name: `vx run check` built twice. The chain's order may
      // matter, so it is named rather than turned into a group.
      // Through `run-s` / `run-p` / `npm-run-all` too (`build: run-p
      // build:*`), each segment naming every task it runs (M-48). A
      // persistent one has PERSISTENT_TODO.
      const persistent = isPersistent(name, scripts)
      let ranTasks = 0
      const ownRuns = own
        .split(/&&|\|\||;/)
        .map((part) => part.trim())
        .filter((part) => {
          const d = delegatedScript(part)
          if (d !== null) {
            if (d === name || !isTask(d)) return false
            ranTasks++
            return true
          }
          if (persistent || !RUNS_OWN.test(part)) return false
          const refs = new Set(scriptRefs(part, text).filter((r) => r !== name && isTask(r)))
          ranTasks += refs.size
          return refs.size > 0
        })
      if (ownRuns.length > 0) {
        const list = ownRuns.map((r) => `\`${r}\``).join(', ')
        todos.push(
          `${list} ${ownRuns.length === 1 ? 'runs' : 'run'} this package's own ${
            ranTasks === 1
              ? 'task again inside the command, beside that task: name it'
              : 'tasks again inside the command, beside those tasks: name them'
          } under dependsOn and drop ${ownRuns.length === 1 ? 'it' : 'them'} from the command`,
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
      if (persistent) {
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
  for (const meta of mapped) {
    if (meta === rootMeta || projects.some((p) => p.dir === meta.dir)) continue
    const scripts = scriptsOf(meta)
    const runs = Object.keys(scripts).some(
      (n) => typeof scripts[n] === 'string' && scripts[n] !== '' && !LIFECYCLE.test(n),
    )
    if (!runs && !lifecycleBuilds.some(([name]) => name === meta.name)) idle.push(meta.name)
  }
  if (idle.length > 0 && projects.length > 0) {
    notes.push(
      `${idle.length === 1 ? '1 package got' : `${idle.length} packages got`} no vx.config.ts, having no script to run (none, or only the package manager's lifecycle hooks): ${listed(idle)}; each is still a project, and a task declared in its own vx.config.ts runs`,
    )
  }
  const owner = metas[0] === undefined ? undefined : ownerOf(metas[0].dir, hookMemo)
  if (owner?.manager === 'berry' && usesPnp(owner.at)) notes.push(PNP_NOTE)

  if (lifecycleBuilds.length > 0) {
    const [name, hook, command] = lifecycleBuilds[0]!
    const more = lifecycleBuilds.length - 1
    notes.push(
      `${lifecycleBuilds.length === 1 ? 'a package builds' : `${lifecycleBuilds.length} packages build`} only in a lifecycle script (\`${hook}: ${command}\` in ${name}${more > 0 ? ` and ${more} more` : ''}), which the package manager runs on pack or install and vx never runs: add a \`build\` script running it and run \`vx init\` again`,
    )
  }
  const lerna = metas.length === 1 ? lernaPackages(metas[0]!.dir) : undefined
  if (lerna !== undefined) notes.push(lernaNote(lerna))
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
