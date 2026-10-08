// `hangupIgnored` reads the SIGHUP disposition this process inherited:
// Linux from /proc/self/status, macOS through sigaction. Both answers are
// driven, each in a fresh process, so the read is the one at startup.
import path from 'node:path'
import { expect, it } from 'bun:test'

const MODULE = path.resolve(import.meta.dir, '..', 'src', 'util', 'hangup.ts')
const PROBE = `import { hangupIgnored } from ${JSON.stringify(MODULE)}; console.log(hangupIgnored())`

function probe(trap: string): string {
  const r = Bun.spawnSync(['sh', '-c', `${trap}exec "$0" -e "$1"`, process.execPath, PROBE], {
    env: { ...process.env },
  })
  return r.stdout.toString().trim()
}

it('hangupIgnored answers for the disposition vx was started with', () => {
  expect([probe(''), probe(`trap '' HUP; `)]).toEqual(['false', 'true'])
})
