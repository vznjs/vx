// The JS half the workspace file imports: same declaration as github(),
// each hook a spawn of the compiled binary.
import { definePlugin, type RunSummaryRecord, type VxPlugin } from '@vzn/vx'

async function call(
  bin: string,
  verb: string,
  body: unknown,
  warn: (m: string) => void,
): Promise<string> {
  // Explicit: Bun.spawn's default env is the one the process started with,
  // not process.env as edited since.
  const p = Bun.spawn([bin, verb], {
    env: process.env,
    stdin: new Blob([JSON.stringify(body)]),
    stdout: 'pipe',
    stderr: 'pipe',
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  for (const line of err.split('\n')) if (line !== '') warn(line)
  if (code !== 0) throw new Error(`${bin} ${verb} exited ${code}`)
  return out
}

export function githubBinary(
  bin: string,
  options: { summaryFile?: string; title?: string } = {},
): VxPlugin | undefined {
  if (process.env['GITHUB_ACTIONS'] !== 'true') return undefined
  return definePlugin(import.meta, {
    commands: {
      setup: {
        description: 'github: install and prove the sandbox runtime on this runner',
        run: (argv) =>
          Bun.spawn([bin, 'setup', ...argv], {
            env: process.env,
            stdio: ['inherit', 'inherit', 'inherit'],
          }).exited,
      },
    },
    async config(workspace, ctx) {
      ctx.setBranch(
        JSON.parse(await call(bin, 'config', { baseBranch: workspace.baseBranch }, ctx.warn)),
      )
    },
    telemetry(ctx) {
      const file = options.summaryFile ?? process.env['GITHUB_STEP_SUMMARY']
      if (file === undefined || file === '') return undefined
      let summary: RunSummaryRecord | undefined
      return {
        name: 'github-job-summary',
        wants: [],
        onRunSummary: (s) => void (summary = s),
        async flush() {
          if (summary === undefined) return
          try {
            await call(
              bin,
              'summary',
              { summary, title: options.title ?? 'vx run', file },
              ctx.warn,
            )
          } catch (err) {
            ctx.warn(`vx-ci: ${err instanceof Error ? err.message : String(err)}`)
          }
        },
      }
    },
  })
}
