// @vzn/vx-infer — tasks a package does not have to write.
//
// Fills the `project` stage (docs/design/pipeline-2026-09.md): every
// package the workspace discovers is visited, a package with no
// vx.config as `{ tasks: {} }`, and each plugin here looks at what the
// package uses — its `package.json` scripts, a `vite.config`, a
// `vitest.config`, a `next.config`, a `tsconfig.json` — and gives it the
// tasks that tool implies, with cache blocks that fit the tool. A task
// the package declares itself always wins; the plugins fill, never
// overwrite. Nothing is inferred about the sandbox: what a task may
// touch is the package's own declaration, never a guess.
//
// This is the seam Nx calls inferred tasks and Turbo does not have. It
// is a plugin family, not core: core names no tool.
//
// Imports core only through the public `@vzn/vx` specifier.
import { existsSync } from 'node:fs'
import path from 'node:path'
import { definePlugin, type ProjectConfig, type TaskConfig, type VxPlugin } from '@vzn/vx'

type Tasks = Record<string, TaskConfig>
type Ctx = {
  readonly name: string
  readonly dir: string
  readonly packageJson: Readonly<Record<string, unknown>>
}

/** Add each task the package does not declare; the package's own wins. */
function fill(config: ProjectConfig, tasks: Tasks): void {
  config.tasks ??= {}
  for (const [name, task] of Object.entries(tasks)) {
    // A copy per fill: the stage hands core an object it owns and edits
    // in place, and this plugin outlives one run (the watch shape).
    config.tasks[name] ??= structuredClone(task)
  }
}

/** The first of `names` that exists in `dir`, as a root-relative glob list for inputs. */
function present(dir: string, names: readonly string[]): string | undefined {
  return names.find((n) => existsSync(path.join(dir, n)))
}

const CONFIG_EXTS = ['ts', 'mts', 'js', 'mjs', 'cjs', 'cts'] as const
const configNames = (base: string): string[] => CONFIG_EXTS.map((e) => `${base}.${e}`)

/** Whether the package's manifest names `dep` anywhere a tool would be installed from. */
function depends(packageJson: Readonly<Record<string, unknown>>, dep: string): boolean {
  for (const field of [
    'dependencies',
    'devDependencies',
    'peerDependencies',
    'optionalDependencies',
  ]) {
    const deps = packageJson[field]
    if (deps !== null && typeof deps === 'object' && dep in (deps as object)) return true
  }
  return false
}

// --- scripts -----------------------------------------------------------------

export interface ScriptsOptions {
  /**
   * Scripts to skip. `pre*` / `post*` lifecycle scripts are always skipped
   * (the package manager runs them around their script); so are `install`
   * hooks. Default: none beyond those.
   */
  readonly exclude?: readonly string[]
}

const LIFECYCLE =
  /^(pre|post)(install|pack|publish|prepare|test|build|[a-z]+)$|^(prepare|install|prepublishOnly)$/

/**
 * Every `package.json` script is a task, **uncached**: a script says what
 * to run and nothing about what it reads or writes, and a cache key with
 * guessed inputs is a stale hit waiting to happen. A `build` script gets
 * `dependsOn: ['^build']`, the workspace convention; a `dev` / `start` /
 * `serve` / `watch` script is persistent. Add a `cache` block in the
 * package's own vx.config the day the task earns one — that declaration
 * replaces this one whole.
 */
export function scripts(options: ScriptsOptions = {}): VxPlugin {
  const exclude = new Set(options.exclude ?? [])
  return definePlugin(import.meta, {
    project(config: ProjectConfig, ctx: Ctx) {
      const raw = ctx.packageJson['scripts']
      if (raw === null || typeof raw !== 'object') return
      const tasks: Tasks = {}
      for (const [name, command] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof command !== 'string' || command.length === 0) continue
        if (exclude.has(name) || LIFECYCLE.test(name)) continue
        const persistent = /^(dev|start|serve|watch)(:|$)/.test(name)
        tasks[name] = {
          description: `package.json script (inferred by @vzn/vx-infer)`,
          exec: { command, ...(persistent ? { persistent: {} } : {}) },
          ...(name === 'build' ? { dependsOn: ['^build'] } : {}),
        }
      }
      fill(config, tasks)
    },
  })
}

// --- vite --------------------------------------------------------------------

export interface ViteOptions {
  /** Where `vite build` writes. Default `dist`. */
  readonly outDir?: string
}

/**
 * A package with a `vite.config.*` gets `build` (cached: sources, the
 * config, `index.html`, `public/`; output `dist/`), `dev` (persistent,
 * ready when vite prints its local URL) and `preview` (persistent, after
 * `build`).
 */
