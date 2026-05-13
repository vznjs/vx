// Stats panel — three single-line sparklines (throughput, parallel %,
// remote ops). Each row is one pre-padded string so the OpenTUI
// painter never leaves stale cells on shrink (multi-element rows
// ghost text in incremental redraws).

import type React from 'react'
import type { State } from '../state/store.js'
import { renderSparkline, type SparklineBuf } from '../primitives/sparkline.js'

interface Props {
  state: State
  width: number
}

const LABEL_WIDTH = 12
const SUFFIX_WIDTH = 8

export function StatsPanel({ state, width }: Props): React.ReactNode {
  const innerWidth = Math.max(8, width - LABEL_WIDTH - SUFFIX_WIDTH - 4)
  const lines = [
    formatLine('throughput', state.throughputBuf, '/s', innerWidth),
    formatLine('parallel %', state.parallelPctBuf, '%', innerWidth),
    formatLine('remote ops', state.remoteOpsBuf, '/s', innerWidth),
  ]
  return (
    <box flexDirection="column" border borderColor="#374151" title="Stats" width={width}>
      {lines.map((line, i) => (
        <text key={String(i)} content={line} fg="#22c55e" />
      ))}
    </box>
  )
}

function formatLine(label: string, buf: SparklineBuf, unit: string, innerWidth: number): string {
  const sparks = renderSparkline(buf, innerWidth)
  const last = Math.round(lastSample(buf))
  const suffix = `${last}${unit}`
  return ` ${label.padEnd(LABEL_WIDTH)} ${sparks}  ${suffix.padEnd(SUFFIX_WIDTH)}`
}

function lastSample(buf: SparklineBuf): number {
  if (buf.len === 0) return 0
  const cap = buf.samples.length
  const idx = (buf.head - 1 + cap) % cap
  return buf.samples[idx] ?? 0
}
