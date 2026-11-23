import { defineProject } from '@vzn/vx'

// The core suite runs as this many parallel `bun test` processes, the files
// dealt by recorded weight (scripts/test-shard.ts). Many processes is not
// only speed: `bun test` pins ~2 descriptors per imported module and macOS
// caps a process at 10 240, so the whole suite in one process does not
// clear the cap. Eighty-four, not the four cores of the smallest box it
// runs on: a distributed run spreads the shards over workers, and the
// slowest shard is its critical path. On 4 cores, 24 shards finished in
// the same wall time as 12 (393 s), each 58 to 72 s against 131 s; on
// CI's workers 36 took 60 to 80 s, still the critical path (2026-10-23).
// Unequal, as counts and relative sizes (`shardSizes`): 46 equal shards
// were two 45 s waves on CI's 36 cores, the second as long as the first,
// and whichever runner was slow ended the run with its second shard.
// Big ones go first by rank and small ones fill the end: simulated on
// two main runs' own times, 20 runs each, the Linux work ended at 114
// and 122 s for 133 and 145 s (2026-11-18).
// The heaviest file (37 s) caps the biggest: a shard cannot hold less than one file.
export const SHARD_SHAPE = '24x4,24x2,36x1'
export const SHARD_COUNT = SHARD_SHAPE.split(',').reduce(
  (n, part) => n + Number(part.split('x')[0]),
  0,
)
// The suite's git fixtures assume git's defaults. A machine's global config
// can change what `git status` vouches for (`core.trustctime=false`,
// `core.checkStat=minimal`, which vx then declines to trust, A-6) or sign
// every commit a fixture makes; neither is the code under test.
const GIT_HERMETIC = { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
// vx forces colour on a task unless it sees FORCE_COLOR. The suite spawns
// vx and its tasks and reads their output as text, so it runs with colour
// off, as a host that sets none ran it before vx forced it.
// VX_CACHE_DIR: every fixture keeps its whole cache in its own .vx/cache; the
// default shares entries through the user's store, and one fixture would hit
// what another saved.
// Bun's transpiler cache writes under HOME, outside the sandbox's grants.
// The platform-bound tasks: CI runs them on Mac workers (darwin-arm64) or
// the arm worker (linux-arm64) of its one distributed run, and their key
// folds the platform (exec.platforms), so a Linux pass never replays as
// the macOS result (#3854).
const MAC = ['darwin-arm64'] as const
const SUITE_ENV = {
  ...GIT_HERMETIC,
  BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
  FORCE_COLOR: '0',
  VX_CACHE_DIR: '.vx/cache',
  // The suite reads vx as a laptop runs it: on CI a spawned vx inherits CI
  // and prints errors-only logs. A test about CI sets it for its child.
  CI: '',
}
// `bun build --compile --target=bun-<t>` for a target other than the
// running Bun fetches `@oven/bun-<t>` from the npm registry once, extracts
// it into `<cwd>/.<hash>-00000000.tmp/` and moves the runtime into
// `~/.bun/install/cache/bun-<t>-v<version>` (strace, Bun 1.4.2). The task's
// environment carries no BUN_INSTALL, so its Bun resolves the cache under
// HOME. The runtime embedded is `bun-<t>-v<the compiling Bun's version>`,
// and the bundler is that Bun too, so the compile tasks fold its version.
// The host target reuses the running binary; `check.bun.binary` holds the same
// grants for a host Bun that is not that target (a baseline build).
const BUN_RUNTIME_WRITES = ['~/.bun/install/cache/', '.*.tmp/**']
const BUN_RUNTIME_NETWORK = ['registry.npmjs.org']
const BUN_VERSION = ['bun --version']
// A key reads no other task's outputs (`vx lock`, X-54): the
// compiled binaries land in `dist/`, so every `**/*` here takes it back.
// `dist/` is gitignored, so no key read it before either. A compile writes
// `.<hash>-<n>.bun-build` and, cross-compiling, `.<16 hex>-<8 hex>.tmp/`
// in this directory mid-run; a key taken meanwhile by any task here would
// hash a file being written, so every `**/*` leaves Bun's temps out too.
const SOURCES = ['**/*', '!dist/**', '!**/*.bun-build', '!**/.????????????????-????????.tmp/**']
// The same for the other packages `test.bun.unsafe` reads: what
// @vzn/vx-docs' `build` tasks write
// (private/vx-docs/vx.config.ts), all gitignored.
const OTHER_OUTPUTS = [
  'packages/vx/dist/**',
  ...[
    'vx-docs/dist/**',
    ...[
      'all-features',
      'api',
      'architecture',
      'benchmarks',
      'caching',
      'cli',
      'compare/turbo-nx-support',
      'comparison',
      'execution',
      'flows',
      'optimizations',
      'overview',
      'parity',
      'patterns',
      'schema',
      'security',
      'upstream-ledger',
    ].map((page) => `vx-docs/src/content/docs/${page}.md`),
    'vx-docs/src/content/docs/modules/**',
    'vx-docs/src/content/docs/design/**',
    'vx-docs/src/content/docs/plugins/**',
  ].map((g) => `private/${g}`),
].map((g) => `!${g}`)
// The macOS run's share: only the files whose outcome is the platform's
// (`PLATFORM_TESTS` in scripts/test-shard.ts), a fifth of the suite's weight.
export const PLATFORM_SHARD_COUNT = 6
export const PLATFORM_UNSAFE_SHARD_COUNT = 3
// Bun's per-test 5 s default is a wall-clock budget: a test that spawns vx
// and git took 457 ms idle and passed 5 s on a packed, traced DTE worker
// (#4198). Speed is asserted in CPU time (helpers/cpu-clock.ts); this is
// only the hang guard, set where load does not reach it.
const TEST_TIMEOUT = '--timeout=30000'
const shardTask = (i: number, n = SHARD_COUNT, flags = '') => ({
  description: `bun test${flags}, shard ${i} of ${n} (dealt by scripts/test-shard.ts)`,
  dependsOn: ['install'],
  exec: {
    // Bun's transpiler cache in the task's own TMPDIR (the sandbox makes one
    // per task and removes it): the suite spawns vx hundreds of times, and
    // each spawn compiled all of src again. One shard took 47 s of CPU
    // without the cache and 34 s with it, cold (2026-11-10).
    command: `BUN_RUNTIME_TRANSPILER_CACHE_PATH="\${TMPDIR:-/tmp}/bun-transpiler" bun test --only-failures ${TEST_TIMEOUT} $(bun scripts/test-shard.ts ${i} ${n}${flags})`,
    ...(flags.includes('--platform') ? { platforms: MAC } : {}),
    env: {
      passThrough: ['VX_REQUIRE_SANDBOX', 'VX_REQUIRE_WATCH_EVENTS', 'VX_REQUIRE_NONROOT'],
      define: SUITE_ENV,
    },
    sandbox: {
      allow: {
        // The root README states counts the suite pins (the hook count,
        // item 283), and the agent skill lives at the root, where
        // `npx skills add vznjs/vx` finds it: reads across the project
        // boundary, declared here and made inputs below.
        read: ['**/*', '../../README.md', '../../skills/'],
        systemInfo: ['vfs.disk-space'],
        machLookup: ['com.apple.FSEvents'],
        // A run a test starts serves `vx last --live` on a unix socket
        // (run-live.ts); the sandbox refuses AF_UNIX without this.
        unixSockets: true,
      },
    },
  },
  inputs: {
    files: SOURCES,
    workspaceFiles: ['README.md', 'skills/**'],
  },
  outputs: { files: [] as string[] },
  cache: true,
})
// The release binary of each platform CI has a worker of must launch there:
// linux-arm64 is cross-compiled and runs nowhere else (the arm worker),
// darwin-arm64 on a Mac worker; plain check.bun.binary on the run's own Linux.
const checkBinary = (platforms?: readonly ('linux-arm64' | 'darwin-arm64')[]) => ({
  description:
    'compile the host binary the way npm.yml does; it must launch and report the manifest version',
  dependsOn: ['install'],
  exec: {
    command: 'bun scripts/check-binary.ts',
    ...(platforms === undefined ? {} : { platforms }),
    env: { passThrough: ['VX_REQUIRE_SANDBOX', 'VX_DEBUG_STRACE'] },
    sandbox: {
      allow: {
        // The bare-specifier workspace links the schedule plugin.
        read: ['**/*', '../vx-history/**'],
        write: ['dist/**', ...BUN_RUNTIME_WRITES],
        network: BUN_RUNTIME_NETWORK,
        systemInfo: ['vfs.disk-space'],
      },
      ignore: {
        write: ['*.bun-build'],
      },
    },
  },
  inputs: {
    files: ['src/**', 'package.json', 'scripts/check-binary.ts', 'scripts/binary-launch.ts'],
    workspaceFiles: ['packages/vx-history/**'],
    runtime: BUN_VERSION,
  },
  outputs: { files: [] },
  cache: true,
})
const shards = <T>(name: string, n: number, task: (i: number, n: number) => T): Record<string, T> =>
  Object.fromEntries(
    Array.from({ length: n }, (_, k) => [`${name}.shard-${k + 1}`, task(k + 1, n)]),
  )
const shardTasks = {
  ...shards('test.bun', SHARD_COUNT, (i, n) => shardTask(i, n, ` --shape ${SHARD_SHAPE}`)),
  ...shards('test.bun.platform', PLATFORM_SHARD_COUNT, (i, n) => shardTask(i, n, ' --platform')),
}

// The unsafe suite (`tests/*.unsafe.test.ts`), dealt the same way: as one
// process it was a DTE run's critical path (178 s of 216 s, 2026-10-22).
// At 6 its shards (35-42 s) were again a PR run's critical path (#4316).
export const UNSAFE_SHARD_COUNT = 10
const unsafeShardTask = (i: number, n: number, flags = '') => ({
  description: `bun test${flags} — the files a sandbox cannot host, shard ${i} of ${n}`,
  dependsOn: ['install'],
  exec: {
    command: `bun test --only-failures ${TEST_TIMEOUT} $(bun scripts/test-shard.ts ${i} ${n} --unsafe${flags})`,
    ...(flags === '' ? {} : { platforms: MAC }),
    env: {
      passThrough: [
        'VX_REQUIRE_SANDBOX',
        'VX_REQUIRE_WATCH_EVENTS',
        'VX_REQUIRE_NONROOT',
        'VX_REQUIRE_TAGS',
        // git-reftable.unsafe.test.ts: a git too old for reftable fails.
        'VX_REQUIRE_REFTABLE',
        'VX_PR_TITLE',
        'VX_PR_BASE',
        'VX_PR_HEAD',
        // npm-pack's install fetches from the registry. Where TLS is
        // signed by a local CA, npm without it retried
        // SELF_SIGNED_CERT_IN_CHAIN to the row's 180 s timeout (local
        // gate, 2026-09-28). A path, unset on CI; not a key input.
        'NODE_EXTRA_CA_CERTS',
      ],
      define: SUITE_ENV,
    },
  },
  inputs: {
    files: SOURCES,
    // The repo-wide laws in this suite read every package, the
    // workflows and the root files (bins, boundaries, exports, the
    // runner, the site's samples); until item 613 the key saw only
    // this package, so an edit elsewhere left the suite an up-to-date
    // hit in the gate. LICENSE (build-npm, npm-pack) and the cache-bump skill
    // (doc-references) were read unkeyed the same way, so CI's restored
    // cache replayed the suite over an edit to them.
    workspaceFiles: [
      'packages/*/**',
      'private/*/**',
      'examples/**',
      '.github/**',
      'scripts/**',
      'CLAUDE.md',
      'README.md',
      'LICENSE',
      '.claude/skills/**',
      'skills/**',
      'vx.config.ts',
      '.vx/workspace.ts',
      ...OTHER_OUTPUTS,
    ],
  },
  outputs: { files: [] as string[] },
  cache: true,
})
const unsafeShardTasks = {
  ...shards('test.bun.unsafe', UNSAFE_SHARD_COUNT, (i, n) => unsafeShardTask(i, n)),
  ...shards('test.bun.platform-unsafe', PLATFORM_UNSAFE_SHARD_COUNT, (i, n) =>
    unsafeShardTask(i, n, ' --platform'),
  ),
}

const compileTasks = Object.fromEntries(
  (['linux-x64', 'linux-arm64', 'darwin-x64', 'darwin-arm64'] as const).map((target) => [
    `compile.bun.${target}`,
    {
      description: `compile the standalone binary (${target})`,
      dependsOn: ['install'],
      exec: {
        // A release's version, defined into src/version.ts; empty off a release.
        command: `bun build --compile --no-compile-autoload-dotenv --compile-autoload-package-json --minify --bytecode --format=esm --splitting --target=bun-${target} --define "VX_RELEASE=\\"\${VX_RELEASE_VERSION#v}\\"" src/bin.ts --outfile dist/vx-${target}`,
        env: { passThrough: ['VX_RELEASE_VERSION'] },
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: [`dist/vx-${target}`, ...BUN_RUNTIME_WRITES],
            network: BUN_RUNTIME_NETWORK,
          },
          ignore: { write: ['*.bun-build'] },
        },
      },
      inputs: { files: SOURCES, runtime: BUN_VERSION, env: ['VX_RELEASE_VERSION'] },
      outputs: { files: [`dist/vx-${target}`] },
      cache: true,
    },
  ]),
)

