// A pipeline is a saved `vx run` (M, 2026-11-22): each key is its flag in
// camelCase, so the one parser that reads a typed run reads a pipeline too.

import type { Pipeline } from '../config.js'
import { envName } from '../settings.js'

type FlagKey = Exclude<keyof Pipeline, 'tasks' | 'env'>

/** Each pipeline key, the `vx run` flag it saves, and the setting behind it (whose variable beats it). */
export const PIPELINE_FLAGS: Readonly<Record<FlagKey, { flag: string; setting?: string }>> = {
  filter: { flag: '--filter' },
  affected: { flag: '--affected' },
  excludeDependencies: { flag: '--exclude-dependencies' },
  concurrency: { flag: '--concurrency', setting: 'run.concurrency' },
  schedule: { flag: '--schedule', setting: 'run.schedule' },
  continue: { flag: '--continue', setting: 'run.continue' },
  retries: { flag: '--retries', setting: 'run.retries' },
  timeout: { flag: '--timeout', setting: 'run.timeout' },
  branch: { flag: '--branch', setting: 'run.branch' },
  cachePolicy: { flag: '--cache-policy', setting: 'cache.policy' },
  noCache: { flag: '--no-cache' },
  force: { flag: '--force' },
  cacheDir: { flag: '--cache-dir', setting: 'cache.dir' },
  cacheDownload: { flag: '--cache-download', setting: 'cache.download' },
  cacheConcurrencyDownload: {
    flag: '--cache-concurrency-download',
    setting: 'cache.concurrency.download',
  },
  cacheConcurrencyUpload: {
    flag: '--cache-concurrency-upload',
    setting: 'cache.concurrency.upload',
  },
  cacheConcurrencyRestore: {
    flag: '--cache-concurrency-restore',
    setting: 'cache.concurrency.restore',
  },
  outputLogs: { flag: '--output-logs', setting: 'run.outputLogs' },
  verbosity: { flag: '--verbosity' },
  profile: { flag: '--profile' },
  dry: { flag: '--dry' },
}

/** The flag words one key's value stands for: none for `false`. */
function words(key: FlagKey, flag: string, v: unknown): string[] {
  if (v === undefined || v === false) return []
  if (v === true) return [flag]
  if (key === 'filter') return (v as readonly string[]).map((f) => `${flag}=${f}`)
  if (Array.isArray(v)) return [`${flag}=${v.join(',')}`]
  return [`${flag}=${v as string | number}`]
}

/** A typed flag that also stands in for a key: a dry run writes no profile, and a profiled run is real. */
const DISPLACES: Readonly<Partial<Record<FlagKey, string>>> = { profile: '--dry', dry: '--profile' }

/**
 * The `vx run` line a pipeline stands for, before the flags typed with it:
 * its tasks over every project, then each key's flag. A key whose flag was
 * typed, or whose `VX_*` variable is set, is left to that.
 */
export function pipelineRunArgs(
  p: Pipeline,
  typed: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const given = (flag: string): boolean => typed.some((a) => a === flag || a.startsWith(`${flag}=`))
  const out = [...p.tasks, '--all']
  for (const key of Object.keys(PIPELINE_FLAGS) as FlagKey[]) {
    const { flag, setting } = PIPELINE_FLAGS[key]
    if (given(flag)) continue
    const displacing = DISPLACES[key]
    if (displacing !== undefined && given(displacing)) continue
    if (setting !== undefined && (env[envName(setting)] ?? '') !== '') continue
    out.push(...words(key, flag, p[key]))
  }
  return out
}
