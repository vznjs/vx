// The single json-render renderer for the dashboard. `createRenderer` binds the
// catalog vocabulary to concrete Solid components; `Dash` wraps it with the
// shared `$computed` functions map so pages only pass a static spec + raw state.

import type { JSX } from 'solid-js'
import { createRenderer } from '@json-render/solid'
import { catalog } from './catalog.ts'
import { FUNCTIONS } from './functions.ts'
import {
  CardEl,
  DataTable,
  Empty,
  Facts,
  FlamegraphEl,
  Grid,
  HeatmapEl,
  LineChartEl,
  LiveActivity,
  Metric,
  Page,
  RankList,
  Stack,
  Text,
  TreemapEl,
} from './components.tsx'

const DashRenderer = createRenderer(catalog, {
  Page,
  Stack,
  Grid,
  Card: CardEl,
  Metric,
  Text,
  Empty,
  Facts,
  LineChart: LineChartEl,
  Treemap: TreemapEl,
  Heatmap: HeatmapEl,
  Flamegraph: FlamegraphEl,
  DataTable,
  RankList,
  LiveActivity,
})

/** Render a static spec against raw `state`, with the shared formatter functions. */
export function Dash(props: { spec: Parameters<typeof DashRenderer>[0]['spec']; state?: Record<string, unknown> }): JSX.Element {
  return <DashRenderer spec={props.spec} state={props.state} functions={FUNCTIONS} />
}
