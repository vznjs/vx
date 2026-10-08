// `vx init [--dry] [--force] [--mjs]` — a workspace from nowhere: one vx.config.ts
// per package from its package.json scripts, and the workspace file every
// run needs. In a Turbo or Nx repo it writes only the workspace file,
// declaring `turbo()` or `nx()` from `@vzn/vx-migrate`, which read the
// runner's own config live (`adopt`).
// `vx init --plugin <seam>` writes a runnable plugin for one seam and its
// test instead (plugin-templates.ts, the examples the gate runs).

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { flagHint, seeHelp } from './help.js'
import { PLUGIN_TEMPLATES } from './plugin-templates.js'
import { isUserError, relPosix, UserError } from '../util/index.js'
import {
  applyMigration,
  discoverProjects,
  findWorkspaceRoot,
  type LoadReads,
  loadWorkspace,
  migrateScripts,
  WORKSPACE_CONFIG_FILENAMES,
} from '../workspace/index.js'

interface InitArgs {
  dry: boolean
  force: boolean
  /** `vx.config.mjs` instead of `.ts` — see `ApplyMigrationArgs.format`. */
  mjs: boolean
  /** `--plugin <seam>`: scaffold that seam's plugin instead of the workspace. */
  plugin?: string
  error?: string
}

export function parseInitArgs(args: readonly string[]): InitArgs {
  const out: InitArgs = { dry: false, force: false, mjs: false }
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!
    if (a === '--plugin' || a.startsWith('--plugin=')) {
      const seam = a === '--plugin' ? args[++i] : a.slice('--plugin='.length)
      const seams = Object.keys(PLUGIN_TEMPLATES).join(', ')
      if (seam === undefined || !Object.hasOwn(PLUGIN_TEMPLATES, seam)) {
        return {
          ...out,
          error: `--plugin takes a seam: one of ${seams}${seam === undefined ? '' : ` (got '${seam}')`}`,
        }
      }
      out.plugin = seam
    } else if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--mjs') out.mjs = true
    else if (a.startsWith('-'))
      return { ...out, error: `unknown flag: ${a}${flagHint('init', a)}${seeHelp('init')}` }
    else return { ...out, error: `unexpected argument: ${a}${seeHelp('init')}` }
  }
  if (out.plugin !== undefined && out.mjs) {
    return {
      ...out,
      error: '--mjs does not combine with --plugin: the plugin templates are TypeScript',
    }
  }
  return out
}

export async function initCmd(args: readonly string[]): Promise<number> {
  const parsed = parseInitArgs(args)
  if (parsed.error) {
    process.stderr.write(`vx init: ${parsed.error}\n`)
    return 1
  }
  if (parsed.plugin !== undefined) return scaffoldPlugin(parsed.plugin, parsed)
  const reads: LoadReads = new Map()
  // "a workspace from nowhere" still needs a package.json to start from,
  // and the lookup's own refusal named no next step.
  const root = await findWorkspaceRoot(process.cwd(), reads).catch((err: unknown) => {
    if (isUserError(err) && err.message.startsWith('Could not find a workspace root')) {
      throw new UserError(
        'vx init: no package.json here or in any parent directory; create one (`bun init` or `npm init -y`) and run vx init again',
      )
    }
    throw err
  })
  const nameless: string[] = []
  const workspace = await loadWorkspace(root, reads)
  const metas = await discoverProjects(workspace, nameless)
  // `init` reads scripts only; a runner's own config beside them is the
  // richer source (dependsOn, inputs, outputs) and was ignored without a
  // word — the walkthrough on a Turbo repo (2026-09-09) got the scripts'
  // TODOs and none of the edges turbo.json already declared.
  // Turbo 2.5+ reads `turbo.jsonc` as well (item 938).
  let turbo: string | undefined
  for (const name of ['turbo.json', 'turbo.jsonc']) {
    if (await Bun.file(path.join(root, name)).exists()) {
      turbo = name
      break
    }
  }
  // A Turbo or Nx repo already says its tasks: the runner's own config is
  // the source, and `turbo()` / `nx()` read it live. Writing a config per
  // package from the scripts dropped every edge turbo.json declares (the
  // first-five-minutes walk, 2026-09-28); the workspace file alone is the
  // whole adoption, and `bunx @vzn/vx-migrate` stays for freezing it.
  if (turbo !== undefined) return adopt(root, 'turbo', turbo, parsed)
  if (await Bun.file(path.join(root, 'nx.json')).exists()) {
    return adopt(root, 'nx', 'nx.json', parsed)
  }
  const unmapped = namelessNotes(root, nameless)
  return applyMigration({
    root,
    metas,
    plan: migrateScripts(
      metas,
      metas.some((m) => m.dir === root) ? undefined : await readRootManifest(root),
      root,
    ),
    source: 'package.json scripts',
    verb: 'vx init',
    notes: [...(await unreadWorkspaces(root, workspace.packageGlobs)), ...unmapped],
    unmapped: unmapped.length > 0,
    dry: parsed.dry,
    force: parsed.force,
    init: true,
    format: parsed.mjs ? 'mjs' : 'ts',
  })
}

