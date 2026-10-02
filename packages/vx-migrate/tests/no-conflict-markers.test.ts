// A merge left `<<<<<<< HEAD` in the README, and the formatter turned the
// rest into `\=======` and `> > > > > > > origin/main`: the gate passed and
// the markers shipped (#2225). Both spellings are refused in every text file.
import path from 'node:path'
import { expect, it } from 'bun:test'

const PKG = path.resolve(import.meta.dir, '..')
const MARKER = /^\s*(<{7}|>{7}|\\?={7}$|(> ){6}>)/

it('no text file in the package holds a merge conflict marker', async () => {
  const hits: string[] = []
  let read = 0
  for await (const rel of new Bun.Glob('**/*.{ts,mts,cjs,js,json,md}').scan({ cwd: PKG })) {
    if (rel.split('/').includes('node_modules')) continue
    read++
    const lines = (await Bun.file(path.join(PKG, rel)).text()).split('\n')
    lines.forEach((l, i) => MARKER.test(l) && hits.push(`${rel}:${i + 1}`))
  }
  expect(read).toBeGreaterThan(50)
  expect(hits).toEqual([])
})
