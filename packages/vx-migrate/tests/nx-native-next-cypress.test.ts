// A migrated Next.js and Cypress target is the command its Nx executor
// runs (P2-3): where it ran, the env vars it set, and what it did besides
// as a TODO.

import { describe, expect, it } from 'bun:test'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const web = {
  projectRel: 'apps/web',
  projectName: 'web',
  targetOptions: (spec: string) =>
    spec === 'web:build:production' ? { outputPath: 'dist/apps/web' } : undefined,
}
const e2e = { projectRel: 'apps/web-e2e', projectName: 'web-e2e' }

type Row = [
  string,
  string,
  Record<string, unknown>,
  object,
  string,
  Record<string, string>,
  string[],
]

describe('Next.js and Cypress executors', () => {
  const rows: Row[] = [
    [
      'next build in the project dir, outputPath through NX_NEXT_OUTPUT_PATH',
      '@nx/next:build',
      { outputPath: '{workspaceRoot}/dist/apps/web', profile: true, buildLibsFromSource: true },
      web,
      'next build --profile',
      { NX_NEXT_OUTPUT_PATH: 'dist/apps/web' },
      [
        '@nx/next:build wrote a package.json (a `next start` script) into dist/apps/web, and copied next.config and public/ there — next build does not',
      ],
    ],
    [
      'next build into its own dir copies nothing',
      '@nx/next:build',
      { outputPath: 'apps/web', fileReplacements: [{ replace: 'a', with: 'b' }] },
      web,
      'next build',
      { NX_NEXT_OUTPUT_PATH: 'apps/web' },
      [
        '@nx/next:build wrote a package.json (a `next start` script) into apps/web — next build does not',
        '@nx/next:build applied `fileReplacements` — next build has no such step',
      ],
    ],
    [
      'next server in dev mode on Nx’s port 4200',
      '@nx/next:server',
      { buildTarget: 'web:build', dev: true, turbo: true },
      web,
      'next dev --port=4200 --turbo',
      { PORT: '4200' },
      [],
    ],
    [
      'next server in production mode starts in the build output dir',
      '@nx/next:server',
      {
        buildTarget: 'web:build:production',
        dev: false,
        port: 3000,
        hostname: '0.0.0.0',
        keepAliveTimeout: 5,
      },
      web,
      'cd ../../dist/apps/web && next start --port=3000 --hostname=0.0.0.0 --keepAliveTimeout=5',
      { PORT: '3000' },
      [],
    ],
    [
      'cypress run from the workspace root on the config file’s dir',
      '@nx/cypress:cypress',
      {
        cypressConfig: 'apps/web-e2e/cypress.config.ts',
        baseUrl: 'http://localhost:4200',
        env: { a: 1, b: 'x' },
        browser: 'chrome',
        exit: true,
        skipServe: true,
        devServerTarget: 'web:serve',
        port: 'cypress-auto',
      },
      e2e,
      'cd ../.. && cypress run --project=apps/web-e2e --config-file=cypress.config.ts --e2e --config=baseUrl=http://localhost:4200 --env=a=1,b=x --browser=chrome',
      {},
      [],
    ],
    [
      'cypress: the dev server Nx started first is a TODO, watch is open',
      '@nx/cypress:cypress',
      {
        cypressConfig: '{projectRoot}/cypress.config.ts',
        devServerTarget: 'web:serve',
        watch: true,
        exit: false,
      },
      e2e,
      'cd ../.. && cypress open --project=apps/web-e2e --config-file=cypress.config.ts --e2e --no-exit',
      {},
      [
        '@nx/cypress:cypress started "web:serve" first and tested its URL — depend on that server task and set its URL as baseUrl',
      ],
    ],
  ]
  for (const [title, executor, options, ctx, command, env, todos] of rows) {
    it(title, () => {
      expect(
        nativeExecutorCommand(
          executor,
          options,
          ctx as Parameters<typeof nativeExecutorCommand>[2],
        ),
      ).toEqual({ command, env, todos })
    })
  }

  it('a Next custom server has no plain line', () => {
    expect(
      nativeExecutorCommand('@nx/next:server', { customServerTarget: 'web:serve-custom' }, web),
    ).toBeNull()
  })
})
