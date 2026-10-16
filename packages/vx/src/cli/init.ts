// `vx init [--dry [--format json]] [--force] [--mjs] [--native|--keep]` — a workspace from nowhere.
// Core reads no package.json (M, 2026-10-14): a repo with one (package.json
// scripts, Turbo, Nx) is `@vzn/vx-migrate`'s, which maps it and installs
// what it writes (`migrate`); without one, the workspace file and an empty
// root project are written here, then the lock (`starter`).
// `vx init --plugin <seam>` writes a runnable plugin for one seam and its
// test instead (plugin-templates.ts, the examples the gate runs).

import { existsSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { gitTop, workspaceFileWritten } from '../handoff.js'
import { flagHint, formatValue, refuse, seeHelp } from './help.js'
import { lockAfterMigration } from './lock.js'
import { PLUGIN_TEMPLATES } from './plugin-templates.js'
import { isCompiledBinary, targetVersion } from './upgrade.js'
import { VERSION } from '../version.js'
import { DOT_VX_GITATTRIBUTES, DOT_VX_GITIGNORE, ui, UserError, sayNotice } from '../util/index.js'
import {
  findWorkspaceRoot,
  PROJECT_CONFIG_FILENAMES,
  vxInvocation,
  WORKSPACE_CONFIG_FILENAMES,
} from '../workspace/index.js'

interface InitArgs {
  dry: boolean
  force: boolean
  /** `vx.config.mjs` instead of `.ts` — see `ApplyMigrationArgs.format`. */
  mjs: boolean
  /** `--plugin <seam>`: scaffold that seam's plugin instead of the workspace. */
  plugin?: string
  /** `--native` / `--keep` in a Turbo or Nx repo; unset, vx-migrate asks a terminal. */
  mode?: 'native' | 'keep'
  /** `--format json` (with `--dry`): the plan as one JSON document. */
  json?: boolean
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
          error: `--plugin takes a seam: one of ${seams}${seam === undefined ? '' : ` (got '${seam}')`}${seeHelp('init')}`,
        }
      }
      out.plugin = seam
    } else if (a === '--format' || a.startsWith('--format=')) {
      const fv = formatValue(a === '--format' ? args[++i] : a.slice('--format='.length), 'init')
      if (typeof fv === 'object') return { ...out, error: fv.error }
      out.json = fv === 'json'
    } else if (a === '--dry') out.dry = true
    else if (a === '--force') out.force = true
    else if (a === '--mjs') out.mjs = true
    else if (a === '--native' || a === '--keep') {
      const mode = a === '--native' ? 'native' : 'keep'
      if (out.mode !== undefined && out.mode !== mode) {
        return {
          ...out,
          error: `--native and --keep are two answers to one question; pass one${seeHelp('init')}`,
        }
      }
      out.mode = mode
    } else if (a.startsWith('-'))
      return { ...out, error: `unknown flag: ${a}${flagHint('init', a)}${seeHelp('init')}` }
    else return { ...out, error: `unexpected argument: ${a}${seeHelp('init')}` }
  }
  if (out.plugin !== undefined && out.mode !== undefined) {
    return { ...out, error: `--${out.mode} does not combine with --plugin${seeHelp('init')}` }
  }
  if (out.plugin !== undefined && out.mjs) {
    return {
      ...out,
      error: `--mjs does not combine with --plugin: the plugin templates are TypeScript${seeHelp('init')}`,
    }
  }
  return out
}

