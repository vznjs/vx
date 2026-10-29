// Formatters for `--dry` (human / JSON).

import type { AffectedReason, CacheStatus, RunPlan } from '../orchestrator/index.js'
import { skippedReason } from '../report/index.js'
import {
  formatBytes,
  formatElapsed,
  maskedCommand,
  paint,
  SUCCESS,
  ui,
  WARN,
  type ColorSupport,
} from '../util/index.js'

/**
 * Human-readable preview. One line per real task (groups hidden, same
 * as the live runner), tagged with predicted cache outcome. A would-run
 * task with recorded history also shows its typical duration (~p50).
 *
 *   would run:
 *     ✓  @vzn/vx#lint       cache hit (local)        abc12345
 *     ↓  @vzn/vx#test       cache hit (remote)       def67890
 *     ▶  @vzn/vx#build      cache miss — would exec  fedcba98  ~1.20s
 *
 *   3 task(s) planned, 2 cache hits (1 local, 1 remote), 1 would run.
 *   predicted: ~1.20s wall · ~1.20s total execution
 */
export function formatPlanText(plan: RunPlan, c: ColorSupport = { enabled: false }): string {
  // A group the platform skip reaches is still a group: it runs nothing.
  const real = plan.tasks.filter(
    (t) =>
      t.cacheStatus !== 'group' &&
      (t.cacheStatus !== 'skipped' || t.node.config.exec !== undefined),
  )
  const dim = (s: string): string => paint('', s, c, { dim: true })
  if (real.length === 0) return `${dim('No tasks planned.')}\n`

  const idWidth = Math.max(...real.map((t) => t.node.id.length))
  const tagWidth = 24

  const lines: string[] = [paint('', 'would run:', c, { bold: true })]
  let local = 0
  let remote = 0
  let miss = 0
  let nocache = 0
  let noop = 0
  let idle = 0
  let platform = 0
  for (const t of real) {
    // `@noop`: the run succeeds it without running, whatever its key says.
    const skipped = t.executor === 'noop' && t.cacheStatus !== 'skipped'
    const sym = skipped ? '·' : symbolFor(t.cacheStatus)
    const desc = skipped
      ? 'noop — would not run'
      : t.cacheStatus === 'skipped'
        ? `skipped — ${skippedReason(t)}`
        : describe(t.cacheStatus)
    const shortHash = t.hash ? t.hash.slice(0, 8) : ''
    const executes = !skipped && (t.cacheStatus === 'miss' || t.cacheStatus === 'no-cache')
    const eta = executes && t.p50Ms !== undefined ? `  ~${formatElapsed(t.p50Ms)}` : ''
    // Placement, by EXECUTOR NAME rather than a local/remote word: the
    // summary line below already spends "local" and "remote" on the cache
    // tier, and a task placed on a named executor is what the reader can
    // act on. Present only when the workspace declared a choice.
    const where = t.executor !== undefined ? `  @${t.executor}` : ''
    const hue = skipped ? '' : HUE[t.cacheStatus]
    lines.push(
      `  ${paint(hue, sym, c, { dim: hue === '' })}  ${ui.inline(ui.id(t.node.id), c)}${' '.repeat(idWidth - t.node.id.length)}  ${paint(hue, desc.padEnd(tagWidth), c, { dim: hue === '' })}  ${dim(shortHash)}${dim(eta)}${where}`,
    )
    // Optional one-line description from the task config, indented
    // under the id so the eye picks up the task → blurb mapping.
    const taskDesc = shownDescription(t)
    if (taskDesc) {
      lines.push(`     ${' '.repeat(idWidth)}  ${dim(taskDesc)}`)
    }
    if (t.affected !== undefined) {
      lines.push(`     ${' '.repeat(idWidth)}  ${dim(`affected: ${describeReason(t.affected)}`)}`)
    }
    if (skipped) noop++
    else if (t.cacheStatus === 'hit-local') local++
    else if (t.cacheStatus === 'hit-remote') remote++
    else if (t.cacheStatus === 'miss') miss++
    else if (t.cacheStatus === 'no-cache') nocache++
    else if (t.cacheStatus === 'not-started') idle++
    else if (t.cacheStatus === 'skipped') platform++
  }

  const hitParts: string[] = []
  if (local > 0) hitParts.push(`${local} local`)
  if (remote > 0) {
    // The remote's sizes, summed: what restoring the hits would download.
    const bytes = real.reduce((sum, t) => sum + (t.remoteBytes ?? 0), 0)
    hitParts.push(bytes > 0 ? `${remote} remote, ${formatBytes(bytes)}` : `${remote} remote`)
  }
  const hits = local + remote
  const summary: string[] = [`${real.length} task(s) planned`]
  if (hits > 0) summary.push(`${hits} cache hit${hits === 1 ? '' : 's'} (${hitParts.join(', ')})`)
  if (miss > 0) summary.push(`${miss} would run`)
  if (nocache > 0) summary.push(`${nocache} no-cache`)
  if (noop > 0) summary.push(`${noop} noop`)
  if (idle > 0) summary.push(`${idle} not started`)
  if (platform > 0) summary.push(`${platform} skipped`)
  lines.push('')
  lines.push(dim(summary.join(', ') + '.'))

  // `--cache-download` is invisible without this: the eligibility gate silently
  // keeps producers eager, so a user who asked for `none` and got no
  // deferral has nothing to read. Say what WOULD stay remote, and name the
  // refusals when nothing would.
  const deferred = real.filter((t) => t.download === 'deferred')
  const downgrades = plan.downloadDowngrades ?? []
  if (deferred.length > 0 || downgrades.length > 0) {
    lines.push('')
    lines.push(
      dim(
        `download: ${deferred.length} task(s) would keep outputs remote` +
          (downgrades.length > 0 ? `, ${downgrades.length} kept eager:` : '.'),
      ),
    )
    for (const d of downgrades.slice(0, 3))
      lines.push(`    ${ui.inline(ui.id(d.taskId), c)} ${dim(`— ${d.reason}`)}`)
    if (downgrades.length > 3) lines.push(dim(`    …and ${downgrades.length - 3} more`))
  }

  // Time prediction — only when history gave us something to say: at least
  // one would-run task has a p50 (an all-unknown prediction is pure noise).
  const p = plan.predicted
  const executes = miss + nocache
  if (p !== undefined && executes > 0 && executes > p.unknownCount) {
    const parts = [`predicted: ~${formatElapsed(p.wallMs)} wall`]
    parts.push(`~${formatElapsed(p.workMs)} total execution`)
    if (p.unknownCount > 0) {
      parts.push(`${p.unknownCount} task${p.unknownCount === 1 ? '' : 's'} without history (+?)`)
    }
    lines.push(dim(parts.join(' · ')))
  }
  return lines.join('\n') + '\n'
}

