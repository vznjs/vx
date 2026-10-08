import { defineProject } from '@vzn/vx'

// The core suite runs as this many parallel `bun test` processes, the files
// dealt by recorded weight (scripts/test-shard.ts). Many processes is not
// only speed: `bun test` pins ~2 descriptors per imported module and macOS
// caps a process at 10 240, so the whole suite in one process does not
// clear the cap. Twelve, not the four cores of the smallest box it runs
// on: an oversubscribed box finishes in the same wall time as eight, a
// twelve-core one in two thirds of it.
export const SHARD_COUNT = 12
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
const SUITE_ENV = { ...GIT_HERMETIC, FORCE_COLOR: '0', VX_CACHE_DIR: '.vx/cache' }
// `bun build --compile --target=bun-<t>` for a target other than the
// running Bun fetches `@oven/bun-<t>` from the npm registry once, extracts
// it into `<cwd>/.<hash>-00000000.tmp/` and moves the runtime into
// `~/.bun/install/cache/bun-<t>-v<version>` (strace, Bun 1.4.2). The task's
// environment carries no BUN_INSTALL, so its Bun resolves the cache under
// HOME. The runtime embedded is `bun-<t>-v<the compiling Bun's version>`,
// and the bundler is that Bun too, so the compile tasks fold its version.
// The host target reuses the running binary; `check.binary` holds the same
// grants for a host Bun that is not that target (a baseline build).
const BUN_RUNTIME_WRITES = ['~/.bun/install/cache/', '.*.tmp/**']
const BUN_RUNTIME_NETWORK = ['registry.npmjs.org']
const BUN_VERSION = ['bun --version']
// A key reads no other task's outputs (`rules.upfrontKeys`, X-54): the
// compiled binaries land in `dist/`, so every `**/*` here takes it back.
// `dist/` is gitignored, so no key read it before either.
const SOURCES = ['**/*', '!dist/**']
// The same for the other packages `test.bun.unsafe` reads: what
// @vzn/vx-docs' `build`, `build.playground` and `import` write
// (packages/vx-docs/vx.config.ts), all gitignored.
const OTHER_OUTPUTS = [
  'vx/dist/**',
  'vx-docs/dist/**',
  'vx-docs/public/playground/planner.js',
  ...[
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
].map((g) => `!packages/${g}`)
const SHARDS = Array.from({ length: SHARD_COUNT }, (_, i) => i + 1)
const shardTask = (i: number) => ({
  description: `bun test, shard ${i} of ${SHARD_COUNT} (dealt by scripts/test-shard.ts)`,
  dependsOn: ['install'],
  exec: {
    command: `bun test --only-failures $(bun scripts/test-shard.ts ${i} ${SHARD_COUNT})`,
    env: {
      passThrough: ['VX_REQUIRE_SANDBOX', 'VX_REQUIRE_WATCH_EVENTS', 'VX_REQUIRE_NONROOT'],
      define: SUITE_ENV,
    },
    sandbox: {
      allow: {
        // The root README states counts the suite pins (the hook count,
        // item 283): a read across the project boundary, declared here
        // and made an input below so a README edit re-keys the shards.
        read: ['**/*', '../../README.md'],
        systemInfo: ['vfs.disk-space'],
        machLookup: ['com.apple.FSEvents'],
      },
    },
  },
  cache: {
    inputs: {
      files: SOURCES,
      workspaceFiles: ['README.md'],
    },
    outputs: { files: [] as string[] },
  },
})
const shardTasks = Object.fromEntries(SHARDS.map((i) => [`test.bun.shard-${i}`, shardTask(i)]))

// The release steps npm.yml, release.yml and auto-release.yml run
// (scripts/release.ts, scripts/auto-release.ts). Uncached, since each has a
// side effect, and in no `ci` graph: only a workflow names them.
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
const releaseTasks = {
  'release.stamp': {
    description: 'stamp VX_RELEASE_VERSION into package.json, the manifest the binary inlines',
    exec: {
      command: 'bun scripts/release.ts stamp',
      env: RELEASE_VERSION,
      sandbox: { allow: { read: ['.'], write: ['package.json'] } },
    },
  },
  'release.npm': {
    description: 'make sure npm can publish with provenance (>= 11.5.1, sigstore intact)',
    exec: {
      command: 'bun scripts/release.ts npm',
      sandbox: {
        allow: {
          read: ['.'],
          write: ['dist/npm-cli/', NPM_HOME],
          network: ['registry.npmjs.org'],
        },
      },
    },
  },
  ...Object.fromEntries(
    (['linux', 'darwin'] as const).flatMap((os) => [
      [
        `release.prove.${os}`,
        {
          description: `the ${os} binaries launch (re-signed only if macOS refuses) and report VX_RELEASE_VERSION`,
          exec: {
            command: `bun scripts/release.ts prove ${os}`,
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
              // Bun's x64 runtime probes CPU features under Rosetta; the
              // denied read changes nothing it prints.
              ...(os === 'darwin'
                ? { ignore: { systemInfo: ['hw.optional.bmi1', 'hw.optional.avx2_0'] } }
                : {}),
            },
          },
        },
      ],
      [
        `release.assemble.${os}`,
        {
          description: `assemble the ${os} npm packages under dist/npm (scripts/build-npm.ts)`,
          exec: {
            command: `bun scripts/release.ts assemble ${os}`,
            env: RELEASE_VERSION,
            sandbox: {
              allow: {
                // The plugin packages are discovered across packages/, and
                // @vzn/vx ships the repo's README and LICENSE.
                read: ['.', '../*', '../../README.md', '../../LICENSE'],
                write: ['dist/npm/'],
              },
            },
          },
        },
      ],
      [
        `release.publish.${os}`,
        {
          description: `npm publish the ${os} packages under dist/npm, skipping any already on the registry`,
          exec: {
            command: `bun scripts/release.ts publish ${os}`,
            env: { passThrough: NPM_OIDC_ENV, secret: ['ACTIONS_ID_TOKEN_REQUEST_TOKEN'] },
            sandbox: {
              allow: {
                read: ['.'],
                write: [NPM_HOME],
                network: NPM_PUBLISH_NETWORK,
                // macOS resolves the registry through configd: the darwin
                // publish was refused it after its last package (0.0.489).
                machLookup: ['com.apple.SystemConfiguration.DNSConfiguration'],
              },
            },
          },
        },
      ],
    ]),
  ),
  ...Object.fromEntries(
    (['linux', 'darwin'] as const).map((os) => [
      `release.upload.${os}`,
      {
        description: `attach the ${os} binaries to the draft release${os === 'darwin' ? ', then publish it' : ''} (scripts/release-assets.ts)`,
        exec: {
          command: `bun scripts/release-assets.ts ${os}${os === 'darwin' ? ' --publish' : ''}`,
          env: {
            passThrough: ['VX_RELEASE_VERSION', 'GITHUB_REPOSITORY', 'GH_TOKEN'],
            secret: ['GH_TOKEN'],
          },
          sandbox: {
            allow: {
              read: ['.'],
              network: ['api.github.com', 'uploads.github.com'],
              machLookup: ['com.apple.SystemConfiguration.DNSConfiguration'],
              // Bun on Apple Silicon reads it here; the denial failed
              // release.yml's sign-darwin job after the release published.
              systemInfo: ['hw.optional.neon'],
            },
          },
        },
      },
    ]),
  ),
  'release.auto': {
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
    ...releaseTasks,
    ci: {
      dependsOn: ['lint', 'test', 'check.binary'],
    },

    // `check.bun` sits under install so that every shard, the unsafe suite,
    // the lint tasks and the binary check wait on it: a gate below the Bun
    // floor stops here, in under a second, instead of an hour later with
    // the runtime's verdicts (scripts/bun-floor.ts says which).
    install: {
      dependsOn: ['^build', 'check.bun'],
    },

    'check.bun': {
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
      // Uncached on purpose: the runtime's version is not a key input, and a
      // hit recorded under 1.4.2 must not answer for a later run under 1.3.11.
    },

    // Core is consumed as source: what a dependant's `install` pulls
    // through `^build` is what it needs from its deps, and for core that
    // is nothing to compile — but it is not nothing to KEY. A dependant's
    // test and type-check read core's source, so `build` carries that
    // source's key through `source`, and every dependant's `install`
    // folds it: an edit to core re-keys the plugin suites (item 687;
    // as an empty group the key never moved, and a warm local cache
    // replayed a plugin's pass over a core change). The four release
    // targets are `build.bun` (release.yml), and `check.binary` proves
    // the one this host can run.
    build: {
      description:
        'nothing to build — core is consumed as source; the release binaries are build.bun',
      dependsOn: ['source'],
    },

    source: {
      description: 'the source dependants import: a key, not a build',
      exec: { command: 'true', sandbox: { allow: { read: [] } } },
      cache: {
        inputs: { files: ['src/**', 'index.ts', 'tsconfig.json'] },
        outputs: { files: [] },
      },
    },

    'check.binary': {
      description:
        'compile the host binary the way release.yml does; it must launch and report the manifest version',
      dependsOn: ['install'],
      exec: {
        command: 'bun scripts/check-binary.ts',
        sandbox: {
          allow: {
            // The bare-specifier workspace links the schedule plugin.
            read: ['**/*', '../vx-schedule-history/**'],
            write: ['dist/**', ...BUN_RUNTIME_WRITES],
            network: BUN_RUNTIME_NETWORK,
            systemInfo: ['vfs.disk-space'],
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
      },
      cache: {
        inputs: {
          files: [
            'src/**',
            'index.ts',
            'package.json',
            'scripts/check-binary.ts',
            'scripts/binary-launch.ts',
          ],
          workspaceFiles: ['packages/vx-schedule-history/**'],
          runtime: BUN_VERSION,
        },
        outputs: { files: [] },
      },
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    test: {
      dependsOn: ['test.bun'],
    },

    'test.bun': {
      description: 'bun test',
      // The pattern form: the shards are generated above, so a spread cannot
      // name them for the key check; `*` expands at graph build.
      dependsOn: ['test.bun.shard-*', 'test.bun.unsafe'],
    },

    'test.bun.unsafe': {
      description: 'bun test — the files a sandbox cannot host',
      dependsOn: ['install'],
      exec: {
        command: 'bun test --only-failures ./tests/*.unsafe.test.ts',
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
            'VX_SMALL_DISK',
            // npm-pack's install fetches from the registry. Where TLS is
            // signed by a local CA, npm without it retried
            // SELF_SIGNED_CERT_IN_CHAIN to the row's 180 s timeout (local
            // gate, 2026-09-28). A path, unset on CI; not a key input.
            'NODE_EXTRA_CA_CERTS',
          ],
          define: SUITE_ENV,
        },
      },
      cache: {
        inputs: {
          files: SOURCES,
          // The repo-wide laws in this suite read every package, the
          // workflows and the root files (bins, boundaries, exports, the
          // runner, the site's samples); until item 613 the key saw only
          // this package, so an edit elsewhere left the suite an up-to-date
          // hit in the gate.
          workspaceFiles: [
            'packages/*/**',
            'examples/**',
            '.github/**',
            'scripts/**',
            'CLAUDE.md',
            'README.md',
            'vx.config.ts',
            'vx.workspace.ts',
            ...OTHER_OUTPUTS,
          ],
        },
        outputs: { files: [] },
      },
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
      cache: {
        inputs: {
          files: SOURCES,
        },
        outputs: { files: [] },
      },
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
      cache: {
        inputs: {
          files: SOURCES,
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt.fix': {
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

    'build.bun': {
      description: 'compile standalone binaries for every target',
      dependsOn: [
        'build.bun.linux-x64',
        'build.bun.linux-arm64',
        'build.bun.darwin-x64',
        'build.bun.darwin-arm64',
      ],
    },

    'build.bun.linux-x64': {
      description: 'compile standalone binary (linux x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --no-compile-autoload-dotenv --compile-autoload-package-json --minify --bytecode --target=bun-linux-x64 src/bin.ts --outfile dist/vx-linux-x64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-linux-x64', ...BUN_RUNTIME_WRITES],
            network: BUN_RUNTIME_NETWORK,
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
      },
      cache: {
        inputs: { files: SOURCES, runtime: BUN_VERSION },
        outputs: { files: ['dist/vx-linux-x64'] },
      },
    },

    'build.bun.linux-arm64': {
      description: 'compile standalone binary (linux arm64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --no-compile-autoload-dotenv --compile-autoload-package-json --minify --bytecode --target=bun-linux-arm64 src/bin.ts --outfile dist/vx-linux-arm64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-linux-arm64', ...BUN_RUNTIME_WRITES],
            network: BUN_RUNTIME_NETWORK,
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
      },
      cache: {
        inputs: { files: SOURCES, runtime: BUN_VERSION },
        outputs: { files: ['dist/vx-linux-arm64'] },
      },
    },

    'build.bun.darwin-x64': {
      description: 'compile standalone binary (darwin x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --no-compile-autoload-dotenv --compile-autoload-package-json --minify --bytecode --target=bun-darwin-x64 src/bin.ts --outfile dist/vx-darwin-x64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-darwin-x64', ...BUN_RUNTIME_WRITES],
            network: BUN_RUNTIME_NETWORK,
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
      },
      cache: {
        inputs: { files: SOURCES, runtime: BUN_VERSION },
        outputs: { files: ['dist/vx-darwin-x64'] },
      },
    },

    'build.bun.darwin-arm64': {
      description: 'compile standalone binary (darwin arm64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --no-compile-autoload-dotenv --compile-autoload-package-json --minify --bytecode --target=bun-darwin-arm64 src/bin.ts --outfile dist/vx-darwin-arm64',
        sandbox: {
          allow: {
            systemInfo: ['vfs.disk-space'],
            read: ['.'],
            write: ['dist/vx-darwin-arm64', ...BUN_RUNTIME_WRITES],
            network: BUN_RUNTIME_NETWORK,
          },
          ignore: {
            write: ['*.bun-build'],
          },
        },
      },
      cache: {
        inputs: { files: SOURCES, runtime: BUN_VERSION },
        outputs: { files: ['dist/vx-darwin-arm64'] },
      },
    },
  },
})
