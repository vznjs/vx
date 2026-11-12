// The planner is pure: it imports its siblings and core's types, never the
// wire, the relay, the cache or a runtime API, so a bench or a lab can
// drive it as the run does.
import { expect, it } from 'bun:test'
import { readdir } from 'node:fs/promises'
import path from 'node:path'

const dir = path.join(import.meta.dir, '..', 'src', 'plan')

it('src/plan imports only itself and types from @vzn/vx', async () => {
  const bad: string[] = []
  const files = (await readdir(dir)).filter((f) => f.endsWith('.ts'))
  expect(files).toContain('index.ts')
  for (const f of files) {
    const src = await Bun.file(path.join(dir, f)).text()
    for (const m of src.matchAll(/^(import|export)(\s+type)?\b[^'"]*?from\s+'([^']+)'/gms)) {
      const [, , type, spec] = m
      if (/^\.\/[\w-]+\.js$/.test(spec!)) continue
      if (spec === '@vzn/vx' && type !== undefined) continue
      bad.push(`${f}: ${spec}`)
    }
    for (const m of src.matchAll(/\b(Bun|process|Date\.now|performance|require|import\()\b/g))
      bad.push(`${f}: ${m[0]}`)
  }
  expect(bad).toEqual([])
})

it('nothing outside src/plan reaches past its index', async () => {
  const bad: string[] = []
  const src = path.join(import.meta.dir, '..', 'src')
  for (const f of await readdir(src)) {
    if (!f.endsWith('.ts')) continue
    const text = await Bun.file(path.join(src, f)).text()
    for (const m of text.matchAll(/from\s+'\.\/plan\/([\w-]+)\.js'/g))
      // A config load reads the strategies alone, never the planner.
      if (!(m[1] === 'index' || (f === 'plugin.ts' && m[1] === 'strategy')))
        bad.push(`${f}: ${m[1]}`)
  }
  expect(bad).toEqual([])
})
