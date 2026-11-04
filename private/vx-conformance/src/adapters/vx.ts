// vx: a vx.config.mjs per project, the lockfile plugin for edges (as a
// user's `bun()` reads them), then `vx lock`, which every run reads.
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import type { Adapter } from '../adapter.ts'
import { projectDir } from '../spec.ts'

const LOCKFILE = path.join(
  import.meta.dir,
  '..',
  '..',
  '..',
  '..',
  'packages',
  'vx-lockfile',
  'src',
  'index.ts',
)
const VX = 'node_modules/.bin/vx'

export const vx: Adapter = {
  name: 'vx',
  pkg: '@vzn/vx',
  bins: ['vx'],
  lacks: [],
  env: { NO_COLOR: '1', VX_CACHE_DIR: '.vx/cache' },
  async configure(dir, ws, command) {
    await mkdir(path.join(dir, '.vx'), { recursive: true })
    await writeFile(
      path.join(dir, '.vx', 'workspace.mjs'),
      `import { bun } from ${JSON.stringify(LOCKFILE)}\nexport default { plugins: [bun()] }\n`,
    )
    for (const [name, p] of Object.entries(ws.projects)) {
      const tasks = Object.fromEntries(
        Object.entries(p.tasks ?? {}).map(([t, spec]) => [
          t,
          {
            exec: {
              command: command(name, t),
              ...(spec.env ? { env: { passThrough: spec.env } } : {}),
            },
            ...(spec.dependsOn ? { dependsOn: spec.dependsOn } : {}),
            ...(spec.inputs
              ? { inputs: { files: spec.inputs, ...(spec.env ? { env: spec.env } : {}) } }
              : {}),
            ...(spec.inputs && spec.outputs && spec.cache !== false
              ? { cache: { outputs: { files: spec.outputs } } }
              : {}),
          },
        ]),
      )
      await writeFile(
        path.join(dir, projectDir(name, p), 'vx.config.mjs'),
        `export default ${JSON.stringify({ tasks }, null, 2)}\n`,
      )
    }
    return [[VX, 'lock']]
  },
  run: (task, projects) => [
    VX,
    'run',
    task,
    ...(projects ? projects.flatMap((p) => ['--filter', p]) : ['--all']),
  ],
  affected: (task, base) => [VX, 'run', task, `--affected=${base}`],
}
