// `@nx/web:file-server`, the `serve-static` Nx infers beside a vite or
// webpack build, was a failing placeholder. It is `http-server` on the
// build's output with Nx's flags, and its build an edge; a bare
// `buildTarget: "build"` names the current project's target, as Nx's
// `parseTargetString` reads it.

import { describe, expect, it } from 'bun:test'
import type { ProjectMeta } from '@vzn/vx'
import { mapNxWorkspace, parseNxGraph } from '../src/nx/nx-map.js'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const DEV_DEP =
  '@nx/web:file-server ran the `http-server` that came with @nx/web — add http-server to devDependencies'
const rebuilt = (spec: string) =>
  `@nx/web:file-server rebuilt ${JSON.stringify(spec)} on change while serving — vx builds it once, first`

const options: Record<string, Record<string, unknown>> = { 'web:build': { outputPath: 'dist/web' } }
const outputs: Record<string, string[]> = { 'web:vite': ['{projectRoot}/dist/**/*'] }
const web = {
  projectRel: 'apps/web',
  projectName: 'web',
  targetOptions: (spec: string) => options[spec],
  targetExecutor: () => 'nx:run-commands',
  targetOutputs: (spec: string) => outputs[spec],
}

describe('@nx/web:file-server', () => {
  it("the build's outputPath, Nx's default flags; the build is an edge", () => {
    expect(nativeExecutorCommand('@nx/web:file-server', { buildTarget: 'web:build' }, web)).toEqual(
      {
        command: 'cd ../.. && http-server dist/web -c-1 --cors -a=localhost -p=4200',
        env: {},
        todos: [DEV_DEP, rebuilt('web:build')],
        deps: ['web:build'],
      },
    )
  })

  it('spa serves index.html as the 404 page and proxies misses to itself', () => {
    expect(
      nativeExecutorCommand(
        '@nx/web:file-server',
        { buildTarget: 'web:vite', spa: true, watch: false, port: 4300, cors: false, gzip: true },
        web,
      ),
    ).toEqual({
      command:
        "cd ../.. && cp apps/web/dist/index.html apps/web/dist/404.html && http-server apps/web/dist -c-1 --gzip -a=localhost '-P=http://localhost:4300?' -p=4300",
      env: {},
      todos: [DEV_DEP],
      deps: ['web:vite'],
    })
  })

  it('staticFilePath with no build target; ssl, proxy and cache flags', () => {
    expect(
      nativeExecutorCommand(
        '@nx/web:file-server',
        {
          staticFilePath: 'dist/site',
          host: '0.0.0.0',
          ssl: true,
          sslCert: 'c.pem',
          sslKey: 'k.pem',
          proxyUrl: 'http://api',
          proxyOptions: { secure: false },
          cacheSeconds: 60,
        },
        web,
      ),
    ).toEqual({
      command:
        'cd ../.. && http-server dist/site -c60 --cors -a=0.0.0.0 -S -C=c.pem -K=k.pem -P=http://api --proxy-options.secure=false -p=4200',
      env: {},
      todos: [DEV_DEP],
    })
  })

  it('no output to serve is no line', () => {
    expect(nativeExecutorCommand('@nx/web:file-server', { buildTarget: 'web:none' }, web)).toBe(
      null,
    )
  })

  it("the inferred serve-static serves the vite build's output and depends on it", async () => {
    const graph = {
      nodes: {
        web: {
          name: 'web',
          data: {
            root: 'apps/web',
            targets: {
              build: {
                command: 'vite build',
                options: { cwd: 'apps/web' },
                outputs: ['{workspaceRoot}/dist/apps/web'],
                cache: true,
              },
              'serve-static': {
                continuous: true,
                executor: '@nx/web:file-server',
                options: { buildTarget: 'build', spa: true },
              },
            },
          },
        },
      },
      dependencies: { web: [] },
    }
    const meta: ProjectMeta = {
      name: 'web',
      dir: '/w/apps/web',
      packageJson: { name: 'web' },
      configPath: null,
    }
    const mapped = await mapNxWorkspace('/w', [meta], parseNxGraph(JSON.stringify(graph), 'g'), {
      persistentTodo: 'p',
      cacheable: new Set(),
      nativeExecutors: true,
    })
    const task = mapped.projects[0]!.tasks.find((t) => t.name === 'serve-static')!
    expect((task.task!['exec'] as { command: string }).command).toBe(
      "cd ../.. && cp dist/apps/web/index.html dist/apps/web/404.html && http-server dist/apps/web -c-1 --cors -a=localhost '-P=http://localhost:4200?' -p=4200",
    )
    expect(task.task!['dependsOn']).toEqual(['web#build'])
    expect(task.todos).toContain(rebuilt('build'))
  })
})
