// `vx-migrate [--from turbo|nx|vite-task|scripts] [--native|--keep] [--no-install] [--dry]
// [--force] [--mjs]` — one vx.config.ts per workspace package from an
// existing Turbo or Nx setup (`--keep`: the workspace file that reads it
// live instead), from Vite Task, or from package.json scripts, and vx
// installed with the repo's manager. `vx init` hands every repo with a
// package.json here (2026-10-14: core reads no package.json).
// Without either mode flag a terminal is asked; anything else is native. Source auto-detect: turbo.json → Turbo;
// .nx/workspace-data/project-graph.json, nx.json or a Lerna-on-Nx lerna.json → Nx (the resolved
// graph, exported by nx if absent); `vite-plus` in the root package.json → Vite Task:
// vite-plus is a whole toolchain, so beside turbo.json or Nx it is not the task runner;
// else the package.json scripts.
// The mappers return a plan; core's migration seam
// (`applyMigration`) renders, guards, writes and reports.

import { existsSync, readFileSync, realpathSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import {
  applyMigration,
  findWorkspaceRoot,
  isStarterConfig,
  isUserError,
  VERSION,
  type MigrationFormat,
  type MigrationPlan,
  UserError,
  ui,
} from '@vzn/vx'
import { migrateScripts } from './migrate-scripts.js'
import type { LoadReads } from './package-fs.js'
import {
  discoverPackages,
  findManifestRoot,
  loadPackageWorkspace,
  type PackageMeta,
  type PackageWorkspace,
  reachesManifest,
  unreachedHint,
  unreachedPackages,
} from './packages.js'
import { relPosix } from './paths.js'
import { REMOTE_CACHE, remoteCacheNote } from './remote-cache.js'
import { migrateNx, NX_GRAPH_REL, nxWorkspaceFields } from './migrate-nx.js'
import { exportGraph, nxBin } from './nx/export-graph.js'
import { readNxJson } from './nx/nx-map.js'
import {
  type AdoptionMode,
  importedPackages,
  install,
  installArgv,
  listedPackages,
  listedPlugins,
  missingPackages,
  MODE_QUESTION,
  ownVersion,
  packageManagerOf,
  parseModeAnswer,
  uninstall,
} from './adopt.js'
import { migrateTurbo } from './migrate-turbo.js'
import { migrateViteTask } from './migrate-vite-task.js'
import { turboConfigFile } from './turbo/turbo-reads.js'
import { lockfilePlugin } from './workspace-notes.js'
import {
  extendWorkspaceFile,
  generatedPlugins,
  undeclared,
  renderWorkspaceFile,
  workspaceFileAt,
  workspacePlugins,
  type WorkspacePlugin,
} from './workspace-plugins.js'

export interface MigrateArgs {
  dry: boolean
  force: boolean
  /** `vx.config.mjs` (and `vx-preset.mjs`) instead of `.ts`. */
  mjs: boolean
  from?: 'turbo' | 'nx' | 'vite-task' | 'scripts'
  /** `--native` / `--keep`; unset asks a terminal and is native elsewhere. */
  mode?: AdoptionMode
  /** `--no-install`: leave package.json's dependencies alone. */
  noInstall?: boolean
  /** `--help` / `-h`: the usage on stdout, exit 0 (as `nx-env --help`). */
  help?: boolean
  /** `--format json` (with `--dry`): the plan as one JSON document (core's `schemas/init.json`). */
  json?: boolean
  error?: string
}

const USAGE =
  'usage: vx-migrate [--from turbo|nx|vite-task|scripts] [--native|--keep] [--no-install] [--dry [--format json]] [--force] [--mjs]'

export function parseMigrateArgs(args: readonly string[]): MigrateArgs {
  const out: MigrateArgs = { dry: false, force: false, mjs: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--mjs') out.mjs = true
    else if (a === '--no-install') out.noInstall = true
    else if (a === '--format' || a?.startsWith('--format=')) {
      const v = a === '--format' ? args[++i] : a.slice('--format='.length)
      if (v !== 'json' && v !== 'pretty') {
        return { ...out, error: `--format must be pretty or json (got ${v ?? 'nothing'})` }
      }
      out.json = v === 'json'
    } else if (a === '--native' || a === '--keep') {
      const mode = a === '--native' ? 'native' : 'keep'
      if (out.mode !== undefined && out.mode !== mode) {
        return { ...out, error: '--native and --keep are two answers to one question; pass one' }
      }
      out.mode = mode
    } else if (a === '--from' || a?.startsWith('--from=')) {
      const v = a === '--from' ? args[++i] : a.slice('--from='.length)
      if (v !== 'turbo' && v !== 'nx' && v !== 'vite-task' && v !== 'scripts') {
        return { ...out, error: '--from must be turbo, nx, vite-task or scripts' }
      }
      out.from = v
    } else if (a === '--help' || a === '-h') return { ...out, help: true }
    else if (a?.startsWith('-')) return { ...out, error: `unknown flag: ${a}\n${USAGE}` }
    else return { ...out, error: `unexpected argument: ${a}\n${USAGE}` }
  }
  if (out.json && !out.dry)
    return { ...out, error: '--format json prints the plan, so it needs --dry' }
  return out
}

/**
 * Core finds a root by a package manager's workspace file; a Rush repo can
 * have none. Say which tool is there and what vx needs from it.
 */
async function noRootReason(cwd: string, err: Error): Promise<Error> {
  if (await Bun.file(path.join(cwd, 'rush.json')).exists()) {
    return new UserError(
      'a Rush workspace: vx does not yet discover projects from rush.json (it finds them through package.json workspaces or pnpm-workspace.yaml)',
    )
  }
  return err
}

/** The command: detect the source, map it, hand the plan to core. Returns the exit code. */
export async function migrateCmd(args: readonly string[]): Promise<number> {
  const parsed = parseMigrateArgs(args)
  if (parsed.help) {
    ui.say('info', USAGE, 'out')
    return 0
  }
  if (parsed.error) {
    ui.say('error', `vx-migrate: ${parsed.error}`)
    return 1
  }
  const reads: LoadReads = new Map()
  // An Nx repo with no package.json (Nx pinned in `.nx/installation`):
  // nothing is installable, so its configs run on core alone.
  let bare = false
  const root = await migrationRoot(process.cwd(), reads).catch(async (err: unknown) => {
    const nx = isUserError(err) ? nxRootWithoutManifest(process.cwd()) : undefined
    if (nx === undefined) throw isUserError(err) ? await noRootReason(process.cwd(), err) : err
    bare = true
    return nx
  })
  const workspace = bare ? { root, packageGlobs: [] } : await loadPackageWorkspace(root, reads)
  const nameless: string[] = []
  // `vx init`'s starter at the root holds no task: mapped as if absent, so
  // the root's own scripts become its tasks.
  const metas = bare
    ? []
    : (await discoverPackages(workspace, nameless)).filter(
        (m) => !(m.dir === root && m.configPath !== null && isStarterConfig(m.configPath)),
      )

  const turboFile = await turboConfigFile(root)
  const hasTurbo = turboFile !== null
  const hasGraph = await Bun.file(path.join(root, NX_GRAPH_REL)).exists()
  const hasNxJson = await Bun.file(path.join(root, 'nx.json')).exists()
  // A Turbo repo's lerna.json publishes; Turbo runs its tasks.
  const lerna = !hasTurbo && !hasGraph && !hasNxJson && lernaOnNx(root)

  // Evaluating teams routinely have two runners checked in — never
  // ask anyone to delete anything; --from disambiguates.
  const found = (
    [
      ['turbo', hasTurbo, 'turbo.json'],
      ['nx', hasGraph || hasNxJson || lerna, 'an nx workspace'],
    ] as const
  ).filter(([, present]) => present)
  if (parsed.from === undefined && found.length > 1) {
    const what = found.map(([, , label]) => label)
    const listed =
      what.length === 2
        ? `both ${what[0]} and ${what[1]}`
        : `${what.slice(0, -1).join(', ')} and ${what.at(-1)}`
    throw new UserError(
      `${listed} are present — pass ${found.map(([id]) => `--from ${id}`).join(' or ')}`,
    )
  }
  if (parsed.from === 'turbo' && !hasTurbo) {
    throw new UserError('--from turbo, but no turbo.json at the workspace root')
  }

  const runner: 'turbo' | 'nx' | 'vite-task' | 'scripts' =
    parsed.from ??
    (hasTurbo
      ? 'turbo'
      : hasGraph || hasNxJson || lerna
        ? 'nx'
        : (await hasVitePlus(root))
          ? 'vite-task'
          : 'scripts')
  if (runner === 'scripts') return scripts(root, workspace, metas, nameless, parsed)
  if (runner === 'vite-task' && parsed.mode === 'keep') {
    throw new UserError(
      '--keep: no plugin runs a Vite Task config live; drop --keep to write vx.config files',
    )
  }
  const runnerFile =
    runner === 'turbo' ? path.basename(turboFile ?? 'turbo.json') : lerna ? 'lerna.json' : 'nx.json'
  // A second `vx init` after the native migration refused to overwrite
  // the configs it wrote, exit 1: the first-run walk (2026-10-09). Set up
  // is an answer, with the next step.
  const existing = workspaceFileAt(root)
  if (
    runner !== 'vite-task' &&
    existing !== undefined &&
    !parsed.force &&
    !parsed.dry &&
    parsed.mode === undefined &&
    metas.some((m) => m.configPath !== null) &&
    !readFileSync(path.join(root, existing), 'utf8').includes(`${runner}(`)
  ) {
    ui.print(
      'out',
      ui.report(`vx-migrate ${VERSION}`, [
        ['kept', `${existing} and the projects' vx.config files`],
        ['note', `vx is already set up here; --force regenerates them from ${runnerFile}`],
        null,
        ['next', adoptionNext(root, runner, runnerFile, ['@vzn/vx'])],
      ]),
    )
    return 0
  }
  if (bare && parsed.mode === 'keep') {
    throw new UserError(
      '--keep: nx() is a plugin to install, and this Nx repo has no package.json to install it in; drop --keep to write vx.config files',
    )
  }
  const mode =
    runner === 'vite-task' || bare
      ? 'native'
      : (parsed.mode ?? (await askMode(runner, lerna ? 'lerna.json' : undefined, parsed.dry)))
  if (mode === 'keep' && runner !== 'vite-task') return keep(root, runner, runnerFile, parsed)

  const format: MigrationFormat = parsed.mjs ? 'mjs' : 'ts'
  // No workspace file yet, or one vx wrote (a `--keep` adoption's): this run
  // writes it, declaring the plugins the repo calls for and the run settings
  // nx.json holds. turbo() and nx() go: the configs written here replace them.
  const existingWorkspace = workspaceFileAt(root)
  const existingFormat = /\.(ts|mjs)$/.exec(existingWorkspace ?? '')?.[1] as
    | MigrationFormat
    | undefined
  const adopted =
    existingWorkspace === undefined
      ? []
      : existingFormat === undefined
        ? null
        : generatedPlugins(readFileSync(path.join(root, existingWorkspace), 'utf8'))
  const writesWorkspace = adopted !== null
  let source: string
  let plan: MigrationPlan
  if (runner === 'vite-task') {
    source = 'vite.config run.tasks'
    plan = await migrateViteTask(root, metas, format)
  } else if (runner === 'nx') {
    if (hasGraph) {
      source = NX_GRAPH_REL
      plan = await migrateNx(root, metas, format, undefined, writesWorkspace, bare)
    } else {
      // Modern Nx stores the graph in SQLite, so the JSON snapshot exists only
      // when exported. The workspace's own nx exports it, as `nx()` does, into
      // a temp file; the user ran that step by hand until 2026-10-01.
      // A fresh clone: the export's own reason names the plugin's `graph`
      // option, which the CLI does not take.
      if (nxBin(root) === undefined) {
        throw new UserError(
          `nx is not installed here (no node_modules/.bin/nx), and vx-migrate reads the graph it exports — ` +
            `run \`${packageManagerOf(root, process.env['npm_config_user_agent'])} install\`, then vx-migrate again`,
        )
      }
      const tmp = await mkdtemp(path.join(os.tmpdir(), 'vx-migrate-nx-'))
      try {
        const snapshot = path.join(tmp, 'project-graph.json')
        const why = await exportGraph(root, snapshot)
        if (why !== null) {
          throw new UserError(
            `no resolved Nx graph found, and exporting one failed (${why}) — export it with ` +
              '`nx graph --file=.nx/workspace-data/project-graph.json`, then re-run vx-migrate',
          )
        }
        source = 'nx graph'
        plan = await migrateNx(root, metas, format, snapshot, writesWorkspace, bare)
      } finally {
        await rm(tmp, { recursive: true, force: true })
      }
    }
  } else {
    source = path.basename(turboFile ?? 'turbo.json')
    plan = await migrateTurbo(root, metas, format)
  }
  // Before the write, so the report's `next:` line runs the installed vx;
  // not when the write will be refused for a config already there.
  const configName = `vx.config.${format}`
  const refused =
    !parsed.force &&
    (plan.projects.some(
      (p) =>
        p.tasks.length > 0 &&
        (metas.some((m) => m.dir === p.dir && m.configPath) ||
          existsSync(path.join(p.dir, configName))),
    ) ||
      plan.extraFiles.some((f) => existsSync(path.join(root, f.relPath))))
  const kept = (adopted ?? []).filter((p) => !ADOPTION_PLUGINS.has(`${p.pkg}#${p.factory}`))
  const plugins =
    writesWorkspace && !bare
      ? [
          ...kept,
          ...workspacePlugins(root, runner === 'vite-task' ? undefined : runner).filter(
            (p) => !kept.some((k) => k.factory === p.factory),
          ),
        ]
      : []
  let workspaceText: string | undefined
  if (writesWorkspace) {
    const fields =
      runner === 'nx'
        ? nxWorkspaceFields((await readNxJson(root).catch(() => null))?.json).flatMap((f) =>
            f.source === undefined ? [] : [{ field: f.field, source: f.source }],
          )
        : []
    workspaceText = renderWorkspaceFile(plugins, existingFormat ?? format, fields)
    // Drop the notes that told the user to declare the lockfile plugin and
    // to remove turbo() or nx().
    plan = {
      ...plan,
      headerNotes: plan.headerNotes.filter(
        (n) => !n.includes('from @vzn/vx-lockfile') && !n.includes(' still declares '),
      ),
      extraFiles:
        existingWorkspace === undefined
          ? [...plan.extraFiles, { relPath: `.vx/workspace.${format}`, contents: workspaceText }]
          : plan.extraFiles,
    }
  }
  // An executor target is an `nx-exec` line and a `.env` one an `nx-env`
  // line: both bins are this package's, and `bunx` leaves none behind.
  const runsBins = plan.projects.some((p) =>
    p.tasks.some((t) => {
      const cmd = (t.task?.['exec'] as { command?: unknown } | undefined)?.command
      return typeof cmd === 'string' && /^nx-(exec|env) /.test(cmd)
    }),
  )
  // Nothing written imports vx-migrate or runs its bins: a `--keep`
  // adoption's install of it is dropped with turbo() / nx().
  const finalWorkspace = workspaceText ?? readFileSync(path.join(root, existingWorkspace!), 'utf8')
  // Imports parsed, not matched: a formatter's double quotes hid it, and
  // the file still imported the package removed (2026-10-16).
  const imported = importedPackages(finalWorkspace)
  const needsSelf = runsBins || imported.includes('@vzn/vx-migrate')
  const cacheNote =
    runner === 'vite-task'
      ? undefined
      : remoteCacheNote(root, runner, finalWorkspace.includes(`${REMOTE_CACHE[runner]}(`))
  const steps: Step[] =
    refused || bare
      ? []
      : [
          ...(existingWorkspace !== undefined && workspaceText !== undefined
            ? await rewriteWorkspace(root, existingWorkspace, workspaceText, adopted!, parsed.dry)
            : []),
          ...(await prepareRepo(
            root,
            [
              ...new Set([
                '@vzn/vx',
                ...(needsSelf ? ['@vzn/vx-migrate'] : []),
                ...plugins.map((p) => p.pkg),
                ...imported,
              ]),
            ],
            parsed,
            needsSelf ? [] : ['@vzn/vx-migrate'],
          )),
        ]
  const code = await applyMigration({
    root,
    metas,
    plan,
    source,
    verb: 'vx-migrate',
    steps,
    notes: refused || bare || cacheNote === undefined ? [] : [cacheNote],
    dry: parsed.dry,
    json: parsed.json === true,
    force: parsed.force,
    format,
    // The written workspace file imports plugins `--no-install` left out.
    ...(parsed.noInstall === true ? {} : { lock: lockWorkspace }),
  })
  return exitAfter(code, steps)
}

/**
 * Core's `vx lock`, run where the configs were written: the step `vx init`
 * ends with, through the core this repo resolves.
 */
async function lockWorkspace(root: string): Promise<{ code: number; said: string }> {
  const p = Bun.spawn([process.execPath, '--no-install', coreBin(root), 'lock'], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  // A success's warnings print above the report; a refusal is said whole.
  // A success is a report row, matched as text: the colour FORCE_COLOR
  // gave the child would hide its `✓ vx lock` mark from that match.
  if (code === 0) process.stderr.write(err)
  return { code, said: code === 0 ? Bun.stripANSI(out) : out + err }
}

/** A report row: what the tool did, e.g. `['ran', 'bun add -d …']`. */
type Step = readonly [label: string, value: string]

/** The `vx` entry of the core this repo resolves. */
function coreBin(root: string): string {
  // A resolve that misses from a directory with no node_modules is an
  // auto-install under Bun: ask the root only where it has the package.
  const installed = path.join(root, 'node_modules', '@vzn', 'vx')
  const core = existsSync(path.join(installed, 'package.json'))
    ? path.join(realpathSync(installed), 'src', 'index.ts')
    : Bun.resolveSync('@vzn/vx', import.meta.dir)
  return path.join(path.dirname(core), 'bin.ts')
}

/** vite-plus (`vp run`) in the root package.json's dependencies. */
async function hasVitePlus(root: string): Promise<boolean> {
  const pkg = (await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => ({}))) as Record<string, unknown>
  return ['dependencies', 'devDependencies'].some((f) => {
    const deps = pkg[f]
    return typeof deps === 'object' && deps !== null && Object.hasOwn(deps, 'vite-plus')
  })
}

/** A terminal is asked which adoption it wants; anything else gets native. */
async function askMode(
  runner: 'turbo' | 'nx',
  file: string | undefined,
  dry: boolean,
): Promise<AdoptionMode> {
  if (dry || !process.stdin.isTTY || !process.stdout.isTTY) return 'native'
  const source = file ?? (runner === 'turbo' ? 'turbo.json' : 'nx.json')
  for (;;) {
    const mode = parseModeAnswer(prompt(MODE_QUESTION(runner, source)))
    if (mode !== undefined) return mode
  }
}

const ADOPTION_PLUGINS = new Set(['@vzn/vx-migrate#turbo', '@vzn/vx-migrate#nx'])

/**
 * A `--keep` adoption's workspace file, written over for a native one.
 * Returns the report's row; writes nothing under `--dry`.
 */
async function rewriteWorkspace(
  root: string,
  file: string,
  text: string,
  before: readonly WorkspacePlugin[],
  dry: boolean,
): Promise<Step[]> {
  if (readFileSync(path.join(root, file), 'utf8') === text) return []
  const dropped = before.filter((p) => ADOPTION_PLUGINS.has(`${p.pkg}#${p.factory}`))
  const names = dropped.map((p) => `${p.factory}()`).join(', ')
  if (dry)
    return [['config', `would ${dropped.length > 0 ? `drop ${names} from` : 'rewrite'} ${file}`]]
  await Bun.write(path.join(root, file), text)
  return [['config', `${dropped.length > 0 ? `dropped ${names} from` : 'rewrote'} ${file}`]]
}

/**
 * Install what the written files import and remove what they no longer
 * do. Returns the report's rows; changes nothing under `--dry`.
 */
async function prepareRepo(
  root: string,
  wanted: readonly string[],
  args: MigrateArgs,
  unwanted: readonly string[] = [],
): Promise<Step[]> {
  if (args.noInstall === true) return []
  const steps: Step[] = []
  const version = ownVersion()
  const all = [...new Set([...wanted, ...listedPlugins(root).filter((p) => !unwanted.includes(p))])]
  const missing = missingPackages(root, all, version)
  if (missing.length > 0) {
    steps.push(
      args.dry ? ['install', missing.join(' ')] : await ran(() => install(root, missing, version)),
    )
  }
  // Last: the package removed may be the one running this.
  const listed = listedPackages(root, unwanted)
  if (listed.length > 0) {
    steps.push(args.dry ? ['remove', listed.join(' ')] : await ran(() => uninstall(root, listed)))
  }
  return steps
}

/**
 * A manager step's row. Its failure is a `failed` row, not the end of the
 * migration: the configs are still written and the report names what to
 * re-run, where a throw left a repo with neither.
 */
async function ran(step: () => Promise<string>): Promise<Step> {
  try {
    return ['ran', await step()]
  } catch (e) {
    if (!isUserError(e)) throw e
    return ['failed', e.message]
  }
}

/** The exit a migration ends with: 1 when a manager step failed, whatever the rest did. */
function exitAfter(code: number, steps: readonly Step[]): number {
  return code === 0 && steps.some(([label]) => label === 'failed') ? 1 : code
}

/**
 * `--keep`: `.vx/workspace.ts` declaring `turbo()` or `nx()`, so the
 * runner's own config stays the source, beside the plugins the repo calls
 * for (its remote cache among them), and the one command from here to a
 * run. A workspace file already here is kept when it declares the runner.
 */
async function keep(
  root: string,
  runner: 'turbo' | 'nx',
  source: string,
  args: MigrateArgs,
): Promise<number> {
  const format: MigrationFormat = args.mjs ? 'mjs' : 'ts'
  const name = `.vx/workspace.${format}`
  const all = [{ pkg: '@vzn/vx-migrate', factory: runner }, ...workspacePlugins(root, runner)]
  const existing = workspaceFileAt(root)
  const before =
    existing === undefined || args.force
      ? undefined
      : readFileSync(path.join(root, existing), 'utf8')
  if (before !== undefined && !before.includes(`${runner}(`)) {
    throw new UserError(
      `${existing} exists; add ${runner}() from @vzn/vx-migrate to its plugins, or --force replaces it`,
    )
  }
  // A kept file in the one-line shape gains the plugins it lacks; any
  // other shape is the user's, and left alone.
  const extended = before === undefined ? null : extendWorkspaceFile(before, all)
  const text = before === undefined ? renderWorkspaceFile(all, format) : (extended ?? before)
  const declares = before === undefined || extended !== null
  const steps = await prepareRepo(
    root,
    [
      ...new Set([
        '@vzn/vx',
        '@vzn/vx-migrate',
        ...(declares ? all.map((p) => p.pkg) : []),
        ...importedPackages(text),
      ]),
    ],
    args,
  )
  if (args.json)
    for (const [label, value] of steps) ui.say('info', `vx-migrate: ${label}: ${value}`)
  const ignore = existsSync(path.join(root, '.vx', '.gitignore')) ? [] : ['.vx/.gitignore']
  if (!args.dry) {
    if (before === undefined) {
      if (existing !== undefined && existing !== name) await rm(path.join(root, existing))
      await Bun.write(path.join(root, name), text)
    } else if (text !== before) await Bun.write(path.join(root, existing!), text)
    // vx's own housekeeping, as a run's first cache open writes it.
    if (ignore.length > 0) await Bun.write(path.join(root, '.vx', '.gitignore'), DOT_VX_GITIGNORE)
  }
  const cache = REMOTE_CACHE[runner]
  const cacheLine =
    before?.includes(`${cache}(`) === true
      ? undefined
      : remoteCacheNote(root, runner, text.includes(`${cache}(`))
  const added = before === undefined ? [] : undeclared(before, all).map((p) => `${p.factory}()`)
  const wrote: Step =
    before === undefined
      ? ['files', [name, ...ignore].join('\n')]
      : text === before
        ? ['kept', `${existing} (declares ${runner}())`]
        : [
            'config',
            `${args.dry ? 'would declare' : 'declared'} ${added.join(', ')} in ${existing}`,
          ]
  const next = adoptionNext(root, runner, source, [
    ...new Set(['@vzn/vx', '@vzn/vx-migrate', ...(declares ? all.map((p) => p.pkg) : [])]),
  ])
  if (args.json) {
    process.stdout.write(
      `${JSON.stringify({
        dry: true,
        source,
        files: [
          ...(text === before
            ? []
            : [{ path: before === undefined ? name : existing!, contents: text }]),
          ...ignore.map((p) => ({ path: p, contents: DOT_VX_GITIGNORE })),
        ],
        kept: text === before ? [existing] : [],
        replaced:
          before === undefined && existing !== undefined && existing !== name ? [existing] : [],
        todos: [],
        notes: cacheLine === undefined ? [] : [cacheLine],
        next,
      })}\n`,
    )
    return 0
  }
  if (args.dry && before === undefined) ui.print('out', ui.excerpt(name, text))
  // A run reads only the lock; with the plugins installed it is written
  // now, else `next` names `vx lock` after the install.
  const lock = !args.dry && !next.includes(' lock && ') ? await lockWorkspace(root) : undefined
  if (lock !== undefined && lock.code !== 0) process.stderr.write(lock.said)
  const rows: ui.FieldRow[] = [
    ['from', `${source}, run by ${runner}() from @vzn/vx-migrate`],
    ...(args.dry ? [['dry run', 'nothing written'] as const] : []),
    ...steps,
    wrote,
    ...(lock === undefined ? [] : [lockRow(lock)]),
    [
      'note',
      'a temporary start: vx init --native writes native config',
      ...(cacheLine === undefined ? [] : [cacheLine]),
    ],
    null,
    [
      'next',
      lock === undefined || lock.code === 0 ? next : `fix the above, then vx lock and ${next}`,
    ],
  ]
  ui.print('out', ui.report(`vx-migrate ${VERSION}`, rows))
  return exitAfter(lock?.code ?? 0, steps)
}

/** `vx lock`'s outcome as the report's row. */
function lockRow(lock: { code: number; said: string }): ui.FieldRow {
  return [
    'lock',
    lock.code === 0
      ? lock.said.trim().replace(/^✓ vx lock\s+/, '')
      : ui.tone('error', 'not written'),
  ]
}

/** `.vx/.gitignore`'s text, as core writes it: the machine-local cache and restore staging stay out of git. */
const DOT_VX_GITIGNORE = '/cache\n/tmp\n'

/**
 * Install what the workspace file imports, if missing, then run the repo's
 * build. Pinned to this release: every @vzn package releases in lockstep,
 * and `latest` beside an older vx mismatched them (agent trial 2).
 */
export function adoptionNext(
  root: string,
  runner: 'turbo' | 'nx',
  source: string,
  needs: readonly string[] = ['@vzn/vx', '@vzn/vx-migrate'],
  version: string | null = ownVersion(),
): string {
  const pm = packageManagerOf(root)
  const missing = needs.filter(
    (p) => !existsSync(path.join(root, 'node_modules', p, 'package.json')),
  )
  // `vx init` installs vx globally first: vx alone, never a package
  // manager's runner (2026-10-22: vx owns the command).
  const run = `vx run ${firstTask(path.join(root, source), runner)} --all`
  if (missing.length === 0) return run
  const pinned = version === null ? missing : missing.map((p) => `${p}@${version}`)
  return `${installArgv(root, pm, pinned).join(' ')} && vx lock && ${run}`
}

/**
 * `build` when the runner's config names it, else the first task name it
 * names. A key with `:` is an Nx executor (`@angular/build:application`)
 * and one with `#` a Turbo package task: neither is a task to run `--all`.
 */
function firstTask(file: string, runner: 'turbo' | 'nx'): string {
  let json: Record<string, unknown> | null
  try {
    json = Bun.JSONC.parse(readFileSync(file, 'utf8')) as Record<string, unknown> | null
  } catch {
    return 'build'
  }
  const field =
    runner === 'turbo' ? (json?.['tasks'] ?? json?.['pipeline']) : json?.['targetDefaults']
  const names = Object.keys(typeof field === 'object' && field !== null ? field : {})
  if (names.includes('build')) return 'build'
  return names.find((n) => !n.includes(':') && !n.includes('#')) ?? 'build'
}

/**
 * package.json scripts → one vx.config.ts per package, and the workspace
 * file declaring the lockfile plugin its lockfile calls for: `vx init`'s
 * mapper until core stopped reading package.json (2026-10-14).
 */
async function scripts(
  root: string,
  workspace: PackageWorkspace,
  metas: readonly PackageMeta[],
  nameless: readonly string[],
  args: MigrateArgs,
): Promise<number> {
  if (args.mode !== undefined) {
    throw new UserError(
      `--${args.mode} answers a Turbo or Nx repo's question, and no turbo.json or nx.json is at ${relPosix(process.cwd(), root) || '.'}`,
    )
  }
  const unmapped = namelessNotes(root, nameless)
  // Only a workspace file this run writes declares it; one already here is the user's.
  const lockfile = workspaceFileAt(root) === undefined ? lockfilePlugin(root) : undefined
  const plugins =
    lockfile === undefined ? [] : [{ pkg: '@vzn/vx-lockfile', factory: lockfile.factory }]
  const plan = migrateScripts(
    metas,
    metas.some((m) => m.dir === root) ? undefined : await readRootManifest(root),
    root,
  )
  const empty = plan.projects.length === 0
  // Single-project mode with packages the root's missing `workspaces` never
  // reaches: the scripts exist, the globs do not (item 248).
  const unreached = empty ? await unreachedPackages(workspace) : []
  // Globs that reach no package: "no scripts" was true and named nothing
  // to fix (M-42). Asked of the globs, not of `metas`: a nameless or
  // shared-name member is matched yet absent from `metas` (M-46).
  const globs = workspace.packageGlobs.filter((g) => g !== '.')
  const noMembers =
    empty && globs.length > 0 && !(await reachesManifest(workspace))
      ? [
          `the workspace globs (${globs.map((g) => `"${g}"`).join(', ')}) match no package.json: add a package under one, or fix the glob`,
        ]
      : []
  const installed = await prepareRepo(root, [...new Set(plugins.map((p) => p.pkg))], args)
  const code = await applyMigration({
    root,
    metas,
    plan,
    source: 'package.json scripts',
    verb: 'vx-migrate',
    notes: [...noMembers, ...(await unreadWorkspaces(root, workspace.packageGlobs)), ...unmapped],
    steps: installed,
    unmapped: unmapped.length > 0,
    ...(unreached.length > 0 ? { emptyReason: unreachedHint(unreached, root) } : {}),
    dry: args.dry,
    json: args.json === true,
    force: args.force,
    init: true,
    format: args.mjs ? 'mjs' : 'ts',
    plugins,
    ...(args.noInstall === true ? {} : { lock: lockWorkspace }),
  })
  return exitAfter(code, installed)
}

/**
 * A member whose package.json has no `name` is no project, so its scripts
 * map to nothing, and init said nothing of them (D-106).
 */
function namelessNotes(root: string, dirs: readonly string[]): string[] {
  const withScripts = dirs
    .filter((dir) => {
      const scripts = (
        JSON.parse(readText(path.join(dir, 'package.json')) || '{}') as { scripts?: unknown }
      ).scripts
      return (
        typeof scripts === 'object' &&
        scripts !== null &&
        Object.values(scripts).some((v) => typeof v === 'string' && v !== '')
      )
    })
    .map((dir) => relPosix(root, dir))
    .sort()
    // The root's own manifest is the empty relative path: a nameless
    // single-package repo read `not mapped:  — its package.json…` (M-54).
    .map((rel) => (rel === '' ? 'the root' : rel))
  if (withScripts.length === 0) return []
  const shown =
    withScripts.slice(0, 3).join(', ') +
    (withScripts.length > 3 ? `, and ${withScripts.length - 3} more` : '')
  return [
    `not mapped: ${shown} — ${withScripts.length === 1 ? 'its package.json has' : 'their package.json files have'} no "name", and vx names a project by it; give ${withScripts.length === 1 ? 'it one' : 'each one'} and run \`vx init\` again`,
  ]
}

/**
 * `pnpm-workspace.yaml`'s `packages` decides the members, as pnpm reads it,
 * and a root `workspaces` that lists other globs was dropped without a word:
 * a bun or npm repo with a stale yaml lost those members (M-51).
 */
async function unreadWorkspaces(root: string, globs: readonly string[]): Promise<string[]> {
  if (!existsSync(path.join(root, 'pnpm-workspace.yaml'))) return []
  const ws = (await readRootManifest(root))['workspaces']
  const list = Array.isArray(ws)
    ? ws
    : typeof ws === 'object' &&
        ws !== null &&
        Array.isArray((ws as { packages?: unknown }).packages)
      ? (ws as { packages: unknown[] }).packages
      : undefined
  if (list === undefined) return []
  const pkg = list.filter((g): g is string => typeof g === 'string')
  if ([...pkg].sort().join('\0') === [...globs].sort().join('\0')) return []
  return [
    `pnpm-workspace.yaml's \`packages\` lists the members, as pnpm reads them; package.json's \`workspaces\` (${pkg.map((g) => `"${g}"`).join(', ')}) is not read: if bun, npm or yarn installs this repo, copy those globs into pnpm-workspace.yaml's \`packages\`, or delete that key so package.json decides`,
  ]
}

/** The root package.json as an object, `{}` when unreadable or not one. */
async function readRootManifest(root: string): Promise<Record<string, unknown>> {
  const pj: unknown = await Bun.file(path.join(root, 'package.json'))
    .json()
    .catch(() => ({}))
  return typeof pj === 'object' && pj !== null && !Array.isArray(pj)
    ? (pj as Record<string, unknown>)
    : {}
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8').replace(/^﻿/, '')
  } catch {
    return ''
  }
}