// A release (npm.yml: `vx pipeline npm` over the release workers,
// vx-release-worker.yml; scripts/release*.ts). Uncached, since each has a
// side effect. A darwin step runs on a Mac (it can re-sign), a linux one on
// linux-x64; an uncached step that writes files keeps its dependants on its
// worker, so each platform's chain stays on one machine. Order: the binaries
// proven, the npm platform packages, attestations, the GitHub uploads (the
// darwin one publishes the release), then @vzn/vx and the plugins on npm,
// then the server images.
const RELEASE_VERSION = { passThrough: ['VX_RELEASE_VERSION'] }
// What `npm publish --provenance` reads under trusted publishing: the OIDC
// token request (npm's lib/utils/oidc.js), the CI detection (ci-info) and
// the provenance statement (libnpmpublish/lib/provenance.js), npm 12.2.
const NPM_OIDC_ENV = [
  'VX_RELEASE_VERSION',
  'GITHUB_ACTIONS',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'GITHUB_WORKFLOW_REF',
  'GITHUB_REPOSITORY',
  'GITHUB_REPOSITORY_ID',
  'GITHUB_REPOSITORY_OWNER_ID',
  'GITHUB_SERVER_URL',
  'GITHUB_EVENT_NAME',
  'GITHUB_REF',
  'GITHUB_SHA',
  'GITHUB_RUN_ID',
  'GITHUB_RUN_ATTEMPT',
  'RUNNER_ENVIRONMENT',
]
// The token request's host, the registry's exchange and publish, and
// Sigstore's certificate authority, transparency log and trust root.
const NPM_PUBLISH_NETWORK = [
  'registry.npmjs.org',
  '*.actions.githubusercontent.com',
  'fulcio.sigstore.dev',
  'rekor.sigstore.dev',
  'tuf-repo-cdn.sigstore.dev',
]
const NPM_HOME = '~/.npm/'
const LINUX = ['linux-x64'] as const
const releasePlatform = (os: 'linux' | 'darwin') => (os === 'darwin' ? MAC : LINUX)
// macOS resolves a host through configd: the darwin publish was refused it
// after its last package (0.0.489).
const DNS = ['com.apple.SystemConfiguration.DNSConfiguration']
// A step that reads the linux binaries names their compiles, whose cached
// outputs its worker restores; the darwin ones read prove's re-signed files.
const binaries = (os: 'linux' | 'darwin') =>
  os === 'linux' ? ['compile.bun.linux-x64', 'compile.bun.linux-arm64'] : []
