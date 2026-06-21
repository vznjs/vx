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
      dependsOn: ['build.bun'],
    },

    lint: {
      dependsOn: ['lint.oxlint', 'lint.oxfmt'],
    },

    test: {
      description: 'bun test against the tests/ tree',
      // Scope to ./tests so workspace-member tests (packages/**/tests/) stay
      // isolated to their own packages — `bun test` without a path scans
      // recursively and would pick up packages/otel-bridge/tests/ which
      // imports through @vzn/vx (not self-resolvable inside the root pkg).
      exec: { command: 'bun test tests/' },
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
