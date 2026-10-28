// `vx init [--dry [--format json]] [--force] [--mjs] [--native|--keep]` — a workspace from nowhere.
// It installs vx globally and, where a package.json is, as its devDependency
// (2026-10-20). A Turbo or Nx repo is `@vzn/vx-migrate`'s, which maps it
// and installs what it writes (`migrate`); any other gets the workspace file
// and an empty root project, then the lock (`starter`).
// `vx init --plugin <seam>` writes a runnable plugin for one seam and its
// test instead (plugin-templates.ts, the examples the gate runs).

import { existsSync, readFileSync } from 'node:fs'
import { mkdir, unlink } from 'node:fs/promises'
import path from 'node:path'
import { gitTop, workspaceFileWritten } from '../handoff.js'
import { flagHint, formatValue, refuse, seeHelp } from './help.js'
import { lockAfterMigration } from './lock.js'
import { PLUGIN_TEMPLATES } from './plugin-templates.js'
import {
  isCompiledBinary,
  projectManager,
  startedVersion,
  targetVersion,
  upgradeArgv,
  type ManagedInstall,
} from './upgrade.js'
import { VERSION } from '../version.js'
import { DOT_VX_GITATTRIBUTES, DOT_VX_GITIGNORE, ui, UserError, sayNotice } from '../util/index.js'
import {
  findWorkspaceRoot,
  PROJECT_CONFIG_FILENAMES,
  STARTER_PROJECT,
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
          error: `--plugin takes a seam: one of ${seams}${seam === undefined || seam === '' ? '' : ` (got '${seam}')`}${seeHelp('init')}`,
        }
      }
      if (out.plugin !== undefined && out.plugin !== seam) {
        return {
          ...out,
          error: `--plugin takes one seam; run vx init --plugin once per seam${seeHelp('init')}`,
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
  if (dirs.some((d) => TOOL_CONFIGS.some((f) => existsSync(path.join(d, f))))) {
    return migrate(dirs, parsed)
  }
  // The topmost package.json: a monorepo's root, wherever below it init ran.
  const pkgRoot = dirs.findLast((d) => existsSync(path.join(d, 'package.json'))) ?? null
  return starter(marked ?? pkgRoot ?? cwd, pkgRoot, top === null, parsed)
}

/** What makes a repo vx-migrate's to map: a Turbo or Nx config. */
const TOOL_CONFIGS = ['turbo.json', 'turbo.jsonc', 'nx.json']

/**
 * The installs `vx init` runs (2026-10-20): vx at `version` globally,
 * with the manager that started init, so a bare `vx` is on PATH, unless
 * the global vx already answers `version`; and, where `pkgRoot` has a
 * package.json, as its devDependency with the repo's own manager.
 */
export function initInstalls(
  version: string,
  userAgent: string | undefined,
  pkgRoot: string | null,
  globalAt: string | undefined,
  execPath = process.execPath,
  plugins: readonly string[] = [],
): { argv: string[]; cwd: string | null }[] {
  const out: { argv: string[]; cwd: string | null }[] = []
  if (globalAt !== version) {
    // Yarn 2+ has no `yarn global`: Bun, which vx needs anyway, as with no runner.
    const ua = /^(npm|pnpm|yarn|bun)\/(\d+)/.exec(userAgent ?? '')
    const runner = ua === null || (ua[1] === 'yarn' && Number(ua[2]) >= 2) ? 'bun' : ua[1]!
    const manager = runner as ManagedInstall['manager']
    out.push({ argv: upgradeArgv({ manager, scope: 'global', cwd: '' }, version), cwd: null })
  }
  if (pkgRoot !== null) {
    const install: ManagedInstall = {
      manager: projectManager(pkgRoot, execPath),
      scope: 'project',
      cwd: pkgRoot,
      field: 'devDependencies',
      plugins: [...plugins],
    }
    out.push({ argv: upgradeArgv(install, version), cwd: pkgRoot })
  }
  return out
}

/** The version the global `vx` on PATH answers: not a runner's cache, not a project's bin. */
function globalVersion(): string | undefined {
  for (const dir of (process.env['PATH'] ?? '').split(path.delimiter)) {
    const p = dir.split(path.sep).join('/')
    if (p.includes('/_npx/') || /\/(bunx|dlx)-/.test(p) || p.includes('/node_modules/.bin'))
      continue
    const bin = path.join(dir, 'vx')
    if (existsSync(bin)) return startedVersion(bin)?.split(' ')[1]
  }
  return undefined
}

/**
 * The package a manager's output says the registry answered 404 for, as
 * `name@version`: a release's platform tarball stays unserved for minutes
 * after publish (v0.0.646, 2026-10-23). bun: `GET <url> - 404`; npm:
 * `404 Not Found - GET <url>`; pnpm: `GET <url>: Not Found - 404`.
 */
export function notServed(output: string): string | undefined {
  for (const line of output.split('\n')) {
    if (!line.includes('404')) continue
    const m = /https?:\/\/\S+?\/((?:@[^/\s]+\/)?[^/\s]+)\/-\/[^/\s]+?-(\d[^/\s]*?)\.tgz/.exec(line)
    if (m !== null) return `${decodeURIComponent(m[1]!)}@${m[2]}`
  }
  return undefined
}

/**
 * Run `initInstalls`, in order. A source checkout (0.0.0, which npm never
 * had) installs nothing: the release would replace the code under test.
 */
async function install(
  pkgRoot: string | null,
  dry: boolean,
  plugins: readonly string[] = [],
): Promise<string[]> {
  if (VERSION === '0.0.0') return []
  const version = await targetVersion(undefined, 'vx init')
  const steps = initInstalls(
    version,
    process.env['npm_config_user_agent'],
    pkgRoot,
    globalVersion(),
    process.execPath,
    plugins,
  )
  if (dry) return steps.map((s) => s.argv.join(' '))
  for (const s of steps) {
    const bin = Bun.which(s.argv[0]!, { PATH: process.env['PATH'] ?? '' })
    if (bin === null) {
      throw new UserError(
        `vx init: ${s.argv[0]} is not on PATH; run it yourself: ${s.argv.join(' ')}`,
      )
    }
    ui.print(
      'out',
      ui.text([ui.cmd(s.argv.join(' ')), ui.dim(s.cwd === null ? '' : ` in ${s.cwd}`)]),
    )
    const proc = Bun.spawn({
      cmd: [bin, ...s.argv.slice(1)],
      cwd: s.cwd ?? process.cwd(),
      stdio: ['inherit', 'inherit', 'pipe'],
    })
    // Shown as it comes, and kept: a registry 404 is the cause to name.
    let said = ''
    const decoder = new TextDecoder()
    for await (const chunk of proc.stderr) {
      process.stderr.write(chunk)
      said += decoder.decode(chunk, { stream: true })
    }
    const code = await proc.exited
    if (code !== 0) {
      const missing = notServed(said)
      throw new UserError(
        missing === undefined
          ? `vx init: ${s.argv.join(' ')} failed (exit ${code})`
          : `vx init: the npm registry does not serve ${missing} yet (404), as a release can take minutes to reach it; run bunx @vzn/vx init again`,
      )
    }
  }
  return steps.map((s) => s.argv.join(' '))
}

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

/**
 * The `@vzn/vx-lockfile` plugin the lockfile at `pkgRoot` calls for: without
 * it a JS workspace has no project edges, and the first `^build` a user
 * writes is refused at `vx lock`.
 */
function lockfilePlugin(pkgRoot: string | null): 'pnpm' | 'bun' | 'yarn' | 'npm' | null {
  if (pkgRoot === null) return null
  const has = (f: string): boolean => existsSync(path.join(pkgRoot, f))
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('bun.lock') || has('bun.lockb')) return 'bun'
  if (has('yarn.lock')) return 'yarn'
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return 'npm'
  return null
}

