// CI's Bench job, before the deploy: the site's src/data/bench.json
// becomes the run just measured only when vx is no worse against Turbo
// than on the live site; otherwise it stays the live numbers and the job
// fails after the deploy, so docs still ship and the regression is red.
//   bun scripts/bench-gate.ts <live-url> → prints `published=true|false`
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BenchData } from '../src/bench/format.ts'
import { againstTurbo, worse } from '../src/bench/gate.ts'

const dir = path.resolve(import.meta.dir, '..')
const site = path.join(dir, 'src/data/bench.json')
const next = JSON.parse(await readFile(path.join(dir, 'measured/bench.json'), 'utf8')) as BenchData
// Before a deploy served bench.json, the committed copy is what showed.
const res = await fetch(process.argv[2]!)
if (!res.ok && res.status !== 404) throw new Error(`${process.argv[2]}: HTTP ${res.status}`)
const live = (res.ok ? await res.json() : JSON.parse(await readFile(site, 'utf8'))) as BenchData
const bad = worse(live, next)
const pct = (r: Record<string, number>) =>
  Object.entries(r)
    .map(([k, v]) => `${k} ${(v * 100).toFixed(0)}%`)
    .join(', ')
console.log(`vx's overhead as a share of Turbo's, live: ${pct(againstTurbo(live))}`)
console.log(`vx's overhead as a share of Turbo's, this run: ${pct(againstTurbo(next))}`)
await writeFile(site, JSON.stringify(bad.length === 0 ? next : live, null, 2) + '\n')
if (bad.length > 0)
  console.log(`vx is worse against Turbo on ${bad.join(', ')}: the live numbers stay`)
console.log(`published=${bad.length === 0}`)
