// `vx history`'s pretty table, apart from the verb that reads the history:
// a pure function of the rows, so its thresholds and its unit breaks are
// pinned without a run.

import { ui } from '@vzn/vx'
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
 * Painted as core's tables are (a dim header, each id in its hue).
 */
export function historyBlock(
  rows: readonly HistoryRow[],
  window: number,
  budgets: Budgets,
  memoryDeclared: boolean,
): ui.Block {
  const seen = rows.filter((r) => r.runs > 0 || r.reservation !== null)
  const lines: ui.Inline[] = [
    [
      ui.cmd('history:'),
      ui.dim(
        ` last ${window} runs · budgets ${budgets.cpus} core${budgets.cpus === 1 ? '' : 's'} (the default worker count; --concurrency changes it per run) · ${budgets.memory} MB` +
          `${memoryDeclared ? ' (the memory option)' : ' (what this process may use)'}`,
      ),
    ],
  ]
  if (seen.length === 0) {
    lines.push(ui.dim('no task has an execution in the window — run something first'))
  } else {
    const idW = Math.max(...seen.map((r) => Bun.stringWidth(r.id)), 4)
    lines.push(
      ui.dim(
        `  ${'task'.padEnd(idW)}  ${'runs'.padStart(4)}  ${'p50'.padStart(7)}  ${'peak rss'.padStart(8)}  ${'cpu'.padStart(5)}  reserves`,
      ),
    )
    for (const r of seen) {
      const amounts =
        r.reservation === null
          ? []
          : [
              ...(r.reservation.memory !== undefined ? [`${r.reservation.memory} MB`] : []),
              ...(r.reservation.cpus !== undefined
                ? [`${r.reservation.cpus} core${r.reservation.cpus === 1 ? '' : 's'}`]
                : []),
            ]
      // A declaration of nothing (`{ memory: 0 }`) still names itself.
      const reserve =
        (amounts.length === 0 ? '—' : amounts.join(' · ')) +
        (r.reservation !== null && r.declared ? ' (declared)' : '')
      lines.push([
        '  ',
        ui.id(r.id),
        ' '.repeat(idW - Bun.stringWidth(r.id)),
        `  ${String(r.runs).padStart(4)}  ${fmtMs(r.p50DurationMs).padStart(7)}  ` +
          `${fmtBytes(r.maxPeakRssBytes).padStart(8)}  ${(r.maxCpuParallelism === null ? '—' : `${r.maxCpuParallelism.toFixed(1)}×`).padStart(5)}  ${reserve}`,
      ])
    }
    const silent = rows.length - seen.length
    if (silent > 0) {
      lines.push(
        ui.dim(
          `  ${silent} task${silent === 1 ? '' : 's'} with no execution in the window reserve${silent === 1 ? 's' : ''} nothing`,
        ),
      )
    }
  }
  return { lines: (c) => lines.map((l) => ui.inline(l, c)) }
}

/** The table as plain text, as a pipe gets it. */
export function renderHistory(
  rows: readonly HistoryRow[],
  window: number,
  budgets: Budgets,
  memoryDeclared: boolean,
): string {
  return ui.render([historyBlock(rows, window, budgets, memoryDeclared)], { enabled: false })
}

// Each unit is chosen by the rounded value: 59 999 ms printed `60.00s`,
// 119.7 s `1m 60s`, and a byte under 1 MiB `1024 KB`.
function fmtMs(ms: number | null): string {
  if (ms === null) return '—'
  if (Math.round(ms) < 1000) return `${Math.round(ms)}ms`
  if (Math.round(ms / 10) < 6000) return `${(ms / 1000).toFixed(2)}s`
  const s = Math.round(ms / 1000)
  return `${Math.floor(s / 60)}m ${s % 60}s`
}

function fmtBytes(n: number | null): string {
  if (n === null) return '—'
  if (Math.round(n / 1024) < 1024) return `${Math.round(n / 1024)} KB`
  if (Math.round(n / MB) < 1024) return `${(n / MB).toFixed(0)} MB`
  return `${(n / (1024 * MB)).toFixed(1)} GB`
}
