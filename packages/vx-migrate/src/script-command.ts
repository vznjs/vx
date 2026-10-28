// The command a package.json script becomes. Inlining the body is the
// rule — one process less per task than `<pm> run <name>` — with two npm
// conventions mapped rather than lost, the way core's `vx init` maps
// them (workspace/migrate-scripts.ts):
//
// - `pre<name>` / `post<name>` hooks, which npm and pnpm run around
//   `<name>` without being asked, are folded into the command in that
//   order (novu's `prebuild` copies the CSS its `build` inlines,
//   2026-09-11; Nx and Turbo run `pnpm run build`, so they get the hooks
//   for free). Lifecycle hooks of the package manager's own verbs
//   (`preinstall`, `prepublishOnly`, …) never ride inside a task.
// - yarn ≥ 2 runs scripts in its own shell, where `run` is a builtin
//   (`run -T rollup -c` is "the root's rollup", `run build:code` the
//   sibling script); inlined into sh that body is `run: command not
//   found` in every strapi package (2026-09-11), so such a script runs
//   through `yarn run <name>`, exactly as Nx and Turbo run it — and yarn
//   ≥ 2 runs no pre/post hooks, so none are folded there either.
// - A Yarn Plug'n'Play workspace has no node_modules: a dependency's
//   `require` resolves only through `.pnp.cjs` and its bins only through
//   the shims `yarn run` writes, so inlined, `node -e "require('left-pad')"`
//   was MODULE_NOT_FOUND (2026-09-28). Every script runs as `yarn run <name>`.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { foldScriptHooks } from '@vzn/vx'

const YARN_RUN_BUILTIN = /(^|&&|\|\||;|\(|\|)\s*run\s/
const LIFECYCLE = /^(pre|post)(install|publish|pack|version)$|^(prepare|prepublishOnly|install)$/

function usable(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0
}

export function scriptCommand(
  name: string,
  body: string,
  scripts: Readonly<Record<string, unknown>> = {},
  pnp = false,
  /** `runsScriptHooks`: false where the manager runs no `pre` / `post` hook. */
  hooks = true,
): string {
  if (pnp) return `yarn run ${name}`
  const hook = (h: string): string | undefined =>
    hooks && !LIFECYCLE.test(h) && usable(scripts[h]) ? scripts[h] : undefined
  const parts = [hook(`pre${name}`), body, hook(`post${name}`)]
  if (parts.some((p) => p !== undefined && YARN_RUN_BUILTIN.test(p))) return `yarn run ${name}`
  return foldScriptHooks(parts[0], body, parts[2])
}

/**
 * Yarn ≥ 2 links Plug'n'Play unless `.yarnrc.yml` names another `nodeLinker`.
 * Read once per mapping; synchronous so every mapper, the synchronous ones
 * included, can ask it.
 */
export function yarnPnp(root: string): boolean {
  let rc: string
  try {
    rc = readFileSync(path.join(root, '.yarnrc.yml'), 'utf8')
  } catch {
    return false
  }
  const linker = /^nodeLinker:[ \t]*["']?([\w-]+)/m.exec(rc)?.[1]
  return linker === undefined || linker === 'pnp'
}

/** `.yarnrc.yml` as a mapping cache reads it: `yarnPnp` decides every script command from it. */
export async function yarnrcText(root: string): Promise<string> {
  return Bun.file(path.join(root, '.yarnrc.yml'))
    .text()
    .catch(() => '\0absent')
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
export function runsScriptHooks(dir: string, memo: Map<string, Owner>): string | null {
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
          ? !set('enable-pre-post-scripts', 'false') && !pnpmSkipsHooks(read('pnpm-workspace.yaml'))
          : true
  return runs ? manager : null
}

/**
 * `enablePrePostScripts: false` in `pnpm-workspace.yaml`, read as pnpm reads
 * it, as YAML: a line regex missed `false # hooks off` and a flow mapping,
 * which pnpm 10 honours, and folded hooks pnpm does not run.
 */
function pnpmSkipsHooks(yaml: string | undefined): boolean {
  if (yaml === undefined) return false
  try {
    const parsed = Bun.YAML.parse(yaml) as { enablePrePostScripts?: unknown } | null
    return parsed?.enablePrePostScripts === false
  } catch {
    return false
  }
}

/** The package manager that owns a directory, and the directory that says so. */
export interface Owner {
  manager: string
  at: string
}

/**
 * The nearest `packageManager` field or lockfile from `dir` up: `berry` for
 * Yarn 2+, `yarn` for Yarn 1, else the manager's name; none found is npm.
 */
export function ownerOf(dir: string, memo: Map<string, Owner>): Owner {
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
    // A byte-order mark is stripped, as npm, pnpm and discovery strip it:
    // JSON.parse threw on one and the field went unread.
    const manifest = (read('package.json') ?? '').replace(/^\uFEFF/, '')
    const pm = (JSON.parse(manifest) as { packageManager?: unknown }).packageManager
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
