// The `github()` telemetry plugin. Contributes one observe-only sink that
// writes the run as a GitHub Actions job summary. Off Actions
// (`GITHUB_ACTIONS` not 'true') the factory returns undefined, which
// `plugins` skips: no hook, no load, so declaring `github()` costs nothing
// on a laptop. index.ts checks its options everywhere.
import { appendFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { homedir } from 'node:os'
import path from 'node:path'
import { definePlugin, type VxPlugin } from '@vzn/vx'
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
}

/** Each option `GithubPluginOptions` names, with its kind: derived from the type, so the two cannot drift. */
export function github(options: GithubPluginOptions = {}): VxPlugin | undefined {
  if (process.env['GITHUB_ACTIONS'] !== 'true') return undefined
  // Its options were checked by index.ts's github(), the only caller.
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
      const { GithubSummarySink } = loadSink()
      return new GithubSummarySink(
        file,
        options.title ?? 'vx run',
        (f, md) => appendFile(f, md, 'utf8'),
        (m) => ctx.warn(m),
        (f) =>
          stat(f).then(
            (st) => st.size,
            () => 0,
          ),
      )
    },
  })
}
