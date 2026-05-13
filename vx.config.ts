import { defineProject } from './src/index.ts'

export default defineProject({
  tasks: {
    lint: {
      description: 'oxlint with tsgolint-backed type-aware checks',
      exec: { command: 'oxlint --type-aware --type-check' },
      cache: {
        inputs: { files: ['src/**', 'tests/**', '.oxlintrc.json', 'tsconfig.json'] },
        outputs: { files: [] },
      },
    },

    'format-check': {
      description: 'oxfmt --check (no rewrite; CI-safe)',
      exec: { command: 'oxfmt --check .' },
      cache: {
        inputs: { files: ['**/*'] },
        outputs: { files: [] },
      },
    },

    // Mutates files in place — no cache (cache hit would skip the rewrite).
    format: {
      description: 'oxfmt . — rewrite formatting in place',
      exec: { command: 'oxfmt .' },
    },

    test: {
      description: 'bun test against the tests/ tree',
      exec: { command: 'bun test' },
      cache: {
        inputs: { files: ['src/**', 'tests/**', 'package.json'] },
        outputs: { files: [] },
      },
    },

    // Umbrella task for CI. Group task: no exec, just chains deps.
    ci: {
      description: 'format-check + lint + test (CI gate)',
      dependsOn: ['format-check', 'lint', 'test'],
    },

    // Cross-target standalone binaries. One task per (os, arch) so
    // each gets its own cache slot. `inputs.files` only needs `src/**`
    // and `tsconfig.json` — package.json bytes are auto-folded into
    // every cache key, and bun.lock is part of the workspace
    // fingerprint. `dist/` is wiped before each build by output
    // cleaning, so the binary on disk always matches the cached one.
    'build.linux-x64': {
      description: 'compile standalone binary (linux x64)',
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-x64 src/bin.ts --outfile dist/vx-linux-x64',
      },
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'] },
        outputs: { files: ['dist/vx-linux-x64'] },
      },
    },
    'build.linux-arm64': {
      description: 'compile standalone binary (linux arm64)',
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-linux-arm64 src/bin.ts --outfile dist/vx-linux-arm64',
      },
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'] },
        outputs: { files: ['dist/vx-linux-arm64'] },
      },
    },
    'build.darwin-x64': {
      description: 'compile standalone binary (darwin x64)',
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-x64 src/bin.ts --outfile dist/vx-darwin-x64',
      },
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'] },
        outputs: { files: ['dist/vx-darwin-x64'] },
      },
    },
    'build.darwin-arm64': {
      description: 'compile standalone binary (darwin arm64)',
      exec: {
        command:
          'bun build --compile --minify --bytecode --target=bun-darwin-arm64 src/bin.ts --outfile dist/vx-darwin-arm64',
      },
      cache: {
        inputs: { files: ['src/**', 'tsconfig.json'] },
        outputs: { files: ['dist/vx-darwin-arm64'] },
      },
    },

    // Umbrella build for the release workflow. Fans out to every
    // platform target. Skipped Windows since vx spawns POSIX shell.
    build: {
      description: 'compile standalone binaries for every target',
      dependsOn: ['build.linux-x64', 'build.linux-arm64', 'build.darwin-x64', 'build.darwin-arm64'],
    },
  },
})
