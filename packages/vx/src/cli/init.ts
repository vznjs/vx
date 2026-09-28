// `vx init [--dry] [--force] [--mjs]` — a workspace from nowhere: one vx.config.ts
// per package from its package.json scripts, and the workspace file every
// run needs. Turbo and Nx are not read here; a runner's own config beside
// the scripts is the richer source, and `@vzn/vx-migrate` maps it.
// `vx init --plugin <seam>` writes a runnable plugin for one seam and its
// test instead (plugin-templates.ts, the examples the gate runs).

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
    else return { ...out, error: `unexpected argument: ${a}` }
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
  const notes: string[] = []
  // Turbo 2.5+ reads `turbo.jsonc` as well (item 938).
  let turbo: string | undefined
  for (const name of ['turbo.json', 'turbo.jsonc']) {
    if (await Bun.file(path.join(root, name)).exists()) {
      turbo = name
      break
    }
  }
  if (turbo !== undefined) {
    notes.push(
      `${turbo} found and not read — ` +
        '`bunx @vzn/vx-migrate` maps it (dependsOn, inputs, ' +
        'outputs), or `plugins: [turbo()]` from @vzn/vx-migrate runs it with nothing written',
    )
  } else if (
    (await Bun.file(path.join(root, 'nx.json')).exists()) ||
    (await Bun.file(path.join(root, '.nx', 'workspace-data', 'project-graph.json')).exists())
  ) {
    notes.push(
      'an Nx workspace found and not read — `bunx @vzn/vx-migrate --from nx` maps its ' +
        'exported project graph, or `plugins: [nx()]` from @vzn/vx-migrate runs it with ' +
        'nothing written',
    )
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
    notes,
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
