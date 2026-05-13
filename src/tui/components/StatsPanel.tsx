// Stats panel — three sparklines: throughput, parallel %, remote ops/s.
// Used inside the Overview view; also a standalone block the Stats
// view will reuse later.

import type React from 'react'
import type { State } from '../state/store.js'
import { renderSparkline } from '../primitives/sparkline.js'

interface Props {
  state: State
  width: number
}

export function StatsPanel({ state, width }: Props): React.ReactNode {
  const innerWidth = Math.max(8, width - 24)
  const tput = renderSparkline(state.throughputBuf, innerWidth)
  const par = renderSparkline(state.parallelPctBuf, innerWidth)
  const remote = renderSparkline(state.remoteOpsBuf, innerWidth)
  const lastT = lastSample(state.throughputBuf)
  const lastP = lastSample(state.parallelPctBuf)
  const lastR = lastSample(state.remoteOpsBuf)
  return (
    <box flexDirection="column" border borderColor="#374151" title="Stats" width={width}>
      <Line label="throughput" line={tput} suffix={`${lastT}/s`} />
      <Line label="parallel %" line={par} suffix={`${lastP}%`} />
      <Line label="remote ops" line={remote} suffix={`${lastR}/s`} />
    </box>
  )
}

interface LineProps {
  label: string
  line: string
  suffix: string
}

function Line({ label, line, suffix }: LineProps): React.ReactNode {
  return (
    <box flexDirection="row" paddingLeft={1} paddingRight={1}>
      <text content={label.padEnd(11)} fg="#9ca3af" />
      <text content={line} fg="#22c55e" />
      <text content="  " />
      <text content={suffix} fg="#d1d5db" />
    </box>
  )
}

function lastSample(buf: State['throughputBuf']): number {
  if (buf.len === 0) return 0
  const cap = buf.samples.length
  const idx = (buf.head - 1 + cap) % cap
  return Math.round(buf.samples[idx] ?? 0)
}
