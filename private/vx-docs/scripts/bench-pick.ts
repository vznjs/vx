// Picks the numbers the site deploys with (2026-11-01: the site never shows
// a vx figure worse than it shows now). The measured run replaces
// src/data/bench.json only when no vx overhead in it is above the live
// site's (src/bench/hold.ts); otherwise the live numbers stay, the rest of
// the site still deploys, and `held=<figures>` in GITHUB_OUTPUT fails the
// job after the deploy, so the regression is seen and fixed, never shown.
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { BenchData } from '../src/bench/format.ts'
import { worse } from '../src/bench/hold.ts'

const SITE = path.resolve(import.meta.dir, '..')
const MEASURED = path.join(SITE, 'measured', 'bench.json')
const DATA = path.join(SITE, 'src', 'data', 'bench.json')
const LIVE = process.env.BENCH_LIVE_URL ?? 'https://vznjs.github.io/vx/bench.json'

const measured = JSON.parse(await readFile(MEASURED, 'utf8')) as BenchData
const res = await fetch(LIVE)
// 404: the site has not served its numbers yet, so there is nothing to hold.
// Any other failure keeps the committed copy: no live figure, no publish.
const live: BenchData | undefined =
  res.status === 404
    ? undefined
    : res.ok
      ? ((await res.json()) as BenchData)
      : JSON.parse(await readFile(DATA, 'utf8'))
const held = live === undefined ? [] : worse(measured, live)
await writeFile(DATA, JSON.stringify(held.length === 0 ? measured : live, null, 2) + '\n')
if (held.length === 0)
  console.log(`bench: publishing the measured run (live: ${LIVE}, ${res.status})`)
else
  console.log(
    `bench: vx is worse than the live site on ${held.join(', ')}; the site keeps its numbers`,
  )
if (process.env.GITHUB_OUTPUT)
  await appendFile(process.env.GITHUB_OUTPUT, `held=${held.join(',')}\n`)
