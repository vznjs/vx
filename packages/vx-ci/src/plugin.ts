// The `github()` telemetry plugin. Contributes one observe-only sink that
// writes the run as a GitHub Actions job summary. Off Actions
// (`GITHUB_ACTIONS` not 'true') the factory returns undefined, which
// `plugins` skips: no option check, no hook, no load, so declaring
// `github()` costs nothing on a laptop.
import { appendFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import {
  refuseUnknownOptions,
  type PluginOptionKinds,
  definePlugin,
  UserError,
  type VxPlugin,
} from '@vzn/vx'
import { githubBranch } from './cache-scope.js'

// Every run evaluates `.vx/workspace.ts`; the sink and the summary
// renderer load only where a summary file is set. The
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
   * Name the run's cache scope and base commit from the Actions event: none
   * on the default branch, else `<owner>/<repo>:<branch>` (a fork's names
   * the fork); a pull request is compared with its base commit. The scope
   * keys plugin entries only. `VX_CACHE_SCOPE` beats it. Default: on;
   * `false` opts out.
   */
  cacheScope?: boolean
  /** Test seam — inject the append. Defaults to fs appendFile. */
  append?: (file: string, markdown: string) => Promise<void>
  /**
   * Test seam — bytes the summary file already holds. Defaults to its size
   * on disk; with `append` injected, 0 (that writer owns the file).
   */
  sizeOf?: (file: string) => Promise<number>
}

/** Each option `GithubPluginOptions` names, with its kind: derived from the type, so the two cannot drift. */
const GITHUB_PLUGIN_KEYS: PluginOptionKinds<GithubPluginOptions> = {
  summaryFile: 'string',
  title: 'string',
  cacheScope: 'boolean',
  append: 'function',
  sizeOf: 'function',
}

export function github(options: GithubPluginOptions = {}): VxPlugin | undefined {
  if (process.env['GITHUB_ACTIONS'] !== 'true') return undefined
  refuseUnknownOptions('github()', options, GITHUB_PLUGIN_KEYS)
  // '' passes the kind check but reads wrong: `??` keeps it, so summaryFile
  // declined instead of using GITHUB_STEP_SUMMARY and title rendered an
  // empty heading.
  for (const key of ['summaryFile', 'title'] as const) {
    if (options[key] === '')
      throw new UserError(`github() option "${key}" must be a non-empty string, got ""`)
  }
  return definePlugin(import.meta, {
    commands: {
      // Kept where actions/cache can save it: a hit installs the
      // packages from it, no index fetch (14 to 52 s, 2026-10-22).
      setup: {
        description: 'github: install and prove the sandbox runtime on this runner',
        run: async (argv) =>
          (await import('./setup.js')).runSetup(
            'github',
            argv,
            path.join(homedir(), '.cache', 'vx', 'setup-debs'),
          ),
      },
    },
    async config(workspace, ctx) {
      if (options.cacheScope === false) return
      ctx.setBranch(await githubBranch(process.env, workspace.baseBranch))
    },
    telemetry(ctx) {
      const file = options.summaryFile ?? process.env['GITHUB_STEP_SUMMARY']
      if (file === undefined || file === '') return undefined
      const append = options.append ?? (async (f: string, md: string) => appendFile(f, md, 'utf8'))
      const { GithubSummarySink } = loadSink()
      return new GithubSummarySink(
        file,
        options.title ?? 'vx run',
        append,
        (m) => ctx.warn(m),
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
