// Chapter 9, guide/inside-vx: the pipeline, a seam at each stage, the local
// floor, and a plugin in twenty lines. It hosts the pipeline explorer, so
// the explorer's rows moved here from learn-architecture.test.ts: the model
// names every hook in core's PLUGIN_HOOKS, in its order, and no other; the
// declarations it shows are read from VxPlugin's source and held to ones
// written out by hand; its first-party column is what each first-party
// factory returns; each stage's example type-checks and fills its stage.
// The worked plugin the chapter shows is a file under src/examples/, shown
// from that file and type-checked with the workspace that declares it.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLUGIN_HOOKS, type VxPlugin } from '@vzn/vx'
import { github } from '@vzn/vx-github'
import { bun as bunLock, npm, pnpm, yarn } from '@vzn/vx-lockfile'
import { mcp } from '@vzn/vx-mcp'
import { nx, nxCache, turbo, turboCache } from '@vzn/vx-migrate'
import { otel } from '@vzn/vx-otel'
import { reapi } from '@vzn/vx-reapi'
import { scheduleHistoryPlugin } from '@vzn/vx-schedule-history'
import { STAGES, hookSignatures, stageExample } from '../src/components/demos/model/pipeline.js'
import * as P from '../src/components/guide/inside-vx/pictures.js'
import {
  DIST,
  SITE,
  chapterShape,
  codeBlocks,
  content,
  defining,
  only,
  page,
  prose,
  tableRows,
  text,
  typeCheck,
} from './guide-page.js'

const SLUG = 'inside-vx'
const EXAMPLES = path.join(SITE, 'src/examples')
// Through the site's own link to core: the sandbox grants a project's
// linked dependencies, and the task declares the file as an input.
const PLUGIN_TS = path.join(SITE, 'node_modules/@vzn/vx/src/orchestrator/plugin.ts')
const WORKED = 'summary-line.ts'

// The truth the chapter teaches, written out by hand, so a wrong model
// cannot pass by agreeing with its own render.
const RUN = [
  'config',
  'project',
  'graph',
  'key',
  'fingerprint',
  'schedule',
  'admit',
  'executor',
  'cache',
  'telemetry',
]
const AROUND = ['setup', 'commands', 'teardown']

/** Each hook as `VxPlugin` declares it, whitespace collapsed. */
const SIGNATURES: Record<string, string> = {
  config: 'config?(workspace: WorkspaceConfig, ctx: WorkspaceHookContext): void | Promise<void>',
  project: 'project?(config: ProjectConfig, ctx: ProjectHookContext): void | Promise<void>',
  graph: 'graph?(nodes: Map<string, TaskNode>, ctx: GraphHookContext): void | Promise<void>',
  key:
    'key?( task: TaskNode, ctx: KeyHookContext, ): | Readonly<Record<string, string>> ' +
    '| undefined | Promise<Readonly<Record<string, string>> | undefined>',
  fingerprint:
    'readonly fingerprint?: FingerprintClaim interface FingerprintClaim { ' +
    'readonly files: readonly string[] affected( change: FingerprintChange, ' +
    'ctx: FingerprintContext, ): Iterable<string> | undefined | ' +
    'Promise<Iterable<string> | undefined> }',
  schedule:
    'schedule?( nodes: ReadonlyMap<string, TaskNode>, ctx: ScheduleHookContext, ): ' +
    'ReadonlyMap<string, number> | undefined | Promise<ReadonlyMap<string, number> | undefined>',
  admit: 'admit?(task: TaskNode, ctx: AdmitContext): boolean',
  executor:
    'executor?(ctx: ExecutorContext): TaskExecutor | undefined | Promise<TaskExecutor | undefined>',
  cache: 'cache?(ctx: CacheContext): CacheLayer | undefined | Promise<CacheLayer | undefined>',
  telemetry:
    'telemetry?( ctx: TelemetryContext, ): | TelemetrySink | TelemetrySink[] | undefined ' +
    '| Promise<TelemetrySink | TelemetrySink[] | undefined>',
  setup: 'setup?(ctx: PluginSetupContext): void | Promise<void>',
  commands:
    'readonly commands?: Readonly<Record<string, PluginCommand>> interface PluginCommand { ' +
    'readonly description: string run(argv: readonly string[], ctx: CommandContext): ' +
    'number | Promise<number> }',
  teardown: 'teardown?(): void | Promise<void>',
}

