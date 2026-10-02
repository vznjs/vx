// What a migrated Nx executor target runs as once Nx is gone: the plain
// command line the executor drives, read from each executor's source in
// Nx 23.2 (`@nx/jest`, `@nx/vitest`, `@nx/vite`, `@nx/eslint`, `@nx/js`,
// `@nx/playwright`). The `nx()` plugin keeps `nx-exec`; a written config
// is native vx, so an executor with no line here is a placeholder and a
// TODO naming it, never an `nx-exec` line that needs Nx installed.
//
// Where: each line runs where the executor ran its tool. Jest and
// Playwright run from the WORKSPACE ROOT with the options' paths as
// written (`cd ../.. && jest --config=libs/a/jest.config.ts`); Vite,
// Vitest, ESLint and tsc run from the project dir, as Nx sets the tool's
// root there, with the paths made project-relative. Both bins resolve:
// vx puts the project's and the root's `node_modules/.bin` on PATH.
//
// Defaults: the graph holds the options as written, and Nx applies the
// executor schema's defaults when it runs one, so a default that turns
// into a flag (`passWithNoTests` for Playwright, `lintFilePatterns`) is
// applied here. What an executor did besides its tool — a package.json
// copied into the output, a type-check before a Vite build, assets — is a
// TODO on the task, not a silent drop.

import { shellQuote } from '../nx-command.js'
import { relPosix } from '../paths.js'

export interface NativeContext {
  /** Project dir relative to the workspace root, `.` for the root. */
  readonly projectRel: string
  readonly projectName: string
}

export interface NativeCommand {
  readonly command: string
  readonly env: Readonly<Record<string, string>>
  readonly todos: readonly string[]
}

type Options = Readonly<Record<string, unknown>>
type Translate = (o: Options, ctx: NativeContext, todos: string[]) => NativeCommand['command']

/** The plain line for `executor`, or null when it has none here. */
export function nativeExecutorCommand(
  executor: string,
  options: Options,
  ctx: NativeContext,
): NativeCommand | null {
  const name = executor.startsWith('@nrwl/') ? `@nx/${executor.slice(6)}` : executor
  const translate = TRANSLATORS[name]
  if (translate === undefined) return null
  const todos: string[] = []
  const env: Record<string, string> = {}
  // Playwright's one env var; every other executor sets none the tool reads.
  if (name === '@nx/playwright:playwright' && typeof options['cacheDir'] === 'string')
    env['PWTEST_CACHE_DIR'] = options['cacheDir']
  return { command: translate(options, ctx, todos), env, todos }
}

/** The TODO an executor with no translator carries; one reason per executor, so the report lists its tasks. */
export function untranslatedTodo(executor: string): string {
  return `executor ${JSON.stringify(executor)} has no plain command here — replace the placeholder with the line it runs`
}

/** The placeholder an untranslated executor target runs: it fails, naming the executor and the options to translate. */
export function untranslatedPlaceholder(executor: string, options: Options): string {
  const opts = Object.keys(options).length > 0 ? ` with ${JSON.stringify(options)}` : ''
  return `echo ${shellQuote(`TODO(vx-migrate): the command ${executor} ran${opts}`)} >&2 && exit 1`
}

