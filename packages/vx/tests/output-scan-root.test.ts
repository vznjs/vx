import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterAll, expect, it } from 'bun:test'
import { resolveOutputs, resolveOutputTree } from '../src/cache/index.js'

const root = await mkdtemp(path.join(os.tmpdir(), 'vx-scan-root-'))
afterAll(() => rm(root, { recursive: true, force: true }))

/** The directories each `Bun.Glob` scan started from, project-relative. */
async function scanned<T>(projectDir: string, f: () => Promise<T>): Promise<[T, string[]]> {
  const native = Bun.Glob.prototype.scanSync
  const from: string[] = []
  Bun.Glob.prototype.scanSync = function (this: Bun.Glob, opts) {
    const cwd = typeof opts === 'string' ? opts : (opts?.cwd ?? '.')
    from.push(path.relative(projectDir, cwd))
    return native.call(this, opts as never)
  }
  try {
    return [await f(), from]
  } finally {
    Bun.Glob.prototype.scanSync = native
  }
}

it('scans an output glob from its static directory, finding what the walk from the project finds', async () => {
  const p = path.join(root, 'p')
  for (let i = 0; i < 20; i++) {
    await mkdir(path.join(p, `out/d${i}/.hid`), { recursive: true })
    await writeFile(path.join(p, `out/d${i}/v.js`), '')
    await writeFile(path.join(p, `out/d${i}/.hid/x`), '')
  }
  await mkdir(path.join(p, 'out/d3/empty'))
  const [files, from] = await scanned(p, () =>
    resolveOutputTree({
      projectDir: p,
      outputs: ['out/d3/**', 'out/*/v.js'],
      nestedProjectDirs: [],
    }),
  )
  // The walk from the project read all 20 dirs per task, twice per miss:
  // 2.3 ms a scan beside 9000 (2026-10-25).
  expect(from.toSorted()).toEqual(['out', 'out/d3'])
  expect(files.files.map((f) => path.relative(p, f)).toSorted()).toEqual(
    ['out/d3/.hid/x', ...Array.from({ length: 20 }, (_, i) => `out/d${i}/v.js`)].toSorted(),
  )
  expect(files.emptyDirs.map((f) => path.relative(p, f))).toEqual(['out/d3/empty'])
})

it('enters a static directory reached through a link, as the walk from the project did', async () => {
  const p = path.join(root, 'q')
  await mkdir(path.join(p, 'build'), { recursive: true })
  await writeFile(path.join(p, 'build/a.js'), '')
  await symlink('build', path.join(p, 'out'))
  const [files, from] = await scanned(p, () =>
    resolveOutputs({ projectDir: p, outputs: ['out/**/*.js'], nestedProjectDirs: [] }),
  )
  expect(from).toEqual(['out'])
  expect(files.map((f) => path.relative(p, f))).toEqual(['out/a.js'])
})
