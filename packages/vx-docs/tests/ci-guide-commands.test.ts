// The CI guide's command block is run from the workspace root, where `vx
// run` and `vx watch` with no selector refuse ("not inside a project"):
// three of its lines did (`--graph`, `-- --bail`, `vx watch test`). Each line
// names `--all`, `--filter`, `--affected` or an exact `pkg#task`.
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const CI = readFileSync(
  path.resolve(import.meta.dir, '..', 'src/content/docs/guides/ci.md'),
  'utf8',
)

it('every vx run / vx watch line in the CI guide selects from the root', () => {
  const block = /```bash\n([\s\S]*?)```/.exec(CI)![1]!
  const lines = block
    .split('\n')
    .map((l) => l.replace(/#\s.*$/, '').trim())
    .filter((l) => /^vx (run|watch) /.test(l))
  expect(lines.length).toBe(11)
  const selects = (l: string): boolean =>
    /\s--(all|filter|affected)\b/.test(l.split(' -- ')[0]!) || /\S#\S/.test(l)
  expect(lines.filter((l) => !selects(l))).toEqual([])
})
