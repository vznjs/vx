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

    install: {
      dependsOn: ['^build'],
    },

    build: {
      dependsOn: ['build.bun', 'build.cloud'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    test: {
      description: 'bun test against the tests/ tree',
      // Scope to ./tests so workspace-member tests (packages/**/tests/) stay
      // isolated to their own packages — `bun test` without a path scans
      // recursively, and the bare `tests/` filter substring-matches
      // packages/cloud/tests/ too. The leading `./` anchors the scan to the
      // root tests/ dir only (the cloud package's tests run via its own
      // `bun test`). `bun test` from a clean root still runs everything.
      exec: { command: 'bun test ./tests/' },
      dependsOn: ['install'],
      cache: {
        inputs: { files: ['src/**', 'tests/**', 'package.json'] },
        outputs: { files: [] },
      },
    },

    'lint.oxlint': {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: { command: 'oxlint --type-aware --type-check' },
      cache: {
        inputs: { files: ['src/**', 'tests/**', 'bench/**', '.oxlintrc.json', 'tsconfig.json'] },
        outputs: { files: [] },
      },
    },

    'lint.oxfmt': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: { command: 'oxfmt --check .' },
      cache: {
        inputs: { files: ['**/*'] },
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

    // Build the embedded dashboard (packages/cloud/ui → single-file
    // dist/index.html). The compile step embeds it via `with { type: 'file' }`,
    // so it must exist first. Uses workspaceFiles (boundary-free) because the
    // dashboard is a separate project; this keeps the binary tasks' dependency
    // same-project (no cross-project ref that scoped loading wouldn't pull in).
    'build.ui': {
      description: 'build the embedded dashboard SPA (packages/cloud/ui)',
      dependsOn: ['install'],
      exec: { command: 'cd packages/cloud/ui && bun run build' },
      cache: {
        inputs: {
          files: [],
          workspaceFiles: [
            'packages/cloud/ui/src/**',
            'packages/cloud/ui/index.html',
            'packages/cloud/ui/package.json',
            'packages/cloud/ui/vite.config.ts',
            'packages/cloud/ui/uno.config.ts',
            'packages/cloud/ui/tsconfig.json',
          ],
        },
        outputs: { files: [], workspaceFiles: ['packages/cloud/ui/dist/index.html'] },
      },
    },

    // Cross-target standalone binaries. One task per (os, arch) so
    // each gets its own cache slot. `dist/` is wiped before each
    // build by output cleaning, so the binary on disk always matches
    // the cached one.
    'build.bun.linux-x64': {
      description: 'compile standalone binary (linux x64)',
      // The dashboard SPA is embedded via `with { type: 'file' }`; build it
      // first so packages/cloud/ui/dist/index.html exists when the compile
      // resolves the import (and so a UI change cascades into the binary key).
      dependsOn: ['install', 'build.ui'],
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
      dependsOn: ['install', 'build.ui'],
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
      dependsOn: ['install', 'build.ui'],
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
      dependsOn: ['install', 'build.ui'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-arm64 src/bin.ts --outfile dist/vx-darwin-arm64',
      },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: ['dist/vx-darwin-arm64'] },
      },
    },

    // The vx-cloud CLI compiled the SAME no-Bun way as vx — one standalone
    // binary per target, with core (`@vzn/vx`) and the dashboard embedded. The
    // binary bundles packages/cloud/src + core src + the SPA, so its inputs are
    // the root project's `**/*` (core src) PLUS the cloud package via
    // workspaceFiles (a separate project, outside the root `**/*` boundary).
    'build.cloud': {
      description: 'compile standalone vx-cloud binaries for every target',
      dependsOn: [
        'build.cloud.linux-x64',
        'build.cloud.linux-arm64',
        'build.cloud.darwin-x64',
        'build.cloud.darwin-arm64',
      ],
    },
    'build.cloud.linux-x64': {
      description: 'compile standalone vx-cloud binary (linux x64)',
      dependsOn: ['install', 'build.ui'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-x64 packages/cloud/src/cli/bin.ts --outfile dist/vx-cloud-linux-x64',
      },
      cache: {
        inputs: {
          files: ['**/*'],
          workspaceFiles: ['packages/cloud/src/**', 'packages/cloud/ui/dist/index.html'],
        },
        outputs: { files: ['dist/vx-cloud-linux-x64'] },
      },
    },
    'build.cloud.linux-arm64': {
      description: 'compile standalone vx-cloud binary (linux arm64)',
      dependsOn: ['install', 'build.ui'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-arm64 packages/cloud/src/cli/bin.ts --outfile dist/vx-cloud-linux-arm64',
      },
      cache: {
        inputs: {
          files: ['**/*'],
          workspaceFiles: ['packages/cloud/src/**', 'packages/cloud/ui/dist/index.html'],
        },
        outputs: { files: ['dist/vx-cloud-linux-arm64'] },
      },
    },
    'build.cloud.darwin-x64': {
      description: 'compile standalone vx-cloud binary (darwin x64)',
      dependsOn: ['install', 'build.ui'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-x64 packages/cloud/src/cli/bin.ts --outfile dist/vx-cloud-darwin-x64',
      },
      cache: {
        inputs: {
          files: ['**/*'],
          workspaceFiles: ['packages/cloud/src/**', 'packages/cloud/ui/dist/index.html'],
        },
        outputs: { files: ['dist/vx-cloud-darwin-x64'] },
      },
    },
    'build.cloud.darwin-arm64': {
      description: 'compile standalone vx-cloud binary (darwin arm64)',
      dependsOn: ['install', 'build.ui'],
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-arm64 packages/cloud/src/cli/bin.ts --outfile dist/vx-cloud-darwin-arm64',
      },
      cache: {
        inputs: {
          files: ['**/*'],
          workspaceFiles: ['packages/cloud/src/**', 'packages/cloud/ui/dist/index.html'],
        },
        outputs: { files: ['dist/vx-cloud-darwin-arm64'] },
      },
    },
  },
})
