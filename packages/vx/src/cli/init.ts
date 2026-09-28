// `vx init [--dry] [--force] [--mjs]` — a workspace from nowhere: one vx.config.ts
// per package from its package.json scripts, and the workspace file every
// run needs. Turbo and Nx are not read here; a runner's own config beside
// the scripts is the richer source, and `@vzn/vx-migrate` maps it.
// `vx init --plugin <seam>` writes a runnable plugin for one seam and its
// test instead (plugin-templates.ts, the examples the gate runs).

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
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
  WORKSPACE_CONFIG_FILENAMES,
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
  // A Turbo or Nx repo already says its tasks: the runner's own config is
  // the source, and `turbo()` / `nx()` read it live. Writing a config per
  // package from the scripts dropped every edge turbo.json declares (the
  // first-five-minutes walk, 2026-09-28); the workspace file alone is the
  // whole adoption, and `bunx @vzn/vx-migrate` stays for freezing it.
  if (turbo !== undefined) return adopt(root, 'turbo', turbo, parsed)
  if (await Bun.file(path.join(root, 'nx.json')).exists()) {
    return adopt(root, 'nx', 'nx.json', parsed)
  }
  return applyMigration({
    root,
    metas,
    plan: migrateScripts(metas),
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
  const body = `import { ${runner} } from '@vzn/vx-migrate'\n\nexport default { plugins: [${runner}()] }`
  const text = args.mjs
    ? `${body}\n`
    : `import type { WorkspaceConfig } from '@vzn/vx'\n${body} satisfies WorkspaceConfig\n`
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
  const wrote =
    existing !== undefined && !args.force
      ? `${existing} already declares ${runner}().`
      : args.dry
        ? `would write ${name} (dry run, nothing written).`
        : `wrote ${name}.`
  process.stdout.write(
    `vx init: ${source} found — ${runner}() from @vzn/vx-migrate runs this repo as it is; nothing else written.\n` +
      `${wrote}\n\nnext: ${adoptionNext(root, runner, source)}\n`,
  )
  return 0
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
  return missing.length === 0 ? run : `${INSTALL[pm]} ${missing.join(' ')} && ${run}`
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
