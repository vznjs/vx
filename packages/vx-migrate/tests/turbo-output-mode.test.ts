// Turbo 1 spells `outputLogs` `outputMode` (1.13.4 resolves it as the task's
// log mode); read as an unknown key, `new-only` said "no vx equivalent —
// map it manually" where `outputLogs: "new-only"` says nothing.
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapTurboWorkspace } from '../src/turbo/turbo-map.js'

let root: string
beforeEach(async () => {
  root = await mkdtemp(path.join(tmpdir(), 'vx-turbo-output-mode-'))
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function map(turbo: unknown) {
  await writeFile(path.join(root, 'turbo.json'), JSON.stringify(turbo))
  const dir = path.join(root, 'packages', 'a')
  await mkdir(dir, { recursive: true })
  const metas: ProjectMeta[] = [
    {
      name: 'a',
      dir,
      packageJson: { name: 'a', scripts: { build: 'b' } } as never,
      configPath: null,
    },
  ]
  return mapTurboWorkspace(root, metas, { splice: (_k, v) => v, persistentTodo: 'PERSIST' })
}

describe("turbo-map: Turbo 1's outputMode", () => {
  it('is outputLogs: new-only says nothing, another value names the run flag', async () => {
    const todos = async (outputMode: unknown) =>
      (await map({ pipeline: { build: { outputMode } } })).projects[0]!.tasks[0]!.todos
    expect([await todos('new-only'), await todos('errors-only')]).toEqual([
      [],
      [
        'turbo key "outputMode" ("errors-only") is a per-run setting in vx — run with --output-logs errors-only',
      ],
    ])
    const refused = await map({ pipeline: { build: { outputMode: 1 } } }).then(
      () => 'mapped',
      (e: unknown) => String(e),
    )
    expect(refused).toBe('UserError: turbo.json: pipeline."build".outputMode must be a string')
  })
})
