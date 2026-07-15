// The JSON-spec rendering path for the catalog.
//
// The catalog components (components.tsx) are native json-render components —
// each takes `BaseComponentProps<P>` — so they register DIRECTLY via the
// documented `defineRegistry` API with no adapter. `defineRegistry` hands each
// component a reactive `props` getter, so prop reads stay live as async state
// resolves.
//
// `Dash` is the render entry for a pure-JSON spec bound to raw `state`:
//   <Dash spec={json} state={rawData} />

import type { JSX } from 'solid-js'
import { JSONUIProvider, Renderer, defineRegistry } from '@json-render/solid'
import { useNavigate } from '@solidjs/router'
import type { Spec } from '@json-render/solid'
import { catalog } from './catalog.ts'
import { FUNCTIONS } from './functions.ts'
import * as C from './components.tsx'

const { registry } = defineRegistry(catalog, {
  components: {
    Page: C.Page,
    Stack: C.Stack,
    Grid: C.Grid,
    Card: C.Card,
    Metric: C.Metric,
    Text: C.Text,
    Empty: C.Empty,
    Facts: C.Facts,
    LineChart: C.LineChart,
    Treemap: C.Treemap,
    Heatmap: C.Heatmap,
    RunViz: C.RunViz,
    DataTable: C.DataTable,
    RankList: C.RankList,
    SparkList: C.SparkList,
    RecList: C.RecList,
    TimeframeSelect: C.TimeframeSelect,
    TaskLogs: C.TaskLogs,
    Json: C.Json,
    TaskConfigList: C.TaskConfigList,
    ArtifactDownload: C.ArtifactDownload,
  },
})

/** Render a raw-JSON spec against raw `state`, through the shared catalog. */
export function Dash(props: { spec: Spec | null; state?: Record<string, unknown> }): JSX.Element {
  const navigate = useNavigate()
  return (
    <JSONUIProvider registry={registry} initialState={props.state} functions={FUNCTIONS} navigate={navigate}>
      <Renderer spec={props.spec} registry={registry} />
    </JSONUIProvider>
  )
}