const releaseTasks = {
  release: {
    description: 'the whole release: GitHub assets, npm packages and server images',
    dependsOn: ['release.docker'],
  },
  ...Object.fromEntries(
    (['linux', 'darwin'] as const).flatMap((os) => [
      [
        `release.npm.${os}.check`,
        {
          description: 'make sure npm can publish with provenance (>= 11.5.1, sigstore intact)',
          exec: {
            command: 'bun scripts/release.ts npm',
            platforms: releasePlatform(os),
            sandbox: {
              allow: {
                read: ['.'],
                write: ['dist/npm-cli/', NPM_HOME],
                network: ['registry.npmjs.org'],
                machLookup: DNS,
              },
            },
          },
        },
      ],
      [
        `release.npm.${os}.prove`,
        {
          description: `the ${os} binaries launch (re-signed only if macOS refuses) and report VX_RELEASE_VERSION`,
          dependsOn: [`compile.bun.${os}-x64`, `compile.bun.${os}-arm64`],
          exec: {
            command: `bun scripts/release.ts prove ${os}`,
            platforms: releasePlatform(os),
            env: RELEASE_VERSION,
            sandbox: {
              allow: {
                read: ['.'],
                // A re-sign: codesign writes `<binary>.cstemp` beside the
                // binary and asks trustd (macOS CI, 2026-10-03).
                ...(os === 'darwin'
                  ? {
                      write: [
                        'dist/vx-darwin-x64',
                        'dist/vx-darwin-arm64',
                        'dist/vx-darwin-x64.cstemp',
                        'dist/vx-darwin-arm64.cstemp',
                      ],
                      machLookup: ['com.apple.trustd.agent'],
                    }
                  : {}),
              },
              // Bun's x64 runtime probes CPU features and cache sizes under
              // Rosetta; the denied read changes nothing it prints.
              ...(os === 'darwin'
                ? {
                    ignore: {
                      systemInfo: ['hw.optional.bmi1', 'hw.optional.avx2_0', 'hw.l3cachesize'],
                    },
                  }
                : {}),
            },
          },
        },
      ],
      [
        `release.npm.${os}.assemble`,
        {
          description: `assemble the ${os} npm packages under dist/npm (scripts/build-npm.ts)`,
          dependsOn: [`release.npm.${os}.prove`, ...binaries(os)],
          exec: {
            command: `bun scripts/release.ts assemble ${os}`,
            platforms: releasePlatform(os),
            env: RELEASE_VERSION,
            sandbox: {
              allow: {
                // The plugin packages are discovered across packages/, and
                // @vzn/vx ships the repo's README, LICENSE and agent skill.
                read: ['.', '../*', '../../README.md', '../../LICENSE', '../../skills/'],
                write: ['dist/npm/'],
              },
            },
          },
        },
      ],
      [
        `release.npm.${os}.publish`,
        {
          description: `npm publish the ${os} packages under dist/npm, skipping any already on the registry`,
          // @vzn/vx after the darwin packages its optionalDependencies name:
          // the darwin upload follows the darwin publish on its Mac.
          dependsOn: [
            `release.npm.${os}.assemble`,
            `release.npm.${os}.check`,
            ...(os === 'linux' ? ['release.github.darwin.upload'] : []),
          ],
          exec: {
            command: `bun scripts/release.ts publish ${os}`,
            platforms: releasePlatform(os),
            env: { passThrough: NPM_OIDC_ENV, secret: ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] },
            sandbox: {
              allow: {
                read: ['.'],
                write: [NPM_HOME],
                network: NPM_PUBLISH_NETWORK,
                machLookup: DNS,
              },
            },
          },
        },
      ],
      [
        `release.github.${os}.attest`,
        {
          description: `attest the build provenance of the ${os} binaries, after any re-sign (scripts/release-attest.ts)`,
          dependsOn: [`release.npm.${os}.prove`, ...binaries(os)],
          exec: {
            command: `bun scripts/release-attest.ts ${os}`,
            platforms: releasePlatform(os),
            env: {
              // The job's OIDC token signs it; the repo's API stores it.
              passThrough: [
                'GH_TOKEN',
                'ACTIONS_ID_TOKEN_REQUEST_URL',
                'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
                'GITHUB_REPOSITORY',
                'GITHUB_SERVER_URL',
                'GITHUB_API_URL',
              ],
              secret: ['GH_TOKEN', 'ACTIONS_ID_TOKEN_REQUEST_TOKEN'],
            },
            sandbox: {
              allow: {
                read: ['.', '../../node_modules/'],
                network: [
                  'api.github.com',
                  '*.actions.githubusercontent.com',
                  'fulcio.sigstore.dev',
                  'rekor.sigstore.dev',
                  'tuf-repo-cdn.sigstore.dev',
                ],
                machLookup: DNS,
              },
            },
          },
        },
      ],
      [
        `release.github.${os}.upload`,
        {
          description: `attach the ${os} binaries to the draft release${os === 'darwin' ? ', then publish it' : ''} (scripts/release-assets.ts)`,
          dependsOn: [
            `release.github.${os}.attest`,
            ...binaries(os),
            // The last upload publishes the release: the linux binaries and
            // the darwin npm packages are out first.
            ...(os === 'darwin'
              ? [
                  'release.npm.darwin.prove',
                  'release.npm.darwin.publish',
                  'release.github.linux.upload',
                ]
              : []),
          ],
          exec: {
            command: `bun scripts/release-assets.ts ${os}${os === 'darwin' ? ' --publish' : ''}`,
            platforms: releasePlatform(os),
            env: {
              passThrough: ['VX_RELEASE_VERSION', 'GITHUB_REPOSITORY', 'GH_TOKEN'],
              secret: ['GH_TOKEN'],
            },
            sandbox: {
              allow: {
                read: ['.'],
                network: ['api.github.com', 'uploads.github.com'],
                machLookup: DNS,
                // Bun on Apple Silicon reads it here; the denial failed the
                // darwin upload after the release published.
                systemInfo: ['hw.optional.neon'],
              },
            },
          },
        },
      ],
    ]),
  ),
  'release.npm.served': {
    description: 'wait until npm serves every published tarball (HTTP 200), up to 15 min',
    dependsOn: ['release.npm.linux.publish'],
    exec: {
      command: 'bun scripts/release.ts served',
      platforms: LINUX,
      env: RELEASE_VERSION,
      sandbox: { allow: { read: ['.'], network: ['registry.npmjs.org'] } },
    },
  },
  // No sandbox: it drives the Docker daemon, as the servers' test.docker do.
  'release.docker': {
    description:
      'push the server images to ghcr.io/vznjs at VX_RELEASE_VERSION (scripts/release-images.ts)',
    dependsOn: ['release.npm.served'],
    exec: {
      command: 'bun scripts/release-images.ts',
      platforms: LINUX,
      env: {
        passThrough: ['VX_RELEASE_VERSION', 'GITHUB_ACTOR', 'GITHUB_TOKEN'],
        secret: ['GITHUB_TOKEN'],
      },
    },
  },
  'release.github.tag': {
    description: 'tag a green main commit with its next version, release it, dispatch the publish',
    exec: {
      command: 'bun scripts/auto-release.ts',
      env: {
        passThrough: ['VX_RELEASE_SHA', 'GITHUB_REPOSITORY', 'GH_TOKEN'],
        secret: ['GH_TOKEN'],
      },
      sandbox: {
        allow: { read: ['.', '../../.git'], network: ['api.github.com'] },
      },
    },
  },
}

