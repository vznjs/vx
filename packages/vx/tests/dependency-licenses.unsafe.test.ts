// Every package vx publishes installs its production dependencies on the
// user's machine, and the compiled binary embeds core's. A copyleft or
// unlicensed package in that closure would bind every user, so the closure
// is walked from the installed tree and each license must be one on the
// permissive list, or a dual license with a permissive choice.
//
// `.unsafe`: it reads every package and the hoisted node_modules.

import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'

const REPO = path.resolve(import.meta.dir, '..', '..', '..')
const PERMISSIVE = new Set(['0BSD', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause', 'ISC', 'MIT'])

function resolveFrom(dir: string, name: string): string | undefined {
  for (let d = dir; ; d = path.dirname(d)) {
    const p = path.join(d, 'node_modules', name, 'package.json')
    if (existsSync(p)) return realpathSync(path.dirname(p))
    if (path.dirname(d) === d) return undefined
  }
}

/** Every package in `root`'s production closure, as `name@version` → license. */
function closure(root: string): Map<string, string> {
  const seen = new Map<string, string>()
  const walk = (dir: string): void => {
    const pj = JSON.parse(readFileSync(path.join(dir, 'package.json'), 'utf8'))
    const deps = Object.keys({ ...pj.dependencies, ...pj.optionalDependencies })
    for (const name of deps) {
      const at = resolveFrom(dir, name)
      if (at === undefined) {
        if (pj.optionalDependencies?.[name] !== undefined) continue
        throw new Error(`${pj.name}: ${name} is not installed`)
      }
      const dep = JSON.parse(readFileSync(path.join(at, 'package.json'), 'utf8'))
      const key = `${dep.name}@${dep.version}`
      if (seen.has(key)) continue
      seen.set(key, typeof dep.license === 'string' ? dep.license : JSON.stringify(dep.license))
      walk(at)
    }
  }
  walk(root)
  return seen
}

const permissive = (license: string): boolean =>
  license
    .replace(/^\(|\)$/g, '')
    .split(' OR ')
    .some((l) => PERMISSIVE.has(l.trim()))

const published = readdirSync(path.join(REPO, 'packages'))
  .map((d) => path.join(REPO, 'packages', d))
  .filter((d) => {
    const f = path.join(d, 'package.json')
    return existsSync(f) && JSON.parse(readFileSync(f, 'utf8')).private !== true
  })

describe('dependency licenses', () => {
  it('are permissive across every published package', () => {
    const bad: string[] = []
    let walked = 0
    for (const dir of published) {
      for (const [pkg, license] of closure(dir)) {
        walked++
        if (!permissive(license)) bad.push(`${path.basename(dir)}: ${pkg} (${license})`)
      }
    }
    expect(bad).toEqual([])
    // Floor: core and vx-reapi have dependencies, so a walk that finds
    // none cannot pass.
    expect(walked).toBeGreaterThan(20)
  })

  it('reads a copyleft license as not permissive, and a dual one by its choice', () => {
    expect(permissive('GPL-3.0')).toBe(false)
    expect(permissive('LGPL-2.1-only')).toBe(false)
    expect(permissive('undefined')).toBe(false)
    expect(permissive('(BSD-3-Clause OR GPL-2.0)')).toBe(true)
    expect(permissive('MIT')).toBe(true)
  })
})
