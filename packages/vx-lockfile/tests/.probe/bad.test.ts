import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { it } from 'bun:test'
import type { TaskNode } from '@vzn/vx'
import { bun, npm, pnpm, yarn } from '../../src/index.js'

const cases: Record<string, [string, () => any, string[]]> = {
  pnpm: ['pnpm-lock.yaml', pnpm, ['', 'just a string', '[]', 'lockfileVersion: 9.0\n', "lockfileVersion: '9.0'\nimporters: [1]\n", "lockfileVersion: '9.0'\nimporters:\n  .:\n    dependencies:\n      a: 3\n", '﻿lockfileVersion: \'9.0\'\n']],
  bun: ['bun.lock', bun, ['', '"x"', '{}', '{"lockfileVersion": 1, "workspaces": [1], "packages": []}', '{"lockfileVersion":1,"packages":{"a":[1]}}', '﻿{"lockfileVersion":1}']],
  npm: ['package-lock.json', npm, ['', '{}', '{"lockfileVersion":3}', '{"lockfileVersion":3,"packages":[]}', '{"lockfileVersion":"3"}', '{"lockfileVersion":1,"dependencies":{}}', '﻿{"lockfileVersion":3,"packages":{}}']],
  yarn: ['yarn.lock', yarn, ['', '# yarn lockfile v1\n', '__metadata:\n  version: 8\n', 'foo: [\n', '# yarn lockfile v1\n\n"a@^1":\n  version "1"\n']],
}
it('probe', async () => {
  for (const [m, [file, mk, texts]] of Object.entries(cases)) {
    for (const t of texts) {
      const root = await mkdtemp(path.join(tmpdir(), 'vx-bad-'))
      await writeFile(path.join(root, 'package.json'), '{"name":"r"}')
      await writeFile(path.join(root, file), t)
      const ctx = { workspaceRoot: root, cacheDir: path.join(root, '.vx'), warn() {} }
      try {
        const r = await mk().key!({ projectDir: root } as TaskNode, ctx)
        console.log(m, JSON.stringify(t).slice(0, 50), '=> KEY', JSON.stringify(r))
      } catch (e) {
        console.log(m, JSON.stringify(t).slice(0, 50), '=> ERR', (e as Error).constructor.name, (e as Error).message.slice(0, 120))
      }
      await rm(root, { recursive: true, force: true })
    }
  }
})