export default defineProject({
  tasks: {
    ...shardTasks,
    ...unsafeShardTasks,
    ...releaseTasks,

    // `check.bun.version` sits under install so that every shard, the unsafe suite,
    // the lint tasks and the binary check wait on it: a gate below the Bun
    // floor stops here, in under a second, instead of an hour later with
    // the runtime's verdicts (scripts/bun-floor.ts says which).
    install: {
      dependsOn: ['^build', 'check.bun.version'],
    },

    'check.bun.version': {
      description: 'refuse a Bun below the floor (engines.bun) before any shard starts',
      exec: {
        command: 'bun scripts/bun-floor.ts',
        sandbox: {
          allow: {
            // The whole project, not the script's files: Bun probes
            // `bunfig.toml` in its cwd, and on macOS seatbelt refuses a
            // cwd no grant covers ("Module not found" for a granted
            // script). Both passed only through the root's `@vzn/vx` link
            // until core stopped following a link back to the task's own
            // project (item 720). The task is uncached, so the wide grant
            // cannot make a stale hit.
            read: ['.'],
          },
        },
      },
      // Keyed but uncached: with no inputs the task is keyless, and a key
      // that folds a keyless task is never read or saved, so every shard
      // behind `install` missed on every run. Uncached still: the check must
      // run under whatever Bun this run uses.
      inputs: {
        files: ['scripts/bun-floor.ts', 'src/util/**', 'package.json'],
        runtime: BUN_VERSION,
      },
    },

    // Core is consumed as source: what a dependant's `install` pulls
    // through `^build` is what it needs from its deps, and for core that
    // is nothing to compile — but it is not nothing to KEY. A dependant's
    // test and type-check read core's source, so `build` is a keyed group
    // over that source, and every dependant's `install` folds it: an edit
    // to core re-keys the plugin suites (item 687; as an empty group the
    // key never moved, and a warm local cache replayed a plugin's pass
    // over a core change). The release binaries are `compile`, and
    // `check.bun.binary` proves the one this host can run.
    build: {
      description:
        'nothing to build — core is consumed as source; the release binaries are compile',
      inputs: { files: ['src/**', 'tsconfig.json'] },
    },

    // What only a push to main runs (.vx/workspace.ts's `main` pipeline).
    main: {
      dependsOn: ['canary', 'deploy'],
    },
    deploy: {
      dependsOn: ['deploy.*'],
    },
    // main's: npm.yml publishes a release before its post lands.
    'deploy.github': {
      description: 'give each GitHub release the body of its release post on the site',
      exec: {
        command: 'bun scripts/release-sync.ts',
        env: {
          passThrough: ['GITHUB_REPOSITORY', 'GH_TOKEN'],
          secret: ['GH_TOKEN'],
        },
        sandbox: {
          allow: {
            read: ['.', '../../private/vx-docs/src/content/docs/releases'],
            network: ['api.github.com'],
          },
        },
      },
    },

    // What only main runs: each launches a release binary on its own
    // platform's worker or drives this machine's sandbox, uncached.
    canary: {
      dependsOn: ['canary.*'],
    },

    // macOS CI's checks of this machine's own sandbox, as tasks so they run on
    // a Mac worker: nothing runs on a distributed run's orchestrator. Neither
    // is sandboxed, as each drives the sandbox itself, and neither is cached.
    'canary.sandbox.leaks': {
      description:
        'drive 20 leaky sandboxed runs through run() under this machine’s sandbox; one it did not enforce fails',
      dependsOn: ['install'],
      exec: { command: 'bun tests/helpers/sandbox-canary.ts 20', platforms: MAC },
    },
    // A grant bwrap honoured by its mounts failed `@vzn/vx-docs#import` on
    // every Mac for a week (2026-10-17). No cache read: a hit would skip the
    // very tasks this runs. In a worktree: core refuses a nested run here.
    'canary.sandbox.cold-build': {
      description:
        'every package’s build under this machine’s sandbox, no cache, as a developer runs it',
      dependsOn: ['install'],
      exec: { command: 'bun scripts/build-cold.ts', platforms: MAC },
    },

    check: {
      dependsOn: ['check.*'],
    },

    'check.bun.binary': checkBinary(),
    'canary.bun.linux-arm64': checkBinary(['linux-arm64']),
    'canary.bun.darwin-arm64': checkBinary(MAC),

    lint: {
      dependsOn: ['lint.*'],
    },

    test: {
      // Every test.<x>: the shards are generated above, so a spread cannot
      // name them for the key check; `*` expands at graph build. The
      // platform shards run on a Mac worker and are skipped elsewhere.
      dependsOn: ['test.*'],
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      dependsOn: ['install'],
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
          },
        },
      },
      inputs: {
        files: SOURCES,
      },
      outputs: { files: [] },
      cache: true,
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      dependsOn: ['install'],
      exec: {
        command: 'oxfmt --check .',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
          },
        },
      },
      inputs: {
        files: SOURCES,
      },
      outputs: { files: [] },
      cache: true,
    },

    format: {
      dependsOn: ['format.*'],
    },

    'format.oxfmt': {
      description: 'oxfmt . — rewrite formatting in place',
      exec: {
        command: 'oxfmt .',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['.'],
          },
        },
      },
    },

    compile: {
      description: 'the standalone release binaries, one per target',
      dependsOn: ['compile.*'],
    },
    ...compileTasks,
  },
})
