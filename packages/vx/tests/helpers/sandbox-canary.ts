// The darwin-CI sandbox CANARY. Not a test — a data collector.
//
// The sandbox suites are class-gated on darwin CI because sandbox-exec there
// intermittently misbehaves under load: violations go unreported, and in one
// observed CI run enforcement itself failed (an undeclared read SUCCEEDED —
// decision log 2026-08-24). That mode never reproduced locally, so this
// canary runs on every darwin CI pass, drives N sandboxed executions of a
// deliberately leaky task THROUGH THE REAL `run()` PATH (a first draft that
// hand-assembled runSandandboxed args reported NOT_ENFORCED 12/12 at idle —
// a harness artifact, since the real suites pass on the same machine; the
// canary must exercise exactly what production exercises), classifies each,
// and prints a machine-greppable summary. It ALWAYS exits 0 — its job is to
// turn the next occurrence into data in the job log, never to gate main.
//
//   bun tests/helpers/sandbox-canary.ts [iterations]

import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { run } from '../../src/index.js'
import { probeSandbox } from '../../src/exec/index.js'
import { localWorkspaceSource } from './local-workspace.js'

const ITERATIONS = Number(process.argv[2] ?? 20)

const probe = await probeSandbox()
console.log(`[canary] probeSandbox: ${JSON.stringify(probe)}`)
if (!probe.available) {
  console.log('[canary] sandbox unavailable — nothing to measure')
  process.exit(0)
}

const silent = {
  runStart: () => undefined,
  taskStart: () => undefined,
  taskStdout: () => undefined,
  taskStderr: () => undefined,
  taskComplete: () => undefined,
  runStatus: () => undefined,
  runEnd: () => undefined,
  status: () => undefined,
}

type Verdict = 'ENFORCED_REPORTED' | 'ENFORCED_UNREPORTED' | 'NOT_ENFORCED' | 'RUN_ERROR'

async function fixture(): Promise<string> {
  const root = mkdtempSync(path.join(tmpdir(), 'vx-canary-'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'canary' }))
  await writeFile(path.join(root, 'pnpm-workspace.yaml'), "packages:\n  - 'proj'\n")
  await mkdir(path.join(root, 'proj', 'src'), { recursive: true })
  await writeFile(path.join(root, 'proj', 'package.json'), JSON.stringify({ name: 'proj' }))
  await writeFile(path.join(root, 'proj', 'src', 'ok.txt'), 'declared\n')
  await writeFile(path.join(root, 'secret.txt'), 'undeclared\n')
  await writeFile(
    path.join(root, 'proj', 'vx.config.mjs'),
    `export default { tasks: { leak: {
       exec: { command: 'cat ../secret.txt > out.txt' },
       cache: { inputs: { files: ['src/**'] }, outputs: { files: ['out.txt'] } },
       sandbox: {},
     } } }`,
  )
  await writeFile(path.join(root, 'vx.workspace.mjs'), localWorkspaceSource())
  const git = (...a: string[]) => Bun.spawnSync({ cmd: ['git', ...a], cwd: root })
  git('init', '-q')
  git('config', 'user.email', 'c@vx')
  git('config', 'user.name', 'c')
  git('config', 'commit.gpgsign', 'false')
  git('add', '-A')
  git('commit', '-qm', 'init')
  return root
}

const counts: Record<Verdict, number> = {
  ENFORCED_REPORTED: 0,
  ENFORCED_UNREPORTED: 0,
  NOT_ENFORCED: 0,
  RUN_ERROR: 0,
}

for (let i = 0; i < ITERATIONS; i++) {
  const root = await fixture() // fresh fixture per iteration: no cache reuse
  try {
    const r = await run({
      cwd: root,
      projects: ['proj'],
      tasks: ['leak'],
      log: silent,
      handleSignals: false,
    })
    const outcome = r.outcomes.find((o) => o.node.id === 'proj#leak')
    let verdict: Verdict
    if (outcome === undefined) verdict = 'RUN_ERROR'
    else if (r.ok && outcome.status !== 'failed') verdict = 'NOT_ENFORCED'
    else if ((outcome.sandboxViolations ?? 0) > 0) verdict = 'ENFORCED_REPORTED'
    else verdict = 'ENFORCED_UNREPORTED'
    counts[verdict]++
    if (verdict === 'NOT_ENFORCED') {
      console.log(`[canary] NOT_ENFORCED at iteration ${i} — the leaky task PASSED`)
      console.log(
        `[canary] outcome: ${JSON.stringify({ status: outcome?.status, exit: outcome?.exitCode })}`,
      )
      console.log(`[canary] uname: ${Bun.spawnSync(['uname', '-av']).stdout.toString().trim()}`)
    }
  } catch (err) {
    counts.RUN_ERROR++
    console.log(`[canary] RUN_ERROR at iteration ${i}: ${(err as Error).message.slice(0, 120)}`)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
}

console.log(
  `[canary] SUMMARY iterations=${ITERATIONS} ` +
    `enforced_reported=${counts.ENFORCED_REPORTED} enforced_unreported=${counts.ENFORCED_UNREPORTED} ` +
    `not_enforced=${counts.NOT_ENFORCED} run_error=${counts.RUN_ERROR}`,
)
// GATE (promoted 2026-08-25, after 220/220 enforced across 11 CI runs):
// ENFORCEMENT is the security property and it has never failed — a single
// NOT_ENFORCED is signal, not noise, and must red the job. Reporting loss
// (ENFORCED_UNREPORTED, ~5% cumulative) stays tolerated: it is
// lossy-by-OS under load, structural, and asserted on nowhere here. A
// harness where EVERY iteration errored proves nothing and must not read
// as green either.
if (counts.NOT_ENFORCED > 0) process.exit(1)
if (ITERATIONS > 0 && counts.RUN_ERROR === ITERATIONS) {
  console.log('[canary] every iteration errored — the harness is broken, not the sandbox')
  process.exit(1)
}
process.exit(0)
