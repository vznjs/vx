// Chapter 3 of the Guide, "Dependencies": a dependency, `^build` against
// `build`, the task graph, waves, and why a cycle has no order. It hosts the
// graph explorer, so the explorer's page rows live here (moved from
// demo-islands.test.ts, where they held the old Learn page). The "In vx"
// config is planned by vx over the four packages: the graph it builds is the
// graph the explorer draws, the pictures' arrows are in it, and the cycle
// the chapter draws is refused with the message it prints.

import { afterAll, describe, expect, it } from 'bun:test'
import {
  TOY_PACKAGES,
  TOY_TASKS,
  affectedBy,
  joinNames,
  neededBy,
  rerunBy,
  waves,
} from '../src/components/demos/model/toy-monorepo.js'
import { NARROW, type Picture } from '../src/components/guide/diagram/diagram.js'
import * as P from '../src/components/guide/dependencies/pictures.js'
import {
  TOY_USES,
  chapterShape,
  content,
  defining,
  only,
  page,
  plan,
  projectObject,
  removeWorkspaces,
  sourceBlocks,
  tableRows,
  text,
  toyWorkspace,
} from './guide-page.js'

const SLUG = 'dependencies'
const html = page(`guide/${SLUG}`)
const main = content(html)
const prose = text(main)

afterAll(removeWorkspaces)

// The graph the chapter teaches, written out by hand. The model, the built
// page and vx's own plan are each held to it.
const WAVES = [
  ['utils#build'],
  ['utils#test', 'ui#build', 'api#build'],
  ['ui#test', 'api#test', 'app#build'],
  ['app#test'],
]
const EDGES = [
  'api#build→api#test',
  'api#build→app#build',
  'app#build→app#test',
  'ui#build→app#build',
  'ui#build→ui#test',
  'utils#build→api#build',
  'utils#build→ui#build',
  'utils#build→utils#test',
]

/** A plan's edges as `from→to`, and its tasks grouped by wave. */
function shape(tasks: { node: { id: string; deps: readonly string[] } }[]): {
  edges: string[]
  waves: string[][]
} {
  const deps = new Map(tasks.map((t) => [t.node.id, t.node.deps]))
  const wave = (id: string): number => {
    const d = deps.get(id)!
    return d.length === 0 ? 1 : 1 + Math.max(...d.map(wave))
  }
  const byWave: string[][] = []
  for (const t of tasks) (byWave[wave(t.node.id) - 1] ??= []).push(t.node.id)
  return {
    edges: tasks.flatMap((t) => t.node.deps.map((d) => `${d}→${t.node.id}`)).sort(),
    waves: byWave.map((w) => w.sort()),
  }
}

