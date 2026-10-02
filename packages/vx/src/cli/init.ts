// `vx init [--dry] [--force] [--mjs]` — a workspace from nowhere: one vx.config.ts
// per package from its package.json scripts, and the workspace file every
// run needs. In a Turbo or Nx repo the runner's config is the source: the
// workspace's own `@vzn/vx-migrate` writer turns it into native configs
// (`migrateRunner`), and the runner's file is then no longer read.
// `vx init --plugin <seam>` writes a runnable plugin for one seam and its
// test instead (plugin-templates.ts, the examples the gate runs).

import { existsSync, readFileSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
import path from 'node:path'
import { flagHint, seeHelp } from './help.js'
import { PLUGIN_TEMPLATES } from './plugin-templates.js'
import { isUserError, UserError } from '../util/index.js'
import {
  applyMigration,
  findWorkspaceRoot,
  type LoadReads,
  listProjects,
  loadWorkspace,
  migrateScripts,
} from '../workspace/index.js'

export interface InitArgs {
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
  const metas = await listProjects(await loadWorkspace(root, reads))
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
  // A Turbo or Nx repo already says its tasks: the runner's config is the
  // richer source, and the scripts alone dropped every edge turbo.json
  // declares (the first-five-minutes walk, 2026-09-28). vx runs the result
  // natively; no plugin reads the runner's file at run time (owner,
  // 2026-10-02).
  if (turbo !== undefined) return migrateRunner(root, 'turbo', turbo, parsed)
  if (await Bun.file(path.join(root, 'nx.json')).exists()) {
    return migrateRunner(root, 'nx', 'nx.json', parsed)
  }
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
  process.stdout.write(
    `${args.dry ? 'would write' : 'wrote'} ${files.map(([rel]) => rel).join(' and ')}\n` +
      `Declare it in vx.workspace.ts: import { ${factory} } from './plugins/${seam}.ts', then plugins: [${factory}(…)]\n` +
      `Test it: bun test plugins/${seam}.test.ts (needs @vzn/vx installed)\n`,
  )
  return 0
}

/**
 * `vx init` in a Turbo or Nx repo: the runner's config becomes native
 * `vx.config.ts` files through `@vzn/vx-migrate`'s writer, loaded from the
 * workspace (core names no plugin package as a dependency), then what is
 * left of the runner is said.
 */
async function migrateRunner(
  root: string,
  runner: 'turbo' | 'nx',
  source: string,
  args: InitArgs,
): Promise<number> {
  let entry: string
  try {
    entry = Bun.resolveSync('@vzn/vx-migrate', root)
  } catch {
    throw new UserError(
      `vx init: ${source} found — its tasks become native vx.config.ts files through @vzn/vx-migrate, ` +
        `not installed here: ${installCommand(root, ['@vzn/vx-migrate'])}, then vx init again`,
    )
  }
  const writer = (await import(entry)) as { migrateCmd?: (argv: string[]) => Promise<number> }
  if (typeof writer.migrateCmd !== 'function') {
    throw new UserError(
      `vx init: the @vzn/vx-migrate installed here has no writer (migrateCmd); update it and run vx init again`,
    )
  }
  const flags = [
    '--from',
    runner,
    ...(args.dry ? ['--dry'] : []),
    ...(args.force ? ['--force'] : []),
    ...(args.mjs ? ['--mjs'] : []),
  ]
  const code = await writer.migrateCmd(flags)
  if (code !== 0) return code
  const remote = remoteCacheSignal(root, runner)
  const cache = REMOTE_CACHE[runner]
  const lines: string[] = []
  if (remote !== undefined) {
    lines.push(
      `${remote}: add ${cache}() from @vzn/vx-migrate to the workspace file's plugins and vx shares that remote cache.`,
    )
  } else if (runner === 'nx' && usesNxCloud(root)) {
    lines.push(
      'nx.json connects Nx Cloud, whose cache vx cannot share: runs cache on this machine (nxCache() serves a self-hosted Nx cache).',
    )
  }
  if (args.dry) {
    lines.push(`${source} stays the source until the files are written.`)
  } else if (runner === 'turbo') {
    lines.push(`vx no longer reads ${source}: delete it once a run passes.`)
  } else {
    // `nx-exec` / `nx-env` run an executor target through Nx's own API,
    // which reads nx.json and the project.json files.
    const viaNx = (await listProjects(await loadWorkspace(root, new Map()))).some(
      (m) => typeof m.configPath === 'string' && /\bnx-(exec|env)\b/.test(readText(m.configPath)),
    )
    lines.push(
      viaNx
        ? 'nx.json stays while a task runs `nx-exec` or `nx-env` (Nx executors read it); delete it once none does.'
        : 'vx no longer reads nx.json: delete it once a run passes.',
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
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

/** Install `packages` at the workspace root with the manager the lockfile names. */
function installCommand(root: string, packages: readonly string[]): string {
  const pm = LOCKFILES.find(([f]) => existsSync(path.join(root, f)))?.[1] ?? 'npm'
  // Yarn 1 refuses `add` at a workspace root without `-W`; Berry has no such
  // flag and refuses it. A Berry lockfile carries `__metadata`.
  const install =
    pm === 'yarn' && !readText(path.join(root, 'yarn.lock')).includes('__metadata:')
      ? `${INSTALL.yarn} -W`
      : INSTALL[pm]
  return `${install} ${packages.join(' ')}`
}

function readText(file: string): string {
  try {
    return readFileSync(file, 'utf8')
  } catch {
    return ''
  }
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