/**
 * The workspace root, or where this run makes one: the package manager's
 * root. A nested workspace the outer one does not list is its own: the
 * outer .vx/workspace.ts made init report the outer configs and write
 * nothing.
 */
async function migrationRoot(cwd: string, reads: LoadReads): Promise<string> {
  const marked = await findWorkspaceRoot(cwd).catch(() => undefined)
  if (marked === undefined) return findManifestRoot(cwd, reads)
  const manifest = await findManifestRoot(cwd, reads).catch(() => marked)
  if (manifest.startsWith(`${marked}${path.sep}`)) {
    const nested = await loadPackageWorkspace(manifest, reads).catch(() => undefined)
    if (nested !== undefined && nested.packageGlobs.length > 0) return manifest
  }
  return marked
}

/**
 * The nearest directory up to the git top-level holding nx.json, for a
 * repo with no package.json: Nx's `nx init` outside JS pins Nx in
 * `.nx/installation` and finds projects by `project.json`.
 */
function nxRootWithoutManifest(cwd: string): string | undefined {
  for (let d = cwd; ; d = path.dirname(d)) {
    if (existsSync(path.join(d, 'nx.json'))) return d
    if (existsSync(path.join(d, '.git')) || path.dirname(d) === d) return undefined
  }
}

/**
 * Lerna 6+ runs `lerna run` on Nx's task runner over the graph `nx graph`
 * exports, nx.json or not, unless lerna.json says `useNx: false`; Lerna 5
 * ran its own unless it said `useNx: true`. Lerna is the installed one,
 * else the root manifest's range; with neither, the lerna.json is another
 * tool's (lerna-lite reads it too, and runs no Nx). A repo whose root
 * scripts never `lerna run` runs its tasks some other way and publishes
 * with Lerna (webdriverio: `run-s`, `pnpm -r`): its scripts are the source.
 */
const LERNA_RUN = /(?:^|[\s;&|(])lerna\s+run\s/

function lernaOnNx(root: string): boolean {
  const json = (file: string): Record<string, unknown> | undefined => {
    try {
      return JSON.parse(readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) as Record<
        string,
        unknown
      >
    } catch {
      return undefined
    }
  }
  const config = json(path.join(root, 'lerna.json'))
  if (config === undefined) return false
  const installed = json(path.join(root, 'node_modules', 'lerna', 'package.json'))?.['version']
  const manifest = json(path.join(root, 'package.json'))
  const declared = ['devDependencies', 'dependencies']
    .map((k) => (manifest?.[k] as Record<string, unknown> | undefined)?.['lerna'])
    .find((v): v is string => typeof v === 'string')
  const version = typeof installed === 'string' ? installed : declared
  if (version === undefined) return false
  const scripts = manifest?.['scripts']
  const runs =
    scripts !== null &&
    typeof scripts === 'object' &&
    Object.values(scripts).some((v) => typeof v === 'string' && LERNA_RUN.test(v))
  if (!runs) return false
  if (typeof config['useNx'] === 'boolean') return config['useNx']
  const major = /\d+/.exec(version)?.[0]
  return major === undefined || Number(major) >= 6
}
