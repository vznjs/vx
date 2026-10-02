// A migrated `@nx/esbuild:esbuild` target is esbuild's own command line
// (P2-5): from the workspace root, one build per format, npm dependencies
// external unless `thirdParty`, and what Nx did besides as a TODO.

import { describe, expect, it } from 'bun:test'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const api = { projectRel: 'apps/api', projectName: 'api' }
const typecheck =
  '@nx/esbuild:esbuild type-checked the project (tsc) besides bundling — add a typecheck task to dependsOn, or drop this line'
const pkg =
  "@nx/esbuild:esbuild copied the project's package.json (unless the workspace uses TS project references) into the output dir — esbuild does not"

describe('@nx/esbuild:esbuild', () => {
  it('the defaults: esm, node, esnext, npm dependencies external, the output emptied first', () => {
    expect(
      nativeExecutorCommand(
        '@nx/esbuild:esbuild',
        {
          main: 'apps/api/src/main.ts',
          outputPath: 'dist/apps/api',
          tsConfig: 'apps/api/tsconfig.app.json',
        },
        api,
      ),
    ).toEqual({
      command:
        'cd ../.. && rm -rf dist/apps/api && esbuild apps/api/src/main.ts --bundle --platform=node --target=esnext --tsconfig=apps/api/tsconfig.app.json --packages=external --format=esm --outfile=dist/apps/api/main.js',
      env: {},
      todos: [typecheck, pkg],
    })
  })

  it('two formats are two builds; thirdParty bundles npm packages but keeps the named externals', () => {
    expect(
      nativeExecutorCommand(
        '@nx/esbuild:esbuild',
        {
          main: '{projectRoot}/src/index.ts',
          outputPath: '{workspaceRoot}/dist/apps/api',
          outputFileName: 'server.js',
          format: ['esm', 'cjs'],
          thirdParty: true,
          external: ['pg', 'sharp'],
          excludeFromExternal: ['sharp'],
          minify: true,
          sourcemap: true,
          skipTypeCheck: true,
          deleteOutputPath: false,
          generatePackageJson: true,
        },
        api,
      ),
    ).toEqual({
      command:
        'cd ../.. && esbuild apps/api/src/index.ts --bundle --platform=node --target=esnext --external:pg --minify --sourcemap --format=esm --outfile=dist/apps/api/server.js && esbuild apps/api/src/index.ts --bundle --platform=node --target=esnext --external:pg --minify --sourcemap --format=cjs --outfile=dist/apps/api/server.cjs',
      env: {},
      todos: ['@nx/esbuild:esbuild generated a package.json in the output dir — esbuild does not'],
    })
  })

  it('additional entry points write an output dir', () => {
    expect(
      nativeExecutorCommand(
        '@nx/esbuild:esbuild',
        {
          main: 'apps/api/src/main.ts',
          additionalEntryPoints: ['apps/api/src/worker.ts'],
          outputPath: 'dist/apps/api',
          format: ['cjs'],
          skipTypeCheck: true,
        },
        api,
      )?.command,
    ).toBe(
      'cd ../.. && rm -rf dist/apps/api && esbuild apps/api/src/main.ts apps/api/src/worker.ts --bundle --platform=node --target=esnext --packages=external --format=cjs --outdir=dist/apps/api --out-extension:.js=.cjs',
    )
  })

  it('unbundled, Nx collects entry points from the graph: no line', () => {
    expect(
      nativeExecutorCommand(
        '@nx/esbuild:esbuild',
        { main: 'apps/api/src/main.ts', outputPath: 'dist/apps/api', bundle: false },
        api,
      ),
    ).toBeNull()
  })
})
