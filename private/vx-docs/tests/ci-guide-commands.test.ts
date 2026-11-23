// CI runs from the workspace root, where `vx run` and `vx watch` with no
// selector refuse ("not inside a project"): three lines of the old CI
// command block did (`--graph`, `-- --bail`, `vx watch test`). Each such
// line on the CI pages names `--all`, `--filter`, `--affected` or an exact
// `pkg#task`.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const DOCS = path.resolve(import.meta.dir, '..', 'src/content/docs/docs')
const PAGES = [
  path.join(DOCS, 'ci.mdx'),
  ...readdirSync(path.join(DOCS, 'ci')).map((f) => path.join(DOCS, 'ci', f)),
]

it('every vx run / vx watch line on the CI pages selects from the root', () => {
  const lines = PAGES.flatMap((p) =>
    [...readFileSync(p, 'utf8').matchAll(/```(?:sh|bash)[^\n]*\n([\s\S]*?)```/g)].flatMap((m) =>
      m[1]!
        .split('\n')
        .map((l) => l.replace(/#\s.*$/, '').trim())
        .filter((l) => /^vx (run|watch) /.test(l)),
    ),
  )
  expect(lines.length).toBeGreaterThan(0)
  const selects = (l: string): boolean =>
    /\s--(all|filter|affected)\b/.test(l.split(' -- ')[0]!) || /\S#\S/.test(l)
  expect(lines.filter((l) => !selects(l))).toEqual([])
})
