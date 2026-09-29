#!/usr/bin/env bun
/**
 * Interleaved A/B of vx on warm workspaces, the method CLAUDE.md's first
 * principle asks of every perf claim: one workspace copy per arm, warmed by
 * that arm; rounds that run every arm once in a rotated order; min and
 * median per arm; an A/A arm (the same vx twice) as the noise floor.
 *
 *   bun packages/vx-bench/ab.ts <rounds> <label>=<vx>@<workspace>... -- <vx args>
 *   bun packages/vx-bench/ab.ts 15 base=/tmp/vx-old@/tmp/w1 main=/tmp/vx-new@/tmp/w2 \
 *     aa=/tmp/vx-new2@/tmp/w3 -- run build --all
 *
 * <vx> is a compiled binary or a checkout (its packages/vx/src/bin.ts runs
 * under this Bun). A real repo's copies each link their own plugin build
 * (`node_modules/@vzn/vx-migrate`) to the arm's checkout. The runs see git's
 * defaults: this container's global config (`core.checkStat=minimal`) makes
 * vx re-hash every input (A-6), which is the config, not the arm.
 * A `run` is timed from a `vx lock` snapshot (`--frozen`): each arm locks
 * its own workspace with its own vx once, before the warm-up, as CI would.
 * Re-locking after a config edit is the caller's, never a rep's.
 * Prints each arm's min and median, then every sample as one JSON line.
 */
import { statSync } from 'node:fs'
import path from 'node:path'
import { benchEnv } from './bench-env.js'

export interface Arm {
  label: string
  vx: string
  workspace: string
}

/** `<label>=<vx>@<workspace>`; the workspace is everything after the last `@`. */
export function parseArm(spec: string): Arm {
  const eq = spec.indexOf('=')
  const at = spec.lastIndexOf('@')
  if (eq <= 0 || at <= eq + 1 || at === spec.length - 1) {
    throw new Error(`arm "${spec}" is not <label>=<vx>@<workspace>`)
  }
  return { label: spec.slice(0, eq), vx: spec.slice(eq + 1, at), workspace: spec.slice(at + 1) }
}

/** The arms' order in round `r`: rotated by one each round, so no arm always runs first. */
export function roundOrder(r: number, arms: number): number[] {
  return Array.from({ length: arms }, (_, i) => (i + r) % arms)
}

export function summarize(samples: readonly number[]): { min: number; median: number } {
  const s = [...samples].sort((a, b) => a - b)
  const mid = s.length >> 1
  return { min: s[0]!, median: s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2 }
}

/** What a failed run said: the tail of stdout, where vx reports a failed task, then stderr. */
export function failure(label: string, code: number, stdout: string, stderr: string): string {
  const tail = (s: string) => s.trimEnd().split('\n').slice(-40).join('\n')
  return [`${label} exited ${code}`, tail(stdout), tail(stderr)].filter((s) => s !== '').join('\n')
}

/** The timed args: a `run` runs frozen, from the lock each arm took before the reps. */
export function frozenArgs(args: readonly string[]): string[] {
  return args[0] === 'run' && !args.includes('--frozen') ? [...args, '--frozen'] : [...args]
}

function command(vx: string): string[] {
  return statSync(vx).isDirectory()
    ? [process.execPath, path.join(vx, 'packages/vx/src/bin.ts')]
    : [vx]
}

async function time(arm: Arm, args: readonly string[]): Promise<number> {
  const t0 = Bun.nanoseconds()
  const p = Bun.spawn({
    cmd: [...command(arm.vx), ...args],
    cwd: arm.workspace,
    // Kept for a failure: vx reports a failed task on stdout, so stderr
    // alone showed an astro run's `pnpm install` failure as nothing.
    stdout: 'pipe',
    stderr: 'pipe',
    env: benchEnv({ NO_COLOR: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }),
  })
  const [code, out, err] = await Promise.all([
    p.exited,
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ])
  if (code !== 0) throw new Error(failure(arm.label, code, out, err))
  return (Bun.nanoseconds() - t0) / 1e6
}

if (import.meta.main) {
  const argv = process.argv.slice(2)
  const dash = argv.indexOf('--')
  const rounds = Number(argv[0])
  if (dash < 2 || !Number.isInteger(rounds) || rounds < 1) {
    throw new Error('usage: ab.ts <rounds> <label>=<vx>@<workspace>... -- <vx args>')
  }
  const arms = argv.slice(1, dash).map(parseArm)
  const args = frozenArgs(argv.slice(dash + 1))
  if (args[0] === 'run') for (const arm of arms) await time(arm, ['lock'])
  // Warmed by its own arm: a cold key (an arm's first run on a copy) is not
  // the warm path, and the second run proves the hits.
  for (const arm of arms) for (let i = 0; i < 2; i++) await time(arm, args)
  const samples = arms.map(() => [] as number[])
  for (let r = 0; r < rounds; r++) {
    for (const i of roundOrder(r, arms.length)) samples[i]!.push(await time(arms[i]!, args))
  }
  for (const [i, arm] of arms.entries()) {
    const { min, median } = summarize(samples[i]!)
    console.log(
      `${arm.label.padEnd(8)} min ${min.toFixed(1)}  median ${median.toFixed(1)}  n=${rounds}`,
    )
  }
  console.log(
    JSON.stringify(
      Object.fromEntries(arms.map((a, i) => [a.label, samples[i]!.map((x) => +x.toFixed(1))])),
    ),
  )
}
