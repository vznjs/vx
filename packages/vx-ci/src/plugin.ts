// The `github()` telemetry plugin. Contributes one observe-only sink that
// writes the run as a GitHub Actions job summary. Declines (returns
// undefined) outside GitHub Actions — no `GITHUB_STEP_SUMMARY` file to write
// and no cost — so declaring `github()` is safe in every environment, the
// same decline pattern as `otel()`.
import { appendFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import {
  refuseUnknownOptions,
  type PluginOptionKinds,
  definePlugin,
  UserError,
  type VxPlugin,
} from '@vzn/vx'
import type { FetchFn } from './checks.js'
import { githubCacheScope } from './cache-scope.js'

// Every run evaluates `vx.workspace.ts`; the sink, the summary renderer
// and the Checks API client load only where a summary file is set. The
// telemetry hook is synchronous, so the module loads by `require`.
const loadSink = (): typeof import('./sink.js') => createRequire(import.meta.url)('./sink.js')

export interface GithubPluginOptions {
  /**
   * Target file for the summary markdown. Falls back to
   * `GITHUB_STEP_SUMMARY` (set by the Actions runner); with neither, the
   * plugin declines.
   */
  summaryFile?: string
  /** Heading for the summary block. Default: `'vx run'`. */
  title?: string
  /**
   * Also create a completed check-run on the built commit (Checks API).
   * Default: on when the environment carries `GITHUB_TOKEN` +
   * `GITHUB_REPOSITORY` + `GITHUB_SHA` (the workflow must grant
   * `permissions: checks: write`); set `false` to opt out, `true` to warn
   * when the environment is missing instead of silently skipping.
   */
  checks?: boolean
  /** Check-run name. Default: `'vx'`. */
  checkName?: string
  /**
   * Set the workspace's `cacheScope` from the run's ref when it names none:
   * a push to the default branch stays trusted, a pull request writes to
   * `pr-<n>`, any other ref to `ref-<name>`. Default: on; `false` opts out.
   */
  cacheScope?: boolean
  /** Test seam — inject the append. Defaults to fs appendFile. */
  append?: (file: string, markdown: string) => Promise<void>
  /** Test seam — inject the Checks API transport. Defaults to fetch. */
  fetchFn?: FetchFn
  /**
   * Test seam — bytes the summary file already holds. Defaults to its size
   * on disk; with `append` injected, 0 (that writer owns the file).
   */
  sizeOf?: (file: string) => Promise<number>
}

/**
 * Why a string cannot be an HTTP header value, or null. Bun's `fetch`
 * refuses a line break, a NUL or a character past Latin-1 once it has
 * trimmed the ends (measured on 1.4.2), and quotes the value in its error.
 */
function headerValueFault(value: string): string | null {
  let past = false
  for (const ch of value.trim()) {
    const c = ch.codePointAt(0)!
    if (c === 0x0a || c === 0x0d || c === 0) return 'a line break or NUL'
    if (c > 0xff) past = true
  }
  return past ? 'a character past Latin-1' : null
}

/** Each option `GithubPluginOptions` names, with its kind: derived from the type, so the two cannot drift. */
const GITHUB_PLUGIN_KEYS: PluginOptionKinds<GithubPluginOptions> = {
  summaryFile: 'string',
  title: 'string',
  checks: 'boolean',
  checkName: 'string',
  cacheScope: 'boolean',
  append: 'function',
  fetchFn: 'function',
  sizeOf: 'function',
}

export function github(options: GithubPluginOptions = {}): VxPlugin {
  refuseUnknownOptions('github()', options, GITHUB_PLUGIN_KEYS)
  // '' passes the kind check but reads wrong: `??` keeps it, so summaryFile
  // declined instead of using GITHUB_STEP_SUMMARY, checkName POSTed a name
  // GitHub refuses (422) and title rendered an empty heading.
  for (const key of ['summaryFile', 'title', 'checkName'] as const) {
    if (options[key] === '')
      throw new UserError(`github() option "${key}" must be a non-empty string, got ""`)
  }
  return definePlugin(import.meta, {
    async config(workspace) {
      if (options.cacheScope === false || workspace.cacheScope !== undefined) return
      const scope = await githubCacheScope(process.env)
      if (scope !== undefined) workspace.cacheScope = scope
    },
    telemetry(ctx) {
      const file = options.summaryFile ?? process.env['GITHUB_STEP_SUMMARY']
      if (file === undefined || file === '') return undefined
      const append = options.append ?? (async (f: string, md: string) => appendFile(f, md, 'utf8'))
      const { GithubSummarySink, resolveCheckRunEnv } = loadSink()
      let check: ConstructorParameters<typeof GithubSummarySink>[4]
      if (options.checks !== false) {
        const env = resolveCheckRunEnv(process.env)
        // fetch refuses a token no header can carry and QUOTES it in its
        // error, which the check-run warning printed (item 928).
        const fault = env === null ? null : headerValueFault(env.token)
        if (fault !== null) {
          ctx.warn(
            `vx-ci: GITHUB_TOKEN holds ${fault}, which no HTTP header can carry — no check-run will be created (the token is not printed)`,
          )
        } else if (env !== null) {
          check = {
            env,
            name: options.checkName ?? 'vx',
            fetchFn: options.fetchFn ?? (fetch as unknown as FetchFn),
          }
        } else if (options.checks === true) {
          ctx.warn(
            'vx-ci: checks requested but GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_SHA are not all set — no check-run will be created',
          )
        }
      }
      return new GithubSummarySink(
        file,
        options.title ?? 'vx run',
        append,
        (m) => ctx.warn(m),
        check,
        options.sizeOf ??
          (options.append !== undefined
            ? async () => 0
            : (f: string) =>
                stat(f).then(
                  (st) => st.size,
                  () => 0,
                )),
      )
    },
  })
}
