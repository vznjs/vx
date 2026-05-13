// Bottlenecks view — four small panels: critical path (predicted /
// observed), top blockers (by dependents count), slow vs history
// (live; ratio > 1.5×), cache-miss impact (predicted cost of misses).

import type React from 'react'
import type { State, TaskRow } from '../state/store.js'
import {
  selectTopBlockers,
  selectSlowVsHistory,
  selectCacheMissImpact,
} from '../state/selectors.js'
import { computeCriticalPath } from '../state/critical-path.js'

interface Props {
  state: State
  width: number
  height: number
  nowMs: number
}

export function Bottlenecks({ state, width, height, nowMs }: Props): React.ReactNode {
  void height
  const critical = computeCriticalPath({
    tasks: [...state.tasks.values()].map((row) => ({
      id: row.id,
      deps: row.deps,
      status: row.status,
      persistent: row.kind === 'persistent',
      ...(row.endNs !== undefined && row.startNs !== undefined
        ? { actualMs: Math.max(0, Math.floor(Number(row.endNs - row.startNs) / 1_000_000)) }
        : {}),
      ...(row.startNs !== undefined && row.endNs === undefined && row.status === 'running'
        ? { currentElapsedMs: Math.max(0, nowMs - Math.floor(Number(row.startNs) / 1_000_000)) }
        : {}),
      ...(state.history.get(row.id)?.avgMs !== undefined
        ? { historyAvgMs: state.history.get(row.id)!.avgMs }
        : {}),
    })),
  })
  const blockers = selectTopBlockers(state, 5)
  const slow = selectSlowVsHistory(state, nowMs)
  const misses = selectCacheMissImpact(state)
  const half = Math.floor((width - 1) / 2)

  return (
    <box flexDirection="column" width={width}>
      <box flexDirection="row" width={width}>
        <Panel
          title={`Critical path (~${critical.totalMs}ms)`}
          width={half}
          rows={critical.path.map((id) => `◆ ${id}  ${critical.weights[id] ?? 0}ms`)}
          empty="(no path yet)"
        />
        <Panel
          title="Top blockers"
          width={width - half}
          rows={blockers.map((r) => `▣ ${r.id}  blocks ${r.dependentsCount}`)}
          empty="(none)"
        />
      </box>
      <box flexDirection="row" width={width}>
        <Panel
          title="Slow vs history"
          width={half}
          rows={slow.map((r: TaskRow) => {
            const hist = state.history.get(r.id)?.avgMs ?? 0
            return `▲ ${r.id}  ${nowMs}ms / ~${Math.round(hist)}ms`
          })}
          empty="(nothing slow)"
        />
        <Panel
          title="Cache-miss impact"
          width={width - half}
          rows={misses.map(
            (r: TaskRow) => `✗ ${r.id}  ~${Math.round(state.history.get(r.id)?.avgMs ?? 0)}ms`,
          )}
          empty="(no misses)"
        />
      </box>
    </box>
  )
}

function Panel({
  title,
  width,
  rows,
  empty,
}: {
  title: string
  width: number
  rows: string[]
  empty: string
}): React.ReactNode {
  return (
    <box flexDirection="column" width={width} border borderColor="#374151" title={title}>
      {rows.length === 0 ? (
        <text content={`  ${empty}`} fg="#6b7280" />
      ) : (
        rows.map((line, i) => <text key={`${i}-${line}`} content={`  ${line}`} fg="#d1d5db" />)
      )}
    </box>
  )
}
