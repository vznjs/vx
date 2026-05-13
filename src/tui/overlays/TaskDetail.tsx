// Task Detail overlay — Enter on a task opens this. Modal popup with
// absolute positioning so it actually covers the underlying view.

import type React from 'react'
import type { State } from '../state/store.js'

interface Props {
  state: State
  screenWidth: number
  screenHeight: number
}

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`
  return `${(ms / 1000).toFixed(2)}s`
}

export function TaskDetail({ state, screenWidth, screenHeight }: Props): React.ReactNode {
  const popupWidth = Math.min(80, Math.max(50, screenWidth - 8))
  const popupHeight = Math.min(28, Math.max(14, screenHeight - 6))
  const left = Math.max(0, Math.floor((screenWidth - popupWidth) / 2))
  const top = Math.max(0, Math.floor((screenHeight - popupHeight) / 2))
  const id = state.selectedTaskId
  const row = id ? state.tasks.get(id) : undefined

  if (!row) {
    return (
      <box
        position="absolute"
        left={left}
        top={top}
        width={popupWidth}
        height={popupHeight}
        flexDirection="column"
        paddingLeft={2}
        paddingRight={2}
        paddingTop={1}
        paddingBottom={1}
        border
        borderColor="#a78bfa"
        title="Task Detail"
        backgroundColor="#111827"
      >
        <text content="(no task selected)" fg="#9ca3af" />
      </box>
    )
  }
  const hist = state.history.get(row.id)
  const logTail = row.logLines.slice(-Math.max(3, popupHeight - 14))

  return (
    <box
      position="absolute"
      left={left}
      top={top}
      width={popupWidth}
      height={popupHeight}
      flexDirection="column"
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
      border
      borderColor="#a78bfa"
      title={`Task — ${row.id}`}
      backgroundColor="#111827"
    >
      <Line label="status" value={row.status} />
      <Line label="kind" value={row.kind} />
      <Line label="slot" value={row.slot !== undefined ? String(row.slot) : '—'} />
      <Line label="cache" value={row.cacheStatus ?? '—'} />
      <Line label="deps" value={row.deps.join(', ') || '—'} />
      <Line label="blocks" value={String(row.dependentsCount)} />
      <text content=" " fg="#111827" />
      <text content="History" fg="#a78bfa" attributes={1} />
      {hist ? (
        <>
          <Line label="  runs" value={String(hist.runs)} />
          <Line label="  avg" value={formatMs(Math.round(hist.avgMs))} />
          <Line label="  p99" value={formatMs(Math.round(hist.p99Ms))} />
          <Line label="  hit %" value={`${Math.round(hist.hitRate * 100)}%`} />
          <Line label="  ok %" value={`${Math.round(hist.successRate * 100)}%`} />
        </>
      ) : (
        <text content="  (no prior runs)" fg="#6b7280" />
      )}
      <text content=" " fg="#111827" />
      <text content="Recent log" fg="#a78bfa" attributes={1} />
      {logTail.length === 0 ? (
        <text content="  (no output)" fg="#6b7280" />
      ) : (
        logTail.map((line, i) => (
          <text key={`${i}-${line}`} content={`  ${line.length === 0 ? ' ' : line}`} fg="#d1d5db" />
        ))
      )}
    </box>
  )
}

function Line({ label, value }: { label: string; value: string }): React.ReactNode {
  return (
    <box flexDirection="row">
      <text content={label.padEnd(12)} fg="#9ca3af" />
      <text content={value} fg="#d1d5db" />
    </box>
  )
}
