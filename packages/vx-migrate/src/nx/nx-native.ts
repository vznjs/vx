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
  /** A `project:target[:configuration]` spec's options (a server's `buildTarget`). */
  readonly targetOptions?: (spec: string) => Options | undefined
}

export interface NativeCommand {
  readonly command: string
  readonly env: Readonly<Record<string, string>>
  readonly todos: readonly string[]
}

type Options = Readonly<Record<string, unknown>>
/** The line, or null when this target's options have no plain form (a Next custom server). */
type Translate = (
  o: Options,
  ctx: NativeContext,
  todos: string[],
  env: Record<string, string>,
) => string | null

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
  const command = translate(options, ctx, todos, env)
  return command === null ? null : { command, env, todos }
}

/** The TODO an executor with no translator carries; one reason per executor, so the report lists its tasks. */
export function untranslatedTodo(executor: string): string {
  const head = `executor ${JSON.stringify(executor)} has no plain command here — `
  const plugin = executor.replace(/^@nrwl\//, '@nx/').split(':')[0]!
  return CONVERTS_TO_INFERRED.has(plugin)
    ? `${head}\`nx g ${plugin}:convert-to-inferred\` rewrites it as the command Nx infers; ` +
        'run it and migrate again, or replace the placeholder with the line it runs'
    : `${head}replace the placeholder with the line it runs`
}

/**
 * The Nx plugins that ship a `convert-to-inferred` generator (Nx 23.2):
 * it turns an executor target into the inferred one, whose graph entry is
 * the tool's own command, which this migrator writes as it is. Webpack's
 * and Rollup's executors hand their options to the project's config
 * function, so no flag line reproduces them: the generator moves them
 * into the config.
 */
const CONVERTS_TO_INFERRED: ReadonlySet<string> = new Set([
  '@nx/cypress',
  '@nx/eslint',
  '@nx/jest',
  '@nx/next',
  '@nx/playwright',
  '@nx/rollup',
  '@nx/storybook',
  '@nx/vite',
  '@nx/vitest',
  '@nx/webpack',
])

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
const playwright: Translate = (o, ctx, todos, env) => {
  if (typeof o['cacheDir'] === 'string') env['PWTEST_CACHE_DIR'] = o['cacheDir']
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

/**
 * Each listed option as its CLI flag, through `flag`; an option the map
 * lacks is a TODO naming it, as the executor handed it to the tool.
 */
function mappedFlags(
  o: Options,
  flags: Readonly<Record<string, string>>,
  skip: ReadonlySet<string>,
  todos: string[],
  executor: string,
  where: string,
): string[] {
  const out: string[] = []
  for (const [k, v] of Object.entries(o)) {
    if (skip.has(k)) continue
    const name = flags[k]
    if (name !== undefined) out.push(...flag(name, v, todos, executor))
    else
      todos.push(
        `${executor} option ${JSON.stringify(k)} has no ${where} flag — set it in ${where}'s config`,
      )
  }
  return out
}

/** A server's `buildTarget` options, or `{}` with a TODO when the graph has no such target. */
function buildTargetOptions(
  o: Options,
  ctx: NativeContext,
  todos: string[],
  executor: string,
): Options {
  const spec = o['buildTarget']
  if (typeof spec !== 'string') return {}
  const found = ctx.targetOptions?.(spec)
  if (found === undefined)
    todos.push(
      `${executor}: buildTarget ${JSON.stringify(spec)} is not in the graph — its configFile and mode are not read`,
    )
  return found ?? {}
}

/** Vite's server and preview flags; the rest of Vite's server options live in its config. */
const VITE_SERVE_FLAGS: Readonly<Record<string, string>> = {
  port: 'port',
  host: 'host',
  strictPort: 'strictPort',
  open: 'open',
  cors: 'cors',
  mode: 'mode',
  base: 'base',
  force: 'force',
}

/**
 * `@nx/vite:dev-server`: `vite` (serve) rooted at the project, on the
 * build target's config file and mode, the server options as flags.
 */
const viteDev: Translate = (o, ctx, todos) => {
  const build = buildTargetOptions(o, ctx, todos, '@nx/vite:dev-server')
  const args = ['vite']
  if (typeof build['configFile'] === 'string')
    args.push(`--config=${shellQuote(projPath(build['configFile'], ctx))}`)
  const opts: Record<string, unknown> =
    typeof build['mode'] === 'string' && o['mode'] === undefined
      ? { ...o, mode: build['mode'] }
      : { ...o }
  if (typeof opts['proxyConfig'] === 'string')
    todos.push(
      '@nx/vite:dev-server loaded `proxyConfig` as server.proxy — move it into the vite config',
    )
  args.push(
    ...mappedFlags(
      opts,
      VITE_SERVE_FLAGS,
      new Set(['buildTarget', 'buildLibsFromSource', 'proxyConfig']),
      todos,
      '@nx/vite:dev-server',
      'vite',
    ),
  )
  return args.join(' ')
}

/**
 * `@nx/vite:preview-server`: `vite preview` over the build target's
 * output dir (or `staticFilePath`, read from the project dir as Nx does).
 */
const vitePreview: Translate = (o, ctx, todos) => {
  const build = buildTargetOptions(o, ctx, todos, '@nx/vite:preview-server')
  const args = ['vite', 'preview']
  if (typeof build['configFile'] === 'string')
    args.push(`--config=${shellQuote(projPath(build['configFile'], ctx))}`)
  const outDir =
    typeof o['staticFilePath'] === 'string'
      ? o['staticFilePath']
      : typeof build['outputPath'] === 'string'
        ? projPath(build['outputPath'], ctx)
        : undefined
  if (outDir !== undefined) args.push(`--outDir=${shellQuote(outDir)}`)
  const opts: Record<string, unknown> =
    typeof build['mode'] === 'string' && o['mode'] === undefined
      ? { ...o, mode: build['mode'] }
      : { ...o }
  if (typeof opts['proxyConfig'] === 'string')
    todos.push(
      '@nx/vite:preview-server loaded `proxyConfig` as preview.proxy — move it into the vite config',
    )
  args.push(
    ...mappedFlags(
      opts,
      VITE_SERVE_FLAGS,
      new Set(['buildTarget', 'proxyConfig', 'staticFilePath', 'watch']),
      todos,
      '@nx/vite:preview-server',
      'vite',
    ),
  )
  todos.push(
    '@nx/vite:preview-server built the app (in watch mode) before serving it — add its build task to dependsOn',
  )
  return args.join(' ')
}

/** Storybook's flags shared by `dev` and `build`, as its CLI spells them. */
const STORYBOOK_COMMON: Readonly<Record<string, string>> = {
  configDir: 'config-dir',
  loglevel: 'loglevel',
  quiet: 'quiet',
  docs: 'docs',
  docsMode: 'docs',
  webpackStatsJson: 'webpack-stats-json',
  debugWebpack: 'debug-webpack',
  disableTelemetry: 'disable-telemetry',
}

/** `configDir` and `outputDir` with Nx's tokens filled: Storybook reads them from the workspace root. */
function storybookPaths(o: Options, ctx: NativeContext): Options {
  const out: Record<string, unknown> = { ...o }
  for (const k of ['configDir', 'outputDir'])
    if (typeof out[k] === 'string') out[k] = wsPath(out[k], ctx)
  return out
}

/**
 * `@nx/storybook:storybook`: `storybook dev` from the workspace root,
 * where Nx hands the options to Storybook's own server; the schema's port
 * (9009) is applied, as Nx applies it, over Storybook's own 6006.
 */
const storybookDev: Translate = (o, ctx, todos) => {
  const opts: Record<string, unknown> = { port: 9009, ...storybookPaths(o, ctx) }
  if (opts['noOpen'] === true || opts['open'] === false) opts['noOpen'] = true
  const args = [
    'storybook',
    'dev',
    ...mappedFlags(
      opts,
      {
        ...STORYBOOK_COMMON,
        port: 'port',
        host: 'host',
        https: 'https',
        sslCa: 'ssl-ca',
        sslCert: 'ssl-cert',
        sslKey: 'ssl-key',
        ci: 'ci',
        smokeTest: 'smoke-test',
        previewUrl: 'preview-url',
        noOpen: 'no-open',
      },
      new Set(['open', 'uiFramework']),
      todos,
      '@nx/storybook:storybook',
      'storybook',
    ),
  ]
  return fromRoot(ctx, args.join(' '))
}

/** `@nx/storybook:build`: `storybook build` from the workspace root, `outputDir` as `--output-dir`. */
const storybookBuild: Translate = (o, ctx, todos) => {
  const args = [
    'storybook',
    'build',
    ...mappedFlags(
      storybookPaths(o, ctx),
      { ...STORYBOOK_COMMON, outputDir: 'output-dir' },
      new Set(['uiFramework']),
      todos,
      '@nx/storybook:build',
      'storybook',
    ),
  ]
  return fromRoot(ctx, args.join(' '))
}

/** Next's own build flags, as `createCliOptions` spells them. */
const NEXT_BUILD_FLAGS: Readonly<Record<string, string>> = {
  experimentalAppOnly: 'experimental-app-only',
  experimentalBuildMode: 'experimental-build-mode',
  profile: 'profile',
  debug: 'debug',
  turbo: 'turbo',
  webpack: 'webpack',
}

/**
 * `@nx/next:build`: `next build` in the project dir. `withNx` in the
 * project's next.config reads `NX_NEXT_OUTPUT_PATH`, which Nx set to
 * `outputPath`; what Nx wrote into `outputPath` after the build is a TODO.
 */
const nextBuild: Translate = (o, ctx, todos, env) => {
  const args = [
    'next',
    'build',
    ...mappedFlags(
      o,
      NEXT_BUILD_FLAGS,
      new Set([
        'outputPath',
        'nextConfig',
        'buildLibsFromSource',
        'includeDevDependenciesInPackageJson',
        'generateLockfile',
        'skipOverrides',
        'skipPackageManager',
        'fileReplacements',
      ]),
      todos,
      '@nx/next:build',
      'next',
    ),
  ]
  if (typeof o['outputPath'] === 'string') {
    const out = wsPath(o['outputPath'], ctx)
    env['NX_NEXT_OUTPUT_PATH'] = out
    todos.push(
      `@nx/next:build wrote a package.json (a \`next start\` script) into ${out}` +
        (out === ctx.projectRel ? '' : ', and copied next.config and public/ there') +
        ' — next build does not',
    )
  }
  if (Array.isArray(o['fileReplacements']) && o['fileReplacements'].length > 0)
    todos.push('@nx/next:build applied `fileReplacements` — next build has no such step')
  return args.join(' ')
}

/**
 * `@nx/next:server`: `next dev` in the project dir (`dev`, the default),
 * else `next start` in the build target's output dir; Nx's port 4200 and
 * `PORT` as Nx sets them. A custom server runs another target: no line.
 */
const nextServer: Translate = (o, ctx, todos, env) => {
  if (typeof o['customServerTarget'] === 'string') return null
  const port = typeof o['port'] === 'number' ? o['port'] : 4200
  env['PORT'] = String(port)
  const dev = o['dev'] !== false
  const args = ['next', dev ? 'dev' : 'start', `--port=${port}`]
  if (typeof o['hostname'] === 'string') args.push(`--hostname=${shellQuote(o['hostname'])}`)
  if (!dev && typeof o['keepAliveTimeout'] === 'number')
    args.push(`--keepAliveTimeout=${o['keepAliveTimeout']}`)
  if (dev && o['turbo'] === true) args.push('--turbo')
  if (dev && o['webpack'] === true) args.push('--webpack')
  if (o['experimentalHttps'] === true) args.push('--experimental-https')
  for (const [k, f] of [
    ['experimentalHttpsKey', 'experimental-https-key'],
    ['experimentalHttpsCert', 'experimental-https-cert'],
    ['experimentalHttpsCa', 'experimental-https-ca'],
  ] as const)
    if (typeof o[k] === 'string') args.push(`--${f}=${shellQuote(projPath(o[k], ctx))}`)
  const line = args.join(' ')
  if (dev) return line
  const build = buildTargetOptions(o, ctx, todos, '@nx/next:server')
  if (typeof build['outputPath'] !== 'string') {
    todos.push('@nx/next:server ran `next start` in its build target’s outputPath, which is unset')
    return line
  }
  return `cd ${shellQuote(projPath(build['outputPath'], ctx))} && ${line}`
}

/** Cypress's run flags with one spelling (`cypress run --help`). */
const CYPRESS_FLAGS: Readonly<Record<string, string>> = {
  browser: 'browser',
  spec: 'spec',
  tag: 'tag',
  headed: 'headed',
  headless: 'headless',
  record: 'record',
  key: 'key',
  parallel: 'parallel',
  ciBuildId: 'ci-build-id',
  group: 'group',
  reporter: 'reporter',
  quiet: 'quiet',
  autoCancelAfterFailures: 'auto-cancel-after-failures',
  reporterOptions: 'reporter-options',
}

/**
 * `@nx/cypress:cypress`: `cypress run` (`open` under `watch`) from the
 * workspace root, on the config file's directory as Nx passes it. A
 * dev server Nx started first is a TODO: vx runs it as a dependency.
 */
const cypress: Translate = (o, ctx, todos) => {
  const args = ['cypress', o['watch'] === true ? 'open' : 'run']
  if (typeof o['cypressConfig'] === 'string') {
    const cfg = wsPath(o['cypressConfig'], ctx)
    const slash = cfg.lastIndexOf('/')
    args.push(
      `--project=${shellQuote(slash === -1 ? '.' : cfg.slice(0, slash))}`,
      `--config-file=${shellQuote(cfg.slice(slash + 1))}`,
    )
  }
  args.push(o['testingType'] === 'component' ? '--component' : '--e2e')
  const config: string[] = []
  if (typeof o['baseUrl'] === 'string') config.push(`baseUrl=${o['baseUrl']}`)
  if (typeof o['ignoreTestFiles'] === 'string')
    config.push(`excludeSpecPattern=${o['ignoreTestFiles']}`)
  if (config.length > 0) args.push(`--config=${shellQuote(config.join(','))}`)
  if (o['env'] !== undefined && o['env'] !== null && typeof o['env'] === 'object') {
    const pairs = Object.entries(o['env'] as Record<string, unknown>)
    if (
      pairs.every(
        ([, v]) => ['string', 'number', 'boolean'].includes(typeof v) && !String(v).includes(','),
      )
    )
      args.push(`--env=${shellQuote(pairs.map(([k, v]) => `${k}=${String(v)}`).join(','))}`)
    else
      todos.push(
        '@nx/cypress:cypress `env` has a value `--env` cannot carry — move it into the cypress config',
      )
  }
  if (o['exit'] === false) args.push('--no-exit')
  args.push(
    ...mappedFlags(
      o,
      CYPRESS_FLAGS,
      new Set([
        'cypressConfig',
        'watch',
        'testingType',
        'baseUrl',
        'env',
        'exit',
        'devServerTarget',
        'skipServe',
        'runnerUi',
        'ignoreTestFiles',
        // The dev server's port, which Nx picks for the server it starts.
        'port',
      ]),
      todos,
      '@nx/cypress:cypress',
      'cypress',
    ),
  )
  if (typeof o['devServerTarget'] === 'string' && o['skipServe'] !== true)
    todos.push(
      `@nx/cypress:cypress started ${JSON.stringify(o['devServerTarget'])} first and tested its URL — ` +
        'depend on that server task and set its URL as baseUrl',
    )
  if (o['testingType'] === 'component')
    todos.push(
      "@nx/cypress:cypress component testing reads Nx's build target through its preset — check the cypress config",
    )
  return fromRoot(ctx, args.join(' '))
}

const TRANSLATORS: Readonly<Record<string, Translate>> = {
  '@nx/next:build': nextBuild,
  '@nx/next:server': nextServer,
  '@nx/cypress:cypress': cypress,
  '@nx/vite:dev-server': viteDev,
  '@nx/vite:preview-server': vitePreview,
  '@nx/storybook:storybook': storybookDev,
  '@nx/storybook:build': storybookBuild,
  '@nx/jest:jest': jest,
  '@nx/vitest:test': vitest,
  '@nx/vite:test': vitest,
  '@nx/vite:build': viteBuild,
  '@nx/eslint:lint': eslint,
  '@nx/linter:eslint': eslint,
  '@nx/js:tsc': tsc,
  '@nx/playwright:playwright': playwright,
}
