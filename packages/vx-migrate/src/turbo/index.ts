// `@vzn/vx-migrate` — a Turbo repo under vx with nothing written.
//
// Fills the `project` stage: every package the workspace discovers is given
// the tasks turbo.json + its package.json scripts define, mapped by the same
// mapper `bunx @vzn/vx-migrate` renders files from — so what runs here is
// what a migration would have written, minus the file. Turbo's global fields
// are inlined into each task instead of imported from a generated preset.
// A task the package's own vx.config already declares wins; the plugin never
// overwrites a user's hand.

import { readFileSync } from 'node:fs'
import { availableParallelism } from 'node:os'
import path from 'node:path'
import type { ProjectMeta, VxPlugin } from '@vzn/vx'
import type { PackageMeta } from '../packages.js'
import { memberProjects, withManifests } from '../manifests.js'
import { refuseUnknownOptions, UserError, type PluginOptionKinds } from '@vzn/vx'
import { type AdoptionRun, adoptionPlugin } from '../adoption-plugin.js'
import type { AdoptionMapping } from '../mapping-cache.js'
import { collectGaps } from '../plugin-gaps.js'
import { gitIgnored, trackedKinds } from '../tracked-outputs.js'
import { packageScripts, relPosix } from '../paths.js'
import { onceReader, type ReadText, tscBuildInfo } from '../tsc-buildinfo.js'
import type * as TurboMap from './turbo-map.js'
import type { TurboMappedProject } from './turbo-map.js'
import {
  envNamesThatMap,
  microfrontendsConfigs,
  rootTaskProject,
  turboConfigFile,
} from './turbo-reads.js'

/** The note every persistent task carries; like every gap, reported once per run for all its tasks. */
const PERSISTENT_NOTE =
  'persistent in turbo.json — vx runs them as persistent tasks that are ready on spawn; ' +
  'add `exec.persistent.readyWhen` in a vx.config to gate dependents on their output'

export interface TurboPluginOptions {
  /**
   * Where turbo.json lives. Defaults to the workspace root; a repo whose
   * turbo.json sits elsewhere names the directory here, relative to the workspace
   * root or absolute.
   */
  readonly root?: string
}

/** Each option `TurboPluginOptions` names, with its kind: derived from the type, so the two cannot drift. */
const TURBO_PLUGIN_KEYS: PluginOptionKinds<TurboPluginOptions> = {
  root: 'string',
}

/**
 * The plugin: the adoption skeleton over `mapTurboWorkspace`, one mapping
 * per run (`adoption-plugin.ts` says why).
 */
export function turbo(options: TurboPluginOptions = {}): VxPlugin {
  refuseUnknownOptions('turbo()', options, TURBO_PLUGIN_KEYS)
  if (options.root === '') throw new UserError('turbo() option "root" is a directory, not empty')
  // Against the workspace root, as vx reads every path: against the cwd,
  // `vx run` from a package dir read another directory.
  const rootOf = (workspaceRoot: string): string =>
    options.root === undefined ? workspaceRoot : path.resolve(workspaceRoot, options.root)
  return adoptionPlugin(
    import.meta,
    (ctx) => run(rootOf(ctx.workspaceRoot), ctx.projects),
    // At the workspace root only: a claim is a root name (a `root` elsewhere
    // is not claimed; its edits select as any unowned file does).
    options.root === undefined ? ['turbo.json', 'turbo.jsonc'] : [],
    {
      async config(workspace, ctx) {
        const keys = await workspaceKeys(rootOf(ctx.workspaceRoot))
        if (workspace.run?.concurrency === undefined && keys.concurrency !== undefined)
          workspace.run = { ...workspace.run, concurrency: keys.concurrency }
        // `turbo run --affected` compares with TURBO_SCM_BASE when set, and
        // on GitHub Actions with what the event names.
        const base =
          Bun.env['TURBO_SCM_BASE']?.trim() ||
          githubActionsBase(rootOf(ctx.workspaceRoot), keys.remoteBaseFallback === true)
        if (base) ctx.setBranch({ base })
      },
      // Turbo's packages are the package manager's members, each a project
      // with no vx.config written. `//#task` keys run on the root, as Turbo
      // runs them: named here, the root is a project too (a create-turbo
      // repo's `//#format`). A package that holds the root's name keeps it,
      // and the mapping's note says so.
      async discover(ctx) {
        const members = await memberProjects(ctx.workspaceRoot)
        if (options.root !== undefined) return members
        const named = await rootTaskProject(ctx.workspaceRoot)
        if (named === null) return members
        const rootDir = path.resolve(named.dir)
        const known = [...ctx.projects, ...members.map((m) => ({ name: m.name, dir: m.dir }))]
        const taken = known.some((m) => m.name === named.name && path.resolve(m.dir) !== rootDir)
        return taken ? members : [...members.filter((m) => path.resolve(m.dir) !== rootDir), named]
      },
    },
  )
}

