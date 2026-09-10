import { defineProject } from '@vzn/vx'

export default defineProject({
  tasks: {
    install: {
      dependsOn: ['^build'],
    },

    ci: {
      dependsOn: ['lint', 'test'],
    },

    // ONE bun PROCESS PER TEST FILE, not one for the suite: Bun 1.4.0's
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
    test: {
      description: 'bun test, one process per file (live suites need VX_REAPI_*_ENDPOINT)',
      dependsOn: ['install'],
      exec: {
        command:
          'for f in tests/*.test.ts; do echo "== $f"; bun test "$f" --timeout 90000 || exit 1; done',
        env: {
          passThrough: [
            'VX_REAPI_TEST_ENDPOINT',
            'VX_REQUIRE_REAPI',
            'VX_REAPI_EXEC_ENDPOINT',
            'VX_REQUIRE_REAPI_EXEC',
          ],
        },
      },
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json', 'tsconfig.json'],
          env: [
            'VX_REAPI_TEST_ENDPOINT',
            'VX_REQUIRE_REAPI',
            'VX_REAPI_EXEC_ENDPOINT',
            'VX_REQUIRE_REAPI_EXEC',
          ],
        },
        outputs: { files: [] },
      },
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
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json', '.oxlintrc.json', 'tsconfig.json'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: {
        command: 'oxfmt --check .',
        sandbox: { allow: { read: ['**/*'], systemInfo: ['vfs.disk-space'] } },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['**/*'],
        },
        outputs: { files: [] },
      },
    },
  },
})