export function vite(options: ViteOptions = {}): VxPlugin {
  const outDir = options.outDir ?? 'dist'
  return definePlugin(import.meta, {
    project(config: ProjectConfig, ctx: Ctx) {
      const cfg = present(ctx.dir, configNames('vite.config'))
      if (cfg === undefined) return
      fill(config, {
        build: {
          description: 'vite build (inferred by @vzn/vx-infer)',
          dependsOn: ['^build'],
          exec: { command: 'vite build' },
          cache: {
            inputs: {
              files: [
                'src/**',
                'public/**',
                'index.html',
                cfg,
                'tsconfig*.json',
                'package.json',
                '.env',
                '.env.*',
              ],
            },
            outputs: { files: [`${outDir}/**`] },
          },
        },
        dev: {
          description: 'vite dev server (inferred by @vzn/vx-infer)',
          dependsOn: ['^build'],
          exec: { command: 'vite', persistent: { readyWhen: 'Local:' } },
        },
        preview: {
          description: 'vite preview of the built site (inferred by @vzn/vx-infer)',
          dependsOn: ['build'],
          exec: { command: 'vite preview', persistent: { readyWhen: 'Local:' } },
        },
      })
    },
  })
}

// --- vitest ------------------------------------------------------------------

/**
 * A package with a `vitest.config.*`, or a `vite.config.*` and vitest in
 * its manifest, gets `test` (`vitest run`, cached on sources, tests and
 * both configs; no outputs).
 */
export function vitest(): VxPlugin {
  return definePlugin(import.meta, {
    project(config: ProjectConfig, ctx: Ctx) {
      const own = present(ctx.dir, configNames('vitest.config'))
      const viaVite =
        own === undefined && depends(ctx.packageJson, 'vitest')
          ? present(ctx.dir, configNames('vite.config'))
          : undefined
      const cfg = own ?? viaVite
      if (cfg === undefined) return
      fill(config, {
        test: {
          description: 'vitest run (inferred by @vzn/vx-infer)',
          dependsOn: ['^build'],
          exec: { command: 'vitest run' },
          cache: {
            inputs: {
              files: [
                'src/**',
                'test/**',
                'tests/**',
                '__tests__/**',
                cfg,
                'tsconfig*.json',
                'package.json',
              ],
            },
            outputs: { files: [] },
          },
        },
      })
    },
  })
}

// --- next --------------------------------------------------------------------

/**
 * A package with a `next.config.*` gets `build` (cached: `app/`, `pages/`,
 * `src/`, `public/`, the config and env files; outputs: what `.next/`
 * holds besides Next's own `cache/`), `dev` (persistent, ready when next prints its local URL) and
 * `start` (persistent, after `build`).
 */
export function next(): VxPlugin {
  return definePlugin(import.meta, {
    project(config: ProjectConfig, ctx: Ctx) {
      const cfg = present(ctx.dir, configNames('next.config'))
      if (cfg === undefined) return
      fill(config, {
        build: {
          description: 'next build (inferred by @vzn/vx-infer)',
          dependsOn: ['^build'],
          exec: { command: 'next build' },
          cache: {
            inputs: {
              files: [
                'app/**',
                'pages/**',
                'src/**',
                'public/**',
                'components/**',
                'lib/**',
                'styles/**',
                cfg,
                'tsconfig*.json',
                'package.json',
                '.env',
                '.env.*',
              ],
            },
            // Not `.next/**`: `.next/cache` is Next's own incremental cache,
            // which a build reads and which must survive between builds — an
            // output is wiped before exec. The build's product is the rest.
            outputs: {
              files: [
                '.next/server/**',
                '.next/static/**',
                '.next/types/**',
                '.next/BUILD_ID',
                '.next/*.json',
                '.next/trace',
              ],
            },
          },
        },
        dev: {
          description: 'next dev server (inferred by @vzn/vx-infer)',
          dependsOn: ['^build'],
          exec: { command: 'next dev', persistent: { readyWhen: 'Local:' } },
        },
        start: {
          description: 'next start on the built app (inferred by @vzn/vx-infer)',
          dependsOn: ['build'],
          exec: { command: 'next start', persistent: { readyWhen: 'Local:' } },
        },
      })
    },
  })
}

// --- tsc ---------------------------------------------------------------------

export interface TscOptions {
  /** The task name. Default `typecheck`. */
  readonly task?: string
  /** The tsconfig to check. Default `tsconfig.json`. */
  readonly project?: string
}

/**
 * A package with a `tsconfig.json` (and TypeScript in its manifest) gets
 * `typecheck` (`tsc --noEmit -p tsconfig.json`, cached on every TS file
 * and tsconfig; no outputs). `noEmit` on purpose: a build that emits is
 * the package's own task to declare, with its outputs.
 */
export function tsc(options: TscOptions = {}): VxPlugin {
  const task = options.task ?? 'typecheck'
  const project = options.project ?? 'tsconfig.json'
  return definePlugin(import.meta, {
    project(config: ProjectConfig, ctx: Ctx) {
      if (!existsSync(path.join(ctx.dir, project)) || !depends(ctx.packageJson, 'typescript'))
        return
      fill(config, {
        [task]: {
          description: `tsc --noEmit (inferred by @vzn/vx-infer)`,
          dependsOn: ['^build'],
          exec: { command: `tsc --noEmit -p ${project}` },
          cache: {
            inputs: {
              files: [
                '**/*.ts',
                '**/*.tsx',
                '**/*.mts',
                '**/*.cts',
                'tsconfig*.json',
                'package.json',
              ],
            },
            outputs: { files: [] },
          },
        },
      })
    },
  })
}
