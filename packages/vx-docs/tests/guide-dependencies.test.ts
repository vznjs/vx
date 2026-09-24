// Chapter 3 of the Guide, "Dependencies" (design/site-redo-2026-09.md, and
// the owner's "simple, visual" brief): a dependency, `^build` against
// `build`, the task graph, waves, and why a cycle has no order. It hosts the
// graph explorer, so the explorer's page rows live here (moved from
// demo-islands.test.ts, where they held the old Learn page). The "In vx"
// config is planned by vx over the four packages: the graph it builds is the
// graph the explorer draws, the pictures' arrows are in it, and the cycle
// the chapter draws is refused with the message it prints.

import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import {
  TOY_PACKAGES,
  TOY_TASKS,
  joinNames,
  neededBy,
  orderSentence,
  rerunBy,
  waves,
} from '../src/components/demos/model/toy-monorepo.js'
import {
  COMPETITORS,
  DIST,
  TOY,
  codeBlocks,
  content,
  expectDiagrams,
  expectOnlyToyPackages,
  missing,
  only,
  page,
  pictures,
  plan,
  projectObject,
  proofLinks,
  proseWords,
  removeWorkspaces,
  sectionTitles,
  summaries,
  text,
  toyWorkspace,
} from './guide-opening.js'
import type { Picture } from '../src/components/guide/diagram.js'
import { CYCLE, ORDER, RULES } from '../src/components/guide/dependencies/pictures.js'

const SLUG = 'guide/dependencies'
const html = page(SLUG)
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

/** The rows of a table's body: each row's cells as text, header cell first. */
function tableRows(table: string): string[][] {
  const body = only(table, /<tbody\b[^>]*>([\s\S]*?)<\/tbody>/g)
  return [...body.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/g)].map((row) =>
    [...row[1]!.matchAll(/<t[hd]\b[^>]*>([\s\S]*?)<\/t[hd]>/g)].map((c) => text(c[1]!)),
  )
}

/** Every `_astro/*.js` the page loads, followed through the chunks' own
 *  static and dynamic imports. The loader imports an element only on
 *  demand, so "the page references the element" means reachable. */
