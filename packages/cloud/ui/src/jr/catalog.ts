// json-render catalog: the set of component names the dashboard specs may use.
//
// Props are typed `z.any()` deliberately — the renderer does not validate props
// at render time (validateSpec is a separate dev tool we don't run), and the
// specs are authored in TS where the component implementations already pin the
// real prop shapes. The catalog's job here is simply to declare the vocabulary.

import { defineCatalog } from '@json-render/core'
import { schema } from '@json-render/solid/schema'
import { z } from 'zod'

const anyProps = () => ({ props: z.any() })

export const catalog = defineCatalog(schema, {
  components: {
    Page: anyProps(),
    Stack: anyProps(),
    Grid: anyProps(),
    Card: anyProps(),
    Metric: anyProps(),
    Text: anyProps(),
    Empty: anyProps(),
    Facts: anyProps(),
    LineChart: anyProps(),
    Treemap: anyProps(),
    Heatmap: anyProps(),
    RunViz: anyProps(),
    DataTable: anyProps(),
    RankList: anyProps(),
    SparkList: anyProps(),
    RecList: anyProps(),
    TimeframeSelect: anyProps(),
    TaskLogs: anyProps(),
    Json: anyProps(),
    TaskConfigList: anyProps(),
    ArtifactDownload: anyProps(),
  },
  actions: {},
})