/** Write `plugins/<seam>.ts` and its test under the workspace root (the cwd when there is none). */
async function scaffoldPlugin(seam: string, args: InitArgs): Promise<number> {
  const root = await findWorkspaceRoot(process.cwd(), new Map()).catch(() => process.cwd())
  const template = PLUGIN_TEMPLATES[seam]!
  const files = [
    [path.join('plugins', `${seam}.ts`), template.plugin],
    [path.join('plugins', `${seam}.test.ts`), template.test],
  ] as const
  if (!args.force) {
    for (const [rel] of files) {
      if (await Bun.file(path.join(root, rel)).exists()) {
        process.stderr.write(`vx init: ${rel} exists; --force overwrites it\n`)
        return 1
      }
    }
  }
  if (!args.dry) {
    await mkdir(path.join(root, 'plugins'), { recursive: true })
    for (const [rel, text] of files) await Bun.write(path.join(root, rel), text)
  }
  const factory = /^export function (\w+)/m.exec(template.plugin)![1]!
  const workspaceFile =
    WORKSPACE_CONFIG_FILENAMES.find((n) => existsSync(path.join(root, n))) ?? 'vx.workspace.ts'
  process.stdout.write(
    `${args.dry ? 'would write' : 'wrote'} ${files.map(([rel]) => rel).join(' and ')}\n` +
      `Declare it in ${workspaceFile}: import { ${factory} } from './plugins/${seam}.ts', then plugins: [${factory}(…)]\n` +
      `Test it: bun test plugins/${seam}.test.ts (needs @vzn/vx installed)\n`,
  )
  return 0
}

/**
 * `vx init` in a Turbo or Nx repo: `vx.workspace.ts` declaring the plugin
 * that runs the repo as it is, nothing else, and the one command that gets
 * from here to a run.
 */
