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
        outputs: { files: ['node_modules/**'] },
      },
    },

    install: {
      dependsOn: ['setup', '^build'],
    },

    build: {
      dependsOn: ['build.bun'],
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
          files: ['src/**', 'tests/**', 'bench/**', '.oxlintrc.json', 'tsconfig.json'],
          // The command scans the whole tree, but project-relative globs
          // stop at project boundaries — without these, a change confined to
          // a sibling package rides a stale lint cache hit.
          workspaceFiles: ['packages/*/src/**', 'packages/*/tests/**', 'scripts/**'],
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
          // workspace-member packages too (ui/deploy are oxfmt-ignored).
          workspaceFiles: ['packages/*/src/**', 'packages/*/tests/**', 'scripts/**'],
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
