// `vx history`'s pretty table, apart from the verb that reads the history:
// a pure function of the rows, so its thresholds and its unit breaks are
// pinned without a run.

import type { Budgets, ResourceEstimate } from './index.js'

export interface HistoryRow {
  id: string
  runs: number
  p50DurationMs: number | null
  maxPeakRssBytes: number | null
  maxCpuParallelism: number | null
  reservation: ResourceEstimate | null
  declared: boolean
}

const MB = 1024 * 1024

/**
 * The table: every task with an execution in the window or a reservation,
 * then a count of the ones with neither. `memoryDeclared` says where the
 * memory budget came from (the option, or what the process may use).
 */
export function renderHistory(
  rows: readonly HistoryRow[],
  window: number,
  budgets: Budgets,
  memoryDeclared: boolean,
): string {
  const seen = rows.filter((r) => r.runs > 0 || r.reservation !== null)
  const lines: string[] = [
    `history: last ${window} runs · budgets ${budgets.cpus} cores (the default worker count; --concurrency changes it per run) · ${budgets.memory} MB` +
      `${memoryDeclared ? ' (the memory option)' : ' (what this process may use)'}`,
  ]
  if (seen.length === 0) {
    lines.push('no task has an execution in the window — run something first')
  } else {
    const idW = Math.max(...seen.map((r) => r.id.length), 4)
    lines.push(
      `  ${'task'.padEnd(idW)}  ${'runs'.padStart(4)}  ${'p50'.padStart(7)}  ${'peak rss'.padStart(8)}  ${'cpu'.padStart(5)}  reserves`,
    )
    for (const r of seen) {
      const reserve =
        r.reservation === null
          ? '—'
          : [
              ...(r.reservation.memory !== undefined ? [`${r.reservation.memory} MB`] : []),
              ...(r.reservation.cpus !== undefined
                ? [`${r.reservation.cpus} core${r.reservation.cpus === 1 ? '' : 's'}`]
                : []),
            ].join(' · ') + (r.declared ? ' (declared)' : '')
      lines.push(
        `  ${r.id.padEnd(idW)}  ${String(r.runs).padStart(4)}  ${fmtMs(r.p50DurationMs).padStart(7)}  ` +
          `${fmtBytes(r.maxPeakRssBytes).padStart(8)}  ${(r.maxCpuParallelism === null ? '—' : `${r.maxCpuParallelism.toFixed(1)}×`).padStart(5)}  ${reserve}`,
      )
    }
    const silent = rows.length - seen.length
    if (silent > 0) {
      lines.push(
        `  ${silent} task${silent === 1 ? '' : 's'} with no execution in the window reserve${silent === 1 ? 's' : ''} nothing`,
      )
    }
  }
  return `${lines.join('\n')}\n`
}

function fmtMs(ms: number | null): string {
  if (ms === null) return '—'
  if (ms < 1000) return `${Math.round(ms)}ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(2)}s`
  const m = Math.floor(ms / 60_000)
  return `${m}m ${Math.round((ms - m * 60_000) / 1000)}s`
}

function fmtBytes(n: number | null): string {
  if (n === null) return '—'
  if (n < MB) return `${Math.round(n / 1024)} KB`
  if (n < 1024 * MB) return `${(n / MB).toFixed(0)} MB`
  return `${(n / (1024 * MB)).toFixed(1)} GB`
}