export async function initCmd(args: readonly string[]): Promise<number> {
  const parsed = parseInitArgs(args)
  if (parsed.error) return refuse('init', args, parsed.error, 'VX_E_USAGE')
  // In the verb, not the parser: completion asks the parser one flag at a time.
  if (parsed.json === true && (!parsed.dry || parsed.plugin !== undefined)) {
    return refuse(
      'init',
      args,
      `--format json prints the workspace plan, so it needs --dry and no --plugin${seeHelp('init')}`,
      'VX_E_USAGE',
    )
  }
  const cwd = process.cwd()
  const marked = await findWorkspaceRoot(cwd).catch(() => undefined)
  if (parsed.plugin !== undefined) return scaffoldPlugin(parsed.plugin, marked ?? cwd, parsed)
  // The directories from here up to the workspace root, else the git
  // top-level, else `/`: where a package manager's root or an installed
  // vx-migrate may be.
  const top = marked ?? (await gitTop(cwd))
  const dirs: string[] = []
  for (let d = cwd; ; d = path.dirname(d)) {
    dirs.push(d)
    if (d === top || path.dirname(d) === d) break
  }
  const manifest = dirs.some((d) => MANIFESTS.some((f) => existsSync(path.join(d, f))))
  if (manifest) return migrate(dirs, parsed)
  return starter(marked ?? cwd, top === null, parsed)
}

/** What makes a repo vx-migrate's to map: a package manager's root, a Turbo or Nx config. */
const MANIFESTS = ['package.json', 'pnpm-workspace.yaml', 'turbo.json', 'turbo.jsonc', 'nx.json']

