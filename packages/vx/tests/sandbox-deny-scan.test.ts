// B-40: where the scoped deny scan is stricter than rg, and where it
// refuses. Parity with SRT's own scan is sandbox-deny-scan.unsafe.test.ts.

import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'bun:test'
import { canScopeDenyScan, scopedMandatoryDenies } from '../src/exec/sandbox-deny-scan.js'

describe('scopedMandatoryDenies', () => {
  let root = ''
  const file = (rel: string): void => {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true })
    writeFileSync(path.join(root, rel), '')
  }
  const at = (...rels: string[]): string[] => rels.map((r) => path.join(root, r)).sort()
  beforeAll(() => {
    root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'vx-denyscan-')))
    file('.gitignore')
    writeFileSync(path.join(root, '.gitignore'), '.mcp.json\n')
    file('a/.mcp.json')
    file('a/node_modules/.bashrc')
    file('a/real')
    symlinkSync(path.join(root, 'a/real'), path.join(root, 'a/.zshrc'))
    file('a/b/c/.bashrc')
    file('deep/x/y/.bashrc')
    file('p[1]/.bashrc')
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('counts what rg skips: an ignored file, one in node_modules, a symlink by its name', () => {
    expect(scopedMandatoryDenies(root, [path.join(root, 'a')]).sort()).toEqual(
      at('a/.mcp.json', 'a/node_modules/.bashrc', 'a/.zshrc'),
    )
  })

  it('stops at rg depth 3 from the root, and at a grant below it', () => {
    expect(scopedMandatoryDenies(root, [path.join(root, 'deep/x/y')])).toEqual([])
    expect(scopedMandatoryDenies(root, [path.join(root, 'a/b')])).toEqual([])
  })

  it('reads nothing outside the root', () => {
    expect(scopedMandatoryDenies(path.join(root, 'a'), [path.join(root, 'deep')])).toEqual([])
  })

  it('refuses a deny a glob character would drop', () => {
    expect(() => scopedMandatoryDenies(root, [path.join(root, 'p[1]')])).toThrow(
      `the sandbox must keep ${path.join(root, 'p[1]/.bashrc')} read-only, and a path with a glob character (* ? [ ]) cannot reach it — rename the directory`,
    )
  })

  it('scopes only a root without glob characters', () => {
    expect([
      canScopeDenyScan('/w/ws'),
      canScopeDenyScan('/w/ws[1]'),
      canScopeDenyScan('/w/*'),
    ]).toEqual([true, false, false])
  })
})
