// A migrated `@nx/js:swc` target is swc's own CLI (P2-7), as Nx's
// `getSwcCmd` builds it: from the project dir, the source root as input,
// the project's `.swcrc`, the output emptied first.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const lib = { projectRel: 'libs/a', projectName: 'a', sourceRoot: () => 'libs/a/src' }
const typecheck =
  '@nx/js:swc type-checked the project (tsc) besides compiling — add a typecheck task to dependsOn, or drop this line'
const pkg =
  '@nx/js:swc wrote a package.json (main, types, exports) into the output dir — swc does not'

describe('@nx/js:swc', () => {
  it('the source root into the output, the project’s .swcrc, emptied first', () => {
    expect(
      nativeExecutorCommand(
        '@nx/js:swc',
        {
          main: 'libs/a/src/index.ts',
          outputPath: 'dist/libs/a',
          tsConfig: 'libs/a/tsconfig.lib.json',
        },
        lib,
      ),
    ).toEqual({
      command: 'rm -rf ../../dist/libs/a && swc src -d ../../dist/libs/a --config-file=.swcrc',
      env: {},
      todos: [typecheck, pkg],
    })
  })

  it('a main outside the source root compiles the whole project; swcrc, flags, no clean', () => {
    expect(
      nativeExecutorCommand(
        '@nx/js:swc',
        {
          main: 'libs/a/server/main.ts',
          outputPath: 'dist/libs/a',
          swcrc: 'libs/a/.lib.swcrc',
          stripLeadingPaths: true,
          clean: false,
          skipTypeCheck: true,
          assets: ['libs/a/*.md'],
        },
        lib,
      ),
    ).toEqual({
      command: 'swc . -d ../../dist/libs/a --config-file=.lib.swcrc --strip-leading-paths',
      env: {},
      todos: [
        pkg,
        '@nx/js:swc copied `assets` into the output dir — swc does not; add a copy step',
      ],
    })
  })

  it('no source root: the project itself', () => {
    expect(
      nativeExecutorCommand(
        '@nx/js:swc',
        { main: 'libs/a/index.ts', outputPath: 'dist/libs/a', skipTypeCheck: true, clean: false },
        { projectRel: 'libs/a', projectName: 'a', sourceRoot: () => undefined },
      )?.command,
    ).toBe('swc . -d ../../dist/libs/a --config-file=.swcrc')
  })
})

describe('the source root comes from the graph, else a src dir on disk', () => {
  it('as Nx reads it', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vx-nx-swc-'))
    try {
      await writeFile(path.join(root, 'package.json'), '{"name":"root","private":true}')
      await mkdir(path.join(root, 'libs', 'b', 'src'), { recursive: true })
      await mkdir(path.join(root, 'libs', 'c'), { recursive: true })
      const build = (main: string) => ({
        executor: '@nx/js:swc',
        options: { main, outputPath: 'dist/x', skipTypeCheck: true, clean: false },
      })
      const graph = {
        nodes: {
          a: {
            name: 'a',
            data: {
              root: 'libs/a',
              sourceRoot: 'libs/a/lib',
              targets: { build: build('libs/a/lib/i.ts') },
            },
          },
          b: { name: 'b', data: { root: 'libs/b', targets: { build: build('libs/b/src/i.ts') } } },
          c: { name: 'c', data: { root: 'libs/c', targets: { build: build('libs/c/i.ts') } } },
        },
        dependencies: {},
      }
      const metas: ProjectMeta[] = ['a', 'b', 'c'].map((n) => ({
        name: n,
        dir: path.join(root, 'libs', n),
        packageJson: { name: n },
        configPath: null,
      }))
      const mapped = await mapNxWorkspace(root, metas, parseNxGraph(JSON.stringify(graph), 'g'), {
        persistentTodo: 'p',
        cacheable: new Set(),
        nativeExecutors: true,
      })
      const commands = Object.fromEntries(
        mapped.projects.map((p) => [
          p.name,
          (p.tasks.find((t) => t.name === 'build')!.task!['exec'] as { command: string }).command,
        ]),
      )
      expect(commands).toEqual({
        a: 'swc lib -d ../../dist/x --config-file=.swcrc',
        b: 'swc src -d ../../dist/x --config-file=.swcrc',
        c: 'swc . -d ../../dist/x --config-file=.swcrc',
      })
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
})