function reachableScripts(page: string): Set<string> {
  const scripts = [...page.matchAll(/<script\b[^>]*>[\s\S]*?<\/script>/g)].map((m) => m[0])
  const seen = new Set<string>()
  const queue = scripts.flatMap((s) =>
    [...s.matchAll(/\/_astro\/([\w.-]+\.js)/g)].map((m) => m[1]!),
  )
  while (queue.length > 0) {
    const name = queue.pop()!
    const file = path.join(DIST, '_astro', name)
    // mermaid's chunks name files it never emits (`./elk-worker.min.js`).
    if (seen.has(name) || !existsSync(file)) continue
    seen.add(name)
    const body = readFileSync(file, 'utf8')
    for (const m of body.matchAll(/["'`]\.\/([\w.-]+\.js)["'`]/g)) queue.push(m[1]!)
  }
  return seen
}

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
  const svg = only(element, /(<svg\b[\s\S]*<\/svg>)/g)
  const table = only(element, /(<table\b[\s\S]*?<\/table>)/g)

  it('ships the task graph as static SVG inside the element, one row per wave', () => {
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
      [...svg.matchAll(/<text\b[^>]*class="wave\b[^"]*"[^>]*>([^<]*)</g)].map((m) => m[1]),
    ).toEqual(['wave 1', 'wave 2', 'wave 3', 'wave 4'])
    // Without JavaScript the SVG is one image with a name, not dead buttons.
    expect(svg).toMatch(/^<svg\b[^>]*role="img"/)
    expect(svg).not.toContain('role="button"')
  })

  it("states each change's run, what it needs first and the order, in a table", () => {
    expect(tableRows(table)).toEqual([
      [
        'utils',
        'utils#build, utils#test, ui#build, ui#test, api#build, api#test, app#build and app#test',
        'nothing',
        'utils#build, then utils#test, ui#build and api#build together, ' +
          'then ui#test, api#test and app#build together, then app#test',
      ],
      [
        'ui',
        'ui#build, ui#test, app#build and app#test',
        'utils#build and api#build',
        'ui#build, then ui#test and app#build together, then app#test',
      ],
      [
        'api',
        'api#build, api#test, app#build and app#test',
        'utils#build and ui#build',
        'api#build, then api#test and app#build together, then app#test',
      ],
      [
        'app',
        'app#build and app#test',
        'utils#build, ui#build and api#build',
        'app#build, then app#test',
      ],
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
        joinNames(rerunBy(p.id)),
        neededBy(p.id).length === 0 ? 'nothing' : joinNames(neededBy(p.id)),
        orderSentence(rerunBy(p.id)),
      ]),
    )
  })

  it('names the waves in the caption', () => {
    // Expressive Code wraps every code block in a <figure> too.
    const figures = [...main.matchAll(/<figure class="vx-demo\b[^"]*">([\s\S]*?)<\/figure>/g)]
      .map((m) => m[1]!)
      .filter((f) => f.includes('<vx-graph-explorer'))
    expect(figures).toHaveLength(1)
    expect(text(only(figures[0]!, /<figcaption\b[^>]*>([\s\S]*?)<\/figcaption>/g))).toBe(
      'The build and test tasks of a four-package monorepo. An arrow goes from a task to a task ' +
        'that needs it, so the first must finish before the second starts. Tasks in the same ' +
        'wave do not need each other and can run at the same time: wave 1 is utils#build; ' +
        'wave 2 is utils#test, ui#build and api#build; wave 3 is ui#test, api#test and ' +
        'app#build; wave 4 is app#test. The table says what a change to each package makes ' +
        'vx run build test --affected run.',
    )
  })

  it('keeps the controls that need JavaScript hidden in the static page', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
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
    const defining = [...reachableScripts(html)].filter((name) =>
      /customElements\.define\(\s*["'`]vx-graph-explorer["'`]/.test(
        readFileSync(path.join(DIST, '_astro', name), 'utf8'),
      ),
    )
    expect(defining).toHaveLength(1)
  })
})

describe('chapter 3, dependencies', () => {
  it('tells the story in its section titles', () => {
    expect(sectionTitles(main)).toEqual([
      'Build ui before app',
      'Two rules draw every arrow',
      'The rules draw the whole graph',
      'A loop has no first task',
      'In vx',
      'Check yourself',
    ])
  })

  it('draws its pictures around the graph explorer, and nothing else', () => {
    expectDiagrams(main, [ORDER, RULES, CYCLE])
    expect([...main.matchAll(/<vx-([a-z-]+)\b/g)].map((m) => m[1])).toEqual(['graph-explorer'])
    const svgs = pictures(main)
    expect(svgs).toHaveLength(4)
    expect(svgs.filter((s) => s.includes('data-task="utils#build"'))).toHaveLength(1)
  })

  it('keeps the prose to the budget', () => {
    expect(proseWords(main)).toBeLessThanOrEqual(350)
  })

  it('draws only arrows the graph has, each rule with its own', () => {
    const arrow = (p: Picture, a: { from: string; to: string }): string => {
      const label = (id: string): string => p.boxes.find((b) => b.id === id)!.label
      return `${label(a.from)}→${label(a.to)}`
    }
    expect(ORDER.arrows!.map((a) => arrow(ORDER, a))).toEqual(['ui#build→app#build'])
    expect(RULES.arrows!.map((a) => [arrow(RULES, a), a.label])).toEqual([
      ['utils#build→ui#build', '^build'],
      ['ui#build→ui#test', 'build'],
    ])
    for (const a of [...ORDER.arrows!.map((x) => arrow(ORDER, x)), 'utils#build→ui#build']) {
      expect(EDGES).toContain(a)
    }
    // ^build crosses packages; build stays in one.
    const [cross, same] = RULES.arrows!.map((a) => arrow(RULES, a).split('→'))
    expect(cross!.map((t) => t.split('#')[0])).toEqual(['utils', 'ui'])
    expect(TOY['ui']).toContain('utils')
    expect(same!.map((t) => t.split('#')[0])).toEqual(['ui', 'ui'])
  })

  it('reads the waves the graph draws', () => {
    expect(prose).toContain('Each row is a wave: its tasks do not need each other')
    expect(waves()).toEqual(WAVES)
  })

  it("names only the four packages, the widgets' own, and no other task runner", () => {
    expect(TOY_PACKAGES.map((p) => [p.id, p.dependsOn])).toEqual(Object.entries(TOY))
    expectOnlyToyPackages(main)
    expect(prose).not.toMatch(COMPETITORS)
  })

  it('keeps its proofs in one collapsed list, each one landing', () => {
    const { proofs, elsewhere } = proofLinks(main)
    expect(proofs.map((l) => l.href)).toEqual([
      '../../schema/#dependson-optional',
      'https://github.com/vznjs/vx/blob/main/packages/vx/tests/package-graph.test.ts',
      'https://github.com/vznjs/vx/blob/main/packages/vx/tests/package-graph.test.ts',
      'https://github.com/vznjs/vx/blob/main/packages/vx/tests/task-graph.test.ts',
    ])
    expect(elsewhere.map((l) => l.href)).toEqual([
      '../../learn/glossary/#task-dependency',
      '../../learn/glossary/#task-graph',
    ])
    expect(
      [...proofs, ...elsewhere].map((l) => missing(SLUG, l)).filter((m) => m !== undefined),
    ).toEqual([])
  })

  it('asks one question', () => {
    expect(summaries(main)).toEqual([
      'How we know this is true',
      'You run vx run app#build on an empty cache. Which tasks run?',
    ])
  })

  describe('the config in "In vx", planned by vx over the four packages', () => {
    const ts = codeBlocks(SLUG, 'ts')
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

    it('runs the four builds for app#build, and no test', async () => {
      const planned = await plan(await toyWorkspace(() => object), ['app#build'])
      expect(planned.tasks.map((t) => t.node.id).sort()).toEqual([
        'api#build',
        'app#build',
        'ui#build',
        'utils#build',
      ])
      expect(prose).toContain('utils#build, ui#build, api#build and app#build. No tests.')
    })

    it('refuses the cycle utils → app with the message the chapter prints, around the loop it draws', async () => {
      const root = await toyWorkspace(() => object, { ...TOY, utils: ['app'] })
      const message = await plan(root, ['build', 'test']).then(
        () => 'planned',
        (e: Error) => e.message,
      )
      expect(message).toBe(
        'Cycle detected in task graph: api#build -> utils#build -> app#build -> api#build',
      )
      expect(codeBlocks(SLUG, '')).toEqual([`${message}\n`])
      // "a -> b" reads "a waits for b", so the picture's arrow runs b → a.
      const loop = message.slice(message.indexOf(': ') + 2).split(' -> ')
      const waits = loop.slice(1).map((b, i) => `${b}→${loop[i]}`)
      expect(CYCLE.arrows!.map((a) => `${a.from}→${a.to}`).sort()).toEqual(waits.sort())
    })
  })

  it('ends on the next problem: the graph is right, the run is as slow as the loop', () => {
    expect(prose).toMatch(/But one task at a time is still as slow as the loop\.$/)
  })
})
