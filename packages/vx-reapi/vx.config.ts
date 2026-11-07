import { defineProject } from '@vzn/vx'

// The suite as one task took 75 s on a DTE worker, past every core shard,
// so it set the run's tail. Three tasks, the files dealt by measured weight
// (`bun test <file>` alone, 2026-11-07: 69 s in all; wedged 15 s, tls 9.7 s
// and wire-sweep 8.6 s the heaviest, mostly retry backoff: each row that
// spends the 100 + 400 + 1600 ms budget waits 2.1 s). A new file goes in the
// lightest shard; suite-coverage fails on a file no shard names.
const SHARDS: readonly (readonly string[])[] = [
  [
    'cache-ac-refused',
    'cancel-operation',
    'exec-e2e',
    'executor-auth',
    'executor-sweep',
    'executor',
    'fake-reapi',
    'materialise-fence',
    'merkle-sweep',
    'reapi-e2e',
    'string-map-options',
    'wedged',
    'wire-exec-unavailable',
  ],
  [
    'encoding',
    'executor-no-stale-replay',
    'factory-capabilities',
    'merkle',
    'no-stale-hit',
    'option-kinds',
    'plugin-sweep',
    'queue-timeout',
    'read-bounds',
    'request-metadata-action',
    'timeout-options',
    'tls',
    'unknown-options',
    'wire-exec-sweep',
  ],
  [
    'boolean-options',
    'cache-sweep',
    'capabilities-retry',
    'decode-sweep',
    'executor-helpers-sweep',
    'integrity',
    'materialise-concurrency',
    'no-env',
    'plugin',
    'record-digest-sizes',
    'stream-cache',
    'vx-run-e2e',
    'wire-only-options',
    'wire-sweep',
    'wire',
  ],
]

// ONE bun PROCESS PER TEST FILE, not one for the shard: Bun 1.4.0's
// node:http2 client stalls inbound frames under load (oven-sh/bun#39796)
// and the stall compounds with accumulated gRPC sessions in one process
// — the whole suite in one process timed out at 90 s on CI (2026-08-23)
// while every file passes alone. `--isolate` was measured against real
// servers and stalled more (3/6 rounds against this loop's 1/6): it gives
// every file its own gRPC client, so the session-setup race runs nine
// times. The live suites SKIP without an endpoint and FAIL with the
// require flag set and no endpoint, so the plain `ci` run exercises the
// wire-level units and the CI job with the service containers proves
// the wire. The endpoint values are key inputs: a skip-mode pass never
// serves a live-mode run. No sandbox: the suites dial the service
// containers on the host's loopback over raw gRPC, and a sandboxed task
// on Linux lives in its own network namespace with no route to it.
const shard = (i: number, files: readonly string[]) => ({
  description: `bun test, shard ${i} of ${SHARDS.length}, one process per file (live suites need VX_REAPI_*_ENDPOINT)`,
  dependsOn: ['install'],
  exec: {
    command: `for f in ${files.map((f) => `tests/${f}.test.ts`).join(' ')}; do echo "== $f"; bun test --only-failures "$f" --timeout 90000 || exit 1; done`,
    env: {
      passThrough: [
        'VX_REAPI_TEST_ENDPOINT',
        'VX_REQUIRE_REAPI',
        'VX_REAPI_EXEC_ENDPOINT',
        'VX_REQUIRE_REAPI_EXEC',
      ],
      // Fixture repos assume git's defaults; a global config may sign commits.
      define: {
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        VX_CACHE_DIR: '.vx/cache',
      },
    },
  },
  inputs: {
    files: ['src/**', 'tests/**', 'package.json', 'tsconfig.json'],
    env: [
      'VX_REAPI_TEST_ENDPOINT',
      'VX_REQUIRE_REAPI',
      'VX_REAPI_EXEC_ENDPOINT',
      'VX_REQUIRE_REAPI_EXEC',
    ],
  },
  outputs: { files: [] as string[] },
  cache: true,
})

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    // Consumed as source by the packages that depend on this one: `build`
    // keys that source and runs nothing, so their `install` (which folds
    // `^build`) re-keys on an edit here (item 687).
    build: {
      description: 'nothing to build — consumed as source',
      dependsOn: ['^build'],
      inputs: { files: ['src/**', 'protos/**'] },
    },

    ci: {
      dependsOn: ['lint', 'test', 'test.live'],
    },

    test: {
      dependsOn: ['test.shard-*'],
    },

    ...Object.fromEntries(SHARDS.map((files, k) => [`test.shard-${k + 1}`, shard(k + 1, files)])),

    // Only the files that dial a real server (`*-e2e.test.ts`); `test` runs
    // every file, these in skip mode. It brings its servers: on a
    // distributed run they start on the agent that runs it. No cache: the
    // servers are images (`bazel-remote:latest`) the key cannot see. No
    // sandbox, for `test`'s reason. Both require flags: a skip is a silent
    // pass, and these suites are the only proof the two wires work.
    'test.live': {
      description: 'bun test, the live REAPI files, against services.cache and services.exec',
      dependsOn: ['install', 'services.cache', 'services.exec'],
      exec: {
        command:
          'for f in tests/*-e2e.test.ts; do echo "== $f"; bun test --only-failures "$f" --timeout 90000 || exit 1; done',
        env: {
          define: {
            GIT_CONFIG_GLOBAL: '/dev/null',
            GIT_CONFIG_NOSYSTEM: '1',
            VX_CACHE_DIR: '.vx/cache',
            VX_REAPI_TEST_ENDPOINT: 'grpc://127.0.0.1:19092',
            VX_REQUIRE_REAPI: '1',
            VX_REAPI_EXEC_ENDPOINT: 'grpc://127.0.0.1:51051',
            VX_REQUIRE_REAPI_EXEC: '1',
          },
        },
      },
    },

    // test.live's servers, in the foreground: the run stops them when it
    // is done. No sandbox: they reach the Docker daemon.
    'services.cache': {
      description: 'bazel-remote (REAPI cache) on :19092',
      exec: {
        command: 'sh tests/helpers/bazel-remote.sh',
        persistent: { readyWhen: 'Starting gRPC server' },
        timeout: '5m',
      },
      inputs: { files: ['tests/helpers/bazel-remote.sh'] },
    },

    'services.exec': {
      description: 'NativeLink (REAPI execution) on :51051',
      exec: {
        command: 'sh tests/helpers/nativelink.sh',
        persistent: { readyWhen: 'Worker registered' },
        timeout: '5m',
      },
      inputs: { files: ['tests/helpers/nativelink.sh', 'tests/helpers/nativelink-exec.json5'] },
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: {
        command: 'oxlint --type-aware --type-check',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      dependsOn: ['install'],
      inputs: {
        files: ['src/**', 'tests/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
      },
      outputs: { files: [] },
      cache: true,
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: {
        command: 'oxfmt --check .',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      dependsOn: ['install'],
      inputs: {
        files: ['**/*'],
      },
      outputs: { files: [] },
      cache: true,
    },
  },
})
