// `gitlab()`: agents as jobs of a child pipeline that `vx dte plan` writes
// (design dte-2026-10.md, "Adapters"). The user's own pipeline runs the
// plan job, triggers the child it wrote, and runs the orchestrator, their
// own `vx run`. Every agent the plan wrote starts at once.

import { existsSync } from 'node:fs'
import path from 'node:path'
import { refuseUnknownOptions, UserError, type PluginOptionKinds } from '@vzn/vx'
import type { DteAdapter } from './plugin.js'

export interface GitlabOptions {
  /** The workspace-relative file that holds `.vx-agent`, the job template every agent job extends. */
  readonly include: string
  /** Runner tags by agent size: the runners each size's jobs go to. */
  readonly tags?: Readonly<Record<string, readonly string[]>>
}

const KEYS: PluginOptionKinds<GitlabOptions> = { include: 'string', tags: 'object' }

/** What the child pipeline is written to, workspace-relative. */
const AGENTS_FILE = 'vx-agents.yml'

export function gitlab(options: GitlabOptions): DteAdapter {
  refuseUnknownOptions('gitlab()', options, KEYS)
  if (typeof options.include !== 'string' || options.include === '') {
    throw new UserError(
      "gitlab() needs include: the file holding .vx-agent, such as '.gitlab/vx.yml'",
    )
  }
  return {
    // The plan wrote every agent; they join as they come up.
    spawn() {},

    render(plan) {
      const vx = binary(plan.workspaceRoot)
      const lines = [
        `# Written by vx dte plan for run ${plan.run}; do not commit.`,
        'include:',
        `  - local: ${json(options.include)}`,
      ]
      for (const a of plan.agents) {
        const tags = options.tags?.[a.size]
        lines.push(
          '',
          `${json(`vx-agent ${a.id}`)}:`,
          '  extends: .vx-agent',
          '  needs:',
          '    - pipeline: $PARENT_PIPELINE_ID',
          '      job: vx-plan',
          ...(tags === undefined ? [] : ['  tags:', ...tags.map((t) => `    - ${json(t)}`)]),
          '  variables:',
          `    VX_DTE_RUN: ${json(plan.run)}`,
          `    VX_DTE_AGENT: ${json(a.id)}`,
          `    VX_DTE_RELAY: ${json(plan.relay)}`,
          '  script:',
          `    - ${json(`${vx} dte agent`)}`,
        )
      }
      return {
        [AGENTS_FILE]: `${lines.join('\n')}\n`,
        // The orchestrator job's run id, as a dotenv report.
        'vx-dte.env': `VX_DTE_RUN=${plan.run}\n`,
      }
    },

    // The plan job's pipeline and job: unique across retries.
    runId() {
      const { CI_PIPELINE_ID: p, CI_JOB_ID: j } = process.env
      return p && j ? `${p}-${j}` : undefined
    },
  }
}

const json = (s: string): string => JSON.stringify(s)

/** The repo's own way to call vx, by its lockfile: never a package.json script. */
function binary(root: string): string {
  const has = (f: string): boolean => existsSync(path.join(root, f))
  if (has('pnpm-lock.yaml')) return 'pnpm exec vx'
  if (has('yarn.lock')) return 'yarn exec vx'
  if (has('bun.lock') || has('bun.lockb')) return 'bunx @vzn/vx'
  return 'npx @vzn/vx'
}