/** Nx's option tokens, as `resolveNxTokensInOptions` fills them, to a workspace-relative path. */
function wsPath(p: string, ctx: NativeContext): string {
  const filled = p
    .replaceAll('{workspaceRoot}/', '')
    .replaceAll('{workspaceRoot}', '.')
    .replaceAll('{projectRoot}', ctx.projectRel)
    .replaceAll('{projectName}', ctx.projectName)
  return filled.startsWith('/') ? filled : filled.replace(/^\.\//, '') || '.'
}

/** A workspace-relative option path as the project dir sees it. */
function projPath(p: string, ctx: NativeContext): string {
  const ws = wsPath(p, ctx)
  if (ws.startsWith('/')) return ws
  return relPosix(ctx.projectRel, ws) || '.'
}

/** `cd` to the workspace root, for a tool Nx ran there. */
function fromRoot(ctx: NativeContext, line: string): string {
  return ctx.projectRel === '.' ? line : `cd ${relPosix(ctx.projectRel, '.')} && ${line}`
}

/**
 * One option as flags, the way yargs-style CLIs read them: `true` is the
 * bare flag, `false` and null nothing, a list one flag per item. An object
 * has no flag spelling; the caller's todo names it.
 */
function flag(name: string, value: unknown, todos: string[], executor: string): string[] {
  if (value === true) return [`--${name}`]
  if (value === false || value === null || value === undefined) return []
  if (typeof value === 'string' || typeof value === 'number')
    return [`--${name}=${shellQuote(String(value))}`]
  if (Array.isArray(value) && value.every((v) => typeof v === 'string' || typeof v === 'number'))
    return value.map((v) => `--${name}=${shellQuote(String(v))}`)
  todos.push(`${executor} option ${JSON.stringify(name)} is not a flag value — not carried`)
  return []
}

const kebab = (s: string): string => s.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()

const JEST_RENAMED = new Set([
  'jestConfig',
  'codeCoverage',
  'testFile',
  'findRelatedTests',
  'tsConfig',
])

/** `@nx/jest:jest`: `runCLI` from the workspace root; every other option is jest's own flag. */
const jest: Translate = (o, ctx, todos) => {
  const args = ['jest']
  if (typeof o['jestConfig'] === 'string')
    args.push(`--config=${shellQuote(wsPath(o['jestConfig'], ctx))}`)
  if (o['codeCoverage'] === true) args.push('--coverage')
  for (const [k, v] of Object.entries(o)) {
    if (JEST_RENAMED.has(k)) continue
    // Nx resolves it from the workspace root, where this line runs.
    const value = k === 'coverageDirectory' && typeof v === 'string' ? wsPath(v, ctx) : v
    args.push(...flag(k, value, todos, '@nx/jest:jest'))
  }
  if (typeof o['findRelatedTests'] === 'string') {
    args.push('--findRelatedTests')
    for (const f of o['findRelatedTests'].split(',')) args.push(shellQuote(f.trim()))
  }
  if (typeof o['testFile'] === 'string') args.push(shellQuote(o['testFile']))
  return fromRoot(ctx, args.join(' '))
}

const VITEST_OWN = new Set([
  'configFile',
  'reportsDirectory',
  'mode',
  'runMode',
  'testFiles',
  'watch',
])

/** `@nx/vitest:test` (and `@nx/vite:test`): vitest rooted at the project, run once unless `watch`. */
const vitest: Translate = (o, ctx, todos) => {
  const verb = o['runMode'] === 'benchmark' ? 'bench' : o['watch'] === true ? 'watch' : 'run'
  const args = ['vitest', verb]
  if (typeof o['configFile'] === 'string')
    args.push(`--config=${shellQuote(projPath(o['configFile'], ctx))}`)
  if (typeof o['mode'] === 'string') args.push(`--mode=${shellQuote(o['mode'])}`)
  if (typeof o['reportsDirectory'] === 'string')
    args.push(`--coverage.reportsDirectory=${shellQuote(projPath(o['reportsDirectory'], ctx))}`)
  for (const [k, v] of Object.entries(o)) {
    if (!VITEST_OWN.has(k)) args.push(...flag(k, v, todos, '@nx/vitest:test'))
  }
  if (Array.isArray(o['testFiles']))
    for (const f of o['testFiles']) if (typeof f === 'string') args.push(shellQuote(f))
  return args.join(' ')
}

const VITE_BUILD_OWN = new Set([
  'configFile',
  'outputPath',
  'watch',
  'buildLibsFromSource',
  'skipTypeCheck',
  'tsConfig',
  'generatePackageJson',
  'includeDevDependenciesInPackageJson',
  'skipOverrides',
  'skipPackageManager',
  'useEnvironmentsApi',
])

/** `@nx/vite:build`: `vite build` rooted at the project, `outputPath` as `--outDir`. */
const viteBuild: Translate = (o, ctx, todos) => {
  const args = ['vite', 'build']
  if (typeof o['configFile'] === 'string')
    args.push(`--config=${shellQuote(projPath(o['configFile'], ctx))}`)
  if (typeof o['outputPath'] === 'string')
    args.push(`--outDir=${shellQuote(projPath(o['outputPath'], ctx))}`, '--emptyOutDir')
  if (o['watch'] === true) args.push('--watch')
  for (const [k, v] of Object.entries(o)) {
    if (!VITE_BUILD_OWN.has(k)) args.push(...flag(k, v, todos, '@nx/vite:build'))
  }
  if (o['skipTypeCheck'] !== true)
    todos.push(
      '@nx/vite:build type-checked the project before building (unless the workspace uses TS ' +
        'project references) — add a typecheck task to dependsOn, or drop this line',
    )
  if (o['generatePackageJson'] === true)
    todos.push('@nx/vite:build generated a package.json in the output dir — vite does not')
  else if (o['generatePackageJson'] !== false && ctx.projectRel !== '.')
    todos.push(
      "@nx/vite:build copied the project's package.json (if any) into the output dir — vite does not",
    )
  return args.join(' ')
}

/** ESLint options that are a bare flag when `true`; `false` is each one's default. */
const ESLINT_BOOLS: Readonly<Record<string, string>> = {
  fix: 'fix',
  cache: 'cache',
  quiet: 'quiet',
  noEslintrc: 'no-eslintrc',
  suppressAll: 'suppress-all',
}
/** ESLint options that are `--flag=value` (one per item for a list); `path` ones are workspace paths. */
const ESLINT_VALUES: Readonly<Record<string, { flag: string; path?: true; skip?: unknown }>> = {
  eslintConfig: { flag: 'config', path: true },
  format: { flag: 'format', skip: 'stylish' },
  outputFile: { flag: 'output-file', path: true },
  cacheStrategy: { flag: 'cache-strategy', skip: 'metadata' },
  ignorePath: { flag: 'ignore-path', path: true },
  resolvePluginsRelativeTo: { flag: 'resolve-plugins-relative-to', path: true },
  reportUnusedDisableDirectives: { flag: 'report-unused-disable-directives-severity' },
  suppressionsLocation: { flag: 'suppressions-location', path: true },
  printConfig: { flag: 'print-config', path: true },
  maxWarnings: { flag: 'max-warnings', skip: -1 },
  rulesdir: { flag: 'rulesdir', path: true },
  suppressRule: { flag: 'suppress-rule' },
}
/** Handled below, or nothing ESLint reads (`silent` only quiets Nx's own banner). */
const ESLINT_OWN = new Set([
  'lintFilePatterns',
  'force',
  'cacheLocation',
  'errorOnUnmatchedPattern',
  'silent',
  'hasTypeAwareRules',
])

/** `@nx/eslint:lint`: `eslint` from the project dir, as Nx's own inferred lint target runs it. */
const eslint: Translate = (o, ctx, todos) => {
  const args = ['eslint']
  for (const [k, v] of Object.entries(o)) {
    if (ESLINT_OWN.has(k)) continue
    const bool = ESLINT_BOOLS[k]
    const value = ESLINT_VALUES[k]
    if (bool !== undefined) {
      if (v === true) args.push(`--${bool}`)
    } else if (value !== undefined) {
      if (v === value.skip) continue
      const items = Array.isArray(v) ? v : [v]
      for (const x of items) {
        if (typeof x === 'string')
          args.push(`--${value.flag}=${shellQuote(value.path ? projPath(x, ctx) : x)}`)
        else if (typeof x === 'number') args.push(`--${value.flag}=${x}`)
      }
    } else
      todos.push(`@nx/eslint:lint option ${JSON.stringify(k)} has no eslint flag — not carried`)
  }
  if (typeof o['cacheLocation'] === 'string')
    args.push(
      `--cache-location=${shellQuote(`${projPath(o['cacheLocation'], ctx)}/${ctx.projectName}`)}`,
    )
  if (o['errorOnUnmatchedPattern'] === false) args.push('--no-error-on-unmatched-pattern')
  const patterns = Array.isArray(o['lintFilePatterns']) ? o['lintFilePatterns'] : ['{projectRoot}']
  for (const p of patterns) if (typeof p === 'string') args.push(shellQuote(projPath(p, ctx)))
  const line = args.join(' ')
  // `force`: Nx reported the errors and passed the task.
  return o['force'] === true ? `${line} || true` : line
}

/** `@nx/js:tsc`: tsc over the project's tsconfig into `outputPath`, `rootDir` the project. */
const tsc: Translate = (o, ctx, todos) => {
  const args = ['tsc']
  if (typeof o['tsConfig'] === 'string') args.push('-p', shellQuote(projPath(o['tsConfig'], ctx)))
  const out =
    typeof o['outputPath'] === 'string' ? shellQuote(projPath(o['outputPath'], ctx)) : undefined
  if (out !== undefined) args.push('--outDir', out)
  args.push(
    '--rootDir',
    shellQuote(typeof o['rootDir'] === 'string' ? projPath(o['rootDir'], ctx) : '.'),
  )
  if (o['watch'] === true) args.push('--watch')
  if (Array.isArray(o['assets']) && o['assets'].length > 0)
    todos.push('@nx/js:tsc copied `assets` into the output dir — tsc does not; add a copy step')
  if (o['generatePackageJson'] !== false)
    todos.push(
      '@nx/js:tsc wrote a package.json (main, types, exports) into the output dir — tsc does not',
    )
  if (Array.isArray(o['transformers']) && o['transformers'].length > 0)
    todos.push('@nx/js:tsc ran `transformers` — plain tsc has no transformer hook')
  const line = args.join(' ')
  // `clean` (default true): Nx emptied the output dir first.
  return out !== undefined && o['clean'] !== false ? `rm -rf ${out} && ${line}` : line
}

/** `@nx/playwright:playwright`: `playwright test` from the workspace root, options as kebab flags. */
const playwright: Translate = (o, ctx, todos) => {
  const args = ['playwright', 'test']
  if (Array.isArray(o['testFiles']))
    for (const f of o['testFiles']) if (typeof f === 'string') args.push(shellQuote(f))
  // The schema's one `true` default, applied by Nx before it builds the argv.
  const opts: Record<string, unknown> = { passWithNoTests: true, ...o }
  for (const [k, v] of Object.entries(opts)) {
    if (k === 'testFiles' || k === 'skipInstall' || k === 'cacheDir') continue
    const value = Array.isArray(v) ? v.map((x) => (typeof x === 'string' ? x.trim() : x)) : v
    args.push(...flag(kebab(k), value, todos, '@nx/playwright:playwright'))
  }
  const line = args.join(' ')
  // `skipInstall` false (the default): Nx ran `playwright install` first.
  return fromRoot(ctx, o['skipInstall'] === true ? line : `playwright install && ${line}`)
}

const TRANSLATORS: Readonly<Record<string, Translate>> = {
  '@nx/jest:jest': jest,
  '@nx/vitest:test': vitest,
  '@nx/vite:test': vitest,
  '@nx/vite:build': viteBuild,
  '@nx/eslint:lint': eslint,
  '@nx/linter:eslint': eslint,
  '@nx/js:tsc': tsc,
  '@nx/playwright:playwright': playwright,
}