/** One `--affected --dry` reason line: the cause, then the edge chain that carried it. */
function describeReason(r: AffectedReason): string {
  const cause =
    r.kind === 'named'
      ? 'named on the command line'
      : r.kind === 'selected'
        ? 'its project is selected outright'
        : r.kind === 'package'
          ? `a ^ edge passes changed package ${r.project}`
          : r.kind === 'input'
            ? `${r.file} changed (an input)`
            : r.kind === 'workspace'
              ? `${r.file} changed (workspace-wide)`
              : r.file !== undefined
                ? `${r.file} changed (in its project)`
                : 'its project changed as a whole'
  return r.via === undefined ? cause : `${cause}, via ${r.via.join(' ← ')}`
}

/** A TS config may build the description from `process.env` (L-11). */
function shownDescription(t: RunPlan['tasks'][number]): string | undefined {
  const { description, exec } = t.node.config
  return description === undefined ? undefined : maskedCommand(description, exec?.env)
}

/** One task of `vx run --dry=json`: the wire, stated by `schemas/plan.json`. */
export interface PlanTaskJson {
  id: string
  project: string
  task: string
  hash: string
  cacheStatus: CacheStatus
  deps: readonly string[]
  p50Ms?: number
  executor?: string
  download?: 'deferred'
  description?: string
  affected?: AffectedReason
  otherPlatform?: { readonly needs: readonly string[]; readonly host: string }
  blockedBy?: string
}

/** `affectedBase`: the ref a bare `--affected` guessed (or was given), so a reader knows what the diff was against. */
export function formatPlanJson(
  plan: Pick<RunPlan, 'tasks' | 'predicted' | 'downloadDowngrades'>,
  affectedBase?: string,
): string {
  return (
    JSON.stringify({
      ...(affectedBase !== undefined ? { affectedBase } : {}),
      tasks: plan.tasks.map((t): PlanTaskJson => {
        const description = shownDescription(t)
        return {
          id: t.node.id,
          project: t.node.projectName,
          task: t.node.taskName,
          hash: t.hash,
          cacheStatus: t.cacheStatus,
          deps: t.deps,
          ...(t.p50Ms !== undefined ? { p50Ms: t.p50Ms } : {}),
          ...(t.executor !== undefined ? { executor: t.executor } : {}),
          ...(t.download !== undefined ? { download: t.download } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(t.affected !== undefined ? { affected: t.affected } : {}),
          ...(t.otherPlatform !== undefined ? { otherPlatform: t.otherPlatform } : {}),
          ...(t.blockedBy !== undefined ? { blockedBy: t.blockedBy } : {}),
        }
      }),
      ...(plan.predicted !== undefined ? { predicted: plan.predicted } : {}),
      // The gate's refusals belong on the SCRIPTING surface too: a CI job
      // asking "did --cache-download=none actually defer anything, and if not
      // why" reads this, not the human table. (This object enumerates its
      // fields deliberately — the plan's internal shape is not the wire —
      // which is exactly why a new PlannedTask field does not appear here
      // for free, and why `download` above had to be added by hand.)
      ...(plan.downloadDowngrades !== undefined
        ? { downloadDowngrades: plan.downloadDowngrades }
        : {}),
    }) + '\n'
  )
}

/** A hit is green, a task that would run is yellow, the rest dim. */
const HUE: Record<CacheStatus, string> = {
  'hit-local': SUCCESS,
  'hit-remote': SUCCESS,
  miss: WARN,
  'no-cache': WARN,
  group: '',
  'not-started': '',
  skipped: '',
}

function symbolFor(s: CacheStatus): string {
  switch (s) {
    case 'hit-local':
      return '✓'
    case 'hit-remote':
      return '↓'
    case 'miss':
      return '▶'
    case 'no-cache':
      return '∅'
    case 'group':
      return '○'
    case 'not-started':
      return '−'
    case 'skipped':
      return '·'
  }
}

function describe(s: CacheStatus): string {
  switch (s) {
    case 'hit-local':
      return 'cache hit (local)'
    case 'hit-remote':
      return 'cache hit (remote)'
    case 'miss':
      return 'cache miss — would exec'
    case 'no-cache':
      return 'no-cache (would exec)'
    case 'group':
      return 'group task'
    case 'not-started':
      return 'not started (unneeded)'
    case 'skipped':
      return 'skipped'
  }
}
