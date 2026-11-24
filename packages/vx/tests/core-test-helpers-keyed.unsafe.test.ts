// A package whose tests import core's test helpers (`../../vx/tests/helpers/`)
// reads them through its `@vzn/vx` link, which its edge to `@vzn/vx#build`
// grants; that build keys only core's `src/**`, so an edit to a helper left
// the package's test and type-aware lint keys unmoved and replayed a pass
// (2026-11-24). Each such task keys the helpers in `inputs.workspaceFiles`.
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
const HELPERS = 'packages/vx/tests/helpers/**'
const IMPORT = /from '(?:\.\.\/)+vx\/tests\/helpers\//

function importsHelpers(dir: string): boolean {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue
    const p = path.join(dir, e.name)
    if (
      e.isDirectory()
        ? importsHelpers(p)
        : /\.[cm]?[jt]s$/.test(e.name) && IMPORT.test(readFileSync(p, 'utf8'))
    )
      return true
  }
  return false
}

it("every cached test and type-aware lint task of a package importing core's test helpers keys them", () => {
  const unkeyed: string[] = []
  for (const top of ['packages', 'private']) {
    for (const name of readdirSync(path.join(REPO, top))) {
      const dir = path.join(REPO, top, name)
      if (
        name === 'vx' ||
        !['tests', 'src'].some((d) => {
          try {
            return importsHelpers(path.join(dir, d))
          } catch {
            return false
          }
        })
      )
        continue
      const lock = JSON.parse(readFileSync(path.join(dir, 'vx.lock.json'), 'utf8')) as {
        tasks: Record<
          string,
          {
            cache?: boolean
            exec?: { command?: string }
            inputs?: { files?: string[]; workspaceFiles?: string[] }
          }
        >
      }
      for (const [task, t] of Object.entries(lock.tasks)) {
        if (t.cache !== true || !(t.inputs?.files ?? []).includes('tests/**')) continue
        if (!/\bbun test\b|--type-aware/.test(t.exec?.command ?? '')) continue
        if (!(t.inputs?.workspaceFiles ?? []).includes(HELPERS))
          unkeyed.push(`${top}/${name}#${task}`)
      }
    }
  }
  expect(unkeyed).toEqual([])
})
