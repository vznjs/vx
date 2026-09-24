// Chapter 7, guide/affected: from changed files to the packages that own
// them and the packages that use those. It hosts the graph explorer in its
// change mode (the "Change a package" buttons and the table of what each
// change runs), so the change-mode rows moved here from
// demo-islands.test.ts; the graph's own rows (the waves, the caption)
// belong to chapter 3. Its pictures are held to the same model.
//
// It reads `dist/`, which the `build` task writes; the `test` task depends
// on `build` for that reason.

import { describe, expect, it } from 'bun:test'
import * as P from '../src/components/guide/affected/pictures.js'
import {
  TOY_PACKAGES,
  affectedBy,
  joinNames,
  neededBy,
  orderSentence,
  rerunBy,
  waves,
} from '../src/components/demos/model/toy-monorepo.js'
import {
  TOY,
  chapterShape,
  codeBlocks,
  content,
  defining,
  only,
  page,
  runFlags,
  sections,
  tableRows,
} from './guide-page.js'

const SLUG = 'affected'

// What a change to each package selects, written out by hand, so a wrong
// rule in the model cannot pass by agreeing with its own render.
const CHANGE: Record<string, { affected: string[]; rerun: string[]; needed: string[] }> = {
  utils: {
    affected: ['utils', 'ui', 'api', 'app'],
    rerun: [
      'utils#build',
      'utils#test',
      'ui#build',
      'ui#test',
      'api#build',
      'api#test',
      'app#build',
      'app#test',
    ],
    needed: [],
  },
  ui: {
    affected: ['ui', 'app'],
    rerun: ['ui#build', 'ui#test', 'app#build', 'app#test'],
    needed: ['utils#build', 'api#build'],
  },
  api: {
    affected: ['api', 'app'],
    rerun: ['api#build', 'api#test', 'app#build', 'app#test'],
    needed: ['utils#build', 'ui#build'],
  },
  app: {
    affected: ['app'],
    rerun: ['app#build', 'app#test'],
    needed: ['utils#build', 'ui#build', 'api#build'],
  },
}

chapterShape({
  slug: SLUG,
  titles: [
    'Find the package each file belongs to',
    'Add every package that uses it',
    'Affected picks packages, the cache skips work',
    'A file no task declares is invisible',
  ],
  pictures: [P.everything, P.owners, P.dependents, P.considerThenRun, P.invisible],
  rows: {
    'packages/vx/tests/affected-dependents.test.ts': [
      'an edit to lib selects lib AND app, never tool',
    ],
    'packages/vx/tests/affected-base-notes.test.ts': [
      'CONTROL: a real base that happens to select nothing keeps the plain note',
    ],
    'packages/vx/tests/affected-workspace-files.test.ts': [
      'the change re-keys the task AND selects it',
      'a shared file NO glob reaches still selects nothing',
    ],
    'packages/vx/tests/affected.test.ts': ['a lockfile edit selects every project'],
    'packages/vx/tests/package-graph.test.ts': [
      'reads all four dependency fields: a workspace peer orders a build too',
    ],
  },
})

describe('a change in the toy monorepo model', () => {
  it.each(Object.keys(CHANGE))(
    'a change to %s affects, reruns and needs the written sets',
    (pkg) => {
      expect({ affected: affectedBy(pkg), rerun: rerunBy(pkg), needed: neededBy(pkg) }).toEqual(
        CHANGE[pkg]!,
      )
    },
  )

  it('orders a run by wave, and says so', () => {
    expect(waves(rerunBy('api'))).toEqual([['api#build'], ['api#test', 'app#build'], ['app#test']])
    expect(orderSentence(rerunBy('ui'))).toBe(
      'ui#build, then ui#test and app#build together, then app#test',
    )
  })
})

describe("the chapter's pictures follow the model", () => {
  const boxIds = (p: typeof P.everything, tone?: string) =>
    p.boxes.filter((b) => tone === undefined || b.tone === tone).map((b) => b.id)

  it('CI checks every package for the README fix', () => {
    expect(boxIds(P.everything, 'danger')).toEqual(TOY)
  })

  it('a change to ui lights up exactly what it affects, and dims the rest', () => {
    expect(boxIds(P.dependents, 'accent')).toEqual(affectedBy('ui'))
    expect(boxIds(P.dependents, 'muted')).toEqual(TOY.filter((p) => !affectedBy('ui').includes(p)))
    // Every "is used by" arrow is a manifest edge, and every edge is drawn.
    expect(P.dependents.arrows!.map((a) => `${a.from}→${a.to}`).sort()).toEqual(
      TOY_PACKAGES.flatMap((p) => p.dependsOn.map((d) => `${d}→${p.id}`)).sort(),
    )
  })

  it("the README edit's affected set is ui's", () => {
    expect(P.considerThenRun.boxes.find((b) => b.id === 'affected')!.sub).toBe(
      affectedBy('ui').join(', '),
    )
  })
})

describe('the graph explorer, changing a package, on guide/affected', () => {
  const html = page(`guide/${SLUG}`)
  const element = only(html, /<vx-graph-explorer\b[^>]*>([\s\S]*?)<\/vx-graph-explorer>/g)
  const table = only(element, /(<table\b[\s\S]*?<\/table>)/g)

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
    expect(tableRows(table)).toEqual(
      TOY_PACKAGES.map((p) => [
        p.id,
        joinNames(rerunBy(p.id)),
        neededBy(p.id).length === 0 ? 'nothing' : joinNames(neededBy(p.id)),
        orderSentence(rerunBy(p.id)),
      ]),
    )
  })

  it('keeps the controls that need JavaScript hidden in the static page', () => {
    expect(only(element, /<div class="controls\b[^"]*"([^>]*)>/g).trim()).toBe('hidden')
    expect([...element.matchAll(/<button\b[^>]*data-pkg="([^"]+)"/g)].map((m) => m[1])).toEqual(TOY)
    expect(only(element, /<p class="status\b[^"]*"([^>]*)>/g).trim()).toBe(
      'aria-live="polite" hidden',
    )
  })

  it("loads the element's module from the page's own scripts", () => {
    expect(defining(html, 'vx-graph-explorer')).toHaveLength(1)
  })
})

describe('"In vx" on guide/affected', () => {
  const inVx = sections(content(page(`guide/${SLUG}`))).find((s) => s.id === 'in-vx')!.html

  it('runs only flags `vx run` documents, with a value where one is taken', () => {
    const flags = runFlags()
    // Positive first: the table was read.
    expect(flags.get('--affected')).toBe(true)
    expect(codeBlocks(inVx, 'sh')).toEqual(['vx run build test --affected=origin/main'])
  })
})
