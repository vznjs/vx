import { For } from 'solid-js'
import type { RunSummaryRow } from '../api.ts'
import { layout, type LayoutInput } from '../flamegraph-layout.ts'

const LANE_HEIGHT = 22
const LANE_PAD = 4

function colorFor(status: string, cacheHit: boolean): string {
  if (status === 'failed') return 'bg-danger/80'
  if (status === 'skipped') return 'bg-warn/70'
  if (cacheHit) return 'bg-cache-local/70'
  return 'bg-success/70'
}

export function Flamegraph(props: { tasks: readonly RunSummaryRow[] }) {
  // Use startedAt/endedAt (epoch ms, present for EVERY task) as the uniform
  // time base — wallclock ns spans are null for cache hits, so keying off them
  // dropped every restored task from the chart. ms units are fine: the layout
  // normalizes against the run window, so only relative proportions matter.
  const inputs = (): LayoutInput[] =>
    props.tasks.map((t) => ({
      taskId: `${t.project}#${t.task}`,
      project: t.project,
      startNs: t.startedAt,
      endNs: t.endedAt,
      status: t.status,
      cacheHit: t.cacheHit === true,
    }))

  const l = () => layout(inputs())

  return (
    <div class="flex flex-col gap-2">
      <div
        class="relative rounded bg-surface-2"
        style={{
          height: `${Math.max(1, l().lanes.length) * (LANE_HEIGHT + LANE_PAD) + LANE_PAD}px`,
        }}
      >
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
