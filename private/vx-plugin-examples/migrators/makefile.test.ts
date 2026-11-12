// The Makefile migrator beside it, through core's migration seam alone:
// the configs it writes load in `vx lock`, and an empty plan is refused.
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, expect, it, spyOn } from 'bun:test'
import { migrateMakefiles } from './makefile.ts'

let root: string
let out: string
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vx-migrator-make-'))
  Bun.spawnSync({ cmd: ['git', 'init', '-q'], cwd: root })
  out = ''
  spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk)
    return true
  })
})
afterEach(async () => {
  ;(process.stdout.write as unknown as { mockRestore(): void }).mockRestore()
  await rm(root, { recursive: true, force: true })
})

const VX = path.join(path.dirname(new URL(import.meta.resolve('@vzn/vx')).pathname), 'bin.ts')

async function makefile(name: string, text: string): Promise<string> {
  const dir = path.join(root, 'services', name)
  await mkdir(dir, { recursive: true })
  await writeFile(path.join(dir, 'Makefile'), text)
  return dir
}

it('each target becomes a task, written as a config vx lock loads', async () => {
  const api = await makefile(
    'api',
    '.PHONY: all build\nGO = go\nall: build test\nbuild: gen\n\t$(GO) build ./...\ngen:\n\t@go generate ./...\ntest: build\n\tgo test ./...\n',
  )
  expect(await migrateMakefiles(root, [api])).toBe(0)
  const config = await readFile(path.join(api, 'vx.config.ts'), 'utf8')
  expect(config).toContain("  name: 'api',")
  expect(config).toContain(
    '    // TODO(make-migrate): the recipe uses make variables: write their values into the command\n',
  )
  const { default: loaded } = (await import(path.join(api, 'vx.config.ts'))) as {
    default: { tasks: Record<string, unknown> }
  }
  expect(loaded.tasks).toEqual({
    all: { dependsOn: ['build', 'test'] },
    build: { exec: { command: '$(GO) build ./...' }, dependsOn: ['gen'] },
    gen: { exec: { command: 'go generate ./...' } },
    test: { exec: { command: 'go test ./...' }, dependsOn: ['build'] },
  })
  // CI draws in colour: the styles sit between the label and its value.
  expect(Bun.stripANSI(out)).toContain('from      Makefile')
  const lock = Bun.spawnSync({ cmd: [process.execPath, VX, 'lock'], cwd: root })
  expect([lock.exitCode, lock.stderr.toString()]).toEqual([0, ''])
}, 20_000)

it('a project with no target is a refusal in the tool’s words', async () => {
  const empty = await makefile('empty', 'GO = go\n')
  await expect(migrateMakefiles(root, [empty])).rejects.toThrow(
    'nothing to migrate: no Makefile targets in any project',
  )
})
