// The JSON-spec rendering path for the catalog.
//
// The SAME plain components used directly in JSX (components.tsx) are exposed to
// json-render here via the documented `defineRegistry` + `<Renderer>` API. The
// only glue is `adapt`: json-render hands a component its resolved props as
// `ctx.props` (a reactive getter) + `ctx.children`; `adapt` forwards those to a
// plain component as ordinary props (through a live proxy so prop reads stay
// reactive when async state resolves).
//
// Pages render in JSX directly. `Dash` is for raw-JSON / AI-generated specs:
//   <Dash spec={json} state={rawData} />

import type { JSX } from 'solid-js'
import { JSONUIProvider, Renderer, defineRegistry } from '@json-render/solid'
import { useNavigate } from '@solidjs/router'
import type { Spec } from '@json-render/solid'
import { catalog } from './catalog.ts'
import { FUNCTIONS } from './functions.ts'
import * as C from './components.tsx'

// json-render render ctx → plain props. `ctx.props` is a reactive getter, so we
// proxy rather than snapshot — reading `props.x` in the component stays live.
interface JrCtx {
  // json-render types resolved props as `unknown` (the catalog uses z.any()).
  props: unknown
  children?: unknown
}
type PlainComponent = (props: Record<string, unknown>) => JSX.Element
const adapt =
  (Comp: PlainComponent) =>
  (ctx: JrCtx): JSX.Element =>
    Comp(
      new Proxy(
        {},
        {
          get: (_t, key) => (key === 'children' ? ctx.children : (ctx.props as Record<string, unknown>)[key as string]),
        },
      ) as Record<string, unknown>,
    )

const { registry } = defineRegistry(catalog, {
  components: {
    Page: adapt(C.Page as PlainComponent),
    Stack: adapt(C.Stack as PlainComponent),
    Grid: adapt(C.Grid as PlainComponent),
    Card: adapt(C.Card as PlainComponent),
    Metric: adapt(C.Metric as PlainComponent),
    Text: adapt(C.Text as PlainComponent),
    Empty: adapt(C.Empty as PlainComponent),
    Facts: adapt(C.Facts as PlainComponent),
    LineChart: adapt(C.LineChart as PlainComponent),
    Treemap: adapt(C.Treemap as PlainComponent),
    Heatmap: adapt(C.Heatmap as PlainComponent),
    Flamegraph: adapt(C.Flamegraph as PlainComponent),
    DataTable: adapt(C.DataTable as PlainComponent),
    RankList: adapt(C.RankList as PlainComponent),
    LiveActivity: adapt(C.LiveActivity as PlainComponent),
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
