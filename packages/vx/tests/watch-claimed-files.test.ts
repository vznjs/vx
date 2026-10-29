// A root file a fingerprint plugin claims is an event (item 971's set).
// The set was read once, at the start: a plugin added to the workspace
// config mid-watch claimed its file, the cycle ran under it, and an edit
// to that file started nothing until a restart.

import { writeFile } from 'node:fs/promises'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import { PLUGIN_IMPORT, pluginSource } from './helpers/plugin.js'
import {
  SETTLE_MS,
  initialOnly,
  runWarned,
  ARMS,
  arms,
  startWatch,
  until,
  useWatchFixture,
} from './helpers/watch-loop.js'

const claimant = (name: string): string =>
  `${PLUGIN_IMPORT}export default { plugins: [${pluginSource(
    name,
    `{ config(_ws, ctx) { ctx.warn('CLAIMANT-LOADED') }, fingerprint: { files: ['custom.lock'], affected: () => undefined } }`,
  )}] }\n`

describe('vx watch and claimed root files', () => {
  const f = useWatchFixture()

  it('a file a plugin added mid-watch claims is an event from then on', async () => {
    f.watch = startWatch(f.root, ['--all'], ARMS)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await Bun.write(path.join(f.root, '.vx/workspace.mjs'), claimant('org/claimant'))
    await until(() => runWarned(w, 'CLAIMANT-LOADED'), 'the cycle under the new plugin')
    await until(() => arms(w) === 2, 'the re-arm after it')
    await writeFile(path.join(f.root, 'custom.lock'), 'v1\n')
    await until(() => w.cycles() === 2, 'the cycle for the claimed file')
    expect(w.out()).toContain('changed root custom.lock')
  }, 40_000)

  // Control: claimed from the start, the file is an event (item 971's path).
  it('a file claimed at the start is an event', async () => {
    await Bun.write(path.join(f.root, '.vx/workspace.mjs'), claimant('org/claimant'))
    f.watch = startWatch(f.root)
    const w = f.watch
    await until(() => w.out().includes('watching '), 'the watching marker')
    await initialOnly(w, f.log)
    await writeFile(path.join(f.root, 'custom.lock'), 'v1\n')
    await until(() => w.cycles() === 1, 'the cycle for the claimed file')
    await Bun.sleep(SETTLE_MS)
    expect(w.cycles()).toBe(1)
  }, 40_000)
})
