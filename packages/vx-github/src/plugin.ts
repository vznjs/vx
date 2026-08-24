// The `github()` telemetry plugin. Contributes one observe-only sink that
// writes the run as a GitHub Actions job summary. Declines (returns
// undefined) outside GitHub Actions — no `GITHUB_STEP_SUMMARY` file to write
// and no cost — so declaring `github()` is safe in every environment, the
// same decline pattern as `otel()`.
import { appendFile } from 'node:fs/promises'
import type { RunSummaryRecord, TelemetrySink, VxPlugin } from '@vzn/vx'
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
  /** Test seam — inject the append. Defaults to fs appendFile. */
  append?: (file: string, markdown: string) => Promise<void>
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
  ) {}

  onRunSummary(summary: RunSummaryRecord): void {
    // MUST return promptly (contract): stash, render + write in flush().
    this.summary = summary
  }

  async flush(): Promise<void> {
    if (this.summary === undefined) return
    await this.append(this.file, renderJobSummary(this.summary, this.title))
  }
}

export function github(options: GithubPluginOptions = {}): VxPlugin {
  return {
    name: '@vzn/vx-github',
    telemetry(ctx) {
      const file = options.summaryFile ?? process.env['GITHUB_STEP_SUMMARY']
      if (file === undefined || file === '') return undefined
      const append = options.append ?? (async (f: string, md: string) => appendFile(f, md, 'utf8'))
      void ctx
      return new GithubSummarySink(file, options.title ?? 'vx run', append)
    },
  }
}