/** Every first-party plugin factory, by package. */
const FACTORIES: Record<string, Record<string, () => VxPlugin>> = {
  '@vzn/vx-reapi': { reapi },
  '@vzn/vx-otel': { otel },
  '@vzn/vx-github': { github },
  '@vzn/vx-mcp': { mcp },
  '@vzn/vx-schedule-history': { scheduleHistoryPlugin },
  '@vzn/vx-lockfile': { pnpm, bun: bunLock, npm, yarn },
  '@vzn/vx-migrate': { turbo, nx, turboCache, nxCache },
}

const ROWS: Record<string, string[]> = {
  'packages/vx/tests/plugin-pipeline.test.ts': [
    'an injected task runs, and keys exactly like the same task written by hand',
  ],
  'packages/vx/tests/package-boundaries.unsafe.test.ts': [
    'core (src/**) never imports a sibling @vzn/vx-* package or packages/*',
    'core ships no plugin: src/plugins does not exist',
  ],
  'packages/vx/tests/local-fallbacks.test.ts': [
    'no plugins at all resolves to the local executor and the local cache handle',
    'a plugin that declines is the same as no plugin — the fallback, not an error',
    'a declared executor goes IN FRONT of the fallback, not instead of it',
  ],
  'packages/vx/tests/plugin-capabilities.test.ts': [
    'NO PLUGINS: a workspace with no workspace file at all runs on the fallbacks',
    'an executor that declines a task falls through to the local executor declared after it',
    'resolveExecutors: a throwing executor factory aborts with a named UserError',
  ],
  'packages/vx/tests/telemetry.test.ts': [
    'disables a sink that throws and keeps delivering to the others',
  ],
  'packages/vx/tests/telemetry-lifecycle.test.ts': [
    'a sink whose flush never settles does not hang the run',
  ],
}

// Expressive Code turns the block's `// vx.workspace.ts` line into its title.
const IN_VX = `import { defineWorkspace } from '@vzn/vx'
import { summaryLine } from './plugins/summary-line.ts'

export default defineWorkspace({ plugins: [summaryLine()] })`

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

function hooksOf(plugin: VxPlugin): string[] {
  return PLUGIN_HOOKS.filter((h) => (plugin as unknown as Record<string, unknown>)[h] !== undefined)
}

/** The plugin an example file makes: its one exported factory, called. */
async function examplePlugin(file: string): Promise<VxPlugin> {
  const mod = (await import(path.join(EXAMPLES, file))) as Record<string, unknown>
  const factories = Object.values(mod).filter((v) => typeof v === 'function')
  expect(factories).toHaveLength(1)
  return (factories[0] as (arg: string) => VxPlugin)('example')
}

function source(file: string): string {
  return readFileSync(path.join(EXAMPLES, file), 'utf8').replace(/\n$/, '')
}

/** The strip's stages, in order: `[run, around]`. */
function strip(html: string): [string[], string[]] {
  const hooks = (list: string) => [...list.matchAll(/<li data-hook="([^"]+)"/g)].map((m) => m[1]!)
  const run = only(html, /<ol class="run\b[^"]*">([\s\S]*?)<\/ol>/g)
  const around = only(html, /<div class="around\b[^"]*">([\s\S]*?)<\/div>/g)
  return [hooks(run), hooks(around)]
}

