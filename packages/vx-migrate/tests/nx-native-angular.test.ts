// A migrated `@nx/angular:package` / `ng-packagr-lite` target is the
// ng-packagr line Nx ran (P2-26), read from the executors in Nx 23.2.1:
// the project's ng-package.json and tsconfig from the workspace root, and
// what Nx did besides (tsconfig path remapping, its stylesheet processor)
// as TODOs.

import { describe, expect, it } from 'bun:test'
import { nativeExecutorCommand } from '../src/nx/nx-native.js'

const ui = { projectRel: 'libs/ui', projectName: 'ui' }
const nx = (e: string) => [
  `${e} pointed the tsconfig \`paths\` of buildable workspace libraries this one imports at their built output — ng-packagr reads the tsconfig as written`,
  `${e} processed styles with Nx's stylesheet processor (Tailwind from the project's config) — check ng-packagr's own output`,
]

describe('Angular library executors', () => {
  it('package: ng-packagr on the project and tsconfig, from the workspace root', () => {
    expect(
      nativeExecutorCommand(
        '@nx/angular:package',
        { project: 'libs/ui/ng-package.json', tsConfig: '{projectRoot}/tsconfig.lib.prod.json' },
        ui,
      ),
    ).toEqual({
      command:
        'cd ../.. && ng-packagr -p libs/ui/ng-package.json -c libs/ui/tsconfig.lib.prod.json',
      env: {},
      todos: nx('@nx/angular:package'),
    })
  })

  it('package with no project: the ng-package.json under the project root; watch carried, poll named', () => {
    expect(nativeExecutorCommand('@nx/angular:package', { watch: true, poll: 500 }, ui)).toEqual({
      command: 'cd ../.. && ng-packagr -p libs/ui/ng-package.json --watch',
      env: {},
      todos: [
        '@nx/angular:package option "poll" has no ng-packagr flag — not carried',
        ...nx('@nx/angular:package'),
      ],
    })
  })

  it('ng-packagr-lite: the same line, and that Nx ran a reduced build', () => {
    expect(
      nativeExecutorCommand(
        '@nrwl/angular:ng-packagr-lite',
        { project: 'libs/ui/ng-package.json' },
        ui,
      ),
    ).toEqual({
      command: 'cd ../.. && ng-packagr -p libs/ui/ng-package.json',
      env: {},
      todos: [
        ...nx('@nx/angular:ng-packagr-lite'),
        "@nx/angular:ng-packagr-lite ran Nx's reduced ng-packagr for incremental builds — ng-packagr builds the full package",
      ],
    })
  })
})