/** Write `plugins/<seam>.ts` and its test under `root`: the workspace root, else the cwd. */
async function scaffoldPlugin(seam: string, root: string, args: InitArgs): Promise<number> {
  const template = PLUGIN_TEMPLATES[seam]!
  const files = [
    [path.join('plugins', `${seam}.ts`), template.plugin],
    [path.join('plugins', `${seam}.test.ts`), template.test],
  ] as const
  if (!args.force) {
    for (const [rel] of files) {
      if (await Bun.file(path.join(root, rel)).exists()) {
        sayNotice('error', 'vx init', `${rel} exists. --force overwrites it`)
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
    WORKSPACE_CONFIG_FILENAMES.find((n) => existsSync(path.join(root, n))) ?? '.vx/workspace.ts'
  process.stdout.write(
    `${args.dry ? 'would write' : 'wrote'} ${files.map(([rel]) => rel).join(' and ')}\n` +
      `Declare it in ${workspaceFile}: import { ${factory} } from '../plugins/${seam}.ts', then plugins: [${factory}(…)]\n` +
      `Test it: bun test plugins/${seam}.test.ts (needs @vzn/vx installed)\n`,
  )
  return 0
}

const WORKSPACE =
  "import { defineWorkspace } from '@vzn/vx'\n\nexport default defineWorkspace({ plugins: [] })\n"
const PROJECT =
  "import { defineProject } from '@vzn/vx'\n\nexport default defineProject({ tasks: {} })\n"

/**
 * No package.json: `.vx/workspace.ts` declaring no plugin and a root
 * `vx.config.ts` with no task, then the lock. `@vzn/vx` resolves to the
 * running vx (core-alias.ts), so the two load with nothing installed.
 * A file already here is kept; `--force` replaces it.
 */
async function starter(root: string, noGit: boolean, args: InitArgs): Promise<number> {
  if (args.mode !== undefined) {
    throw new UserError(
      `vx init: --${args.mode} answers a Turbo or Nx repo's question, and there is no package.json here`,
    )
  }
  const ext = args.mjs ? 'mjs' : 'ts'
  const config = `vx.config.${ext}`
  const files: { path: string; contents: string }[] = []
  const kept: string[] = []
  const replaced: string[] = []
  for (const [names, name, contents] of [
    [WORKSPACE_CONFIG_FILENAMES, `.vx/workspace.${ext}`, WORKSPACE],
    [PROJECT_CONFIG_FILENAMES, config, PROJECT],
  ] as const) {
    const existing = names.find((n) => existsSync(path.join(root, n)))
    if (existing !== undefined && !args.force) kept.push(existing)
    else {
      files.push({ path: name, contents })
      if (existing !== undefined && existing !== name) replaced.push(existing)
    }
  }
  // vx's own housekeeping, as a run's first cache open and `vx lock` write them.
  for (const [name, contents] of [
    ['.vx/.gitignore', DOT_VX_GITIGNORE],
    ['.vx/.gitattributes', DOT_VX_GITATTRIBUTES],
  ] as const) {
    if (!existsSync(path.join(root, name))) files.push({ path: name, contents })
  }
  const vx = vxInvocation(process.env['npm_config_user_agent'], false)
  const next = `${noGit ? 'git init, ' : ''}declare a task in ${kept.find((f) => f.startsWith('vx.config.')) ?? config}, then ${vx} lock && ${vx} run <task>`
  if (args.json === true) {
    process.stdout.write(
      `${JSON.stringify({ dry: true, source: 'no package.json', files, kept, replaced, todos: [], notes: [], next })}\n`,
    )
    return 0
  }
  const rows: ui.FieldRow[] = [['from', 'no package.json: one project, the root']]
  if (args.dry) rows.push(['dry run', 'nothing written'])
  if (files.length > 0) rows.push(['files', ...files.map((f) => f.path)])
  if (kept.length > 0) rows.push(['kept', ...kept])
  if (replaced.length > 0) rows.push(['replaced', ...replaced])
  if (args.dry) {
    for (const f of files) process.stdout.write(`── ${f.path} ──\n${f.contents}\n`)
    ui.print('out', ui.report(`vx init ${VERSION}`, [...rows, null, ['next', next]]))
    return 0
  }
  for (const f of files) await Bun.write(path.join(root, f.path), f.contents)
  for (const f of replaced) await unlink(path.join(root, f))
  // The lock that follows loads the workspace file just written.
  workspaceFileWritten()
  const lock = await lockAfterMigration(root)
  rows.push(['lock', lock.code === 0 ? lock.said.replace(/^locked /, '') : 'not written'], null, [
    'next',
    lock.code === 0 ? next : `fix the above, then vx lock and ${next}`,
  ])
  ui.print('out', ui.report(`vx init ${VERSION}`, rows))
  return 0
}

/**
 * A repo with a package.json is `@vzn/vx-migrate`'s, at the latest
 * release: it installs @vzn/vx and every @vzn/vx-* plugin the root lists
 * at its own version, so init always lands on latest with all of them
 * together, as `vx upgrade` moves them (M, 2026-10-16: an installed 0.0.637
 * pinned core back from 0.0.639). It finds the root itself, asks a
 * terminal native or keep in a Turbo or Nx repo, and installs what it writes.
 */
async function migrate(dirs: readonly string[], args: InitArgs): Promise<number> {
  const flags = [
    args.dry && '--dry',
    args.force && '--force',
    args.mjs && '--mjs',
    args.mode !== undefined && `--${args.mode}`,
    args.json === true && '--format=json',
  ].filter((f): f is string => typeof f === 'string')
  // An exact version: `bun x` may answer `@latest` from its cache.
  const latest = VERSION === '0.0.0' ? 'latest' : await targetVersion(undefined, 'vx init')
  return Bun.spawn(migrateCommand(dirs, flags, latest), {
    stdio: ['inherit', 'inherit', 'inherit'],
    // A compiled vx is a Bun runtime only when told so.
    env: isCompiledBinary() ? { ...process.env, BUN_BE_BUN: '1' } : process.env,
  }).exited
}

export function migrateCommand(
  dirs: readonly string[],
  flags: readonly string[],
  latest: string,
  running = VERSION,
): string[] {
  // A source checkout (0.0.0, which npm never had) runs the vx-migrate
  // beside it; a release never runs an installed one.
  if (running === '0.0.0') {
    for (const d of dirs) {
      const installed = path.join(d, 'node_modules', '@vzn', 'vx-migrate', 'src', 'bin.ts')
      if (existsSync(installed)) return [process.execPath, '--no-install', installed, ...flags]
    }
  }
  // Bun's own install output ("Slow filesystem detected…") in a pnpm or npm
  // repo reads as a stranger speaking (Growth's first-run funnel F2).
  return [process.execPath, 'x', '--silent', `@vzn/vx-migrate@${latest}`, ...flags]
}