describe('the pipeline model follows PLUGIN_HOOKS', () => {
  const model = STAGES.map((s) => s.hook as string)

  it('names every hook core declares, and none it lacks', () => {
    expect({
      missing: PLUGIN_HOOKS.filter((h) => !model.includes(h)),
      extra: model.filter((h) => !(PLUGIN_HOOKS as readonly string[]).includes(h)),
      duplicated: model.filter((h, i) => model.indexOf(h) !== i),
    }).toEqual({ missing: [], extra: [], duplicated: [] })
  })

  it("keeps core's order, and groups the stages the way the chapter draws them", () => {
    expect(model).toEqual([...PLUGIN_HOOKS])
    expect(STAGES.filter((s) => s.group === 'run').map((s): string => s.hook)).toEqual(RUN)
    expect(STAGES.filter((s) => s.group !== 'run').map((s): string => s.hook)).toEqual(AROUND)
  })

  it("reads each hook's declaration from VxPlugin's source", () => {
    const read = hookSignatures(readFileSync(PLUGIN_TS, 'utf8'))
    expect([...read.keys()].sort()).toEqual([...PLUGIN_HOOKS].sort())
    expect(Object.fromEntries([...read].map(([h, s]) => [h, flat(s)]))).toEqual(SIGNATURES)
  })

  it('names as first-party exactly the hooks each first-party factory fills', () => {
    const filled = Object.entries(FACTORIES).flatMap(([pkg, fns]) =>
      Object.entries(fns).flatMap(([fn, make]) => hooksOf(make()).map((h) => `${h} ${pkg} ${fn}`)),
    )
    const named = STAGES.flatMap((s) =>
      s.firstParty.flatMap((p) =>
        [...p.call.matchAll(/(\w+)\(/g)].map((m) => `${s.hook} ${p.pkg} ${m[1]}`),
      ),
    )
    expect([...new Set(named)].sort()).toEqual([...new Set(filled)].sort())
  })
})

describe('the examples the chapter shows', () => {
  // A file here that no page shows is code nobody reads and the site still
  // type-checks: the extending page's four other plugins went with it.
  it('are every file under src/examples/: one per stage, and the worked plugin', () => {
    const files = readdirSync(EXAMPLES, { recursive: true, encoding: 'utf8' })
      .filter((f) => f.endsWith('.ts'))
      .map((f) => f.split(path.sep).join('/'))
      .sort()
    expect(files).toEqual([...STAGES.map((s) => stageExample(s.hook)), WORKED].sort())
  })

  it('type-check against @vzn/vx: every stage example, the worked plugin, and its workspace', async () => {
    await typeCheck({
      ...Object.fromEntries(
        STAGES.map((s) => [
          `examples/${stageExample(s.hook)}`,
          { copy: path.join(EXAMPLES, stageExample(s.hook)) },
        ]),
      ),
      [`plugins/${WORKED}`]: { copy: path.join(EXAMPLES, WORKED) },
      'vx.workspace.ts': IN_VX,
    })
  }, 120_000)

  it.each(STAGES.map((s) => s.hook))('the %s example fills its own stage', async (hook) => {
    expect(hooksOf(await examplePlugin(stageExample(hook)))).toContain(hook)
  })

  it('the worked plugin fills exactly telemetry', async () => {
    expect(hooksOf(await examplePlugin(WORKED))).toEqual(['telemetry'])
  })

  it('the worked plugin is about twenty lines', () => {
    const lines = source(WORKED).split('\n').length
    expect(lines).toBeGreaterThanOrEqual(15)
    expect(lines).toBeLessThanOrEqual(25)
  })
})

describe('the pipeline explorer on guide/inside-vx', () => {
  const html = page(`guide/${SLUG}`)
  const element = only(html, /<vx-pipeline-explorer\b[^>]*>([\s\S]*?)<\/vx-pipeline-explorer>/g)
  const signatures = hookSignatures(readFileSync(PLUGIN_TS, 'utf8'))
  const sectionsOf = [
    ...element.matchAll(
      /<section class="stage\b[^"]*" id="([^"]+)" data-hook="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g,
    ),
  ].map((m) => ({ id: m[1]!, hook: m[2]!, body: m[3]! }))

  it('draws the strip in order, each stage a link to its section', () => {
    expect(strip(element)).toEqual([RUN, AROUND])
    const links = [...element.matchAll(/<a href="#([^"]+)" data-hook="([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ])
    expect(links).toEqual([...RUN, ...AROUND].map((h) => [`vx-stage-${h}`, h]))
  })

  it('has one section per stage, with its declaration, its plugins and its example', () => {
    expect(sectionsOf.map((s) => [s.id, s.hook])).toEqual(
      [...PLUGIN_HOOKS].map((h) => [`vx-stage-${h}`, h]),
    )
    for (const [i, s] of sectionsOf.entries()) {
      const stage = STAGES[i]!
      expect(text(only(s.body, /<h3\b[^>]*>([\s\S]*?)<\/h3>/g))).toBe(
        `Stage ${i + 1} of ${PLUGIN_HOOKS.length}: ${s.hook}`,
      )
      const [declared, example, ...rest] = codeBlocks(s.body, 'ts')
      expect(rest).toEqual([])
      expect(flat(declared!)).toBe(SIGNATURES[s.hook]!)
      expect(declared).toBe(signatures.get(s.hook)!)
      expect(example).toBe(source(stageExample(stage.hook)))
      const linked = [...s.body.matchAll(/<p class="first-party\b[^"]*">([\s\S]*?)<\/p>/g)]
      expect(linked).toHaveLength(1)
      const hrefsOf = [...linked[0]![1]!.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])
      expect(hrefsOf).toEqual(stage.firstParty.map((p) => `/vx/${p.href}`))
      if (stage.firstParty.length === 0) {
        expect(text(linked[0]![1]!)).toBe('First-party: none yet.')
      }
    }
  })

  it('links each first-party plugin to a page the site has, at an anchor it has', () => {
    const missing: string[] = []
    for (const p of STAGES.flatMap((s) => s.firstParty)) {
      const [rel, anchor] = p.href.split('#')
      const file = path.join(DIST, rel!, 'index.html')
      if (!existsSync(file)) missing.push(p.href)
      else if (anchor !== undefined && !readFileSync(file, 'utf8').includes(`id="${anchor}"`))
        missing.push(p.href)
    }
    expect(missing).toEqual([])
  })

  // Each stage's first-party plugins are its section's links (above), so the
  // table says only what core does alone and what a plugin decides.
  it('tabulates what core does and what a plugin decides at each stage', () => {
    const table = only(element, /(<table class="overview\b[\s\S]*?<\/table>)/g)
    expect(tableRows(table)).toEqual(STAGES.map((s) => [s.hook, s.core, s.plugin]))
    expect(tableRows(table).map((r) => r[0])).toEqual([...PLUGIN_HOOKS])
    expect(only(element, /<table class="overview\b[^"]*"([^>]*)>/g).trim()).toBe('')
  })

  it('ships every stage visible and no control that needs JavaScript', () => {
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
    expect(element).not.toContain('role="button"')
    expect(element).not.toContain('aria-pressed')
    expect(
      [...element.matchAll(/<section\b([^>]*)>/g)].map((m) => /\shidden\b/.test(m[1]!)),
    ).toEqual(PLUGIN_HOOKS.map(() => false))
  })

  it('counts the stages in its one-line caption', () => {
    const caption = only(html, /<figcaption\b[^>]*>(The 13 stages[\s\S]*?)<\/figcaption>/g)
    expect(text(caption)).toBe(
      "The 13 stages a plugin can fill, in core's order. Pick one to see its hook and a plugin.",
    )
    expect(PLUGIN_HOOKS).toHaveLength(13)
  })

  it("loads the element's module from the page's own scripts", () => {
    expect(defining(html, 'vx-pipeline-explorer')).toHaveLength(1)
  })
})

chapterShape({
  slug: SLUG,
  titles: [
    'Every run passes the same stages',
    'A plugin fills one stage',
    'With no plugins, vx still runs and caches',
    'A whole plugin fits in 20 lines',
  ],
  pictures: [P.pipeline, P.plugins, P.floor],
  rows: ROWS,
})

describe("the chapter's pictures follow PLUGIN_HOOKS", () => {
  it("draws the run's stages in core's order, and names the three around it", () => {
    expect<string[]>([...P.RUN_STAGES]).toEqual(RUN)
    expect(P.pipeline.boxes.map((b) => b.label)).toEqual(RUN)
    expect(P.pipeline.arrows!.map((a) => `${a.from}→${a.to}`)).toEqual(
      RUN.slice(1).map((to, i) => `${RUN[i]}→${to}`),
    )
    const notes = P.pipeline.notes!.map((n) => n.text).join(' ')
    expect(AROUND.filter((h) => !notes.includes(h))).toEqual([])
  })

  it('plugs each plugin into a real stage, in pipeline order', () => {
    const stages = P.plugins.arrows!.map((a) => a.to)
    expect(stages.every((s) => (PLUGIN_HOOKS as readonly string[]).includes(s))).toBe(true)
    expect(stages).toEqual(PLUGIN_HOOKS.filter((h) => stages.includes(h)))
  })
})

describe('the worked plugin and "In vx" on guide/inside-vx', () => {
  const chapter = content(page(`guide/${SLUG}`))
  const outside = prose(chapter)

  it('shows the worked plugin from its file, then the workspace that declares it', () => {
    expect(codeBlocks(outside, 'ts')).toEqual([source(WORKED), IN_VX])
    expect([...outside.matchAll(/<span class="title">([^<]*)<\/span>/g)].map((m) => m[1])).toEqual([
      `plugins/${WORKED}`,
      'vx.workspace.ts',
    ])
  })
})
