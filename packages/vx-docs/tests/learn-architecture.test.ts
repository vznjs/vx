// The architecture and extending pages (roadmap W5 and W6) teach the
// plugin API, so everything they show is held to the code it describes:
//
// - the pipeline model names every hook in core's PLUGIN_HOOKS, in its
//   order, and no other;
// - the hook declarations the explorer shows are read from VxPlugin's
//   source, and the reader is held to declarations written out by hand;
// - the first-party column is what each first-party factory returns;
// - every example under src/examples/ type-checks against @vzn/vx and
//   fills the stage the page lights up for it;
// - the built pages render the model: the strip, the sections, the table,
//   the Mermaid source, and the no-JavaScript state.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
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
import {
  STAGES,
  filledBy,
  hookSignatures,
  pipelineMermaid,
  stageExample,
} from '../src/components/demos/model/pipeline.js'

const SITE = path.resolve(import.meta.dir, '..')
const ROOT = path.resolve(SITE, '../..')
const DIST = path.join(SITE, 'dist')
const EXAMPLES = path.join(SITE, 'src/examples')
const MODEL = path.join(SITE, 'src/components/demos/model/pipeline.ts')
// Through the site's own link to core: the sandbox grants a project's
// linked dependencies, and the task declares the file as an input.
const PLUGIN_TS = path.join(SITE, 'node_modules/@vzn/vx/src/orchestrator/plugin.ts')
const OXLINT = path.join(ROOT, 'node_modules/.bin/oxlint')

// The truth the pages teach, written out by hand, so a wrong model cannot
// pass by agreeing with its own render.
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

/** The extending page's examples, in page order, and the stage each fills. */
const WORKED: [file: string, stages: string[]][] = [
  ['summary-line.ts', ['telemetry']],
  ['http-cache.ts', ['cache']],
  ['cache-size.ts', ['commands']],
  ['start-first.ts', ['schedule']],
  ['turbo-workspace.ts', ['project']],
]

const flat = (s: string): string => s.replace(/\s+/g, ' ').trim()

function hooksOf(plugin: VxPlugin): string[] {
  return PLUGIN_HOOKS.filter((h) => (plugin as unknown as Record<string, unknown>)[h] !== undefined)
}

/** The plugin an example file makes: its one exported factory, called, or
 *  the plugins of the workspace it exports. */
async function examplePlugins(file: string): Promise<VxPlugin[]> {
  const mod = (await import(path.join(EXAMPLES, file))) as Record<string, unknown>
  if (mod['default'] !== undefined) return [...(mod['default'] as { plugins: VxPlugin[] }).plugins]
  const factories = Object.values(mod).filter((v) => typeof v === 'function')
  expect(factories).toHaveLength(1)
  return [(factories[0] as (arg: string) => VxPlugin)('example')]
}

function page(rel: string): string {
  const file = path.join(DIST, rel, 'index.html')
  if (!existsSync(file)) throw new Error(`${file} is missing: run the site's build task first`)
  return readFileSync(file, 'utf8')
}

function only(html: string, re: RegExp): string {
  const found = [...html.matchAll(re)]
  expect(found).toHaveLength(1)
  return found[0]![1]!
}

function decode(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x([0-9a-f]+);/gi, (_, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, '&')
}

function text(html: string): string {
  return flat(decode(html.replace(/<[^>]+>/g, '')))
}

/** Each code block in `html`, as its lines of text. Expressive Code puts
 *  one `ec-line` per source line. */
function codeBlocks(html: string): string[] {
  return [...html.matchAll(/<pre data-language="ts"><code>([\s\S]*?)<\/code><\/pre>/g)].map((m) =>
    m[1]!
      .split(/<div class="ec-line[^"]*">/)
      .slice(1)
      .map((line) => decode(line.replace(/<[^>]+>/g, '')).replace(/\n$/, ''))
      .join('\n'),
  )
}

function source(file: string): string {
  return readFileSync(path.join(EXAMPLES, file), 'utf8').replace(/\n$/, '')
}

/** The rows of a table's body: each row's cells as text, header cell first. */
function tableRows(table: string): string[][] {
  const body = only(table, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g)
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => text(c[1]!)),
  )
}

/** The strip's stages, in order: `[run, around, lit]`. */
function strip(html: string): [string[], string[], string[]] {
  const hooks = (list: string) => [...list.matchAll(/<li data-hook="([^"]+)"/g)].map((m) => m[1]!)
  const run = only(html, /<ol class="run\b[^"]*">([\s\S]*?)<\/ol>/g)
  const around = only(html, /<div class="around\b[^"]*">([\s\S]*?)<\/div>/g)
  const lit = [...html.matchAll(/<li data-hook="([^"]+)" class="lit\b/g)].map((m) => m[1]!)
  return [hooks(run), hooks(around), lit]
}

