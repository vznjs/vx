// A named input neither nx.json nor the project defines (an `extends`
// preset not installed where the snapshot is read) keys the whole project
// (P2-21): an empty list keyed a cached task on its config alone, a stale
// hit after every source edit.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'

const target = (inputs: string[]) => ({
  command: 'tsc',
  cache: true,
  inputs,
  outputs: ['{projectRoot}/dist'],
})
const graph = {
  nodes: {
    a: {
      name: 'a',
      data: { root: 'libs/a', targets: { build: target(['production', '^production']) } },
    },
    b: { name: 'b', data: { root: 'libs/b', targets: { build: target(['production']) } } },
  },
  dependencies: { a: [{ source: 'a', target: 'b', type: 'static' }], b: [] },
}

describe('an undefined named input', () => {
  it('keys the whole project, its dependency twin too, and says so', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-unknown-input-'))
    try {
      await writeFile(path.join(root, 'package.json'), '{"name":"r","private":true}')
      await writeFile(path.join(root, 'nx.json'), '{"extends":"@acme/nx-preset/nx.json"}')
      const metas: ProjectMeta[] = ['a', 'b'].map((n) => ({
        name: n,
        dir: path.join(root, 'libs', n),
        packageJson: { name: n },
        configPath: null,
      }))
      const mapped = await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
        cacheable: new Set(),
        migration: true,
      })
      const tasks = new Map(
        mapped.projects.flatMap((p) =>
          p.tasks.map((t) => [`${p.name}#${t.name}` as string, t] as const),
        ),
      )
      const files = (id: string) =>
        (tasks.get(id)!.task!['cache'] as { inputs: { files: unknown } }).inputs.files
      expect(files('a#build')).toEqual(['**/*'])
      expect(files('b#build')).toEqual(['**/*'])
      // `b#build`'s output taken back (core X-54).
      expect(files('b#nx-input:production')).toEqual([
        'package.json',
        'project.json',
        '**/*',
        '!dist',
      ])
      expect(tasks.get('a#build')!.todos).toEqual([
        'named input "production" not found in nx.json or the project — keyed on the whole project (`**/*`) until its globs are declared',
      ])
      expect(tasks.get('b#nx-input:production')!.todos).toEqual([
        'named input "production" not found for "b" — keyed on its whole project (`**/*`) until its globs are declared',
      ])
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
