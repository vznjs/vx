// The job summary sink: loaded only on a runner that sets a summary file,
// so a run elsewhere pays no module of it.
import { type RunSummaryRecord, type TelemetrySink } from '@vzn/vx'
import { buildCheckRunPayload, postCheckRun, type CheckRunEnv, type FetchFn } from './checks.js'
import { clampJobSummary, MAX_JOB_SUMMARY_BYTES, renderJobSummary } from './summary.js'

export { resolveCheckRunEnv } from './checks.js'

export class GithubSummarySink implements TelemetrySink {
  readonly name = 'github-job-summary'
  /** Summary-only: no streaming records at all — zero per-event cost. */
  readonly wants: [] = []
  private summary: RunSummaryRecord | undefined

  constructor(
    private readonly file: string,
    private readonly title: string,
    private readonly append: (file: string, markdown: string) => Promise<void>,
    private readonly warn: (m: string) => void,
    private readonly check?: { env: CheckRunEnv; name: string; fetchFn: FetchFn },
    /** Bytes the summary file already holds. */
    private readonly sizeOf: (file: string) => Promise<number> = async () => 0,
  ) {}

  onRunSummary(summary: RunSummaryRecord): void {
    // MUST return promptly (contract): stash, render + write in flush().
    this.summary = summary
  }

  async flush(signal?: AbortSignal): Promise<void> {
    if (this.summary === undefined) return
    const markdown = renderJobSummary(this.summary, this.title)
    // The two artifacts are INDEPENDENT, and the plugin already says so in
    // one direction: it declines the check-run without a token and still
    // writes the summary. The reverse has to hold, or a full disk on the
    // runner costs the PR its check — the more visible of the two. Reported,
    // not thrown: a telemetry sink may never break a run.
    try {
      // Clamped: past GitHub's 1 MiB cap the runner drops the summary whole,
      // so a bounded page beats none. The cap covers the step's whole file,
      // and a page clamped to 1 MiB after another writer's output lost both
      // (F-42): the room is what is left. The check-run payload has its own,
      // smaller cap and is clamped where it is built.
      const used = await this.sizeOf(this.file)
      // After another writer the page starts on its own line: one that left
      // no final newline ran vx's heading into its paragraph (F-51).
      const lead = used > 0 ? '\n' : ''
      const page = clampJobSummary(markdown, MAX_JOB_SUMMARY_BYTES - used - lead.length)
      if (page === '') {
        this.warn(
          `vx-ci: ${this.file} already holds ${used} bytes of GitHub's 1 MiB job summary cap — no room for vx's page`,
        )
      } else {
        await this.append(this.file, lead + page)
      }
    } catch (err) {
      this.warn(
        `vx-ci: could not write the job summary to ${this.file}: ${err instanceof Error ? err.message : String(err)}`,
      )
    }
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
        warn: this.warn,
        ...(signal === undefined ? {} : { signal }),
      })
    }
  }
}