async function adopt(
  root: string,
  runner: 'turbo' | 'nx',
  source: string,
  args: InitArgs,
): Promise<number> {
  const name = `vx.workspace.${args.mjs ? 'mjs' : 'ts'}`
  const remote = remoteCacheSignal(root, runner)
  const cache = REMOTE_CACHE[runner]
  const imports = remote === undefined ? runner : `${runner}, ${cache}`
  const plugins = remote === undefined ? `${runner}()` : `${runner}(), ${cache}()`
  const body = `import { ${imports} } from '@vzn/vx-migrate'\n\nexport default { plugins: [${plugins}] }`
  const text = args.mjs
    ? `${body}\n`
    : `import type { WorkspaceConfig } from '@vzn/vx/config'\n${body} satisfies WorkspaceConfig\n`
  const existing = WORKSPACE_CONFIG_FILENAMES.find((f) => existsSync(path.join(root, f)))
  if (existing !== undefined && !args.force) {
    const declared = readFileSync(path.join(root, existing), 'utf8').includes(`${runner}(`)
    if (!declared) {
      throw new UserError(
        `vx init: ${existing} exists; add ${runner}() from @vzn/vx-migrate to its plugins, or --force replaces it`,
      )
    }
  } else if (args.dry) {
    process.stdout.write(`── ${name} ──\n${text}\n`)
  } else {
    if (existing !== undefined && existing !== name) await unlink(path.join(root, existing))
    await Bun.write(path.join(root, name), text)
  }
  const kept = existing !== undefined && !args.force
  const wrote = kept
    ? `${existing} already declares ${runner}().`
    : args.dry
      ? `would write ${name} (dry run, nothing written).`
      : `wrote ${name}.`
  const cacheLine =
    remote === undefined
      ? runner === 'nx' && usesNxCloud(root)
        ? 'nx.json connects Nx Cloud, whose cache vx cannot share: runs cache on this machine (nxCache() serves a self-hosted Nx cache).\n'
        : ''
      : kept && !readFileSync(path.join(root, existing), 'utf8').includes(`${cache}(`)
        ? `${remote}: add ${cache}() from @vzn/vx-migrate to its plugins and vx shares that remote cache.\n`
        : kept
          ? ''
          : `${cache}(): ${remote}, so vx shares that remote cache (inert where the variable is unset).\n`
  process.stdout.write(
    `vx init: ${source} found — ${runner}() from @vzn/vx-migrate, a temporary start until bunx @vzn/vx-migrate writes native config; nothing else written.\n` +
      `${wrote}\n${cacheLine}\nnext: ${adoptionNext(root, runner, source)}\n`,
  )
  return 0
}

const REMOTE_CACHE = { turbo: 'turboCache', nx: 'nxCache' } as const

/**
 * nx.json names an Nx Cloud workspace (`nxCloudId`, `nxCloudAccessToken`,
 * or the legacy `nx-cloud` runner). Its wire is Nx's own, so a user who
 * expected their remote cache under vx heard nothing and ran cold.
 */
function usesNxCloud(root: string): boolean {
  let json: {
    nxCloudId?: unknown
    nxCloudAccessToken?: unknown
    tasksRunnerOptions?: { default?: { runner?: unknown } }
  } | null
  try {
    json = Bun.JSONC.parse(readFileSync(path.join(root, 'nx.json'), 'utf8')) as typeof json
  } catch {
    return false
  }
  const set = (v: unknown) => typeof v === 'string' && v !== ''
  const runner = json?.tasksRunnerOptions?.default?.runner
  return (
    set(json?.nxCloudId) ||
    set(json?.nxCloudAccessToken) ||
    (typeof runner === 'string' && /(^|\/)nx-cloud$/.test(runner))
  )
}

/** The variable each runner's self-hosted remote cache is set by, as its plugin reads it. */
const REMOTE_CACHE_ENV = { turbo: 'TURBO_TOKEN', nx: 'NX_SELF_HOSTED_REMOTE_CACHE_SERVER' } as const

const CI_FILES = ['.gitlab-ci.yml', '.circleci/config.yml']

/**
 * Where the repo shows a remote cache its runner uses, or undefined: turbo.json's
 * enabled `remoteCache`, a `turbo link`ed `.turbo/config.json`, or a CI file that sets the runner's cache variable (a
 * local repo holds no token; CI does).
 */
