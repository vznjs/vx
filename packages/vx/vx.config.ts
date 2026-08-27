import { defineProject } from './src/index.ts'

export default defineProject({
  tasks: {
    // CI gate = fast feedback: lint + test only. Building the four
    // cross-compiled release binaries lives in `release.yml` (`vx run
    // build`), which runs them alone — fanning all four out concurrently
    // alongside lint + test starves the ubuntu runner and a darwin
    // cross-compile gets OOM-killed.
    ci: {
      dependsOn: ['lint', 'test'],
    },

    setup: {
      description: 'bun install on the worker (install-as-an-action)',
      exec: {
        remote: 'only',
        command: 'bun ci',
        env: {
          define: {
            BUN_INSTALL_CACHE_DIR: '/root/.bun/install/cache',
          },
        },
      },
      cache: {
        inputs: {
          files: [],
          workspaceFiles: [
            'package.json',
            'bun.lock',
            'packages/*/package.json',
            'apps/*/package.json',
          ],
        },
        outputs: {
          files: [],
          workspaceFiles: ['node_modules', 'packages/*/node_modules', 'apps/*/node_modules'],
        },
      },
    },

    install: {
      dependsOn: ['setup', '^build'],
    },

    // setup -> install -> build. `install` chains the workspace install and
    // the dependencies' builds; everything that needs node_modules hangs off
    // it, and depending on the GROUP is enough — a dependent of a group now
    // receives the real tasks beneath it in its input closure, so a remotely
    // executed leaf gets setup's node_modules without naming setup itself.
    build: {
      dependsOn: ['install', 'build.bun'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    test: {
      description: 'bun test against the tests/ tree',
      // Scope to ./tests so workspace-member tests (packages/**/tests/) stay
      // isolated to their own packages — `bun test` without a path scans
      // recursively, and a bare `tests/` filter substring-matches a package's
      // own tests dir too. The leading `./` anchors the scan to the root
      // tests/ dir only. `bun test` from a clean root still runs everything.
      // --preload wires a global cwd-restore guard (tests/setup.ts) so a
      // chdir'ing suite can never leak its cwd into the next file — Bun shares
      // one process across files and does NOT restore cwd at the boundary.
      exec: {
        command: 'bun test --preload ./tests/setup.ts ./tests/',
        // The child env is isolated, so the sandbox gate's switch has to be
        // forwarded explicitly (see tests/helpers/sandbox-gate.ts).
        env: { passThrough: ['VX_REQUIRE_SANDBOX'] },
      },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['src/**', 'tests/**', 'package.json'],
          // Folded into the KEY as well, which passThrough alone does not do.
          // Without it a green artifact from a run that SKIPPED the 21 sandbox
          // tests restores into a run that was supposed to require them — the
          // hole in the fix, not a nicety.
          env: ['VX_REQUIRE_SANDBOX'],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: { command: 'oxlint --type-aware --type-check' },
      dependsOn: ['install'],
      cache: {
        inputs: {
          // `package.json` is folded into every task's key by core, but the
          // KEY is not the input set — it has to be declared to be shipped,
          // and the type checker follows `src/version.ts`'s `../package.json`
          // import and the `@vzn/vx` self-reference into the members' own
          // manifests.
          files: ['src/**', 'tests/**', 'package.json'],
          // The command scans the whole tree, but project-relative globs
          // stop at project boundaries — without these, a change confined to
          // a sibling package rides a stale lint cache hit. `bench/`, the
          // linter config and the tsconfig sit at the workspace ROOT and are
          // root-anchored for the same reason: declared project-relative they
          // resolved to paths that do not exist, so editing `.oxlintrc.json`
          // did not invalidate this task — and a remotely executed action got
          // no tsconfig, which tsgolint reports as ~900 phantom "Cannot find
          // name 'process'" errors rather than as a missing file.
          workspaceFiles: [
            'packages/*/src/**',
            'packages/*/tests/**',
            'scripts/**',
            'packages/*/package.json',
            'bench/**',
            '.oxlintrc.json',
            'tsconfig.json',
          ],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: { command: 'oxfmt --check .' },
      dependsOn: ['install'],
      cache: {
        inputs: {
          files: ['**/*'],
          // Same boundary gap as lint.oxlint: `oxfmt --check .` scans the
          // workspace-member packages too (ui/deploy are oxfmt-ignored), and
          // its config lives at the root, outside every project-relative glob.
          workspaceFiles: [
            'packages/*/src/**',
            'packages/*/tests/**',
            'scripts/**',
            '.oxfmtrc.json',
          ],
        },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt.fix': {
      description: 'oxfmt . — rewrite formatting in place',
      exec: { command: 'oxfmt .' },
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

    // Cross-target standalone binaries. One task per (os, arch) so
    // each gets its own cache slot. `dist/` is wiped before each
    // build by output cleaning, so the binary on disk always matches
    // the cached one.
    'build.bun.linux-x64': {
      description: 'compile standalone binary (linux x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-x64 src/bin.ts --outfile dist/vx-linux-x64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-linux-x64'] },
      },
    },
    'build.bun.linux-arm64': {
      description: 'compile standalone binary (linux arm64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-arm64 src/bin.ts --outfile dist/vx-linux-arm64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-linux-arm64'] },
      },
    },
    'build.bun.darwin-x64': {
      description: 'compile standalone binary (darwin x64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-x64 src/bin.ts --outfile dist/vx-darwin-x64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-darwin-x64'] },
      },
    },
    'build.bun.darwin-arm64': {
      description: 'compile standalone binary (darwin arm64)',
      dependsOn: ['install'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-arm64 src/bin.ts --outfile dist/vx-darwin-arm64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-darwin-arm64'] },
      },
    },
  },
})
