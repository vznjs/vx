// The `github()` telemetry plugin. Contributes one observe-only sink that
// writes the run as a GitHub Actions job summary. Declines (returns
// undefined) outside GitHub Actions — no `GITHUB_STEP_SUMMARY` file to write
// and no cost — so declaring `github()` is safe in every environment, the
// same decline pattern as `otel()`.
import { appendFile } from 'node:fs/promises'
import type { RunSummaryRecord, TelemetrySink, VxPlugin } from '@vzn/vx'
import {
  buildCheckRunPayload,
  postCheckRun,
  resolveCheckRunEnv,
  type CheckRunEnv,
  type FetchFn,
} from './checks.js'
import { renderJobSummary } from './summary.js'

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
  /** Test seam — inject the append. Defaults to fs appendFile. */
  append?: (file: string, markdown: string) => Promise<void>
  /** Test seam — inject the Checks API transport. Defaults to fetch. */
  fetchFn?: FetchFn
}

export class GithubSummarySink implements TelemetrySink {
  readonly name = 'github-job-summary'
  /** Summary-only: no streaming records at all — zero per-event cost. */
  readonly wants: [] = []
  private summary: RunSummaryRecord | undefined

  constructor(
    private readonly file: string,
    private readonly title: string,
    private readonly append: (file: string, markdown: string) => Promise<void>,
    private readonly check?: {
      env: CheckRunEnv
      name: string
      fetchFn: FetchFn
      warn: (m: string) => void
    },
  ) {}

  onRunSummary(summary: RunSummaryRecord): void {
    // MUST return promptly (contract): stash, render + write in flush().
    this.summary = summary
  }

  async flush(): Promise<void> {
    if (this.summary === undefined) return
    const markdown = renderJobSummary(this.summary, this.title)
    await this.append(this.file, markdown)
    if (this.check !== undefined) {
      await postCheckRun({
        env: this.check.env,
        payload: buildCheckRunPayload({
          summary: this.summary,
          markdown,
          name: this.check.name,
          sha: this.check.env.sha,
        }),
        fetchFn: this.check.fetchFn,
        warn: this.check.warn,
      })
    }
  }
}

export function github(options: GithubPluginOptions = {}): VxPlugin {
  return {
    name: '@vzn/vx-github',
    telemetry(ctx) {
      const file = options.summaryFile ?? process.env['GITHUB_STEP_SUMMARY']
      if (file === undefined || file === '') return undefined
      const append = options.append ?? (async (f: string, md: string) => appendFile(f, md, 'utf8'))
      let check: ConstructorParameters<typeof GithubSummarySink>[3]
      if (options.checks !== false) {
        const env = resolveCheckRunEnv(process.env)
        if (env !== null) {
          check = {
            env,
            name: options.checkName ?? 'vx',
            fetchFn: options.fetchFn ?? (fetch as unknown as FetchFn),
            warn: (m) => ctx.warn(m),
          }
        } else if (options.checks === true) {
          ctx.warn(
            'vx-github: checks requested but GITHUB_TOKEN / GITHUB_REPOSITORY / GITHUB_SHA are not all set — no check-run will be created',
          )
        }
      }
      return new GithubSummarySink(file, options.title ?? 'vx run', append, check)
    },
  }
}