function remoteCacheSignal(root: string, runner: 'turbo' | 'nx'): string | undefined {
  if (runner === 'turbo') {
    for (const f of ['turbo.json', 'turbo.jsonc']) {
      let rc: unknown
      try {
        rc = (
          Bun.JSONC.parse(readFileSync(path.join(root, f), 'utf8')) as { remoteCache?: unknown }
        )?.remoteCache
      } catch {
        continue
      }
      if (typeof rc === 'object' && rc !== null) {
        // Turned off in turbo.json is off, whatever CI sets.
        if ((rc as { enabled?: unknown }).enabled === false) return undefined
        return `${f} names a remoteCache`
      }
    }
    // `turbo link` writes the team here (gitignored, on the machine that
    // linked); turboCache() reads it, so a linked repo has a remote cache.
    let linked: unknown
    try {
      linked = JSON.parse(readFileSync(path.join(root, '.turbo', 'config.json'), 'utf8'))
    } catch {}
    if (
      typeof linked === 'object' &&
      linked !== null &&
      Object.entries(linked).some(
        ([k, v]) => /^(teamid|teamslug|token)$/i.test(k) && typeof v === 'string' && v !== '',
      )
    ) {
      return '.turbo/config.json links a team (turbo link)'
    }
  }
  const variable = REMOTE_CACHE_ENV[runner]
  // A line that sets it (`TURBO_TOKEN: …`, `TURBO_TOKEN=…`), not one that
  // names it: a comment or a doc line counted as "sets" (J's lead).
  const sets = new RegExp(`^(?!\\s*#).*\\b${variable}\\s*[:=]`, 'm')
  const workflows = new Bun.Glob('.github/workflows/*.{yml,yaml}')
  const files = [...workflows.scanSync({ cwd: root, dot: true })].sort().concat(CI_FILES)
  for (const f of files) {
    let text: string
    try {
      text = readFileSync(path.join(root, f), 'utf8')
    } catch {
      continue
    }
    if (sets.test(text)) return `${f} sets ${variable}`
  }
  return undefined
}

type PackageManager = 'pnpm' | 'yarn' | 'bun' | 'npm'

const LOCKFILES: ReadonlyArray<[string, PackageManager]> = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

const INSTALL: Record<PackageManager, string> = {
  pnpm: 'pnpm add -D -w',
  yarn: 'yarn add -D',
  bun: 'bun add -d',
  npm: 'npm install -D',
}

const EXEC: Record<PackageManager, string> = { pnpm: 'pnpm', yarn: 'yarn', bun: 'bunx', npm: 'npx' }

/** Install what the workspace file imports, if missing, then run the repo's build. */
export function adoptionNext(root: string, runner: 'turbo' | 'nx', source: string): string {
  const pm = LOCKFILES.find(([f]) => existsSync(path.join(root, f)))?.[1] ?? 'npm'
  const missing = ['@vzn/vx', '@vzn/vx-migrate'].filter(
    (p) => !existsSync(path.join(root, 'node_modules', p, 'package.json')),
  )
  // A global vx (no runner started this one) runs the workspace's plugins as they are.
  const vx = process.env['npm_config_user_agent'] === undefined ? 'vx' : `${EXEC[pm]} vx`
  const task = firstTask(path.join(root, source), runner)
  const run = `${vx} run ${task} --all`
  if (missing.length === 0) return run
  // Yarn 1 refuses `add` at a workspace root without `-W`; Berry has no such
  // flag and refuses it. A Berry lockfile carries `__metadata`.
  const install =
    pm === 'yarn' && !readText(path.join(root, 'yarn.lock')).includes('__metadata:')
      ? `${INSTALL.yarn} -W`
      : INSTALL[pm]
  return `${install} ${missing.join(' ')} && ${run}`
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
}

/** `build` when the runner's config names it, else the first task it names. */
function firstTask(file: string, runner: 'turbo' | 'nx'): string {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch {
    return 'build'
  }
  if (/"build"\s*:/.test(text)) return 'build'
  const field = runner === 'turbo' ? '(?:tasks|pipeline)' : 'targetDefaults'
  const first = new RegExp(`"${field}"\\s*:\\s*\\{\\s*"([^"]+)"`).exec(text)?.[1]
  return first ?? 'build'
}

/**
 * A member whose package.json has no `name` is no project, so its scripts
 * map to nothing, and init said nothing of them (D-106).
 */
function namelessNotes(root: string, dirs: readonly string[]): string[] {
  const withScripts = dirs
    .filter((dir) => {
      const scripts = (
        JSON.parse(readText(path.join(dir, 'package.json')) || '{}') as {
          scripts?: unknown
        }
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