const UNKNOWN_SHA = '0'.repeat(40)

/**
 * Turbo's `--affected` base on GitHub Actions when `TURBO_SCM_BASE` is
 * unset (`get_github_base_ref`): a pull request's `GITHUB_BASE_REF`, else
 * the push event's `before`, or the parent of its first commit when the
 * push is new or forced. vx guessed `origin/HEAD`, which on a push to the
 * default branch is the commit itself: nothing was affected where Turbo
 * ran the pushed commits' packages. `origin/<ref>` stands in for a base
 * ref the checkout lacks only under Turbo's
 * `futureFlags.githubActionsRemoteBaseRefFallback`, as in Turbo.
 */
function githubActionsBase(root: string, remoteFallback: boolean): string | undefined {
  if (!Bun.env['GITHUB_ACTIONS']) return undefined
  const ref = Bun.env['GITHUB_BASE_REF']
  if (ref) {
    if (!remoteFallback) return ref
    const has = (r: string) =>
      Bun.spawnSync(['git', 'rev-parse', '--verify', '--quiet', '--end-of-options', r], {
        cwd: root,
        stdout: 'ignore',
        stderr: 'ignore',
      }).exitCode === 0
    return has(ref) || !has(`origin/${ref}`) ? ref : `origin/${ref}`
  }
  const eventPath = Bun.env['GITHUB_EVENT_PATH']
  if (!eventPath) return undefined
  let event: { before?: unknown; forced?: unknown; commits?: unknown }
  try {
    event = JSON.parse(readFileSync(eventPath, 'utf8')) as typeof event
  } catch {
    return undefined
  }
  const before = typeof event.before === 'string' ? event.before : ''
  if (before === UNKNOWN_SHA || event.forced === true) {
    const commits = Array.isArray(event.commits) ? event.commits : []
    const id = (commits[0] as { id?: unknown } | undefined)?.id
    return commits.length > 0 && commits.length < 2048 && typeof id === 'string'
      ? `${id}^`
      : undefined
  }
  return before === '' ? undefined : before
}

/**
 * turbo.json's workspace keys vx has a home for, top level or under
 * `global`: `concurrency` (`"10"`, `"50%"` of the cores).
 */
async function workspaceKeys(root: string): Promise<{
  concurrency?: number
  remoteBaseFallback?: boolean
}> {
  const file = await turboConfigFile(root)
  if (file === null) return {}
  let raw: Record<string, unknown>
  try {
    raw = (Bun.JSONC.parse(await Bun.file(file).text()) ?? {}) as Record<string, unknown>
  } catch {
    return {} // the mapping refuses the file, naming it
  }
  const global = (typeof raw['global'] === 'object' ? raw['global'] : null) as Record<
    string,
    unknown
  > | null
  // Turbo's environment sits above turbo.json (`TURBO_CONCURRENCY`, …);
  // a set variable decides, its `0` included.
  const read = (key: string, envName: string): string | undefined => {
    const e = process.env[envName]?.trim()
    const v = e !== undefined && e !== '' ? e : (global?.[key] ?? raw[key])
    return typeof v === 'string' && v.trim() !== '' && v.trim() !== '0' ? v.trim() : undefined
  }
  const out: {
    concurrency?: number
    remoteBaseFallback?: boolean
  } = {}
  const flags = raw['futureFlags'] as { githubActionsRemoteBaseRefFallback?: unknown } | undefined
  if (flags?.githubActionsRemoteBaseRefFallback === true) out.remoteBaseFallback = true
  const c = read('concurrency', 'TURBO_CONCURRENCY')
  if (c !== undefined) {
    const pct = /^(\d+)%$/.exec(c)
    const n = pct
      ? Math.max(1, Math.floor((availableParallelism() * Number(pct[1])) / 100))
      : Number(c)
    if (Number.isInteger(n) && n > 0) out.concurrency = n
  }
  return out
}

const envNamesNow = (): string[] => Object.keys(process.env).sort()