/** Every `_astro/*.js` the page loads, followed through the chunks' own
 *  static and dynamic imports. */
function reachableScripts(html: string): Set<string> {
  const scripts = [...html.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
  const seen = new Set<string>()
  const queue = scripts.flatMap((s) =>
    [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!),
  )
  while (queue.length > 0) {
    const name = queue.pop()!
    const file = path.join(DIST, '_astro', name)
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    const body = readFileSync(file, 'utf8')
    for (const m of body.matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) queue.push(m[1]!)
  }
  return seen
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

  it("keeps core's order, and groups the stages the way the pages draw them", () => {
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

describe('the examples', () => {
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory()
        ? walk(path.join(dir, e.name))
        : [path.relative(EXAMPLES, path.join(dir, e.name))],
    )
  const files = walk(EXAMPLES).sort()

  it('are one per stage, and the five the extending page shows', () => {
    expect(files).toEqual(
      [...STAGES.map((s) => stageExample(s.hook)), ...WORKED.map(([f]) => f)].sort(),
    )
  })

  it('type-check against @vzn/vx, with the model beside them', async () => {
    // Outside the repo, like the guide pins: a test that wrote into its own
    // project would dirty the tree the cache hashes. The layout is kept, so
    // an import between two examples would resolve as it does here.
    const dir = await mkdtemp(path.join(os.tmpdir(), 'vx-learn-examples-'))
    try {
      await symlink(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'), 'dir')
      await writeFile(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            strict: true,
            noUncheckedIndexedAccess: true,
            exactOptionalPropertyTypes: true,
            module: 'esnext',
            moduleResolution: 'bundler',
            target: 'esnext',
            noEmit: true,
            allowImportingTsExtensions: true,
            types: ['bun'],
            // Through the site's own link, which the sandbox grants; the
            // root's node_modules has no @vzn/vx-migrate.
            paths: {
              '@vzn/vx-migrate': [path.join(SITE, 'node_modules/@vzn/vx-migrate/src/index.ts')],
            },
          },
          include: ['examples/**/*.ts', 'model/*.ts'],
        }),
      )
      const checked: string[] = []
      for (const file of files) {
        const to = path.join(dir, 'examples', file)
        await mkdir(path.dirname(to), { recursive: true })
        await copyFile(path.join(EXAMPLES, file), to)
        checked.push(to)
      }
      await mkdir(path.join(dir, 'model'))
      await copyFile(MODEL, path.join(dir, 'model', 'pipeline.ts'))
      checked.push(path.join(dir, 'model', 'pipeline.ts'))
      // Named one by one: pointed at the directory, oxlint walks the
      // symlinked node_modules until the kernel kills it.
      const p = Bun.spawnSync({
        cmd: [OXLINT, '--type-aware', '--type-check', ...checked],
        cwd: dir,
        stdout: 'pipe',
        stderr: 'pipe',
      })
      const out = new TextDecoder().decode(p.stdout) + new TextDecoder().decode(p.stderr)
      const errors = out.split('\n').filter((l) => /^\s*x |: error /.test(l))
      const tail = p.exitCode === 0 ? [] : out.trim().split('\n').slice(-20)
      expect({ exitCode: p.exitCode, errors, tail }).toEqual({ exitCode: 0, errors: [], tail: [] })
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it.each(STAGES.map((s) => s.hook))('the %s example fills its own stage', async (hook) => {
    const [plugin] = await examplePlugins(stageExample(hook))
    expect(hooksOf(plugin!)).toContain(hook)
  })

  it.each(WORKED)('%s fills exactly %p', async (file, stages) => {
    const plugins = await examplePlugins(file)
    expect(plugins.flatMap(hooksOf).sort()).toEqual([...stages].sort())
  })
})

describe('the pipeline explorer on learn/architecture', () => {
  const html = page('learn/architecture')
  const element = only(html, /<vx-pipeline-explorer\b[^>]*>([\s\S]*?)<\/vx-pipeline-explorer>/g)
  const signatures = hookSignatures(readFileSync(PLUGIN_TS, 'utf8'))
  const sections = [
    ...element.matchAll(
      /<section class="stage\b[^"]*" id="([^"]+)" data-hook="([^"]+)"[^>]*>([\s\S]*?)<\/section>/g,
    ),
  ].map((m) => ({ id: m[1]!, hook: m[2]!, body: m[3]! }))

  it('draws the strip in order, each stage a link to its section', () => {
    expect(strip(element)).toEqual([RUN, AROUND, []])
    const links = [...element.matchAll(/<a href="#([^"]+)" data-hook="([^"]+)"/g)].map((m) => [
      m[1],
      m[2],
    ])
    expect(links).toEqual([...RUN, ...AROUND].map((h) => [`vx-stage-${h}`, h]))
  })

  it('has one section per stage, with its declaration, its plugins and its example', () => {
    expect(sections.map((s) => [s.id, s.hook])).toEqual(
      [...PLUGIN_HOOKS].map((h) => [`vx-stage-${h}`, h]),
    )
    for (const [i, s] of sections.entries()) {
      const stage = STAGES[i]!
      expect(text(only(s.body, /<h3\b[^>]*>([\s\S]*?)<\/h3>/g))).toBe(
        `Stage ${i + 1} of ${PLUGIN_HOOKS.length}: ${s.hook}`,
      )
      const [declared, example, ...rest] = codeBlocks(s.body)
      expect(rest).toEqual([])
      expect(flat(declared!)).toBe(SIGNATURES[s.hook]!)
      expect(declared).toBe(signatures.get(s.hook)!)
      expect(example).toBe(source(stageExample(stage.hook)))
      const linked = [...s.body.matchAll(/<p class="first-party\b[^"]*">([\s\S]*?)<\/p>/g)]
      expect(linked).toHaveLength(1)
      const hrefs = [...linked[0]![1]!.matchAll(/<a href="([^"]+)"/g)].map((m) => m[1])
      expect(hrefs).toEqual(stage.firstParty.map((p) => `/vx/${p.href}`))
      if (stage.firstParty.length === 0) {
        expect(text(linked[0]![1]!)).toBe(
          'First-party: none yet. The stage is open to your own plugin.',
        )
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

  it('tabulates what core does and what a plugin decides at each stage', () => {
    const table = only(element, /(<table\b[\s\S]*?<\/table>)/g)
    expect(tableRows(table)).toEqual(STAGES.map((s) => [s.hook, s.core, s.plugin, filledBy(s)]))
    expect(tableRows(table).map((r) => r[0])).toEqual([...PLUGIN_HOOKS])
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

  it('draws the pipeline in Mermaid from the same model', () => {
    const mermaid = decode(only(html, /<pre class="mermaid"[^>]*>([\s\S]*?)<\/pre>/g))
    expect(mermaid).toBe(pipelineMermaid())
    expect([...new Set([...mermaid.matchAll(/\bs_(\w+)/g)].map((m) => m[1]!))].sort()).toEqual(
      [...PLUGIN_HOOKS].sort(),
    )
  })

  it('names the stages in the caption', () => {
    const figures = [
      ...html.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/vx-pipeline-explorer>/g),
    ]
    expect(figures).toHaveLength(1)
    const caption = only(html, /<figcaption\b[^>]*>(The 13 hooks[\s\S]*?)<\/figcaption>/g)
    expect(text(caption)).toBe(
      "The 13 hooks a plugin can fill, in the order of core's own list. Each section shows the " +
        "hook's declaration from core's source, the first-party plugins that fill it, and a " +
        'short example plugin. The table says what core does at each stage when no plugin ' +
        'fills it, and what a plugin can decide there.',
    )
  })

  it('answers the checkpoint with the three stages the question needs', () => {
    const answer = only(html, /<details>([\s\S]*?)<\/details>/g)
    const named = [...answer.matchAll(/<code\b[^>]*>([a-z]+)<\/code>/g)].map((m) => m[1]!)
    expect(
      [...new Set(named.filter((n) => (PLUGIN_HOOKS as readonly string[]).includes(n)))].sort(),
    ).toEqual(['admit', 'executor', 'telemetry'])
  })

  it("loads the element's module from the page's own scripts", () => {
    const defining = [...reachableScripts(html)].filter((name) =>
      /customElements\.define\(\s*["'`]vx-pipeline-explorer["'`]/.test(
        readFileSync(path.join(DIST, '_astro', name), 'utf8'),
      ),
    )
    expect(defining).toHaveLength(1)
  })
})

describe('the worked examples on learn/extending', () => {
  const html = page('learn/extending')
  const figures = [
    ...html.matchAll(/<figure class="vx-example\b[^"]*" data-example="([^"]+)">([\s\S]*?<\/pre>)/g),
  ].map((m) => ({ file: m[1]!, body: m[2]! }))

  it('shows the five examples in order, each beside the pipeline with its stage lit', () => {
    expect(figures.map((f) => [f.file, strip(f.body)])).toEqual(
      WORKED.map(([file, stages]) => [file, [RUN, AROUND, stages]]),
    )
  })

  it('shows each example from its file', () => {
    for (const f of figures) expect(codeBlocks(f.body)).toEqual([source(f.file)])
  })

  it('answers the checkpoint with the telemetry stage and its flush', () => {
    const answer = only(html, /<details>([\s\S]*?)<\/details>/g)
    const named = new Set(
      [...answer.matchAll(/<code\b[^>]*>([^<]+)<\/code>/g)].map((m) => decode(m[1]!)),
    )
    expect(named).toEqual(
      new Set(['telemetry', "wants: ['task.log', 'task.end']", 'onRecord', 'flush']),
    )
  })
})