function workspaceSource(plugin: string | null): string {
  if (plugin === null)
    return "import { defineWorkspace } from '@vzn/vx'\n\nexport default defineWorkspace({ plugins: [] })\n"
  return `import { defineWorkspace } from '@vzn/vx'\nimport { ${plugin} } from '@vzn/vx-lockfile'\n\nexport default defineWorkspace({ plugins: [${plugin}()] })\n`
}

/**
 * Whether `pkgRoot` has package.json scripts to map: its own, or a
 * workspace's members (`workspaces`, `pnpm-workspace.yaml`). Core maps none
 * (2026-10-20), so `next` names the tool that does.
 */
function hasScripts(pkgRoot: string | null): boolean {
  if (pkgRoot === null) return false
  if (existsSync(path.join(pkgRoot, 'pnpm-workspace.yaml'))) return true
  try {
    const text = readFileSync(path.join(pkgRoot, 'package.json'), 'utf8').replace(/^﻿/, '')
    const pj = JSON.parse(text) as {
      scripts?: unknown
      workspaces?: unknown
    }
    return (
      pj.workspaces !== undefined ||
      (typeof pj.scripts === 'object' && pj.scripts !== null && Object.keys(pj.scripts).length > 0)
    )
  } catch {
    return false
  }
}

/**
 * No Turbo or Nx config: the installs, then `.vx/workspace.ts` declaring
 * no plugin and a root `vx.config.ts` with no task, then the lock.
 * `@vzn/vx` resolves to the running vx (core-alias.ts), so the two load
 * whatever got installed. A file already here is kept; `--force` replaces it.
 */
