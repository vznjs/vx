// The single json-render renderer for the dashboard. `createRenderer` binds the
// catalog vocabulary to concrete Solid components and returns a component that
// renders any spec authored against that catalog: `<DashRenderer spec={...} />`.

import { createRenderer } from '@json-render/solid'
import { catalog } from './catalog.ts'
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

export const DashRenderer = createRenderer(catalog, {
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
