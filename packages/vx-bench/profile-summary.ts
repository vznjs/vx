// Summarise a V8 .cpuprofile (from `bun --cpu-prof`) by SELF time per
// function and by file, so a warm-run profile answers "where does the time
// go?" in one screen instead of a flame chart.
//
//   bun --cpu-prof --cpu-prof-dir=/tmp/prof packages/vx/src/bin.ts run build --all
//   bun bench/profile-summary.ts /tmp/prof/*.cpuprofile [top=25]

interface ProfileNode {
  id: number
  callFrame: { functionName: string; url: string; lineNumber: number }
  children?: number[]
}
interface Profile {
  nodes: ProfileNode[]
  samples: number[]
  timeDeltas: number[]
}

const file = process.argv[2]
if (!file) throw new Error('usage: bun bench/profile-summary.ts <file.cpuprofile> [top]')
const top = Number(process.argv[3] ?? 25)
const prof = (await Bun.file(file).json()) as Profile

const byId = new Map(prof.nodes.map((n) => [n.id, n]))
const selfUs = new Map<number, number>()
let totalUs = 0
for (let i = 0; i < prof.samples.length; i++) {
  const dt = prof.timeDeltas[i] ?? 0
  totalUs += dt
  const id = prof.samples[i]!
  selfUs.set(id, (selfUs.get(id) ?? 0) + dt)
}

function label(n: ProfileNode): string {
  const url = n.callFrame.url.replace(/^file:\/\//, '')
  const short = url.includes('/packages/vx/') ? url.slice(url.indexOf('/packages/vx/') + 1) : url
  return `${n.callFrame.functionName || '(anonymous)'}  ${short}:${n.callFrame.lineNumber + 1}`
}

const byFn = new Map<string, number>()
const byFile = new Map<string, number>()
for (const [id, us] of selfUs) {
  const n = byId.get(id)!
  const l = label(n)
  byFn.set(l, (byFn.get(l) ?? 0) + us)
  const url = n.callFrame.url || '(native)'
  byFile.set(url, (byFile.get(url) ?? 0) + us)
}

const fmt = (us: number) =>
  `${(us / 1000).toFixed(1).padStart(7)} ms ${((100 * us) / totalUs).toFixed(1).padStart(5)}%`
console.log(`total sampled: ${(totalUs / 1000).toFixed(1)} ms\n`)
console.log('— self time by function —')
for (const [l, us] of [...byFn].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(`${fmt(us)}  ${l}`)
console.log('\n— self time by file —')
for (const [f, us] of [...byFile].sort((a, b) => b[1] - a[1]).slice(0, top))
  console.log(`${fmt(us)}  ${f.replace(/^file:\/\//, '')}`)