async function starter(
  root: string,
  pkgRoot: string | null,
  noGit: boolean,
  args: InitArgs,
): Promise<number> {
  if (args.mode !== undefined) {
    throw new UserError(
      `vx init: --${args.mode} answers a Turbo or Nx repo's question, and there is no turbo.json or nx.json here`,
    )
  }
  // A source checkout installs nothing, so it declares the plugin only where one is.
  const found = lockfilePlugin(pkgRoot)
  const plugin =
    found !== null &&
    (VERSION !== '0.0.0' ||
      existsSync(path.join(pkgRoot!, 'node_modules', '@vzn', 'vx-lockfile', 'package.json')))
      ? found
      : null
  const plugins = plugin === null ? [] : ['@vzn/vx-lockfile']
  const installs = args.json === true || args.dry ? await install(pkgRoot, true, plugins) : []
  const ext = args.mjs ? 'mjs' : 'ts'
  const config = `vx.config.${ext}`
  const files: { path: string; contents: string }[] = []
  const kept: string[] = []
  const replaced: string[] = []
  for (const [names, name, contents] of [
    [WORKSPACE_CONFIG_FILENAMES, `.vx/workspace.${ext}`, workspaceSource(plugin)],
    [PROJECT_CONFIG_FILENAMES, config, STARTER_PROJECT],
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
  const declare = `declare a task in ${kept.find((f) => f.startsWith('vx.config.')) ?? config}, then vx lock && vx run <task>`
  const next = `${noGit ? 'git init, ' : ''}${hasScripts(pkgRoot) ? `bunx @vzn/vx-migrate${args.mjs ? ' --mjs' : ''} to make package.json scripts tasks, or ${declare}` : declare}`
  if (args.json === true) {
    process.stdout.write(
      `${JSON.stringify({ dry: true, source: 'no turbo.json or nx.json', files, kept, replaced, todos: [], notes: [], next, installs })}\n`,
    )
    return 0
  }
  const rows: ui.FieldRow[] = [['from', 'no turbo.json or nx.json: one project, the root']]
  // The files are root-relative: a root above the cwd is named, or they read as written here.
  if (root !== process.cwd()) rows.push(['root', root])
  if (args.dry) rows.push(['dry run', 'nothing written'])
  if (installs.length > 0) rows.push(['install', ...installs])
  if (files.length > 0) rows.push(['files', ...files.map((f) => f.path)])
  if (kept.length > 0) rows.push(['kept', ...kept])
  if (replaced.length > 0) rows.push(['replaced', ...replaced])
  if (args.dry) {
    for (const f of files) process.stdout.write(`── ${f.path} ──\n${f.contents}\n`)
    ui.print('out', ui.report(`vx init ${VERSION}`, [...rows, null, ['next', next]]))
    return 0
  }
  const ran = await install(pkgRoot, false, plugins)
  if (ran.length > 0) rows.push(['installed', ...ran])
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
  // A run reads only the lock: init without one is not done, as vx-migrate exits.
  return lock.code === 0 ? 0 : 1
}

/**
 * A Turbo or Nx repo is `@vzn/vx-migrate`'s, after the global install, at the latest
 * release: it installs @vzn/vx and every @vzn/vx-* plugin the root lists
 * at its own version, so init always lands on latest with all of them
 * together, as `vx upgrade` moves them (2026-10-16: an installed 0.0.637
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
  // vx-migrate installs the project's own vx.
  if (!args.dry) await install(null, false)
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