const textOf = (file: string): Promise<string> =>
  Bun.file(file)
    .text()
    .catch(() => '\0absent')

/**
 * Everything the mapping reads: the root's and each package's
 * `turbo.json` / `turbo.jsonc`, every package manifest, the root's,
 * `.yarnrc.yml`, `.npmrc`, `pnpm-workspace.yaml` and the microfrontends configs.
 */
async function run(root: string, projects: readonly ProjectMeta[]): Promise<AdoptionRun> {
  const dirs = [root, ...projects.map((m) => m.dir)]
  const [metas, configs, yarnrc, rootManifest, hookConfigs] = await Promise.all([
    withManifests(projects),
    Promise.all(
      dirs.flatMap((d) => ['turbo.json', 'turbo.jsonc'].map((f) => textOf(path.join(d, f)))),
    ),
    textOf(path.join(root, '.yarnrc.yml')),
    textOf(path.join(root, 'package.json')),
    // Whether the manager runs `pre` / `post` hooks, so whether they fold.
    Promise.all(['.npmrc', 'pnpm-workspace.yaml'].map((f) => textOf(path.join(root, f)))),
  ])
  const envNames = envNamesThatMap(configs, envNamesNow())
  // The tsconfigs a `tsc` script reads are the mapping's inputs too.
  const tsc = onceReader()
  for (const m of metas)
    for (const s of Object.values(packageScripts(m)))
      if (typeof s === 'string' && /\btsc\b/.test(s)) tscBuildInfo(tsc.read, m.dir, s)
  return {
    name: 'turbo',
    spareTracked: true,
    reads: [
      JSON.stringify(dirs),
      // An env wildcard expands over these; a new name it matches maps afresh.
      JSON.stringify(envNames),
      process.env['TURBO_CI_VENDOR_ENV_KEY'] ?? '',
      process.env['TURBO_ENV_MODE'] ?? '',
      ...configs,
      yarnrc,
      // Whether pnpm or npm runs a script's `pre` / `post` hooks (`runsScriptHooks`).
      ...hookConfigs,
      // Its dependencies are global inputs, a member or not; its `packageManager` names who runs hooks.
      rootManifest,
      JSON.stringify(microfrontendsConfigs(root, dirs)),
      // A config file added beside mapped tasks changes what an output may cover.
      JSON.stringify(metas.map((m) => [m.name, m.dir, m.packageJson, m.configPath])),
      JSON.stringify([...tsc.texts]),
    ],
    map: (tracked) => mapAll(root, metas, envNames, tracked, tsc.read),
  }
}

/**
 * The mapping indexed by package name. The stage visits every package and
 * each visit looked its package up with a linear scan over the mapping —
 * a million comparisons on a 1,000-package workspace, a third of the
 * stage's cost there (2026-09-10).
 */
async function mapAll(
  root: string,
  metas: readonly PackageMeta[],
  envNames: readonly string[],
  trackedFiles: () => Promise<readonly string[] | null>,
  read: ReadText,
): Promise<AdoptionMapping> {
  const tracked = await trackedFiles()
  const configs = new Map(
    metas.flatMap((m) =>
      m.configPath === null ? [] : [[relPosix(root, m.dir), path.basename(m.configPath)] as const],
    ),
  )
  // Only a mapping the kept one no longer holds loads the mapper.
  const { mapTurboWorkspace } = require('./turbo-map.js') as typeof TurboMap
  const mapped = await mapTurboWorkspace(root, metas, {
    // Inline: the values themselves, where `bunx @vzn/vx-migrate` splices a preset import.
    splice: (_kind, values) => values,
    persistentTodo: PERSISTENT_NOTE,
    envNames,
    vendorEnvPrefix: process.env['TURBO_CI_VENDOR_ENV_KEY'] ?? '',
    envMode: process.env['TURBO_ENV_MODE'] ?? '',
    ...(tracked === null ? {} : { tracked: trackedKinds(tracked) }),
    ownConfig: (rel) => configs.get(rel === '.' ? '' : rel) ?? null,
    ignored: (rels) => gitIgnored(root, rels),
    buildInfo: (rel, command) => tscBuildInfo(read, path.join(root, rel), command),
  })
  const byName = new Map<string, TurboMappedProject>()
  for (const project of mapped.projects) byName.set(project.name, project)
  return { byName, gaps: collectGaps(mapped.projects, mapped.notes) }
}