describe('the graph explorer on guide/dependencies', () => {
  const element = only(main, /<vx-graph-explorer\b[^>]*>([\s\S]*?)<\/vx-graph-explorer>/g)
  // The wide drawing, then the phone one (the diagram kit's `narrow`): the
  // rows below hold each of them.
  const drawings = [...element.matchAll(/<svg\b[\s\S]*?<\/svg>/g)].map((m) => m[0])
  const svg = drawings[0]!
  const table = only(element, /(<table\b[\s\S]*?<\/table>)/g)

  it('draws it twice, wide and for a phone, the phone one at most NARROW across', () => {
    expect(drawings.map((d) => /^<svg\b[^>]*data-layout="(\w+)"/.exec(d)?.[1])).toEqual([
      'wide',
      'narrow',
    ])
    expect(
      Number(/^<svg\b[^>]*viewBox="0 [\d.]+ ([\d.]+) /.exec(drawings[1]!)![1]),
    ).toBeLessThanOrEqual(NARROW)
  })

  for (const [layout, svg] of drawings.map((d, i) => [i === 0 ? 'wide' : 'phone', d] as const))
    it(`ships the task graph as static SVG inside the element, one row per wave (${layout})`, () => {
      const nodes = [
        ...svg.matchAll(/<g\b[^>]*data-task="([^"]+)" data-pkg="([^"]+)" data-wave="(\d+)"/g),
      ].map((m) => `${m[1]} ${m[2]} ${m[3]}`)
      expect(nodes.sort()).toEqual(
        WAVES.flatMap((w, i) => w.map((id) => `${id} ${id.split('#')[0]} ${i + 1}`)).sort(),
      )
      expect(
        [...svg.matchAll(/data-from="([^"]+)" data-to="([^"]+)"/g)]
          .map((m) => `${m[1]}→${m[2]}`)
          .sort(),
      ).toEqual(EDGES)
      expect(
        [...svg.matchAll(/<text class="note\b[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]),
      ).toEqual(['wave 1', 'wave 2', 'wave 3', 'wave 4'])
      // A wave is a row: every box of a wave at one height, each wave lower.
      const rowOf = new Map<number, Set<string>>()
      for (const m of svg.matchAll(/data-wave="(\d+)"[^>]*>\s*<rect\b[^>]*\sy="([\d.]+)"/g)) {
        rowOf.set(Number(m[1]), (rowOf.get(Number(m[1])) ?? new Set()).add(m[2]!))
      }
      const ys = [1, 2, 3, 4].map((w) => [...rowOf.get(w)!])
      expect(ys.map((y) => y.length)).toEqual([1, 1, 1, 1])
      expect(ys.map((y) => Number(y[0])).every((y, i, all) => i === 0 || y > all[i - 1]!)).toBe(
        true,
      )
      // Without JavaScript the SVG is one image with a name, not dead buttons.
      expect(svg).toMatch(/^<svg\b[^>]*role="img"/)
      expect(only(svg, /^<svg\b[^>]*aria-label="([^"]*)"/g)).toBe(
        'Task graph of the toy monorepo in 4 waves: wave 1 is utils#build; wave 2 is ' +
          'utils#test, ui#build and api#build; wave 3 is ui#test, api#test and app#build; ' +
          'wave 4 is app#test.',
      )
      expect(svg).not.toContain('role="button"')
    })

  // The explorer is one of the Guide's pictures: the kit draws it, in the
  // kit's own frame and classes, so it takes the pictures' look.
  it("is drawn by the Guide's diagram kit", () => {
    expect(element).toMatch(/<div class="vx-diagram inset\b[^"]*"[^>]*>\s*<svg\b/)
    const boxes = [...svg.matchAll(/<g class="box (\w+)" data-box="([^"]+)"/g)]
    expect(boxes.map((m) => `${m[2]} ${m[1]}`)).toEqual(TOY_TASKS.map((t) => `${t.id} default`))
    // Every tone the element may give an arrow has its head.
    expect([...svg.matchAll(/<marker id="vx-dg-graph-explorer-(\w+)"/g)].map((m) => m[1])).toEqual([
      'default',
      'accent',
      'link',
      'danger',
      'ok',
      'warn',
      'muted',
    ])
  })

  it("states each change's packages to build and test again, and what it needs first, in a table", () => {
    expect(tableRows(table)).toEqual([
      ['utils', 'utils, ui, api and app', 'nothing'],
      ['ui', 'ui and app', 'utils#build and api#build'],
      ['api', 'api and app', 'utils#build and ui#build'],
      ['app', 'app', 'utils#build, ui#build and api#build'],
    ])
  })

  it('renders what the model says, so the element and the fallback agree', () => {
    expect(waves()).toEqual(WAVES)
    expect([...svg.matchAll(/data-task="([^"]+)"/g)].map((m) => m[1])).toEqual(
      TOY_TASKS.map((t) => t.id),
    )
    expect(tableRows(table)).toEqual(
      TOY_PACKAGES.map((p) => [
        p.id,
        joinNames(affectedBy(p.id)),
        neededBy(p.id).length === 0 ? 'nothing' : joinNames(neededBy(p.id)),
      ]),
    )
    // Building and testing a package again is every task of it.
    for (const p of TOY_PACKAGES) {
      expect(rerunBy(p.id)).toEqual(
        TOY_TASKS.filter((t) => affectedBy(p.id).includes(t.pkg)).map((t) => t.id),
      )
    }
  })

  it('says in one line what an arrow and a row mean', () => {
    // Expressive Code wraps every code block in a <figure> too.
    const figures = [...main.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
      .map((m) => m[1]!)
      .filter((f) => f.includes('<vx-graph-explorer'))
    expect(figures).toHaveLength(1)
    expect(text(only(figures[0]!, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).toBe(
      'An arrow points to the task that waits. Tasks in one row run at the same time.',
    )
  })

  it('keeps the controls that need JavaScript hidden in the static page', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect(only(element, /<table class="static\b[^"]*"([^>]*)>/g).trim()).toBe('')
    expect([...element.matchAll(/<button\b[^>]*data-pkg="([^"]+)"/g)].map((m) => m[1])).toEqual([
      'utils',
      'ui',
      'api',
      'app',
    ])
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
  })

  it("loads the element's module from the page's own scripts", () => {
    expect(defining(html, 'vx-graph-explorer')).toHaveLength(1)
  })
})

chapterShape({
  slug: SLUG,
  titles: [
    'Build ui before app',
    'Two rules draw every arrow',
    'The rules draw the whole graph',
    'A loop has no first task',
  ],
  pictures: [P.order, P.rules, P.cycle],
  rows: {
    'packages/vx/tests/package-graph.test.ts': [
      'reads all four dependency fields: a workspace peer orders a build too',
      'records direct workspace deps only when the dep is in the workspace',
    ],
    'packages/vx/tests/task-graph.test.ts': ['a task cycle through every project is refused'],
  },
})

describe('chapter 3, dependencies', () => {
  it('hosts the graph explorer and no other widget', () => {
    expect([...main.matchAll(/<vx-([a-z-]+)\b/g)].map((m) => m[1])).toEqual([
      'graph-explorer',
      'checkpoint',
    ])
  })

  it('draws only arrows the graph has, each rule with its own', () => {
    const arrow = (p: Picture, a: { from: string; to: string }): string => {
      const label = (id: string): string => p.boxes.find((b) => b.id === id)!.label
      return `${label(a.from)}→${label(a.to)}`
    }
    expect(P.order.arrows!.map((a) => arrow(P.order, a))).toEqual(['ui#build→app#build'])
    expect(P.rules.arrows!.map((a) => [arrow(P.rules, a), a.label])).toEqual([
      ['utils#build→ui#build', '^build'],
      ['ui#build→ui#test', 'build'],
    ])
    for (const a of [...P.order.arrows!.map((x) => arrow(P.order, x)), 'utils#build→ui#build']) {
      expect(EDGES).toContain(a)
    }
    // ^build crosses packages; build stays in one.
    const [cross, same] = P.rules.arrows!.map((a) => arrow(P.rules, a).split('→'))
    expect(cross!.map((t) => t.split('#')[0])).toEqual(['utils', 'ui'])
    expect(TOY_USES['ui']).toContain('utils')
    expect(same!.map((t) => t.split('#')[0])).toEqual(['ui', 'ui'])
  })

  it('reads the waves the graph draws', () => {
    expect(prose).toContain('Each row is a wave: its tasks do not need each other')
    expect(waves()).toEqual(WAVES)
  })

  it("draws the widgets' four packages", () => {
    expect(TOY_PACKAGES.map((p) => [p.id, p.dependsOn])).toEqual(Object.entries(TOY_USES))
  })

  describe('the config in "In vx", planned by vx over the four packages', () => {
    const ts = sourceBlocks(SLUG, 'ts')
    const object = projectObject(ts[0]!)

    it('is the one config block, with the two rules', () => {
      expect(ts).toHaveLength(1)
      expect(object).toContain("build: { dependsOn: ['^build'],")
      expect(object).toContain("test: { dependsOn: ['build'],")
    })

    it('builds the graph the chapter draws, from the package.json dependencies', async () => {
      const planned = await plan(await toyWorkspace(() => object), ['build', 'test'])
      expect(shape(planned.tasks)).toEqual({
        edges: EDGES,
        waves: WAVES.map((w) => [...w].sort()),
      })
    })

    // The chapter's checkpoint asks this; its answer, computed at build time
    // by the planner the site ships, is the one vx plans here.
    it('runs the four builds for app#build, and no test', async () => {
      const planned = await plan(await toyWorkspace(() => object), ['app#build'])
      const four = ['api#build', 'app#build', 'ui#build', 'utils#build']
      expect(planned.tasks.map((t) => t.node.id).sort()).toEqual(four)
      const checkpoint = only(main, /<vx-checkpoint\b[^>]*>([\s\S]*?)<\/vx-checkpoint>/g)
      expect(only(checkpoint, /data-checkpoint="([^"]+)"/g)).toBe('dependencies')
      const answer = only(checkpoint, /<details class="answer\b[^"]*">([\s\S]*?)<\/details>/g)
      const yes = [...answer.matchAll(/<li>([\s\S]*?)<\/li>/g)].map(
        (m) => text(m[1]!).split(' ')[0]!,
      )
      expect(yes.sort()).toEqual(four)
    })

    it('refuses the cycle utils → app with the message the chapter prints, around the loop it draws', async () => {
      const root = await toyWorkspace(() => object, { ...TOY_USES, utils: ['app'] })
      const message = await plan(root, ['build', 'test']).then(
        () => 'planned',
        (e: Error) => e.message,
      )
      expect(message).toBe(
        'Cycle detected in task graph: api#build -> utils#build -> app#build -> api#build',
      )
      expect(sourceBlocks(SLUG, '')).toEqual([`${message}\n`])
      // "a -> b" reads "a waits for b", so the picture's arrow runs b → a.
      const loop = message.slice(message.indexOf(': ') + 2).split(' -> ')
      const waits = loop.slice(1).map((b, i) => `${b}→${loop[i]}`)
      expect(P.cycle.arrows!.map((a) => `${a.from}→${a.to}`).sort()).toEqual(waits.sort())
    })
  })

  it('ends on the next problem: the graph is right, the run is as slow as the loop', () => {
    expect(prose).toMatch(/But one task at a time is still as slow as the loop\.$/)
  })
})
