// `vx info` is where a broken setup is diagnosed, and it refused at once
// under a `.vx/workspace` that did not load (a syntax error, a plugin whose
// `config` hook threw): no Bun version, no sandbox verdict. It now prints
// every fact it learns without the workspace file, names what failed and
// why, and exits 1; `--format json` carries the same facts and the error.
import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'bun:test'
import { VERSION } from '../src/version.js'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import { BIN, vxSync } from './helpers/vx.js'

const roots: string[] = []
afterAll(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true })
})

async function workspace(source: string): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'vx-info-broken-')))
  roots.push(root)
  mkdirSync(path.join(root, '.vx'))
  await writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'r', private: true }))
  await writeFile(path.join(root, '.vx', 'workspace.mjs'), source)
  return root
}

const CASES: Array<[string, string, RegExp]> = [
  ['a syntax error', 'export default {\n', /workspace\.mjs/],
  [
    'a plugin whose config hook throws',
    `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
      'boom-plugin',
      "{ config() { throw new Error('boom in config') } }",
    )}] }\n`,
    /boom in config/,
  ],
]

describe('vx info under a workspace file that does not load', () => {
  it.each(CASES)(
    '%s: the facts it can learn, the error, exit 1',
    async (_, source, said) => {
      const root = await workspace(source)
      const text = vxSync(root, ['info'], { bin: BIN })
      expect(text.code).toBe(1)
      expect(text.out).toMatch(new RegExp(`^  vx +${VERSION.replace(/\./g, '\\.')} `, 'm'))
      expect(text.out).toMatch(new RegExp(`^  bun +${Bun.version.replace(/\./g, '\\.')}`, 'm'))
      expect(text.out).toMatch(/^  sandbox +(available|unavailable)/m)
      expect(text.out).toMatch(/^  cache dir +\S/m)
      const row = text.out.split('\n').find((l) => l.startsWith('  workspace config '))
      expect(row).toMatch(said)

      const json = vxSync(root, ['info', '--format', 'json'], { bin: BIN })
      expect(json.code).toBe(1)
      const facts = JSON.parse(json.out) as {
        vx: string
        bun: string
        sandbox: { available: boolean }
        cacheDir: string
        workspaceError: { code: string; message: string } | null
      }
      expect([facts.vx, facts.bun, typeof facts.sandbox.available]).toEqual([
        VERSION,
        Bun.version,
        'boolean',
      ])
      expect(facts.cacheDir).toStartWith(root)
      expect(facts.workspaceError?.code).toMatch(/^VX_E_/)
      expect(facts.workspaceError?.message).toMatch(said)
    },
    60_000,
  )

  it('a workspace that loads has no error (control)', async () => {
    const root = await workspace('export default {}\n')
    const json = vxSync(root, ['info', '--format', 'json'], { bin: BIN })
    expect(json.code).toBe(0)
    expect((JSON.parse(json.out) as { workspaceError: unknown }).workspaceError).toBeNull()
  }, 60_000)
})
