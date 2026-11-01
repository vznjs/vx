// The per-PR bench's second yardstick: the base commit's own vx, built in
// the same job and timed beside this checkout's. The Turbo ratio alone held
// at 1.3× let main grow slower run by run (10-25 to 10-29) with every PR
// passing; a base timed on the same box at the same minute is the reference
// that moves with nothing but the change.

import { mkdtempSync, rmSync, symlinkSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/**
 * The chance a vx no slower than its base still reads slower in this many
 * of its pairs, below which the arm fails. A sign test, not a tolerance:
 * 4% slack let a regression land 3% at a time. Low because an undecided arm
 * keeps adding pairs and is tested again after each: simulated, an
 * unchanged vx fails 0.7% of arms, one slower in 3 of 4 pairs 63%, in
 * 17 of 20 pairs 90%.
 */
export const SIGNIFICANCE = 0.002

/**
 * The arms a check holds. Cold too: it is the overhead the site publishes,
 * and printed only, it read vx 1.12× Turbo for weeks with every PR passing.
 */
export const HELD = ['cold', 'restore', 'noop'] as const
export type Arm = (typeof HELD)[number]

/**
 * The arms timed on the site's workspace (9,603 tasks), not the small one:
 * a per-task cost the site pays 9,603 times read as noise at 200, and
 * #4892's 17-35 ms on every site run passed.
 */
export const SITE_ARMS: readonly Arm[] = ['restore', 'noop']

/** The rivals a check times vx against. */
export const RIVALS = ['turbo', 'nx', 'vite-task'] as const
export type Rival = (typeof RIVALS)[number]

/**
 * The rivals vx may use less CPU than none of: all but Vite Task, whose
 * one process per run does less than vx's shell per task.
 */
export const CPU_HELD: readonly Rival[] = ['turbo', 'nx']

/** A tool's best wall and CPU ms in one arm. */
export interface Best {
  ms: number
  cpuMs: number
}

const NAME: Record<Rival, string> = { turbo: 'Turbo', nx: 'Nx', 'vite-task': 'Vite Task' }

/** vx and a rival, timed on one workspace. */
export interface Match {
  vx: Best
  rival: Best
}

/** Every held arm vx was slower than a rival in, or used more CPU than a rival `CPU_HELD` names. */
export function rivalFails(
  best: Readonly<Partial<Record<Arm, Partial<Record<Rival, Match>>>>>,
  held: readonly Arm[],
): string[] {
  const fails: string[] = []
  for (const arm of held) {
    for (const rival of RIVALS) {
      const m = best[arm]?.[rival]
      if (m === undefined) continue
      const { vx, rival: r } = m
      if (vx.ms > r.ms)
        fails.push(
          `${arm}: vx ${vx.ms.toFixed(0)} ms against ${NAME[rival]} ${r.ms.toFixed(0)} ms: vx is slower than ${NAME[rival]}`,
        )
      if (CPU_HELD.includes(rival) && vx.cpuMs > r.cpuMs)
        fails.push(
          `${arm}: vx ${vx.cpuMs.toFixed(0)} ms CPU against ${NAME[rival]} ${r.cpuMs.toFixed(0)} ms: vx uses more CPU than ${NAME[rival]}`,
        )
    }
  }
  return fails
}

/** One interleaved pair's times of this checkout's vx and the base's. */
export interface BasePair {
  vx: number
  base: number
}

/** P(X ≥ k) for X ~ Binomial(n, 1/2): how often a coin reads k or more heads of n. */
export function tailAtLeast(k: number, n: number): number {
  let sum = 0
  let c = 1
  for (let i = 0; i <= n; i++) {
    if (i >= k) sum += c
    c = (c * (n - i)) / (i + 1)
  }
  return sum / 2 ** n
}

/** The pairs vx ran slower than the base in, and that count's chance under no change. */
function slower(pairs: readonly BasePair[]): { k: number; p: number } {
  const k = pairs.filter((x) => x.vx > x.base).length
  return { k, p: tailAtLeast(k, pairs.length) }
}

/**
 * Whether an arm's pairs lean slower than the base without yet proving it:
 * more pairs decide. A lean faster, or an even split, is decided.
 */
export function undecided(pairs: readonly BasePair[]): boolean {
  const { k, p } = slower(pairs)
  return k > pairs.length / 2 && p >= SIGNIFICANCE
}

/** The held arms vx ran slower than the base in, beyond what chance explains. */
export function baseFails(
  pairs: Readonly<Partial<Record<Arm, readonly BasePair[]>>>,
  held: readonly Arm[],
): string[] {
  const fails: string[] = []
  for (const arm of held) {
    const ran = pairs[arm]
    if (ran === undefined || ran.length === 0) continue
    const { k, p } = slower(ran)
    if (p >= SIGNIFICANCE) continue
    fails.push(
      `${arm}: vx slower than the base in ${k} of ${ran.length} pairs (p ${p.toPrecision(2)})`,
    )
  }
  return fails
}

/**
 * The base commit's vx, compiled as this checkout's is, to `outfile`:
 * `packages/vx` at `sha` comes out of git's objects (`git archive`), so no
 * worktree is written into the repository. Throws when the commit is not
 * in the clone: a base the job was told to time and could not is a broken
 * job, not a pass.
 */
export function buildBase(repo: string, sha: string, outfile: string): void {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) throw new Error(`VX_BENCH_BASE is not a commit sha: ${sha}`)
  const src = mkdtempSync(path.join(os.tmpdir(), 'vx-prbench-base-'))
  try {
    const run = (cmd: string[], cwd: string): void => {
      const r = Bun.spawnSync(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' })
      if (r.exitCode !== 0)
        throw new Error(`${cmd.join(' ')} failed:\n${r.stderr.toString().slice(-2000)}`)
    }
    run(['git', 'cat-file', '-e', `${sha}^{commit}`], repo)
    run(['sh', '-c', `git archive --format=tar ${sha} packages/vx | tar -x -C "${src}"`], repo)
    // Its dependencies are this checkout's install, reached through the
    // bench's own link to core (the sandbox grants that path, not
    // packages/vx): a base that moved one is timed with the head's copy, as
    // no lockfile lives in packages/vx.
    symlinkSync(
      path.join(import.meta.dir, 'node_modules/@vzn/vx/node_modules'),
      path.join(src, 'packages/vx/node_modules'),
    )
    run(
      [
        'bun',
        'build',
        '--compile',
        '--minify',
        '--bytecode',
        path.join(src, 'packages/vx/src/bin.ts'),
        '--outfile',
        outfile,
      ],
      src,
    )
  } finally {
    rmSync(src, { recursive: true, force: true })
  }
}
