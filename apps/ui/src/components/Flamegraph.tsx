import { For } from 'solid-js'
import type { RunSummaryRow } from '../api.ts'
import { layout, type LayoutInput } from '../flamegraph-layout.ts'

const LANE_HEIGHT = 22
const LANE_PAD = 4

function colorFor(status: string, cacheHit: boolean): string {
  if (status === 'failed') return 'bg-failure/80'
  if (status === 'skipped') return 'bg-skipped/70'
  if (cacheHit) return 'bg-cache/70'
  return 'bg-success/70'
}

export function Flamegraph(props: { tasks: readonly RunSummaryRow[] }) {
  const inputs = (): LayoutInput[] =>
    props.tasks
      .filter((t) => t.wallclockStartNs !== null && t.wallclockEndNs !== null)
      .map((t) => ({
        taskId: `${t.project}#${t.task}`,
        project: t.project,
        startNs: Number(t.wallclockStartNs),
        endNs: Number(t.wallclockEndNs),
        status: t.status,
        cacheHit: t.cacheHit === true,
      }))

  const l = () => layout(inputs())

  return (
    <div class="flex flex-col gap-2">
      <div class="text-fg-muted text-xs uppercase tracking-wider">Flamegraph</div>
      <div
        class="relative border border-border-muted rounded bg-bg-elevated"
        style={{
          height: `${Math.max(1, l().lanes.length) * (LANE_HEIGHT + LANE_PAD) + LANE_PAD}px`,
        }}
      >
        <For each={l().lanes}>
          {(lane, i) => (
            <div
              class="absolute left-0 right-0 border-b border-border-muted/40 text-fg-muted text-[10px] pl-1 font-mono"
              style={{
                top: `${i() * (LANE_HEIGHT + LANE_PAD) + LANE_PAD}px`,
                height: `${LANE_HEIGHT}px`,
              }}
            >
              {lane}
            </div>
          )}
        </For>
        <For each={l().bars}>
          {(bar) => (
            <div
              class={`absolute rounded text-[10px] text-bg font-medium overflow-hidden whitespace-nowrap px-1 ${colorFor(bar.status, bar.cacheHit)}`}
              style={{
                left: `${bar.leftPct}%`,
                width: `${bar.widthPct}%`,
                top: `${bar.lane * (LANE_HEIGHT + LANE_PAD) + LANE_PAD}px`,
                height: `${LANE_HEIGHT}px`,
                'line-height': `${LANE_HEIGHT}px`,
              }}
              title={bar.taskId}
            >
              {bar.taskId}
            </div>
          )}
        </For>
      </div>
    </div>
  )
}
