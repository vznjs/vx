import { For, Show, createResource } from 'solid-js'
import { useNavigate } from '@solidjs/router'
import { getBottlenecks, getFlakiest, getOriginSignal, getPrunable } from '../api.ts'
import { Card, EmptyState } from '../components/ui.tsx'
import { HBar } from '../components/charts.tsx'
import { formatBytes, formatDuration, formatPercent, formatRelativeTime } from '../format.ts'

export function Bottlenecks() {
  const origin = getOriginSignal()
  const navigate = useNavigate()
  const [bottlenecks] = createResource(origin, () => getBottlenecks(14, 25))
  const [flaky] = createResource(origin, () => getFlakiest(25))
  const [prunable] = createResource(origin, () => getPrunable(7, 25))

  return (
    <div class="flex flex-col gap-5">
      <div>
        <h1 class="text-base font-semibold m-0">Bottlenecks</h1>
        <p class="text-fg-3 text-[12px] mt-1">High-leverage targets — ranked by where you'd save the most time.</p>
      </div>

      <Card
        title="Where to invest"
        action={<span class="text-[10px] text-fg-3 font-mono">14-day lookback · savings = 25% cut, extrapolated weekly</span>}
        noPad
      >
        <Show when={(bottlenecks() ?? []).length > 0} fallback={<EmptyState title="Not enough runs to rank bottlenecks" hint="Run a few tasks and come back." />}>
          <table class="w-full text-[12px]">
            <thead class="bg-surface-2/40">
              <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                <th class="text-left px-4 py-2 font-semibold">Task</th>
                <th class="text-right px-4 py-2 font-semibold">Runs / day</th>
                <th class="text-right px-4 py-2 font-semibold">Avg</th>
                <th class="text-right px-4 py-2 font-semibold">Total burn</th>
                <th class="text-right px-4 py-2 font-semibold">Weekly savings</th>
              </tr>
            </thead>
            <tbody>
              <For each={bottlenecks()!}>
                {(b, i) => {
                  const max = Math.max(...(bottlenecks() ?? []).map((x) => x.weeklySavingsAt25PctCutMs))
                  return (
                    <tr
                      class="border-t border-border hover:bg-surface-hover cursor-pointer"
                      onClick={() => navigate(`/tasks/${encodeURIComponent(b.id)}`)}
                    >
                      <td class="px-4 py-2 font-mono">
                        <span class="text-fg-3 text-[10px] mr-2">{i() + 1}.</span>
                        <span class="text-fg-3">{b.project}#</span>{b.task}
                      </td>
                      <td class="px-4 py-2 text-right font-mono">{b.runsPerDay.toFixed(1)}</td>
                      <td class="px-4 py-2 text-right font-mono">{formatDuration(b.avgDurationMs)}</td>
                      <td class="px-4 py-2 text-right font-mono">{formatDuration(b.totalDurationMs)}</td>
                      <td class="px-4 py-2 text-right font-mono text-success">
                        <div class="flex items-center gap-2 justify-end">
                          <span class="w-16">{formatDuration(b.weeklySavingsAt25PctCutMs)}</span>
                          <div class="w-20"><HBar fraction={b.weeklySavingsAt25PctCutMs / max} colorClass="bg-success" /></div>
                        </div>
                      </td>
                    </tr>
                  )
                }}
              </For>
            </tbody>
          </table>
        </Show>
      </Card>

      <div class="grid grid-cols-1 lg:grid-cols-2 gap-4">
        <Card title="Flaky tasks" action={<span class="text-[10px] text-fg-3 font-mono">failure rate + tail ratio</span>} noPad>
          <Show when={(flaky() ?? []).length > 0} fallback={<div class="text-fg-3 text-xs text-center py-12">No flaky tasks. <span class="text-success">🎉</span></div>}>
            <table class="w-full text-[12px]">
              <thead class="bg-surface-2/40">
                <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                  <th class="text-left px-4 py-2 font-semibold">Task</th>
                  <th class="text-right px-4 py-2 font-semibold">Fail %</th>
                  <th class="text-right px-4 py-2 font-semibold">p99/p50</th>
                </tr>
              </thead>
              <tbody>
                <For each={flaky()!}>
                  {(f) => (
                    <tr
                      class="border-t border-border hover:bg-surface-hover cursor-pointer"
                      onClick={() => navigate(`/tasks/${encodeURIComponent(f.id)}`)}
                    >
                      <td class="px-4 py-2 font-mono">
                        <span class="text-fg-3">{f.project}#</span>{f.task}
                      </td>
                      <td class="px-4 py-2 text-right font-mono" classList={{ 'text-danger': f.failureRate > 0.1 }}>
                        {formatPercent(f.failureRate, 0)}
                      </td>
                      <td class="px-4 py-2 text-right font-mono" classList={{ 'text-warn': (f.durationTailRatio ?? 0) > 3 }}>
                        {f.durationTailRatio?.toFixed(1) ?? '—'}×
                      </td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
          </Show>
        </Card>

        <Card title="Prunable cache entries" action={<span class="text-[10px] text-fg-3 font-mono">unused ≥7d</span>} noPad>
          <Show when={(prunable() ?? []).length > 0} fallback={<div class="text-fg-3 text-xs text-center py-12">Everything's been accessed recently.</div>}>
            <table class="w-full text-[12px]">
              <thead class="bg-surface-2/40">
                <tr class="text-fg-3 text-[10px] uppercase tracking-wider">
                  <th class="text-left px-4 py-2 font-semibold">Task</th>
                  <th class="text-right px-4 py-2 font-semibold">Size</th>
                  <th class="text-right px-4 py-2 font-semibold">Last hit</th>
                </tr>
              </thead>
              <tbody>
                <For each={prunable()!}>
                  {(e) => (
                    <tr class="border-t border-border">
                      <td class="px-4 py-2 font-mono">
                        <span class="text-fg-3">{e.project}#</span>{e.task}
                      </td>
                      <td class="px-4 py-2 text-right font-mono">{formatBytes(e.sizeBytes)}</td>
                      <td class="px-4 py-2 text-right font-mono text-fg-3">{formatRelativeTime(e.accessedAt)}</td>
                    </tr>
                  )}
                </For>
              </tbody>
            </table>
            <div class="px-4 py-2 text-[10px] text-fg-3 font-mono border-t border-border">
              Tip: <code class="text-fg-1">vx cache prune --older-than 7d</code>
            </div>
          </Show>
        </Card>
      </div>
    </div>
  )
}
